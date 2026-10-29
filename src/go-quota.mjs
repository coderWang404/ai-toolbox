// OpenCode Go 额度：多密钥查官方三窗口，并把选中的密钥写入本机 cc-switch 和 OpenCode。
// 密钥只落在 ~/.ai-toolbox/opencode-go-keys.json，不进仓库、不进命令行参数。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { dataFile, ccSwitchDbPath, codexConfigPath } from "./paths.mjs";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const WINDOWS = [
  { key: "rolling", label: "5小时滚动", fraction: 0.2 },
  { key: "weekly", label: "本周", fraction: 0.5 },
  { key: "monthly", label: "本月", fraction: 1 },
];

export function keysPath() {
  return dataFile("opencode-go-keys.json");
}

export function catalog() {
  const path = join(dirname(fileURLToPath(import.meta.url)), "go-catalog.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

const KEY_PATTERN = /(?:oc_sk_|sk-)[A-Za-z0-9_-]{8,}/;

export function isApiKey(value) {
  return /^(?:oc_sk_|sk-)[A-Za-z0-9_-]{8,}$/.test(String(value ?? "").trim());
}

export function redact(text) {
  return String(text ?? "").replace(/(?:oc_sk_|sk-)[A-Za-z0-9_-]{6,}/g, "…");
}

function emptyStore() {
  return { keys: [] };
}

function readStore() {
  const path = keysPath();
  if (!existsSync(path)) return emptyStore();
  try {
    chmodSync(path, 0o600);
  } catch {
    // 权限收紧失败时仍只在本机读取。
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || !Array.isArray(parsed.keys)) return emptyStore();
  return parsed;
}

function writeStore(store) {
  const path = keysPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function tailOf(key) {
  const text = String(key ?? "");
  return text.length >= 4 ? text.slice(-4) : "";
}

export function publicKey(item) {
  return { id: item.id, name: item.name, tail: tailOf(item.key), key: item.key, plan: item.plan === "plus" ? "plus" : "go" };
}

export function listKeys() {
  return readStore().keys.map(publicKey);
}

function normalizePlan(plan) {
  return plan === "plus" ? "plus" : "go";
}

function defaultName(key, used) {
  const base = `密钥 …${tailOf(key)}`;
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function parseKeyText(text) {
  const rows = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const found = line.match(KEY_PATTERN);
    if (!found) throw new Error("有一行不是 oc_sk_… 或 sk-… 密钥");
    const key = found[0];
    const name = line.slice(0, found.index).trim().replace(/[:：,，\s]+$/g, "");
    rows.push({ name, key });
  }
  if (!rows.length) throw new Error("没有可导入的密钥");
  return rows;
}

export function addKeys(entries, plan = "go") {
  const store = readStore();
  const names = new Set(store.keys.map((item) => item.name));
  const seen = new Set(store.keys.map((item) => item.key));
  let added = 0;
  for (const entry of entries) {
    const key = String(entry.key ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (!isApiKey(key)) throw new Error("密钥格式不对，需要 oc_sk_… 或 sk-…");
    if (seen.has(key)) continue;
    const name = String(entry.name ?? "").trim() || defaultName(key, names);
    names.add(name);
    seen.add(key);
    store.keys.push({ id: randomUUID(), name, key, plan: normalizePlan(entry.plan ?? plan) });
    added += 1;
  }
  writeStore(store);
  return { keys: store.keys.map(publicKey), added };
}

export function removeKey(id) {
  const store = readStore();
  const next = store.keys.filter((item) => item.id !== id);
  if (next.length === store.keys.length) throw new Error("找不到这个密钥");
  store.keys = next;
  writeStore(store);
  return store.keys.map(publicKey);
}

export function setPlan(id, plan) {
  if (plan !== "go" && plan !== "plus") throw new Error("套餐只能是 go 或 plus");
  const store = readStore();
  const item = store.keys.find((key) => key.id === id);
  if (!item) throw new Error("找不到这个密钥");
  item.plan = plan;
  writeStore(store);
  return store.keys.map(publicKey);
}

async function fetchUsage(key) {
  const started = Date.now();
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "User-Agent": "ai-toolbox/1.0",
  };
  const response = await fetch(USAGE_URL, { headers, signal: AbortSignal.timeout(15000) });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`额度接口 ${response.status} ${redact(raw).slice(0, 180)}`);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("额度接口没有返回 JSON");
  }
  const usage = body?.usage;
  if (!usage || typeof usage !== "object") throw new Error("额度接口缺少 usage");
  const windows = {};
  for (const spec of WINDOWS) {
    const item = usage[spec.key] ?? {};
    windows[spec.key] = {
      status: String(item.status ?? "unknown"),
      percent: Number(item.percent ?? 0),
      resetsAt: item.resetsAt ?? null,
    };
  }
  return { windows, latencyMs: Date.now() - started };
}

export async function queryAll() {
  const store = readStore();
  const keys = await Promise.all(store.keys.map(async (item) => {
    const pub = publicKey(item);
    try {
      const usage = await fetchUsage(item.key);
      return { ...pub, ok: true, latencyMs: usage.latencyMs, error: null, windows: usage.windows };
    } catch (error) {
      return { ...pub, ok: false, latencyMs: null, error: redact(error?.message ?? error), windows: null };
    }
  }));
  return {
    command: "go-quota",
    fetchedAt: new Date().toISOString(),
    keys,
  };
}

const KEY_FIELDS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "apiKey",
  "inferenceGatewayApiKey",
]);

function usesGo(value) {
  return JSON.stringify(value ?? "").includes("opencode.ai/zen/go");
}

function replaceKeyFields(value, key) {
  if (Array.isArray(value)) return value.map((item) => replaceKeyFields(item, key));
  if (!value || typeof value !== "object") return value;
  const next = { ...value };
  for (const [name, child] of Object.entries(next)) {
    if (typeof child === "string" && KEY_FIELDS.has(name)) next[name] = key;
    else if (name === "config" && typeof child === "string") {
      next[name] = child.replace(
        /experimental_bearer_token\s*=\s*"[^"]*"/g,
        `experimental_bearer_token = "${key}"`,
      );
    } else if (child && typeof child === "object") next[name] = replaceKeyFields(child, key);
  }
  return next;
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

function opencodeAuthPath() {
  return join(homedir(), ".local", "share", "opencode", "auth.json");
}

function claudeDesktopProfilePath() {
  return join(homedir(), "Library", "Application Support", "Claude-3p", "configLibrary", "00000000-0000-4000-8000-000000157210.json");
}

function ccSwitchIsRunning() {
  try {
    execFileSync("pgrep", ["-f", "CC Switch.app/Contents/MacOS/cc-switch"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function containsKnownKey(value, known) {
  if (typeof value === "string") return [...known].some((item) => item && value.includes(item));
  if (Array.isArray(value)) return value.some((item) => containsKnownKey(item, known));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsKnownKey(item, known));
  return false;
}

function replaceExactKeys(value, known, selected) {
  if (typeof value === "string") {
    if (known.has(value)) return selected;
    return value.replace(/experimental_bearer_token\s*=\s*"([^"]*)"/g, (all, token) => (
      known.has(token) ? `experimental_bearer_token = "${selected}"` : all
    ));
  }
  if (Array.isArray(value)) return value.map((item) => replaceExactKeys(item, known, selected));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, replaceExactKeys(item, known, selected)]));
}

function applyCcSwitch(key, known) {
  const dbPath = ccSwitchDbPath();
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare("SELECT id, app_type, name, settings_config FROM providers").all();
    const update = db.prepare("UPDATE providers SET settings_config = ? WHERE id = ? AND app_type = ?");
    const updated = [];
    for (const row of rows) {
      let settings;
      try {
        settings = JSON.parse(row.settings_config || "{}");
      } catch {
        continue;
      }
      const goUrl = usesGo(settings);
      const knownHit = containsKnownKey(settings, known);
      if (!goUrl && !knownHit) continue;
      let next = settings;
      if (goUrl) next = replaceKeyFields(next, key);
      if (knownHit) next = replaceExactKeys(next, known, key);
      update.run(JSON.stringify(next), row.id, row.app_type);
      updated.push({ target: "cc-switch", appType: row.app_type, name: row.name });
    }
    return updated;
  } finally {
    db.close();
  }
}

export function applyKimiCode(key) {
  const path = join(homedir(), ".kimi-code", "config.toml");
  if (!existsSync(path)) return [];
  const original = readFileSync(path, "utf8");
  let touched = false;
  const next = original.split(/(?=^\[)/m).map((part) => {
    const header = part.match(/^\[([^\]]+)\]/);
    if (!header || !header[1].startsWith("providers.")) return part;
    if (!part.includes("opencode.ai")) return part;
    if (!/^api_key\s*=\s*"/m.test(part)) return part;
    touched = true;
    return part.replace(/^api_key\s*=\s*"[^"]*"/m, `api_key = "${key}"`);
  }).join("");
  if (next !== original) writeFileSync(path, next);
  return touched ? [{ target: "kimi-code", name: "OpenCode Go" }] : [];
}

async function restartApp(appName, marker) {
  const pids = () => {
    try {
      const out = execFileSync("pgrep", ["-f", marker], { encoding: "utf8" });
      return out.trim().split("\n").map((line) => line.trim()).filter((pid) => /^\d+$/.test(pid));
    } catch {
      return [];
    }
  };
  const before = pids();
  if (!before.length) return { restarted: false };
  try {
    execFileSync("osascript", ["-e", `tell application "${appName}" to quit`], { stdio: "ignore" });
  } catch {
    // 没响应时再按主进程结束。
  }
  let gone = await waitFor(() => pids().length === 0, 8000);
  if (!gone) {
    for (const pid of pids()) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // 进程可能刚刚退出。
      }
    }
    gone = await waitFor(() => pids().length === 0, 4000);
  }
  if (!gone) throw new Error(`密钥已写入，但 ${appName} 没有退出`);
  execFileSync("open", ["-a", appName], { stdio: "ignore" });
  const opened = await waitFor(() => pids().length > 0, 12000);
  if (!opened) throw new Error(`密钥已写入，但 ${appName} 没有重新打开`);
  try {
    execFileSync("osascript", ["-e", `tell application "${appName}" to activate`], { stdio: "ignore" });
  } catch {
    // open 已经把应用拉起。
  }
  return { restarted: true };
}

function applyOpenCode(key) {
  const path = opencodeAuthPath();
  const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const current = data["opencode-go"] && typeof data["opencode-go"] === "object" ? data["opencode-go"] : {};
  data["opencode-go"] = { ...current, type: current.type || "api", key };
  writeJson(path, data);
  return [{ target: "opencode", name: "opencode-go" }];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(200);
  }
  return predicate();
}

function mainOpenCodePids() {
  try {
    const out = execFileSync("pgrep", ["-f", "/Applications/OpenCode.app/Contents/MacOS/OpenCode"], { encoding: "utf8" });
    return out.trim().split("\n").map((line) => line.trim()).filter((pid) => /^\d+$/.test(pid));
  } catch {
    return [];
  }
}

async function restartOpenCode() {
  const before = mainOpenCodePids();
  if (!before.length) return { restarted: false, pid: null };
  try {
    execFileSync("osascript", ["-e", 'tell application "OpenCode" to quit'], { stdio: "ignore" });
  } catch {
    // 没响应时再按主进程结束。
  }
  let gone = await waitFor(() => mainOpenCodePids().length === 0, 8000);
  if (!gone) {
    for (const pid of mainOpenCodePids()) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // 进程可能刚刚退出。
      }
    }
    gone = await waitFor(() => mainOpenCodePids().length === 0, 4000);
  }
  if (!gone) throw new Error("密钥已写入，但 OpenCode 没有退出");
  execFileSync("open", ["-a", "OpenCode"], { stdio: "ignore" });
  let pid = null;
  const opened = await waitFor(() => {
    const now = mainOpenCodePids();
    pid = now.find((item) => !before.includes(item)) ?? now[0] ?? null;
    return pid != null;
  }, 12000);
  if (!opened) throw new Error("密钥已写入，但 OpenCode 没有重新打开");
  try {
    execFileSync("osascript", ["-e", 'tell application "OpenCode" to activate'], { stdio: "ignore" });
  } catch {
    // open 已经把应用拉起。
  }
  return { restarted: true, pid: Number(pid) };
}

function applyLiveCodex(key) {
  const path = codexConfigPath();
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (!text.includes("opencode.ai/zen/go")) return [];
  const next = text.replace(
    /experimental_bearer_token\s*=\s*"[^"]*"/g,
    `experimental_bearer_token = "${key}"`,
  );
  if (next === text) return [];
  writeFileSync(path, next.endsWith("\n") ? next : `${next}\n`);
  return [{ target: "codex", name: "当前配置" }];
}

function applyLiveClaudeDesktop(key) {
  const path = claudeDesktopProfilePath();
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!String(data.inferenceGatewayBaseUrl || "").includes("opencode.ai/zen/go")) return [];
  data.inferenceGatewayApiKey = key;
  writeJson(path, data);
  return [{ target: "claude-desktop", name: "当前配置" }];
}

function dshHome() {
  return join(homedir(), ".dsh");
}

function collectOpenCodeCredentialNames(text, names) {
  let provider = null;
  let base = "";
  let env = "";
  const flush = () => {
    if (provider && base.includes("opencode.ai") && env) names.add(env);
  };
  for (const line of text.split(/\n/)) {
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const key = match[2];
    const value = match[3].trim();
    if (indent === 6 && !value && key !== "headers" && key !== "models") {
      flush();
      provider = key;
      base = "";
      env = "";
    } else if (key === "baseURL") {
      base = value;
    } else if (key === "apiKeyEnv") {
      env = value.replace(/^['"]|['"]$/g, "");
    }
  }
  flush();
}

function opencodeCredentialNames() {
  const names = new Set(["OPENCODE_GO_API_KEY"]);
  const root = join(dshHome(), "profiles");
  if (!existsSync(root)) return names;
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") visit(path);
      } else if (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) {
        collectOpenCodeCredentialNames(readFileSync(path, "utf8"), names);
      }
    }
  };
  visit(root);
  return names;
}

export function applyDeepSeekHarness(key) {
  const path = join(dshHome(), ".credentials.yaml");
  if (!existsSync(path)) return [];
  const names = opencodeCredentialNames();
  const original = readFileSync(path, "utf8");
  const replaced = [];
  const next = original.split("\n").map((line) => {
    const match = line.match(/^(\s*)([A-Za-z0-9_]+)(\s*:\s*)(.*)$/);
    if (!match || !names.has(match[2])) return line;
    const value = match[4].trim();
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
    const rendered = quote ? `${quote}${key}${quote}` : key;
    if (value.replace(/^['"]|['"]$/g, "") === key) {
      replaced.push(match[2]);
      return line;
    }
    replaced.push(match[2]);
    return `${match[1]}${match[2]}${match[3]}${rendered}`;
  }).join("\n");
  if (next !== original) writeFileSync(path, next);
  return [...new Set(replaced)].map((name) => ({ target: "deepseek-harness", name }));
}

async function restartDeepSeekHarness() {
  const marker = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
  const pids = () => {
    try {
      const out = execFileSync("pgrep", ["-f", marker], { encoding: "utf8" });
      return out.trim().split("\n").map((line) => line.trim()).filter((pid) => /^\d+$/.test(pid));
    } catch {
      return [];
    }
  };
  const before = pids();
  if (!before.length) return { restarted: false };
  try {
    execFileSync("osascript", ["-e", 'tell application "DeepSeek Harness" to quit'], { stdio: "ignore" });
  } catch {
    // 没响应时再按主进程结束。
  }
  let gone = await waitFor(() => pids().length === 0, 8000);
  if (!gone) {
    for (const pid of pids()) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // 进程可能刚刚退出。
      }
    }
    gone = await waitFor(() => pids().length === 0, 4000);
  }
  if (!gone) throw new Error("密钥已写入，但 DeepSeek Harness 没有退出");
  execFileSync("open", ["-a", "DeepSeek Harness"], { stdio: "ignore" });
  const opened = await waitFor(() => pids().length > 0, 12000);
  if (!opened) throw new Error("密钥已写入，但 DeepSeek Harness 没有重新打开");
  try {
    execFileSync("osascript", ["-e", 'tell application "DeepSeek Harness" to activate'], { stdio: "ignore" });
  } catch {
    // open 已经把应用拉起。
  }
  return { restarted: true };
}

export async function applySelectedKey(id) {
  const store = readStore();
  const item = store.keys.find((key) => key.id === id);
  if (!item) throw new Error("找不到这个密钥");
  const known = new Set(store.keys.map((entry) => entry.key));
  const updated = [
    ...applyCcSwitch(item.key, known),
    ...applyOpenCode(item.key),
    ...applyKimiCode(item.key),
    ...applyLiveCodex(item.key),
    ...applyLiveClaudeDesktop(item.key),
    ...applyDeepSeekHarness(item.key),
  ];
  if (!updated.some((entry) => entry.target === "cc-switch")) {
    throw new Error("cc-switch 里没有指向 OpenCode Go 的供应商");
  }
  const opencode = await restartOpenCode();
  const harness = await restartDeepSeekHarness();
  const kimi = await restartApp("Kimi Code", "/Applications/Kimi Code.app/Contents/MacOS/Kimi Code");
  return {
    command: "go-keys-use",
    name: item.name,
    tail: tailOf(item.key),
    updated,
    ccSwitchRunning: ccSwitchIsRunning(),
    opencodeRestarted: opencode.restarted,
    harnessRestarted: harness.restarted,
    kimiRestarted: kimi.restarted,
  };
}
