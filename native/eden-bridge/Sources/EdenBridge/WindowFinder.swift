import Foundation
import ScreenCaptureKit

enum WindowFinder {
    static func shareable() async throws -> SCShareableContent {
        try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    }

    /// The largest reasonably sized on-screen window owned by `pid`.
    static func find(pid: pid_t) async throws -> SCWindow? {
        let content = try await shareable()
        return content.windows
            .filter { $0.owningApplication?.processID == pid && $0.frame.width >= 160 && $0.frame.height >= 120 && $0.windowLayer == 0 }
            .max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    static func list() async throws -> [[String: Any]] {
        let content = try await shareable()
        return content.windows
            .filter { $0.windowLayer == 0 && $0.frame.width >= 160 && $0.frame.height >= 120 && $0.owningApplication != nil }
            .map { w in
                [
                    "pid": Int(w.owningApplication!.processID),
                    "app": w.owningApplication!.applicationName,
                    "title": w.title ?? "",
                    "width": Int(w.frame.width),
                    "height": Int(w.frame.height),
                ]
            }
    }
}
