import CoreMedia
import EdenBridgeCore
import Foundation
import ScreenCaptureKit

// eden-bridge: captures a native emulator window, encodes H.264 + PCM, serves it to the VS Code
// webview over an authenticated loopback WebSocket, and injects controller input into the process.
//
//   eden-bridge --pid <pid> [--fps 30] [--height 720] [--bitrate 8000] [--keymap '{"A":"C",...}']
//   eden-bridge --list-windows
//   eden-bridge --pid <pid> --selftest     (capture+encode for 5 s, print stats, no server)
//
// The session token is read from RETROVERSE_BRIDGE_TOKEN (never argv).

let version = "0.1.0"
let protocolVersion = 1

struct Options {
    var pid: pid_t = 0
    var fps = 30
    var height = 720
    var bitrateKbps = 8000
    var keymap: [String: String] = [:]
    var listWindows = false
    var selftest = false
    var noAudio = false
    var synthetic = false
    var turboHotkey: String?
    /// Processes whose windows the emulator window must not share a display with (VS Code).
    var avoidPids: Set<pid_t> = []
    var place = true
}

func parseOptions() -> Options {
    var o = Options()
    var args = CommandLine.arguments.dropFirst().makeIterator()
    while let a = args.next() {
        switch a {
        case "--pid": o.pid = pid_t(args.next() ?? "") ?? 0
        case "--fps": o.fps = max(1, min(60, Int(args.next() ?? "") ?? 30))
        case "--height": o.height = max(144, min(2160, Int(args.next() ?? "") ?? 720))
        case "--bitrate": o.bitrateKbps = max(500, min(50_000, Int(args.next() ?? "") ?? 8000))
        case "--keymap":
            if let d = args.next()?.data(using: .utf8), let m = try? JSONSerialization.jsonObject(with: d) as? [String: String] { o.keymap = m }
        case "--list-windows": o.listWindows = true
        case "--selftest": o.selftest = true
        case "--no-audio": o.noAudio = true
        case "--synthetic": o.synthetic = true
        case "--turbo-hotkey": o.turboHotkey = args.next()
        case "--avoid-pid": if let p = pid_t(args.next() ?? "") { o.avoidPids.insert(p) }
        case "--no-place": o.place = false
        case "--version": print(version); exit(0)
        default: Control.log("unknown argument \(a)")
        }
    }
    return o
}

func nowMicros() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1_000_000) }

/// Repeating timer on the main queue (async code here may run off the main run loop, so Foundation Timers are not used).
private var timers: [DispatchSourceTimer] = []
func every(_ seconds: Double, _ block: @escaping () -> Void) {
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + seconds, repeating: seconds)
    t.setEventHandler(handler: block)
    t.resume()
    DispatchQueue.main.async { timers.append(t) }
}

func processAlive(_ pid: pid_t) -> Bool { kill(pid, 0) == 0 || errno == EPERM }

final class Bridge {
    let o: Options
    let token: String
    var server: MediaServer?
    var capture: WindowCapture?
    var encoder: H264Encoder?
    var injector: InputInjector?
    var configFrame: WireFrame?
    var paused = false

    // telemetry
    var framesSent = 0
    var lastEncodeMs = 0.0
    var lastCaptureMs = 0.0
    var lastBytes: UInt64 = 0
    var audioConfig: (rate: Int, channels: Int)?

    init(o: Options, token: String) {
        self.o = o
        self.token = token
    }

    var synthetic: SyntheticSource?

    /// `--synthetic`: test pattern instead of a captured window (no permissions needed).
    func runSynthetic() {
        Control.emit(["type": "hello", "version": version, "protocol": protocolVersion])
        Control.emit(["type": "permissions", "screen": true, "accessibility": true])
        let src = SyntheticSource(height: o.height, fps: o.fps)
        guard let enc = try? H264Encoder(width: src.width, height: src.height, fps: o.fps, bitrateKbps: o.bitrateKbps) else {
            Control.error("encoder", "could not create encoder", fatal: true); exit(4)
        }
        synthetic = src
        encoder = enc
        enc.onConfig = { [weak self] avcC, w, h in self?.sendConfig(avcC: avcC, width: w, height: h) }
        enc.onFrame = { [weak self] out in self?.sendVideo(out) }
        src.onVideo = { [weak self] pb, pts, _ in
            guard let self, self.o.selftest || self.server?.hasClient == true else { return }
            enc.encode(pb, pts: pts)
        }
        src.onAudio = { [weak self] pcm, rate, ch in self?.sendAudio(pcm, rate: rate, channels: ch) }
        Control.emit(["type": "window", "width": src.width, "height": src.height, "title": "synthetic"])
        src.start()
        if o.selftest { runSelftest(); return }
        startServer()
        // Report what would be injected, so tests can verify webview key -> logical input -> emulator key.
        let codes = resolveKeymap(o.keymap).codes
        let names = Dictionary(virtualKeyCodes.map { ($0.value, $0.key) }, uniquingKeysWith: { a, b in a.count <= b.count ? a : b })
        var held = Set<String>()
        server?.onInput = { [weak self] st in
            self?.synthetic?.setInput(st)
            let next = activeInputs(st)
            guard next != held else { return }
            held = next
            let keys = next.compactMap { codes[$0] }.compactMap { names[$0] }.sorted()
            Control.emit(["type": "injected", "inputs": next.sorted(), "keys": keys])
        }
        server?.onTurbo = { on in Control.emit(["type": "injected", "turbo": on]) }
        every(1) { self.telemetry() }
    }

    func run() async {
        if o.synthetic { runSynthetic(); return }
        Control.emit(["type": "hello", "version": version, "protocol": protocolVersion])
        let screen = Permissions.screenCapture(request: true)
        let ax = Permissions.accessibility(prompt: !o.selftest)
        Control.emit(["type": "permissions", "screen": screen, "accessibility": ax])
        guard screen else {
            Control.error("permission", "Screen Recording permission denied", fatal: true)
            exit(3)
        }
        injector = InputInjector(pid: o.pid, keymap: o.keymap, enabled: ax)
        if let s = o.turboHotkey {
            if let hk = parseHotkey(s) { injector?.turboHotkey = hk } else { Control.log("input: unparseable turbo hotkey '\(s)'") }
        }

        // Watch the target; exit when it dies.
        every(1) {
            if !processAlive(self.o.pid) { self.shutdown(code: 0, reason: "target exited") }
        }

        guard var window = await waitForWindow() else { return }
        if o.place && !o.selftest { window = await placeWindow(window) }
        Control.emit(["type": "window", "width": Int(window.frame.width), "height": Int(window.frame.height), "title": window.title ?? ""])

        do {
            let cap = try WindowCapture(window: window, targetHeight: o.height, fps: o.fps, audio: !o.noAudio)
            let enc = try H264Encoder(width: cap.width, height: cap.height, fps: o.fps, bitrateKbps: o.bitrateKbps)
            capture = cap
            encoder = enc
            enc.onConfig = { [weak self] avcC, w, h in self?.sendConfig(avcC: avcC, width: w, height: h) }
            enc.onFrame = { [weak self] out in self?.sendVideo(out) }
            cap.onVideo = { [weak self] pb, pts, captureMs in
                guard let self, !self.paused || self.configFrame == nil else { return }
                self.lastCaptureMs = captureMs
                // Without a viewer there is nothing to encode (except in selftest).
                if self.o.selftest || self.server?.hasClient == true { enc.encode(pb, pts: pts) }
            }
            cap.onAudio = { [weak self] pcm, rate, ch in self?.sendAudio(pcm, rate: rate, channels: ch) }
            cap.onStop = { [weak self] err in
                Control.error("capture", "capture stopped: \(err?.localizedDescription ?? "unknown")", fatal: true)
                self?.shutdown(code: 4, reason: "capture stopped")
            }
            try await cap.start()
        } catch {
            Control.error("capture", "could not start capture: \(error.localizedDescription)", fatal: true)
            exit(4)
        }

        if o.selftest {
            runSelftest()
            return
        }
        startServer()
        every(1) { self.telemetry() }
    }

    var placer: WindowPlacer?

    /// Park the emulator window on a display without VS Code (so it is never covered), then keep watching:
    /// re-place it if the emulator moves it back during boot, and report when it is covered anyway.
    func placeWindow(_ window: SCWindow) async -> SCWindow {
        let placer = WindowPlacer(pid: o.pid, avoidPids: o.avoidPids)
        self.placer = placer
        func report(_ p: WindowPlacer.Placement) {
            switch p {
            case .moved(let pt): Control.emit(["type": "placement", "result": "moved", "x": Int(pt.x), "y": Int(pt.y)])
            case .alreadyClear: Control.emit(["type": "placement", "result": "clear"])
            case .noFreeDisplay: Control.emit(["type": "placement", "result": "noFreeDisplay"])
            case .noAccessibility: Control.emit(["type": "placement", "result": "noAccessibility"])
            case .failed(let why): Control.emit(["type": "placement", "result": "failed", "reason": why])
            }
        }
        let first = placer.place()
        report(first)
        if case .noFreeDisplay = first {} else if placer.refocusEditor() { Control.emit(["type": "placement", "result": "refocused"]) }
        var checks = 0
        every(1) { [weak self] in
            guard let self, let placer = self.placer else { return }
            checks += 1
            // Eden resizes/re-centres its window when the game boots; keep it off the editor display early on.
            if checks <= 20, case .moved(let pt) = placer.place() {
                Control.emit(["type": "placement", "result": "moved", "x": Int(pt.x), "y": Int(pt.y)])
            }
            if let covered = placer.checkCovered() { Control.emit(["type": "covered", "covered": covered]) }
        }
        try? await Task.sleep(nanoseconds: 300_000_000)
        // Return the refreshed SCWindow (frame changed after the move).
        return (try? await WindowFinder.find(pid: o.pid)) ?? window
    }

    func waitForWindow() async -> SCWindow? {
        var announced = false
        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline {
            if !processAlive(o.pid) { shutdown(code: 0, reason: "target exited before showing a window"); return nil }
            if let w = try? await WindowFinder.find(pid: o.pid) { return w }
            if !announced {
                Control.emit(["type": "waiting", "reason": "Waiting for the emulator window…"])
                announced = true
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        Control.error("window", "no window appeared for pid \(o.pid)", fatal: true)
        shutdown(code: 5, reason: "no window")
        return nil
    }

    func startServer() {
        do {
            let s = try MediaServer(token: token)
            server = s
            s.onInput = { [weak self] st in self?.injector?.apply(st) }
            s.onTurbo = { [weak self] on in self?.injector?.setTurbo(on) }
            s.onClient = { connected in Control.emit(["type": "client", "connected": connected]) }
            s.onAuthenticated = { [weak self] in
                guard let self else { return }
                // A new viewer needs the decoder config and a fresh keyframe.
                if let cfg = self.configFrame { s.send(cfg) }
                self.encoder?.requestKeyframe()
            }
            s.start({ port in Control.emit(["type": "ready", "port": Int(port)]) }, failed: { err in
                Control.error("server", "listener failed: \(err)", fatal: true)
                self.shutdown(code: 6, reason: "listener failed")
            })
        } catch {
            Control.error("server", "could not create listener: \(error)", fatal: true)
            exit(6)
        }
    }

    func sendConfig(avcC: Data, width: Int, height: Int) {
        guard let codec = avcCodecString(avcC: avcC) else { return }
        var cfg: [String: Any] = ["codec": codec, "width": width, "height": height, "description": avcC.base64EncodedString()]
        if let a = audioConfig { cfg["sampleRate"] = a.rate; cfg["channels"] = a.channels }
        else if !o.noAudio { cfg["sampleRate"] = 48_000; cfg["channels"] = 2 }
        guard let json = try? JSONSerialization.data(withJSONObject: cfg) else { return }
        let f = WireFrame(type: .config, timestamp: nowMicros(), payload: json)
        configFrame = f
        server?.send(f)
    }

    func sendVideo(_ out: H264Encoder.Output) {
        lastEncodeMs = out.encodeMs
        framesSent += 1
        guard let server else { return }
        if server.backlogged && !out.isKey { encoder?.requestKeyframe() }
        var payload = Data([out.isKey ? 1 : 0])
        payload.append(out.data)
        server.send(WireFrame(type: .video, timestamp: out.ptsMicros, payload: payload), droppable: !out.isKey)
    }

    func sendAudio(_ pcm: Data, rate: Int, channels: Int) {
        if audioConfig == nil { audioConfig = (rate, channels) }
        guard !paused else { return }
        server?.send(WireFrame(type: .audio, timestamp: nowMicros(), payload: pcm), droppable: true)
    }

    func telemetry() {
        let bytes = server?.bytesSent ?? 0
        let t: [String: Any] = [
            "fps": framesSent,
            "captureMs": (lastCaptureMs * 10).rounded() / 10,
            "encodeMs": (lastEncodeMs * 10).rounded() / 10,
            "bitrateKbps": Double(bytes - lastBytes) * 8 / 1000,
            "droppedFrames": (encoder?.dropped ?? 0) + (server?.droppedForBackpressure ?? 0),
        ]
        lastBytes = bytes
        framesSent = 0
        if let json = try? JSONSerialization.data(withJSONObject: t) {
            server?.send(WireFrame(type: .telemetry, timestamp: nowMicros(), payload: json))
        }
    }

    func runSelftest() {
        var seconds = 0
        every(1) {
            seconds += 1
            Control.emit(["type": "telemetry", "data": ["fps": self.framesSent, "encodeMs": self.lastEncodeMs, "captureMs": self.lastCaptureMs, "droppedFrames": self.encoder?.dropped ?? 0, "audio": self.audioConfig != nil]])
            self.framesSent = 0
            if seconds >= 5 { self.shutdown(code: 0, reason: "selftest done") }
        }
    }

    func handle(_ cmd: [String: Any]) {
        switch cmd["type"] as? String {
        case "releaseAll": injector?.releaseAll()
        case "pause":
            paused = cmd["paused"] as? Bool ?? false
            injector?.releaseAll()
        case "keymap":
            if let m = cmd["map"] as? [String: String] { injector?.setKeymap(m) }
        case "stop": shutdown(code: 0, reason: "stop requested")
        default: break
        }
    }

    private var shuttingDown = false
    func shutdown(code: Int32, reason: String) {
        if shuttingDown { return }
        shuttingDown = true
        Control.log("bridge: shutting down (\(reason))")
        injector?.releaseAll()
        server?.stop()
        encoder?.invalidate()
        let cap = capture
        Task {
            await cap?.stop()
            exit(code)
        }
        // Hard stop if capture teardown hangs.
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { exit(code) }
    }
}

// MARK: entry

signal(SIGPIPE, SIG_IGN)
let options = parseOptions()

if options.listWindows {
    Task {
        guard Permissions.screenCapture(request: true) else {
            FileHandle.standardError.write(Data("Screen Recording permission denied\n".utf8))
            exit(3)
        }
        do {
            let list = try await WindowFinder.list()
            let data = try JSONSerialization.data(withJSONObject: list, options: [.prettyPrinted])
            FileHandle.standardOutput.write(data)
            exit(0)
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
    RunLoop.main.run()
}

guard options.pid > 0 || options.synthetic else {
    Control.log("usage: eden-bridge --pid <pid> [--fps N] [--height N] [--bitrate kbps] | --list-windows")
    exit(2)
}
let token = ProcessInfo.processInfo.environment["RETROVERSE_BRIDGE_TOKEN"] ?? ""
if token.count < 16 && !options.selftest {
    Control.error("token", "missing or short RETROVERSE_BRIDGE_TOKEN", fatal: true)
    exit(2)
}

let bridge = Bridge(o: options, token: token)
Control.readCommands({ cmd in DispatchQueue.main.async { bridge.handle(cmd) } }, onEOF: {
    // Parent (extension host) is gone: never outlive it.
    if !options.selftest { DispatchQueue.main.async { bridge.shutdown(code: 0, reason: "stdin closed") } }
})
Task { await bridge.run() }
RunLoop.main.run()
