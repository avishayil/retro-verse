import CoreGraphics
import EdenBridgeCore
import Foundation

/// Converts controller snapshots into key events posted directly to the emulator process.
/// Snapshot diffs make repeated/duplicate packets harmless; releaseAll() always lifts every held key.
final class InputInjector {
    private let pid: pid_t
    private var codes: [String: UInt16]
    private var held = Set<String>()
    private let lock = NSLock()
    private let source = CGEventSource(stateID: .privateState)
    private var lastSeq: UInt32 = 0
    var enabled: Bool
    /// Emulator hotkey that toggles turbo (Eden: "Toggle Turbo Speed"); nil = turbo unsupported.
    var turboHotkey: Hotkey?
    private var turboOn = false

    init(pid: pid_t, keymap: [String: String], enabled: Bool) {
        self.pid = pid
        let r = resolveKeymap(keymap)
        codes = r.codes
        self.enabled = enabled
        if !r.unknown.isEmpty { Control.log("input: unknown key names ignored: \(r.unknown.joined(separator: ", "))") }
    }

    func setKeymap(_ keymap: [String: String]) {
        releaseAll()
        lock.lock(); codes = resolveKeymap(keymap).codes; lock.unlock()
    }

    func apply(_ state: InputState) {
        lock.lock(); defer { lock.unlock() }
        // Ignore stale reordered packets (sequence restarts from 1 on reconnect; seq 0 = release).
        if state.seq != 0 && state.seq < lastSeq && lastSeq - state.seq < 1_000_000 { return }
        lastSeq = state.seq
        let next = enabled ? activeInputs(state) : []
        let t = keyTransitions(from: held, to: next, codes: codes)
        for c in t.up { post(c, down: false) }
        for c in t.down { post(c, down: true) }
        held = next
    }

    func releaseAll() {
        lock.lock(); defer { lock.unlock() }
        for c in Set(held.compactMap { codes[$0] }) { post(c, down: false) }
        held.removeAll()
        lastSeq = 0
    }

    /// Bring the emulator's (toggle-style) turbo to the requested state. Idempotent.
    func setTurbo(_ on: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard enabled, let hk = turboHotkey, on != turboOn else { return }
        turboOn = on
        post(hk.keyCode, down: true, flags: hk.flags)
        post(hk.keyCode, down: false, flags: hk.flags)
    }

    private func post(_ code: UInt16, down: Bool, flags: UInt64 = 0) {
        guard let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
        e.flags = CGEventFlags(rawValue: flags | intrinsicFlags(forKeyCode: code))
        e.postToPid(pid)
    }
}
