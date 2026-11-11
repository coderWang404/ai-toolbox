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
    private let defaults = UserDefaults.standard
    private let autoSyncCheck = NSButton(checkboxWithTitle: "自动同步远端", target: nil, action: nil)

    private let headerLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "读取中…")
    private let table = NSTableView()
    private let scroll = NSScrollView()
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
        headerLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        detailLabel.font = .systemFont(ofSize: 12)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.lineBreakMode = .byTruncatingMiddle
        detailLabel.maximumNumberOfLines = 2

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        refreshButton.bezelStyle = .rounded
        refreshButton.target = self
        refreshButton.action = #selector(refreshNow)
        syncButton.bezelStyle = .rounded
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
        table.rowHeight = 44
        table.selectionHighlightStyle = .none
        table.backgroundColor = .clear
        table.intercellSpacing = NSSize(width: 0, height: 0)
        table.style = .plain
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("claude"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(rowClicked)

        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.scrollerStyle = .overlay
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 236).isActive = true

        let headerRow = NSStackView(views: [headerLabel, spacer(), spinner, autoSyncCheck, syncButton, refreshButton])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 8

        let group = GroupBox()
        group.addRow(scroll)

        let stack = NSStackView(views: [headerRow, detailLabel, group, status])
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
            detailLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
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
        startWatchIfNeeded()
    }

    deinit { watchTimer?.invalidate() }

    /// 本地 cc-switch / 手动改动 ~/.claude/settings.json 时，自动刷新列表并同步远端。
    private func startWatchIfNeeded() {
        guard mode == .code, watchTimer == nil else { return }
        let timer = Timer(timeInterval: 3, repeats: true) { [weak self] _ in self?.watchTick() }
        RunLoop.main.add(timer, forMode: .common)
        watchTimer = timer
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
                    let detail = "实际网关：\(list.applied?.host ?? "-")"
                    DispatchQueue.main.async {
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
        if let current = rows.first(where: { $0.id == currentId }) {
            self.headerLabel.stringValue = "当前：\(current.name)"
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
        guard item.id != currentId else {
            status.set("已经是当前供应商")
            return
        }
        busy = true
        spinner.startAnimation(nil)
        status.set("正在切换到 \(item.name)…")
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
                    let result = try self.backend.claudeDesktopSwitch(item.id)
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

    // MARK: - 表格

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

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
        name.font = .systemFont(ofSize: 13, weight: isCurrent ? .semibold : .regular)
        name.lineBreakMode = .byTruncatingTail

        var parts: [String] = []
        if let host = item.host, !host.isEmpty { parts.append(host) }
        if let model = item.model, !model.isEmpty { parts.append("model \(model)") }
        if let note = item.note { parts.append(note) }
        let detail = NSTextField(labelWithString: parts.isEmpty ? "-" : parts.joined(separator: "   "))
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingMiddle

        let texts = NSStackView(views: [name, detail])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 2

        let rowStack = NSStackView(views: [dot, texts])
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
        return container
    }
}
