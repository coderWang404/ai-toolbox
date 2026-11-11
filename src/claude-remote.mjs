// 把本机 Claude Code 的 env 同步到远端 ~/.claude/settings.json。
// 只替换 env（端点/密钥/模型档位），远端自己的 theme、权限等设置保留。
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { sshArgs, loadRemotes } from "./remote-sync.mjs";
import { claudeSettingsPath } from "./claude-code.mjs";

const execFileAsync = promisify(execFile);
const MARKER = "AI_TOOLBOX_CLAUDE:";

export function readLocalClaudeSettings() {
  const file = claudeSettingsPath();
  if (!existsSync(file)) throw new Error(`找不到 ~/.claude/settings.json`);
  const settings = JSON.parse(readFileSync(file, "utf8"));
  return {
    file,
    env: settings.env && typeof settings.env === "object" ? settings.env : {},
    baseUrl: settings.env?.ANTHROPIC_BASE_URL ?? null,
  };
}

function remoteProgram(env, { dryRun }) {
  return `
import json, os, pathlib
LOCAL_ENV = ${JSON.stringify(env)}
DRY = ${dryRun ? "True" : "False"}
base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
home = pathlib.Path(base)
target = home / "settings.json"
existing = {}
if target.exists():
    try:
        existing = json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        existing = {}
merged = dict(existing)
merged["env"] = LOCAL_ENV
changed = merged != existing
if changed and not DRY:
    home.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(".settings.json.tmp")
    tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(target)
print(${JSON.stringify(MARKER)} + json.dumps({
    "changed": changed,
    "dryRun": DRY,
    "path": str(target),
    "host": (LOCAL_ENV or {}).get("ANTHROPIC_BASE_URL"),
    "hadFile": bool(existing),
}))
`;
}

async function syncHost(entry, env, { dryRun }) {
  try {
    const { stdout } = await execFileAsync("ssh", sshArgs(entry, remoteProgram(env, { dryRun })), {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const line = stdout
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.startsWith(MARKER));
    if (!line) throw new Error(stdout.trim().slice(-180) || "远程没有返回结果");
    return { host: entry.host, label: entry.label, ok: true, ...JSON.parse(line.slice(MARKER.length)) };
  } catch (err) {
    return {
      host: entry.host,
      label: entry.label,
      ok: false,
      error: String(err?.stderr || err?.message || err).trim().split("\n").slice(-2).join(" ").slice(0, 200),
    };
  }
}

export async function syncClaudeRemotes({ dryRun = false, log = console.log, hosts = null } = {}) {
  const local = readLocalClaudeSettings();
  const entries = hosts ?? loadRemotes();
  if (!entries.length) {
    log("  未配置远程主机，跳过");
    return { hosts: [], baseUrl: local.baseUrl };
  }
  if (!local.baseUrl) log("  ⚠️ 本机 Claude 配置没有 ANTHROPIC_BASE_URL");
  log(`\n🌐 同步 Claude Code 配置（${local.baseUrl ?? "-"}）到 ${entries.length} 台远程`);
  const results = await Promise.all(entries.map((entry) => syncHost(entry, local.env, { dryRun })));
  for (const row of results) {
    if (!row.ok) {
      log(`  ❌ ${row.label}: ${row.error}`);
    } else if (row.changed) {
      log(`  ✔ ${row.label}: ${dryRun ? "[dry-run] " : ""}已写入 ${row.host ?? "-"}`);
    } else {
      log(`  ✔ ${row.label}: 已一致（${row.host ?? "-"}）`);
    }
  }
  return { command: "claude-sync-remote", baseUrl: local.baseUrl, hosts: results };
}
