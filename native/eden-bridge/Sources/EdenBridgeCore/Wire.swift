import Foundation

/// Binary framing shared with src/protocol/bridgeWire.ts:
/// [u8 type][u64 big-endian timestamp µs][payload]
public enum WireType: UInt8 {
    case hello = 0x01
    case config = 0x10
    case video = 0x11
    case audio = 0x12
    case telemetry = 0x13
    case error = 0x14
    case input = 0x20
    case ping = 0x21
    case pong = 0x22
    case turbo = 0x23
}

public let wireHeaderBytes = 9

public struct WireFrame: Equatable {
    public var type: WireType
    public var timestamp: UInt64
    public var payload: Data

    public init(type: WireType, timestamp: UInt64, payload: Data) {
        self.type = type
        self.timestamp = timestamp
        self.payload = payload
    }

    public func encoded() -> Data {
        var out = Data(capacity: wireHeaderBytes + payload.count)
        out.append(type.rawValue)
        var ts = timestamp.bigEndian
        withUnsafeBytes(of: &ts) { out.append(contentsOf: $0) }
        out.append(payload)
        return out
    }

    public static func decode(_ data: Data) -> WireFrame? {
        guard data.count >= wireHeaderBytes, let type = WireType(rawValue: data[data.startIndex]) else { return nil }
        var ts: UInt64 = 0
        for i in 1...8 { ts = (ts << 8) | UInt64(data[data.startIndex + i]) }
        return WireFrame(type: type, timestamp: ts, payload: data.subdata(in: (data.startIndex + wireHeaderBytes)..<data.endIndex))
    }
}

public struct InputState: Equatable {
    public var seq: UInt32
    public var buttons: UInt32
    public var lx: Float, ly: Float, rx: Float, ry: Float

    public init(seq: UInt32, buttons: UInt32, lx: Float, ly: Float, rx: Float, ry: Float) {
        self.seq = seq; self.buttons = buttons; self.lx = lx; self.ly = ly; self.rx = rx; self.ry = ry
    }

    public static let released = InputState(seq: 0, buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0)

    public static func decode(_ p: Data) -> InputState? {
        guard p.count == 24 else { return nil }
        let b = [UInt8](p)
        func u32(_ o: Int) -> UInt32 { (UInt32(b[o]) << 24) | (UInt32(b[o + 1]) << 16) | (UInt32(b[o + 2]) << 8) | UInt32(b[o + 3]) }
        func f32(_ o: Int) -> Float {
            let v = Float(bitPattern: u32(o))
            return v.isFinite ? max(-1, min(1, v)) : 0
        }
        return InputState(seq: u32(0), buttons: u32(4), lx: f32(8), ly: f32(12), rx: f32(16), ry: f32(20))
    }
}

/// Logical button order; must match BUTTONS in src/protocol/types.ts.
public let buttonOrder = ["A", "B", "X", "Y", "L", "R", "ZL", "ZR", "Start", "Select", "Up", "Down", "Left", "Right", "Home", "Capture", "LS", "RS"]

/// Digital "virtual inputs" active for a state: pressed buttons plus thresholded stick directions.
public func activeInputs(_ s: InputState, threshold: Float = 0.5) -> Set<String> {
    var out = Set<String>()
    for (i, name) in buttonOrder.enumerated() where s.buttons & (1 << UInt32(i)) != 0 { out.insert(name) }
    if s.lx <= -threshold { out.insert("LLeft") }
    if s.lx >= threshold { out.insert("LRight") }
    if s.ly <= -threshold { out.insert("LUp") }
    if s.ly >= threshold { out.insert("LDown") }
    if s.rx <= -threshold { out.insert("RLeft") }
    if s.rx >= threshold { out.insert("RRight") }
    if s.ry <= -threshold { out.insert("RUp") }
    if s.ry >= threshold { out.insert("RDown") }
    return out
}

/// Constant-time comparison for the session token.
public func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
    guard a.count == b.count else { return false }
    var diff: UInt8 = 0
    for (x, y) in zip(a, b) { diff |= x ^ y }
    return diff == 0
}

/// Only VS Code webviews may connect (Origin: vscode-webview://<id>). Missing Origin is rejected too.
public func isAllowedOrigin(_ origin: String?) -> Bool {
    guard let o = origin?.lowercased() else { return false }
    return o.hasPrefix("vscode-webview://")
}

/// Build the WebCodecs codec string ("avc1.PPCCLL") from an avcC record.
public func avcCodecString(avcC: Data) -> String? {
    guard avcC.count >= 4, avcC[avcC.startIndex] == 1 else { return nil }
    let b = [UInt8](avcC)
    return String(format: "avc1.%02x%02x%02x", b[1], b[2], b[3])
}

/// Session tokens are 32 random bytes in base64url (43 chars); accept 22 to 128 URL-safe characters.
public func isAcceptableToken(_ t: String) -> Bool {
    (22...128).contains(t.count) && t.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
}

/// Token-bucket rate limiter (not thread-safe; use from one queue). `allow()` is false once the budget is spent.
public struct RateLimiter {
    public let ratePerSecond: Double
    public let burst: Double
    private var tokens: Double
    private var last: Double

    public init(ratePerSecond: Double, burst: Double, now: Double = 0) {
        self.ratePerSecond = ratePerSecond
        self.burst = burst
        self.tokens = burst
        self.last = now
    }

    public mutating func allow(now: Double) -> Bool {
        tokens = min(burst, tokens + max(0, now - last) * ratePerSecond)
        last = now
        guard tokens >= 1 else { return false }
        tokens -= 1
        return true
    }
}

/// Limits for the media WebSocket.
public enum MediaLimits {
    /// Unauthenticated connections allowed at once; extra ones are closed immediately.
    public static let maxPendingConnections = 4
    /// Input frames per second per connection (the webview sends ~4/s plus one per change).
    public static let inputPerSecond = 1000.0
    /// Malformed or unexpected frames tolerated before the connection is closed.
    public static let maxBadFrames = 3
}
