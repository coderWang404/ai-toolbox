// 网络测速页。表盘按实际速度定刻度；历史只留每次的汇总，动画在数字稳住后就停。
import AppKit

private struct SpeedRecord: Codable {
    var at: TimeInterval
    var down: Double
    var up: Double
    var ping: Double?
}

final class SpeedPane: NSObject {
    private(set) var root: NSView!
    var onDetail: ((String) -> Void)?

    private let backend: Backend
    private let gauge = SpeedGauge()
    private let spark = SpeedSpark()
    private let historyChart = SpeedHistoryChart()
    private let downloadCard = MetricCard(title: "下载", tint: .systemTeal)
    private let uploadCard = MetricCard(title: "上传", tint: .systemBlue)
    private let pingCard = MetricCard(title: "延迟", tint: .systemOrange)
    private let cumulativeLabel = NSTextField(wrappingLabelWithString: "这次还没开始。完成后会按时间留在下面。")
    private let historyLabel = NSTextField(wrappingLabelWithString: "")
    private let detailGrid = NSGridView()
    private var fields: [String: NSTextField] = [:]
    private let status = StatusLine()
    private let startButton = NSButton()
    private var testing = false
    private var infoBusy = false
    private var infoTimer: Timer?
    private var samples: [CGFloat] = []
    private var downBytes: Double = 0
    private var upBytes: Double = 0
    private var lastBytesIn: Double?
    private var lastBytesOut: Double?
    private var lastByteSample: Date?
    private var records: [SpeedRecord] = []

    init(backend: Backend) {
        self.backend = backend
        super.init()
        records = Self.loadRecords()
        root = makeRoot()
        renderHistory()
    }

    func onShow() {
        refreshInfo()
        infoTimer?.invalidate()
        let timer = Timer(timeInterval: 8, repeats: true) { [weak self] _ in
            guard let self, !self.testing else { return }
            self.refreshInfo()
        }
        RunLoop.main.add(timer, forMode: .common)
        infoTimer = timer
    }

    func onHide() {
        infoTimer?.invalidate()
        infoTimer = nil
        gauge.stop()
    }

    func sidebarDetail() -> String {
        if testing { return gauge.caption }
        if downloadCard.number != "—" { return "↓ \(downloadCard.number)" }
        return records.isEmpty ? "未测速" : "\(records.count) 次记录"
    }

    private func makeRoot() -> NSView {
        gauge.translatesAutoresizingMaskIntoConstraints = false
        gauge.heightAnchor.constraint(equalToConstant: 156).isActive = true
        startButton.title = "开始测速"
        startButton.bezelStyle = .rounded
        startButton.bezelColor = .controlAccentColor
        startButton.target = self
        startButton.action = #selector(toggleTest)
        let buttonRow = NSStackView(views: [NSView(), startButton, NSView()])
        buttonRow.orientation = .horizontal
        let dialColumn = NSStackView(views: [gauge, buttonRow])
        dialColumn.orientation = .vertical
        dialColumn.alignment = .centerX
        dialColumn.spacing = 4
        gauge.widthAnchor.constraint(equalTo: dialColumn.widthAnchor).isActive = true
        buttonRow.widthAnchor.constraint(equalTo: dialColumn.widthAnchor).isActive = true

        let metricColumn = NSStackView(views: [downloadCard, uploadCard, pingCard])
        metricColumn.orientation = .vertical
        metricColumn.distribution = .fillEqually
        metricColumn.spacing = 8
        metricColumn.translatesAutoresizingMaskIntoConstraints = false
        metricColumn.heightAnchor.constraint(equalToConstant: 196).isActive = true

        let top = NSStackView(views: [dialColumn, metricColumn])
        top.orientation = .horizontal
        top.alignment = .centerY
        top.spacing = 16
        top.translatesAutoresizingMaskIntoConstraints = false
        dialColumn.widthAnchor.constraint(equalTo: top.widthAnchor, multiplier: 0.56).isActive = true

        cumulativeLabel.font = .systemFont(ofSize: 12)
        cumulativeLabel.textColor = .secondaryLabelColor
        cumulativeLabel.maximumNumberOfLines = 2
        let totalBox = GroupBox()
        totalBox.addRow(cumulativeLabel)

        spark.translatesAutoresizingMaskIntoConstraints = false
        spark.heightAnchor.constraint(equalToConstant: 64).isActive = true
        let sparkBox = GroupBox()
        sparkBox.addRow(spark)

        historyChart.translatesAutoresizingMaskIntoConstraints = false
        historyChart.heightAnchor.constraint(equalToConstant: 72).isActive = true
        historyLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        historyLabel.textColor = .secondaryLabelColor
        historyLabel.maximumNumberOfLines = 6
        let historyColumn = NSStackView(views: [historyChart, historyLabel])
        historyColumn.orientation = .vertical
        historyColumn.alignment = .leading
        historyColumn.spacing = 8
        let historyBox = GroupBox()
        historyBox.addRow(historyColumn)

        let specs: [(String, String)] = [
            ("接口", "interface"), ("类型", "kind"),
            ("本机 IPv4", "ipv4"), ("本机 IPv6", "ipv6"),
            ("网关", "gateway"), ("DNS", "dns"),
            ("Wi-Fi", "ssid"), ("链路", "media"),
            ("公网 IP", "publicIP"), ("位置", "place"),
            ("出口节点", "colo"), ("协议", "protocol"),
            ("实时接收", "liveIn"), ("实时发送", "liveOut"),
            ("抖动", "jitter"), ("丢包", "loss"),
        ]
        var gridRows: [[NSView]] = []
        var pair: [NSView] = []
        for spec in specs {
            pair.append(detailCell(spec.0, key: spec.1))
            if pair.count == 2 {
                gridRows.append(pair)
                pair = []
            }
        }
        detailGrid.rowSpacing = 8
        detailGrid.columnSpacing = 18
        detailGrid.translatesAutoresizingMaskIntoConstraints = false
        for (index, row) in gridRows.enumerated() {
            detailGrid.addRow(with: row)
            detailGrid.row(at: index).topPadding = 1
            detailGrid.row(at: index).bottomPadding = 1
        }
        let detailBox = GroupBox()
        detailBox.addRow(detailGrid)

        let body = NSStackView(views: [
            top,
            totalBox,
            SectionView(title: "这一次", content: sparkBox, footer: "线是这一段开始以来的平均速度，不是每一瞬间的跳动。"),
            SectionView(title: "按时间累计", content: historyBox, footer: "只保留最近 48 次的结果。关掉窗口也不会丢。"),
            SectionView(title: "线路", content: detailBox, footer: "下载和上传各约 8 秒。实时收发每 8 秒看一次网卡，测速时先暂停，免得跟测速抢。"),
            status,
        ])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 16
        for view in [top, totalBox, sparkBox, historyBox] {
            view.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        }
        historyChart.widthAnchor.constraint(equalTo: historyColumn.widthAnchor).isActive = true
        return PageChrome.scroll(
            title: "网络测速",
            subtitle: "表盘跟着这次的均速走。下面留着每一次的结果。",
            content: body
        )
    }

    private func detailCell(_ title: String, key: String) -> NSView {
        let caption = NSTextField(labelWithString: title)
        caption.font = .systemFont(ofSize: 11)
        caption.textColor = .secondaryLabelColor
        let value = NSTextField(labelWithString: "—")
        value.font = .systemFont(ofSize: 13, weight: .medium)
        value.lineBreakMode = .byTruncatingMiddle
        value.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        fields[key] = value
        let column = NSStackView(views: [caption, value])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 1
        return column
    }

    @objc private func toggleTest() {
        if testing {
            backend.stopSpeedTest()
            testing = false
            startButton.title = "开始测速"
            gauge.caption = "已停止"
            gauge.stop()
            status.set("已停止")
            onDetail?(sidebarDetail())
            return
        }
        testing = true
        startButton.title = "停止"
        samples = []
        downBytes = 0
        upBytes = 0
        spark.setSamples([])
        gauge.caption = "准备"
        gauge.setSpeed(0)
        cumulativeLabel.stringValue = "正在看线路…"
        status.set("正在看线路…")
        onDetail?(sidebarDetail())
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                try self.backend.runSpeedTest { [weak self] line in
                    DispatchQueue.main.async { self?.apply(line) }
                }
                DispatchQueue.main.async {
                    guard self.testing || self.startButton.title == "停止" else { return }
                    self.testing = false
                    if self.startButton.title == "停止" { self.startButton.title = "再测一次" }
                    if self.gauge.caption != "已停止", self.gauge.caption != "失败" { self.status.set("✔ 测速完成") }
                    self.gauge.stop()
                    self.onDetail?(self.sidebarDetail())
                }
            } catch {
                DispatchQueue.main.async {
                    self.testing = false
                    self.startButton.title = "开始测速"
                    self.gauge.caption = "失败"
                    self.gauge.stop()
                    self.status.set("❌ \(error.localizedDescription)")
                    self.onDetail?(self.sidebarDetail())
                }
            }
        }
    }

    private func refreshInfo() {
        guard !infoBusy else { return }
        infoBusy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let info = try? self.backend.netInfo()
            DispatchQueue.main.async {
                self.infoBusy = false
                guard let info, !self.testing else { return }
                self.showInfo(info)
            }
        }
    }

    private func apply(_ line: String) {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }
        switch type {
        case "info":
            set("interface", object["interfaceName"] as? String)
            set("kind", object["interfaceKind"] as? String)
            set("ipv4", object["localIPv4"] as? String)
            set("ipv6", object["localIPv6"] as? String)
            set("gateway", object["gateway"] as? String)
            if let dns = object["dns"] as? [String] { set("dns", dns.joined(separator: "、")) }
            set("ssid", object["ssid"] as? String)
            set("media", object["media"] as? String)
            noteRates(inn: object["bytesIn"] as? Double, out: object["bytesOut"] as? Double)
            set("publicIP", object["publicIP"] as? String)
            set("place", object["place"] as? String)
            set("colo", object["colo"] as? String)
            set("protocol", object["httpProtocol"] as? String)
        case "phase":
            let phase = object["phase"] as? String
            samples = []
            spark.setSamples([])
            if phase == "ping" {
                gauge.caption = "延迟"
                status.set("正在测延迟…")
            } else if phase == "download" {
                gauge.caption = "下载"
                gauge.setSpeed(0)
                status.set("正在测下载…")
            } else if phase == "upload" {
                gauge.caption = "上传"
                gauge.setSpeed(0)
                status.set("正在测上传…")
            }
            onDetail?(sidebarDetail())
        case "ping":
            if let ms = object["ms"] as? Double {
                pingCard.set(Self.milliseconds(ms), unit: "ms")
                gauge.caption = "延迟"
            }
        case "latency":
            if let ms = object["pingMs"] as? Double { pingCard.set(Self.milliseconds(ms), unit: "ms") }
            if let jitter = object["jitterMs"] as? Double { set("jitter", "\(Self.milliseconds(jitter)) ms") }
            if let loss = object["loss"] as? Double { set("loss", "\(Int((loss * 100).rounded()))%") }
        case "sample":
            let average = object["averageMbps"] as? Double ?? object["mbps"] as? Double ?? 0
            gauge.setSpeed(average)
            samples.append(CGFloat(average))
            if samples.count > 36 { samples.removeFirst(samples.count - 36) }
            spark.setSamples(samples)
            let text = Self.mbps(average)
            let bytes = object["bytes"] as? Double ?? 0
            if object["phase"] as? String == "upload" {
                uploadCard.set(text, unit: "Mbps")
                upBytes = bytes
            } else {
                downloadCard.set(text, unit: "Mbps")
                downBytes = bytes
            }
            refreshCumulative()
        case "done":
            let down = object["downloadMbps"] as? Double ?? 0
            let up = object["uploadMbps"] as? Double ?? 0
            let ping = object["pingMs"] as? Double
            downloadCard.set(Self.mbps(down), unit: "Mbps")
            uploadCard.set(Self.mbps(up), unit: "Mbps")
            if let ping { pingCard.set(Self.milliseconds(ping), unit: "ms") }
            gauge.caption = "完成"
            gauge.setSpeed(down)
            remember(down: down, up: up, ping: ping)
            testing = false
            startButton.title = "再测一次"
            onDetail?(sidebarDetail())
        case "error":
            gauge.caption = "失败"
            gauge.stop()
            status.set("❌ \(object["message"] as? String ?? "测速失败")")
        default:
            break
        }
    }

    private func refreshCumulative() {
        cumulativeLabel.stringValue = "这次累计  下载 \(Self.bytes(downBytes)) · 均速 \(downloadCard.number) Mbps    上传 \(Self.bytes(upBytes)) · 均速 \(uploadCard.number) Mbps"
    }

    private func showInfo(_ info: NetInfo) {
        set("interface", info.interfaceName)
        set("kind", info.interfaceKind)
        set("ipv4", info.localIPv4)
        set("ipv6", info.localIPv6)
        set("gateway", info.gateway)
        set("dns", info.dns?.joined(separator: "、"))
        set("ssid", info.ssid)
        set("media", info.media)
        noteRates(inn: info.bytesIn, out: info.bytesOut)
        set("publicIP", info.publicIP)
        set("place", info.place)
        set("colo", info.colo)
        set("protocol", info.httpProtocol)
    }

    private func noteRates(inn: Double?, out: Double?) {
        let now = Date()
        if let lastBytesIn, let lastBytesOut, let lastByteSample, let inn, let out {
            let dt = now.timeIntervalSince(lastByteSample)
            if dt > 0.4 {
                let down = (inn - lastBytesIn) * 8 / dt / 1_000_000
                let up = (out - lastBytesOut) * 8 / dt / 1_000_000
                if down >= 0 { set("liveIn", "\(Self.mbps(down)) Mbps") }
                if up >= 0 { set("liveOut", "\(Self.mbps(up)) Mbps") }
            }
        }
        lastBytesIn = inn
        lastBytesOut = out
        lastByteSample = now
    }

    private func remember(down: Double, up: Double, ping: Double?) {
        records.append(SpeedRecord(at: Date().timeIntervalSince1970, down: down, up: up, ping: ping))
        if records.count > 48 { records.removeFirst(records.count - 48) }
        Self.saveRecords(records)
        renderHistory()
    }

    private func renderHistory() {
        historyChart.setRecords(records)
        if records.isEmpty {
            historyLabel.stringValue = "还没有记录。"
            return
        }
        let downs = records.map(\.down)
        let ups = records.map(\.up)
        let meanDown = downs.reduce(0, +) / Double(downs.count)
        let meanUp = ups.reduce(0, +) / Double(ups.count)
        let head = "共 \(records.count) 次 · 下载均值 \(Self.mbps(meanDown)) · 上传均值 \(Self.mbps(meanUp)) · 下载峰值 \(Self.mbps(downs.max() ?? 0))"
        let lines = records.suffix(5).reversed().map { record -> String in
            let when = Self.clock.string(from: Date(timeIntervalSince1970: record.at))
            let ping = record.ping.map { "  延迟 \(Self.milliseconds($0)) ms" } ?? ""
            return "\(when)   ↓ \(Self.mbps(record.down))   ↑ \(Self.mbps(record.up))\(ping)"
        }
        historyLabel.stringValue = ([head] + lines).joined(separator: "\n")
    }

    private func set(_ key: String, _ value: String?) {
        let next = (value?.isEmpty == false) ? value! : "—"
        guard fields[key]?.stringValue != next else { return }
        fields[key]?.stringValue = next
    }

    private static func mbps(_ value: Double) -> String {
        if value >= 100 { return String(format: "%.0f", value) }
        if value >= 10 { return String(format: "%.1f", value) }
        return String(format: "%.2f", value)
    }

    private static func milliseconds(_ value: Double) -> String {
        value >= 100 ? String(format: "%.0f", value) : String(format: "%.1f", value)
    }

    private static func bytes(_ value: Double) -> String {
        if value >= 1_000_000 { return String(format: "%.1f MB", value / 1_000_000) }
        if value >= 1_000 { return String(format: "%.0f KB", value / 1_000) }
        return "\(Int(value)) B"
    }

    private static let clock: DateFormatter = {
        let format = DateFormatter()
        format.locale = Locale(identifier: "zh_CN")
        format.dateFormat = "M月d日 HH:mm"
        return format
    }()

    private static func historyURL() -> URL {
        AppPaths.dataFile("speed-history.json")
    }

    private static func loadRecords() -> [SpeedRecord] {
        guard let data = try? Data(contentsOf: historyURL()) else { return [] }
        return (try? JSONDecoder().decode([SpeedRecord].self, from: data)) ?? []
    }

    private static func saveRecords(_ records: [SpeedRecord]) {
        let url = historyURL()
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(records) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

private final class MetricCard: NSView {
    private let numberField = NSTextField(labelWithString: "—")
    private let unitField = NSTextField(labelWithString: "")
    private(set) var number = "—"

    init(title: String, tint: NSColor) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 10
        let caption = NSTextField(labelWithString: title)
        caption.font = .systemFont(ofSize: 11, weight: .medium)
        caption.textColor = tint
        numberField.font = .monospacedDigitSystemFont(ofSize: 22, weight: .semibold)
        unitField.font = .systemFont(ofSize: 11)
        unitField.textColor = .secondaryLabelColor
        let row = NSStackView(views: [numberField, unitField])
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 4
        let column = NSStackView(views: [caption, row])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 1
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            column.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
            column.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
    }

    func set(_ value: String, unit: String) {
        guard number != value || unitField.stringValue != unit else { return }
        number = value
        numberField.stringValue = value
        unitField.stringValue = unit
    }
}

private final class SpeedGauge: NSView {
    var caption = "准备" { didSet { if oldValue != caption { needsDisplay = true } } }
    private var shown: CGFloat = 0
    private var targetMbps: CGFloat = 0
    private var scale: CGFloat = 5
    private var timer: Timer?
    private let steps: [CGFloat] = [5, 10, 20, 50, 100, 200, 500, 1000]

    func setSpeed(_ mbps: Double) {
        targetMbps = CGFloat(max(0, mbps))
        fitScale()
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        shown = targetMbps
        needsDisplay = true
    }

    private func tick() {
        shown += (targetMbps - shown) * 0.35
        if abs(targetMbps - shown) < 0.05 {
            shown = targetMbps
            timer?.invalidate()
            timer = nil
        }
        needsDisplay = true
    }

    private func fitScale() {
        let needed = max(targetMbps, shown, 0.2)
        let next = steps.first { needed <= $0 * 0.82 } ?? 1000
        if next > scale || needed < scale * 0.28 { scale = next }
    }

    override func draw(_ dirtyRect: NSRect) {
        let radius = min(bounds.width * 0.36, bounds.height * 0.62)
        let center = NSPoint(x: bounds.midX, y: bounds.minY + radius * 0.42 + 18)
        let sweep: CGFloat = 220
        let start: CGFloat = 200
        let fraction = scale > 0 ? min(1, max(0, shown / scale)) : 0

        let track = NSBezierPath()
        track.lineWidth = 10
        track.lineCapStyle = .round
        NSColor.quaternaryLabelColor.withAlphaComponent(0.55).setStroke()
        track.appendArc(withCenter: center, radius: radius, startAngle: start, endAngle: start - sweep, clockwise: true)
        track.stroke()

        if fraction > 0.015 {
            let arc = NSBezierPath()
            arc.lineWidth = 10
            arc.lineCapStyle = .round
            NSColor.controlAccentColor.setStroke()
            arc.appendArc(withCenter: center, radius: radius, startAngle: start, endAngle: start - sweep * fraction, clockwise: true)
            arc.stroke()
        }

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let measuring = caption == "下载" || caption == "上传" || caption == "完成"
        let number = shown >= 100 ? String(format: "%.0f", shown) : (shown >= 10 ? String(format: "%.1f", shown) : String(format: "%.2f", shown))
        let big = NSAttributedString(string: measuring ? number : "—", attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 34, weight: .semibold),
            .foregroundColor: NSColor.labelColor,
            .paragraphStyle: paragraph,
        ])
        let unit = NSAttributedString(string: measuring ? "Mbps" : "", attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .medium),
            .foregroundColor: NSColor.secondaryLabelColor,
            .paragraphStyle: paragraph,
        ])
        let phase = NSAttributedString(string: caption, attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.controlAccentColor,
            .paragraphStyle: paragraph,
        ])
        big.draw(in: NSRect(x: center.x - 70, y: center.y + 6, width: 140, height: 40))
        unit.draw(in: NSRect(x: center.x - 50, y: center.y - 10, width: 100, height: 16))
        phase.draw(in: NSRect(x: center.x - 60, y: center.y + 46, width: 120, height: 16))

        drawEnd("0", angle: start, radius: radius + 16, center: center)
        drawEnd(Self.tick(scale), angle: start - sweep, radius: radius + 16, center: center)
    }

    private func drawEnd(_ text: String, angle: CGFloat, radius: CGFloat, center: NSPoint) {
        let radians = angle * .pi / 180
        let point = NSPoint(x: center.x + cos(radians) * radius, y: center.y + sin(radians) * radius)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .medium),
            .foregroundColor: NSColor.tertiaryLabelColor,
        ]
        let size = (text as NSString).size(withAttributes: attributes)
        (text as NSString).draw(at: NSPoint(x: point.x - size.width / 2, y: point.y - size.height / 2), withAttributes: attributes)
    }

    private static func tick(_ scale: CGFloat) -> String {
        scale >= 100 ? String(format: "%.0f", scale) : String(format: "%.0f", scale)
    }
}

private final class SpeedSpark: NSView {
    private var samples: [CGFloat] = []

    func setSamples(_ values: [CGFloat]) {
        samples = values
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let baseline = bounds.minY + 6
        NSColor.quaternaryLabelColor.withAlphaComponent(0.4).setStroke()
        let base = NSBezierPath()
        base.lineWidth = 1
        base.move(to: NSPoint(x: 0, y: baseline))
        base.line(to: NSPoint(x: bounds.width, y: baseline))
        base.stroke()
        guard samples.count > 1 else { return }
        let peak = max(samples.max() ?? 1, 1)
        let step = bounds.width / CGFloat(max(samples.count - 1, 1))
        let path = NSBezierPath()
        path.lineWidth = 2
        path.lineJoinStyle = .round
        path.lineCapStyle = .round
        for (index, sample) in samples.enumerated() {
            let point = NSPoint(x: CGFloat(index) * step, y: baseline + (bounds.height - 14) * (sample / peak))
            if index == 0 { path.move(to: point) } else { path.line(to: point) }
        }
        NSColor.controlAccentColor.setStroke()
        path.stroke()
    }
}

private final class SpeedHistoryChart: NSView {
    private var records: [SpeedRecord] = []

    func setRecords(_ values: [SpeedRecord]) {
        records = Array(values.suffix(24))
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard !records.isEmpty else { return }
        let peak = max(records.map { max($0.down, $0.up) }.max() ?? 1, 1)
        let slot = bounds.width / CGFloat(records.count)
        let bar = max(2, min(6, slot * 0.28))
        let usable = bounds.height - 4
        for (index, record) in records.enumerated() {
            let x = CGFloat(index) * slot + slot * 0.5
            NSColor.systemTeal.withAlphaComponent(0.9).setFill()
            NSBezierPath(rect: NSRect(x: x - bar - 0.5, y: 2, width: bar, height: max(2, usable * CGFloat(record.down / peak)))).fill()
            NSColor.systemBlue.withAlphaComponent(0.75).setFill()
            NSBezierPath(rect: NSRect(x: x + 0.5, y: 2, width: bar, height: max(2, usable * CGFloat(record.up / peak)))).fill()
        }
    }
}
