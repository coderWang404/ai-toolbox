// 监控 ~/.codex/config.toml：cc-switch（或其它工具）改写配置后自动触发热重启。
//
// 只对「供应商相关」的那部分做指纹：应用每次启动都会重写 mcp_servers / tui /
// plugins 等段落，如果直接 hash 整个文件，热重启 → 应用改写 config → 再重启，
// 会变成不停重启的死循环。
import Foundation
import CryptoKit

final class ConfigWatcher {
    private let configPath: String
    private let queue = DispatchQueue(label: "ai-toolbox.watcher")
    private var timer: DispatchSourceTimer?
    private var lastHash: String?
    private var pendingWork: DispatchWorkItem?
    private var lastReloadAt: Date?
    private static let cooldown: TimeInterval = 4

    /// 检测到供应商变化时回调（主线程）
    var onChanged: (() -> Void)?

    private(set) var isRunning = false

    /// 会触发 app-server 重启的顶层键（与 src/config-fingerprint.mjs 保持一致）。
    private static let providerTopKeys: Set<String> = [
        "model",
        "model_provider",
        "model_reasoning_effort",
        "model_reasoning_summary",
        "model_verbosity",
        "model_context_window",
        "model_auto_compact_token_limit",
        "model_post_turn_compact_threshold_percent",
        "model_catalog_json",
        "service_tier",
        "disable_response_storage",
        "personality",
        "profile",
        "forced_login_method",
        "forced_chatgpt_workspace_id",
    ]

    init(configPath: String) {
        self.configPath = configPath
    }

    func start(interval: TimeInterval = 1.0) {
        guard !isRunning else { return }
        isRunning = true
        lastHash = Self.hashProviderSlice(at: configPath)
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + interval, repeating: interval)
        source.setEventHandler { [weak self] in self?.tick() }
        source.resume()
        timer = source
    }

    func stop() {
        isRunning = false
        timer?.cancel()
        timer = nil
        pendingWork?.cancel()
        pendingWork = nil
    }

    /// 忽略当前内容（用于自身刚刚写入配置后，避免自我触发）。
    func baselineNow() {
        queue.sync { lastHash = Self.hashProviderSlice(at: configPath) }
    }

    private func tick() {
        let current = Self.hashProviderSlice(at: configPath)
        guard let current else { return }
        if lastHash == nil {
            lastHash = current
            return
        }
        guard current != lastHash else { return }

        // 防抖：等文件稳定 300ms 再触发
        pendingWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let stable = Self.hashProviderSlice(at: self.configPath)
            self.lastHash = stable
            // 距上次热重启太近：大概率是应用/目录写入的余波，合并掉，避免连环重启。
            if let last = self.lastReloadAt, Date().timeIntervalSince(last) < Self.cooldown { return }
            self.lastReloadAt = Date()
            DispatchQueue.main.async { self.onChanged?() }
        }
        pendingWork = work
        queue.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    private static func hashProviderSlice(at path: String) -> String? {
        guard let slice = providerSlice(at: path) else { return nil }
        return SHA256.hash(data: Data(slice.utf8)).compactMap { String(format: "%02x", $0) }.joined()
    }

    /// 提取 provider/model 相关的顶层键与所有 [model_providers.*] 表。
    private static func providerSlice(at path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path),
              let text = String(data: data, encoding: .utf8) else { return nil }
        var out: [String] = []
        var inProviderTable = false
        var inOtherTable = false

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("["), trimmed.hasSuffix("]") {
                let name = String(trimmed.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
                inProviderTable = name == "model_providers" || name.hasPrefix("model_providers.")
                inOtherTable = !inProviderTable
                if inProviderTable { out.append("[\(name)]") }
                continue
            }
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            if inProviderTable {
                out.append(trimmed)
                continue
            }
            if inOtherTable { continue }
            if line.hasPrefix(" ") || line.hasPrefix("\t") { continue }
            guard let eq = trimmed.firstIndex(of: "=") else { continue }
            let key = trimmed[..<eq].trimmingCharacters(in: .whitespaces)
            if providerTopKeys.contains(key) { out.append(trimmed) }
        }
        return out.joined(separator: "\n")
    }
}
