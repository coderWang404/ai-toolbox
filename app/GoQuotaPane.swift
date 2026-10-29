// OpenCode Go 额度页：多密钥查询，并按模型换算剩余金额和本机消耗。
import AppKit

final class GoQuotaPane: NSObject {
    private(set) var root: NSView!
    var onDetail: ((String) -> Void)?

    private let backend: Backend
    private var keys: [GoKeyPublic] = []
    private var report: GoQuotaReport?
    private var busy = false
    private var loaded = false

    private let keyBox = GroupBox()
    private let results = NSStackView()
    private let status = StatusLine()
    private let nameField = NSTextField()
    private let keyField = NSTextField()
    private let bulkView = NSTextView()
    private let formStatus = StatusLine()
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
        guard let report else { return keys.isEmpty ? "未添加密钥" : "未查询" }
        let exhausted = report.keys.contains { key in
            guard let month = key.windows?.monthly else { return false }
            return month.status == "rate-limited" || month.percent >= 100
        }
        if report.keys.count > 1 {
            return exhausted ? "\(report.keys.count) 个密钥 · 有本月用尽" : "\(report.keys.count) 个密钥"
        }
        if let month = report.keys.first?.windows?.monthly {
            if month.status == "rate-limited" || month.percent >= 100 { return "本月已用尽" }
            return "本月已用 \(Int(month.percent.rounded()))%"
        }
        return "查询失败"
    }

    private func makeRoot() -> NSView {
        configureField(nameField, placeholder: "例如 巴基斯坦 Google")
        configureField(keyField, placeholder: "oc_sk_… 或 sk-…", mono: true)
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
        let addSection = SectionView(
            title: "添加一把",
            content: singleColumn,
            footer: "名称用来区分订阅。密钥支持 oc_sk_… 和 sk-…。在密钥框按回车就会添加。"
        )

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
        bulkScroll.heightAnchor.constraint(equalToConstant: 88).isActive = true
        let importButton = NSButton(title: "导入这些密钥", target: self, action: #selector(importBulk))
        importButton.bezelStyle = .rounded
        let bulkColumn = NSStackView(views: [bulkScroll, importButton])
        bulkColumn.orientation = .vertical
        bulkColumn.alignment = .leading
        bulkColumn.spacing = 8
        bulkScroll.widthAnchor.constraint(equalTo: bulkColumn.widthAnchor).isActive = true
        let bulkBox = GroupBox()
        bulkBox.addRow(bulkColumn)
        let bulkSection = SectionView(
            title: "一次添加多把",
            content: bulkBox,
            footer: "每行一把。可以只写密钥，或写成「名称 oc_sk_…」。密钥完整显示，可以复制。"
        )

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
            footer: "「用于本机」以这里选中的密钥为准，替换 cc-switch 里所有 OpenCode Go 密钥、Kimi Code、OpenCode 和 DeepSeek Harness。模型不改。正在运行的这几个应用会退出并重新打开。"
        )
        let body = NSStackView(views: [keySection, addSection, bulkSection, queryRow, results, status])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 22
        renderKeys()
        renderResults()
        let page = PageChrome.scroll(
            title: "OpenCode 额度",
            subtitle: "查询每把密钥的官方三窗口额度。选中一把后，可以把它写进本机的 cc-switch 和 OpenCode。",
            content: body
        )
        return page
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

    private func scrollToTop() {
        guard let scroll = root as? NSScrollView else { return }
        DispatchQueue.main.async {
            guard let document = scroll.documentView else { return }
            scroll.layoutSubtreeIfNeeded()
            let clip = scroll.contentView
            let y = clip.isFlipped ? 0 : max(0, document.bounds.height - clip.bounds.height)
            clip.scroll(to: NSPoint(x: 0, y: y))
            scroll.reflectScrolledClipView(clip)
        }
    }

    private func reloadKeys(thenQuery: Bool) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let list = try self.backend.goKeys()
                DispatchQueue.main.async {
                    self.keys = list.keys ?? []
                    self.renderKeys()
                    self.onDetail?(self.sidebarDetail())
                    if thenQuery, !self.keys.isEmpty, self.report == nil {
                        self.queryAll()
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.status.set("❌ \(self.describe(error))")
                }
            }
        }
    }

    @objc private func focusKeyField() {
        keyField.window?.makeFirstResponder(keyField)
    }

    @objc private func addOne() {
        let key = keyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            formStatus.set("❌ 先把密钥贴到「密钥」这一行")
            focusKeyField()
            return
        }
        let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        formStatus.set("正在添加…")
        mutateKeys(thenQuery: true, note: formStatus) {
            try self.backend.goKeysAdd(name: name, key: key, plan: "go")
        } success: { added in
            if added == 0 {
                self.formStatus.set("这个密钥已经在列表里")
            } else {
                let label = name.isEmpty ? "这把密钥" : "「\(name)」"
                self.formStatus.set("✔ 已添加 \(label)")
                self.nameField.stringValue = ""
                self.keyField.stringValue = ""
            }
        }
    }

    @objc private func importBulk() {
        let text = bulkView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            formStatus.set("❌ 先把密钥贴到「一次添加多把」的文本框")
            bulkView.window?.makeFirstResponder(bulkView)
            return
        }
        formStatus.set("正在导入…")
        mutateKeys(thenQuery: true, note: formStatus) {
            try self.backend.goKeysImport(text: text, plan: "go")
        } success: { added in
            if added == 0 {
                self.formStatus.set("这些密钥都已经在列表里")
            } else {
                self.formStatus.set("✔ 已导入 \(added) 把")
                self.bulkView.string = ""
            }
        }
    }

    @objc private func removeKey(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue,
              let item = keys.first(where: { $0.id == id }) else { return }
        let alert = NSAlert()
        alert.messageText = "删除「\(item.name)」？"
        alert.informativeText = "只从本机列表移除「\(item.name)」，不会改动 OpenCode。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "删除")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        mutateKeys(thenQuery: false, note: status) {
            try self.backend.goKeysRemove(id)
        } success: { _ in
            if var current = self.report {
                current.keys.removeAll { $0.id == id }
                self.report = current
                self.renderResults()
            }
        }
    }

    @objc private func useKey(_ sender: NSButton) {
        guard !busy, let id = sender.identifier?.rawValue else { return }
        busy = true
        syncControls()
        status.set("正在切换密钥，并重启 OpenCode、Kimi Code 和 DeepSeek Harness…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.goKeysUse(id)
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.status.set("✔ \(self.useSummary(result))")
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

    private func useSummary(_ result: GoKeyUseResult) -> String {
        let targets = (result.updated ?? []).map { item -> String in
            switch item.target {
            case "cc-switch":
                let kind = item.appType == "codex" ? "Codex" : (item.appType == "claude" ? "Claude" : (item.appType ?? ""))
                return "cc-switch \(kind)「\(item.name)」"
            case "opencode": return "OpenCode"
            case "deepseek-harness": return "DeepSeek Harness「\(item.name)」"
            case "kimi-code": return "Kimi Code「\(item.name)」"
            case "codex": return "当前 Codex 配置"
            case "claude-desktop": return "当前 Claude Desktop"
            default: return item.name
            }
        }
        var text = "已写入 \(targets.joined(separator: "、"))，模型未改"
        if result.opencodeRestarted == true {
            text += "。OpenCode 已重新打开"
        } else {
            text += "。OpenCode 没在运行，下次打开会用新密钥"
        }
        if result.harnessRestarted == true {
            text += "。DeepSeek Harness 已重新打开"
        }
        if result.kimiRestarted == true {
            text += "。Kimi Code 已重新打开"
        }
        if result.ccSwitchRunning == true {
            text += "。cc-switch 正在运行，卡片若还显示旧密钥，重新点开该供应商即可"
        }
        return text
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
                let report = try self.backend.goQuota()
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

    private func mutateKeys(thenQuery: Bool, note: StatusLine, work: @escaping () throws -> GoKeyListResult, success: @escaping (Int) -> Void) {
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
                    if thenQuery, (list.added ?? 0) > 0 {
                        self.queryAll()
                    } else {
                        self.syncControls()
                        self.onDetail?(self.sidebarDetail())
                    }
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
        spinner.startAnimation(nil)
        if !busy { spinner.stopAnimation(nil) }
    }

    private func announce(_ report: GoQuotaReport) {
        let failed = report.keys.filter { !$0.ok }
        let when = formatReset(report.fetchedAt) ?? "刚刚"
        if failed.isEmpty {
            status.set("✔ 已更新 \(when)，共 \(report.keys.count) 个密钥")
        } else {
            status.set("⚠️ \(report.keys.count) 个密钥里有 \(failed.count) 个查询失败")
        }
    }

    private func renderKeys() {
        if keys.isEmpty {
            keyBox.setRows([QuotaText.label("还没有密钥。下面添加后就可以查询。", size: 12, color: .secondaryLabelColor)])
        } else {
            keyBox.setRows(keys.map(keyRow))
        }
        syncControls()
    }

    private func keyRow(_ item: GoKeyPublic) -> NSView {
        let use = NSButton(title: "用于本机", target: self, action: #selector(useKey(_:)))
        use.bezelStyle = .rounded
        use.controlSize = .small
        use.identifier = NSUserInterfaceItemIdentifier(item.id)
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
        let accessory = NSStackView(views: [use, delete])
        accessory.orientation = .horizontal
        accessory.alignment = .centerY
        accessory.spacing = 8
        return savedKeyRow(title: item.name, key: item.key, accessory: accessory)
    }

    private func replace(_ stack: NSStackView, with views: [NSView]) {
        for view in stack.arrangedSubviews {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for view in views {
            stack.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }

    private func renderResults() {
        replace(results, with: resultViews())
        syncControls()
        scrollToTop()
    }

    private func resultViews() -> [NSView] {
        guard let report else {
            return [QuotaText.label("查询之后，这里列出每把密钥的 5 小时、本周和本月额度。", size: 12, color: .secondaryLabelColor)]
        }
        var views: [NSView] = report.keys.map { keySection($0) }
        views.append(QuotaText.label(
            "官方用量接口只返回这三个窗口的已用百分比和重置时间，没有调用次数，也没有按模型拆开的消耗，所以这里不再展示模型明细。",
            size: 11,
            color: .secondaryLabelColor,
            lines: 0
        ))
        return views
    }

    private func keySection(_ key: GoQuotaKey) -> NSView {
        let column = NSStackView()
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 16
        if let error = key.error, !key.ok {
            column.addArrangedSubview(QuotaText.label(error, size: 12, color: .systemRed, lines: 0))
        } else if let windows = key.windows {
            let box = GroupBox()
            box.addRow(windowRow("5小时滚动", windows.rolling))
            box.addRow(windowRow("本周", windows.weekly))
            box.addRow(windowRow("本月", windows.monthly))
            column.addArrangedSubview(box)
            if let month = windows.monthly, month.status == "rate-limited" || month.percent >= 100 {
                column.addArrangedSubview(QuotaText.label("本月已限流。", size: 11, color: .systemOrange))
            }
        }
        for view in column.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        let latency = key.latencyMs.map { "接口 \($0) ms" }
        let secret = CopyableSecret(text: key.key, expands: true)
        column.insertArrangedSubview(secret, at: 0)
        secret.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        return SectionView(title: key.name, content: column, footer: latency)
    }

    private func windowRow(_ title: String, _ window: GoQuotaWindow?) -> NSView {
        let heading = QuotaText.label(title, size: 13, weight: .semibold)
        heading.setContentHuggingPriority(.required, for: .horizontal)
        let detail = QuotaText.label(windowDetail(window), size: 12, color: windowColor(window))
        let line = NSStackView(views: [heading, detail])
        line.orientation = .horizontal
        line.alignment = .firstBaseline
        line.spacing = 12
        let meter = UsageMeter()
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

    private func windowDetail(_ window: GoQuotaWindow?) -> String {
        guard let window else { return "没有返回" }
        let used = Int(window.percent.rounded())
        let remain = max(0, 100 - used)
        let state = window.status == "ok" ? "正常" : (window.status == "rate-limited" ? "已限流" : window.status)
        let reset = formatReset(window.resetsAt).map { " · \($0) 重置" } ?? ""
        return "已用 \(used)% · 剩余 \(remain)% · \(state)\(reset)"
    }

    private func windowColor(_ window: GoQuotaWindow?) -> NSColor {
        guard let window else { return .secondaryLabelColor }
        if window.status == "rate-limited" || window.percent >= 100 { return .systemRed }
        if window.percent >= 80 { return .systemOrange }
        return .secondaryLabelColor
    }

    private func meterColor(_ window: GoQuotaWindow?) -> NSColor {
        guard let window else { return .controlAccentColor }
        if window.status == "rate-limited" || window.percent >= 90 { return .systemRed }
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
        if let range = text.range(of: #"(?:oc_sk_|sk-)[A-Za-z0-9_-]{6,}"#, options: .regularExpression) {
            return text.replacingCharacters(in: range, with: "…")
        }
        return text
    }
}

private enum QuotaText {
    static func label(
        _ text: String,
        size: CGFloat,
        weight: NSFont.Weight = .regular,
        color: NSColor = .labelColor,
        lines: Int = 1,
        align: NSTextAlignment = .left
    ) -> NSView {
        if lines != 1 {
            return WrappingLabel(text: text, font: .systemFont(ofSize: size, weight: weight), color: color, align: align)
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

private final class WrappingLabel: NSView {
    private let field = NSTextField(wrappingLabelWithString: "")

    init(text: String, font: NSFont, color: NSColor, align: NSTextAlignment = .left, lines: Int = 4) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.stringValue = text
        field.font = font
        field.textColor = color
        field.alignment = align
        field.maximumNumberOfLines = lines
        field.preferredMaxLayoutWidth = 180
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.translatesAutoresizingMaskIntoConstraints = false
        addSubview(field)
        NSLayoutConstraint.activate([
            field.topAnchor.constraint(equalTo: topAnchor),
            field.leadingAnchor.constraint(equalTo: leadingAnchor),
            field.trailingAnchor.constraint(equalTo: trailingAnchor),
            field.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var intrinsicContentSize: NSSize {
        field.intrinsicContentSize
    }

    override func layout() {
        super.layout()
        let width = bounds.width
        guard width > 1, abs(field.preferredMaxLayoutWidth - width) > 0.5 else { return }
        field.preferredMaxLayoutWidth = width
        invalidateIntrinsicContentSize()
    }
}

private final class UsageMeter: NSView {
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
