// 智商测试历史：最近 20 条结果，点一行回看当时的页面或文字答案。
import AppKit

final class IqHistoryPane: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    var onSelect: ((IqHistoryEntry) -> Void)?

    let root: NSView
    private let backend = Backend.shared
    private var entries: [IqHistoryEntry] = []
    private var busy = false

    private let table = NSTableView()
    private let scroll = ProviderScrollView()
    private let emptyLabel = NSTextField(labelWithString: "还没有历史结果")
    private let spinner = NSProgressIndicator()
    private let refreshButton = NSButton(title: "刷新", target: nil, action: nil)
    private let clearButton = NSButton(title: "清空", target: nil, action: nil)

    override init() {
        root = NSView()
        super.init()
        build()
    }

    private func build() {
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        refreshButton.bezelStyle = .inline
        refreshButton.isBordered = false
        refreshButton.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "刷新历史")
        refreshButton.imagePosition = .imageOnly
        refreshButton.contentTintColor = .secondaryLabelColor
        clearButton.bezelStyle = .inline
        clearButton.isBordered = false
        clearButton.image = NSImage(systemSymbolName: "trash", accessibilityDescription: "清空历史")
        clearButton.imagePosition = .imageOnly
        clearButton.contentTintColor = .secondaryLabelColor

        table.headerView = nil
        table.rowHeight = 54
        table.selectionHighlightStyle = .none
        table.backgroundColor = .clear
        table.intercellSpacing = NSSize(width: 0, height: 0)
        table.style = .plain
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("iq-history"))
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
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.drawsBackground = false
        scroll.contentView.drawsBackground = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 164).isActive = true

        emptyLabel.font = .systemFont(ofSize: 12)
        emptyLabel.textColor = .secondaryLabelColor

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let header = NSStackView(views: [spacer, spinner, clearButton, refreshButton])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 8

        refreshButton.target = self
        refreshButton.action = #selector(refreshNow)
        clearButton.target = self
        clearButton.action = #selector(clearNow)

        let group = GroupBox()
        group.addRow(scroll)

        let column2 = NSStackView(views: [header, emptyLabel, group])
        column2.orientation = .vertical
        column2.alignment = .leading
        column2.spacing = 8
        column2.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(column2)
        NSLayoutConstraint.activate([
            column2.topAnchor.constraint(equalTo: root.topAnchor),
            column2.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            column2.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            column2.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            header.widthAnchor.constraint(equalTo: column2.widthAnchor),
            group.widthAnchor.constraint(equalTo: column2.widthAnchor),
        ])
    }

    func refresh() {
        guard !busy else { return }
        busy = true
        spinner.startAnimation(nil)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.iqHistory(limit: 20)
                DispatchQueue.main.async {
                    self.entries = result.entries ?? []
                    self.table.reloadData()
                    self.busy = false
                    self.spinner.stopAnimation(nil)
                    self.emptyLabel.isHidden = !self.entries.isEmpty
                    if self.entries.isEmpty {
                        self.emptyLabel.stringValue = "还没有历史结果"
                        self.emptyLabel.textColor = .secondaryLabelColor
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.spinner.stopAnimation(nil)
                    self.entries = []
                    self.table.reloadData()
                    self.emptyLabel.isHidden = false
                    self.emptyLabel.stringValue = "读取历史失败：\(error.localizedDescription)"
                    self.emptyLabel.textColor = .systemRed
                }
            }
        }
    }

    @objc private func refreshNow() { refresh() }

    @objc private func clearNow() {
        guard !entries.isEmpty else { return }
        let alert = NSAlert()
        alert.messageText = "清空智商测试历史？"
        alert.informativeText = "只删除历史记录，不会删除已经生成的页面文件。"
        alert.addButton(withTitle: "清空")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            _ = try backend.iqClearHistory()
            entries = []
            table.reloadData()
            emptyLabel.isHidden = false
            emptyLabel.stringValue = "还没有历史结果"
            emptyLabel.textColor = .secondaryLabelColor
        } catch {
            emptyLabel.isHidden = false
            emptyLabel.stringValue = "清空失败：\(error.localizedDescription)"
            emptyLabel.textColor = .systemRed
        }
    }

    @objc private func rowClicked() {
        let row = table.clickedRow >= 0 ? table.clickedRow : table.selectedRow
        guard row >= 0, row < entries.count else { return }
        onSelect?(entries[row])
    }

    // MARK: - 表格

    func numberOfRows(in tableView: NSTableView) -> Int { entries.count }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let view = ProviderRowView()
        view.showTopSeparator = row > 0
        return view
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat { 54 }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < entries.count else { return nil }
        let item = entries[row]

        let title = NSTextField(labelWithString: item.topicTitle ?? item.topic ?? "未知题目")
        title.font = .systemFont(ofSize: 13, weight: .medium)
        title.lineBreakMode = .byTruncatingTail

        var details: [String] = []
        if let at = Self.dateText(item.at) { details.append(at) }
        let model = [item.providerName, item.model].compactMap { $0 }.joined(separator: " / ")
        if !model.isEmpty { details.append(model) }
        if let ms = item.elapsedMs { details.append("用时 \(Int((Double(ms) / 1000).rounded()))s") }
        if item.replyTruncated == true { details.append("回复已截断") }
        let detail = NSTextField(labelWithString: details.joined(separator: "  ·  "))
        detail.font = .monospacedSystemFont(ofSize: 10.5, weight: .regular)
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingMiddle

        let texts = NSStackView(views: [title, detail])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 3
        texts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        var trailing: [NSView] = []
        if let tag = Self.tag(for: item) { trailing.append(tag) }

        var views: [NSView] = [texts]
        if !trailing.isEmpty {
            views.append(NSView())
            views.append(contentsOf: trailing)
        }
        let rowStack = NSStackView(views: views)
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

    private static func tag(for item: IqHistoryEntry) -> NSView? {
        if item.error != nil { return PageChrome.tag("失败", tint: .systemRed) }
        if item.stopReason == "cancelled" { return PageChrome.tag("已取消") }
        if let answer = item.answer, !answer.isEmpty {
            return PageChrome.tag("答案 \(answer)", tint: .systemGreen)
        }
        if item.inspect?.hasSvg == true, item.inspect?.hasAnimation == true {
            return PageChrome.tag("SVG+动画", tint: .systemGreen)
        }
        return PageChrome.tag("已完成")
    }

    private static func dateText(_ iso: String?) -> String? {
        guard let iso else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = formatter.date(from: iso)
        if date == nil {
            formatter.formatOptions = [.withInternetDateTime]
            date = formatter.date(from: iso)
        }
        guard let date else { return iso }
        let display = DateFormatter()
        display.dateFormat = "MM-dd HH:mm"
        return display.string(from: date)
    }
}
