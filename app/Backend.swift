// 后端桥接：定位 Node 与内置脚本，执行 CLI 命令并解析 JSON。
import Foundation
import Darwin

enum BackendError: LocalizedError {
    case nodeNotFound
    case scriptNotFound
    case commandFailed(String)
    case badOutput(String)

    var errorDescription: String? {
        switch self {
        case .nodeNotFound:
            return "未找到 Node.js。请安装 Node 18+ 或在本 App 的设置中指定路径。"
        case .scriptNotFound:
            return "未找到内置的 ai-toolbox 脚本，App 可能未完整打包。"
        case .commandFailed(let message):
            return message
        case .badOutput(let raw):
            return "无法解析命令输出: \(raw.prefix(200))"
        }
    }
}

final class Backend {
    static let shared = Backend()

    /// 记录 watchdog 是否真的触发过（用于给出明确的「命令超时」而不是解析失败）。
    private final class TimeoutLatch: @unchecked Sendable {
        private let lock = NSLock()
        private var fired = false
        func fire() { lock.lock(); fired = true; lock.unlock() }
        var isFired: Bool { lock.lock(); defer { lock.unlock() }; return fired }
    }

    private(set) var nodePath: String?
    private(set) var scriptPath: String?
    private var controlledProcess: Process?
    private var controlledStdin: FileHandle?
    private var grokProcess: Process?
    private var grokStderr = ""
    private var speedProcess: Process?
    private var speedCancelled = false
    private var todayProcess: Process?
    private var todayStderr = ""
    private let processLock = NSLock()
    private var activeProcesses: [Process] = []

    static let defaultGrokPort = 8765

    var grokGatewayPort: Int {
        let stored = UserDefaults.standard.integer(forKey: "grokPort")
        return (1024...65535).contains(stored) ? stored : Self.defaultGrokPort
    }

    var grokGatewayBaseURL: String {
        "http://127.0.0.1:\(grokGatewayPort)/v1"
    }

    private init() {
        nodePath = Self.resolveNodePath()
        scriptPath = Self.resolveScriptPath()
    }

    // MARK: - 路径解析

    static func resolveScriptPath() -> String? {
        // 1. 环境变量覆盖（开发调试用）
        if let override = ProcessInfo.processInfo.environment["AI_TOOLBOX_SCRIPT"],
           FileManager.default.isExecutableFile(atPath: override) || FileManager.default.fileExists(atPath: override) {
            return override
        }
        // 2. App 内置副本
        if let resource = Bundle.main.resourceURL {
            let bundled = resource.appendingPathComponent("ai-toolbox/bin/ai-toolbox.mjs").path
            if FileManager.default.fileExists(atPath: bundled) { return bundled }
        }
        return nil
    }

    static func resolveNodePath() -> String? {
        let fm = FileManager.default
        let home = NSHomeDirectory()

        if let override = UserDefaults.standard.string(forKey: "nodePath"), !override.isEmpty,
           fm.isExecutableFile(atPath: override) {
            return override
        }

        let fixed = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.local/bin/node",
            "\(home)/.bun/bin/node",
        ]
        for path in fixed where fm.isExecutableFile(atPath: path) { return path }

        // nvm：取版本号最大的一个
        let nvmRoot = "\(home)/.nvm/versions/node"
        if let versions = try? fm.contentsOfDirectory(atPath: nvmRoot) {
            let sorted = versions.sorted { lhs, rhs in
                lhs.compare(rhs, options: .numeric) == .orderedDescending
            }
            for version in sorted {
                let candidate = "\(nvmRoot)/\(version)/bin/node"
                if fm.isExecutableFile(atPath: candidate) { return candidate }
            }
        }

        // fnm
        let fnmRoot = "\(home)/Library/Application Support/fnm/node-versions"
        if let versions = try? fm.contentsOfDirectory(atPath: fnmRoot) {
            for version in versions.sorted(by: >) {
                let candidate = "\(fnmRoot)/\(version)/installation/bin/node"
                if fm.isExecutableFile(atPath: candidate) { return candidate }
            }
        }

        // 登录 shell 兜底（GUI App 不继承终端 PATH）
        if let shellNode = Self.nodeFromLoginShell() { return shellNode }
        return nil
    }

    private static func nodeFromLoginShell() -> String? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-ilc", "command -v node"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) { return path }
        return nil
    }

    // MARK: - 执行

    private func environment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let extraPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        if let existing = env["PATH"], !existing.isEmpty {
            env["PATH"] = "\(extraPath):\(existing)"
        } else {
            env["PATH"] = extraPath
        }
        env["LANG"] = "zh_CN.UTF-8"
        env["GROKBOT_PORT"] = String(grokGatewayPort)
        return env
    }

    /// 同步执行 CLI（内部会切到后台线程由调用方负责）。
    /// - Parameter withSecrets: 只有 App 里确实要复制/展示完整密钥的调用才传 true。
    func run(_ arguments: [String], stdin: Data? = nil, timeout: TimeInterval = 90, withSecrets: Bool = false) throws -> Data {
        guard let nodePath else { throw BackendError.nodeNotFound }
        guard let scriptPath else { throw BackendError.scriptNotFound }
        if ProcessInfo.processInfo.environment["AI_TOOLBOX_DEBUG"] != nil {
            FileHandle.standardError.write("RUN \(nodePath) \(scriptPath) \(arguments)\n".data(using: .utf8)!)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        var args = [scriptPath] + arguments + ["--json"]
        if withSecrets { args.append("--with-secrets") }
        process.arguments = args
        process.environment = environment()

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        let input = Pipe()
        if stdin != nil { process.standardInput = input }

        try process.run()
        track(process)
        defer { untrack(process) }
        if let stdin {
            // 写 stdin 放到后台，先让 stdout/stderr 的读取器跑起来，避免大请求体互相堵死。
            DispatchQueue.global(qos: .utility).async {
                try? input.fileHandleForWriting.write(contentsOf: stdin)
                try? input.fileHandleForWriting.close()
            }
        }

        let deadline = DispatchTime.now() + timeout
        let timeoutLatch = TimeoutLatch()
        let watchdog = DispatchWorkItem {
            if process.isRunning {
                timeoutLatch.fire()
                process.terminate()
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                }
            }
        }
        DispatchQueue.global().asyncAfter(deadline: deadline, execute: watchdog)
        defer { watchdog.cancel() }

        var outData = Data()
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            outData = stdout.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            errData = stderr.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        process.waitUntilExit()
        group.wait()

        if timeoutLatch.isFired {
            let command = arguments.dropFirst().prefix(2).joined(separator: " ")
            throw BackendError.commandFailed(
                "命令超时（\(Int(timeout))s）已终止：ai-toolbox \(command)。运行 ai-toolbox current 可查看当前配置状态。"
            )
        }

        if ProcessInfo.processInfo.environment["AI_TOOLBOX_DEBUG"] != nil {
            FileHandle.standardError.write("EXIT \(process.terminationStatus) out=\(outData.count)B err=\(errData.count)B\n".data(using: .utf8)!)
        }

        let stdoutText = String(data: outData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let payloadError = Self.jsonError(in: outData)
        if process.terminationStatus != 0 {
            let stderrText = String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let message = payloadError ?? (stderrText.isEmpty ? "命令执行失败（退出码 \(process.terminationStatus)）" : stderrText)
            throw BackendError.commandFailed(Self.redacted(message))
        }
        // 有些命令会以 exit 0 返回 {ok:false}；统一当成失败，避免界面显示“✔ 已切换”。
        if let payloadError {
            throw BackendError.commandFailed(Self.redacted(payloadError))
        }
        if stdoutText.isEmpty {
            throw BackendError.badOutput("命令没有输出")
        }
        return outData
    }

    private static func jsonError(in data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ok = object["ok"] as? Bool, ok == false else {
            return nil
        }
        if let message = object["error"] as? String, !message.isEmpty { return message }
        return "命令返回 ok=false"
    }

    /// 错误文案里可能带出 CLI 原始 JSON（含 token），统一打码。
    static func redacted(_ text: String) -> String {
        var value = text
        let patterns = [
            "(?i)bearer\\s+[A-Za-z0-9._-]{8,}",
            "(?i)(?:sk|oc_sk|grok)_[A-Za-z0-9_-]{8,}",
            "(?i)\"(?:token|refreshToken|apiKey|key)\"\\s*:\\s*\"[^\"]+\"",
        ]
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern) {
                value = regex.stringByReplacingMatches(
                    in: value,
                    range: NSRange(value.startIndex..., in: value),
                    withTemplate: "…"
                )
            }
        }
        return value
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        do {
            return try decoder.decode(type, from: data)
        } catch {
            let raw = String(data: data, encoding: .utf8) ?? ""
            throw BackendError.badOutput(Self.redacted(raw))
        }
    }

    // MARK: - 便捷命令

    func list() throws -> ListResult {
        try decode(ListResult.self, from: run(["list"], withSecrets: true))
    }

    func current() throws -> CurrentResult {
        try decode(CurrentResult.self, from: run(["current"], timeout: 25, withSecrets: true))
    }

    func switchProvider(_ identifier: String, scope: String, focus: Bool, force: Bool = false, remote: Bool = true) throws -> SwitchResult {
        var args = ["switch", identifier, "--scope", scope]
        if !focus { args.append("--no-focus") }
        if force { args.append("--force") }
        if !remote { args.append("--no-remote") }
        return try decode(SwitchResult.self, from: run(args, timeout: 180))
    }

    func switchProviderProgress(
        _ identifier: String,
        scope: String,
        focus: Bool,
        force: Bool = false,
        remote: Bool = true,
        onProgress: @escaping (String) -> Void
    ) throws -> SwitchResult {
        var args = ["switch", identifier, "--scope", scope]
        if !focus { args.append("--no-focus") }
        if force { args.append("--force") }
        if !remote { args.append("--no-remote") }
        let data = try runStreaming(args, timeout: 180) { chunk in
            for line in chunk.split(separator: "\n") {
                onProgress(String(line))
            }
        }
        return try decode(SwitchResult.self, from: data)
    }

    func reload(scope: String, focus: Bool = true, remote: Bool = true) throws -> ReloadResult {
        var args = ["reload", "--scope", scope]
        if !focus { args.append("--no-focus") }
        if !remote { args.append("--no-remote") }
        return try decode(ReloadResult.self, from: run(args, timeout: 180))
    }

    func claudeList() throws -> ClaudeListResult {
        try decode(ClaudeListResult.self, from: run(["claude-list"], timeout: 30))
    }

    func claudeCurrent() throws -> ClaudeCurrentResult {
        try decode(ClaudeCurrentResult.self, from: run(["claude-current"], timeout: 30))
    }

    func claudeSwitch(_ id: String) throws -> ClaudeSwitchResult {
        try decode(ClaudeSwitchResult.self, from: run(["claude-switch", id], timeout: 60))
    }

    /// 检查远端 Codex / cc-switch CLI 版本。
    func remoteVersions() throws -> RemoteVersionsResult {
        try decode(RemoteVersionsResult.self, from: run(["remote-versions"], timeout: 180))
    }

    /// 查看 Codex 项目状态是否被账号隔离寄存。
    func projectState() throws -> ProjectStateReport {
        try decode(ProjectStateReport.self, from: run(["project-state"], timeout: 30))
    }

    /// 把被寄存的项目 / 会话归属恢复到 Codex 界面（Codex 需退出；force 允许运行中写入）。
    func repairProjects(force: Bool = false) throws -> ProjectStateReport {
        var args = ["repair-projects"]
        if force { args.append("--force") }
        return try decode(ProjectStateReport.self, from: run(args, timeout: 60))
    }

    func doctor() throws -> DoctorResult {
        try decode(DoctorResult.self, from: run(["doctor"], timeout: 40))
    }

    func remoteStatus() throws -> RemoteSyncInfo {
        let result = try decode(RemoteStatusResult.self, from: run(["remote-status"], timeout: 40, withSecrets: true))
        return result.remote
    }

    func iqList() throws -> IqListResult {
        try decode(IqListResult.self, from: run(["iq-list"], timeout: 45))
    }

    func iqRun(_ provider: String, model: String, thinking: String, topic: String, onProgress: @escaping (String) -> Void) throws -> IqRunResult {
        let data = try runStreaming(["iq-run", provider, "--model", model, "--thinking", thinking, "--topic", topic], timeout: 1000, control: true, onStderr: onProgress)
        let result = try decode(IqRunResult.self, from: data)
        if result.ok == false {
            throw BackendError.commandFailed(result.error ?? "测试没有完成")
        }
        return result
    }

    func iqControl(_ command: String) {
        guard command == "pause" || command == "resume" || command == "cancel" else { return }
        guard let stdin = controlledStdin, let process = controlledProcess, process.isRunning else { return }
        let line = Data("{\"cmd\":\"\(command)\"}\n".utf8)
        try? stdin.write(contentsOf: line)
        if command == "cancel" {
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                if process.isRunning { process.terminate() }
            }
        }
    }

    func runStreaming(_ arguments: [String], timeout: TimeInterval, control: Bool = false, onStderr: @escaping (String) -> Void) throws -> Data {
        guard let nodePath else { throw BackendError.nodeNotFound }
        guard let scriptPath else { throw BackendError.scriptNotFound }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [scriptPath] + arguments + ["--json"]
        process.environment = environment()
        let stdout = Pipe()
        let stderr = Pipe()
        let stdin = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        if control {
            process.standardInput = stdin
            controlledProcess = process
            controlledStdin = stdin.fileHandleForWriting
        }
        let errHandle = stderr.fileHandleForReading
        // stderr 是逐块到达的，必须自己做行缓冲：IQ 的 STATE/HTML 标记可能被拆成多块。
        let errLock = NSLock()
        var errBuffer = ""
        errHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            errLock.lock()
            errBuffer += text
            var lines: [String] = []
            while let range = errBuffer.range(of: "\n") {
                lines.append(String(errBuffer[..<range.lowerBound]))
                errBuffer.removeSubrange(..<range.upperBound)
            }
            errLock.unlock()
            if !lines.isEmpty {
                let payload = lines.joined(separator: "\n") + "\n"
                DispatchQueue.main.async { onStderr(payload) }
            }
        }
        try process.run()
        track(process)
        let deadline = DispatchTime.now() + timeout
        let timeoutLatch = TimeoutLatch()
        let watchdog = DispatchWorkItem {
            if process.isRunning {
                timeoutLatch.fire()
                process.terminate()
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                }
            }
        }
        DispatchQueue.global().asyncAfter(deadline: deadline, execute: watchdog)
        defer {
            watchdog.cancel()
            untrack(process)
            errHandle.readabilityHandler = nil
            if control {
                try? stdin.fileHandleForWriting.close()
                controlledStdin = nil
                controlledProcess = nil
            }
        }
        var outData = Data()
        let outGroup = DispatchGroup()
        outGroup.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            outData = stdout.fileHandleForReading.readDataToEndOfFile()
            outGroup.leave()
        }
        process.waitUntilExit()
        outGroup.wait()

        errLock.lock()
        let tail = errBuffer
        errBuffer = ""
        errLock.unlock()
        if !tail.isEmpty {
            DispatchQueue.main.async { onStderr(tail) }
        }
        if timeoutLatch.isFired {
            let command = arguments.dropFirst().prefix(2).joined(separator: " ")
            throw BackendError.commandFailed(
                "命令超时（\(Int(timeout))s）已终止：ai-toolbox \(command)。运行 ai-toolbox current 可查看当前配置状态。"
            )
        }
        if process.terminationStatus != 0 {
            let message = Self.jsonError(in: outData)
                ?? String(data: outData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                ?? ""
            throw BackendError.commandFailed(Self.redacted(message.isEmpty ? "测试没有完成" : message))
        }
        if let payloadError = Self.jsonError(in: outData) {
            throw BackendError.commandFailed(Self.redacted(payloadError))
        }
        return outData
    }

    func ccSwitchFingerprint() throws -> String {
        try decode(FingerprintResult.self, from: run(["ccswitch-fingerprint"], timeout: 20)).fingerprint
    }

    func syncCcSwitch(hosts: [String]? = nil) throws -> CcSwitchSyncResult {
        var args = ["sync-ccswitch"]
        for host in hosts ?? [] {
            args.append("--host")
            args.append(host)
        }
        return try decode(CcSwitchSyncResult.self, from: run(args, timeout: 90))
    }

    func goKeys() throws -> GoKeyListResult {
        try decode(GoKeyListResult.self, from: run(["go-keys"], timeout: 20, withSecrets: true))
    }

    func goKeysAdd(name: String, key: String, plan: String) throws -> GoKeyListResult {
        try goKeysWrite(["go-keys-add"], payload: ["name": name, "key": key, "plan": plan])
    }

    func goKeysImport(text: String, plan: String) throws -> GoKeyListResult {
        try goKeysWrite(["go-keys-add"], payload: ["text": text, "plan": plan])
    }

    func goKeysRemove(_ id: String) throws -> GoKeyListResult {
        try decode(GoKeyListResult.self, from: run(["go-keys-remove", id], timeout: 20, withSecrets: true))
    }

    func goKeysPlan(_ id: String, plan: String) throws -> GoKeyListResult {
        try decode(GoKeyListResult.self, from: run(["go-keys-plan", id, plan], timeout: 20, withSecrets: true))
    }

    func goKeysUse(_ id: String) throws -> GoKeyUseResult {
        let result = try decode(GoKeyUseResult.self, from: run(["go-keys-use", id], timeout: 90))
        if !result.ok {
            throw BackendError.commandFailed(result.error ?? "切换密钥失败")
        }
        return result
    }

    func clineKeys() throws -> ClineKeyListResult {
        try decode(ClineKeyListResult.self, from: run(["cline-keys"], timeout: 20, withSecrets: true))
    }

    func clineKeysAdd(name: String, key: String) throws -> ClineKeyListResult {
        try clineKeysWrite(["cline-keys-add"], payload: ["name": name, "key": key])
    }

    func clineKeysImport(text: String) throws -> ClineKeyListResult {
        try clineKeysWrite(["cline-keys-add"], payload: ["text": text])
    }

    func clineKeysRemove(_ id: String) throws -> ClineKeyListResult {
        try decode(ClineKeyListResult.self, from: run(["cline-keys-remove", id], timeout: 20, withSecrets: true))
    }

    func clineQuota() throws -> ClineQuotaReport {
        try decode(ClineQuotaReport.self, from: run(["cline-quota"], timeout: 60, withSecrets: true))
    }

    private func clineKeysWrite(_ arguments: [String], payload: [String: String]) throws -> ClineKeyListResult {
        let data = try JSONSerialization.data(withJSONObject: payload)
        let result = try decode(ClineKeyListResult.self, from: run(arguments, stdin: data, timeout: 20, withSecrets: true))
        if !result.ok {
            throw BackendError.commandFailed(result.error ?? "保存密钥失败")
        }
        return result
    }

    func goQuota() throws -> GoQuotaReport {
        try decode(GoQuotaReport.self, from: run(["go-quota"], timeout: 60, withSecrets: true))
    }

    private func goKeysWrite(_ arguments: [String], payload: [String: String]) throws -> GoKeyListResult {
        let data = try JSONSerialization.data(withJSONObject: payload)
        let result = try decode(GoKeyListResult.self, from: run(arguments, stdin: data, timeout: 20, withSecrets: true))
        if !result.ok {
            throw BackendError.commandFailed(result.error ?? "保存密钥失败")
        }
        return result
    }

    func netInfo() throws -> NetInfo {
        try decode(NetInfo.self, from: run(["net-info"], timeout: 20))
    }

    func stopSpeedTest() {
        speedCancelled = true
        if let process = speedProcess, process.isRunning {
            process.terminate()
        }
    }

    func runSpeedTest(onLine: @escaping (String) -> Void) throws {
        speedCancelled = false
        try stream(["net-speed"], timeout: 90, onLine: onLine)
    }

    private func stream(_ arguments: [String], timeout: TimeInterval, onLine: @escaping (String) -> Void) throws {
        guard let nodePath else { throw BackendError.nodeNotFound }
        guard let scriptPath else { throw BackendError.scriptNotFound }
        if let process = speedProcess, process.isRunning { process.terminate() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [scriptPath] + arguments
        process.environment = environment()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        var buffer = ""
        let lock = NSLock()
        stdout.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            lock.lock()
            buffer += text
            while let range = buffer.range(of: "\n") {
                let line = String(buffer[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                buffer.removeSubrange(..<range.upperBound)
                if !line.isEmpty { onLine(line) }
            }
            lock.unlock()
        }
        speedProcess = process
        try process.run()
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        stdout.fileHandleForReading.readabilityHandler = nil
        if process.isRunning {
            process.terminate()
            throw BackendError.commandFailed("测速超时")
        }
        let leftover = lock.withLock { buffer }
        let tail = leftover.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty { onLine(tail) }
        if speedCancelled { return }
        if process.terminationStatus != 0 {
            let message = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !message.isEmpty { throw BackendError.commandFailed(message) }
        }
    }

    // MARK: - Today

    var todayGatewayPort: Int {
        let stored = UserDefaults.standard.integer(forKey: "todayPort")
        return (1024...65535).contains(stored) ? stored : 8317
    }

    var todayGatewayBaseURL: String {
        "http://127.0.0.1:\(todayGatewayPort)/v1"
    }

    func todayStatus() throws -> TodayStatus {
        try decode(TodayStatus.self, from: run(
            ["today-status", "--port", String(todayGatewayPort)],
            timeout: 30,
            withSecrets: true
        ))
    }

    func todayModels() throws -> TodayModelsResult {
        try decode(TodayModelsResult.self, from: run(["today-models"], timeout: 45))
    }

    func todayChat(text: String, model: String?) throws -> TodayChatResult {
        var payload: [String: String] = ["text": text]
        if let model, !model.isEmpty { payload["model"] = model }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try decode(TodayChatResult.self, from: run(["today-chat"], stdin: data, timeout: 240))
    }

    func todaySetModel(_ id: String) throws -> TodayModelsResult {
        try decode(TodayModelsResult.self, from: run(["today-model", id], timeout: 45))
    }

    func todayLaunch() throws {
        _ = try run(["today-launch"], timeout: 45)
    }

    func todayGatewayIsRunning() -> Bool {
        todayProcess?.isRunning == true
    }

    func startTodayGateway() throws {
        if todayProcess?.isRunning == true { return }
        guard let nodePath else { throw BackendError.nodeNotFound }
        guard let scriptPath else { throw BackendError.scriptNotFound }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [scriptPath, "today-serve", "--port", String(todayGatewayPort)]
        process.environment = environment()
        process.standardOutput = FileHandle.nullDevice
        let err = Pipe()
        process.standardError = err
        todayStderr = ""
        err.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            self?.todayStderr += text
        }
        try process.run()
        todayProcess = process
        Thread.sleep(forTimeInterval: 0.8)
        if !process.isRunning {
            err.fileHandleForReading.readabilityHandler = nil
            todayProcess = nil
            let message = todayStderr
                .split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty && !$0.hasPrefix("(node:") && !$0.hasPrefix("(Use `node") }
                .joined(separator: "\n")
            if message.contains("EADDRINUSE") {
                throw BackendError.commandFailed("端口 \(todayGatewayPort) 已被占用，请换一个端口")
            }
            throw BackendError.commandFailed(message.isEmpty ? "Today 网关没有启动" : message)
        }
    }

    func stopTodayGateway() {
        if let process = todayProcess, process.isRunning { process.terminate() }
        todayProcess = nil
    }

    private func track(_ process: Process) {
        processLock.lock()
        activeProcesses.append(process)
        processLock.unlock()
    }

    private func untrack(_ process: Process) {
        processLock.lock()
        activeProcesses.removeAll { $0 === process }
        processLock.unlock()
    }

    /// 退出 App 时结束所有常驻/正在跑的子进程，避免留下孤儿 node。
    func stopAll() {
        stopGrokGateway()
        stopTodayGateway()
        speedCancelled = true
        processLock.lock()
        let running = activeProcesses
        activeProcesses.removeAll()
        processLock.unlock()
        for process in running where process.isRunning {
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
        }
        if let process = speedProcess, process.isRunning { process.terminate() }
        if let process = controlledProcess, process.isRunning { process.terminate() }
    }

    // MARK: - Qoder 网络

    func qoderStatus() throws -> QoderStatusResult {
        try decode(QoderStatusResult.self, from: run(["qoder-status"], timeout: 40))
    }

    func qoderFix() throws -> QoderActionResult {
        try decode(QoderActionResult.self, from: run(["qoder-fix"], timeout: 240))
    }

    func qoderRestore() throws -> QoderActionResult {
        try decode(QoderActionResult.self, from: run(["qoder-restore"], timeout: 240))
    }

    func qoderRestart() throws -> QoderActionResult {
        try decode(QoderActionResult.self, from: run(["qoder-restart"], timeout: 40))
    }

    func qoderOpen() throws -> QoderActionResult {
        try decode(QoderActionResult.self, from: run(["qoder-open"], timeout: 20))
    }

    func qoderRemoteStatus() throws -> QoderRemoteReport {
        try decode(QoderRemoteReport.self, from: run(["qoder-remote-status"], timeout: 60))
    }

    func qoderRemoteAction(host: String, action: String) throws -> QoderRemoteActionReport {
        try decode(QoderRemoteActionReport.self, from: run(
            ["qoder-remote-action", "--host", host, "--action", action],
            timeout: 90
        ))
    }

    func grokStatus() throws -> GrokStatus {
        try decode(GrokStatus.self, from: run(["grok-status"], timeout: 30, withSecrets: true))
    }

    func grokChat(model: String, text: String) throws -> GrokChatResult {
        let data = try JSONSerialization.data(withJSONObject: ["model": model, "text": text])
        let result = try decode(GrokChatResult.self, from: run(["grok-chat"], stdin: data, timeout: 130))
        if !result.ok {
            throw BackendError.commandFailed(result.error ?? "Grok Bot 没有返回")
        }
        return result
    }

    func grokGatewayIsRunning() -> Bool {
        grokProcess?.isRunning == true
    }

    func startGrokGateway() throws {
        if grokProcess?.isRunning == true { return }
        guard let nodePath else { throw BackendError.nodeNotFound }
        guard let scriptPath else { throw BackendError.scriptNotFound }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [scriptPath, "grok-serve"]
        process.environment = environment()
        process.standardOutput = FileHandle.nullDevice
        let err = Pipe()
        process.standardError = err
        grokStderr = ""
        err.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            self?.grokStderr += text
        }
        try process.run()
        grokProcess = process
        Thread.sleep(forTimeInterval: 0.6)
        if !process.isRunning {
            err.fileHandleForReading.readabilityHandler = nil
            grokProcess = nil
            var message = cleanedGrokError()
            if message.contains("EADDRINUSE") {
                message = "端口 \(grokGatewayPort) 已被其他程序占用。请在「本地网关」里换一个端口，或先关闭占用该端口的程序。"
            } else if message.contains("EACCES") {
                message = "没有权限监听端口 \(grokGatewayPort)，请换一个 1024 以上的端口。"
            }
            throw BackendError.commandFailed(message.isEmpty ? "网关没有启动" : message)
        }
    }

    private func cleanedGrokError() -> String {
        grokStderr
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("(node:") && !$0.hasPrefix("(Use `node") }
            .joined(separator: "\n")
    }

    func grokPortOwner() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-nP", "-iTCP:\(grokGatewayPort)", "-sTCP:LISTEN", "-F", "c"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let output = String(data: data, encoding: .utf8) ?? ""
        for line in output.split(separator: "\n") where line.hasPrefix("c") {
            let name = String(line.dropFirst()).trimmingCharacters(in: .whitespaces)
            if !name.isEmpty { return name }
        }
        return nil
    }

    func stopGrokGateway() {
        if let process = grokProcess, process.isRunning {
            process.terminate()
        }
        grokProcess = nil
    }

    var isReady: Bool { nodePath != nil && scriptPath != nil }

    var diagnosticMessage: String? {
        if nodePath == nil { return BackendError.nodeNotFound.errorDescription }
        if scriptPath == nil { return BackendError.scriptNotFound.errorDescription }
        return nil
    }
}
