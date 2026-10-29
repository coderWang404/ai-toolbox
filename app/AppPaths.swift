// 应用身份与本地数据目录。改名后首次启动时把旧目录和偏好迁移过来。
import Foundation

enum AppIdentity {
    static let displayName = "AI 工具箱"
    static let bundleIdentifier = "com.local.ai-toolbox"
    static let legacyBundleIdentifier = "com.local.codex-hotswitch"
    static let dataDirectoryName = ".ai-toolbox"
    static let legacyDataDirectoryName = ".codex-hotswitch"
}

enum AppPaths {
    static var dataDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(AppIdentity.dataDirectoryName, isDirectory: true)
    }

    static func dataFile(_ name: String) -> URL {
        dataDirectory.appendingPathComponent(name)
    }
}

enum LegacyMigration {
    static func run() {
        migrateDataDirectory()
        migratePreferences()
    }

    private static func migrateDataDirectory() {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        let legacy = home.appendingPathComponent(AppIdentity.legacyDataDirectoryName, isDirectory: true)
        let current = home.appendingPathComponent(AppIdentity.dataDirectoryName, isDirectory: true)
        guard fm.fileExists(atPath: legacy.path), !fm.fileExists(atPath: current.path) else { return }
        try? fm.moveItem(at: legacy, to: current)
    }

    private static func migratePreferences() {
        let defaults = UserDefaults.standard
        let marker = "migratedFromCodexHotswitch"
        guard !defaults.bool(forKey: marker) else { return }
        defer { defaults.set(true, forKey: marker) }
        guard let legacy = UserDefaults(suiteName: AppIdentity.legacyBundleIdentifier),
              let domain = legacy.persistentDomain(forName: AppIdentity.legacyBundleIdentifier) else { return }
        for (key, value) in domain where !key.hasPrefix("NSStatusItem") {
            defaults.set(value, forKey: key)
        }
    }
}
