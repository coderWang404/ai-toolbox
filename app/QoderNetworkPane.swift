// Qoder 网络页：状态显示 + 一键修复/还原。
import AppKit

final class QoderNetworkPane: NSObject {
    private(set) var root: NSView!
    var onDetail: ((String) -> Void)?

    private let backend: Backend
    private var statusInfo: QoderStatusResult?
    private var busy = false

    private let appBox = GroupBox()
    private let dnsBox = GroupBox()
    private let clashBox = GroupBox()
    private let actionBox = GroupBox()
    private let status = StatusLine()
    private let issuesLabel = NSTextField(wrappingLabelWithString: "")
    private let actionStatus = StatusLine()
    private let spinner = NSProgressIndicator()
    private let refreshButton = NSButton()
    private let fixButton = NSButton()
    private let restoreButton = NSButton()
    private let restartButton = NSButton()
    private let openButton = NSButton()

    init(backend: Backend) {
        self.backend = backend
        super.init()
        root = makeRoot()
    }

    func onShow() {
        guard !busy else { return }
        refresh()
    }

    func sidebarDetail() -> String {
        guard let statusInfo else { return "读取 Qoder 网络" }
        switch statusInfo.health {
        case "ok": return "网络正常"
        case "broken": return "网络异常"
        default: return "需要检查"
        }
    }

    private func makeRoot() -> NSView {
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
        issuesLabel.maximumNumberOfLines = 4
        status.translatesAutoresizingMaskIntoConstraints = false

        let body = NSStackView(views: [
            status,
            issuesLabel,
            SectionView(title: "Qoder CN", content: appBox),
            SectionView(title: "DNS 与入口", content: dnsBox, footer: "固定入口是 8.153.206.47；系统 DNS 和 Clash DNS 不一致时，说明 hosts/Clash 没有对齐。"),
            SectionView(title: "Clash", content: clashBox, footer: "TUN + fake-IP 下要让 Clash 使用系统 hosts，并且把 Qoder 域名/IP 放到直连规则最前面。"),
            SectionView(title: "管理", content: actionBox),
            actionStatus,
        ])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 22
        issuesLabel.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        status.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        actionStatus.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        return PageChrome.scroll(
            title: "Qoder 网络",
            subtitle: "查看 Qoder CN 的 DNS、hosts、Clash 和 HTTPDNS 状态，并一键修复。",
            content: body
        )
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
                    self.actionStatus.set("已刷新 · \(info.checkedAt ?? "")", tone: .info)
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
                    if let info = result.status {
                        self.applyStatus(info)
                    }
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

    private func applyStatus(_ info: QoderStatusResult) {
        statusInfo = info
        switch info.health {
        case "ok":
            status.set("✔ Qoder 网络正常", tone: .success)
        case "broken":
            status.set("❌ Qoder 网络异常", tone: .error)
        default:
            status.set("⚠️ Qoder 网络需要检查", tone: .warning)
        }
        issuesLabel.stringValue = (info.issues ?? []).isEmpty ? "没有发现明显问题。" : (info.issues ?? []).joined(separator: "\n")
        renderApp()
        renderDNS()
        renderClash()
        syncControls()
        onDetail?(sidebarDetail())
    }

    private func renderApp() {
        guard let info = statusInfo else { return }
        let app = info.app
        var rows: [NSView] = [
            SettingRow(
                title: "应用",
                subtitle: app?.running == true ? "运行中（\(app?.pids?.count ?? 0) 个进程）" : "未运行",
                accessory: label(app?.installed == true ? "已安装 · \(app?.version ?? "-")" : "未安装")
            ),
            SettingRow(title: "网络模式", accessory: label(info.log?.networkMode ?? "-")),
            SettingRow(title: "HTTPDNS", accessory: label(info.log?.httpdnsConfigured == true ? "已启用" : "已关闭")),
            SettingRow(title: "最近模型请求", accessory: label(info.log?.lastModelStatus.map(String.init) ?? "-")),
        ]
        if let error = info.log?.lastError, !error.isEmpty {
            let field = NSTextField(wrappingLabelWithString: error)
            field.font = .systemFont(ofSize: 11)
            field.textColor = .secondaryLabelColor
            field.maximumNumberOfLines = 2
            rows.append(SettingRow(title: "最近错误", accessory: field))
        }
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
            let ok = endpoint.reachable == true
            rows.append(SettingRow(
                title: "\(endpoint.name) · \(endpoint.via ?? "")",
                accessory: pill(statusText, ok: ok)
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

    private func dnsText(_ group: QoderDNSGroup?) -> String {
        let gateway = group?.gateway?.joined(separator: ", ") ?? "-"
        let openapi = group?.openapi?.joined(separator: ", ") ?? "-"
        return "gateway \(gateway) · openapi \(openapi)"
    }

    private func yesNo(_ value: Bool?) -> NSTextField {
        let field = NSTextField(labelWithString: value == true ? "是" : "否")
        field.font = .systemFont(ofSize: 12)
        field.textColor = value == true ? .systemGreen : .secondaryLabelColor
        return field
    }

    private func pill(_ text: String, ok: Bool) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: 11, weight: .medium)
        field.textColor = ok ? .systemGreen : .systemRed
        return field
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
