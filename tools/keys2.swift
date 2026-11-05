// 改进版键盘注入：显式 CGEventSource + 可定向投递到指定 PID，绕开 nil source 的兼容问题。
// 用法：keys2 --post <pid|global> <动作...>
//   动作：cmd-l cmd-opt-j cmd-a cmd-v cmd-c cmd-t enter esc tab type:<文本> sleep:<毫秒>
import CoreGraphics
import Foundation
import AppKit

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: keys2 --post <pid|global> <动作...>\n".data(using: .utf8)!)
    exit(2)
}

var targetPid: pid_t? = nil
var actions: [String] = []
var i = 0
while i < args.count {
    if args[i] == "--post" {
        let v = args[i + 1]
        if v != "global" { targetPid = pid_t(Int32(v)!) }
        i += 2
    } else {
        actions.append(args[i])
        i += 1
    }
}

let source = CGEventSource(stateID: .hidSystemState)

func post(_ e: CGEvent) {
    if let p = targetPid {
        e.postToPid(p)
    } else {
        e.post(tap: .cghidEventTap)
    }
    usleep(20_000)
}

func key(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags) {
    guard let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
    e.flags = flags
    post(e)
}

func tap(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
    key(code, true, flags)
    key(code, false, flags)
}

// macOS ANSI 虚拟键码（务必对照 HIToolbox Events.h，0x0C 是 Q 不是 L）
let codes: [String: CGKeyCode] = [
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05,
    "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B,
    "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11,
    "o": 0x1F, "u": 0x20, "i": 0x22, "p": 0x23,
    "l": 0x25, "j": 0x26, "k": 0x28, "n": 0x2D, "m": 0x2E,
    "enter": 0x24, "esc": 0x35, "tab": 0x30,
]

func typeText(_ text: String) {
    for u in text.utf16 {
        var ch = u
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) else { continue }
        down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
        post(down)
        guard let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { continue }
        up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
        post(up)
    }
}

func clickAt(_ x: Double, _ y: Double) {
    let p = CGPoint(x: x, y: y)
    if let m = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) { post(m) }
    if let d = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left) { post(d) }
    if let u = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left) { post(u) }
}

// US 键盘字符 → (虚拟键码, 是否需要 Shift)。逐字发真实键码，比 unicode 注入可靠。
let charMap: [Character: (CGKeyCode, Bool)] = [
    "a": (0x00, false), "s": (0x01, false), "d": (0x02, false), "f": (0x03, false),
    "h": (0x04, false), "g": (0x05, false), "z": (0x06, false), "x": (0x07, false),
    "c": (0x08, false), "v": (0x09, false), "b": (0x0B, false), "q": (0x0C, false),
    "w": (0x0D, false), "e": (0x0E, false), "r": (0x0F, false), "y": (0x10, false),
    "t": (0x11, false), "1": (0x12, false), "2": (0x13, false), "3": (0x14, false),
    "4": (0x15, false), "6": (0x16, false), "5": (0x17, false), "=": (0x18, false),
    "9": (0x19, false), "7": (0x1A, false), "-": (0x1B, false), "8": (0x1C, false),
    "0": (0x1D, false), "]": (0x1E, false), "o": (0x1F, false), "u": (0x20, false),
    "[": (0x21, false), "i": (0x22, false), "p": (0x23, false), "l": (0x25, false),
    "j": (0x26, false), "'": (0x27, false), "k": (0x28, false), ";": (0x29, false),
    "\\": (0x2A, false), ",": (0x2B, false), "/": (0x2C, false), "n": (0x2D, false),
    "m": (0x2E, false), ".": (0x2F, false), " ": (0x31, false), "`": (0x32, false),
    // Shift 组合
    ":": (0x29, true), "+": (0x18, true), "?": (0x2C, true), "_": (0x1B, true),
    "\"": (0x27, true), "!": (0x12, true), "@": (0x13, true), "#": (0x14, true),
    "$": (0x15, true), "%": (0x17, true), "^": (0x16, true), "&": (0x1A, true),
    "*": (0x1C, true), "(": (0x19, true), ")": (0x1D, true), "{": (0x21, true),
    "}": (0x1E, true), "|": (0x2A, true), "<": (0x2B, true), ">": (0x2F, true),
    "~": (0x32, true),
]

func typeKeys(_ text: String) {
    for ch in text {
        let lower = Character(ch.lowercased())
        guard let (code, shift) = charMap[lower] else { continue }
        let needShift = shift || (ch.isUppercase)
        key(code, true, needShift ? .maskShift : [])
        key(code, false, needShift ? .maskShift : [])
    }
}

for a in actions {
    switch true {
    case a == "cmd-l": tap(codes["l"]!, .maskCommand)
    case a == "ctrl-space": tap(0x31, .maskControl)
    case a == "ctrl-opt-space": tap(0x31, [.maskControl, .maskAlternate])
    case a == "cmd-w": tap(codes["w"]!, .maskCommand)
    case a == "cmd-r": tap(codes["r"]!, .maskCommand)
    case a == "cmd-t": tap(codes["t"]!, .maskCommand)
    case a == "cmd-opt-j":
        tap(codes["j"]!, [.maskCommand, .maskAlternate])
    case a == "cmd-opt-i":
        tap(codes["i"]!, [.maskCommand, .maskAlternate])
    case a == "cmd-a": tap(codes["a"]!, .maskCommand)
    case a == "cmd-v": tap(codes["v"]!, .maskCommand)
    case a == "cmd-c": tap(codes["c"]!, .maskCommand)
    case a == "enter": tap(codes["enter"]!)
    case a == "backspace": tap(0x33)
    case a == "esc": tap(codes["esc"]!)
    case a == "tab": tap(codes["tab"]!)
    case a.hasPrefix("type:"): typeText(String(a.dropFirst(5)))
    case a.hasPrefix("keys:"): typeKeys(String(a.dropFirst(5)))
    case a.hasPrefix("paste:"):
        let text = String(a.dropFirst(6))
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        tap(codes["v"]!, .maskCommand)
    case a.hasPrefix("click:"):
        let p = String(a.dropFirst(6)).split(separator: ",")
        if p.count == 2, let x = Double(p[0]), let y = Double(p[1]) { clickAt(x, y) }
    case a.hasPrefix("sleep:"): usleep(UInt32(a.dropFirst(6))! * 1000)
    default: break
    }
}
