import Foundation

/// macOS virtual key codes (Carbon kVK_*) for names usable in retroverse.switch.keyboardMap.
public let virtualKeyCodes: [String: UInt16] = {
    var m: [String: UInt16] = [
        "A": 0x00, "S": 0x01, "D": 0x02, "F": 0x03, "H": 0x04, "G": 0x05, "Z": 0x06, "X": 0x07,
        "C": 0x08, "V": 0x09, "B": 0x0B, "Q": 0x0C, "W": 0x0D, "E": 0x0E, "R": 0x0F, "Y": 0x10,
        "T": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "9": 0x19,
        "7": 0x1A, "8": 0x1C, "0": 0x1D, "O": 0x1F, "U": 0x20, "I": 0x22, "P": 0x23, "L": 0x25,
        "J": 0x26, "K": 0x28, "N": 0x2D, "M": 0x2E,
        "Return": 0x24, "Tab": 0x30, "Space": 0x31, "Delete": 0x33, "Escape": 0x35,
        "LeftArrow": 0x7B, "RightArrow": 0x7C, "DownArrow": 0x7D, "UpArrow": 0x7E,
        "F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60, "F6": 0x61,
        "F7": 0x62, "F8": 0x64, "F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F,
    ]
    for d in 0...9 { m["Digit\(d)"] = m["\(d)"] }
    return m
}()

/// Resolve a logical-input -> key-name map into key codes, dropping unknown names.
public func resolveKeymap(_ names: [String: String]) -> (codes: [String: UInt16], unknown: [String]) {
    var codes: [String: UInt16] = [:]
    var unknown: [String] = []
    for (input, key) in names {
        if let c = virtualKeyCodes[key] ?? virtualKeyCodes[key.uppercased()] { codes[input] = c } else { unknown.append("\(input)=\(key)") }
    }
    return (codes, unknown.sorted())
}

/// Key transitions needed to go from `old` held inputs to `new`.
public func keyTransitions(from old: Set<String>, to new: Set<String>, codes: [String: UInt16]) -> (down: [UInt16], up: [UInt16]) {
    let up = old.subtracting(new).compactMap { codes[$0] }
    let down = new.subtracting(old).compactMap { codes[$0] }
    return (Array(Set(down)).sorted(), Array(Set(up)).sorted())
}

/// CGEventFlags bit values (kept here so the core stays free of CoreGraphics).
public enum ModifierFlag {
    public static let shift: UInt64 = 0x20000
    public static let control: UInt64 = 0x40000
    public static let option: UInt64 = 0x80000
    public static let command: UInt64 = 0x100000
}

/// Flags a physical keyboard sets for a key. Arrow keys carry NumericPad + SecondaryFn and F-keys carry
/// SecondaryFn; Qt's macOS key translation treats arrows without them differently, so synthetic events match.
public func intrinsicFlags(forKeyCode code: UInt16) -> UInt64 {
    let numericPad: UInt64 = 0x200000, secondaryFn: UInt64 = 0x800000
    switch code {
    case 0x7B...0x7E: return numericPad | secondaryFn
    case 0x60...0x6F, 0x76, 0x78, 0x7A: return secondaryFn
    default: return 0
    }
}

public struct Hotkey: Equatable {
    public let keyCode: UInt16
    public let flags: UInt64
}

/// Parse "cmd+shift+Z" style hotkeys (case-insensitive modifiers: cmd, ctrl, alt/option, shift).
public func parseHotkey(_ s: String) -> Hotkey? {
    let parts = s.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    guard let keyName = parts.last else { return nil }
    var flags: UInt64 = 0
    for m in parts.dropLast() {
        switch m.lowercased() {
        case "cmd", "command", "meta": flags |= ModifierFlag.command
        case "ctrl", "control": flags |= ModifierFlag.control
        case "alt", "option", "opt": flags |= ModifierFlag.option
        case "shift": flags |= ModifierFlag.shift
        default: return nil
        }
    }
    guard let code = virtualKeyCodes[keyName] ?? virtualKeyCodes[keyName.uppercased()] else { return nil }
    return Hotkey(keyCode: code, flags: flags)
}
