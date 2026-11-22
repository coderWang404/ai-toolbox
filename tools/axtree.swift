// 转储 Chrome 的辅助功能树，用于定位地址栏（AXTextField）等元素。
import ApplicationServices
import AppKit
import Foundation

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    let r = AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return r == .success ? v : nil
}

func walk(_ el: AXUIElement, _ depth: Int, _ maxDepth: Int) {
    if depth > maxDepth { return }
    let role = attr(el, kAXRoleAttribute) as? String ?? "?"
    let sub = attr(el, kAXSubroleAttribute) as? String ?? ""
    let title = attr(el, kAXTitleAttribute) as? String ?? ""
    let value = attr(el, kAXValueAttribute) as? String ?? ""
    let desc = attr(el, kAXDescriptionAttribute) as? String ?? ""
    let indent = String(repeating: "  ", count: depth)
    var line = "\(indent)\(role)"
    if !sub.isEmpty { line += "/\(sub)" }
    if !title.isEmpty { line += " title=\"\(title.prefix(40))\"" }
    if !desc.isEmpty { line += " desc=\"\(desc.prefix(30))\"" }
    if !value.isEmpty { line += " value=\"\(value.prefix(50))\"" }
    print(line)
    if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
        for k in kids { walk(k, depth + 1, maxDepth) }
    }
}

guard let chrome = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome").first else {
    print("Chrome 未运行"); exit(0)
}
let app = AXUIElementCreateApplication(chrome.processIdentifier)
print("=== Chrome AX 树（前 6 层）===")
walk(app, 0, 6)
