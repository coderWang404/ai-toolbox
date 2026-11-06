// Today 页：Today.app 登录态、模型目录、本地 OpenAI 兼容网关。
import AppKit

final class TodayPane: NSObject {
    private(set) var root: NSView!
    var onDetail: ((String) -> Void)?

    private let backend: Backend
    private let embedded: Bool
    private var statusInfo: TodayStatus?
    private var models: [TodayModel] = []
    private var busy = false
    private var gatewayRunning = false

    private let statusBox = GroupBox()
    private let gatewayBox = GroupBox()
    private let modelBox = GroupBox()
    private let modelPopup = NSPopUpButton()
    private let portField = NSTextField()
    private let gatewayButton = NSButton()
    private let launchButton = NSButton()
    private let portApplyButton = NSButton()
    private let applyModelButton = NSButton()
    private let promptView = NSTextView()
    private let replyView = NSTextView()
    private let status = StatusLine()
    private let gatewayStatus = StatusLine()
    private let spinner = NSProgressIndicator()
    private var topControls: NSStackView!
    private var gatewayControls: NSStackView!

    init(backend: Backend, embedded: Bool = false) {
        self.backend = backend
        self.embedded = embedded
        super.init()
        root = makeRoot()
    }

    func onShow() {
        guard !busy else { return }
        refresh()
    }

    func sidebarDetail() -> String {
        if let current = statusInfo?.currentModel, !current.isEmpty { return current }
        if statusInfo?.cdp?.reachable == true { return "已连接" }
        return "未连接"
    }

    private func makeRoot() -> NSView {
        gatewayButton.title = "启动网关"
        gatewayButton.bezelStyle = .rounded
        gatewayButton.target = self
        gatewayButton.action = #selector(toggleGateway)
        launchButton.title = "启动 Today（调试端口）"
        launchButton.bezelStyle = .rounded
        launchButton.target = self
        launchButton.action = #selector(launchToday)
        applyModelButton.title = "切换"
        applyModelButton.bezelStyle = .rounded
        applyModelButton.target = self
        applyModelButton.action = #selector(applyModel)

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        portField.stringValue = String(backend.todayGatewayPort)
        portField.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
        portField.alignment = .right
        portField.translatesAutoresizingMaskIntoConstraints = false
        portField.widthAnchor.constraint(equalToConstant: 72).isActive = true
        portField.toolTip = "1024–65535"
        portField.target = self
        portField.action = #selector(applyPort)
        portApplyButton.title = "应用"
        portApplyButton.bezelStyle = .rounded
        portApplyButton.target = self
        portApplyButton.action = #selector(applyPort)

        let refreshButton = NSButton(title: "刷新", target: self, action: #selector(refresh))
        refreshButton.bezelStyle = .rounded
        topControls = NSStackView(views: [spinner, refreshButton, launchButton])
        topControls.orientation = .horizontal
        topControls.alignment = .centerY
        topControls.spacing = 8

        gatewayControls = NSStackView(views: [gatewayButton, portField, portApplyButton])
        gatewayControls.orientation = .horizontal
        gatewayControls.alignment = .centerY
        gatewayControls.spacing = 8

        configureText(promptView)
        configureText(replyView)
        let promptScroll = scroll(promptView, height: 64)
        let replyScroll = scroll(replyView, height: 128)
        let sendButton = NSButton(title: "发送", target: self, action: #selector(send))
        sendButton.bezelStyle = .rounded
        sendButton.bezelColor = .controlAccentColor
        let modelRow = NSStackView(views: [modelPopup, applyModelButton, NSView(), sendButton])
        modelRow.orientation = .horizontal
        modelRow.alignment = .centerY
        modelRow.spacing = 8
        let chatColumn = NSStackView(views: [modelRow, promptScroll, replyScroll])
        chatColumn.orientation = .vertical
        chatColumn.alignment = .leading
        chatColumn.spacing = 8
        promptScroll.widthAnchor.constraint(equalTo: chatColumn.widthAnchor).isActive = true
        replyScroll.widthAnchor.constraint(equalTo: chatColumn.widthAnchor).isActive = true
        modelRow.widthAnchor.constraint(equalTo: chatColumn.widthAnchor).isActive = true
        modelBox.addRow(chatColumn)

        let body = NSStackView(views: [
            SectionView(title: "状态", content: statusBox, footer: "Today 的鉴权在 Electron 主进程里自动注入，本模块只通过 CDP 页面上下文发请求，不保存账号密码。"),
            gatewayStatus,
            SectionView(title: "本地网关", content: gatewayBox, footer: "复制 Base URL 和 API Key 填到其他 OpenAI 兼容客户端；模型切换是 Today 账号的全局设置。"),
            SectionView(title: "试一句", content: modelBox, footer: "模型目录来自 Today 账号，切换后 Today App 里的选择也会变。"),
            status,
        ])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 22
        renderStatus()
        renderGateway()
        renderModels()
        if embedded { return PageChrome.embeddedScroll(content: body) }
        return PageChrome.scroll(
            title: "Today",
            subtitle: "把 Today.app 的模型接成一个独立的本地 OpenAI 兼容模块。",
            content: body
        )
    }

    private func configureText(_ view: NSTextView) {
        view.isEditable = true
        view.isSelectable = true
        view.isRichText = false
        view.font = .systemFont(ofSize: 13)
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.drawsBackground = false
        view.textContainerInset = NSSize(width: 6, height: 6)
    }

    private func scroll(_ view: NSTextView, height: CGFloat) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.documentView = view
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: height).isActive = true
        return scroll
    }

    @objc private func refresh() {
        guard !busy else { return }
        busy = true
        syncControls()
        status.set("正在读取 Today…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let info = try self.backend.todayStatus()
                DispatchQueue.main.async {
                    self.busy = false
                    self.statusInfo = info
                    self.models = info.models ?? []
                    self.renderStatus()
                    self.renderGateway()
                    self.renderModels()
                    self.syncControls()
                    if let error = info.error, !error.isEmpty {
                        self.status.set("⚠️ \(error)", tone: .warning)
                    } else if info.cdp?.reachable == true {
                        let count = self.models.count
                        self.status.set("✔ Today 已连接 · \(count) 个模型", tone: .success)
                    } else {
                        self.status.set("Today 没有带调试端口运行", tone: .error)
                    }
                    self.onDetail?(self.sidebarDetail())
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.status.set("❌ \(error.localizedDescription)", tone: .error)
                }
            }
        }
    }

    @objc private func launchToday() {
        guard !busy else { return }
        busy = true
        syncControls()
        status.set("正在以调试端口启动 Today…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                try self.backend.todayLaunch()
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.status.set("✔ Today 已启动，正在读取登录态…", tone: .success)
                    self.refresh()
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.status.set("❌ \(error.localizedDescription)", tone: .error)
                }
            }
        }
    }

    @objc private func toggleGateway() {
        guard !busy else { return }
        let running = gatewayRunning || backend.todayGatewayIsRunning()
        busy = true
        syncControls()
        gatewayStatus.set(running ? "正在停止网关…" : "正在启动网关…", tone: .info)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                if running {
                    self.backend.stopTodayGateway()
                    Thread.sleep(forTimeInterval: 0.3)
                    DispatchQueue.main.async {
                        self.busy = false
                        self.gatewayRunning = false
                        self.syncControls()
                        self.gatewayStatus.set("网关已停止", tone: .info)
                        self.status.set("已停止 Today 网关")
                    }
                } else {
                    try self.backend.startTodayGateway()
                    DispatchQueue.main.async {
                        self.busy = false
                        self.gatewayRunning = true
                        self.syncControls()
                        self.gatewayStatus.set("网关已启动 · \(self.backend.todayGatewayBaseURL)", tone: .success)
                        self.status.set("网关已启动，正在读取状态…")
                        self.refresh()
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.gatewayRunning = false
                    self.syncControls()
                    self.gatewayStatus.set(error.localizedDescription, tone: .error)
                    self.status.set("❌ \(error.localizedDescription)", tone: .error)
                }
            }
        }
    }

    @objc private func applyPort() {
        guard !busy else { return }
        let text = portField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let port = Int(text), (1024...65535).contains(port) else {
            gatewayStatus.set("端口要填 1024–65535 之间的数字", tone: .error)
            return
        }
        guard port != backend.todayGatewayPort else {
            gatewayStatus.set("端口没有变化 · \(port)", tone: .info)
            return
        }
        let wasRunning = gatewayRunning || backend.todayGatewayIsRunning()
        busy = true
        syncControls()
        gatewayStatus.set("正在切换端口…", tone: .info)
        UserDefaults.standard.set(port, forKey: "todayPort")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            if wasRunning {
                self.backend.stopTodayGateway()
                Thread.sleep(forTimeInterval: 0.3)
            }
            DispatchQueue.main.async {
                self.busy = false
                self.gatewayRunning = false
                self.syncControls()
                self.gatewayStatus.set("端口已改为 \(port)，点「启动网关」使用新地址", tone: .info)
                self.refresh()
            }
        }
    }

    @objc private func applyModel() {
        guard !busy, let id = selectedModelId(), !id.isEmpty else { return }
        busy = true
        syncControls()
        status.set("正在切换 Today 模型…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.todaySetModel(id)
                DispatchQueue.main.async {
                    self.busy = false
                    self.models = result.models ?? self.models
                    self.renderModels()
                    self.syncControls()
                    self.status.set("✔ 已切换到 \(result.currentModel ?? id)", tone: .success)
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.status.set("❌ \(error.localizedDescription)", tone: .error)
                }
            }
        }
    }

    @objc private func send() {
        let text = promptView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            status.set("❌ 先写一句要发给 Today 的话")
            return
        }
        guard !busy else { return }
        let model = selectedModelId()
        busy = true
        syncControls()
        replyView.string = ""
        status.set("正在等待 Today 回复…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.todayChat(text: text, model: model)
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.replyView.string = result.reply ?? ""
                    let ms = result.elapsedMs.map { " · \($0) ms" } ?? ""
                    self.status.set("✔ \(result.model ?? model ?? "Today")\(ms)", tone: .success)
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.status.set("❌ \(error.localizedDescription)", tone: .error)
                }
            }
        }
    }

    private func syncControls() {
        gatewayButton.isEnabled = !busy
        launchButton.isEnabled = !busy
        applyModelButton.isEnabled = !busy
        modelPopup.isEnabled = !busy && !models.isEmpty
        portField.isEnabled = !busy
        portApplyButton.isEnabled = !busy
        gatewayButton.title = (gatewayRunning || backend.todayGatewayIsRunning()) ? "停止网关" : "启动网关"
        if busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
    }

    private func renderStatus() {
        var rows: [NSView] = [
            SettingRow(title: "Today.app", subtitle: "CDP 调试端口 9222", accessory: topControls),
        ]
        if let cdp = statusInfo?.cdp {
            let state = cdp.reachable ? "已连接" : "不可达"
            rows.append(SettingRow(title: "CDP", subtitle: cdp.error, accessory: pill(state, ok: cdp.reachable)))
        }
        if let page = statusInfo?.pageUrl, !page.isEmpty {
            rows.append(SettingRow(title: "页面", accessory: label(page)))
        }
        if let current = statusInfo?.currentModel, !current.isEmpty {
            rows.append(SettingRow(title: "当前模型", accessory: label(current)))
        }
        statusBox.setRows(rows)
    }

    private func renderGateway() {
        let port = statusInfo?.gateway?.port ?? backend.todayGatewayPort
        let base = statusInfo?.gateway?.baseUrl ?? "http://127.0.0.1:\(port)/v1"
        gatewayRunning = statusInfo?.gateway?.running == true || backend.todayGatewayIsRunning()
        var rows: [NSView] = [
            SettingRow(title: "本地网关", subtitle: "OpenAI 兼容地址，供其他 agent 调用", accessory: gatewayControls),
            SettingRow(title: "地址", accessory: CopyableSecret(text: base, expands: true, masked: false)),
        ]
        if let key = statusInfo?.gateway?.apiKey, !key.isEmpty {
            rows.append(SettingRow(title: "API Key", accessory: CopyableSecret(text: key, expands: true)))
        }
        if gatewayRunning {
            gatewayStatus.set("网关运行中 · \(base)", tone: .success)
        } else {
            gatewayStatus.set("网关未启动 · 端口 \(port)", tone: .info)
        }
        gatewayBox.setRows(rows)
    }

    private func selectedModelId() -> String? {
        let index = modelPopup.indexOfSelectedItem
        guard index >= 0, index < models.count else { return nil }
        return models[index].id
    }

    private func renderModels() {
        let selected = modelPopup.indexOfSelectedItem
        modelPopup.removeAllItems()
        if models.isEmpty {
            modelPopup.addItem(withTitle: "没有可用模型")
            modelPopup.isEnabled = false
            return
        }
        for model in models {
            let suffix = model.disabled == true ? "（不可用）" : ""
            modelPopup.addItem(withTitle: "\(model.id)\(suffix)")
        }
        if selected >= 0, selected < models.count {
            modelPopup.selectItem(at: selected)
        } else if let current = statusInfo?.currentModel,
                  let index = models.firstIndex(where: { $0.id == current }) {
            modelPopup.selectItem(at: index)
        }
    }

    private func pill(_ text: String, ok: Bool) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: 11, weight: .medium)
        field.textColor = ok ? .systemGreen : .systemRed
        return field
    }

    private func label(_ text: String) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: 12)
        field.textColor = .secondaryLabelColor
        field.lineBreakMode = .byTruncatingMiddle
        return field
    }
}
