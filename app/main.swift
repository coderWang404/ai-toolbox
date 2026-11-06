// AI 工具箱 — 桌面 App（主窗口 + 菜单栏图标）
// 本地 AI 小工具集合：供应商热切换、cc-switch 同步、桌面应用跟随、本地网关。
import AppKit

LegacyMigration.run()

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

// MARK: - AppDelegate

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private let windowController = MainWindowController()
    private let backend = Backend.shared
    private lazy var watcher = ConfigWatcher(configPath: configPath)
    private var providers: [ProviderSummary] = []
    private var currentId: String?
    private var menuStatus: String?

    private var configPath: String {
        NSString(string: "~/.codex/config.toml").expandingTildeInPath
    }

    private var defaults: UserDefaults { .standard }

    // MARK: 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainMenu()
        setupStatusItem()

        NotificationCenter.default.addObserver(
            forName: .configWrittenFromApp, object: nil, queue: .main
        ) { [weak self] _ in
            // 自身写入的配置不应触发自动跟随
            self?.watcher.baselineNow()
        }

        NotificationCenter.default.addObserver(
            forName: .watchToggled, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            if self.defaults.bool(forKey: "watchEnabled") {
                self.startWatching()
            } else {
                self.watcher.stop()
            }
        }

        windowController.show { [weak self] providers, currentId in
            self?.providers = providers
            self?.currentId = currentId
            self?.updateStatusTitle()
        }
        if let index = CommandLine.arguments.firstIndex(of: "--page"),
           index + 1 < CommandLine.arguments.count,
           let page = Int(CommandLine.arguments[index + 1]) {
            windowController.selectPage(page)
        }

        if defaults.bool(forKey: "watchEnabled") { startWatching() }
        windowController.setWatchState(watcher.isRunning)
    }

    func applicationWillTerminate(_ notification: Notification) {
        watcher.stop()
        Backend.shared.stopAll()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        windowController.show { [weak self] providers, currentId in
            self?.providers = providers
            self?.currentId = currentId
            self?.updateStatusTitle()
        }
        return true
    }

    private func setupMainMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 AI 工具箱", action: #selector(showAbout), keyEquivalent: "")
            .target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "环境自检…", action: #selector(showDoctor), keyEquivalent: "")
            .target = self
        appMenu.addItem(withTitle: "打开 config.toml", action: #selector(openConfig), keyEquivalent: "")
            .target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 AI 工具箱", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 AI 工具箱", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    // MARK: 菜单栏图标（菜单栏有空间时显示；空间不足时系统会隐藏，不影响主窗口使用）

    private func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "arrow.left.arrow.right.circle.fill",
                                     accessibilityDescription: "AI 工具箱")
        item.button?.toolTip = "AI 工具箱（单击查看供应商）"
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        statusItem = item
        updateStatusTitle()
    }

    private func updateStatusTitle() {
        guard let button = statusItem?.button else { return }
        let showName = defaults.object(forKey: "showNameInMenuBar") as? Bool ?? false
        if showName, let provider = providers.first(where: { $0.id == currentId }) {
            let name = provider.name.count > 10 ? String(provider.name.prefix(10)) + "…" : provider.name
            button.title = " \(name)"
            statusItem?.length = NSStatusItem.variableLength
        } else {
            button.title = ""
            statusItem?.length = NSStatusItem.squareLength
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let header = NSMenuItem(title: headerText(), action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        if let menuStatus {
            let status = NSMenuItem(title: menuStatus, action: nil, keyEquivalent: "")
            status.isEnabled = false
            menu.addItem(status)
        }

        menu.addItem(.sectionHeader(title: "Codex"))
        let openCodex = NSMenuItem(title: "打开 Codex", action: #selector(showCodexPage), keyEquivalent: "")
        openCodex.target = self
        menu.addItem(openCodex)
        let reload = NSMenuItem(title: "重新加载", action: #selector(reloadNow), keyEquivalent: "r")
        reload.target = self
        menu.addItem(reload)
        let watch = NSMenuItem(title: "自动跟随", action: #selector(toggleWatchFromMenu), keyEquivalent: "")
        watch.target = self
        watch.state = watcher.isRunning ? .on : .off
        menu.addItem(watch)
        let remote = NSMenuItem(title: "远程同步", action: #selector(toggleRemoteFromMenu), keyEquivalent: "")
        remote.target = self
        remote.state = windowController.remoteSyncIsOn ? .on : .off
        menu.addItem(remote)
        for line in windowController.barHostLines() {
            let item = NSMenuItem(title: "\(line.label)  ·  \(line.codex)", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        menu.addItem(.sectionHeader(title: "cc-switch"))
        let openCc = NSMenuItem(title: "打开 cc-switch", action: #selector(showCcPage), keyEquivalent: "")
        openCc.target = self
        menu.addItem(openCc)
        let ccSync = NSMenuItem(title: "实时同步", action: #selector(toggleCcFromMenu), keyEquivalent: "")
        ccSync.target = self
        ccSync.state = windowController.ccSyncIsOn ? .on : .off
        menu.addItem(ccSync)
        let check = NSMenuItem(title: "立即检查", action: #selector(checkCcFromMenu), keyEquivalent: "")
        check.target = self
        menu.addItem(check)
        for line in windowController.barHostLines() {
            let item = NSMenuItem(title: "\(line.label)  ·  \(line.ccswitch)", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        menu.addItem(.sectionHeader(title: "智商测试"))
        let openIq = NSMenuItem(title: "打开智商测试", action: #selector(showIqPage), keyEquivalent: "")
        openIq.target = self
        menu.addItem(openIq)

        menu.addItem(.sectionHeader(title: "额度"))
        let openQuota = NSMenuItem(title: "打开额度", action: #selector(showQuotaPage), keyEquivalent: "")
        openQuota.target = self
        menu.addItem(openQuota)
        let openCode = NSMenuItem(title: "OpenCode 额度", action: #selector(showOpenCodeQuota), keyEquivalent: "")
        openCode.target = self
        menu.addItem(openCode)
        let openCline = NSMenuItem(title: "ClinePass 额度", action: #selector(showClineQuota), keyEquivalent: "")
        openCline.target = self
        menu.addItem(openCline)

        menu.addItem(.sectionHeader(title: "网关与网络"))
        let openGateway = NSMenuItem(title: "打开网关与网络", action: #selector(showGatewayPage), keyEquivalent: "")
        openGateway.target = self
        menu.addItem(openGateway)
        let openGrok = NSMenuItem(title: "Grok Bot", action: #selector(showGrokPage), keyEquivalent: "")
        openGrok.target = self
        menu.addItem(openGrok)
        let openToday = NSMenuItem(title: "Today", action: #selector(showTodayPage), keyEquivalent: "")
        openToday.target = self
        menu.addItem(openToday)
        let openQoderNetwork = NSMenuItem(title: "Qoder 网络", action: #selector(showQoderNetworkPage), keyEquivalent: "")
        openQoderNetwork.target = self
        menu.addItem(openQoderNetwork)

        menu.addItem(.sectionHeader(title: "网络测速"))
        let openSpeed = NSMenuItem(title: "打开测速", action: #selector(showSpeedPage), keyEquivalent: "")
        openSpeed.target = self
        menu.addItem(openSpeed)

        menu.addItem(.separator())
        let nameItem = NSMenuItem(title: "菜单栏显示供应商名称", action: #selector(toggleShowName), keyEquivalent: "")
        nameItem.target = self
        nameItem.state = (defaults.object(forKey: "showNameInMenuBar") as? Bool ?? false) ? .on : .off
        menu.addItem(nameItem)
        let doctor = NSMenuItem(title: "环境自检…", action: #selector(showDoctor), keyEquivalent: "")
        doctor.target = self
        menu.addItem(doctor)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出 AI 工具箱", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    private func headerText() -> String {
        if let provider = providers.first(where: { $0.id == currentId }) {
            return "当前: \(provider.name) · \(provider.model ?? "-")"
        }
        return "当前: (未知)"
    }

    // MARK: 操作

    @objc private func showWindow() {
        windowController.show { [weak self] providers, currentId in
            self?.providers = providers
            self?.currentId = currentId
            self?.updateStatusTitle()
        }
    }

    @objc private func showCodexPage() {
        windowController.selectPage(0)
        showWindow()
    }

    @objc private func showIqPage() {
        windowController.selectPage(2)
        showWindow()
    }

    @objc private func showQuotaPage() {
        windowController.selectPage(3)
        showWindow()
    }

    @objc private func showOpenCodeQuota() {
        windowController.selectPage(3)
        windowController.selectQuotaTab(0)
        showWindow()
    }

    @objc private func showClineQuota() {
        windowController.selectPage(3)
        windowController.selectQuotaTab(1)
        showWindow()
    }

    @objc private func showGatewayPage() {
        windowController.selectPage(4)
        showWindow()
    }

    @objc private func showGrokPage() {
        windowController.selectPage(4)
        windowController.selectGatewayTab(0)
        showWindow()
    }

    @objc private func showTodayPage() {
        windowController.selectPage(4)
        windowController.selectGatewayTab(1)
        showWindow()
    }

    @objc private func showQoderNetworkPage() {
        windowController.selectPage(4)
        windowController.selectGatewayTab(2)
        showWindow()
    }

    @objc private func showSpeedPage() {
        windowController.selectPage(5)
        showWindow()
    }

    @objc private func showCcPage() {
        windowController.selectPage(1)
        showWindow()
    }

    @objc private func toggleRemoteFromMenu() {
        windowController.setRemoteSyncEnabled(!windowController.remoteSyncIsOn)
        menuStatus = windowController.remoteSyncIsOn ? "已开启 Codex 远程同步" : "已关闭 Codex 远程同步"
    }

    @objc private func toggleCcFromMenu() {
        windowController.setCcSyncEnabled(!windowController.ccSyncIsOn)
        menuStatus = windowController.ccSyncIsOn ? "已开启 cc-switch 实时同步" : "已关闭 cc-switch 实时同步"
    }

    @objc private func checkCcFromMenu() {
        windowController.selectPage(1)
        windowController.checkCcSwitchFromMenu()
        menuStatus = "正在检查远程 cc-switch…"
        showWindow()
    }

    @objc private func reloadNow() {
        menuStatus = "正在重新加载 Codex…"
        let scope = defaults.string(forKey: "scope") ?? "chatgpt"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let remote = self.defaults.object(forKey: "syncRemote") as? Bool ?? true
                let result = try self.backend.reload(scope: scope, remote: remote)
                let remoteText = result.remote?.hosts.map { host in
                    host.ok ? (host.changed ? "\(host.label) 已同步" : "\(host.label) 已一致") : "\(host.label) 失败"
                }.joined(separator: "、") ?? ""
                DispatchQueue.main.async {
                    let suffix = remoteText.isEmpty ? "" : " · 远程 \(remoteText)"
                    self.menuStatus = "✔ 已重新加载\(suffix)"
                    self.windowController.setStatus("✔ 已重新加载 Codex\(suffix)")
                }
            } catch {
                DispatchQueue.main.async { self.menuStatus = "❌ \(error.localizedDescription)" }
            }
        }
    }

    @objc private func toggleWatchFromMenu() {
        if watcher.isRunning {
            watcher.stop()
            defaults.set(false, forKey: "watchEnabled")
            menuStatus = "已关闭自动跟随"
        } else {
            startWatching()
            menuStatus = "已开启自动跟随"
        }
        windowController.setWatchState(watcher.isRunning)
    }

    @objc private func toggleShowName() {
        let current = defaults.object(forKey: "showNameInMenuBar") as? Bool ?? false
        defaults.set(!current, forKey: "showNameInMenuBar")
        updateStatusTitle()
    }

    private func startWatching() {
        watcher.onChanged = { [weak self] in
            guard let self else { return }
            self.menuStatus = "检测到配置变化，正在热重启…"
            self.windowController.autoReloadAfterChange { [weak self] in
                guard let self else { return }
                self.menuStatus = "⚡ 已自动跟随切换"
                self.windowController.refresh()
            }
        }
        watcher.start()
        defaults.set(true, forKey: "watchEnabled")
        menuStatus = "已开启自动跟随"
    }

    @objc private func openConfig() {
        NSWorkspace.shared.open(URL(fileURLWithPath: configPath))
    }

    @objc func showAbout() {
        let alert = NSAlert()
        alert.messageText = "AI 工具箱"
        alert.informativeText = """
        本地 AI 小工具集合：Codex 供应商热切换、cc-switch 同步、额度查询、本机网关与网络检查。

        · 原理：切换配置后只重启 Codex 的 app-server 子进程
        · Codex：自动跟随本机供应商，并把供应商配置同步到远程
        · cc-switch：以本机配置为准，实时同步远程的供应商、端点和当前选择
        · 额度：OpenCode 与 ClinePass 的密钥额度，同页分段查看
        · 网关与网络：Grok Bot / Today 的 OpenAI 兼容网关，以及 Qoder 的 DNS/hosts、Clash、HTTPDNS 状态
        · 工具目录：\(backend.scriptPath.map { URL(fileURLWithPath: $0).deletingLastPathComponent().deletingLastPathComponent().path } ?? "未找到")
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "好")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc private func showDoctor() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let message: String
            do {
                let result = try self.backend.doctor()
                message = result.checks.map { "\($0.ok ? "通过" : "未通过")  \($0.label)" }.joined(separator: "\n")
            } catch {
                message = "自检失败: \(error.localizedDescription)"
            }
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "环境自检"
                alert.informativeText = message
                alert.alertStyle = .informational
                alert.addButton(withTitle: "好")
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
            }
        }
    }
}
