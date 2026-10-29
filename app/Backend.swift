// 后端桥接：定位 Node 与内置脚本，执行 CLI 命令并解析 JSON。
import Foundation

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

    private(set) var nodePath: String?
    private(set) var scriptPath: String?
    private var controlledProcess: Process?
    private var controlledStdin: FileHandle?
    private var grokProcess: Process?
    private var grokStderr = ""
    private var speedProcess: Process?
    private var speedCancelled = false

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
    func run(_ arguments: [String], stdin: Data? = nil, timeout: TimeInterval = 90) throws -> Data {
        guard let nodePath else { throw BackendError.nodeNotFound }
        guard let scriptPath else { throw BackendError.scriptNotFound }
        if ProcessInfo.processInfo.environment["AI_TOOLBOX_DEBUG"] != nil {
            FileHandle.standardError.write("RUN \(nodePath) \(scriptPath) \(arguments)\n".data(using: .utf8)!)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [scriptPath] + arguments + ["--json"]
        process.environment = environment()

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        let input = Pipe()
        if stdin != nil {
            process.standardInput = input
        }

        try process.run()
        if let stdin {
            input.fileHandleForWriting.write(stdin)
            try? input.fileHandleForWriting.close()
        }

        // 超时看门狗
        let deadline = DispatchTime.now() + timeout
        let watchdog = DispatchWorkItem {
            if process.isRunning { process.terminate() }
        }
        DispatchQueue.global().asyncAfter(deadline: deadline, execute: watchdog)
        defer { watchdog.cancel() }

        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        let errData = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        if ProcessInfo.processInfo.environment["AI_TOOLBOX_DEBUG"] != nil {
            FileHandle.standardError.write("EXIT \(process.terminationStatus) out=\(outData.count)B err=\(errData.count)B\n".data(using: .utf8)!)
        }
        if process.terminationStatus != 0, outData.isEmpty {
            let message = String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw BackendError.commandFailed(message?.isEmpty == false ? message! : "命令执行失败（退出码 \(process.terminationStatus)）")
        }
        return outData
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        do {
            return try decoder.decode(type, from: data)
        } catch {
            let raw = String(data: data, encoding: .utf8) ?? ""
            throw BackendError.badOutput(raw)
        }
    }

    // MARK: - 便捷命令

    func list() throws -> ListResult {
        try decode(ListResult.self, from: run(["list"]))
    }

    func current() throws -> CurrentResult {
        try decode(CurrentResult.self, from: run(["current"]))
    }

    func switchProvider(_ identifier: String, scope: String, focus: Bool, force: Bool = false, remote: Bool = true) throws -> SwitchResult {
        var args = ["switch", identifier, "--scope", scope]
        if !focus { args.append("--no-focus") }
        if force { args.append("--force") }
        if !remote { args.append("--no-remote") }
        return try decode(SwitchResult.self, from: run(args, timeout: 180))
    }

    func reload(scope: String, focus: Bool = true, remote: Bool = true) throws -> ReloadResult {
        var args = ["reload", "--scope", scope]
        if !focus { args.append("--no-focus") }
        if !remote { args.append("--no-remote") }
        return try decode(ReloadResult.self, from: run(args, timeout: 180))
    }

    func doctor() throws -> DoctorResult {
        try decode(DoctorResult.self, from: run(["doctor"], timeout: 40))
    }

    func remoteStatus() throws -> RemoteSyncInfo {
        let result = try decode(RemoteStatusResult.self, from: run(["remote-status"], timeout: 40))
        return result.remote
    }

    func claudeList() throws -> ClaudeListResult {
        try decode(ClaudeListResult.self, from: run(["claude-list"], timeout: 20))
    }

    func claudeSwitch(_ identifier: String, force: Bool = false) throws -> ClaudeSwitchResult {
        var args = ["claude-switch", identifier]
        if force { args.append("--force") }
        return try decode(ClaudeSwitchResult.self, from: run(args, timeout: 40))
    }

    func claudeReload() throws -> ClaudeReloadResult {
        try decode(ClaudeReloadResult.self, from: run(["claude-reload"], timeout: 40))
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
        errHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { onStderr(text) }
        }
        try process.run()
        let deadline = DispatchTime.now() + timeout
        let watchdog = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: deadline, execute: watchdog)
        defer {
            watchdog.cancel()
            errHandle.readabilityHandler = nil
            if control {
                try? stdin.fileHandleForWriting.close()
                controlledStdin = nil
                controlledProcess = nil
            }
        }
        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        if process.terminationStatus != 0, outData.isEmpty {
            throw BackendError.commandFailed("测试没有完成")
        }
        return outData
    }

    func claudeSync() throws -> ClaudeSyncResult {
        try decode(ClaudeSyncResult.self, from: run(["claude-sync"], timeout: 40))
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
        try decode(GoKeyListResult.self, from: run(["go-keys"], timeout: 20))
    }

    func goKeysAdd(name: String, key: String, plan: String) throws -> GoKeyListResult {
        try goKeysWrite(["go-keys-add"], payload: ["name": name, "key": key, "plan": plan])
    }

    func goKeysImport(text: String, plan: String) throws -> GoKeyListResult {
        try goKeysWrite(["go-keys-add"], payload: ["text": text, "plan": plan])
    }

    func goKeysRemove(_ id: String) throws -> GoKeyListResult {
        try decode(GoKeyListResult.self, from: run(["go-keys-remove", id], timeout: 20))
    }

    func goKeysPlan(_ id: String, plan: String) throws -> GoKeyListResult {
        try decode(GoKeyListResult.self, from: run(["go-keys-plan", id, plan], timeout: 20))
    }

    func goKeysUse(_ id: String) throws -> GoKeyUseResult {
        let result = try decode(GoKeyUseResult.self, from: run(["go-keys-use", id], timeout: 90))
        if !result.ok {
            throw BackendError.commandFailed(result.error ?? "切换密钥失败")
        }
        return result
    }

    func clineKeys() throws -> ClineKeyListResult {
        try decode(ClineKeyListResult.self, from: run(["cline-keys"], timeout: 20))
    }

    func clineKeysAdd(name: String, key: String) throws -> ClineKeyListResult {
        try clineKeysWrite(["cline-keys-add"], payload: ["name": name, "key": key])
    }

    func clineKeysImport(text: String) throws -> ClineKeyListResult {
        try clineKeysWrite(["cline-keys-add"], payload: ["text": text])
    }

    func clineKeysRemove(_ id: String) throws -> ClineKeyListResult {
        try decode(ClineKeyListResult.self, from: run(["cline-keys-remove", id], timeout: 20))
    }

    func clineQuota() throws -> ClineQuotaReport {
        try decode(ClineQuotaReport.self, from: run(["cline-quota"], timeout: 60))
    }

    private func clineKeysWrite(_ arguments: [String], payload: [String: String]) throws -> ClineKeyListResult {
        let data = try JSONSerialization.data(withJSONObject: payload)
        let result = try decode(ClineKeyListResult.self, from: run(arguments, stdin: data, timeout: 20))
        if !result.ok {
            throw BackendError.commandFailed(result.error ?? "保存密钥失败")
        }
        return result
    }

    func goQuota() throws -> GoQuotaReport {
        try decode(GoQuotaReport.self, from: run(["go-quota"], timeout: 60))
    }

    private func goKeysWrite(_ arguments: [String], payload: [String: String]) throws -> GoKeyListResult {
        let data = try JSONSerialization.data(withJSONObject: payload)
        let result = try decode(GoKeyListResult.self, from: run(arguments, stdin: data, timeout: 20))
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

    func grokStatus() throws -> GrokStatus {
        try decode(GrokStatus.self, from: run(["grok-status"], timeout: 30))
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
