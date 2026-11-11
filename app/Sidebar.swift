// 系统设置风格的源列表侧栏：分组标题 + 图标徽章 + 两行描述。
import AppKit

final class SettingsSidebarController: NSViewController, NSTableViewDataSource, NSTableViewDelegate {
    struct Item {
        let page: Int
        let title: String
        let symbol: String
        let tint: NSColor
        var detail: String
    }

    private enum Row {
        case header(String)
        case item(Int)
    }

    var onSelect: ((Int) -> Void)?

    private var items: [Item] = [
        Item(page: 0, title: "Codex", symbol: "arrow.left.arrow.right", tint: .systemBlue, detail: "供应商热切换"),
        Item(page: 6, title: "Claude Code", symbol: "chevron.left.forwardslash.chevron.right", tint: .systemOrange, detail: "供应商切换"),
        Item(page: 7, title: "Claude Desktop", symbol: "macwindow", tint: .systemOrange, detail: "供应商切换"),
        Item(page: 1, title: "cc-switch", symbol: "arrow.triangle.2.circlepath", tint: .systemGreen, detail: "实时同步"),
        Item(page: 2, title: "智商测试", symbol: "brain.head.profile", tint: .systemPurple, detail: "选题作画"),
        Item(page: 3, title: "额度", symbol: "chart.bar.fill", tint: .systemTeal, detail: "OpenCode / ClinePass"),
        Item(page: 4, title: "网关与网络", symbol: "point.3.connected.trianglepath.dotted", tint: .systemIndigo, detail: "Grok / Today / Qoder"),
        Item(page: 5, title: "网络测速", symbol: "speedometer", tint: .systemCyan, detail: "未测速"),
    ]

    /// 分组：供应商放在最前，之后是同步/工具和网络。
    private let sections: [(title: String, pages: [Int])] = [
        ("供应商", [0, 6, 7]),
        ("工具", [1, 2, 3]),
        ("网络", [4, 5]),
    ]

    private let table = NSTableView()
    private var suppressSelection = false

    private var rows: [Row] {
        var result: [Row] = []
        for section in sections {
            result.append(.header(section.title))
            for page in section.pages {
                if let index = items.firstIndex(where: { $0.page == page }) {
                    result.append(.item(index))
                }
            }
        }
        return result
    }

    override func loadView() {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        table.style = .sourceList
        table.headerView = nil
        table.rowHeight = 44
        table.backgroundColor = .clear
        table.intercellSpacing = NSSize(width: 0, height: 0)
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("sidebar"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.dataSource = self
        table.delegate = self
        scroll.documentView = table
        view = scroll
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        table.reloadData()
    }

    func select(page: Int) {
        guard let row = rows.firstIndex(where: {
            if case .item(let index) = $0 { return items[index].page == page }
            return false
        }) else { return }
        suppressSelection = true
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        table.scrollRowToVisible(row)
        suppressSelection = false
    }

    func setDetail(page: Int, _ text: String) {
        guard let index = items.firstIndex(where: { $0.page == page }), items[index].detail != text else { return }
        items[index].detail = text
        guard let row = rows.firstIndex(where: {
            if case .item(let itemIndex) = $0 { return itemIndex == index }
            return false
        }) else { return }
        if let cell = table.view(atColumn: 0, row: row, makeIfNecessary: false) as? SidebarCell {
            cell.setDetail(text)
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        if case .header = rows[row] { return 26 }
        return 44
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if case .header = rows[row] { return false }
        return true
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        switch rows[row] {
        case .header(let title):
            return SidebarHeaderCell(title: title)
        case .item(let index):
            let cell = SidebarCell()
            cell.configure(items[index])
            return cell
        }
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !suppressSelection else { return }
        let row = table.selectedRow
        guard row >= 0, row < rows.count, case .item(let index) = rows[row] else { return }
        onSelect?(items[index].page)
    }
}

private final class SidebarHeaderCell: NSTableCellView {
    private let label = NSTextField(labelWithString: "")

    init(title: String) {
        super.init(frame: .zero)
        label.stringValue = title
        label.font = .systemFont(ofSize: 10.5, weight: .semibold)
        label.textColor = .tertiaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

private final class SidebarCell: NSTableCellView {
    private let badge = NSView()
    private let icon = NSImageView()
    private let titleField = NSTextField(labelWithString: "")
    private let detailField = NSTextField(labelWithString: "")
    private var tint: NSColor = .systemBlue

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        badge.wantsLayer = true
        badge.layer?.cornerRadius = 6
        badge.translatesAutoresizingMaskIntoConstraints = false
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11.5, weight: .semibold)
        icon.translatesAutoresizingMaskIntoConstraints = false
        badge.addSubview(icon)
        titleField.font = .systemFont(ofSize: 13)
        titleField.lineBreakMode = .byTruncatingTail
        detailField.font = .systemFont(ofSize: 11)
        detailField.lineBreakMode = .byTruncatingTail
        let texts = NSStackView(views: [titleField, detailField])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 1
        texts.translatesAutoresizingMaskIntoConstraints = false
        addSubview(badge)
        addSubview(texts)
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            badge.centerYAnchor.constraint(equalTo: centerYAnchor),
            badge.widthAnchor.constraint(equalToConstant: 22),
            badge.heightAnchor.constraint(equalToConstant: 22),
            icon.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
            texts.leadingAnchor.constraint(equalTo: badge.trailingAnchor, constant: 10),
            texts.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            texts.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(_ item: SettingsSidebarController.Item) {
        tint = item.tint
        titleField.stringValue = item.title
        detailField.stringValue = item.detail
        icon.image = NSImage(systemSymbolName: item.symbol, accessibilityDescription: item.title)
        applyColors(selected: backgroundStyle == .emphasized)
    }

    func setDetail(_ text: String) {
        detailField.stringValue = text
    }

    private func applyColors(selected: Bool) {
        titleField.textColor = selected ? .white : .labelColor
        detailField.textColor = selected ? NSColor.white.withAlphaComponent(0.82) : .secondaryLabelColor
        if selected {
            icon.contentTintColor = .white
            badge.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.24).cgColor
        } else {
            icon.contentTintColor = tint
            badge.layer?.backgroundColor = tint.withAlphaComponent(0.16).cgColor
        }
    }

    override var backgroundStyle: NSView.BackgroundStyle {
        didSet { applyColors(selected: backgroundStyle == .emphasized) }
    }
}
