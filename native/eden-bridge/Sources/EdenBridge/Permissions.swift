import ApplicationServices
import CoreGraphics

enum Permissions {
    /// Screen Recording. On first use macOS shows a prompt attributed to the responsible app (VS Code).
    static func screenCapture(request: Bool) -> Bool {
        if CGPreflightScreenCaptureAccess() { return true }
        return request ? CGRequestScreenCaptureAccess() : false
    }

    /// Accessibility (needed to post keyboard events to the emulator process).
    static func accessibility(prompt: Bool) -> Bool {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(opts)
    }
}
