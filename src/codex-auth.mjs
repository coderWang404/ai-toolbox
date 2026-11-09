// 保住 ChatGPT 登录态：cc-switch 切到第三方供应商时会把 ~/.codex/auth.json
// 收进 ~/.cc-switch/codex-login-stash.json（"保留官方登录态"关闭时）。
// 登录态一没，Codex 桌面端就认为「未登录」，把项目列表按账号寄存 —— 这就是
// 每次切换后项目消失的根因。这里在切换后把 auth.json 还原，身份保持稳定。
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import path from "node:path";
import { codexAuthPath, ccSwitchDir, codexConfigPath } from "./paths.mjs";

const STASH_FILE = "codex-login-stash.json";

function hasCredentials(entry) {
  if (!entry || typeof entry !== "object") return false;
  return Boolean(entry.tokens?.access_token || entry.OPENAI_API_KEY);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 当前 provider 是否走第三方（requires_openai_auth=false），用于判断该不该还原登录态。 */
export function usesThirdPartyProvider(configPath = codexConfigPath()) {
  if (!existsSync(configPath)) return false;
  let inProviderTable = false;
  for (const rawLine of readFileSync(configPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      inProviderTable = /^model_providers(\s*\.|\s*$)/.test(header[1].trim());
      continue;
    }
    if (inProviderTable && /requires_openai_auth\s*=\s*false/.test(line)) return true;
  }
  return false;
}

/**
 * 确保 auth.json 还在：缺失时从 cc-switch 的登录暂存里还原。
 * @returns {{ok:boolean, action:'kept'|'restored'|'would-restore'|'skipped', account?:string, reason?:string}}
 */
export function ensureAuthPreserved({
  authPath = codexAuthPath(),
  stashPath = path.join(ccSwitchDir(), STASH_FILE),
  configPath = codexConfigPath(),
  log = null,
  dryRun = false,
} = {}) {
  if (existsSync(authPath)) {
    const current = readJson(authPath);
    if (hasCredentials(current)) return { ok: true, action: "kept" };
  }
  if (!existsSync(stashPath)) return { ok: false, action: "skipped", reason: "no-stash" };

  const stash = readJson(stashPath);
  const logins = stash?.logins ?? {};
  const key = stash?.last ?? Object.keys(logins).pop();
  const entry = key ? logins[key] : null;
  if (!hasCredentials(entry)) return { ok: false, action: "skipped", reason: "empty-stash" };

  // 官方供应商必须保留原样（它本来就该用 auth.json）；第三方才做还原。
  if (!usesThirdPartyProvider(configPath)) {
    return { ok: false, action: "skipped", reason: "official-provider" };
  }
  if (dryRun) return { ok: true, action: "would-restore", account: key };

  const tmp = `${authPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  renameSync(tmp, authPath);
  try {
    chmodSync(authPath, 0o600);
  } catch {
    /* 忽略 */
  }
  if (log) log("  已还原 ChatGPT 登录态（保持账号身份不变，项目不会被寄存）");
  return { ok: true, action: "restored", account: key };
}
