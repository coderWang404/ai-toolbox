// 打印屏幕与 Chrome 窗口的坐标信息，用于校准 CGEvent 点击坐标。
import AppKit
import ApplicationServices

for (i, s) in NSScreen.screens.enumerated() {
    print("Screen[\(i)] frame=\(s.frame) visible=\(s.visibleFrame) backingScale=\(s.backingScaleFactor)")
}
print("CGDisplayPixelsWide: \(CGDisplayPixelsWide(CGMainDisplayID()))  PixelsHigh: \(CGDisplayPixelsHigh(CGMainDisplayID()))")
print("CGDisplayBounds: \(CGDisplayBounds(CGMainDisplayID()))")
print("鼠标当前(CGEvent): \(CGEvent(source: nil)?.location ?? .zero)")

if let chrome = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome").first {
    let app = AXUIElementCreateApplication(chrome.processIdentifier)
    var wins: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &wins) == .success,
       let list = wins as? [AXUIElement] {
        for (i, w) in list.enumerated() {
            var pos: CFTypeRef?, size: CFTypeRef?
            AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &pos)
            AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &size)
            var p = CGPoint.zero, s = CGSize.zero
            if let pos { AXValueGetValue(pos as! AXValue, .cgPoint, &p) }
            if let size { AXValueGetValue(size as! AXValue, .cgSize, &s) }
            var t: CFTypeRef?
            AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t)
            print("Window[\(i)] pos=\(p) size=\(s) title=\((t as? String ?? "").prefix(30))")
        }
    }
}
