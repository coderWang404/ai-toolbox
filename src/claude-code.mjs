// Claude Code 供应商切换：数据来自 cc-switch 的 app_type='claude' 卡片，
// 写入 ~/.claude/settings.json（env 整块替换，其余用户设置保留）。
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ccSwitchDbPath, ccSwitchSettingsPath } from "./paths.mjs";
import { execFileSync } from "node:child_process";

export function claudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sqliteJson(dbPath, sql) {
  const out = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const trimmed = out.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function sqliteExec(dbPath, sql) {
  execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
}

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host;
  } catch {
    return null;
  }
}

function tokenTail(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(-8) : null;
}

/** 列出 cc-switch 里所有 Claude Code 供应商。 */
export function listClaudeProviders() {
  const db = ccSwitchDbPath();
  if (!existsSync(db)) throw new Error(`找不到 cc-switch 数据库: ${db}`);
  const rows = sqliteJson(
    db,
    "SELECT id, name, is_current, settings_config FROM providers WHERE app_type='claude' ORDER BY sort_index, created_at",
  );
  return rows.map((row) => {
    let settings = {};
    try {
      settings = JSON.parse(row.settings_config || "{}");
    } catch {
      settings = {};
    }
    const env = settings.env ?? {};
    return {
      id: row.id,
      name: row.name,
      isCurrent: !!row.is_current,
      baseUrl: env.ANTHROPIC_BASE_URL ?? null,
      host: hostOf(env.ANTHROPIC_BASE_URL ?? null),
      tokenTail: tokenTail(env.ANTHROPIC_AUTH_TOKEN ?? null),
      model: env.ANTHROPIC_MODEL ?? env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null,
      settings,
    };
  });
}

function currentIdFromSettings() {
  const file = ccSwitchSettingsPath();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")).currentProviderClaude ?? null;
  } catch {
    return null;
  }
}

export function getCurrentClaudeProvider() {
  const providers = listClaudeProviders();
  const id = currentIdFromSettings();
  return providers.find((p) => p.id === id) ?? providers.find((p) => p.isCurrent) ?? null;
}

export function findClaudeProvider(query) {
  const providers = listClaudeProviders();
  const q = String(query ?? "").trim().toLowerCase();
  return (
    providers.find((p) => p.id.toLowerCase() === q) ||
    providers.find((p) => p.name.toLowerCase() === q) ||
    providers.find((p) => p.name.toLowerCase().includes(q)) ||
    providers.find((p) => p.id.toLowerCase().includes(q)) ||
    null
  );
}

/**
 * 合并 settings：供应商卡片覆盖同名顶层键；env 整块替换（与 cc-switch 一致）。
 * 纯函数，便于测试。
 */
export function mergeClaudeSettings(live, providerSettings) {
  const base = live && typeof live === "object" ? live : {};
  const patch = providerSettings && typeof providerSettings === "object" ? providerSettings : {};
  const next = { ...base, ...patch };
  if (patch.env && typeof patch.env === "object") next.env = { ...patch.env };
  return next;
}

function writeAtomic(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* 忽略 */
  }
  renameSync(tmp, file);
}

/** 应用一个供应商：写 ~/.claude/settings.json，并同步 cc-switch 的当前标记。 */
export function switchClaudeProvider(query, { dryRun = false } = {}) {
  const provider = findClaudeProvider(query);
  if (!provider) throw new Error(`找不到 Claude Code 供应商「${query}」`);
  const file = claudeSettingsPath();
  let live = {};
  if (existsSync(file)) {
    try {
      live = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      live = {};
    }
  }
  const next = mergeClaudeSettings(live, provider.settings);
  if (dryRun) return { provider, preview: next, applied: false };

  let backupPath = null;
  if (existsSync(file)) {
    backupPath = `${file}.bak_${timestamp()}`;
    copyFileSync(file, backupPath);
    try {
      chmodSync(backupPath, 0o600);
    } catch {
      /* 忽略 */
    }
  }
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);

  let synced = false;
  try {
    sqliteExec(
      ccSwitchDbPath(),
      `UPDATE providers SET is_current = CASE WHEN id='${provider.id.replace(/'/g, "''")}' AND app_type='claude' THEN 1 ELSE 0 END WHERE app_type='claude';`,
    );
    const settingsFile = ccSwitchSettingsPath();
    if (existsSync(settingsFile)) {
      const s = JSON.parse(readFileSync(settingsFile, "utf8"));
      s.currentProviderClaude = provider.id;
      writeAtomic(settingsFile, `${JSON.stringify(s, null, 2)}\n`);
    }
    synced = true;
  } catch {
    synced = false;
  }

  return {
    provider,
    applied: true,
    settingsPath: file,
    backupPath,
    synced,
    endpoint: provider.baseUrl,
    model: next.env?.ANTHROPIC_MODEL ?? null,
  };
}

/** 当前生效的 Claude 配置（读 settings.json 而不是卡片）。 */
export function claudeStatus() {
  const file = claudeSettingsPath();
  const provider = getCurrentClaudeProvider();
  if (!existsSync(file)) return { ok: false, error: "找不到 ~/.claude/settings.json", provider };
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false, error: String(err.message ?? err), provider };
  }
  const env = settings.env ?? {};
  return {
    ok: true,
    settingsPath: file,
    baseUrl: env.ANTHROPIC_BASE_URL ?? null,
    host: hostOf(env.ANTHROPIC_BASE_URL ?? null),
    model: env.ANTHROPIC_MODEL ?? null,
    tokenTail: tokenTail(env.ANTHROPIC_AUTH_TOKEN ?? null),
    provider: provider ? { id: provider.id, name: provider.name } : null,
    matchesProvider:
      provider && env.ANTHROPIC_BASE_URL && provider.baseUrl ? env.ANTHROPIC_BASE_URL === provider.baseUrl : null,
  };
}
