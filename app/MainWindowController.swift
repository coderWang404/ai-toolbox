// 主窗口：供应商列表 + 一键热切换 + 自动跟随。
import AppKit
import ServiceManagement
import WebKit

final class MainWindowController: NSObject, NSWindowDelegate, NSToolbarDelegate, NSTableViewDataSource, NSTableViewDelegate {
    private var window: NSWindow!
    private var tableView: NSTableView!
    private var headerLabel: NSTextField!
    private var effectiveLabel: NSTextField!
    private var statusLabel: StatusLine!
    private var reloadButton: NSButton!
    private var watchSwitch: NSSwitch!
    private var scopePopup: NSPopUpButton!
    private var focusSwitch: NSSwitch!
    private var remoteSwitch: NSSwitch!
    private var loginSwitch: NSSwitch!
    private var spinner: NSProgressIndicator!
    private var remoteRows: NSStackView!
    private var ccRows: NSStackView!
    private var sidebar: SettingsSidebarController!
    private var iqPane: NSView!
    private var quotaPane: NSView!
    private var quotaController: GoQuotaPane!
    private var clinePane: NSView!
    private var clineController: ClineQuotaPane!
    private var grokPane: NSView!
    private var grokController: GrokBotPane!
    private var speedPane: NSView!
    private var speedController: SpeedPane!
    private let codexKeyHost = NSStackView()
    private let claudeKeyHost = NSStackView()
    private var iqProviderPopup: NSPopUpButton!
    private var iqTopicPopup: NSPopUpButton!
    private var iqModelPopup: NSPopUpButton!
    private var iqThinkingControl: NSSegmentedControl!
    private var iqThinkingLevels: [String] = ["off"]
    private var iqStatusLabel: StatusLine!
    private var iqWeb: QuietWebView!
    private var iqPreviewHeight: NSLayoutConstraint?
    private var iqFitWidth: CGFloat = 0
    private var iqFitPasses = 0
    private var iqReply: NSTextView!
    private var iqReplyScroll: NSScrollView!
    private var iqLogScroll: NSScrollView!
    private var iqLogHeight: NSLayoutConstraint!
    private var iqRunButton: NSButton!
    private var iqCancelButton: NSButton!
    private var iqPhase = "idle"
    private var iqEmptyLabel: NSTextField!
    private var iqMetaLabel: NSTextField!
    private var iqLog: NSTextView!
    private var codexNote: NSTextField!
    private var claudeNote: NSTextField!
    private var providerTableHeight: NSLayoutConstraint!
    private var claudeTableHeight: NSLayoutConstraint!
    private var codexPane: NSView!
    private var claudePane: NSView!
    private var ccPane: NSView!
    private var claudeTableView: NSTableView!
    private var claudeHeaderLabel: NSTextField!
    private var claudeEffectiveLabel: NSTextField!
    private var claudeStatusLabel: StatusLine!
    private var claudeWatchSwitch: NSSwitch!
    private var ccSyncSwitch: NSSwitch!
    private var ccStatusLabel: StatusLine!
    private var addRemoteButton: NSButton!
    private let remotes = RemoteStore.shared

    private let backend = Backend.shared
    private var providers: [ProviderSummary] = []
    private var claudeProviders: [ProviderSummary] = []
    private var currentId: String?
    private var claudeCurrentId: String?
    private var claudeLive: ClaudeLiveInfo?
    private var liveInfo: LiveInfo?
    private var remoteLive: [String: RemoteHostInfo] = [:]
    private var ccSwitchLive: [String: CcSwitchHostInfo] = [:]
    private var ccSwitchTimer: Timer?
    private var ccSwitchBusy = false
    private var ccSwitchHash: String?
    private var ccSwitchPending = Set<String>()
    private var ccSwitchAttempts: [String: Int] = [:]
    private var ccSwitchBootstrapped = false
    private var ccSwitchLastAttempt = Date.distantPast
    private var ccSwitchRunning = false
    private var iqProviders: [IqProvider] = []
    private var iqCatalogTimer: Timer?
    private var iqCatalogStamp: TimeInterval = 0
    private var iqDidLoadResult = false
    private var busy = false
    private var pendingAutoReload = false
    private var pendingAutoReloadDone: (() -> Void)?
    private var onProvidersChanged: (([ProviderSummary], String?) -> Void)?

    private var defaults: UserDefaults { .standard }

    var isVisible: Bool { window?.isVisible ?? false }

    func show(onProvidersChanged: @escaping ([ProviderSummary], String?) -> Void) {
        self.onProvidersChanged = onProvidersChanged
        if window == nil { buildWindow() }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        refresh()
        refreshClaude()
    }

    func hide() { window?.orderOut(nil) }

    // MARK: - 构建界面

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 880, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = AppIdentity.displayName
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 760, height: 520)
        window.isRestorable = false
        window.delegate = self
        window.center()
        window.isReleasedWhenClosed = false
        let toolbar = NSToolbar(identifier: "ai-toolbox.main")
        toolbar.delegate = self
        window.toolbar = toolbar
        window.toolbarStyle = .unified

        headerLabel = makeLabel("加载中…", font: .systemFont(ofSize: 15, weight: .semibold), color: .labelColor)
        effectiveLabel = makeLabel("", font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
        effectiveLabel.lineBreakMode = .byTruncatingMiddle
        codexNote = makeLabel("", font: .systemFont(ofSize: 11), color: .secondaryLabelColor)
        codexNote.lineBreakMode = .byWordWrapping
        codexNote.maximumNumberOfLines = 3
        statusLabel = StatusLine()

        tableView = makeProviderTable(action: #selector(rowClicked))
        let providerScroll = makeTableScroll(tableView)
        providerTableHeight = providerScroll.heightAnchor.constraint(equalToConstant: 176)
        providerTableHeight.isActive = true

        reloadButton = NSButton(title: "重新加载", target: self, action: #selector(reloadNow))
        reloadButton.bezelStyle = .rounded
        reloadButton.controlSize = .regular
        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        let currentAccessory = NSStackView(views: [spinner, reloadButton])
        currentAccessory.orientation = .horizontal
        currentAccessory.alignment = .centerY
        currentAccessory.spacing = 8
        codexKeyHost.orientation = .vertical
        codexKeyHost.alignment = .leading
        codexKeyHost.spacing = 4
        let currentTexts = NSStackView(views: [headerLabel, effectiveLabel, codexKeyHost])
        currentTexts.orientation = .vertical
        currentTexts.alignment = .leading
        currentTexts.spacing = 2
        codexKeyHost.widthAnchor.constraint(equalTo: currentTexts.widthAnchor).isActive = true
        let currentRow = NSStackView(views: [currentTexts, flexibleSpace(), currentAccessory])
        currentRow.orientation = .horizontal
        currentRow.alignment = .centerY
        let currentGroup = GroupBox()
        currentGroup.addRow(currentRow)

        watchSwitch = makeSwitch(action: #selector(toggleWatch))
        watchSwitch.state = defaults.bool(forKey: "watchEnabled") ? .on : .off
        remoteSwitch = makeSwitch(action: #selector(toggleRemote))
        remoteSwitch.state = (defaults.object(forKey: "syncRemote") as? Bool ?? true) ? .on : .off
        let followGroup = GroupBox()
        followGroup.addRow(SettingRow(title: "自动跟随 cc-switch", subtitle: "cc-switch 里切换后自动热重启 Codex", accessory: watchSwitch))
        followGroup.addRow(SettingRow(title: "远程同步", subtitle: "把本机供应商同步到已启用的机器", accessory: remoteSwitch))

        remoteRows = NSStackView()
        remoteRows.orientation = .vertical
        remoteRows.alignment = .leading
        remoteRows.spacing = 0
        addRemoteButton = linkButton(title: "添加机器", symbol: "plus", action: #selector(addRemote))
        rebuildRemoteRows()
        let remoteGroup = GroupBox()
        remoteRows.translatesAutoresizingMaskIntoConstraints = false
        remoteGroup.addSubview(remoteRows)
        NSLayoutConstraint.activate([
            remoteRows.topAnchor.constraint(equalTo: remoteGroup.topAnchor),
            remoteRows.leadingAnchor.constraint(equalTo: remoteGroup.leadingAnchor),
            remoteRows.trailingAnchor.constraint(equalTo: remoteGroup.trailingAnchor),
            remoteRows.bottomAnchor.constraint(equalTo: remoteGroup.bottomAnchor),
            remoteRows.widthAnchor.constraint(equalTo: remoteGroup.widthAnchor),
        ])

        scopePopup = NSPopUpButton()
        scopePopup.controlSize = .regular
        scopePopup.addItems(withTitles: ["仅主 app-server", "含 computer-use 会话", "全部（含其它 App）"])
        scopePopup.selectItem(at: scopeIndexFromDefaults())
        scopePopup.target = self
        scopePopup.action = #selector(scopeChanged)
        scopePopup.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true
        focusSwitch = makeSwitch(action: #selector(toggleFocus))
        focusSwitch.state = (defaults.object(forKey: "focusChatGPT") as? Bool ?? true) ? .on : .off
        loginSwitch = makeSwitch(action: #selector(toggleLogin))
        loginSwitch.state = Self.loginItemEnabled() ? .on : .off
        let generalGroup = GroupBox()
        generalGroup.addRow(SettingRow(title: "重启范围", accessory: scopePopup))
        generalGroup.addRow(SettingRow(title: "热重启后聚焦 ChatGPT", accessory: focusSwitch))
        generalGroup.addRow(SettingRow(title: "登录时启动", accessory: loginSwitch))

        let codexBody = NSStackView(views: [
            SectionView(title: "当前供应商", content: currentGroup, footer: nil),
            SectionView(title: "供应商", content: providerScroll),
            SectionView(title: "自动跟随", content: followGroup),
            SectionView(title: "远程机器", content: remoteGroup),
            SectionView(title: "通用", content: generalGroup),
            statusLabel,
        ])
        codexBody.orientation = .vertical
        codexBody.alignment = .leading
        codexBody.spacing = 22
        codexNote.translatesAutoresizingMaskIntoConstraints = false
        codexBody.insertArrangedSubview(codexNote, at: 1)
        codexPane = codexBody

        claudeHeaderLabel = makeLabel("加载中…", font: .systemFont(ofSize: 15, weight: .semibold), color: .labelColor)
        claudeEffectiveLabel = makeLabel("", font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
        claudeEffectiveLabel.lineBreakMode = .byTruncatingMiddle
        claudeNote = makeLabel("", font: .systemFont(ofSize: 11), color: .secondaryLabelColor)
        claudeNote.lineBreakMode = .byWordWrapping
        claudeNote.maximumNumberOfLines = 3
        claudeStatusLabel = StatusLine()
        let claudeReload = NSButton(title: "重新打开", target: self, action: #selector(reloadClaudeNow))
        claudeReload.bezelStyle = .rounded
        claudeReload.bezelColor = .controlAccentColor
        claudeKeyHost.orientation = .vertical
        claudeKeyHost.alignment = .leading
        claudeKeyHost.spacing = 4
        let claudeCurrent = NSStackView(views: [
            NSStackView(views: [claudeHeaderLabel, claudeEffectiveLabel, claudeKeyHost]),
            flexibleSpace(),
            claudeReload,
        ])
        claudeCurrent.orientation = .horizontal
        claudeCurrent.alignment = .centerY
        (claudeCurrent.arrangedSubviews[0] as? NSStackView)?.orientation = .vertical
        if let texts = claudeCurrent.arrangedSubviews[0] as? NSStackView {
            claudeKeyHost.widthAnchor.constraint(equalTo: texts.widthAnchor).isActive = true
        }
        (claudeCurrent.arrangedSubviews[0] as? NSStackView)?.alignment = .leading
        let claudeCurrentGroup = GroupBox()
        claudeCurrentGroup.addRow(claudeCurrent)
        claudeTableView = makeProviderTable(action: #selector(claudeRowClicked))
        let claudeScroll = makeTableScroll(claudeTableView)
        claudeTableHeight = claudeScroll.heightAnchor.constraint(equalToConstant: 176)
        claudeTableHeight.isActive = true
        claudeWatchSwitch = makeSwitch(action: #selector(toggleClaudeWatch))
        let claudeWatchOn = defaults.object(forKey: "watchClaudeEnabled") as? Bool ?? true
        claudeWatchSwitch.state = claudeWatchOn ? .on : .off
        let claudeFollow = GroupBox()
        claudeFollow.addRow(SettingRow(title: "自动跟随 cc-switch", subtitle: "切换后退出并重新打开 Claude Desktop，并置于最前", accessory: claudeWatchSwitch))
        let claudeBody = NSStackView(views: [
            SectionView(title: "当前供应商", content: claudeCurrentGroup),
            claudeNote,
            SectionView(title: "供应商", content: claudeScroll),
            SectionView(title: "自动跟随", content: claudeFollow),
            claudeStatusLabel,
        ])
        claudeBody.orientation = .vertical
        claudeBody.alignment = .leading
        claudeBody.spacing = 22
        claudePane = claudeBody

        ccStatusLabel = StatusLine()
        ccSyncSwitch = makeSwitch(action: #selector(toggleCcSync))
        ccSyncSwitch.state = (defaults.object(forKey: "syncCcSwitch") as? Bool ?? true) ? .on : .off
        let checkButton = NSButton(title: "立即检查", target: self, action: #selector(checkCcSwitchNow))
        checkButton.bezelStyle = .rounded
        checkButton.controlSize = .regular
        ccRows = NSStackView()
        ccRows.orientation = .vertical
        ccRows.alignment = .leading
        ccRows.spacing = 0
        rebuildCcRows()
        let ccGroup = GroupBox()
        ccRows.translatesAutoresizingMaskIntoConstraints = false
        ccGroup.addSubview(ccRows)
        NSLayoutConstraint.activate([
            ccRows.topAnchor.constraint(equalTo: ccGroup.topAnchor),
            ccRows.leadingAnchor.constraint(equalTo: ccGroup.leadingAnchor),
            ccRows.trailingAnchor.constraint(equalTo: ccGroup.trailingAnchor),
            ccRows.bottomAnchor.constraint(equalTo: ccGroup.bottomAnchor),
            ccRows.widthAnchor.constraint(equalTo: ccGroup.widthAnchor),
        ])
        let syncRow = SettingRow(title: "实时同步", subtitle: "以本机配置为准，连上后先检查再更新", accessory: ccSyncSwitch)
        let syncGroup = GroupBox()
        syncGroup.addRow(NSStackView(views: [syncRow, flexibleSpace(), checkButton]))
        let ccBody = NSStackView(views: [
            SectionView(title: "同步", content: syncGroup),
            SectionView(title: "远程机器", content: ccGroup),
            ccStatusLabel,
        ])
        ccBody.orientation = .vertical
        ccBody.alignment = .leading
        ccBody.spacing = 22
        ccPane = ccBody

        iqTopicPopup = NSPopUpButton()
        iqTopicPopup.addItem(withTitle: "鹈鹕骑自行车")
        iqTopicPopup.lastItem?.representedObject = "pelican"
        iqTopicPopup.addItem(withTitle: "秦始皇骑自行车买菜")
        iqTopicPopup.lastItem?.representedObject = "qin"
        iqTopicPopup.addItem(withTitle: "香蕉人开小汽车")
        iqTopicPopup.lastItem?.representedObject = "banana"
        iqTopicPopup.addItem(withTitle: "摸糖保证题")
        iqTopicPopup.lastItem?.representedObject = "candy"
        iqTopicPopup.widthAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
        iqProviderPopup = NSPopUpButton()
        iqModelPopup = NSPopUpButton()
        iqProviderPopup.target = self
        iqProviderPopup.action = #selector(iqProviderChanged)
        iqModelPopup.target = self
        iqModelPopup.action = #selector(iqModelChanged)
        iqProviderPopup.widthAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
        iqModelPopup.widthAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
        iqThinkingControl = NSSegmentedControl(labels: ["关闭"], trackingMode: .selectOne, target: nil, action: nil)
        iqThinkingControl.segmentStyle = .rounded
        iqThinkingControl.selectedSegment = 0
        iqThinkingControl.setContentHuggingPriority(.required, for: .horizontal)
        iqStatusLabel = StatusLine()
        iqRunButton = PageChrome.primaryButton("开始测试", action: #selector(runIqTest), target: self)
        iqCancelButton = NSButton(title: "取消", target: self, action: #selector(cancelIqTest))
        iqCancelButton.bezelStyle = .rounded
        iqCancelButton.isHidden = true
        iqMetaLabel = makeLabel("", font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
        iqLog = NSTextView()
        iqLog.isEditable = false
        iqLog.isSelectable = true
        iqLog.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        iqLog.textColor = .secondaryLabelColor
        iqLog.drawsBackground = false
        iqLog.string = ""
        let logScroll = NSScrollView()
        logScroll.documentView = iqLog
        logScroll.hasVerticalScroller = true
        logScroll.hasHorizontalScroller = false
        logScroll.autohidesScrollers = true
        logScroll.scrollerStyle = .overlay
        logScroll.drawsBackground = false
        logScroll.translatesAutoresizingMaskIntoConstraints = false
        iqLogScroll = logScroll
        iqLogHeight = logScroll.heightAnchor.constraint(equalToConstant: 0)
        iqLogHeight.isActive = true
        logScroll.isHidden = true
        iqEmptyLabel = makeLabel("选择题目和模型后点「开始测试」", font: .systemFont(ofSize: 13), color: .secondaryLabelColor)
        let previewWeb = QuietWebView()
        previewWeb.navigationDelegate = previewWeb
        previewWeb.onContentHeight = { [weak self] height in
            guard let self, self.iqWeb?.isHidden == false else { return }
            let width = self.iqWeb.bounds.width
            if abs(width - self.iqFitWidth) > 1 {
                self.iqFitWidth = width
                self.iqFitPasses = 0
            }
            self.fitIqPreview(height)
        }
        iqWeb = previewWeb
        iqWeb.translatesAutoresizingMaskIntoConstraints = false
        let preview = NSView()
        preview.wantsLayer = true
        preview.layer?.cornerRadius = 10
        preview.layer?.borderWidth = 0.5
        preview.layer?.borderColor = NSColor.separatorColor.cgColor
        preview.layer?.masksToBounds = true
        iqReply = NSTextView()
        iqReply.isEditable = false
        iqReply.isSelectable = true
        iqReply.font = .systemFont(ofSize: 13)
        iqReply.textContainerInset = NSSize(width: 12, height: 12)
        iqReply.drawsBackground = false
        iqReply.isHorizontallyResizable = false
        iqReply.textContainer?.widthTracksTextView = true
        let replyScroll = NSScrollView()
        replyScroll.documentView = iqReply
        replyScroll.hasVerticalScroller = true
        replyScroll.autohidesScrollers = true
        replyScroll.scrollerStyle = .overlay
        replyScroll.drawsBackground = false
        replyScroll.isHidden = true
        iqReplyScroll = replyScroll
        preview.addSubview(iqWeb)
        preview.addSubview(replyScroll)
        preview.addSubview(iqEmptyLabel)
        iqEmptyLabel.translatesAutoresizingMaskIntoConstraints = false
        replyScroll.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iqWeb.topAnchor.constraint(equalTo: preview.topAnchor),
            iqWeb.leadingAnchor.constraint(equalTo: preview.leadingAnchor),
            iqWeb.trailingAnchor.constraint(equalTo: preview.trailingAnchor),
            iqWeb.bottomAnchor.constraint(equalTo: preview.bottomAnchor),
            replyScroll.topAnchor.constraint(equalTo: preview.topAnchor),
            replyScroll.leadingAnchor.constraint(equalTo: preview.leadingAnchor),
            replyScroll.trailingAnchor.constraint(equalTo: preview.trailingAnchor),
            replyScroll.bottomAnchor.constraint(equalTo: preview.bottomAnchor),
            iqEmptyLabel.centerXAnchor.constraint(equalTo: preview.centerXAnchor),
            iqEmptyLabel.centerYAnchor.constraint(equalTo: preview.centerYAnchor),
        ])
        let openBrowser = NSButton(title: "在浏览器打开", target: self, action: #selector(openIqInBrowser))
        openBrowser.bezelStyle = .rounded
        openBrowser.image = NSImage(systemSymbolName: "safari", accessibilityDescription: "在浏览器打开")
        openBrowser.imagePosition = .imageLeading
        let reveal = NSButton(title: "在访达中显示", target: self, action: #selector(revealIqInFinder))
        reveal.bezelStyle = .rounded
        reveal.image = NSImage(systemSymbolName: "folder", accessibilityDescription: "在访达中显示")
        reveal.imagePosition = .imageLeading
        let iqActions = NSStackView(views: [flexibleSpace(), openBrowser, reveal])
        iqActions.orientation = .horizontal
        iqActions.spacing = 8
        let iqTarget = GroupBox()
        iqTarget.addRow(SettingRow(title: "题目", accessory: iqTopicPopup))
        iqTarget.addRow(SettingRow(title: "供应商", accessory: iqProviderPopup))
        iqTarget.addRow(SettingRow(title: "模型", accessory: iqModelPopup))
        iqTarget.addRow(SettingRow(title: "思考强度", accessory: iqThinkingControl))
        let iqTargetSection = SectionView(title: "测试对象", content: iqTarget, footer: "画面题只改工作目录里的 index.html。摸糖保证题只许文字作答，不能联网，也不能读文件。测试过程中可以暂停或取消。")
        let runRow = NSStackView(views: [flexibleSpace(), iqCancelButton, iqRunButton])
        runRow.orientation = .horizontal
        let resultGroup = NSStackView(views: [iqMetaLabel, logScroll, preview, iqActions])
        resultGroup.orientation = .vertical
        resultGroup.alignment = .leading
        resultGroup.spacing = 8
        iqPreviewHeight = preview.heightAnchor.constraint(equalToConstant: 720)
        iqPreviewHeight?.isActive = true
        logScroll.widthAnchor.constraint(equalTo: resultGroup.widthAnchor).isActive = true
        preview.widthAnchor.constraint(equalTo: resultGroup.widthAnchor).isActive = true
        iqActions.widthAnchor.constraint(equalTo: resultGroup.widthAnchor).isActive = true
        let iqBody = NSStackView(views: [
            iqTargetSection,
            runRow,
            SectionView(title: "结果", content: resultGroup),
            iqStatusLabel,
        ])
        iqBody.orientation = .vertical
        iqBody.alignment = .leading
        iqBody.spacing = 22
        iqPane = wrapPage("智商测试", "选定题目、供应商和模型，看它能不能画出指定的动画。", iqBody)
        quotaController = GoQuotaPane(backend: backend)
        quotaController.onDetail = { [weak self] text in self?.sidebar?.setDetail(page: 4, text) }
        quotaPane = quotaController.root
        clineController = ClineQuotaPane(backend: backend)
        clineController.onDetail = { [weak self] text in self?.sidebar?.setDetail(page: 5, text) }
        clinePane = clineController.root
        grokController = GrokBotPane(backend: backend)
        grokController.onDetail = { [weak self] text in self?.sidebar?.setDetail(page: 6, text) }
        grokPane = grokController.root
        speedController = SpeedPane(backend: backend)
        speedController.onDetail = { [weak self] text in self?.sidebar?.setDetail(page: 7, text) }
        speedPane = speedController.root

        codexPane = wrapPage("Codex", "跟随 cc-switch 热切换 Codex 供应商", codexPane)
        claudePane = wrapPage("Claude Desktop", "跟随 cc-switch 的 Claude Desktop 供应商，切换后重新打开应用", claudePane)
        ccPane = wrapPage("cc-switch 同步", "以本机 cc-switch 为准，同步到远程机器", ccPane)

        sidebar = SettingsSidebarController()
        sidebar.onSelect = { [weak self] page in self?.selectPage(page) }
        let content = NSViewController()
        let host = NSView()
        host.wantsLayer = true
        for pane in [codexPane!, claudePane!, ccPane!, iqPane!, quotaPane!, clinePane!, grokPane!, speedPane!] {
            pane.translatesAutoresizingMaskIntoConstraints = false
            host.addSubview(pane)
        NSLayoutConstraint.activate([
                pane.topAnchor.constraint(equalTo: host.topAnchor),
                pane.leadingAnchor.constraint(equalTo: host.leadingAnchor),
                pane.trailingAnchor.constraint(equalTo: host.trailingAnchor),
                pane.bottomAnchor.constraint(equalTo: host.bottomAnchor),
            ])
        }
        content.view = host
        let split = NSSplitViewController()
        let sideItem = NSSplitViewItem(sidebarWithViewController: sidebar)
        sideItem.minimumThickness = 200
        sideItem.maximumThickness = 260
        sideItem.canCollapse = false
        let mainItem = NSSplitViewItem(viewController: content)
        split.addSplitViewItem(sideItem)
        split.addSplitViewItem(mainItem)
        window.contentViewController = split
        split.splitView.setPosition(220, ofDividerAt: 0)

        let savedPage = defaults.integer(forKey: "mainPage")
        showPage([1, 2, 3, 4, 5, 6, 7].contains(savedPage) ? savedPage : 0)
        if ccSyncEnabled() { startCcSwitchFollow() }
        startIqCatalogWatch()
    }

    private func startIqCatalogWatch() {
        iqCatalogTimer?.invalidate()
        let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            self?.refreshIqCatalogIfChanged()
        }
        RunLoop.main.add(timer, forMode: .common)
        iqCatalogTimer = timer
    }

    private func refreshIqCatalogIfChanged() {
        let db = NSString(string: "~/.cc-switch/cc-switch.db").expandingTildeInPath
        let settings = NSString(string: "~/.cc-switch/settings.json").expandingTildeInPath
        let dbDate = (try? FileManager.default.attributesOfItem(atPath: db)[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let settingsDate = (try? FileManager.default.attributesOfItem(atPath: settings)[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let stamp = max(dbDate, settingsDate)
        guard stamp != iqCatalogStamp else { return }
        iqCatalogStamp = stamp
        reloadIqProviders()
    }

    private func wrapPage(_ title: String, _ subtitle: String, _ body: NSView) -> NSView {
        PageChrome.scroll(title: title, subtitle: subtitle, content: body)
    }

    private func makeProviderTable(action: Selector) -> NSTableView {
        let table = NSTableView()
        table.headerView = nil
        table.rowHeight = 44
        table.selectionHighlightStyle = .none
        table.backgroundColor = .clear
        table.intercellSpacing = NSSize(width: 0, height: 0)
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("main"))
        column.resizingMask = .autoresizingMask
        column.width = 480
        table.addTableColumn(column)
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = action
        table.style = .plain
        return table
    }

    private func makeTableScroll(_ table: NSTableView) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.scrollerStyle = .overlay
        scroll.translatesAutoresizingMaskIntoConstraints = false
        return scroll
    }

    private func makeLabel(_ text: String, font: NSFont, color: NSColor) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = font
        label.textColor = color
        label.translatesAutoresizingMaskIntoConstraints = false
        return label
    }

    private func sectionLabel(_ text: String) -> NSTextField {
        let label = makeLabel(text, font: .systemFont(ofSize: 13, weight: .bold), color: .labelColor)
        label.translatesAutoresizingMaskIntoConstraints = false
        return label
    }

    private func sectionBlock(_ title: String, _ content: NSView) -> NSStackView {
        let block = NSStackView(views: [sectionLabel(title), content])
        block.orientation = .vertical
        block.alignment = .leading
        block.spacing = 6
        return block
    }

    private func linkButton(title: String, symbol: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .inline
        button.isBordered = false
        button.contentTintColor = .controlAccentColor
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        button.imagePosition = .imageLeading
        button.font = .systemFont(ofSize: 13)
        return button
    }

    private func makeSwitch(action: Selector) -> NSSwitch {
        let toggle = NSSwitch()
        toggle.controlSize = .small
        toggle.target = self
        toggle.action = action
        return toggle
    }

    private func labeledSwitch(_ toggle: NSSwitch, title: String) -> NSView {
        let label = makeLabel(title, font: .systemFont(ofSize: 13), color: .labelColor)
        let row = NSStackView(views: [label, toggle])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        return row
    }

    private func hugLeading(_ view: NSView) -> NSView {
        view.setContentHuggingPriority(.required, for: .horizontal)
        let row = NSStackView(views: [view, flexibleSpace()])
        row.orientation = .horizontal
        row.alignment = .centerY
        return row
    }

    private func flexibleSpace() -> NSView {
        let view = NSView()
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return view
    }

    private func settingsLine(_ title: String, _ control: NSView) -> NSView {
        let label = makeLabel(title, font: .systemFont(ofSize: 13), color: .labelColor)
        let row = NSStackView(views: [label, flexibleSpace(), control])
        row.orientation = .horizontal
        row.alignment = .centerY
        return row
    }

    private func groupedStack(_ rows: [NSView]) -> NSStackView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        for row in rows { addGrouped(stack, row) }
        return stack
    }

    private func addGrouped(_ stack: NSStackView, _ view: NSView) {
        if !stack.arrangedSubviews.isEmpty {
            let line = separatorRow()
            stack.addArrangedSubview(line)
            line.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        let row = padded(view, NSEdgeInsets(top: 8, left: 14, bottom: 8, right: 12))
        stack.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    private func padded(_ content: NSView, _ insets: NSEdgeInsets) -> NSView {
        let wrap = NSView()
        content.translatesAutoresizingMaskIntoConstraints = false
        wrap.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: wrap.topAnchor, constant: insets.top),
            content.leadingAnchor.constraint(equalTo: wrap.leadingAnchor, constant: insets.left),
            content.trailingAnchor.constraint(equalTo: wrap.trailingAnchor, constant: -insets.right),
            content.bottomAnchor.constraint(equalTo: wrap.bottomAnchor, constant: -insets.bottom),
        ])
        return wrap
    }

    private func separatorRow() -> NSView {
        let wrap = NSView()
        let line = NSBox()
        line.boxType = .separator
        line.translatesAutoresizingMaskIntoConstraints = false
        wrap.addSubview(line)
        NSLayoutConstraint.activate([
            line.leadingAnchor.constraint(equalTo: wrap.leadingAnchor, constant: 14),
            line.trailingAnchor.constraint(equalTo: wrap.trailingAnchor),
            line.centerYAnchor.constraint(equalTo: wrap.centerYAnchor),
            wrap.heightAnchor.constraint(equalToConstant: 1),
        ])
        return wrap
    }

    private func card(containing view: NSView, insets: NSEdgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)) -> NSView {
        let box = CardView()
        view.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(view)
        NSLayoutConstraint.activate([
            view.topAnchor.constraint(equalTo: box.topAnchor, constant: insets.top),
            view.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: insets.left),
            view.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -insets.right),
            view.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -insets.bottom),
        ])
        return box
    }

    private func rebuildRemoteRows() {
        guard remoteRows != nil else { return }
        for view in remoteRows.arrangedSubviews {
            remoteRows.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        addGrouped(remoteRows, settingsLine("同步这些机器", remoteSwitch))
        if remotes.machines.isEmpty {
            addGrouped(remoteRows, makeLabel("还没有远程机器", font: .systemFont(ofSize: 13), color: .tertiaryLabelColor))
        } else {
            let dimmed = remoteSwitch.state != .on
            for machine in remotes.machines {
                let row = makeRemoteRow(machine)
                if dimmed { row.alphaValue = 0.45 }
                addGrouped(remoteRows, row)
            }
        }
        if addRemoteButton != nil { addGrouped(remoteRows, hugLeading(addRemoteButton)) }
        rebuildCcRows()
    }

    private func rebuildCcRows() {
        guard ccRows != nil, ccSyncSwitch != nil else { return }
        for view in ccRows.arrangedSubviews {
            ccRows.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        if remotes.machines.isEmpty {
            addGrouped(ccRows, makeLabel("还没有远程机器。可在 Codex 页添加。", font: .systemFont(ofSize: 13), color: .tertiaryLabelColor))
        } else {
            let dimmed = !ccSyncEnabled()
            for machine in remotes.machines {
                let row = makeCcRow(machine)
                if dimmed { row.alphaValue = 0.45 }
                addGrouped(ccRows, row)
            }
        }
    }

    private func makeCcSyncRow() -> NSView {
        let title = makeLabel("实时同步", font: .systemFont(ofSize: 13), color: .labelColor)
        let detail = makeLabel("以本机 cc-switch 为准。配置一变就推到远程；没连上的机器会等到连上，再检查并更新。", font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
        detail.lineBreakMode = .byWordWrapping
        detail.maximumNumberOfLines = 3
        detail.preferredMaxLayoutWidth = 400
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let texts = NSStackView(views: [title, detail])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 2
        texts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let row = NSStackView(views: [texts, flexibleSpace(), ccSyncSwitch])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        return row
    }

    private func makeCcRow(_ machine: RemoteMachine) -> NSView {
        let title = NSTextField(labelWithString: machine.label)
        title.font = .systemFont(ofSize: 13, weight: .medium)
        let detail = NSTextField(labelWithString: machine.detail)
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = .secondaryLabelColor
        let texts = NSStackView(views: [title, detail])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 1
        texts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let appearance = ccSwitchAppearance(for: machine)
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: appearance.symbol, accessibilityDescription: appearance.text)
        icon.contentTintColor = appearance.tint
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
        let state = NSTextField(labelWithString: appearance.text)
        state.font = .systemFont(ofSize: 12)
        state.textColor = appearance.tint
        state.lineBreakMode = .byTruncatingTail
        let status = NSStackView(views: [icon, state])
        status.orientation = .horizontal
        status.alignment = .centerY
        status.spacing = 4

        let row = NSStackView(views: [texts, flexibleSpace(), status])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        return row
    }

    private func makeRemoteRow(_ machine: RemoteMachine) -> NSView {
        let toggle = NSSwitch()
        toggle.controlSize = .small
        toggle.state = machine.enabled ? .on : .off
        toggle.target = self
        toggle.action = #selector(remoteMachineToggled(_:))
        toggle.identifier = NSUserInterfaceItemIdentifier(machine.host)

        let title = NSTextField(labelWithString: machine.label)
        title.font = .systemFont(ofSize: 13, weight: .medium)
        title.lineBreakMode = .byTruncatingTail
        let detail = NSTextField(labelWithString: machine.detail)
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingMiddle
        let usage = NSTextField(labelWithString: usageText(for: machine.host))
        usage.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        usage.textColor = .secondaryLabelColor
        usage.lineBreakMode = .byTruncatingMiddle
        let texts = NSStackView(views: [title, detail, usage])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 1

        var trailing: [NSView] = []
        if let token = remoteLive[machine.host]?.token, !token.isEmpty {
            trailing.append(CopyableSecret(text: token))
        }
        if machine.builtin {
            trailing.append(makeLabel("内置", font: .systemFont(ofSize: 11), color: .tertiaryLabelColor))
        } else {
            let remove = NSButton()
            remove.bezelStyle = .inline
            remove.isBordered = false
            remove.image = NSImage(systemSymbolName: "trash", accessibilityDescription: "移除")
            remove.imagePosition = .imageOnly
            remove.contentTintColor = .secondaryLabelColor
            remove.target = self
            remove.action = #selector(removeRemote(_:))
            remove.identifier = NSUserInterfaceItemIdentifier(machine.host)
            trailing.append(remove)
        }
        trailing.append(toggle)
        texts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let row = NSStackView(views: [texts, flexibleSpace()] + trailing)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        return row
    }

    // MARK: - 表格

    func numberOfRows(in tableView: NSTableView) -> Int {
        tableView === claudeTableView ? claudeProviders.count : providers.count
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        nil
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        46
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let provider = tableView === claudeTableView ? claudeProviders[row] : providers[row]
        let isCurrent = tableView === claudeTableView ? provider.id == claudeCurrentId : provider.id == currentId

        let name = NSTextField(labelWithString: provider.name)
        name.font = .systemFont(ofSize: 13, weight: isCurrent ? .medium : .regular)
        name.lineBreakMode = .byTruncatingTail

        let model = NSTextField(labelWithString: [
            provider.model,
            provider.host,
            provider.catalogCount > 0 ? "目录\(provider.catalogCount)" : nil,
        ].compactMap { $0 }.joined(separator: " · "))
        model.font = .systemFont(ofSize: 12)
        model.textColor = .secondaryLabelColor

        let textStack = NSStackView(views: [name, model])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 1
        textStack.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        var leading: [NSView] = []
        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        dot.layer?.backgroundColor = (isCurrent ? NSColor.systemGreen : NSColor.clear).cgColor
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 8).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 8).isActive = true
        leading.append(dot)
        var trailing: [NSView] = []
        if let token = provider.token, !token.isEmpty {
            trailing.append(CopyableSecret(text: token))
        }
        if provider.official {
            trailing.append(PageChrome.pill("官方"))
        }

        let rowStack = NSStackView(views: leading + [textStack, flexibleSpace()] + trailing)
        rowStack.orientation = .horizontal
        rowStack.alignment = .centerY
        rowStack.spacing = 8
        rowStack.edgeInsets = NSEdgeInsets(top: 2, left: 10, bottom: 2, right: 10)
        rowStack.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(rowStack)
        NSLayoutConstraint.activate([
            rowStack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            rowStack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            rowStack.topAnchor.constraint(equalTo: container.topAnchor),
            rowStack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        if !provider.hasConfig || provider.official {
            container.alphaValue = 0.5
        }
        return container
    }

    @objc private func rowClicked() {
        let row = tableView.clickedRow >= 0 ? tableView.clickedRow : tableView.selectedRow
        guard row >= 0, row < providers.count, !busy else { return }
        let provider = providers[row]
        if provider.official {
            setStatus("「\(provider.name)」是官方供应商，请在 cc-switch 中切换")
            return
        }
        // cc-switch 在运行时：外部直接改 live 配置会被它回填到"它以为的当前卡片"，导致卡片内容错位。
        // 因此默认引导用户改用 cc-switch 切换（自动跟随会热重启，效果一致）。
        if ccSwitchRunning {
            let alert = NSAlert()
            alert.messageText = "建议在 cc-switch 里切换"
            alert.informativeText = """
            cc-switch 正在运行。若由本 App 直接改配置，cc-switch 可能把这份配置回填到它认为的当前卡片，造成卡片内容错位。

            推荐：在 cc-switch 里点击「\(provider.name)」，本 App 会自动热重启 Codex，效果完全一样。
            """
            alert.alertStyle = .warning
            alert.addButton(withTitle: "打开 cc-switch")      // 1
            alert.addButton(withTitle: "强制切换")             // 2
            alert.addButton(withTitle: "取消")                 // 3
            NSApp.activate(ignoringOtherApps: true)
            let choice = alert.runModal()
            if choice == .alertFirstButtonReturn {
                NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/CC Switch.app"))
                setStatus("请在 cc-switch 里点击「\(provider.name)」，本 App 会自动热重启 Codex")
                return
            }
            if choice == .alertSecondButtonReturn {
                performSwitch(provider, force: true)
                return
            }
            return
        }
        performSwitch(provider)
    }

    // MARK: - 操作

    func refresh() {
        guard !busy else { return }
        setBusy(true, status: nil)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                // 先渲染列表，避免被后续的配置校验拖慢
                let result = try self.backend.list()
                DispatchQueue.main.async {
                    self.providers = result.providers
                    self.currentId = result.currentId
                    self.liveInfo = result.live
                    self.ccSwitchRunning = result.ccSwitchRunning ?? false
                    self.tableView.reloadData()
                    self.providerTableHeight?.constant = self.tableHeight(self.tableView, rows: result.providers.count)
                    self.onProvidersChanged?(result.providers, result.currentId)
                    self.updateHeader(current: nil)
                }
                // 再异步取生效配置（启动一次性 app-server 校验）
                let current = try? self.backend.current()
                DispatchQueue.main.async {
                    self.updateHeader(current: current)
                    self.setBusy(false)
                    self.refreshRemoteLive()
                    if let scroll = self.codexPane as? NSScrollView { self.scrollToTop(scroll) }
                }
            } catch {
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.setStatus("❌ \(error.localizedDescription)")
                }
            }
        }
    }

    private func updateHeader(current: CurrentResult?) {
        // 以 config.toml（Codex 真正读取的文件）为准展示"正在使用谁"
        let live = liveInfo
        let liveProvider = live?.liveProviderId.flatMap { id in providers.first { $0.id == id } }
            ?? live?.matchedIds?.first.flatMap { id in providers.first { $0.id == id } }

        if let provider = liveProvider ?? providers.first(where: { $0.id == currentId }) {
            var title = "\(provider.name) · \(provider.model ?? "-")"
            if let host = live?.host, host != provider.host {
                title += "  →  \(host)"
            }
            headerLabel.stringValue = title
        } else {
            headerLabel.stringValue = "(未知)"
        }

        var lines: [String] = []
        if let live, let host = live.host {
            lines.append("实际端点: \(host)")
        }
        if let current, let eff = current.effective, eff.ok {
            lines.append(eff.hasToken == true ? "token ✔" : "token ✗")
        }
        effectiveLabel.stringValue = lines.joined(separator: "   ")
        replaceSecrets(in: codexKeyHost, with: live?.token)

        // 一致性提示
        var notes: [String] = []
        if let live, let matched = live.matchedIds, matched.count > 1 {
            let names = matched.compactMap { id in providers.first { $0.id == id }?.name }
            if let used = liveProvider?.name {
                notes.append("「\(names.joined(separator: "」「"))」内容相同，实际使用其中的「\(used)」")
            }
        }
        if let live, let liveId = live.liveProviderId, let cur = currentId, liveId != cur {
            let a = providers.first { $0.id == cur }?.name ?? cur
            let b = providers.first { $0.id == liveId }?.name ?? liveId
            notes.append("⚠️ cc-switch 记录的是「\(a)」，但实际配置来自「\(b)」")
        }
        codexNote?.stringValue = notes.joined(separator: "；")
        codexNote?.isHidden = notes.isEmpty
        refreshSidebar()
    }

    private func performSwitch(_ provider: ProviderSummary, force: Bool = false) {
        setBusy(true, status: "正在切换到 \(provider.name)…")
        let scope = scopeCode()
        let focus = focusSwitch.state == .on
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.switchProvider(provider.id, scope: scope, focus: focus, force: force, remote: self.syncRemoteEnabled())
                NotificationCenter.default.post(name: .configWrittenFromApp, object: nil)
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.applyRemoteLive(result.remote)
                    self.refresh()
                    var parts = ["✔ 已切换到 \(provider.name)"]
                    if let model = result.effective?.model { parts.append("模型 \(model)") }
                    if let reload = result.reload {
                        if (reload.killed ?? 0) > 0 {
                            parts.append("已强制重启：在 ChatGPT 里点一次「Restart ChatGPT」")
                        } else if reload.respawned != nil {
                            parts.append("app-server 已自动重启，立即生效")
                        } else if (reload.terminated ?? 0) > 0 {
                            parts.append("点一下任意对话即生效，无需重启 Codex")
                        } else {
                            parts.append("下次启动 Codex 时生效")
                        }
                    }
                    if let warnings = result.warnings, !warnings.isEmpty {
                        parts.append("⚠️ " + warnings.joined(separator: "；"))
                    }
                    if let remote = self.remoteSummary(result.remote) { parts.append(remote) }
                    self.setStatus(parts.joined(separator: " · "))
                }
            } catch {
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.setStatus("❌ \(error.localizedDescription)")
                }
            }
        }
    }

    @objc private func reloadNow() {
        guard !busy else { return }
        setBusy(true, status: "正在重新加载 Codex…")
        let scope = scopeCode()
        let focus = focusSwitch.state == .on
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.reload(scope: scope, focus: focus, remote: self.syncRemoteEnabled())
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.applyRemoteLive(result.remote)
                    self.refresh()
                    let detail = result.reload
                    var text: String
                    if detail?.respawned != nil {
                        text = "✔ app-server 已自动重启，新供应商已生效"
                    } else if (detail?.killed ?? 0) > 0 {
                        text = "✔ 已强制重启：在 ChatGPT 里点一次「Restart ChatGPT」"
                    } else if (detail?.terminated ?? 0) > 0 {
                        text = "✔ 已重启 app-server，点一下任意对话即生效"
                    } else {
                        text = "ℹ️ 当前没有运行中的 app-server，下次启动 Codex 时生效"
                    }
                    if let remote = self.remoteSummary(result.remote) { text += " · \(remote)" }
                    self.setStatus(text)
                }
            } catch {
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.setStatus("❌ \(error.localizedDescription)")
                }
            }
        }
    }

    /// 外部（cc-switch 或自身）改动配置后的自动热重启。
    func autoReloadAfterChange(onDone: (() -> Void)? = nil) {
        if busy {
            // 新建分组时 cc-switch 会连写两次配置。第一次重启还没结束时，
            // 第二次变化不能丢掉，否则 app-server 会停在旧配置上。
            pendingAutoReload = true
            if onDone != nil { pendingAutoReloadDone = onDone }
            return
        }
        setBusy(true, status: "检测到配置变化，正在热重启 Codex…")
        let scope = scopeCode()
        let focus = focusSwitch.state == .on
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.reload(scope: scope, focus: focus, remote: self.syncRemoteEnabled())
                DispatchQueue.main.async {
                    self.applyRemoteLive(result.remote)
                    self.refresh()
                    var text: String
                    if result.reload?.respawned != nil {
                        text = "⚡ 已自动跟随切换：app-server 已重启，立即生效"
                    } else if (result.reload?.terminated ?? 0) > 0 || (result.reload?.killed ?? 0) > 0 {
                        text = "⚡ 已自动跟随切换，点一下任意对话即生效"
                    } else {
                        text = "⚡ 配置已变更（当前无运行中的 app-server）"
                    }
                    if let remote = self.remoteSummary(result.remote) { text += " · \(remote)" }
                    self.setStatus(text)
                    self.finishAutoReload(onDone: onDone)
                }
            } catch {
                DispatchQueue.main.async {
                    self.setStatus("❌ 自动跟随失败: \(error.localizedDescription)")
                    self.finishAutoReload(onDone: onDone)
                }
            }
        }
    }

    @objc private func toggleWatch() {
        let enabled = watchSwitch.state == .on
        defaults.set(enabled, forKey: "watchEnabled")
        NotificationCenter.default.post(name: .watchToggled, object: nil)
        setStatus(enabled ? "已开启自动跟随：在 cc-switch 里切换供应商后 Codex 会自动生效" : "已关闭自动跟随")
    }

    func setWatchState(_ running: Bool) {
        guard watchSwitch != nil else { return }
        watchSwitch.state = running ? .on : .off
    }

    func setClaudeWatchState(_ running: Bool) {
        guard claudeWatchSwitch != nil else { return }
        claudeWatchSwitch.state = running ? .on : .off
    }

    var claudeWatchIsOn: Bool { claudeWatchSwitch?.state == .on }

    @objc private func claudeRowClicked() {
        let row = claudeTableView.clickedRow >= 0 ? claudeTableView.clickedRow : claudeTableView.selectedRow
        guard row >= 0, row < claudeProviders.count, !busy else { return }
        let provider = claudeProviders[row]
        if !provider.hasConfig {
            setClaudeStatus("「\(provider.name)」请在 cc-switch 中切换")
            return
        }
        if ccSwitchRunning {
            let alert = NSAlert()
            alert.messageText = "建议在 cc-switch 里切换"
            alert.informativeText = """
            cc-switch 正在运行。在那边点击「\(provider.name)」后，本 App 会重新打开 Claude Desktop，让新网关生效。
            """
            alert.alertStyle = .warning
            alert.addButton(withTitle: "打开 cc-switch")
            alert.addButton(withTitle: "强制切换")
            alert.addButton(withTitle: "取消")
            NSApp.activate(ignoringOtherApps: true)
            let choice = alert.runModal()
            if choice == .alertFirstButtonReturn {
                NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/CC Switch.app"))
                setClaudeStatus("请在 cc-switch 里点击「\(provider.name)」，本 App 会重新打开 Claude Desktop")
                return
            }
            if choice == .alertSecondButtonReturn {
                performClaudeSwitch(provider, force: true)
            }
            return
        }
        performClaudeSwitch(provider)
    }

    private func performClaudeSwitch(_ provider: ProviderSummary, force: Bool = false) {
        setBusy(true, status: nil)
        setClaudeStatus("正在切换到 \(provider.name)…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.claudeSwitch(provider.id, force: force)
                NotificationCenter.default.post(name: .claudeConfigWrittenFromApp, object: nil)
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.refreshClaude()
                    let restarted = result.reload?.restarted == true
                    self.setClaudeStatus(restarted
                        ? "✔ 已切换到 \(provider.name)，Claude Desktop 已重新打开并置于最前"
                        : "✔ 已写入 \(provider.name)，下次打开 Claude Desktop 时生效")
                }
            } catch {
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.setClaudeStatus("❌ \(error.localizedDescription)")
                }
            }
        }
    }

    func refreshClaude() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.claudeList()
                DispatchQueue.main.async {
                    self.claudeProviders = result.providers
                    self.claudeCurrentId = result.currentId
                    self.claudeLive = result.live
                    self.ccSwitchRunning = result.ccSwitchRunning ?? self.ccSwitchRunning
                    self.claudeTableView?.reloadData()
                    self.claudeTableHeight?.constant = self.tableHeight(self.claudeTableView, rows: result.providers.count)
                    self.updateClaudeHeader()
                    self.refreshSidebar()
                }
            } catch {
                DispatchQueue.main.async { self.setClaudeStatus("❌ \(error.localizedDescription)") }
            }
        }
    }

    private func updateClaudeHeader() {
        let provider = claudeProviders.first { $0.id == claudeCurrentId }
        if let provider {
            claudeHeaderLabel?.stringValue = provider.host.map { "\(provider.name) · \($0)" } ?? provider.name
        } else {
            claudeHeaderLabel?.stringValue = "(未知)"
        }
        var lines: [String] = []
        if let host = claudeLive?.host { lines.append("实际网关: \(host)") }
        claudeEffectiveLabel?.stringValue = lines.joined(separator: "   ")
        replaceSecrets(in: claudeKeyHost, with: claudeLive?.token)
        if let provider, let liveId = claudeLive?.liveProviderId, liveId != provider.id {
            let liveName = claudeProviders.first { $0.id == liveId }?.name ?? "另一套网关"
            claudeNote?.stringValue = "cc-switch 当前是「\(provider.name)」，桌面仍是「\(liveName)」。自动跟随会按 cc-switch 写回。"
            claudeNote?.isHidden = false
        } else {
            claudeNote?.stringValue = ""
            claudeNote?.isHidden = true
        }
    }

    @objc private func reloadClaudeNow() {
        guard !busy else { return }
        setBusy(true, status: nil)
        setClaudeStatus("正在重新打开 Claude Desktop…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.claudeReload()
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.refreshClaude()
                    self.setClaudeStatus(result.reload?.restarted == true
                        ? "✔ Claude Desktop 已重新打开，正在使用当前网关"
                        : "ℹ️ 当前没有运行中的 Claude Desktop，下次打开时生效")
                }
            } catch {
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.setClaudeStatus("❌ \(error.localizedDescription)")
                }
            }
        }
    }

    func autoReloadClaude(onDone: (() -> Void)? = nil) {
        guard !busy else { onDone?(); return }
        setBusy(true, status: nil)
        setClaudeStatus("正在按 cc-switch 的当前供应商同步 Claude Desktop…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.claudeSync()
                NotificationCenter.default.post(name: .claudeConfigWrittenFromApp, object: nil)
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.refreshClaude()
                    let name = result.current?.name ?? "当前供应商"
                    if let reason = result.reason, result.aligned != true {
                        self.setClaudeStatus(reason)
                    } else if result.reload?.restarted == true {
                        self.setClaudeStatus("⚡ 已按 cc-switch 的「\(name)」重新打开 Claude Desktop，并置于最前")
                    } else if result.applied == true {
                        self.setClaudeStatus("⚡ 已按 cc-switch 的「\(name)」写回网关，下次打开 Claude Desktop 时生效")
                    } else {
                        self.setClaudeStatus("已与 cc-switch 的「\(name)」一致")
                    }
                    onDone?()
                }
            } catch {
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.setClaudeStatus("❌ 自动跟随失败: \(error.localizedDescription)")
                    onDone?()
                }
            }
        }
    }

    @objc private func toggleClaudeWatch() {
        let enabled = claudeWatchSwitch.state == .on
        defaults.set(enabled, forKey: "watchClaudeEnabled")
        NotificationCenter.default.post(name: .claudeWatchToggled, object: nil)
        setClaudeStatus(enabled ? "已开启自动跟随：在 cc-switch 里切换后会重新打开 Claude Desktop" : "已关闭自动跟随")
    }

    private func setClaudeStatus(_ text: String) {
        claudeStatusLabel?.set(text)
    }

    @objc private func scopeChanged() {
        defaults.set(scopeCode(), forKey: "scope")
    }

    @objc private func toggleFocus() {
        defaults.set(focusSwitch.state == .on, forKey: "focusChatGPT")
    }

    @objc private func toggleRemote() {
        defaults.set(remoteSwitch.state == .on, forKey: "syncRemote")
        rebuildRemoteRows()
        refreshSidebar()
        setStatus(remoteSwitch.state == .on ? "已开启 Codex 远程同步" : "已关闭 Codex 远程同步")
    }

    func refreshIq() {
        reloadIqProviders()
        if !iqDidLoadResult {
            iqDidLoadResult = true
            loadLastIqResult()
        }
    }

    private func reloadIqProviders() {
        let selected = currentIqSelection()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.iqList()
                DispatchQueue.main.async {
                    self.applyIqProviders(result.providers, keeping: selected)
                }
            } catch {
                DispatchQueue.main.async { self.iqStatusLabel?.set("❌ \(error.localizedDescription)") }
            }
        }
    }

    private func currentIqSelection() -> (key: String, model: String, thinking: String)? {
        guard let provider = selectedIqProvider() else { return nil }
        return ("\(provider.appType)/\(provider.id)", iqModelPopup?.titleOfSelectedItem ?? "", selectedIqThinking())
    }

    private func selectedIqProvider() -> IqProvider? {
        let key = iqProviderPopup?.selectedItem?.representedObject as? String
        return iqProviders.first { "\($0.appType)/\($0.id)" == key }
    }

    private func selectedIqModel() -> IqModel? {
        guard let provider = selectedIqProvider() else { return nil }
        let name = iqModelPopup.titleOfSelectedItem ?? ""
        return provider.models.first { $0.id == name } ?? provider.models.first
    }

    private func selectedIqThinking() -> String {
        let index = iqThinkingControl?.selectedSegment ?? 0
        guard index >= 0, index < iqThinkingLevels.count else { return "off" }
        return iqThinkingLevels[index]
    }

    private func applyIqProviders(_ providers: [IqProvider], keeping selected: (key: String, model: String, thinking: String)?) {
        iqProviders = providers
        let menu = NSMenu()
        let order = ["claude", "codex", "opencode"]
        let grouped = Dictionary(grouping: providers, by: \.appType)
        let types = order.filter { grouped[$0] != nil } + grouped.keys.filter { !order.contains($0) }.sorted()
        for type in types {
            let header = NSMenuItem()
            header.isEnabled = false
            header.attributedTitle = NSAttributedString(
                string: iqAppTypeTitle(type),
                attributes: [
                    .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                    .foregroundColor: NSColor.secondaryLabelColor,
                ]
            )
            menu.addItem(header)
            for provider in grouped[type] ?? [] {
                let item = NSMenuItem(title: provider.name, action: nil, keyEquivalent: "")
                item.representedObject = "\(provider.appType)/\(provider.id)"
                menu.addItem(item)
            }
            if type != types.last { menu.addItem(.separator()) }
        }
        iqProviderPopup.menu = menu
        let fallback = providers.first { $0.appType == "claude" && $0.id == "stepfun" }
            ?? providers.first
        let key = selected?.key ?? fallback.map { "\($0.appType)/\($0.id)" }
        if let key, let item = menu.items.first(where: { ($0.representedObject as? String) == key }) {
            iqProviderPopup.select(item)
        }
        fillIqModels(preferred: selected?.model, thinking: selected?.thinking)
    }

    private func iqAppTypeTitle(_ type: String) -> String {
        switch type {
        case "claude": return "Claude"
        case "claude-desktop": return "Claude Desktop"
        case "codex": return "Codex"
        case "opencode": return "OpenCode"
        default: return type
        }
    }

    private func thinkingTitle(_ level: String) -> String {
        switch level {
        case "off": return "关闭"
        case "minimal": return "极轻"
        case "low": return "轻"
        case "medium": return "中"
        case "high": return "高"
        case "xhigh": return "极高"
        default: return level
        }
    }

    private func fillIqModels(preferred: String? = nil, thinking: String? = nil) {
        guard let provider = selectedIqProvider() else { return }
        let models = provider.models
        let keep = preferred ?? iqModelPopup.titleOfSelectedItem
        iqModelPopup.removeAllItems()
        iqModelPopup.addItems(withTitles: models.map(\.id))
        if let keep, let found = models.firstIndex(where: { $0.id == keep }) {
            iqModelPopup.selectItem(at: found)
        } else if let preview = models.firstIndex(where: { $0.id == "step-5-preview" }) {
            iqModelPopup.selectItem(at: preview)
        }
        fillIqThinking(preferred: thinking)
    }

    private func fillIqThinking(preferred: String? = nil) {
        let model = selectedIqModel()
        let levels = model?.thinkingLevels ?? ["off"]
        iqThinkingLevels = levels.isEmpty ? ["off"] : levels
        iqThinkingControl.segmentCount = iqThinkingLevels.count
        for (index, level) in iqThinkingLevels.enumerated() {
            iqThinkingControl.setLabel(thinkingTitle(level), forSegment: index)
            iqThinkingControl.setWidth(46, forSegment: index)
        }
        let choice = preferred ?? model?.defaultThinking ?? "off"
        iqThinkingControl.selectedSegment = iqThinkingLevels.firstIndex(of: choice) ?? 0
        iqThinkingControl.isEnabled = iqThinkingLevels.count > 1
    }

    @objc private func iqModelChanged() {
        fillIqThinking(preferred: nil)
    }

    @objc private func iqProviderChanged() {
        fillIqModels(preferred: nil)
    }

    @objc private func runIqTest() {
        if iqPhase == "running" {
            backend.iqControl("pause")
            return
        }
        if iqPhase == "paused" {
            backend.iqControl("resume")
            iqPhase = "running"
            iqRunButton?.title = "暂停"
            iqStatusLabel.set("继续测试…")
            return
        }
        guard let provider = selectedIqProvider(), !busy else { return }
        let model = iqModelPopup.titleOfSelectedItem ?? provider.models.first?.id ?? ""
        let thinking = selectedIqThinking()
        let topic = iqTopicPopup.selectedItem?.representedObject as? String ?? "pelican"
        let topicTitle = iqTopicPopup.titleOfSelectedItem ?? "鹈鹕骑自行车"
        guard !model.isEmpty else { return }
        setBusy(true, status: nil)
        iqPhase = "running"
        iqStatusLabel.set("正在测试 \(topicTitle) · \(provider.name) / \(model) · \(thinkingTitle(thinking))…")
        iqLog?.string = ""
        iqReply?.string = ""
        iqReplyScroll?.isHidden = true
        iqWeb?.isHidden = false
        setIqLogVisible(false)
        appendIqLine("开始 \(provider.name) / \(model)")
        iqRunButton?.title = "暂停"
        iqRunButton?.isEnabled = true
        iqCancelButton?.isHidden = false
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.iqRun("\(provider.appType)/\(provider.id)", model: model, thinking: thinking, topic: topic) { [weak self] chunk in
                    self?.handleIqProgress(chunk)
                }
                DispatchQueue.main.async {
                    self.finishIqRun()
                    self.showIq(result)
                }
            } catch {
                DispatchQueue.main.async {
                    self.finishIqRun()
                    self.iqStatusLabel.set("❌ \(error.localizedDescription)")
                }
            }
        }
    }

    private func handleIqProgress(_ chunk: String) {
        for raw in chunk.split(whereSeparator: \.isNewline) {
            let line = String(raw).trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { continue }
            if line.hasPrefix("STATE ") {
                applyIqState(String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces))
            } else if line.hasPrefix("HTML ") {
                let path = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                appendIqLine("页面已更新")
                iqEmptyLabel?.isHidden = true
                let url = URL(fileURLWithPath: path)
                iqWeb?.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            } else if line.hasPrefix("STEP ") {
                let text = String(line.dropFirst(5))
                appendIqLine(text)
                iqStatusLabel?.set(text)
            } else if line.hasPrefix("RUN_DIR ") {
                appendIqLine("工作目录已准备")
            }
        }
    }

    private func appendIqLine(_ text: String) {
        guard let iqLog else { return }
        if !iqLog.string.isEmpty { iqLog.string += "\n" }
        iqLog.string += text
        iqLog.scrollToEndOfDocument(nil)
        setIqLogVisible(true)
    }

    private func setIqLogVisible(_ visible: Bool) {
        iqLogScroll?.isHidden = !visible
        iqLogHeight?.constant = visible ? 72 : 0
    }

    @objc private func cancelIqTest() {
        guard iqPhase == "running" || iqPhase == "paused" else { return }
        iqPhase = "cancelled"
        iqStatusLabel.set("正在取消…")
        iqRunButton?.isEnabled = false
        backend.iqControl("cancel")
    }

    private func applyIqState(_ state: String) {
        guard state == "running" || state == "paused" || state == "cancelled" else { return }
        iqPhase = state
        iqCancelButton?.isHidden = false
        if state == "paused" {
            iqRunButton?.title = "继续"
            iqRunButton?.isEnabled = true
            iqStatusLabel.set("已暂停")
        } else if state == "running" {
            iqRunButton?.title = "暂停"
            iqRunButton?.isEnabled = true
        }
    }

    private func finishIqRun() {
        iqPhase = "idle"
        setBusy(false)
        iqRunButton?.title = "开始测试"
        iqRunButton?.isEnabled = true
        iqCancelButton?.isHidden = true
    }

    private func showIq(_ result: IqRunResult) {
        if result.stopReason == "cancelled", result.htmlPath == nil, (result.reply ?? "").isEmpty {
            iqStatusLabel.set("已取消")
            iqRunButton?.title = "开始测试"
            iqRunButton?.isEnabled = true
            return
        }
        let inspect = result.inspect
        let textAnswer = (result.reply?.isEmpty == false)
        let flag: String
        if textAnswer {
            flag = result.answer.map { "答案 \($0)" } ?? "没有单独写出答案"
        } else {
            flag = (inspect?.hasSvg == true && inspect?.hasAnimation == true) ? "SVG 和动画都有" : "检查未完全通过"
        }
        let thinking = result.thinking.flatMap { $0 == "off" ? nil : thinkingTitle($0) }
        let head = "\(result.topicTitle ?? iqTopicPopup.titleOfSelectedItem ?? "") · \(result.providerName ?? "") / \(result.model ?? "")"
        iqMetaLabel?.stringValue = thinking == nil ? "\(head) · \(flag)" : "\(head) · \(thinking!) · \(flag)"
        if result.stopReason == "cancelled" {
            iqStatusLabel.set("已取消，保留已写出的页面")
        } else {
            iqStatusLabel.set("")
        }
        iqRunButton?.title = "开始测试"
        iqRunButton?.isEnabled = true
        if textAnswer, let reply = result.reply {
            iqEmptyLabel?.isHidden = true
            iqWeb?.isHidden = true
            iqReplyScroll?.isHidden = false
            iqReply?.string = reply
            fitIqReply()
            return
        }
        iqReplyScroll?.isHidden = true
        iqWeb?.isHidden = false
        iqWeb?.forwardsWheelToParent = true
        iqReply?.string = ""
        guard let html = result.htmlPath else {
            iqEmptyLabel?.isHidden = false
            iqPreviewHeight?.constant = 360
            return
        }
        iqEmptyLabel?.isHidden = true
        iqFitPasses = 0
        iqPreviewHeight?.constant = 720
        let url = URL(fileURLWithPath: html)
        iqWeb.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        sidebar?.setDetail(page: 3, result.model ?? "鹈鹕骑车")
    }

    private func fitIqPreview(_ measured: CGFloat) {
        let cap: CGFloat = 12000
        let target = min(max(ceil(measured), 360), cap)
        guard let constraint = iqPreviewHeight else { return }
        let delta = target - constraint.constant
        if abs(delta) < 8 { return }
        if delta > 0 {
            iqFitPasses += 1
            if iqFitPasses > 6 { return }
        }
        constraint.constant = target
        iqWeb?.forwardsWheelToParent = measured <= cap
    }

    private func fitIqReply() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let reply = self.iqReply, let container = reply.textContainer, let manager = reply.layoutManager, self.iqWeb?.isHidden == true else { return }
            let width = max((self.iqReplyScroll?.bounds.width ?? 0) - 8, 280)
            container.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
            manager.ensureLayout(for: container)
            let used = manager.usedRect(for: container).height
            self.iqFitPasses = 0
            self.fitIqPreview(used + 36)
        }
    }

    @objc private func openIqInBrowser() {
        guard let html = lastIqHTML() else { return }
        NSWorkspace.shared.open(html)
    }

    @objc private func revealIqInFinder() {
        guard let html = lastIqHTML() else { return }
        NSWorkspace.shared.activateFileViewerSelecting([html])
    }

    private func lastIqHTML() -> URL? {
        let path = AppPaths.dataFile("iq-last.json").path
        guard let data = FileManager.default.contents(atPath: path),
              let result = try? JSONDecoder().decode(IqRunResult.self, from: data),
              let html = result.htmlPath else { return nil }
        return URL(fileURLWithPath: html)
    }

    private func loadLastIqResult() {
        let path = AppPaths.dataFile("iq-last.json").path
        guard let data = FileManager.default.contents(atPath: path),
              let result = try? JSONDecoder().decode(IqRunResult.self, from: data) else { return }
        showIq(result)
    }

    func selectPage(_ index: Int) {
        let page = [0, 1, 2, 3, 4, 5, 6, 7].contains(index) ? index : 0
        defaults.set(page, forKey: "mainPage")
        showPage(page)
    }

    private func showPage(_ index: Int) {
        let pages = [codexPane, claudePane, ccPane, iqPane, quotaPane, clinePane, grokPane, speedPane]
        let visible = pane(for: index)
        for pane in pages {
            pane?.isHidden = pane !== visible
        }
        sidebar?.select(page: index)
        if let scroll = visible as? NSScrollView {
            scrollToTop(scroll)
            DispatchQueue.main.async { [weak self] in self?.scrollToTop(scroll) }
        }
        if index == 3 { refreshIq() }
        if index == 4 { quotaController?.onShow() }
        if index == 5 { clineController?.onShow() }
        if index == 6 { grokController?.onShow() }
        if index == 7 { speedController?.onShow() } else { speedController?.onHide() }
        refreshSidebar()
    }

    private func pane(for index: Int) -> NSView? {
        switch index {
        case 1: return ccPane
        case 2: return claudePane
        case 3: return iqPane
        case 4: return quotaPane
        case 5: return clinePane
        case 6: return grokPane
        case 7: return speedPane
        default: return codexPane
        }
    }

    private func scrollToTop(_ scroll: NSScrollView) {
        guard scroll.documentView != nil else { return }
        let clip = scroll.contentView
        guard let document = scroll.documentView else { return }
        let y = clip.isFlipped ? 0 : max(0, document.bounds.height - clip.bounds.height)
        clip.scroll(to: NSPoint(x: 0, y: y))
        scroll.reflectScrolledClipView(clip)
    }

    private func refreshSidebar() {
        sidebar?.setDetail(page: 0, codexSidebarDetail())
        sidebar?.setDetail(page: 2, claudeSidebarDetail())
        sidebar?.setDetail(page: 1, ccSidebarDetail())
        sidebar?.setDetail(page: 3, iqSidebarDetail())
        sidebar?.setDetail(page: 4, quotaController?.sidebarDetail() ?? "查询剩余额度")
        sidebar?.setDetail(page: 5, clineController?.sidebarDetail() ?? "查询剩余额度")
        sidebar?.setDetail(page: 6, grokController?.sidebarDetail() ?? "本机网关")
        sidebar?.setDetail(page: 7, speedController?.sidebarDetail() ?? "未测速")
    }

    private func iqSidebarDetail() -> String {
        if let model = iqModelPopup?.titleOfSelectedItem, !model.isEmpty { return model }
        return "鹈鹕骑车"
    }

    private func claudeSidebarDetail() -> String {
        if let provider = claudeProviders.first(where: { $0.id == claudeCurrentId }) {
            return provider.host.map { "\(provider.name) · \($0)" } ?? provider.name
        }
        return "跟随 cc-switch"
    }

    private func codexSidebarDetail() -> String {
        if let provider = providers.first(where: { $0.id == currentId }) {
            if let model = provider.model, !model.isEmpty { return "\(provider.name) · \(model)" }
            return provider.name
        }
        return "供应商热切换"
    }

    private func ccSidebarDetail() -> String {
        guard ccSyncEnabled() else { return "实时同步已关闭" }
        let enabled = remotes.machines.filter(\.enabled)
        if enabled.isEmpty { return "没有远程机器" }
        let lives = enabled.compactMap { ccSwitchLive[$0.host] }
        if lives.count < enabled.count { return "正在检查…" }
        let waiting = lives.filter(\.pending).count
        if waiting > 0 { return "\(waiting) 台等待连接" }
        let failed = lives.filter { !$0.ok }.count
        if failed > 0 { return "\(failed) 台需要处理" }
        return "已与本机一致"
    }

    func barHostLines() -> [(label: String, codex: String, ccswitch: String)] {
        remotes.machines.map { machine in
            let codex: String
            if !machine.enabled {
                codex = "已暂停"
            } else if let live = remoteLive[machine.host] {
                codex = live.ok ? (live.providerName ?? "已连接") : "未连接"
            } else {
                codex = "正在读取"
            }
            return (machine.label, codex, ccSwitchAppearance(for: machine).text)
        }
    }

    func setRemoteSyncEnabled(_ enabled: Bool) {
        guard remoteSwitch != nil else {
            defaults.set(enabled, forKey: "syncRemote")
            return
        }
        guard (remoteSwitch.state == .on) != enabled else { return }
        remoteSwitch.state = enabled ? .on : .off
        toggleRemote()
    }

    func setCcSyncEnabled(_ enabled: Bool) {
        guard ccSyncSwitch != nil else {
            defaults.set(enabled, forKey: "syncCcSwitch")
            return
        }
        guard (ccSyncSwitch.state == .on) != enabled else { return }
        ccSyncSwitch.state = enabled ? .on : .off
        toggleCcSync()
    }

    func checkCcSwitchFromMenu() {
        checkCcSwitchNow()
    }

    var remoteSyncIsOn: Bool { syncRemoteEnabled() }
    var ccSyncIsOn: Bool { ccSyncEnabled() }

    @objc private func toggleCcSync() {
        defaults.set(ccSyncSwitch.state == .on, forKey: "syncCcSwitch")
        rebuildCcRows()
        if ccSyncSwitch.state == .on {
            ccSwitchBootstrapped = false
            startCcSwitchFollow()
            setCcStatus("已开启实时同步")
        } else {
            stopCcSwitchFollow()
            setCcStatus("已关闭实时同步")
        }
        refreshSidebar()
    }

    @objc private func checkCcSwitchNow() {
        guard !ccSwitchBusy else { return }
        ccSwitchBootstrapped = false
        ccSwitchPending.removeAll()
        setCcStatus("正在按本机检查远程 cc-switch…")
        if ccSyncSwitch.state == .on {
            startCcSwitchFollow()
        }
        tickCcSwitchFollow()
    }

    private func ccSyncEnabled() -> Bool {
        if ccSyncSwitch != nil { return ccSyncSwitch.state == .on }
        return defaults.object(forKey: "syncCcSwitch") as? Bool ?? true
    }

    private func setCcStatus(_ text: String) {
        ccStatusLabel?.set(text)
    }

    private func syncRemoteEnabled() -> Bool {
        if remoteSwitch != nil { return remoteSwitch.state == .on }
        return defaults.object(forKey: "syncRemote") as? Bool ?? true
    }

    @objc private func remoteMachineToggled(_ sender: NSSwitch) {
        guard let host = sender.identifier?.rawValue else { return }
        remotes.setEnabled(host: host, enabled: sender.state == .on)
        let name = remotes.machines.first { $0.host == host }?.label ?? host
        setStatus(sender.state == .on ? "\(name) 会参与同步" : "已暂停同步 \(name)")
    }

    @objc private func removeRemote(_ sender: NSButton) {
        guard let host = sender.identifier?.rawValue else { return }
        let name = remotes.machines.first { $0.host == host }?.label ?? host
        remotes.remove(host: host)
        rebuildRemoteRows()
        setStatus("已移除 \(name)")
    }

    @objc private func addRemote() {
        presentAddSheet()
    }

    private func ccSwitchAppearance(for machine: RemoteMachine) -> (symbol: String, tint: NSColor, text: String) {
        guard machine.enabled else { return ("pause.circle", .tertiaryLabelColor, "已暂停") }
        guard ccSyncEnabled() else { return ("pause.circle", .tertiaryLabelColor, "已关闭") }
        guard let live = ccSwitchLive[machine.host] else { return ("arrow.triangle.2.circlepath", .secondaryLabelColor, "正在检查…") }
        if live.pending {
            let waiting = live.error == "等待连接" || live.error == nil
            return ("clock", .secondaryLabelColor, waiting ? "等待连接" : (live.error ?? "等待连接"))
        }
        if !live.ok { return ("exclamationmark.circle", .systemRed, live.error.map { "失败：\($0)" } ?? "失败") }
        if live.changed { return ("checkmark.circle.fill", .systemGreen, "已按本机更新") }
        return ("checkmark.circle.fill", .systemGreen, "已与本机一致")
    }

    private func startCcSwitchFollow() {
        guard ccSwitchTimer == nil else { return }
        let timer = Timer(timeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.tickCcSwitchFollow()
        }
        RunLoop.main.add(timer, forMode: .common)
        ccSwitchTimer = timer
        tickCcSwitchFollow()
    }

    private func stopCcSwitchFollow() {
        ccSwitchTimer?.invalidate()
        ccSwitchTimer = nil
        ccSwitchBusy = false
    }

    private func tickCcSwitchFollow() {
        guard ccSyncEnabled(), !ccSwitchBusy else { return }
        let previous = ccSwitchHash
        let bootstrapped = ccSwitchBootstrapped
        let pending = ccSwitchPending
        let lastAttempt = ccSwitchLastAttempt
        ccSwitchBusy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            guard let hash = try? self.backend.ccSwitchFingerprint() else {
                DispatchQueue.main.async { self.ccSwitchBusy = false }
                return
            }
            let localChanged = hash != previous
            let retryDue = !pending.isEmpty && Date().timeIntervalSince(lastAttempt) > 8
            guard localChanged || !bootstrapped || retryDue else {
                DispatchQueue.main.async { self.ccSwitchBusy = false }
                return
            }
            let onlyPending = !localChanged && bootstrapped
            do {
                if localChanged { Thread.sleep(forTimeInterval: 0.4) }
                let stable = try self.backend.ccSwitchFingerprint()
                let result = try self.backend.syncCcSwitch(hosts: onlyPending ? Array(pending) : nil)
                DispatchQueue.main.async {
                    self.applyCcSwitchResult(result, hash: stable, replacePending: !onlyPending)
                }
            } catch {
                DispatchQueue.main.async {
                    self.ccSwitchBusy = false
                    self.ccSwitchLastAttempt = Date()
                }
            }
        }
    }

    private func applyCcSwitchResult(_ result: CcSwitchSyncResult, hash: String, replacePending: Bool) {
        ccSwitchBusy = false
        ccSwitchHash = hash
        ccSwitchBootstrapped = true
        ccSwitchLastAttempt = Date()
        if replacePending { ccSwitchPending.removeAll() }
        var changedState = false
        for host in result.remote.hosts {
            let old = ccSwitchLive[host.host]
            if old?.ok != host.ok || old?.pending != host.pending || old?.changed != host.changed {
                changedState = true
            }
            ccSwitchLive[host.host] = host
            if host.ok {
                ccSwitchAttempts[host.host] = 0
                ccSwitchPending.remove(host.host)
            } else if host.pending || (ccSwitchAttempts[host.host] ?? 0) < 3 {
                ccSwitchAttempts[host.host] = (ccSwitchAttempts[host.host] ?? 0) + 1
                ccSwitchPending.insert(host.host)
            } else {
                ccSwitchPending.remove(host.host)
            }
        }
        if changedState { rebuildCcRows() }
        refreshSidebar()
        let updated = result.remote.hosts.filter { $0.ok && $0.changed }.map(\.label)
        if !updated.isEmpty {
            setCcStatus("已按本机更新 " + updated.joined(separator: "、"))
        } else if let waiting = result.remote.hosts.first(where: { $0.pending }) {
            let reason = waiting.error ?? "没连上"
            setCcStatus("\(waiting.label)：\(reason)。连上后会再检查")
        } else if result.remote.hosts.allSatisfy(\.ok) {
            setCcStatus("远程 cc-switch 已与本机一致")
        }
    }

    private func replaceSecrets(in host: NSStackView, with token: String?) {
        for view in host.arrangedSubviews {
            host.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        guard let token, !token.isEmpty else { return }
        let secret = CopyableSecret(text: token, expands: true)
        host.addArrangedSubview(secret)
        secret.widthAnchor.constraint(equalTo: host.widthAnchor).isActive = true
    }

    private func tableHeight(_ table: NSTableView?, rows: Int) -> CGFloat {
        guard let table, rows > 0 else { return 44 }
        var total: CGFloat = 0
        for row in 0..<rows {
            total += self.tableView(table, heightOfRow: row)
        }
        return min(560, max(44, total))
    }

    private func usageText(for host: String) -> String {
        guard let live = remoteLive[host] else { return "正在读取…" }
        if !live.ok { return live.error ?? "读取失败" }
        let name = live.providerName ?? "未命名"
        let endpoint = live.baseUrl.flatMap { URL(string: $0)?.host } ?? live.baseUrl ?? "—"
        return "\(name) · \(endpoint)"
    }

    private func refreshRemoteLive() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let result = try? self.backend.remoteStatus()
            DispatchQueue.main.async {
                guard let result else {
                    self.setStatus("远程状态读取失败")
                    return
                }
                var next: [String: RemoteHostInfo] = [:]
                for host in result.hosts {
                    next[host.host] = host
                }
                self.remoteLive = next
                self.rebuildRemoteRows()
                self.refreshSidebar()
            }
        }
    }

    private func applyRemoteLive(_ remote: RemoteSyncInfo?) {
        guard let remote else { return }
        for host in remote.hosts where host.ok {
            remoteLive[host.host] = host
        }
        rebuildRemoteRows()
        refreshSidebar()
    }

    private func remoteSummary(_ remote: RemoteSyncInfo?) -> String? {
        guard let remote, !remote.hosts.isEmpty else { return nil }
        let parts = remote.hosts.map { host -> String in
            if !host.ok { return "\(host.label) 失败" }
            if host.changed { return "\(host.label) 已同步" }
            return "\(host.label) 已一致"
        }
        var text = "远程 " + parts.joined(separator: "、")
        if let error = remote.hosts.first(where: { !$0.ok })?.error, !error.isEmpty {
            text += "（\(error)）"
        }
        return text
    }

    @objc private func toggleLogin() {
        do {
            if loginSwitch.state == .on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            setStatus(loginSwitch.state == .on ? "已设置登录时启动" : "已取消登录时启动")
        } catch {
            loginSwitch.state = loginSwitch.state == .on ? .off : .on
            setStatus("设置登录启动失败: \(error.localizedDescription)")
        }
    }

    static func loginItemEnabled() -> Bool {
        SMAppService.mainApp.status == .enabled
    }

    private func scopeCode() -> String {
        switch scopePopup.indexOfSelectedItem {
        case 1: return "chatgpt-all"
        case 2: return "all"
        default: return "chatgpt"
        }
    }

    private func scopeIndexFromDefaults() -> Int {
        switch defaults.string(forKey: "scope") ?? "chatgpt" {
        case "chatgpt-all": return 1
        case "all": return 2
        default: return 0
        }
    }

    // MARK: - 状态

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [] }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [] }

    func setStatus(_ text: String) {
        statusLabel.set(text)
    }

    private func finishAutoReload(onDone: (() -> Void)?) {
        if pendingAutoReload {
            pendingAutoReloadDone = onDone ?? pendingAutoReloadDone
        }
        let followUp = pendingAutoReload
        setBusy(false)
        if followUp {
            let done = pendingAutoReloadDone
            pendingAutoReload = false
            pendingAutoReloadDone = nil
            autoReloadAfterChange(onDone: done)
        } else {
            onDone?()
        }
    }

    private func setBusy(_ value: Bool, status: String? = nil) {
        busy = value
        reloadButton.isEnabled = !value
        iqRunButton?.isEnabled = !value
        tableView.isEnabled = !value
        claudeTableView?.isEnabled = !value
        if value { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        addRemoteButton?.isEnabled = !value
        if let status { setStatus(status) }
    }

    private func presentAddSheet() {
        let labelField = formField("例如 gpu")
        let hostField = formField("主机名或 IP")
        let userField = formField("留空则用 SSH config")
        let portField = formField("22")
        let keyField = formField("留空则用 SSH config")
        portField.stringValue = ""

        let choose = NSButton(title: "选择…", target: self, action: #selector(chooseIdentity(_:)))
        choose.bezelStyle = .rounded
        choose.controlSize = .small
        choose.identifier = NSUserInterfaceItemIdentifier("identity-picker")
        objc_setAssociatedObject(choose, &identityFieldKey, keyField, .OBJC_ASSOCIATION_RETAIN)

        let keyRow = NSStackView(views: [keyField, choose])
        keyRow.orientation = .horizontal
        keyRow.spacing = 8
        keyField.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let grid = NSGridView(views: [
            [formCaption("名称"), labelField],
            [formCaption("主机"), hostField],
            [formCaption("用户"), userField],
            [formCaption("端口"), portField],
            [formCaption("私钥"), keyRow],
        ])
        grid.rowSpacing = 12
        grid.columnSpacing = 12
        grid.column(at: 1).xPlacement = .fill

        let cancel = NSButton(title: "取消", target: self, action: #selector(cancelAddSheet(_:)))
        cancel.bezelStyle = .rounded
        cancel.keyEquivalent = "\u{1b}"
        let save = NSButton(title: "添加", target: self, action: #selector(confirmAddSheet(_:)))
        save.bezelStyle = .rounded
        save.keyEquivalent = "\r"
        objc_setAssociatedObject(save, &addSheetFieldsKey, [labelField, hostField, userField, portField, keyField], .OBJC_ASSOCIATION_RETAIN)

        let buttons = NSStackView(views: [flexibleSpace(), cancel, save])
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let hint = makeLabel("认证使用 SSH 密钥。没有写在 SSH config 里的机器，请填用户和私钥。", font: .systemFont(ofSize: 11), color: .secondaryLabelColor)
        hint.maximumNumberOfLines = 2
        hint.lineBreakMode = .byWordWrapping

        let body = NSStackView(views: [grid, hint, buttons])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 16
        body.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 16, right: 20)
        body.translatesAutoresizingMaskIntoConstraints = false

        let sheet = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 280),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        sheet.title = "添加远程机器"
        let sheetContent = NSView()
        sheet.contentView = sheetContent
        sheetContent.addSubview(body)
        NSLayoutConstraint.activate([
            body.topAnchor.constraint(equalTo: sheetContent.topAnchor),
            body.leadingAnchor.constraint(equalTo: sheetContent.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: sheetContent.trailingAnchor),
            body.bottomAnchor.constraint(equalTo: sheetContent.bottomAnchor),
            grid.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -40),
            hint.widthAnchor.constraint(equalTo: grid.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: grid.widthAnchor),
        ])
        window.beginSheet(sheet)
    }

    @objc private func cancelAddSheet(_ sender: NSButton) {
        guard let sheet = sender.window else { return }
        window.endSheet(sheet)
    }

    @objc private func confirmAddSheet(_ sender: NSButton) {
        guard let sheet = sender.window,
              let fields = objc_getAssociatedObject(sender, &addSheetFieldsKey) as? [NSTextField],
              fields.count == 5 else { return }
        let portText = fields[3].stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        var port: Int?
        if !portText.isEmpty {
            guard let value = Int(portText), (1...65535).contains(value) else {
                setStatus("端口需要是 1 到 65535 的数字")
                return
            }
            port = value
        }
        do {
            try remotes.add(
                label: fields[0].stringValue,
                host: fields[1].stringValue,
                user: fields[2].stringValue,
                port: port,
                identityFile: fields[4].stringValue
            )
            rebuildRemoteRows()
            setStatus("已添加 \(fields[0].stringValue.isEmpty ? fields[1].stringValue : fields[0].stringValue)")
            window.endSheet(sheet)
        } catch {
            setStatus(error.localizedDescription)
        }
    }

    @objc private func chooseIdentity(_ sender: NSButton) {
        guard let field = objc_getAssociatedObject(sender, &identityFieldKey) as? NSTextField else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ssh")
        panel.begin { response in
            if response == .OK, let url = panel.url {
                field.stringValue = url.path
            }
        }
    }

    private func formField(_ placeholder: String) -> NSTextField {
        let field = NSTextField()
        field.placeholderString = placeholder
        field.font = .systemFont(ofSize: 13)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.widthAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
        return field
    }

    private func formCaption(_ text: String) -> NSTextField {
        let label = makeLabel(text, font: .systemFont(ofSize: 13), color: .labelColor)
        label.alignment = .right
        label.widthAnchor.constraint(equalToConstant: 36).isActive = true
        return label
    }
}

private var addSheetFieldsKey: UInt8 = 0
private var identityFieldKey: UInt8 = 0

final class SidebarRow: NSView {
    var onClick: (() -> Void)?
    var selected = false { didSet { applyStyle() } }

    private let iconView = NSImageView()
    private let titleField: NSTextField
    private let detailField: NSTextField

    init(title: String, symbol: String) {
        titleField = NSTextField(labelWithString: title)
        detailField = NSTextField(labelWithString: " ")
        super.init(frame: .zero)
        titleField.font = .systemFont(ofSize: 13, weight: .medium)
        titleField.lineBreakMode = .byTruncatingTail
        detailField.font = .systemFont(ofSize: 11)
        detailField.lineBreakMode = .byTruncatingTail
        iconView.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 15, weight: .medium)
        iconView.translatesAutoresizingMaskIntoConstraints = false

        let texts = NSStackView(views: [titleField, detailField])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 1
        texts.translatesAutoresizingMaskIntoConstraints = false
        addSubview(iconView)
        addSubview(texts)
        NSLayoutConstraint.activate([
            iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            iconView.centerYAnchor.constraint(equalTo: centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 18),
            texts.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 8),
            texts.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            texts.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
        applyStyle()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setDetail(_ text: String) {
        detailField.stringValue = text
        setAccessibilityValue(text)
    }

    override func draw(_ dirtyRect: NSRect) {
        if selected {
            NSColor.controlAccentColor.setFill()
            let rect = bounds.insetBy(dx: 6, dy: 2)
            NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8).fill()
        }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        return bounds.contains(local) ? self : nil
    }

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }

    override func accessibilityPerformPress() -> Bool {
        onClick?()
        return true
    }

    private func applyStyle() {
        titleField.textColor = selected ? .white : .labelColor
        detailField.textColor = selected ? NSColor.white.withAlphaComponent(0.86) : .secondaryLabelColor
        iconView.contentTintColor = selected ? .white : .secondaryLabelColor
        needsDisplay = true
    }
}

final class CardView: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.masksToBounds = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
    }
}

final class ProviderRowView: NSTableRowView {
    var active = false

    override func drawSelection(in dirtyRect: NSRect) {}

    override func draw(_ dirtyRect: NSRect) {
        if active {
            NSColor.controlAccentColor.withAlphaComponent(0.14).setFill()
            let rect = bounds.insetBy(dx: 4, dy: 2)
            NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6).fill()
        }
        super.draw(dirtyRect)
    }
}

extension Notification.Name {
    static let watchToggled = Notification.Name("ai-toolbox.watchToggled")
    static let configWrittenFromApp = Notification.Name("ai-toolbox.configWrittenFromApp")
    static let claudeWatchToggled = Notification.Name("ai-toolbox.claudeWatchToggled")
    static let claudeConfigWrittenFromApp = Notification.Name("ai-toolbox.claudeConfigWrittenFromApp")
}
