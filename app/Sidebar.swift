// 系统设置风格的源列表侧栏。
import AppKit

final class SettingsSidebarController: NSViewController, NSTableViewDataSource, NSTableViewDelegate {
    struct Item {
        let page: Int
        let title: String
        let symbol: String
        let tint: NSColor
        var detail: String
    }

    var onSelect: ((Int) -> Void)?
    private var items: [Item] = [
        Item(page: 0, title: "Codex", symbol: "arrow.left.arrow.right", tint: .systemBlue, detail: "供应商热切换"),
        Item(page: 2, title: "Claude Desktop", symbol: "bubble.left.and.bubble.right", tint: .systemOrange, detail: "跟随 cc-switch"),
        Item(page: 1, title: "cc-switch", symbol: "arrow.triangle.2.circlepath", tint: .systemGreen, detail: "实时同步"),
        Item(page: 3, title: "智商测试", symbol: "brain.head.profile", tint: .systemPurple, detail: "选题作画"),
        Item(page: 4, title: "OpenCode 额度", symbol: "chart.bar.fill", tint: .systemTeal, detail: "查询剩余额度"),
        Item(page: 5, title: "ClinePass 额度", symbol: "creditcard.fill", tint: .systemPink, detail: "查询剩余额度"),
        Item(page: 6, title: "Grok Bot", symbol: "sparkles", tint: .systemIndigo, detail: "本机网关"),
        Item(page: 7, title: "网络测速", symbol: "speedometer", tint: .systemCyan, detail: "未测速"),
    ]
    private let table = NSTableView()
    private var suppressSelection = false

    override func loadView() {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        table.style = .sourceList
        table.headerView = nil
        table.rowHeight = 40
        table.backgroundColor = .clear
        table.intercellSpacing = NSSize(width: 0, height: 2)
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
        guard let row = items.firstIndex(where: { $0.page == page }) else { return }
        suppressSelection = true
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        suppressSelection = false
    }

    func setDetail(page: Int, _ text: String) {
        guard let row = items.firstIndex(where: { $0.page == page }) else { return }
        items[row].detail = text
        if let cell = table.view(atColumn: 0, row: row, makeIfNecessary: false) as? SidebarCell {
            cell.setDetail(text)
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let item = items[row]
        let cell = SidebarCell()
        cell.configure(item)
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !suppressSelection else { return }
        let row = table.selectedRow
        guard row >= 0, row < items.count else { return }
        onSelect?(items[row].page)
    }
}

private final class SidebarCell: NSTableCellView {
    private let badge = NSView()
    private let icon = NSImageView()
    private let titleField = NSTextField(labelWithString: "")
    private let detailField = NSTextField(labelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        badge.wantsLayer = true
        badge.layer?.cornerRadius = 5
        badge.translatesAutoresizingMaskIntoConstraints = false
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
        icon.translatesAutoresizingMaskIntoConstraints = false
        badge.addSubview(icon)
        titleField.font = .systemFont(ofSize: 13)
        titleField.lineBreakMode = .byTruncatingTail
        detailField.font = .systemFont(ofSize: 11)
        detailField.lineBreakMode = .byTruncatingTail
        let texts = NSStackView(views: [titleField, detailField])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 0
        texts.translatesAutoresizingMaskIntoConstraints = false
        addSubview(badge)
        addSubview(texts)
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            badge.centerYAnchor.constraint(equalTo: centerYAnchor),
            badge.widthAnchor.constraint(equalToConstant: 20),
            badge.heightAnchor.constraint(equalToConstant: 20),
            icon.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
            texts.leadingAnchor.constraint(equalTo: badge.trailingAnchor, constant: 8),
            texts.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            texts.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(_ item: SettingsSidebarController.Item) {
        titleField.stringValue = item.title
        detailField.stringValue = item.detail
        icon.image = NSImage(systemSymbolName: item.symbol, accessibilityDescription: item.title)
        icon.contentTintColor = .white
        badge.layer?.backgroundColor = item.tint.cgColor
    }

    func setDetail(_ text: String) {
        detailField.stringValue = text
    }

    override var backgroundStyle: NSView.BackgroundStyle {
        didSet {
            let selected = backgroundStyle == .emphasized
            titleField.textColor = selected ? .white : .labelColor
            detailField.textColor = selected ? NSColor.white.withAlphaComponent(0.85) : .secondaryLabelColor
        }
    }
}
