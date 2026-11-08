import Foundation

/// JSON-lines control channel with the VS Code extension host (stdout = events, stdin = commands).
enum Control {
    private static let lock = NSLock()

    static func emit(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }

    static func log(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }

    static func error(_ code: String, _ message: String, fatal: Bool = false) {
        emit(["type": "error", "code": code, "message": message, "fatal": fatal])
    }

    /// Reads stdin lines on a background thread. EOF means the extension host went away.
    static func readCommands(_ handler: @escaping ([String: Any]) -> Void, onEOF: @escaping () -> Void) {
        let t = Thread {
            while let line = readLine(strippingNewline: true) {
                guard let data = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                handler(obj)
            }
            onEOF()
        }
        t.name = "stdin"
        t.start()
    }
}
