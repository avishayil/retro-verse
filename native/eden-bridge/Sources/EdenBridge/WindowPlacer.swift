import AppKit
import ApplicationServices
import CoreGraphics
import EdenBridgeCore
import Foundation

/// Keeps the emulator window where macOS will keep drawing it.
///
/// macOS stops an app's rendering as soon as its window is fully covered, hidden or minimized, which freezes
/// window capture. So instead of hiding the emulator, the bridge parks its window on a display the VS Code
/// window is not on (without activating it), and reports when something covers it anyway.
final class WindowPlacer {
    private let pid: pid_t
    private let avoidPids: Set<pid_t>
    private var lastCovered: Bool?

    init(pid: pid_t, avoidPids: Set<pid_t>) {
        self.pid = pid
        self.avoidPids = avoidPids
    }

    // MARK: geometry (CoreGraphics global coordinates: origin top-left of the main display; same as AX)

    struct WindowInfo { let id: CGWindowID; let pid: pid_t; let bounds: CGRect; let layer: Int }

    static func onScreenWindows() -> [WindowInfo] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { w in
            guard let id = w[kCGWindowNumber as String] as? CGWindowID,
                  let p = w[kCGWindowOwnerPID as String] as? pid_t,
                  let b = w[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: b as CFDictionary) else { return nil }
            return WindowInfo(id: id, pid: p, bounds: rect, layer: w[kCGWindowLayer as String] as? Int ?? 0)
        } // front-to-back order
    }

    static func displays() -> [CGRect] {
        var n: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &n)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(n))
        CGGetActiveDisplayList(n, &ids, &n)
        return ids.map { CGDisplayBounds($0) }
    }

    private func emulatorWindow(_ wins: [WindowInfo]) -> WindowInfo? {
        wins.filter { $0.pid == pid && $0.layer == 0 && $0.bounds.width >= 160 && $0.bounds.height >= 120 }
            .max { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }
    }

    // MARK: placement

    enum Placement { case moved(CGPoint), alreadyClear, noFreeDisplay, noAccessibility, failed(String) }

    /// Move the emulator window to a display without an editor window. No-op if it is already on one.
    func place() -> Placement {
        guard AXIsProcessTrusted() else { return .noAccessibility }
        let wins = Self.onScreenWindows()
        guard let emu = emulatorWindow(wins) else { return .failed("emulator window not found") }
        let editorRects = wins.filter { avoidPids.contains($0.pid) && $0.layer == 0 }.map(\.bounds)
        let displays = Self.displays()
        func editorArea(_ d: CGRect) -> CGFloat { editorRects.reduce(0) { $0 + area($1.intersection(d)) } }
        let current = displays.max { area($0.intersection(emu.bounds)) < area($1.intersection(emu.bounds)) }
        if let current, editorArea(current) == 0 { return .alreadyClear }
        guard let target = displays.filter({ editorArea($0) == 0 }).max(by: { area($0) < area($1) }) else { return .noFreeDisplay }
        // Centre on the target display (top-left if larger than it).
        let origin = CGPoint(x: target.minX + max(0, (target.width - emu.bounds.width) / 2),
                             y: target.minY + max(0, (target.height - emu.bounds.height) / 2))
        return setPosition(origin, near: emu.bounds) ? .moved(origin) : .failed("AX could not move the window")
    }

    private func setPosition(_ p: CGPoint, near bounds: CGRect) -> Bool {
        let app = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success, let windows = value as? [AXUIElement] else { return false }
        // Pick the AX window whose frame matches the captured one.
        let target = windows.min { distance(frame(of: $0), bounds) < distance(frame(of: $1), bounds) }
        guard let w = target else { return false }
        var point = p
        guard let axPoint = AXValueCreate(.cgPoint, &point) else { return false }
        return AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, axPoint) == .success
    }

    private func frame(of w: AXUIElement) -> CGRect {
        var pos = CGPoint.zero, size = CGSize.zero
        var v: CFTypeRef?
        if AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &v) == .success, let v { AXValueGetValue(v as! AXValue, .cgPoint, &pos) }
        if AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &v) == .success, let v { AXValueGetValue(v as! AXValue, .cgSize, &size) }
        return CGRect(origin: pos, size: size)
    }

    /// Give focus back to VS Code after the emulator launched in front, so typing goes to the editor and the
    /// emulator keeps running unobstructed on its own display. The first avoid-pid that is a GUI app wins.
    func refocusEditor() -> Bool {
        for p in avoidPids {
            if let app = NSRunningApplication(processIdentifier: p), app.activationPolicy == .regular {
                return app.activate()
            }
        }
        return false
    }

    // MARK: coverage

    /// Returns a change in "covered" state (nil when unchanged). Covered = no part of the emulator window is
    /// visible on any display, i.e. macOS will throttle it.
    func checkCovered() -> Bool? {
        let wins = Self.onScreenWindows()
        guard let emuIndex = wins.firstIndex(where: { $0.pid == pid && $0.layer == 0 && $0.bounds.width >= 160 }) else { return nil }
        let emu = wins[emuIndex].bounds
        // Only ordinary app windows (layer 0) can hide the emulator. System layers such as the Dock (20) and
        // Notification Center (21) keep invisible full-screen windows on every display and must not count.
        let above = wins[..<emuIndex].filter { $0.pid != pid && $0.layer == 0 }.map(\.bounds)
        let screens = Self.displays()
        let covered = !visibleSample(emu, above: above, screens: screens)
        defer { lastCovered = covered }
        return covered == lastCovered ? nil : covered
    }
}

func area(_ r: CGRect) -> CGFloat { r.isNull ? 0 : r.width * r.height }

func distance(_ a: CGRect, _ b: CGRect) -> CGFloat {
    abs(a.minX - b.minX) + abs(a.minY - b.minY) + abs(a.width - b.width) + abs(a.height - b.height)
}

/// True if any sampled point of `rect` is on a screen and not under any window in `above`.
func visibleSample(_ rect: CGRect, above: [CGRect], screens: [CGRect], grid: Int = 12) -> Bool {
    for i in 0..<grid {
        for j in 0..<grid {
            let p = CGPoint(x: rect.minX + (CGFloat(i) + 0.5) * rect.width / CGFloat(grid),
                            y: rect.minY + (CGFloat(j) + 0.5) * rect.height / CGFloat(grid))
            if screens.contains(where: { $0.contains(p) }) && !above.contains(where: { $0.contains(p) }) { return true }
        }
    }
    return false
}
