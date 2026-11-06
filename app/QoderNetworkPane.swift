// Qoder 网络页：本机状态 + 可折叠详情 + 远程 Qoder 状态/管理。
import AppKit

final class QoderNetworkPane: NSObject {
    private(set) var root: NSView!
    var onDetail: ((String) -> Void)?

    private let backend: Backend
    private let embedded: Bool
    private var statusInfo: QoderStatusResult?
    private var remoteReport: QoderRemoteReport?
    private var busy = false
    private var remoteBusy = false
    private var remoteLoaded = false
    private var expandedRemoteHost: String?
    private var needsTopScroll = false

    private let appBox = GroupBox()
    private let dnsBox = GroupBox()
    private let clashBox = GroupBox()
    private let logBox = GroupBox()
    private let actionBox = GroupBox()
    private let status = StatusLine()
    private let issuesLabel = NSTextField(wrappingLabelWithString: "")
    private let actionStatus = StatusLine()
    private let remoteStatus = StatusLine()
    private let remoteList = NSStackView()
    private let remoteSummary = NSTextField(wrappingLabelWithString: "")
    private let spinner = NSProgressIndicator()
    private let remoteSpinner = NSProgressIndicator()
    private let refreshButton = NSButton()
    private let fixButton = NSButton()
    private let restoreButton = NSButton()
    private let restartButton = NSButton()
    private let openButton = NSButton()
    private let remoteRefreshButton = NSButton()
    private var localSection: QoderSection!
    private var remoteSection: QoderSection!

    init(backend: Backend, embedded: Bool = false) {
        self.backend = backend
        self.embedded = embedded
        super.init()
        root = makeRoot()
    }

    func onShow() {
        needsTopScroll = true
        scrollToTop()
        guard !busy else { return }
        refresh()
    }

    private func scrollToTop() {
        guard let scroll = root as? NSScrollView else { return }
        let clip = scroll.contentView
        clip.scroll(to: .zero)
        scroll.reflectScrolledClipView(clip)
    }

    func sidebarDetail() -> String {
        guard let statusInfo else { return "网络状态" }
        let local = statusInfo.health == "ok" ? "本机正常" : "本机需检查"
        if let remoteReport, let summary = remoteReport.summary {
            return "\(local) · 远程 \(summary.ok)/\(summary.total)"
        }
        return local
    }

    private func makeRoot() -> NSView {
        configureButtons()
        let firstRow = NSStackView(views: [spinner, refreshButton, openButton, restartButton])
        firstRow.orientation = .horizontal
        firstRow.spacing = 8
        firstRow.alignment = .centerY
        let secondRow = NSStackView(views: [fixButton, restoreButton])
        secondRow.orientation = .horizontal
        secondRow.spacing = 8
        secondRow.alignment = .centerY
        actionBox.addRow(SettingRow(
            title: "维护",
            subtitle: "修复会写入 /etc/hosts（系统会要求管理员授权）、调整 Clash 增强规则并重启 Qoder",
            accessory: firstRow
        ))
        actionBox.addRow(SettingRow(title: "一键操作", subtitle: "可随时还原到未修改状态", accessory: secondRow))

        issuesLabel.font = .systemFont(ofSize: 12)
        issuesLabel.textColor = .secondaryLabelColor
        issuesLabel.maximumNumberOfLines = 3

        let localContent = NSStackView(views: [
            sectionLabel("DNS 与入口"),
            dnsBox,
            sectionLabel("Clash"),
            clashBox,
            sectionLabel("日志"),
            logBox,
        ])
        localContent.orientation = .vertical
        localContent.alignment = .leading
        localContent.spacing = 10
        dnsBox.widthAnchor.constraint(equalTo: localContent.widthAnchor).isActive = true
        clashBox.widthAnchor.constraint(equalTo: localContent.widthAnchor).isActive = true
        logBox.widthAnchor.constraint(equalTo: localContent.widthAnchor).isActive = true
        localSection = QoderSection(
            title: "本机详情",
            summary: "hosts · DNS · Clash · 入口探测",
            content: localContent,
            expanded: false
        )

        remoteSummary.font = .systemFont(ofSize: 11)
        remoteSummary.textColor = .secondaryLabelColor
        remoteSummary.maximumNumberOfLines = 3
        remoteList.orientation = .vertical
        remoteList.alignment = .leading
        remoteList.spacing = 8
        remoteRefreshButton.title = "检查远程"
        remoteRefreshButton.bezelStyle = .rounded
        remoteRefreshButton.target = self
        remoteRefreshButton.action = #selector(refreshRemote)
        remoteSpinner.style = .spinning
        remoteSpinner.controlSize = .small
        remoteSpinner.isDisplayedWhenStopped = false
        let remoteTools = NSStackView(views: [remoteSpinner, remoteRefreshButton])
        remoteTools.orientation = .horizontal
        remoteTools.spacing = 8
        remoteTools.alignment = .centerY
        let remoteContent = NSStackView(views: [remoteSummary, remoteTools, remoteList, remoteStatus])
        remoteContent.orientation = .vertical
        remoteContent.alignment = .leading
        remoteContent.spacing = 8
        remoteList.widthAnchor.constraint(equalTo: remoteContent.widthAnchor).isActive = true
        remoteStatus.widthAnchor.constraint(equalTo: remoteContent.widthAnchor).isActive = true
        remoteSummary.widthAnchor.constraint(equalTo: remoteContent.widthAnchor).isActive = true
        remoteSection = QoderSection(
            title: "远程 Qoder",
            summary: "展开时检查，不占用本机加载时间",
            content: remoteContent,
            expanded: ProcessInfo.processInfo.environment["AI_TOOLBOX_QODER_REMOTE_OPEN"] == "1",
            onExpand: { [weak self] in
                self?.loadRemoteStatusIfNeeded()
                self?.scrollRemoteIntoView()
            }
        )

        let body = NSStackView(views: [
            status,
            issuesLabel,
            SectionView(title: "Qoder CN", content: appBox),
            SectionView(title: "管理", content: actionBox),
            remoteSection,
            localSection,
            actionStatus,
        ])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 22
        for view in [status as NSView, issuesLabel as NSView, localSection as NSView, remoteSection as NSView, actionStatus as NSView] {
            view.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        }
        if embedded { return PageChrome.embeddedScroll(content: body) }
        return PageChrome.scroll(
            title: "Qoder 网络",
            subtitle: "本机 Qoder CN 与远程机器的 DNS、Clash、HTTPDNS 状态；详情按需展开。",
            content: body
        )
    }

    private func configureButtons() {
        refreshButton.title = "刷新"
        fixButton.title = "一键修复"
        restoreButton.title = "恢复默认"
        restartButton.title = "重启 Qoder"
        openButton.title = "打开 Qoder"
        for button in [refreshButton, fixButton, restoreButton, restartButton, openButton] {
            button.bezelStyle = .rounded
            button.target = self
        }
        fixButton.bezelColor = .controlAccentColor
        refreshButton.action = #selector(refresh)
        fixButton.action = #selector(fixNetwork)
        restoreButton.action = #selector(restoreNetwork)
        restartButton.action = #selector(restartQoder)
        openButton.action = #selector(openQoder)
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
    }

    private func sectionLabel(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        label.textColor = .secondaryLabelColor
        return label
    }

    @objc private func refresh() {
        guard !busy else { return }
        busy = true
        syncControls()
        actionStatus.set("正在读取 Qoder 网络…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let info = try self.backend.qoderStatus()
                DispatchQueue.main.async {
                    self.busy = false
                    self.applyStatus(info)
                    self.syncControls()
                    self.actionStatus.set("已刷新 · \(self.localTime(info.checkedAt))", tone: .info)
                    if self.remoteSection.isExpanded {
                        self.loadRemoteStatusIfNeeded(force: true)
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.actionStatus.set("❌ \(error.localizedDescription)", tone: .error)
                }
            }
        }
    }

    private func applyStatus(_ info: QoderStatusResult) {
        statusInfo = info
        switch info.health {
        case "ok":
            status.set("✔ Qoder 本机网络正常", tone: .success)
        case "broken":
            status.set("❌ Qoder 本机网络异常", tone: .error)
        default:
            status.set("⚠️ Qoder 本机网络需要检查", tone: .warning)
        }
        issuesLabel.stringValue = (info.issues ?? []).isEmpty ? "没有发现明显问题。" : (info.issues ?? []).joined(separator: "\n")
        localSection.setSummary("hosts \(info.hosts?.pinned == true ? "已固定" : "未固定") · HTTPDNS \(info.httpdns?.disabled == true ? "关闭" : "开启") · Clash \(info.clash?.qoderRules == true ? "直连规则已生效" : "缺少规则")")
        renderApp()
        renderDNS()
        renderClash()
        renderLog()
        syncControls()
        if needsTopScroll {
            needsTopScroll = false
            DispatchQueue.main.async { [weak self] in self?.scrollToTop() }
        }
        onDetail?(sidebarDetail())
    }

    private func renderApp() {
        guard let info = statusInfo else { return }
        let rows: [NSView] = [
            SettingRow(
                title: "应用",
                subtitle: info.app?.running == true ? "运行中（\(info.app?.pids?.count ?? 0) 个进程）" : "未运行",
                accessory: label(info.app?.installed == true ? "已安装 · \(info.app?.version ?? "-")" : "未安装")
            ),
            SettingRow(title: "网络模式", accessory: label(info.log?.networkMode ?? "-")),
            SettingRow(title: "HTTPDNS", accessory: label(info.log?.httpdnsConfigured == true ? "已启用" : "已关闭")),
        ]
        appBox.setRows(rows)
    }

    private func renderDNS() {
        guard let info = statusInfo else { return }
        let hosts = info.hosts
        let entries = (hosts?.entries ?? []).map { "\($0.ip) \($0.domain)" }.joined(separator: "\n")
        var rows: [NSView] = [
            SettingRow(
                title: "hosts",
                subtitle: entries.isEmpty ? "没有 Qoder 条目" : entries,
                accessory: pill(hosts?.pinned == true ? "已固定" : "未固定", ok: hosts?.pinned == true)
            ),
            SettingRow(title: "系统 DNS", accessory: label(dnsText(info.dns?.system))),
            SettingRow(title: "Clash DNS", accessory: label(dnsText(info.dns?.clash))),
            SettingRow(title: "fake-IP", accessory: pill(info.dns?.fakeIP == true ? "检测到" : "未检测到", ok: info.dns?.fakeIP != true)),
        ]
        for endpoint in info.endpoints ?? [] {
            let statusText: String
            if let code = endpoint.status {
                statusText = "\(code) · \(endpoint.timeMs ?? 0) ms · \(endpoint.remoteIP ?? "-")"
            } else {
                statusText = endpoint.error ?? "不可达"
            }
            rows.append(SettingRow(
                title: "\(endpoint.name) · \(endpoint.via ?? "")",
                accessory: pill(statusText, ok: endpoint.reachable == true)
            ))
        }
        dnsBox.setRows(rows)
    }

    private func renderClash() {
        guard let info = statusInfo else { return }
        let clash = info.clash
        let rows: [NSView] = [
            SettingRow(
                title: "Clash",
                subtitle: clash?.running == true ? "运行中" : "未运行",
                accessory: label(clash?.installed == true ? "已安装" : "未安装")
            ),
            SettingRow(title: "TUN", accessory: yesNo(clash?.tunEnabled)),
            SettingRow(title: "fake-IP", accessory: yesNo(clash?.fakeIP)),
            SettingRow(title: "使用系统 hosts", accessory: yesNo(clash?.useSystemHosts)),
            SettingRow(title: "Qoder 直连规则", accessory: label(clash?.qoderRules == true ? "已生效 · index \(clash?.ruleIndex ?? 0)" : "缺失")),
            SettingRow(title: "当前配置", accessory: label(clash?.profile ?? "-")),
            SettingRow(title: "当前节点", accessory: label(clash?.node ?? "-")),
        ]
        clashBox.setRows(rows)
    }

    private func renderLog() {
        guard let info = statusInfo else { return }
        var rows: [NSView] = [
            SettingRow(title: "最近运行", subtitle: info.log?.latestRun, accessory: label(localTime(info.log?.updatedAt))),
            SettingRow(title: "最近模型请求", accessory: label(info.log?.lastModelStatus.map(String.init) ?? "-")),
        ]
        if let error = info.log?.lastError, !error.isEmpty {
            let field = NSTextField(wrappingLabelWithString: error)
            field.font = .systemFont(ofSize: 11)
            field.textColor = .secondaryLabelColor
            field.maximumNumberOfLines = 3
            rows.append(SettingRow(title: "最近错误", accessory: field))
        }
        logBox.setRows(rows)
    }

    private func scrollRemoteIntoView() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
            guard let self,
                  let scroll = self.root as? NSScrollView,
                  let document = scroll.documentView,
                  let section = self.remoteSection else { return }
            let origin = section.convert(NSPoint.zero, to: document)
            let clip = scroll.contentView
            let y = max(0, origin.y - 16)
            clip.scroll(to: NSPoint(x: 0, y: y))
            scroll.reflectScrolledClipView(clip)
        }
    }

    private func loadRemoteStatusIfNeeded(force: Bool = false) {
        if remoteBusy { return }
        if remoteLoaded && !force { return }
        remoteBusy = true
        remoteSpinner.startAnimation(nil)
        remoteRefreshButton.isEnabled = false
        remoteStatus.set("正在通过 SSH 检查远程机器…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let report = try self.backend.qoderRemoteStatus()
                DispatchQueue.main.async {
                    self.remoteBusy = false
                    self.remoteLoaded = true
                    self.remoteReport = report
                    self.remoteSpinner.stopAnimation(nil)
                    self.remoteRefreshButton.isEnabled = true
                    self.renderRemote()
                }
            } catch {
                DispatchQueue.main.async {
                    self.remoteBusy = false
                    self.remoteSpinner.stopAnimation(nil)
                    self.remoteRefreshButton.isEnabled = true
                    self.remoteStatus.set("❌ \(error.localizedDescription)", tone: .error)
                }
            }
        }
    }

    @objc private func refreshRemote() {
        loadRemoteStatusIfNeeded(force: true)
    }

    private func renderRemote() {
        for view in remoteList.arrangedSubviews {
            remoteList.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        guard let report = remoteReport else {
            remoteSummary.stringValue = "还没有检查。"
            remoteStatus.set("展开远程 Qoder 或点「检查远程」开始。")
            return
        }
        if report.configured != true {
            remoteSummary.stringValue = "未配置远程机器：\(report.file ?? "~/.ai-toolbox/qoder-remotes.json")"
            remoteStatus.set("在 qoder-remotes.json 里添加 host / label / proxy / role 后再检查。", tone: .info)
            return
        }
        if ProcessInfo.processInfo.environment["AI_TOOLBOX_QODER_REMOTE_DETAIL"] == "1", expandedRemoteHost == nil, let first = report.hosts?.first {
            expandedRemoteHost = first.host
        }
        if let summary = report.summary {
            remoteSummary.stringValue = "配置：\(report.file ?? "-") · 检查：\(localTime(report.checkedAt))"
            remoteStatus.set(summary.broken > 0 ? "有机器异常，展开对应机器查看。" : "远程状态已读取。", tone: summary.broken > 0 ? .warning : .info)
            remoteSection.setSummary("\(summary.ok)/\(summary.total) 正常 · \(summary.warning) 需检查 · \(summary.broken) 异常")
        }
        for (index, host) in (report.hosts ?? []).enumerated() {
            let row = remoteHostRow(host, index: index)
            remoteList.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: remoteList.widthAnchor).isActive = true
            if expandedRemoteHost == host.host {
                let detail = remoteHostDetail(host)
                remoteList.addArrangedSubview(detail)
                detail.widthAnchor.constraint(equalTo: remoteList.widthAnchor).isActive = true
            }
        }
        onDetail?(sidebarDetail())
    }

    private func remoteHostRow(_ host: QoderRemoteHostInfo, index: Int) -> NSView {
        let name = NSTextField(labelWithString: host.label ?? host.host)
        name.font = .systemFont(ofSize: 13, weight: .medium)
        let meta = NSTextField(labelWithString: [host.hostname, host.user, host.latencyMs.map { "\($0) ms" }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
        meta.font = .systemFont(ofSize: 11)
        meta.textColor = .secondaryLabelColor
        let column = NSStackView(views: [name, meta])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 1
        let pill = healthPill(host.health)
        let detail = NSButton(title: expandedRemoteHost == host.host ? "收起" : "详情", target: self, action: #selector(toggleRemoteHost(_:)))
        detail.bezelStyle = .rounded
        detail.controlSize = .small
        detail.tag = index
        let row = NSStackView(views: [column, NSView(), pill, detail])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        column.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return row
    }

    @objc private func toggleRemoteHost(_ sender: NSButton) {
        guard let hosts = remoteReport?.hosts, sender.tag >= 0, sender.tag < hosts.count else { return }
        let host = hosts[sender.tag]
        expandedRemoteHost = expandedRemoteHost == host.host ? nil : host.host
        renderRemote()
    }

    private func remoteHostDetail(_ host: QoderRemoteHostInfo) -> NSView {
        var rows: [NSView] = [
            SettingRow(title: "安装 / 包装", accessory: label("\(host.installs ?? 0) / \(host.wrapped ?? 0)")),
            SettingRow(title: "watcher", accessory: pill(host.watcher ?? "-", ok: host.watcher == "active")),
            SettingRow(title: "runtime", accessory: label("\(host.runtime ?? 0) 个进程")),
            SettingRow(title: "hosts", accessory: pill("\(host.hostsCount ?? 0) 条", ok: (host.hostsCount ?? 0) >= 4)),
            SettingRow(title: "HTTPDNS", accessory: pill(host.httpdnsOff == true ? "已关闭" : "未确认", ok: host.httpdnsOff == true)),
            SettingRow(title: "直连入口", accessory: endpointPill(host.endpointDirectCode, host.endpointDirectTimeMs)),
            SettingRow(title: "代理入口", accessory: endpointPill(host.endpointProxyCode, host.endpointProxyTimeMs)),
        ]
        if let proxy = host.proxy, !proxy.isEmpty {
            rows.append(SettingRow(title: "代理", subtitle: proxy, accessory: pill(host.wrapperProxy?.contains(proxy) == true ? "已配置" : "未配置", ok: host.wrapperProxy?.contains(proxy) == true)))
        }
        if let role = host.role, role == "proxy" {
            rows.append(SettingRow(title: "代理服务", accessory: pill(host.proxyService ?? "-", ok: host.proxyService == "active")))
        }
        if let issues = host.issues, !issues.isEmpty {
            let note = NSTextField(wrappingLabelWithString: issues.joined(separator: "；"))
            note.font = .systemFont(ofSize: 11)
            note.textColor = .systemOrange
            note.maximumNumberOfLines = 3
            rows.append(SettingRow(title: "问题", accessory: note))
        }
        let actions = NSStackView(views: [
            actionButton("重新包装", host: host.host, action: "wrap"),
            actionButton("重启 watcher", host: host.host, action: "restart-watcher"),
            actionButton("重启 worker", host: host.host, action: "restart-worker"),
            host.role == "proxy" ? actionButton("重启代理", host: host.host, action: "restart-proxy") : NSView(),
        ])
        actions.orientation = .horizontal
        actions.spacing = 6
        actions.alignment = .centerY
        rows.append(actions)
        let box = GroupBox()
        box.setRows(rows)
        return box
    }

    private func actionButton(_ title: String, host: String, action: String) -> NSButton {
        let button = NSButton(title: title, target: self, action: #selector(runRemoteAction(_:)))
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.identifier = NSUserInterfaceItemIdentifier("\(host)|\(action)")
        return button
    }

    @objc private func runRemoteAction(_ sender: NSButton) {
        guard !remoteBusy, let raw = sender.identifier?.rawValue else { return }
        let parts = raw.split(separator: "|", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return }
        remoteBusy = true
        remoteSpinner.startAnimation(nil)
        remoteRefreshButton.isEnabled = false
        remoteStatus.set("正在对 \(parts[0]) 执行 \(parts[1])…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.backend.qoderRemoteAction(host: parts[0], action: parts[1])
                DispatchQueue.main.async {
                    self.remoteBusy = false
                    self.remoteSpinner.stopAnimation(nil)
                    self.remoteRefreshButton.isEnabled = true
                    if result.ok {
                        self.remoteStatus.set("✔ \(parts[0]) \(parts[1]) 完成", tone: .success)
                    } else {
                        self.remoteStatus.set("❌ \(result.error ?? "远程操作失败")", tone: .error)
                    }
                    if let status = result.status {
                        self.remoteReport = status
                        self.renderRemote()
                    } else {
                        self.loadRemoteStatusIfNeeded(force: true)
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.remoteBusy = false
                    self.remoteSpinner.stopAnimation(nil)
                    self.remoteRefreshButton.isEnabled = true
                    self.remoteStatus.set("❌ \(error.localizedDescription)", tone: .error)
                }
            }
        }
    }

    @objc private func fixNetwork() {
        guard !busy else { return }
        let alert = NSAlert()
        alert.messageText = "应用 Qoder 网络修复？"
        alert.informativeText = """
        将执行：
        · 写入 /etc/hosts（系统会弹出管理员授权）
        · 关闭 Qoder HTTPDNS 并安装开机 LaunchAgent
        · 给 Clash 增加 Qoder 直连规则、使用系统 hosts
        · 清理 Qoder DNS 缓存并重启 Qoder
        """
        alert.alertStyle = .warning
        alert.addButton(withTitle: "应用修复")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        runAction(title: "正在应用 Qoder 网络修复…") { try $0.qoderFix() }
    }

    @objc private func restoreNetwork() {
        guard !busy else { return }
        let alert = NSAlert()
        alert.messageText = "恢复 Qoder 默认网络？"
        alert.informativeText = "会移除 hosts 固定、删除 HTTPDNS LaunchAgent、移除 Clash 里的 Qoder 规则，并重启 Qoder。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "恢复默认")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        runAction(title: "正在恢复 Qoder 默认网络…") { try $0.qoderRestore() }
    }

    @objc private func restartQoder() {
        guard !busy else { return }
        runAction(title: "正在重启 Qoder…") { try $0.qoderRestart() }
    }

    @objc private func openQoder() {
        guard !busy else { return }
        runAction(title: "正在打开 Qoder…") { try $0.qoderOpen() }
    }

    private func runAction(title: String, operation: @escaping (Backend) throws -> QoderActionResult) {
        busy = true
        syncControls()
        actionStatus.set(title, tone: .info)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try operation(self.backend)
                DispatchQueue.main.async {
                    self.busy = false
                    if let info = result.status { self.applyStatus(info) }
                    let steps = (result.steps ?? []).map { step -> String in
                        let state = step.ok == false ? "失败" : (step.skipped == true ? "跳过" : "完成")
                        let detail = step.message.map { "（\($0)）" } ?? ""
                        return "\(step.step) \(state)\(detail)"
                    }.joined(separator: " · ")
                    let message = result.message ?? result.error
                    if result.ok {
                        self.actionStatus.set("✔ \(steps.isEmpty ? "完成" : steps)", tone: .success)
                    } else {
                        self.actionStatus.set("❌ \(message ?? steps)", tone: .error)
                    }
                    self.syncControls()
                    self.onDetail?(self.sidebarDetail())
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.syncControls()
                    self.actionStatus.set("❌ \(error.localizedDescription)", tone: .error)
                }
            }
        }
    }

    private func dnsText(_ group: QoderDNSGroup?) -> String {
        let gateway = group?.gateway?.joined(separator: ", ") ?? "-"
        let openapi = group?.openapi?.joined(separator: ", ") ?? "-"
        return "gateway \(gateway) · openapi \(openapi)"
    }

    private func healthPill(_ health: String?) -> NSTextField {
        let text: String
        let ok: Bool
        switch health {
        case "ok": text = "正常"; ok = true
        case "warning": text = "需检查"; ok = false
        case "broken": text = "异常"; ok = false
        default: text = "未知"; ok = false
        }
        return pill(text, ok: ok, warning: health == "warning")
    }

    private func endpointPill(_ code: Int?, _ timeMs: Int?) -> NSTextField {
        guard let code, code > 0 else { return pill("不可达", ok: false) }
        return pill("\(code) · \(timeMs ?? 0) ms", ok: code < 500)
    }

    private func yesNo(_ value: Bool?) -> NSTextField {
        let field = NSTextField(labelWithString: value == true ? "是" : "否")
        field.font = .systemFont(ofSize: 12)
        field.textColor = value == true ? .systemGreen : .secondaryLabelColor
        return field
    }

    private func pill(_ text: String, ok: Bool, warning: Bool = false) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: 11, weight: .medium)
        field.textColor = ok ? .systemGreen : (warning ? .systemOrange : .systemRed)
        return field
    }

    private func localTime(_ iso: String?) -> String {
        guard let iso else { return "-" }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? {
            let fallback = ISO8601DateFormatter()
            fallback.formatOptions = [.withInternetDateTime]
            return fallback.date(from: iso)
        }()
        guard let date else { return iso }
        let formatter = DateFormatter()
        formatter.dateFormat = "MM-dd HH:mm:ss"
        return formatter.string(from: date)
    }

    private func label(_ text: String?) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text ?? "-")
        field.font = .systemFont(ofSize: 12)
        field.textColor = .secondaryLabelColor
        field.maximumNumberOfLines = 2
        return field
    }

    private func syncControls() {
        refreshButton.isEnabled = !busy
        fixButton.isEnabled = !busy
        restoreButton.isEnabled = !busy
        restartButton.isEnabled = !busy
        openButton.isEnabled = !busy
        if busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
    }
}

private final class QoderSection: NSStackView {
    private let content: NSView
    private let sectionTitle: String
    private let titleButton = NSButton()
    private let summaryLabel = NSTextField(labelWithString: "")
    private let onExpand: (() -> Void)?
    private(set) var isExpanded: Bool

    init(title: String, summary: String, content: NSView, expanded: Bool, onExpand: (() -> Void)? = nil) {
        self.content = content
        self.sectionTitle = title
        self.onExpand = onExpand
        self.isExpanded = expanded
        super.init(frame: .zero)
        orientation = .vertical
        alignment = .leading
        spacing = 8
        titleButton.bezelStyle = .inline
        titleButton.isBordered = false
        titleButton.font = .systemFont(ofSize: 13, weight: .semibold)
        titleButton.target = self
        titleButton.action = #selector(toggle)
        summaryLabel.stringValue = summary
        summaryLabel.font = .systemFont(ofSize: 11)
        summaryLabel.textColor = .secondaryLabelColor
        summaryLabel.lineBreakMode = .byTruncatingTail
        let header = NSStackView(views: [titleButton, summaryLabel, NSView()])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 8
        summaryLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        addArrangedSubview(header)
        addArrangedSubview(content)
        header.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        content.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        update(notify: false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setSummary(_ text: String) {
        summaryLabel.stringValue = text
    }

    @objc private func toggle() {
        isExpanded.toggle()
        update(notify: true)
    }

    private func update(notify: Bool) {
        titleButton.title = isExpanded ? "▾  \(sectionTitle)" : "▸  \(sectionTitle)"
        content.isHidden = !isExpanded
        if isExpanded, notify { onExpand?() }
    }
}
