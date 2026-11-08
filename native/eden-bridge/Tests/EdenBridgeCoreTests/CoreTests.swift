import XCTest
@testable import EdenBridgeCore

final class CoreTests: XCTestCase {
    func testFrameRoundTrip() {
        let f = WireFrame(type: .video, timestamp: 123_456_789, payload: Data([1, 2, 3]))
        XCTAssertEqual(WireFrame.decode(f.encoded()), f)
        XCTAssertNil(WireFrame.decode(Data([0x11, 0, 0])))
        XCTAssertNil(WireFrame.decode(Data(repeating: 0xFF, count: 12)))
    }

    /// Bytes produced by encodeInput(7, A|B, {lx:-1, ly:0.5, rx:0, ry:0.25}) in TypeScript.
    func testInputDecodeMatchesTypeScript() {
        var p = Data()
        func u32(_ v: UInt32) { var b = v.bigEndian; withUnsafeBytes(of: &b) { p.append(contentsOf: $0) } }
        u32(7); u32(0b11)
        for f: Float in [-1, 0.5, 0, 0.25] { u32(f.bitPattern) }
        let s = InputState.decode(p)!
        XCTAssertEqual(s.seq, 7)
        XCTAssertEqual(activeInputs(s), ["A", "B", "LLeft", "LDown"])
        XCTAssertNil(InputState.decode(Data(count: 23)))
    }

    func testNonFiniteAxesAreClamped() {
        var p = Data(count: 8)
        for f: Float in [.nan, .infinity, 5, -5] { var b = f.bitPattern.bigEndian; withUnsafeBytes(of: &b) { p.append(contentsOf: $0) } }
        let s = InputState.decode(p)!
        XCTAssertEqual([s.lx, s.ly, s.rx, s.ry], [0, 0, 1, -1])
    }

    func testTokenAndOrigin() {
        XCTAssertTrue(constantTimeEqual(Data("abc".utf8), Data("abc".utf8)))
        XCTAssertFalse(constantTimeEqual(Data("abc".utf8), Data("abd".utf8)))
        XCTAssertFalse(constantTimeEqual(Data("abc".utf8), Data("abcd".utf8)))
        XCTAssertTrue(isAllowedOrigin("vscode-webview://1abc"))
        XCTAssertFalse(isAllowedOrigin("https://evil.example"))
        XCTAssertFalse(isAllowedOrigin(nil))
        XCTAssertFalse(isAllowedOrigin("null"))
    }

    func testKeymap() {
        let r = resolveKeymap(["A": "C", "Up": "UpArrow", "ZL": "Digit1", "B": "NotAKey"])
        XCTAssertEqual(r.codes["A"], 0x08)
        XCTAssertEqual(r.codes["Up"], 0x7E)
        XCTAssertEqual(r.codes["ZL"], 0x12)
        XCTAssertEqual(r.unknown, ["B=NotAKey"])
        let t = keyTransitions(from: ["A", "Up"], to: ["A", "ZL"], codes: r.codes)
        XCTAssertEqual(t.down, [0x12])
        XCTAssertEqual(t.up, [0x7E])
    }

    func testCodecString() {
        XCTAssertEqual(avcCodecString(avcC: Data([1, 0x64, 0x00, 0x1F, 0xFF])), "avc1.64001f")
        XCTAssertNil(avcCodecString(avcC: Data([0, 1])))
    }

    func testHotkeyParsing() {
        XCTAssertEqual(parseHotkey("cmd+Z"), Hotkey(keyCode: 0x06, flags: ModifierFlag.command))
        XCTAssertEqual(parseHotkey("Ctrl+Shift+F5"), Hotkey(keyCode: 0x60, flags: ModifierFlag.control | ModifierFlag.shift))
        XCTAssertNil(parseHotkey("hyper+Z"))
        XCTAssertNil(parseHotkey("cmd+"))
        XCTAssertEqual(WireType(rawValue: 0x23), .turbo)
    }

    func testArrowKeysCarryKeyboardFlags() {
        XCTAssertEqual(intrinsicFlags(forKeyCode: 0x7E), 0xA00000) // UpArrow: numericPad | secondaryFn
        XCTAssertEqual(intrinsicFlags(forKeyCode: 0x60), 0x800000) // F5
        XCTAssertEqual(intrinsicFlags(forKeyCode: 0x08), 0) // C
    }
}
