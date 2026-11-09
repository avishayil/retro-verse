import EdenBridgeCore
import Foundation
import Network

/// Loopback-only WebSocket server. A client must (1) present a vscode-webview Origin during the handshake
/// and (2) send a Hello frame carrying the session token within 2 s. One authenticated client at a time;
/// a newly authenticated client replaces the previous one (webview reloads).
final class MediaServer {
    var onInput: ((InputState) -> Void)?
    var onTurbo: ((Bool) -> Void)?
    var onClient: ((Bool) -> Void)?
    var onAuthenticated: (() -> Void)?

    private let listener: NWListener
    private let token: Data
    private let queue = DispatchQueue(label: "media.server")
    private var client: NWConnection?
    private var pendingBytes = 0
    private let maxPendingBytes = 4 * 1024 * 1024
    private(set) var bytesSent: UInt64 = 0
    private(set) var droppedForBackpressure = 0

    init(token: String, allowTestOrigin: Bool) throws {
        self.token = Data(token.utf8)
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = 1 << 20
        ws.setClientRequestHandler(DispatchQueue(label: "media.handshake")) { _, headers in
            let origin = headers.first { $0.name.lowercased() == "origin" }?.value
            // RETROVERSE_BRIDGE_TEST_ORIGIN exists only for the browser test harness; the extension never sets it.
            // Only honoured in --synthetic mode, so a stray environment variable cannot widen a real session.
            let testOrigin = allowTestOrigin ? ProcessInfo.processInfo.environment["RETROVERSE_BRIDGE_TEST_ORIGIN"] : nil
            let ok = isAllowedOrigin(origin) || (testOrigin != nil && !testOrigin!.isEmpty && origin == testOrigin)
            if !ok { Control.emit(["type": "security", "event": "origin-rejected", "detail": "WebSocket handshake from a non-webview origin"]) }
            return NWProtocolWebSocket.Response(status: ok ? .accept : .reject, subprotocol: nil)
        }
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        params.acceptLocalOnly = true
        params.allowLocalEndpointReuse = false
        listener = try NWListener(using: params)
    }

    /// Starts listening; calls back with the bound port.
    func start(_ ready: @escaping (UInt16) -> Void, failed: @escaping (Error) -> Void) {
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: if let p = self?.listener.port?.rawValue { ready(p) }
            case .failed(let e): failed(e)
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        listener.start(queue: queue)
    }

    /// Connections that have not authenticated yet (guarded by `queue`).
    private var pendingConnections = 0

    private func accept(_ conn: NWConnection) {
        // Cap unauthenticated connections so local processes cannot exhaust the bridge.
        guard pendingConnections < MediaLimits.maxPendingConnections else {
            Control.emit(["type": "security", "event": "connection-limit", "detail": "too many unauthenticated connections"])
            conn.cancel()
            return
        }
        pendingConnections += 1
        var authed = false
        var counted = true
        var badFrames = 0
        var limiter = RateLimiter(ratePerSecond: MediaLimits.inputPerSecond, burst: MediaLimits.inputPerSecond, now: CFAbsoluteTimeGetCurrent())
        let release = { [weak self] in
            if counted { counted = false; self?.pendingConnections -= 1 }
        }
        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .failed, .cancelled:
                release()
                if self.client === conn {
                    self.client = nil
                    self.onInput?(.released) // never leave keys held when the viewer goes away
                    self.onTurbo?(false)
                    self.onClient?(false)
                }
            default: break
            }
        }
        conn.start(queue: queue)
        // Unauthenticated connections are dropped after 2 s.
        queue.asyncAfter(deadline: .now() + 2) { if !authed { conn.cancel() } }
        receive(conn) { [weak self] frame in
            guard let self else { return false }
            if !authed {
                guard frame.type == .hello, constantTimeEqual(frame.payload, self.token) else {
                    Control.emit(["type": "security", "event": "auth-failed", "detail": "client did not present the session token"])
                    conn.cancel()
                    return false
                }
                authed = true
                release()
                self.client?.cancel()
                self.client = conn
                self.pendingBytes = 0
                self.onClient?(true)
                self.onAuthenticated?()
                return true
            }
            func bad(_ why: String) -> Bool {
                badFrames += 1
                guard badFrames >= MediaLimits.maxBadFrames else { return true }
                Control.emit(["type": "security", "event": "bad-frames", "detail": why])
                conn.cancel()
                return false
            }
            switch frame.type {
            case .input:
                guard limiter.allow(now: CFAbsoluteTimeGetCurrent()) else { return true } // drop the excess
                guard let s = InputState.decode(frame.payload) else { return bad("malformed input frame") }
                self.onInput?(s)
            case .turbo:
                guard frame.payload.count == 1 else { return bad("malformed turbo frame") }
                self.onTurbo?(frame.payload.first == 1)
            case .ping:
                guard limiter.allow(now: CFAbsoluteTimeGetCurrent()) else { return true }
                self.send(WireFrame(type: .pong, timestamp: frame.timestamp, payload: Data()))
            default:
                return bad("unexpected frame type \(frame.type)")
            }
            return true
        }
    }

    private func receive(_ conn: NWConnection, _ handle: @escaping (WireFrame) -> Bool) {
        conn.receiveMessage { [weak self] data, ctx, _, error in
            guard self != nil, error == nil else { conn.cancel(); return }
            if let meta = ctx?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata, meta.opcode == .close {
                conn.cancel(); return
            }
            if let data {
                if let frame = WireFrame.decode(data) {
                    if !handle(frame) { return }
                } else {
                    // Undecodable frame (unknown type or too short): treat as malformed input.
                    if !handle(WireFrame(type: .error, timestamp: 0, payload: Data())) { return }
                }
            }
            self?.receive(conn, handle)
        }
    }

    var hasClient: Bool { queue.sync { client != nil } }

    /// Queues a frame for the current client. Droppable frames (non-key video) are skipped under backpressure.
    /// Asynchronous so it is safe to call from any thread, including this server's own queue.
    func send(_ frame: WireFrame, droppable: Bool = false) {
        let data = frame.encoded()
        queue.async { [weak self] in
            guard let self, let c = self.client else { return }
            if droppable && self.pendingBytes > self.maxPendingBytes {
                self.droppedForBackpressure += 1
                return
            }
            self.pendingBytes += data.count
            let meta = NWProtocolWebSocket.Metadata(opcode: .binary)
            let ctx = NWConnection.ContentContext(identifier: "media", metadata: [meta])
            c.send(content: data, contentContext: ctx, isComplete: true, completion: .contentProcessed { [weak self] _ in
                self?.queue.async {
                    self?.pendingBytes -= data.count
                    self?.bytesSent += UInt64(data.count)
                }
            })
        }
    }

    var backlogged: Bool { queue.sync { pendingBytes > maxPendingBytes } }

    func stop() {
        queue.sync {
            client?.cancel()
            client = nil
        }
        listener.cancel()
    }
}
