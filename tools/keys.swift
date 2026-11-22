// 最小键盘事件工具：用 CGEvent 直发键盘，不经过 AppleScript（绕开 Apple Events 的 TCC 限制）。
// 用法：keys cmd-l | keys enter | keys type "文本" | keys cmd-opt-j
import CoreGraphics
import Foundation

func key(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags = []) {
    guard let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { return }
    e.flags = flags
    e.post(tap: .cghidEventTap)
    usleep(18_000)
}

func tap(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
    key(code, true, flags)
    key(code, false, flags)
}

let codes: [String: CGKeyCode] = [
    "l": 0x0C, "j": 0x0C, "a": 0x00, "v": 0x09, "c": 0x08,
    "enter": 0x24, "esc": 0x35, "tab": 0x30, "cmd": 0x37, "opt": 0x3A,
]

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: keys cmd-l | keys enter | keys type \"文本\"\n".data(using: .utf8)!)
    exit(2)
}

func run(_ cmd: String) {
    switch cmd {
    case "cmd-l":
        tap(codes["l"]!, .maskCommand)
    case "cmd-opt-j":
        key(codes["opt"]!, true, .maskAlternate)
        key(codes["cmd"]!, true, [.maskCommand, .maskAlternate])
        tap(codes["j"]!, [.maskCommand, .maskAlternate])
        key(codes["cmd"]!, false)
        key(codes["opt"]!, false)
    case "cmd-a":
        tap(codes["a"]!, .maskCommand)
    case "cmd-v":
        tap(codes["v"]!, .maskCommand)
    case "cmd-c":
        tap(codes["c"]!, .maskCommand)
    case "enter":
        tap(codes["enter"]!)
    case "esc":
        tap(codes["esc"]!)
    case "tab":
        tap(codes["tab"]!)
    case "type":
        guard args.count >= 3 else { return }
        let text = args[2]
        for u in text.utf16 {
            var ch = u
            guard let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else { continue }
            e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
            e.post(tap: .cghidEventTap)
            usleep(6_000)
        }
    default:
        break
    }
}

for c in args.dropFirst() { run(c) }
