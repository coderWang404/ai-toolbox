// Claude Code 供应商页：数据来自 cc-switch（app_type='claude'），
// 点击切换会写入 ~/.claude/settings.json，并同步 cc-switch 的当前标记。
import AppKit

final class ClaudeCodePane: NSView, NSTableViewDataSource, NSTableViewDelegate {
    private let backend = Backend.shared
    private var providers: [ClaudeProviderSummary] = []
    private var currentId: String?
    private var busy = false

    private let headerLabel = NSTextField(labelWithString: "Claude Code")
    private let detailLabel = NSTextField(labelWithString: "读取中…")
    private let providerTable = NSTableView()
    private let tableScroll = NSScrollView()
    private let status = StatusLine()
    private let spinner = NSProgressIndicator()
    private let refreshButton = NSButton(title: "刷新", target: nil, action: nil)

    convenience init() {
        self.init(frame: .zero)
        build()
    }

    private func build() {
        wantsLayer = true

        headerLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        detailLabel.font = .systemFont(ofSize: 12)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.lineBreakMode = .byTruncatingMiddle
        detailLabel.maximumNumberOfLines = 2

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        refreshButton.bezelStyle = .rounded
        refreshButton.controlSize = .regular
        refreshButton.target = self
        refreshButton.action = #selector(refreshNow)

        providerTable.headerView = nil
        providerTable.rowHeight = 44
        providerTable.selectionHighlightStyle = .none
        providerTable.backgroundColor = .clear
        providerTable.intercellSpacing = NSSize(width: 0, height: 0)
        providerTable.style = .plain
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("claude"))
        column.resizingMask = .autoresizingMask
        providerTable.addTableColumn(column)
        providerTable.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        providerTable.dataSource = self
        providerTable.delegate = self
        providerTable.target = self
        providerTable.action = #selector(rowClicked)

        tableScroll.documentView = providerTable
        tableScroll.hasVerticalScroller = true
        tableScroll.drawsBackground = false
        tableScroll.scrollerStyle = .overlay
        tableScroll.translatesAutoresizingMaskIntoConstraints = false
        tableScroll.heightAnchor.constraint(equalToConstant: 236).isActive = true

        let headerRow = NSStackView(views: [headerLabel, flexibleSpacer(), spinner, refreshButton])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 8

        let group = GroupBox()
        group.addRow(tableScroll)

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

    private func flexibleSpacer() -> NSView {
        let spacer = NSView()
        spacer.translatesAutoresizingMaskIntoConstraints = false
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return spacer
    }

    func onShow() { refresh() }

    @objc private func refreshNow() { refresh() }

    private func refresh() {
        guard !busy else { return }
        busy = true
        spinner.startAnimation(nil)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.claudeList()
                let status = try? self.backend.claudeCurrent()
                DispatchQueue.main.async {
                    self.providers = result.providers ?? []
                    self.currentId = result.currentId
                    self.providerTable.reloadData()
                    self.busy = false
                    self.spinner.stopAnimation(nil)
                    self.renderHeader(status)
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

    private func renderHeader(_ status: ClaudeCurrentResult?) {
        let current = providers.first { $0.id == currentId }
        if let current {
            headerLabel.stringValue = "当前：\(current.name)"
            detailLabel.stringValue = "\(status?.host ?? current.host ?? "-")   model \(status?.model ?? current.model ?? "-")"
        } else {
            headerLabel.stringValue = "Claude Code"
            detailLabel.stringValue = "cc-switch 里还没有 Claude Code 供应商"
        }
        if let status, status.matchesProvider == false {
            statusText("⚠️ 实际生效的端点与 cc-switch 记录不一致，可能被手动改过")
        }
    }

    private func statusText(_ text: String) {
        status.set(text)
    }

    @objc private func rowClicked() {
        let row = providerTable.clickedRow >= 0 ? providerTable.clickedRow : providerTable.selectedRow
        guard row >= 0, row < providers.count, !busy else { return }
        let provider = providers[row]
        guard provider.id != currentId else {
            statusText("已经是当前供应商")
            return
        }
        busy = true
        spinner.startAnimation(nil)
        status.set("正在切换到 \(provider.name)…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.claudeSwitch(provider.id)
                DispatchQueue.main.async {
                    self.busy = false
                    self.spinner.stopAnimation(nil)
                    if let error = result.error, !error.isEmpty {
                        self.status.set("❌ \(error)")
                        return
                    }
                    self.status.set("✔ 已切换到 \(result.provider?.name ?? provider.name)：新开 Claude Code 会话时生效")
                    self.refresh()
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

    // MARK: - 表格

    func numberOfRows(in tableView: NSTableView) -> Int { providers.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < providers.count else { return nil }
        let provider = providers[row]
        let isCurrent = provider.id == currentId

        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        dot.layer?.backgroundColor = (isCurrent ? NSColor.systemGreen : NSColor.clear).cgColor
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 8).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 8).isActive = true

        let name = NSTextField(labelWithString: provider.name)
        name.font = .systemFont(ofSize: 13, weight: isCurrent ? .semibold : .regular)
        name.lineBreakMode = .byTruncatingTail

        let detail = NSTextField(labelWithString: "\(provider.host ?? "-")   model \(provider.model ?? "-")")
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
