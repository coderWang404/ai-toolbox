// ClinePass 额度页：多密钥查询三窗口用量和账户余额。
import AppKit

final class ClineQuotaPane: NSObject {
    private(set) var root: NSView!
    var onDetail: ((String) -> Void)?

    private let backend: Backend
    private var keys: [ClineKeyPublic] = []
    private var report: ClineQuotaReport?
    private var busy = false
    private var loaded = false

    private let keyBox = GroupBox()
    private let results = NSStackView()
    private let status = StatusLine()
    private let formStatus = StatusLine()
    private let nameField = NSTextField()
    private let keyField = NSTextField()
    private let bulkView = NSTextView()
    private var addButton: NSButton!
    private let queryButton = NSButton()
    private let spinner = NSProgressIndicator()

    init(backend: Backend) {
        self.backend = backend
        super.init()
        root = makeRoot()
    }

    func onShow() {
        guard !loaded else { return }
        loaded = true
        reloadKeys(thenQuery: true)
    }

    func sidebarDetail() -> String {
        guard let report, let first = report.keys.first else {
            return keys.isEmpty ? "未添加密钥" : "未查询"
        }
        if let month = first.windows?.monthly {
            if month.percent >= 100 { return "本月已用尽" }
            return "本月已用 \(Int(month.percent.rounded()))%"
        }
        return first.ok ? "已查询" : "查询失败"
    }

    private func makeRoot() -> NSView {
        configureField(nameField, placeholder: "例如 默认")
        configureField(keyField, placeholder: "sk_…", mono: true)
        nameField.target = self
        nameField.action = #selector(focusKeyField)
        keyField.target = self
        keyField.action = #selector(addOne)
        addButton = NSButton(title: "添加并查询", target: self, action: #selector(addOne))
        addButton.bezelStyle = .rounded
        addButton.bezelColor = .controlAccentColor
        let addRow = NSStackView(views: [NSView(), addButton])
        addRow.orientation = .horizontal
        let singleBox = GroupBox()
        singleBox.addRow(labeledField("名称", nameField))
        singleBox.addRow(labeledField("密钥", keyField))
        singleBox.addRow(addRow)
        let singleColumn = NSStackView(views: [singleBox, formStatus])
        singleColumn.orientation = .vertical
        singleColumn.alignment = .leading
        singleColumn.spacing = 8
        singleBox.widthAnchor.constraint(equalTo: singleColumn.widthAnchor).isActive = true
        formStatus.widthAnchor.constraint(equalTo: singleColumn.widthAnchor).isActive = true
        let addSection = SectionView(title: "添加一把", content: singleColumn, footer: "密钥是 sk_ 开头。在密钥框按回车就会添加。完整显示，可以复制。")

        bulkView.isEditable = true
        bulkView.isSelectable = true
        bulkView.isRichText = false
        bulkView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        bulkView.isAutomaticQuoteSubstitutionEnabled = false
        bulkView.isAutomaticDashSubstitutionEnabled = false
        bulkView.drawsBackground = false
        let bulkScroll = NSScrollView()
        bulkScroll.documentView = bulkView
        bulkScroll.hasVerticalScroller = true
        bulkScroll.autohidesScrollers = true
        bulkScroll.borderType = .bezelBorder
        bulkScroll.translatesAutoresizingMaskIntoConstraints = false
        bulkScroll.heightAnchor.constraint(equalToConstant: 72).isActive = true
        let importButton = NSButton(title: "导入这些密钥", target: self, action: #selector(importBulk))
        importButton.bezelStyle = .rounded
        let bulkColumn = NSStackView(views: [bulkScroll, importButton])
        bulkColumn.orientation = .vertical
        bulkColumn.alignment = .leading
        bulkColumn.spacing = 8
        bulkScroll.widthAnchor.constraint(equalTo: bulkColumn.widthAnchor).isActive = true
        let bulkBox = GroupBox()
        bulkBox.addRow(bulkColumn)
        let bulkSection = SectionView(title: "一次添加多把", content: bulkBox, footer: "每行一把，也可以写成「名称 sk_…」。")

        queryButton.title = "查询全部"
        queryButton.bezelStyle = .rounded
        queryButton.bezelColor = .controlAccentColor
        queryButton.target = self
        queryButton.action = #selector(queryAll)
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        let queryRow = NSStackView(views: [NSView(), spinner, queryButton])
        queryRow.orientation = .horizontal
        queryRow.alignment = .centerY
        queryRow.spacing = 8

        results.orientation = .vertical
        results.alignment = .leading
        results.spacing = 18

        let keySection = SectionView(
            title: "已保存的密钥",
            content: keyBox,
            footer: "向 api.cline.bot 查询 5 小时、本周、本月用量，以及账户余额。"
        )
        let body = NSStackView(views: [keySection, addSection, bulkSection, queryRow, results, status])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 22
        renderKeys()
        renderResults()
        return PageChrome.scroll(
            title: "ClinePass 额度",
            subtitle: "查询每把 ClinePass 密钥的三窗口剩余额度和账户余额。",
            content: body
        )
    }

    private func configureField(_ field: NSTextField, placeholder: String, mono: Bool = false) {
        field.placeholderString = placeholder
        field.font = mono ? .monospacedSystemFont(ofSize: 12, weight: .regular) : .systemFont(ofSize: 13)
        field.isEditable = true
        field.isSelectable = true
        field.lineBreakMode = .byTruncatingTail
        field.cell?.sendsActionOnEndEditing = false
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    private func labeledField(_ title: String, _ field: NSTextField) -> NSView {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 13)
        label.textColor = .secondaryLabelColor
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.widthAnchor.constraint(equalToConstant: 36).isActive = true
        let row = NSStackView(views: [label, field])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        return row
    }

    private func reloadKeys(thenQuery: Bool) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let list = try self.backend.clineKeys()
                DispatchQueue.main.async {
                    self.keys = list.keys ?? []
                    self.renderKeys()
                    self.onDetail?(self.sidebarDetail())
                    if thenQuery, !self.keys.isEmpty, self.report == nil { self.queryAll() }
                }
            } catch {
                DispatchQueue.main.async { self.formStatus.set("❌ \(self.describe(error))") }
            }
        }
    }

    @objc private func focusKeyField() { keyField.window?.makeFirstResponder(keyField) }

    @objc private func addOne() {
        let key = keyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            formStatus.set("❌ 先把密钥贴到「密钥」这一行")
            focusKeyField()
            return
        }
        let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        formStatus.set("正在添加…")
        mutate(thenQuery: true, note: formStatus, work: {
            try self.backend.clineKeysAdd(name: name, key: key)
        }, success: { added in
            if added == 0 {
                self.formStatus.set("这个密钥已经在列表里")
            } else {
                self.formStatus.set("✔ 已添加")
                self.nameField.stringValue = ""
                self.keyField.stringValue = ""
            }
        })
    }

    @objc private func importBulk() {
        let text = bulkView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            formStatus.set("❌ 先把密钥贴到下面的文本框")
            return
        }
        formStatus.set("正在导入…")
        mutate(thenQuery: true, note: formStatus, work: {
            try self.backend.clineKeysImport(text: text)
        }, success: { added in
            if added == 0 {
                self.formStatus.set("这些密钥都已经在列表里")
            } else {
                self.formStatus.set("✔ 已导入 \(added) 把")
                self.bulkView.string = ""
            }
        })
    }

    @objc private func removeKey(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue,
              let item = keys.first(where: { $0.id == id }) else { return }
        let alert = NSAlert()
        alert.messageText = "删除「\(item.name)」？"
        alert.informativeText = "只从本机列表移除「\(item.name)」。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "删除")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        mutate(thenQuery: false, note: status, work: {
            try self.backend.clineKeysRemove(id)
        }, success: { _ in
            if var current = self.report {
                current = ClineQuotaReport(ok: current.ok, keys: current.keys.filter { $0.id != id }, fetchedAt: current.fetchedAt, error: current.error)
                self.report = current
                self.renderResults()
            }
        })
    }

    @objc private func queryAll() {
        guard !busy else { return }
        guard !keys.isEmpty else {
            formStatus.set("❌ 先在上面添加一把密钥")
            return
        }
        busy = true
        syncControls()
        status.set("正在查询 \(keys.count) 个密钥…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let report = try self.backend.clineQuota()
                DispatchQueue.main.async {
                    self.busy = false
                    self.report = report
                    self.renderKeys()
                    self.renderResults()
                    self.announce(report)
                    self.onDetail?(self.sidebarDetail())
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.status.set("❌ \(self.describe(error))")
                }
            }
        }
    }

    private func mutate(thenQuery: Bool, note: StatusLine, work: @escaping () throws -> ClineKeyListResult, success: @escaping (Int) -> Void) {
        guard !busy else { return }
        busy = true
        syncControls()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let list = try work()
                DispatchQueue.main.async {
                    self.busy = false
                    self.keys = list.keys ?? []
                    self.renderKeys()
                    success(list.added ?? 0)
                    if thenQuery, (list.added ?? 0) > 0 { self.queryAll() }
                    else { self.syncControls(); self.onDetail?(self.sidebarDetail()) }
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    note.set("❌ \(self.describe(error))")
                }
            }
        }
    }

    private func syncControls() {
        addButton?.isEnabled = !busy
        queryButton.isEnabled = !busy && !keys.isEmpty
        if busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
    }

    private func announce(_ report: ClineQuotaReport) {
        let failed = report.keys.filter { !$0.ok }.count
        if failed == 0 {
            status.set("✔ 已更新，共 \(report.keys.count) 个密钥")
        } else {
            status.set("⚠️ \(report.keys.count) 个密钥里有 \(failed) 个查询失败")
        }
    }

    private func renderKeys() {
        if keys.isEmpty {
            keyBox.setRows([ClineText.label("还没有密钥。下面添加后就可以查询。", size: 12, color: .secondaryLabelColor)])
        } else {
            keyBox.setRows(keys.map(keyRow))
        }
        syncControls()
    }

    private func keyRow(_ item: ClineKeyPublic) -> NSView {
        let delete = NSButton()
        delete.bezelStyle = .inline
        delete.isBordered = false
        delete.image = NSImage(systemSymbolName: "minus.circle", accessibilityDescription: "删除密钥")
        delete.imagePosition = .imageOnly
        delete.contentTintColor = .secondaryLabelColor
        delete.identifier = NSUserInterfaceItemIdentifier(item.id)
        delete.target = self
        delete.action = #selector(removeKey(_:))
        delete.translatesAutoresizingMaskIntoConstraints = false
        delete.widthAnchor.constraint(equalToConstant: 22).isActive = true
        delete.heightAnchor.constraint(equalToConstant: 22).isActive = true
        return savedKeyRow(title: item.name, key: item.key, accessory: delete)
    }

    private func renderResults() {
        for view in results.arrangedSubviews {
            results.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for view in resultViews() {
            results.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: results.widthAnchor).isActive = true
        }
        syncControls()
    }

    private func resultViews() -> [NSView] {
        guard let report else {
            return [ClineText.label("查询之后，这里列出每把密钥的 5 小时、本周、本月额度和账户余额。", size: 12, color: .secondaryLabelColor)]
        }
        var views = report.keys.map { keySection($0) }
        views.append(ClineText.label("官方接口返回三个窗口的已用百分比和重置时间，以及余额（单位是美元）。没有按模型拆开的消耗。", size: 11, color: .secondaryLabelColor, lines: 0))
        return views
    }

    private func keySection(_ key: ClineQuotaKey) -> NSView {
        let column = NSStackView()
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 12
        if let error = key.error, !key.ok {
            column.addArrangedSubview(ClineText.label(error, size: 12, color: .systemRed, lines: 0))
        } else if let windows = key.windows {
            if let note = key.note, !note.isEmpty {
                column.addArrangedSubview(ClineText.label(note, size: 12, color: .secondaryLabelColor, lines: 0))
            }
            let box = GroupBox()
            box.addRow(SettingRow(title: "账户余额", accessory: ClineText.label(key.balance ?? "—", size: 13, weight: .semibold)))
            box.addRow(windowRow("5小时滚动", windows.rolling))
            box.addRow(windowRow("本周", windows.weekly))
            box.addRow(windowRow("本月", windows.monthly))
            column.addArrangedSubview(box)
        }
        for view in column.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        let secret = CopyableSecret(text: key.key, expands: true)
        column.insertArrangedSubview(secret, at: 0)
        secret.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        let latency = key.latencyMs.map { "接口 \($0) ms" }
        return SectionView(title: key.name, content: column, footer: latency)
    }

    private func windowRow(_ title: String, _ window: ClineQuotaWindow?) -> NSView {
        let heading = ClineText.label(title, size: 13, weight: .semibold)
        heading.setContentHuggingPriority(.required, for: .horizontal)
        let detail = ClineText.label(windowDetail(window), size: 12, color: windowColor(window))
        let line = NSStackView(views: [heading, detail])
        line.orientation = .horizontal
        line.alignment = .firstBaseline
        line.spacing = 12
        let meter = ClineMeter()
        meter.fraction = CGFloat((window?.percent ?? 0) / 100)
        meter.fill = meterColor(window)
        meter.translatesAutoresizingMaskIntoConstraints = false
        meter.heightAnchor.constraint(equalToConstant: 8).isActive = true
        let stack = NSStackView(views: [line, meter])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        meter.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        line.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return stack
    }

    private func windowDetail(_ window: ClineQuotaWindow?) -> String {
        guard let window else { return "没有返回" }
        let used = Int(window.percent.rounded())
        let remain = max(0, 100 - used)
        let state = window.status == "rate-limited" || used >= 100 ? "已限流" : "正常"
        let reset = formatReset(window.resetsAt).map { " · \($0) 重置" } ?? ""
        return "已用 \(used)% · 剩余 \(remain)% · \(state)\(reset)"
    }

    private func windowColor(_ window: ClineQuotaWindow?) -> NSColor {
        guard let window else { return .secondaryLabelColor }
        if window.percent >= 100 { return .systemRed }
        if window.percent >= 80 { return .systemOrange }
        return .secondaryLabelColor
    }

    private func meterColor(_ window: ClineQuotaWindow?) -> NSColor {
        guard let window else { return .controlAccentColor }
        if window.percent >= 90 { return .systemRed }
        if window.percent >= 50 { return .systemOrange }
        return .systemGreen
    }

    private func formatReset(_ value: String?) -> String? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        guard let date = fractional.date(from: value) ?? plain.date(from: value) else { return nil }
        let format = DateFormatter()
        format.locale = Locale(identifier: "zh_CN")
        format.dateFormat = "M月d日 HH:mm"
        return format.string(from: date)
    }

    private func describe(_ error: Error) -> String {
        let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        if let range = text.range(of: #"sk_[A-Za-z0-9]{8,}"#, options: .regularExpression) {
            return text.replacingCharacters(in: range, with: "sk_…")
        }
        return text
    }
}

private enum ClineText {
    static func label(
        _ text: String,
        size: CGFloat,
        weight: NSFont.Weight = .regular,
        color: NSColor = .labelColor,
        lines: Int = 1,
        align: NSTextAlignment = .left
    ) -> NSView {
        if lines != 1 {
            let field = NSTextField(wrappingLabelWithString: text)
            field.font = .systemFont(ofSize: size, weight: weight)
            field.textColor = color
            field.alignment = align
            field.maximumNumberOfLines = 4
            field.preferredMaxLayoutWidth = 420
            field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            return field
        }
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        field.alignment = align
        field.lineBreakMode = .byTruncatingTail
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }
}

private final class ClineMeter: NSView {
    var fraction: CGFloat = 0 { didSet { needsDisplay = true } }
    var fill: NSColor = .controlAccentColor { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.quaternaryLabelColor.withAlphaComponent(0.45).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill()
        let width = bounds.width * max(0, min(1, fraction))
        guard width > 0 else { return }
        fill.setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: max(width, 4), height: bounds.height), xRadius: 4, yRadius: 4).fill()
    }
}
