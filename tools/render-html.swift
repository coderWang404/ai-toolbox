// 在本进程里用 WebKit 把 HTML 画成 PNG，不启动 Chrome 或其他应用。
import AppKit
import WebKit

final class Renderer: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let html: URL
    let png: URL
    let delay: TimeInterval
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 960, height: 720))
    var window: NSWindow?

    init(html: URL, png: URL, delay: TimeInterval) {
        self.html = html
        self.png = png
        self.delay = delay
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: web.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.alphaValue = 0
        window.setFrameOrigin(NSPoint(x: -3200, y: -3200))
        window.contentView = web
        window.orderBack(nil)
        self.window = window
        web.navigationDelegate = self
        web.loadFileURL(html, allowingReadAccessTo: html.deletingLastPathComponent())
        DispatchQueue.main.asyncAfter(deadline: .now() + max(delay, 0.4) + 8) {
            fputs("渲染超时\n", stderr)
            exit(1)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + max(delay, 0.05)) {
            let config = WKSnapshotConfiguration()
            config.rect = webView.bounds
            webView.takeSnapshot(with: config) { image, error in
                guard let image, let tiff = image.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let data = rep.representation(using: .png, properties: [:]) else {
                    fputs("截图失败 \(error?.localizedDescription ?? "")\n", stderr)
                    exit(1)
                }
                do {
                    try data.write(to: self.png)
                    exit(0)
                } catch {
                    fputs("\(error)\n", stderr)
                    exit(1)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fputs("\(error)\n", stderr)
        exit(1)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fputs("\(error)\n", stderr)
        exit(1)
    }
}

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    fputs("用法: render-html <html> <png> [延迟毫秒]\n", stderr)
    exit(2)
}
let delay = (Double(arguments.count > 3 ? arguments[3] : "0") ?? 0) / 1000
let renderer = Renderer(
    html: URL(fileURLWithPath: arguments[1]),
    png: URL(fileURLWithPath: arguments[2]),
    delay: delay
)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.delegate = renderer
app.run()
