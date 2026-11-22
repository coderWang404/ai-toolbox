// 诊断本机事件注入与辅助功能 API 是否真正可用。
import CoreGraphics
import Foundation
import ApplicationServices
import AppKit

func log(_ s: String) { print(s); fflush(stdout) }

log("AXIsProcessTrusted: \(AXIsProcessTrusted())")

// 1) 鼠标位置变化
let before = CGEvent(source: nil)?.location ?? .zero
log("鼠标位置(before): \(before)")
let src = CGEventSource(stateID: .hidSystemState)
if let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: 400, y: 400), mouseButton: .left) {
    move.post(tap: .cghidEventTap)
}
usleep(300_000)
let after = CGEvent(source: nil)?.location ?? .zero
log("鼠标位置(after hid): \(after)  -> \(before != after ? "事件生效" : "事件无效")")
if let move2 = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: 500, y: 500), mouseButton: .left) {
    move2.post(tap: .cgSessionEventTap)
}
usleep(300_000)
log("鼠标位置(after session): \(CGEvent(source: nil)?.location ?? .zero)")

// 2) 找到 Chrome 并读它的 AX 信息
guard let chrome = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome").first else {
    log("Chrome 未运行")
    exit(0)
}
log("Chrome pid: \(chrome.processIdentifier)")
let appEl = AXUIElementCreateApplication(chrome.processIdentifier)
var winVal: CFTypeRef?
let r1 = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &winVal)
log("读 AXWindows: \(r1.rawValue) \(r1 == .success ? "成功" : "失败")")
if r1 == .success, let wins = winVal as? [AXUIElement], let w = wins.first {
    var titleVal: CFTypeRef?
    AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &titleVal)
    log("窗口标题: \(titleVal as? String ?? "(空)")")
    // 找地址栏：遍历 toolbar 下的 AXTextField
    func findTextField(_ el: AXUIElement, depth: Int) -> AXUIElement? {
        if depth > 6 { return nil }
        var roleVal: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        let role = roleVal as? String ?? ""
        if role == "AXTextField" { return el }
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
           let kids = children as? [AXUIElement] {
            for k in kids { if let f = findTextField(k, depth: depth + 1) { return f } }
        }
        return nil
    }
    if let field = findTextField(w, depth: 0) {
        var v: CFTypeRef?
        AXUIElementCopyAttributeValue(field, kAXValueAttribute as CFString, &v)
        log("地址栏当前值: \(v as? String ?? "(空)")")
    } else {
        log("未找到 AXTextField（地址栏）")
    }
}
