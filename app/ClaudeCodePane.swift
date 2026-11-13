// Claude 供应商页：Code 模式写 ~/.claude/settings.json；Desktop 模式写 Claude-3p 配置并重启应用。
import AppKit

final class ClaudeProvidersPane: NSView, NSTableViewDataSource, NSTableViewDelegate {
    enum Mode {
        case code
        case desktop
    }

    private struct Row {
        let id: String
        let name: String
        let host: String?
        let model: String?
        let note: String?
    }

    private let backend = Backend.shared
    private let mode: Mode
    private var rows: [Row] = []
    private var currentId: String?
    private var busy = false
    private var syncingRemote = false
    private var envFingerprint: String?
    private var watchTimer: Timer?
    private var didLaunchSync = false
    private let defaults = UserDefaults.standard
    private let autoSyncCheck = NSButton(checkboxWithTitle: "自动同步远端", target: nil, action: nil)

    // Claude Desktop 专用：显示当前是谁在接管（CC Switch / Magpie）。
    private let managerBanner = NSView()
    private let managerIcon = NSImageView()
    private let managerTitle = NSTextField(labelWithString: "")
    private let managerDetail = NSTextField(labelWithString: "")
    private let handoffButton = NSButton(title: "", target: nil, action: nil)
    private var desktopManager: String?
    private var magpieProfileExists = false
    private var managerTimer: Timer?

    private let headerLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "读取中…")
    private let table = NSTableView()
    private let scroll = ProviderScrollView()
    private let status = StatusLine()
    private let spinner = NSProgressIndicator()
    private let refreshButton = NSButton(title: "刷新", target: nil, action: nil)
    private let syncButton = NSButton(title: "同步到远端", target: nil, action: nil)

    init(mode: Mode) {
        self.mode = mode
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private var titleText: String {
        mode == .code ? "Claude Code" : "Claude Desktop"
    }

    private func build() {
        headerLabel.stringValue = titleText
        headerLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        detailLabel.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.lineBreakMode = .byTruncatingMiddle
        detailLabel.maximumNumberOfLines = 2

        let caption = NSTextField(labelWithString: "当前供应商")
        caption.font = .systemFont(ofSize: 10.5, weight: .semibold)
        caption.textColor = .tertiaryLabelColor

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        refreshButton.bezelStyle = .inline
        refreshButton.isBordered = false
        refreshButton.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "刷新")
        refreshButton.imagePosition = .imageOnly
        refreshButton.contentTintColor = .secondaryLabelColor
        refreshButton.toolTip = "刷新列表"
        refreshButton.target = self
        refreshButton.action = #selector(refreshNow)

        syncButton.bezelStyle = .rounded
        syncButton.image = NSImage(systemSymbolName: "icloud.and.arrow.up", accessibilityDescription: "同步到远端")
        syncButton.imagePosition = .imageLeading
        syncButton.bezelColor = .controlAccentColor
        syncButton.target = self
        syncButton.action = #selector(syncRemotesNow)
        syncButton.isHidden = mode != .code

        autoSyncCheck.controlSize = .small
        autoSyncCheck.font = .systemFont(ofSize: 11)
        autoSyncCheck.isHidden = mode != .code
        autoSyncCheck.target = self
        autoSyncCheck.action = #selector(autoSyncToggled)
        let autoSyncOn = defaults.object(forKey: "claudeAutoSyncRemote") as? Bool ?? true
        autoSyncCheck.state = autoSyncOn ? .on : .off

        table.headerView = nil
        table.rowHeight = 52
        table.selectionHighlightStyle = .none
        table.backgroundColor = .clear
        table.intercellSpacing = NSSize(width: 0, height: 0)
        table.style = .plain
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("claude"))
        column.resizingMask = .autoresizingMask
        column.width = 100
        table.addTableColumn(column)
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(rowClicked)

        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.contentView.drawsBackground = false
        scroll.scrollerStyle = .overlay
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 284).isActive = true

        let titleColumn = NSStackView(views: [caption, headerLabel, detailLabel])
        titleColumn.orientation = .vertical
        titleColumn.alignment = .leading
        titleColumn.spacing = 2
        titleColumn.setCustomSpacing(10, after: headerLabel)

        let headerRow = NSStackView(views: [titleColumn, spacer(), spinner, autoSyncCheck, syncButton, refreshButton])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 10

        // 接管方横幅：Magpie 在接管时用橙色提示，CC Switch 用绿色。
        managerBanner.wantsLayer = true
        managerBanner.layer?.cornerRadius = 10
        managerBanner.layer?.borderWidth = 1
        managerBanner.translatesAutoresizingMaskIntoConstraints = false
        managerBanner.isHidden = mode != .desktop

        managerIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 15, weight: .medium)
        managerIcon.imageScaling = .scaleProportionallyDown
        managerIcon.translatesAutoresizingMaskIntoConstraints = false
        managerIcon.widthAnchor.constraint(equalToConstant: 20).isActive = true
        managerIcon.heightAnchor.constraint(equalToConstant: 20).isActive = true

        managerTitle.font = .systemFont(ofSize: 12, weight: .semibold)
        managerTitle.lineBreakMode = .byTruncatingTail
        managerDetail.font = .systemFont(ofSize: 11)
        managerDetail.textColor = .secondaryLabelColor
        managerDetail.lineBreakMode = .byTruncatingTail
        managerDetail.maximumNumberOfLines = 2

        let managerText = NSStackView(views: [managerTitle, managerDetail])
        managerText.orientation = .vertical
        managerText.alignment = .leading
        managerText.spacing = 2
        managerText.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        handoffButton.bezelStyle = .rounded
        handoffButton.controlSize = .small
        handoffButton.target = self
        handoffButton.action = #selector(handoffTapped)

        let managerRow = NSStackView(views: [managerIcon, managerText, spacer(), handoffButton])
        managerRow.orientation = .horizontal
        managerRow.alignment = .centerY
        managerRow.spacing = 10
        managerRow.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        managerRow.translatesAutoresizingMaskIntoConstraints = false
        managerBanner.addSubview(managerRow)
        NSLayoutConstraint.activate([
            managerRow.leadingAnchor.constraint(equalTo: managerBanner.leadingAnchor),
            managerRow.trailingAnchor.constraint(equalTo: managerBanner.trailingAnchor),
            managerRow.topAnchor.constraint(equalTo: managerBanner.topAnchor),
            managerRow.bottomAnchor.constraint(equalTo: managerBanner.bottomAnchor),
        ])

        let group = GroupBox()
        group.addRow(scroll)

        let stack = NSStackView(views: [headerRow, managerBanner, group, status])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            headerRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            managerBanner.widthAnchor.constraint(equalTo: stack.widthAnchor),
            group.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    private func spacer() -> NSView {
        let view = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return view
    }

    func onShow() {
        refresh()
        startWatching()
    }

    deinit {
        watchTimer?.invalidate()
        managerTimer?.invalidate()
    }

    /// Claude Code：每 3 秒比对 settings.json 指纹，并在配置变化时同步远端。
    /// Claude Desktop：每 5 秒检查 configLibrary 的 appliedId，识别 cc-switch / Magpie 接管切换。
    /// App 启动时就会调用（不要求先打开本页），第一次比对时顺带把远端对齐一次。
    func startWatching() {
        if mode == .desktop {
            guard managerTimer == nil else { return }
            showDesktopManager(readDesktopManagerState())
            let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in self?.desktopWatchTick() }
            RunLoop.main.add(timer, forMode: .common)
            managerTimer = timer
            return
        }
        guard watchTimer == nil else { return }
        let timer = Timer(timeInterval: 3, repeats: true) { [weak self] _ in self?.watchTick() }
        RunLoop.main.add(timer, forMode: .common)
        watchTimer = timer
        // App 启动时先对齐一次远端（本机为准），之后每 3 秒跟着本机配置变化走。
        if autoSyncCheck.state == .on, !didLaunchSync {
            didLaunchSync = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self, !self.syncingRemote else { return }
                self.syncRemotes(auto: true)
            }
        }
    }

    @objc private func autoSyncToggled() {
        defaults.set(autoSyncCheck.state == .on, forKey: "claudeAutoSyncRemote")
        status.set(autoSyncCheck.state == .on
            ? "已开启：切换供应商或在 cc-switch 里改动后自动同步远端"
            : "已关闭自动同步远端，只在本机生效")
    }

    @objc private func watchTick() {
        guard mode == .code, !busy, !syncingRemote else { return }
        guard let fingerprint = settingsFingerprint() else { return }
        guard let previous = envFingerprint else {
            envFingerprint = fingerprint
            return
        }
        guard previous != fingerprint else { return }
        envFingerprint = fingerprint
        status.set("检测到 Claude Code 配置变化，正在刷新…")
        refresh()
        if autoSyncCheck.state == .on { syncRemotes(auto: true) }
    }

    /// 只取 env（端点 / 密钥 / 模型档位）做指纹，不落盘、不打印。
    private func settingsFingerprint() -> String? {
        let path = NSString(string: "~/.claude/settings.json").expandingTildeInPath
        guard let data = FileManager.default.contents(atPath: path),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let env = root["env"] as? [String: Any] else { return nil }
        return env.keys.sorted().map { "\($0)=\(env[$0] ?? "")" }.joined(separator: "|")
    }

    @objc private func refreshNow() { refresh() }

    private func refresh() {
        guard !busy else { return }
        busy = true
        spinner.startAnimation(nil)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                if self.mode == .code {
                    let list = try self.backend.claudeList()
                    let status = try? self.backend.claudeCurrent()
                    let rows = (list.providers ?? []).map { Row(id: $0.id, name: $0.name, host: $0.host, model: $0.model, note: nil) }
                    DispatchQueue.main.async {
                        self.apply(rows: rows, currentId: list.currentId, detail: self.codeDetail(status: status, list: list))
                    }
                } else {
                    let list = try self.backend.claudeDesktopList()
                    let rows = (list.providers ?? []).map { p in
                        Row(
                            id: p.id,
                            name: p.name,
                            host: p.host,
                            model: nil,
                            note: p.proxyMode == true ? "走 cc-switch 代理" : (p.official == true ? "官方" : nil)
                        )
                    }
                    let manager = self.readDesktopManagerState()
                    let detail = "接管 \(self.managerText(manager.kind)) · 实际网关 \(list.applied?.host ?? "-")"
                    DispatchQueue.main.async {
                        self.showDesktopManager(manager)
                        self.apply(rows: rows, currentId: list.currentId, detail: detail)
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.spinner.stopAnimation(nil)
                    self.status.set("❌ \(error.localizedDescription)")
                }
            }
        }
    }

    private func codeDetail(status: ClaudeCurrentResult?, list: ClaudeListResult) -> String {
        let current = (list.providers ?? []).first { $0.id == list.currentId }
        let host = status?.host ?? current?.host ?? "-"
        let model = status?.model ?? current?.model ?? "-"
        return "\(host)   model \(model)"
    }

    private func apply(rows: [Row], currentId: String?, detail: String) {
        self.rows = rows
        self.currentId = currentId
        self.table.reloadData()
        self.busy = false
        self.spinner.stopAnimation(nil)
        if mode == .code { envFingerprint = settingsFingerprint() }
        self.detailLabel.stringValue = rows.isEmpty ? "cc-switch 里还没有对应供应商" : detail
        if mode == .desktop, desktopManager == "magpie" {
            self.headerLabel.stringValue = "Magpie 接管中"
        } else if let current = rows.first(where: { $0.id == currentId }) {
            self.headerLabel.stringValue = current.name
        } else {
            self.headerLabel.stringValue = titleText
        }
    }

    @objc private func syncRemotesNow() { syncRemotes(auto: false) }

    private func syncRemotes(auto: Bool) {
        guard !syncingRemote else { return }
        syncingRemote = true
        spinner.startAnimation(nil)
        status.set(auto ? "检测到配置变化，正在同步到远端…" : "正在同步到远端…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.claudeSyncRemote()
                let hosts = result.hosts ?? []
                let failed = hosts.filter { $0.ok == false }
                let changed = hosts.filter { $0.changed == true }.count
                let text = failed.isEmpty
                    ? "✔ 已同步到 \(hosts.count) 台远端（\(changed) 台有更新）"
                    : "⚠️ \(hosts.count - failed.count) 台成功，\(failed.count) 台失败：\(failed.compactMap { $0.label }.joined(separator: "、"))"
                DispatchQueue.main.async {
                    self.syncingRemote = false
                    self.spinner.stopAnimation(nil)
                    self.status.set(text)
                }
            } catch {
                DispatchQueue.main.async {
                    self.syncingRemote = false
                    self.spinner.stopAnimation(nil)
                    self.status.set("❌ 同步失败：\(error.localizedDescription)")
                }
            }
        }
    }

    @objc private func rowClicked() {
        let row = table.clickedRow >= 0 ? table.clickedRow : table.selectedRow
        guard row >= 0, row < rows.count, !busy else { return }
        let item = rows[row]
        let desktopUnderMagpie = mode == .desktop && desktopManager == "magpie"
        guard item.id != currentId || desktopUnderMagpie else {
            status.set("已经是当前供应商")
            return
        }
        if desktopUnderMagpie, !confirmDesktopTakeover(item.name) { return }
        let force = desktopUnderMagpie
        busy = true
        spinner.startAnimation(nil)
        status.set(desktopUnderMagpie ? "正在从 Magpie 切回 \(item.name)…" : "正在切换到 \(item.name)…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                if self.mode == .code {
                    let result = try self.backend.claudeSwitch(item.id)
                    DispatchQueue.main.async {
                        if let error = result.error, !error.isEmpty {
                            self.finish(error: error)
                        } else {
                            self.finishOk("✔ 已切换到 \(result.provider?.name ?? item.name)：新开 Claude Code 会话时生效")
                        }
                    }
                } else {
                    let result = try self.backend.claudeDesktopSwitch(item.id, force: force)
                    DispatchQueue.main.async {
                        if let error = result.error, !error.isEmpty {
                            self.finish(error: error)
                        } else {
                            self.finishOk("✔ 已切换到 \(result.provider?.name ?? item.name)，Claude Desktop 已重新打开")
                        }
                    }
                }
            } catch {
                DispatchQueue.main.async { self.finish(error: error.localizedDescription) }
            }
        }
    }

    /// 必须先释放 busy 再刷新，否则 refresh 会被自己的 guard 挡掉，页面就“点不动”了。
    private func finishOk(_ text: String) {
        busy = false
        spinner.stopAnimation(nil)
        status.set(text)
        refresh()
    }

    private func finish(error: String) {
        busy = false
        spinner.stopAnimation(nil)
        status.set("❌ \(error)")
    }

    // MARK: - 接管方（CC Switch / Magpie）

    private struct DesktopManagerState {
        let kind: String
        let name: String
        let model: String?
        let profileExists: Bool
    }

    /// 直接读 Claude-3p 的 configLibrary/_meta.json：appliedId 指向谁，谁就在接管。
    private func readDesktopManagerState() -> DesktopManagerState {
        let base = ("~/Library/Application Support/Claude-3p/configLibrary" as NSString).expandingTildeInPath
        let metaURL = URL(fileURLWithPath: base).appendingPathComponent("_meta.json")
        var kind = "none"
        var name = "未设置"
        if let data = try? Data(contentsOf: metaURL),
           let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let applied = root["appliedId"] as? String
            let entries = root["entries"] as? [[String: Any]] ?? []
            name = applied == nil ? "未设置" : "未知配置"
            if let entry = entries.first(where: { ($0["id"] as? String) == applied }),
               let entryName = entry["name"] as? String, !entryName.isEmpty {
                name = entryName
            }
            switch applied {
            case "00000000-0000-4000-8000-000000157210":
                kind = "cc-switch"
            case "00000000-0000-4000-8000-6d6167706965":
                kind = "magpie"
            case nil:
                kind = "none"
            default:
                let lower = name.lowercased()
                if lower.contains("magpie") {
                    kind = "magpie"
                } else if lower.contains("cc switch") || lower.contains("cc-switch") {
                    kind = "cc-switch"
                } else {
                    kind = "unknown"
                }
            }
        }

        let modelPath = ("~/.config/magpie/claude-desktop.model" as NSString).expandingTildeInPath
        let model = (try? String(contentsOfFile: modelPath, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let magpieProfile = URL(fileURLWithPath: base)
            .appendingPathComponent("00000000-0000-4000-8000-6d6167706965.json").path
        return DesktopManagerState(
            kind: kind,
            name: name,
            model: (model?.isEmpty == false) ? model : nil,
            profileExists: FileManager.default.fileExists(atPath: magpieProfile)
        )
    }

    private func managerText(_ kind: String?) -> String {
        switch kind {
        case "magpie": return "Magpie"
        case "cc-switch": return "CC Switch"
        case "none": return "未设置"
        default: return "未知"
        }
    }

    private func showDesktopManager(_ state: DesktopManagerState) {
        guard mode == .desktop else { return }
        let changed = state.kind != desktopManager
        desktopManager = state.kind
        magpieProfileExists = state.profileExists

        managerBanner.isHidden = false
        switch state.kind {
        case "magpie":
            managerBanner.layer?.backgroundColor = NSColor.systemOrange.withAlphaComponent(0.10).cgColor
            managerBanner.layer?.borderColor = NSColor.systemOrange.withAlphaComponent(0.30).cgColor
            managerIcon.image = NSImage(systemSymbolName: "bird", accessibilityDescription: "Magpie")
            managerIcon.contentTintColor = .systemOrange
            managerTitle.stringValue = "Claude Desktop 现在由 Magpie 接管"
            let tail = "点一行会先确认，再切回 CC Switch。"
            managerDetail.stringValue = state.model.map { "Magpie 模型 \($0)。\(tail)" } ?? "cc-switch 的供应商只是记录，\(tail)"
            handoffButton.title = "切回 CC Switch"
            handoffButton.isHidden = currentId == nil
        case "cc-switch":
            managerBanner.layer?.backgroundColor = NSColor.systemGreen.withAlphaComponent(0.08).cgColor
            managerBanner.layer?.borderColor = NSColor.systemGreen.withAlphaComponent(0.25).cgColor
            managerIcon.image = NSImage(systemSymbolName: "switch.2", accessibilityDescription: "CC Switch")
            managerIcon.contentTintColor = .systemGreen
            managerTitle.stringValue = "Claude Desktop 由 CC Switch 管理"
            managerDetail.stringValue = "点下面的供应商切换；也可以交给 Magpie 的 agent 接管。"
            handoffButton.title = "交给 Magpie"
            handoffButton.isHidden = !state.profileExists
        default:
            managerBanner.layer?.backgroundColor = NSColor.secondaryLabelColor.withAlphaComponent(0.06).cgColor
            managerBanner.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.35).cgColor
            managerIcon.image = NSImage(systemSymbolName: "questionmark.circle", accessibilityDescription: "未知接管方")
            managerIcon.contentTintColor = .secondaryLabelColor
            managerTitle.stringValue = "接管方未知"
            managerDetail.stringValue = state.name == "未设置"
                ? "configLibrary 里还没有 appliedId，Claude Desktop 可能还没进第三方模式。"
                : "configLibrary 里的接管方「\(state.name)」无法识别。"
            handoffButton.title = "交给 Magpie"
            handoffButton.isHidden = !state.profileExists
        }
        if changed { table.reloadData() }
    }

    private func desktopWatchTick() {
        guard mode == .desktop, !busy else { return }
        let state = readDesktopManagerState()
        let changed = state.kind != desktopManager
        showDesktopManager(state)
        if changed, state.kind != "unknown" {
            status.set("检测到 Claude Desktop 接管方变化：\(managerText(state.kind))", tone: .info)
            refresh()
        }
    }

    private func confirmDesktopTakeover(_ name: String) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Claude Desktop 现在由 Magpie 接管"
        alert.informativeText = "继续会改用 CC Switch 的「\(name)」，并重启 Claude Desktop；Magpie 的 agent 接管会中断。"
        alert.addButton(withTitle: "切回 CC Switch")
        alert.addButton(withTitle: "取消")
        return alert.runModal() == .alertFirstButtonReturn
    }

    @objc private func handoffTapped() {
        guard mode == .desktop, !busy else { return }
        if desktopManager == "magpie" {
            guard let id = currentId, let item = rows.first(where: { $0.id == id }) else {
                status.set("cc-switch 里还没有可用的当前供应商，先在 cc-switch 里选一个", tone: .warning)
                return
            }
            guard confirmDesktopTakeover(item.name) else { return }
            busy = true
            spinner.startAnimation(nil)
            status.set("正在从 Magpie 切回 \(item.name)…")
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self else { return }
                do {
                    let result = try self.backend.claudeDesktopSwitch(item.id, force: true)
                    DispatchQueue.main.async {
                        if let error = result.error, !error.isEmpty {
                            self.finish(error: error)
                        } else {
                            self.finishOk("✔ 已从 Magpie 切回 \(result.provider?.name ?? item.name)，Claude Desktop 已重新打开")
                        }
                    }
                } catch {
                    DispatchQueue.main.async { self.finish(error: error.localizedDescription) }
                }
            }
            return
        }

        guard magpieProfileExists else {
            status.set("Magpie 还没有 Claude Desktop 配置，先在 Magpie 里接管一次", tone: .warning)
            return
        }
        let alert = NSAlert()
        alert.messageText = "交给 Magpie 接管？"
        alert.informativeText = "Claude Desktop 会重新打开，网关改由 Magpie 的 agent 接管；cc-switch 的供应商记录会保留。"
        alert.addButton(withTitle: "交给 Magpie")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        busy = true
        spinner.startAnimation(nil)
        status.set("正在交给 Magpie 接管…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.claudeDesktopUseMagpie()
                DispatchQueue.main.async {
                    if let error = result.error, !error.isEmpty {
                        self.finish(error: error)
                    } else {
                        let model = result.manager?.magpieModel.map { "（\($0)）" } ?? ""
                        self.finishOk("✔ 已交给 Magpie 接管\(model)，Claude Desktop 已重新打开")
                    }
                }
            } catch {
                DispatchQueue.main.async { self.finish(error: error.localizedDescription) }
            }
        }
    }

    // MARK: - 表格

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let view = ProviderRowView()
        view.showTopSeparator = row > 0
        return view
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat { 52 }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < rows.count else { return nil }
        let item = rows[row]
        let isCurrent = item.id == currentId

        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        dot.layer?.backgroundColor = (isCurrent ? NSColor.systemGreen : NSColor.clear).cgColor
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 8).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 8).isActive = true

        let name = NSTextField(labelWithString: item.name)
        name.font = .systemFont(ofSize: 13.5, weight: isCurrent ? .semibold : .regular)
        name.lineBreakMode = .byTruncatingTail

        var parts: [String] = []
        if let host = item.host, !host.isEmpty { parts.append(host) }
        if let model = item.model, !model.isEmpty { parts.append(model) }
        let detail = NSTextField(labelWithString: parts.isEmpty ? "-" : parts.joined(separator: "  ·  "))
        detail.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingMiddle

        let texts = NSStackView(views: [name, detail])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 3
        texts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        var trailing: [NSView] = []
        if let note = item.note {
            trailing.append(PageChrome.tag(note, tint: .systemOrange))
        }
        if isCurrent {
            if mode == .desktop, desktopManager == "magpie" {
                trailing.append(PageChrome.tag("cc-switch 记录"))
            } else {
                trailing.append(PageChrome.tag("当前", tint: .controlAccentColor))
            }
        }
        var rowViews: [NSView] = [dot, texts]
        if !trailing.isEmpty {
            rowViews.append(NSView())
            rowViews.append(contentsOf: trailing)
        }
        let rowStack = NSStackView(views: rowViews)
        rowStack.orientation = .horizontal
        rowStack.alignment = .centerY
        rowStack.spacing = 8
        rowStack.edgeInsets = NSEdgeInsets(top: 2, left: 12, bottom: 2, right: 12)
        rowStack.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(rowStack)
        NSLayoutConstraint.activate([
            rowStack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            rowStack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            rowStack.topAnchor.constraint(equalTo: container.topAnchor),
            rowStack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        return container
    }
}
