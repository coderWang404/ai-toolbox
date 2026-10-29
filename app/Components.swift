// 系统设置风格的分组、行和状态条。
import AppKit
import WebKit

enum Chrome {
    static let groupRadius: CGFloat = 10
    static let pageInset = NSEdgeInsets(top: 52, left: 28, bottom: 28, right: 28)
}

final class GroupBox: NSView {
    let stack = NSStackView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = Chrome.groupRadius
        layer?.masksToBounds = true
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        layer?.borderWidth = dark ? 0.5 : 0
        layer?.borderColor = NSColor.separatorColor.cgColor
    }

    func setRows(_ rows: [NSView]) {
        for view in stack.arrangedSubviews {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for row in rows { addRow(row) }
    }

    func addRow(_ content: NSView) {
        if !stack.arrangedSubviews.isEmpty {
            let line = NSBox()
            line.boxType = .separator
            line.translatesAutoresizingMaskIntoConstraints = false
            let wrap = NSView()
            wrap.addSubview(line)
            NSLayoutConstraint.activate([
                line.leadingAnchor.constraint(equalTo: wrap.leadingAnchor, constant: 14),
                line.trailingAnchor.constraint(equalTo: wrap.trailingAnchor),
                line.centerYAnchor.constraint(equalTo: wrap.centerYAnchor),
                wrap.heightAnchor.constraint(equalToConstant: 1),
            ])
            stack.addArrangedSubview(wrap)
            wrap.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        let padded = NSView()
        content.translatesAutoresizingMaskIntoConstraints = false
        padded.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: padded.topAnchor, constant: 10),
            content.leadingAnchor.constraint(equalTo: padded.leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: padded.trailingAnchor, constant: -14),
            content.bottomAnchor.constraint(equalTo: padded.bottomAnchor, constant: -10),
            padded.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
        ])
        stack.addArrangedSubview(padded)
        padded.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
}

final class SettingRow: NSView {
    init(title: String, subtitle: String? = nil, accessory: NSView) {
        super.init(frame: .zero)
        let titleField = NSTextField(labelWithString: title)
        titleField.font = .systemFont(ofSize: 13)
        titleField.lineBreakMode = .byTruncatingTail
        var texts: [NSView] = [titleField]
        if let subtitle, !subtitle.isEmpty {
            let detail = NSTextField(labelWithString: subtitle)
            detail.font = .systemFont(ofSize: 11)
            detail.textColor = .secondaryLabelColor
            detail.lineBreakMode = .byWordWrapping
            detail.maximumNumberOfLines = 2
            detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            texts.append(detail)
        }
        let textStack = NSStackView(views: texts)
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 2
        textStack.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let row = NSStackView(views: [textStack, NSView(), accessory])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

final class SectionView: NSStackView {
    private var footerLabel: NSTextField?

    init(title: String?, content: NSView, footer: String? = nil) {
        super.init(frame: .zero)
        orientation = .vertical
        alignment = .leading
        spacing = 6
        if let title {
            let label = NSTextField(labelWithString: title)
            label.font = .systemFont(ofSize: 13, weight: .semibold)
            addArrangedSubview(label)
        }
        addArrangedSubview(content)
        content.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        if let footer, !footer.isEmpty {
            let note = NSTextField(wrappingLabelWithString: footer)
            note.font = .systemFont(ofSize: 11)
            note.textColor = .secondaryLabelColor
            note.preferredMaxLayoutWidth = 320
            note.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            addArrangedSubview(note)
            note.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
            footerLabel = note
        }
    }

    override func layout() {
        super.layout()
        guard let footerLabel, bounds.width > 1, footerLabel.preferredMaxLayoutWidth != bounds.width else { return }
        footerLabel.preferredMaxLayoutWidth = bounds.width
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

final class StatusLine: NSView {
    enum Tone { case info, success, warning, error }

    private let icon = NSImageView()
    private let label = NSTextField(wrappingLabelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
        icon.translatesAutoresizingMaskIntoConstraints = false
        label.font = .systemFont(ofSize: 12)
        label.textColor = .secondaryLabelColor
        label.isSelectable = true
        label.maximumNumberOfLines = 3
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let row = NSStackView(views: [icon, label])
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            icon.widthAnchor.constraint(equalToConstant: 14),
        ])
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func set(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            clear()
            return
        }
        let (tone, body) = StatusLine.interpret(trimmed)
        apply(body, tone: tone)
    }

    func set(_ text: String, tone: Tone) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            clear()
            return
        }
        apply(trimmed, tone: tone)
    }

    private func clear() {
        isHidden = true
        label.stringValue = ""
    }

    private func apply(_ body: String, tone: Tone) {
        isHidden = false
        label.stringValue = body
        let symbol: String
        let color: NSColor
        switch tone {
        case .success:
            symbol = "checkmark.circle.fill"
            color = .systemGreen
        case .warning:
            symbol = "exclamationmark.triangle.fill"
            color = .systemOrange
        case .error:
            symbol = "xmark.circle.fill"
            color = .systemRed
        case .info:
            symbol = "info.circle.fill"
            color = .secondaryLabelColor
        }
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        icon.contentTintColor = color
    }

    private static func interpret(_ text: String) -> (Tone, String) {
        let prefixes: [(String, Tone)] = [
            ("❌", .error), ("⚠️", .warning), ("✔", .success), ("⚡", .success), ("ℹ️", .info),
        ]
        for (prefix, tone) in prefixes where text.hasPrefix(prefix) {
            return (tone, String(text.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces))
        }
        if text.hasPrefix("已开启") || text.hasPrefix("已关闭") || text.contains("已一致") || text.contains("已与") {
            return (.success, text)
        }
        if text.hasPrefix("正在") || text.hasPrefix("检测到") {
            return (.info, text)
        }
        return (.info, text)
    }
}

final class FlippedDocumentView: NSView {
    override var isFlipped: Bool { true }
}

final class QuietWebView: WKWebView, WKNavigationDelegate {
    var onContentHeight: ((CGFloat) -> Void)?
    var forwardsWheelToParent = true
    private var lastWidth: CGFloat = -1
    private var measureToken = 0
    private var monitor: Any?

    override init(frame frameRect: NSRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frameRect, configuration: configuration)
        navigationDelegate = self
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            self?.forwardScroll(event) ?? event
        }
    }

    deinit {
        if let monitor { NSEvent.removeMonitor(monitor) }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        let width = bounds.width
        guard width > 1, abs(width - lastWidth) > 0.5 else { return }
        lastWidth = width
        scheduleMeasure()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        lastWidth = bounds.width
        scheduleMeasure()
    }

    private func scheduleMeasure() {
        measureToken += 1
        let token = measureToken
        for delay in [0.0, 0.25, 0.9] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, token == self.measureToken else { return }
                self.measureContentHeight(token: token)
            }
        }
    }

    private func measureContentHeight(token: Int) {
        let script = """
        (function(){
          const doc = document.documentElement;
          const body = document.body;
          const scrollY = window.scrollY || (doc && doc.scrollTop) || 0;
          let bottom = 0;
          if (body) {
            const nodes = body.getElementsByTagName('*');
            for (let i = 0; i < nodes.length; i++) {
              const el = nodes[i];
              const pos = getComputedStyle(el).position;
              if (pos === 'fixed' || pos === 'sticky') continue;
              const edge = el.getBoundingClientRect().bottom + scrollY;
              if (edge > bottom) bottom = edge;
            }
          }
          const scroll = Math.max(
            doc ? doc.scrollHeight : 0,
            body ? body.scrollHeight : 0,
            doc ? doc.offsetHeight : 0,
            body ? body.offsetHeight : 0
          );
          return Math.ceil(Math.max(scroll, bottom));
        })()
        """
        evaluateJavaScript(script) { [weak self] value, _ in
            guard let self, token == self.measureToken else { return }
            let number = (value as? NSNumber)?.doubleValue ?? 0
            guard number > 1 else { return }
            self.onContentHeight?(CGFloat(number))
            self.suppressInnerScrollers()
        }
    }

    private func forwardScroll(_ event: NSEvent) -> NSEvent? {
        guard forwardsWheelToParent, let host = window, event.window === host, host.isVisible, !isHiddenOrHasHiddenAncestor else { return event }
        let point = convert(event.locationInWindow, from: nil)
        guard bounds.contains(point) else { return event }
        guard let outer = superview?.enclosingScrollView else { return event }
        outer.scrollWheel(with: event)
        return nil
    }

    private func suppressInnerScrollers() {
        let selector = NSSelectorFromString("_scrollView")
        if responds(to: selector), let scroll = value(forKey: "_scrollView") as? NSScrollView {
            scroll.hasVerticalScroller = false
            scroll.hasHorizontalScroller = false
            scroll.verticalScrollElasticity = .none
            scroll.horizontalScrollElasticity = .none
            scroll.scrollerStyle = .overlay
            scroll.autohidesScrollers = true
        }
    }
}

final class CopyableSecret: NSView {
    private let secret: String
    private let background = NSView()
    private let preview = NSTextField(labelWithString: "")
    private let copyButton = NSButton()
    private let revealButton = NSButton()
    private var popover: NSPopover?
    private var hovering = false

    init(text: String, expands: Bool = false, masked: Bool = true) {
        secret = text
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        heightAnchor.constraint(equalToConstant: 28).isActive = true
        if expands {
            setContentHuggingPriority(.defaultLow, for: .horizontal)
        } else {
            setContentHuggingPriority(.required, for: .horizontal)
            setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        }

        background.wantsLayer = true
        background.layer?.cornerRadius = 8
        background.layer?.backgroundColor = NSColor.quaternaryLabelColor.withAlphaComponent(0.28).cgColor
        background.translatesAutoresizingMaskIntoConstraints = false
        addSubview(background)

        let glyph = NSImageView()
        glyph.image = NSImage(systemSymbolName: "key.fill", accessibilityDescription: "密钥")
        glyph.contentTintColor = .controlAccentColor
        glyph.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 10, weight: .semibold)
        glyph.setContentHuggingPriority(.required, for: .horizontal)

        preview.stringValue = masked ? Self.masked(text) : text
        preview.font = .monospacedSystemFont(ofSize: 11, weight: .medium)
        preview.textColor = .secondaryLabelColor
        preview.lineBreakMode = .byTruncatingMiddle
        preview.setContentCompressionResistancePriority(expands ? .defaultLow : .required, for: .horizontal)
        preview.toolTip = masked ? "完整密钥可以点眼睛查看，或直接复制" : "点右侧按钮复制"

        styleIcon(revealButton, symbol: "eye", label: "查看完整密钥", action: #selector(reveal))
        styleIcon(copyButton, symbol: "doc.on.doc", label: "复制完整密钥", action: #selector(copySecret))
        revealButton.isHidden = !masked

        let row = NSStackView(views: [glyph, preview, revealButton, copyButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.edgeInsets = NSEdgeInsets(top: 0, left: 8, bottom: 0, right: 4)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            background.topAnchor.constraint(equalTo: topAnchor),
            background.leadingAnchor.constraint(equalTo: leadingAnchor),
            background.trailingAnchor.constraint(equalTo: trailingAnchor),
            background.bottomAnchor.constraint(equalTo: bottomAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            revealButton.widthAnchor.constraint(equalToConstant: 22),
            revealButton.heightAnchor.constraint(equalToConstant: 22),
            copyButton.widthAnchor.constraint(equalToConstant: 22),
            copyButton.heightAnchor.constraint(equalToConstant: 22),
        ])
        if !expands {
            widthAnchor.constraint(lessThanOrEqualToConstant: 210).isActive = true
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = true
        tintBackground(true)
    }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        tintBackground(false)
    }

    private func styleIcon(_ button: NSButton, symbol: String, label: String, action: Selector) {
        button.bezelStyle = .inline
        button.isBordered = false
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        button.imagePosition = .imageOnly
        button.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
        button.contentTintColor = .secondaryLabelColor
        button.target = self
        button.action = action
        button.toolTip = label
        button.wantsLayer = true
    }

    private func tintBackground(_ hot: Bool) {
        let color = hot
            ? NSColor.controlAccentColor.withAlphaComponent(0.16)
            : NSColor.quaternaryLabelColor.withAlphaComponent(0.28)
        let animation = CABasicAnimation(keyPath: "backgroundColor")
        animation.fromValue = background.layer?.backgroundColor
        animation.toValue = color.cgColor
        animation.duration = 0.16
        animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
        background.layer?.add(animation, forKey: "tint")
        background.layer?.backgroundColor = color.cgColor
    }

    @objc private func copySecret() {
        writePasteboard()
        celebrate(copyButton, symbol: "doc.on.doc")
    }

    @objc private func reveal() {
        if let popover, popover.isShown {
            popover.performClose(nil)
            return
        }
        let card = SecretCardController(secret: secret)
        let pop = NSPopover()
        pop.contentViewController = card
        pop.behavior = .transient
        pop.animates = true
        pop.delegate = card
        popover = pop
        pop.show(relativeTo: bounds, of: self, preferredEdge: .minY)
        pulse(revealButton)
    }

    private func writePasteboard() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(secret, forType: .string)
    }

    private func celebrate(_ button: NSButton, symbol: String) {
        button.contentTintColor = .systemGreen
        button.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: "已复制")
        let scale = CASpringAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.65
        scale.toValue = 1
        scale.mass = 0.35
        scale.stiffness = 320
        scale.damping = 11
        scale.duration = scale.settlingDuration
        button.layer?.add(scale, forKey: "pop")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.05) { [weak button] in
            button?.contentTintColor = .secondaryLabelColor
            button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "复制完整密钥")
        }
    }

    private func pulse(_ button: NSButton) {
        let scale = CASpringAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.8
        scale.toValue = 1
        scale.mass = 0.3
        scale.stiffness = 260
        scale.damping = 12
        scale.duration = scale.settlingDuration
        button.layer?.add(scale, forKey: "pulse")
    }

    private static func masked(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 16 else { return trimmed }
        return "\(trimmed.prefix(6))···\(trimmed.suffix(4))"
    }
}

private final class SecretCardController: NSViewController, NSPopoverDelegate {
    private let secret: String
    private let copyButton = NSButton()

    init(secret: String) {
        self.secret = secret
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 168))
        let title = NSTextField(labelWithString: "完整密钥")
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        let hint = NSTextField(labelWithString: "文字可以选中。复制的是整段。")
        hint.font = .systemFont(ofSize: 11)
        hint.textColor = .secondaryLabelColor

        let field = NSTextView()
        field.string = secret
        field.isEditable = false
        field.isSelectable = true
        field.isRichText = false
        field.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        field.textContainerInset = NSSize(width: 8, height: 8)
        field.drawsBackground = false
        field.isAutomaticQuoteSubstitutionEnabled = false
        let scroll = NSScrollView()
        scroll.documentView = field
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = true
        scroll.backgroundColor = NSColor.quaternaryLabelColor.withAlphaComponent(0.2)
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 8
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 72).isActive = true

        copyButton.title = "复制全部"
        copyButton.bezelStyle = .rounded
        copyButton.bezelColor = .controlAccentColor
        copyButton.target = self
        copyButton.action = #selector(copyAll)
        copyButton.wantsLayer = true
        let actions = NSStackView(views: [NSView(), copyButton])
        actions.orientation = .horizontal

        let column = NSStackView(views: [title, hint, scroll, actions])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 6
        column.edgeInsets = NSEdgeInsets(top: 14, left: 14, bottom: 14, right: 14)
        column.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: root.topAnchor),
            column.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            column.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            scroll.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -28),
            actions.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -28),
        ])
        view = root
        preferredContentSize = NSSize(width: 440, height: 168)
    }

    @objc private func copyAll() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(secret, forType: .string)
        copyButton.title = "已复制"
        copyButton.contentTintColor = .systemGreen
        let scale = CASpringAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.92
        scale.toValue = 1
        scale.mass = 0.4
        scale.stiffness = 280
        scale.damping = 12
        scale.duration = scale.settlingDuration
        copyButton.layer?.add(scale, forKey: "pop")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) { [weak self] in
            self?.copyButton.title = "复制全部"
            self?.copyButton.contentTintColor = nil
        }
    }
}

func savedKeyRow(title: String, key: String, accessory: NSView) -> NSView {
    let heading = NSTextField(labelWithString: title)
    heading.font = .systemFont(ofSize: 13, weight: .semibold)
    heading.lineBreakMode = .byTruncatingTail
    let head = NSStackView(views: [heading, NSView(), accessory])
    head.orientation = .horizontal
    head.alignment = .centerY
    head.spacing = 8
    let secret = CopyableSecret(text: key, expands: true)
    let column = NSStackView(views: [head, secret])
    column.orientation = .vertical
    column.alignment = .leading
    column.spacing = 6
    head.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
    secret.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
    return column
}

enum PageChrome {
    static func scroll(title: String, subtitle: String, content: NSView) -> NSScrollView {
        let heading = NSTextField(labelWithString: title)
        heading.font = .systemFont(ofSize: 22, weight: .semibold)
        let detail = NSTextField(wrappingLabelWithString: subtitle)
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = .secondaryLabelColor
        detail.preferredMaxLayoutWidth = 560
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let stack = NSStackView(views: [heading, detail, content])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 0, bottom: 24, right: 0)
        stack.setCustomSpacing(4, after: heading)
        stack.setCustomSpacing(22, after: detail)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let document = FlippedDocumentView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)

        let scroll = NSScrollView()
        scroll.drawsBackground = true
        scroll.backgroundColor = .windowBackgroundColor
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.documentView = document
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let clip = scroll.contentView
        stack.setContentHuggingPriority(.defaultLow, for: .horizontal)
        content.setContentHuggingPriority(.defaultLow, for: .horizontal)
        content.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        NSLayoutConstraint.activate([
            document.topAnchor.constraint(equalTo: clip.topAnchor),
            document.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            document.widthAnchor.constraint(equalTo: clip.widthAnchor),
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -28),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -24),
            content.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        if let body = content as? NSStackView {
            for view in body.arrangedSubviews {
                view.setContentHuggingPriority(.defaultLow, for: .horizontal)
                view.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
            }
        }
        return scroll
    }

    static func primaryButton(_ title: String, action: Selector, target: AnyObject) -> NSButton {
        let button = NSButton(title: title, target: target, action: action)
        button.bezelStyle = .rounded
        button.controlSize = .regular
        button.bezelColor = .controlAccentColor
        button.keyEquivalent = "\r"
        return button
    }

    static func pill(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 10, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.wantsLayer = true
        label.layer?.cornerRadius = 4
        label.layer?.backgroundColor = NSColor.quaternaryLabelColor.withAlphaComponent(0.25).cgColor
        label.alignment = .center
        return label
    }
}
