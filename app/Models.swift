// 数据模型：与 ai-toolbox --json 输出对应
import Foundation

struct ProviderSummary: Codable {
    let id: String
    let name: String
    let isCurrent: Bool
    let model: String?
    let catalogCount: Int
    let official: Bool
    let hasConfig: Bool
    let baseUrl: String?
    let host: String?
    let tokenTail: String?
    let token: String?
}

struct LiveInfo: Codable {
    let providerId: String?
    let baseUrl: String?
    let host: String?
    let tokenTail: String?
    let token: String?
    let model: String?
    let matchedIds: [String]?
    let liveProviderId: String?
}

struct ListResult: Codable {
    let ok: Bool
    let currentId: String?
    let providers: [ProviderSummary]
    let live: LiveInfo?
    let ccSwitchRunning: Bool?
    let error: String?
}

struct EffectiveInfo: Codable {
    let ok: Bool
    let modelProvider: String?
    let model: String?
    let baseUrl: String?
    let hasToken: Bool?
    let catalogJson: String?
    let error: String?
}

struct AppServerInfo: Codable {
    let pid: Int
    let owner: String
    let kind: String
    let topLevel: Bool
}

struct CurrentResult: Codable {
    let ok: Bool
    let current: ProviderRef?
    let configPath: String?
    let effective: EffectiveInfo?
    let appServers: [AppServerInfo]?
    let tuiCount: Int?
}

struct ProviderRef: Codable {
    let id: String
    let name: String
}

struct RemoteHostInfo: Codable {
    let host: String
    let label: String
    let ok: Bool
    let changed: Bool
    let baseUrl: String?
    let previousBaseUrl: String?
    let providerName: String?
    let tokenTail: String?
    let token: String?
    let restarted: Int
    let error: String?
}

struct RemoteSyncInfo: Codable {
    let hosts: [RemoteHostInfo]
}

struct ReloadResult: Codable {
    let ok: Bool
    let current: ProviderRef?
    let reload: ReloadDetail?
    let remote: RemoteSyncInfo?
}

struct ReloadDetail: Codable {
    let targets: [ReloadTarget]?
    let terminated: Int?
    let killed: Int?
    let respawned: RespawnInfo?
    let dryRun: Bool?
    let tuiCount: Int?
}

struct ReloadTarget: Codable {
    let pid: Int
    let owner: String?
}

struct RespawnInfo: Codable {
    let pid: Int
}

struct SwitchResult: Codable {
    let ok: Bool
    let provider: ProviderSummary?
    let effective: EffectiveInfo?
    let verified: Bool?
    let backupPath: String?
    let synced: Bool?
    let warnings: [String]?
    let reload: ReloadDetail?
    let remote: RemoteSyncInfo?
    let error: String?
}

struct CheckItem: Codable {
    let ok: Bool
    let label: String
}

struct DoctorResult: Codable {
    let ok: Bool
    let checks: [CheckItem]
    let failed: Int
}

struct RemoteStatusResult: Codable {
    let ok: Bool
    let remote: RemoteSyncInfo
}

struct CcSwitchHostInfo: Codable {
    let host: String
    let label: String
    let ok: Bool
    let changed: Bool
    let pending: Bool
    let providerCount: Int?
    let error: String?
}

struct CcSwitchRemoteInfo: Codable {
    let hosts: [CcSwitchHostInfo]
}

struct CcSwitchSyncResult: Codable {
    let ok: Bool
    let fingerprint: String?
    let remote: CcSwitchRemoteInfo
}

struct FingerprintResult: Codable {
    let ok: Bool
    let fingerprint: String
}

struct ClaudeLiveInfo: Codable {
    let baseUrl: String?
    let host: String?
    let tokenTail: String?
    let token: String?
    let provider: String?
    let scheme: String?
    let liveProviderId: String?
}

struct ClaudeListResult: Codable {
    let ok: Bool
    let currentId: String?
    let providers: [ProviderSummary]
    let live: ClaudeLiveInfo?
    let ccSwitchRunning: Bool?
}

struct ClaudeReloadDetail: Codable {
    let wasRunning: Bool?
    let restarted: Bool?
    let pid: Int?
    let dryRun: Bool?
}

struct ClaudeSwitchResult: Codable {
    let ok: Bool
    let provider: ProviderSummary?
    let reload: ClaudeReloadDetail?
    let error: String?
}

struct ClaudeReloadResult: Codable {
    let ok: Bool
    let current: ProviderRef?
    let reload: ClaudeReloadDetail?
}

struct IqModel: Codable {
    let id: String
    let thinkingLevels: [String]
    let defaultThinking: String
}

struct IqProvider: Codable {
    let id: String
    let appType: String
    let name: String
    let baseUrl: String
    let models: [IqModel]
}

struct IqListResult: Codable {
    let ok: Bool
    let providers: [IqProvider]
}

struct IqInspect: Codable {
    let exists: Bool?
    let bytes: Int?
    let hasSvg: Bool?
    let hasAnimation: Bool?
}

struct IqRunResult: Codable {
    let ok: Bool?
    let error: String?
    let providerName: String?
    let model: String?
    let thinking: String?
    let topic: String?
    let topicTitle: String?
    let reply: String?
    let answer: String?
    let htmlPath: String?
    let turns: Int?
    let elapsedMs: Int?
    let stopReason: String?
    let inspect: IqInspect?
}

struct GoKeyPublic: Codable {
    let id: String
    let name: String
    let tail: String
    let key: String
    var plan: String
}

struct GoKeyListResult: Codable {
    let ok: Bool
    let keys: [GoKeyPublic]?
    let added: Int?
    let error: String?
}

struct GoQuotaWindow: Codable {
    let status: String
    let percent: Double
    let resetsAt: String?
}

struct GoQuotaWindows: Codable {
    let rolling: GoQuotaWindow?
    let weekly: GoQuotaWindow?
    let monthly: GoQuotaWindow?
}

struct GoQuotaKey: Codable {
    let id: String
    let name: String
    let tail: String
    let key: String
    var plan: String
    let ok: Bool
    let latencyMs: Int?
    let error: String?
    let windows: GoQuotaWindows?
}

struct GoQuotaPrice: Codable {
    let label: String?
    let input: Double?
    let output: Double?
    let cacheRead: Double?
    let cacheWrite: Double?
}

struct GoQuotaLimits: Codable {
    let go: Double?
    let plus: Double?
}

struct GoQuotaRequestWindow: Codable {
    let rolling: Int
    let weekly: Int
    let monthly: Int
}

struct GoQuotaRequestPlans: Codable {
    let go: GoQuotaRequestWindow?
    let plus: GoQuotaRequestWindow?
}

struct GoQuotaModel: Codable {
    let id: String
    let name: String
    let note: String?
    let prices: [GoQuotaPrice]
    let limits: GoQuotaLimits
    let requests: GoQuotaRequestPlans
}

struct GoQuotaLocalModel: Codable {
    let id: String
    let requests: Int
    let total: Int
    let input: Int
    let output: Int
    let reasoning: Int
    let cacheRead: Int
    let cacheWrite: Int
    let cost: Double
}

struct GoQuotaTrend: Codable {
    let date: String
    let tokens: Int
    let cost: Double
}

struct GoQuotaLocal: Codable {
    let days: Int
    let available: Bool
    let models: [GoQuotaLocalModel]
    let trend: [GoQuotaTrend]
}

struct GoKeyUseTarget: Codable {
    let target: String
    let appType: String?
    let name: String
}

struct GoKeyUseResult: Codable {
    let ok: Bool
    let name: String?
    let tail: String?
    let updated: [GoKeyUseTarget]?
    let ccSwitchRunning: Bool?
    let opencodeRestarted: Bool?
    let harnessRestarted: Bool?
    let kimiRestarted: Bool?
    let error: String?
}

struct ClineKeyPublic: Codable {
    let id: String
    let name: String
    let tail: String
    let key: String
}

struct ClineKeyListResult: Codable {
    let ok: Bool
    let keys: [ClineKeyPublic]?
    let added: Int?
    let error: String?
}

struct ClineQuotaWindow: Codable {
    let status: String
    let percent: Double
    let resetsAt: String?
}

struct ClineQuotaWindows: Codable {
    let rolling: ClineQuotaWindow?
    let weekly: ClineQuotaWindow?
    let monthly: ClineQuotaWindow?
}

struct ClineQuotaKey: Codable {
    let id: String
    let name: String
    let tail: String
    let key: String
    let ok: Bool
    let latencyMs: Int?
    let error: String?
    let note: String?
    let balance: String?
    let windows: ClineQuotaWindows?
}

struct NetInfo: Codable {
    let ok: Bool
    let interfaceName: String?
    let interfaceKind: String?
    let media: String?
    let localIPv4: String?
    let localIPv6: String?
    let gateway: String?
    let dns: [String]?
    let ssid: String?
    let bytesIn: Double?
    let bytesOut: Double?
    let publicIP: String?
    let place: String?
    let colo: String?
    let isp: String?
    let asn: Int?
    let httpProtocol: String?
    let error: String?
}

struct GrokAgent: Codable {
    let id: String
    let legacyAgentId: String?
    let name: String
    let description: String?
    let kind: String?
}

struct GrokModelInfo: Codable {
    let id: String
    let description: String
}

struct GrokGatewayInfo: Codable {
    let running: Bool
    let port: Int
    let baseUrl: String
}

struct GrokStatus: Codable {
    let ok: Bool
    let email: String?
    let token: String?
    let refreshToken: String?
    let machineId: String?
    let agents: [GrokAgent]?
    let agentsError: String?
    let models: [GrokModelInfo]?
    let gateway: GrokGatewayInfo?
    let error: String?
}

struct GrokChatResult: Codable {
    let ok: Bool
    let model: String?
    let reply: String?
    let agentId: String?
    let elapsedMs: Int?
    let error: String?
}

struct ClineQuotaReport: Codable {
    let ok: Bool
    let keys: [ClineQuotaKey]
    let fetchedAt: String?
    let error: String?
}

struct GoQuotaReport: Codable {
    let ok: Bool
    var keys: [GoQuotaKey]
    let fetchedAt: String?
    let error: String?
}

struct ClaudeSyncResult: Codable {
    let ok: Bool
    let aligned: Bool?
    let applied: Bool?
    let current: ProviderRef?
    let reload: ClaudeReloadDetail?
    let reason: String?
}
