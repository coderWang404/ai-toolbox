// Grok Bot 页：本机登录、助手、模型和 127.0.0.1 上的 OpenAI 兼容网关。
import AppKit

final class GrokBotPane: NSObject {
    private(set) var root: NSView!
    var onDetail: ((String) -> Void)?

    private let backend: Backend
    private var statusInfo: GrokStatus?
    private var busy = false
    private var loaded = false

    private let accountBox = GroupBox()
    private let agentBox = GroupBox()
    private let modelPopup = NSPopUpButton()
    private let promptView = NSTextView()
    private let replyView = NSTextView()
    private let status = StatusLine()
    private let gatewayStatus = StatusLine()
    private let gatewayButton = NSButton()
    private let portField = NSTextField()
    private let portApplyButton = NSButton()
    private let sendButton = NSButton()
    private let spinner = NSProgressIndicator()
    private var gatewayRunning = false

    init(backend: Backend) {
        self.backend = backend
        super.init()
        root = makeRoot()
    }

    func onShow() {
        guard !loaded else { return }
        loaded = true
        refresh()
    }

    func sidebarDetail() -> String {
        if gatewayRunning || backend.grokGatewayIsRunning() { return "网关运行中" }
        if let email = statusInfo?.email, !email.isEmpty { return email }
        return "读取本机登录"
    }

    private func makeRoot() -> NSView {
        modelPopup.addItems(withTitles: ["grok-bot-default", "grok-bot-automation"])
        gatewayButton.title = "启动网关"
        gatewayButton.bezelStyle = .rounded
        gatewayButton.target = self
        gatewayButton.action = #selector(toggleGateway)
        let refreshButton = NSButton(title: "刷新", target: self, action: #selector(refresh))
        refreshButton.bezelStyle = .rounded
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        portField.stringValue = String(backend.grokGatewayPort)
        portField.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
        portField.alignment = .right
        portField.translatesAutoresizingMaskIntoConstraints = false
        portField.widthAnchor.constraint(equalToConstant: 72).isActive = true
        portField.target = self
        portField.action = #selector(applyPort)
        portField.toolTip = "1024–65535"
        portApplyButton.title = "应用"
        portApplyButton.bezelStyle = .rounded
        portApplyButton.target = self
        portApplyButton.action = #selector(applyPort)

        let gatewayButtons = NSStackView(views: [spinner, refreshButton, gatewayButton])
        gatewayButtons.orientation = .horizontal
        gatewayButtons.alignment = .centerY
        gatewayButtons.spacing = 8
        let portControls = NSStackView(views: [portField, portApplyButton])
        portControls.orientation = .horizontal
        portControls.alignment = .centerY
        portControls.spacing = 6

        let gatewayBox = GroupBox()
        gatewayBox.addRow(SettingRow(title: "本机网关", subtitle: "OpenAI 兼容地址", accessory: gatewayButtons))
        gatewayBox.addRow(SettingRow(title: "端口", subtitle: "改端口后，cc-switch 的 Base URL 也要同步改", accessory: portControls))

        configureText(promptView)
        configureText(replyView)
        let promptScroll = scroll(promptView, height: 72)
        let replyScroll = scroll(replyView, height: 120)
        sendButton.title = "发送"
        sendButton.bezelStyle = .rounded
        sendButton.bezelColor = .controlAccentColor
        sendButton.target = self
        sendButton.action = #selector(send)
        let modelRow = NSStackView(views: [modelPopup, NSView(), sendButton])
        modelRow.orientation = .horizontal
        modelRow.alignment = .centerY
        let chatColumn = NSStackView(views: [modelRow, promptScroll, replyScroll])
        chatColumn.orientation = .vertical
        chatColumn.alignment = .leading
        chatColumn.spacing = 8
        promptScroll.widthAnchor.constraint(equalTo: chatColumn.widthAnchor).isActive = true
        replyScroll.widthAnchor.constraint(equalTo: chatColumn.widthAnchor).isActive = true
        modelRow.widthAnchor.constraint(equalTo: chatColumn.widthAnchor).isActive = true
        let chatBox = GroupBox()
        chatBox.addRow(chatColumn)

        let body = NSStackView(views: [
            SectionView(title: "本地网关", content: gatewayBox, footer: "启动后，OpenAI 兼容地址是 http://127.0.0.1:端口/v1。模型只有 grok-bot-default 和 grok-bot-automation。"),
            gatewayStatus,
            SectionView(title: "本机登录", content: accountBox, footer: "密钥来自 Grok Bot 自己的钥匙串，完整显示，可以复制。"),
            SectionView(title: "助手", content: agentBox),
            SectionView(title: "试一句", content: chatBox, footer: "发给当前账号里名为「日常问答」的助手；没有这个名字就用第一个。"),
            status,
        ])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 22
        renderAccount()
        renderAgents()
        renderGateway()
        return PageChrome.scroll(
            title: "Grok Bot",
            subtitle: "把本机 Grok Bot 登录转成可查看的助手列表，以及一个本机 OpenAI 兼容网关。",
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
        status.set("正在读取 Grok Bot…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let info = try self.backend.grokStatus()
                let portOwner = info.gateway?.running == true ? nil : self.backend.grokPortOwner()
                DispatchQueue.main.async {
                    self.busy = false
                    self.statusInfo = info
                    self.renderAccount()
                    self.renderAgents()
                    self.renderGateway(portOwner: portOwner)
                    if self.portField.currentEditor() == nil {
                        self.portField.stringValue = String(info.gateway?.port ?? self.backend.grokGatewayPort)
                    }
                    self.syncControls()
                    if let error = info.error, info.token == nil {
                        self.status.set("❌ \(error)")
                    } else if let agentsError = info.agentsError {
                        self.status.set("⚠️ 登录可读，助手列表失败：\(agentsError)")
                    } else {
                        let count = info.agents?.count ?? 0
                        self.status.set(info.gateway?.running == true ? "✔ 已读取，网关正在运行 · \(count) 个助手" : "✔ 已读取 · \(count) 个助手")
                    }
                    self.onDetail?(self.sidebarDetail())
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.status.set("❌ \(error.localizedDescription)")
                }
            }
        }
    }

    @objc private func toggleGateway() {
        guard !busy else { return }
        let running = gatewayRunning || backend.grokGatewayIsRunning()
        busy = true
        syncControls()
        gatewayStatus.set(running ? "正在停止网关…" : "正在启动网关…", tone: .info)
        status.set(running ? "正在停止网关…" : "正在启动网关…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                if running {
                    self.backend.stopGrokGateway()
                    Thread.sleep(forTimeInterval: 0.3)
                    DispatchQueue.main.async {
                        self.busy = false
                        self.gatewayRunning = false
                        self.syncControls()
                        self.gatewayStatus.set("网关已停止", tone: .info)
                        self.status.set("已停止 Grok Bot 网关")
                        self.refresh()
                    }
                } else {
                    try self.backend.startGrokGateway()
                    DispatchQueue.main.async {
                        self.busy = false
                        self.gatewayRunning = true
                        self.syncControls()
                        self.gatewayStatus.set("网关已启动 · \(self.backend.grokGatewayBaseURL)", tone: .success)
                        self.status.set("网关已启动，正在读取助手…")
                        self.refresh()
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.gatewayRunning = false
                    self.syncControls()
                    self.gatewayStatus.set(error.localizedDescription, tone: .error)
                    self.status.set("❌ \(error.localizedDescription)")
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
        guard port != backend.grokGatewayPort else {
            gatewayStatus.set("端口没有变化 · \(port)", tone: .info)
            return
        }
        let wasRunning = gatewayRunning || backend.grokGatewayIsRunning()
        busy = true
        syncControls()
        gatewayStatus.set("正在切换端口…", tone: .info)
        UserDefaults.standard.set(port, forKey: "grokPort")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            if wasRunning {
                self.backend.stopGrokGateway()
                Thread.sleep(forTimeInterval: 0.3)
            }
            DispatchQueue.main.async {
                self.busy = false
                self.gatewayRunning = false
                self.syncControls()
                if wasRunning {
                    self.gatewayStatus.set("端口已改为 \(port)，网关已停止，请重新启动", tone: .info)
                } else {
                    self.gatewayStatus.set("端口已改为 \(port)，点「启动网关」使用新地址", tone: .info)
                }
                self.refresh()
            }
        }
    }

    @objc private func send() {
        let text = promptView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            status.set("❌ 先写一句要发给 Grok Bot 的话")
            return
        }
        guard !busy else { return }
        busy = true
        syncControls()
        replyView.string = ""
        status.set("正在等待 Grok Bot…")
        let model = modelPopup.titleOfSelectedItem ?? "grok-bot-default"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.grokChat(model: model, text: text)
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.replyView.string = result.reply ?? ""
                    let ms = result.elapsedMs.map { " · \($0) ms" } ?? ""
                    self.status.set("✔ \(result.model ?? model)\(ms)")
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.status.set("❌ \(error.localizedDescription)")
                }
            }
        }
    }

    private func syncControls() {
        gatewayButton.isEnabled = !busy
        portField.isEnabled = !busy
        portApplyButton.isEnabled = !busy
        sendButton.isEnabled = !busy
        gatewayButton.title = gatewayRunning ? "停止网关" : "启动网关"
        if busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
    }

    private func renderGateway(portOwner: String? = nil) {
        let port = statusInfo?.gateway?.port ?? backend.grokGatewayPort
        let base = statusInfo?.gateway?.baseUrl ?? "http://127.0.0.1:\(port)/v1"
        gatewayRunning = statusInfo?.gateway?.running == true || backend.grokGatewayIsRunning()
        if gatewayRunning {
            gatewayStatus.set("网关运行中 · \(base)", tone: .success)
        } else if let portOwner, !portOwner.isEmpty {
            gatewayStatus.set("端口 \(port) 被 \(portOwner) 占用，网关无法启动。请换一个端口。", tone: .error)
        } else {
            gatewayStatus.set("网关未启动 · 端口 \(port)", tone: .info)
        }
    }

    private func renderAccount() {
        var rows: [NSView] = []
        if let email = statusInfo?.email, !email.isEmpty {
            rows.append(SettingRow(title: "账号", accessory: label(email)))
        }
        if let token = statusInfo?.token, !token.isEmpty {
            rows.append(labeledSecret("访问令牌", token))
        }
        if let token = statusInfo?.refreshToken, !token.isEmpty {
            rows.append(labeledSecret("刷新令牌", token))
        }
        if let machine = statusInfo?.machineId, !machine.isEmpty {
            rows.append(labeledSecret("机器标识", machine))
        }
        let base = statusInfo?.gateway?.baseUrl ?? backend.grokGatewayBaseURL
        rows.append(labeledSecret("网关地址", base, masked: false))
        if rows.isEmpty {
            rows.append(label("还没有读到 Grok Bot 登录。"))
        }
        accountBox.setRows(rows)
    }

    private func renderAgents() {
        let agents = statusInfo?.agents ?? []
        if agents.isEmpty {
            agentBox.setRows([label("没有助手，或还没刷新。")])
            return
        }
        agentBox.setRows(agents.map { agent in
            let title = NSTextField(labelWithString: agent.name)
            title.font = .systemFont(ofSize: 13, weight: .medium)
            let meta = [agent.kind, agent.description].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            var views: [NSView] = [title]
            if !meta.isEmpty {
                let detail = NSTextField(wrappingLabelWithString: meta)
                detail.font = .systemFont(ofSize: 12)
                detail.textColor = .secondaryLabelColor
                detail.preferredMaxLayoutWidth = 460
                views.append(detail)
            }
            let agentId = agent.legacyAgentId ?? agent.id
            if !agentId.isEmpty {
                views.append(CopyableSecret(text: agentId, expands: true))
            }
            let column = NSStackView(views: views)
            column.orientation = .vertical
            column.alignment = .leading
            column.spacing = 4
            for view in column.arrangedSubviews where view !== title {
                view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
            }
            return column
        })
    }

    private func labeledSecret(_ title: String, _ value: String, masked: Bool = true) -> NSView {
        let heading = NSTextField(labelWithString: title)
        heading.font = .systemFont(ofSize: 12, weight: .semibold)
        heading.textColor = .secondaryLabelColor
        let secret = CopyableSecret(text: value, expands: true, masked: masked)
        let column = NSStackView(views: [heading, secret])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        secret.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        return column
    }

    private func label(_ text: String) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: 12)
        field.textColor = .secondaryLabelColor
        return field
    }
}
