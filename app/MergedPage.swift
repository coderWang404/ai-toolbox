// 合并页：顶部一个分段控件，下面切换多个子页；每个子页保留自己的滚动位置。
import AppKit

final class MergedPageController: NSObject {
    struct Tab {
        let title: String
        let pane: NSView
        let onShow: () -> Void
    }

    private(set) var root: NSView!
    private(set) var currentIndex: Int
    var onTabChanged: ((Int) -> Void)?

    private let tabs: [Tab]
    private let segmented = NSSegmentedControl()
    private let contentHost = NSView()

    init(title: String, subtitle: String, tabs: [Tab], selected: Int) {
        self.tabs = tabs
        self.currentIndex = tabs.isEmpty ? 0 : min(max(selected, 0), tabs.count - 1)
        super.init()
        root = makeRoot(title: title, subtitle: subtitle)
        apply(index: currentIndex, notify: false, show: false)
    }

    func select(_ index: Int) {
        guard !tabs.isEmpty else { return }
        let target = min(max(index, 0), tabs.count - 1)
        if target == currentIndex {
            tabs[target].onShow()
            return
        }
        apply(index: target, notify: true, show: true)
    }

    func onShow() {
        guard !tabs.isEmpty else { return }
        tabs[currentIndex].onShow()
    }

    var currentTitle: String {
        tabs.isEmpty ? "" : tabs[currentIndex].title
    }

    @objc private func segmentChanged() {
        let index = segmented.selectedSegment
        guard index >= 0, index < tabs.count, index != currentIndex else { return }
        apply(index: index, notify: true, show: true)
    }

    private func apply(index: Int, notify: Bool, show: Bool) {
        currentIndex = index
        segmented.selectedSegment = index
        for (offset, tab) in tabs.enumerated() {
            tab.pane.isHidden = offset != index
        }
        if let scroll = tabs[index].pane as? NSScrollView {
            scrollToTop(scroll)
            DispatchQueue.main.async { [weak self, weak scroll] in
                guard let self, let scroll else { return }
                if self.currentIndex == index { self.scrollToTop(scroll) }
            }
        }
        if show { tabs[index].onShow() }
        if notify { onTabChanged?(index) }
    }

    private func scrollToTop(_ scroll: NSScrollView) {
        guard let document = scroll.documentView else { return }
        let clip = scroll.contentView
        let y = clip.isFlipped ? 0 : max(0, document.bounds.height - clip.bounds.height)
        clip.scroll(to: NSPoint(x: 0, y: y))
        scroll.reflectScrolledClipView(clip)
    }

    private func makeRoot(title: String, subtitle: String) -> NSView {
        let host = NSView()
        host.wantsLayer = true
        host.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        let heading = NSTextField(labelWithString: title)
        heading.font = .systemFont(ofSize: 22, weight: .semibold)
        let detail = MergedSubtitleLabel(wrappingLabelWithString: subtitle)
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = .secondaryLabelColor
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        segmented.segmentStyle = .rounded
        segmented.trackingMode = .selectOne
        segmented.segmentCount = tabs.count
        for (index, tab) in tabs.enumerated() {
            segmented.setLabel(tab.title, forSegment: index)
        }
        segmented.target = self
        segmented.action = #selector(segmentChanged)
        segmented.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        segmented.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)

        let header = NSStackView(views: [heading, detail, segmented])
        header.orientation = .vertical
        header.alignment = .leading
        header.spacing = 4
        header.setCustomSpacing(12, after: detail)
        header.translatesAutoresizingMaskIntoConstraints = false

        contentHost.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(header)
        host.addSubview(contentHost)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: host.topAnchor, constant: 24),
            header.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: 28),
            header.trailingAnchor.constraint(equalTo: host.trailingAnchor, constant: -28),
            segmented.widthAnchor.constraint(lessThanOrEqualTo: header.widthAnchor),
            contentHost.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 10),
            contentHost.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            contentHost.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            contentHost.bottomAnchor.constraint(equalTo: host.bottomAnchor),
        ])

        for tab in tabs {
            tab.pane.translatesAutoresizingMaskIntoConstraints = false
            contentHost.addSubview(tab.pane)
            NSLayoutConstraint.activate([
                tab.pane.topAnchor.constraint(equalTo: contentHost.topAnchor),
                tab.pane.leadingAnchor.constraint(equalTo: contentHost.leadingAnchor),
                tab.pane.trailingAnchor.constraint(equalTo: contentHost.trailingAnchor),
                tab.pane.bottomAnchor.constraint(equalTo: contentHost.bottomAnchor),
            ])
        }
        return host
    }
}

/// 合并页的副标题：跟随可用宽度换行，避免窗口窄时被裁掉。
private final class MergedSubtitleLabel: NSTextField {
    override func layout() {
        super.layout()
        guard bounds.width > 1, abs(preferredMaxLayoutWidth - bounds.width) > 0.5 else { return }
        preferredMaxLayoutWidth = bounds.width
    }
}
