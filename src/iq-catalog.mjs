// 从 cc-switch 取出可以用 OpenAI Chat 协议调用的供应商和模型。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ccSwitchDbPath } from "./paths.mjs";

function sqliteJson(dbPath, sql) {
  const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const trimmed = out.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

function parseJson(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function pushModel(list, id) {
  const name = String(id || "").trim();
  if (!name || list.includes(name)) return;
  list.push(name);
}

function codexBaseUrl(configText) {
  return configText.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

function codexModel(configText) {
  return configText.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

function chatBase(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  if (!trimmed) return null;
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

function usableModel(value) {
  const id = String(value || "").replace(/\[[^\]]*\]\s*$/, "").trim();
  if (!id || /^(opus|sonnet|haiku|fable)$/i.test(id)) return null;
  return id;
}

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"];
const THINKING_ALIAS = {
  none: "off",
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
  ultra: "xhigh",
};

function normalizeThinking(value) {
  return THINKING_ALIAS[String(value || "").trim().toLowerCase()] || null;
}

function inferredLevels(id) {
  const name = String(id || "").toLowerCase();
  if (/think|reason/.test(name) || /^step-5/.test(name)) return ["off", "low", "medium", "high"];
  if (/opus|sonnet/.test(name)) return ["off", "low", "medium", "high"];
  if (/deepseek|glm-|kimi|qwen|grok|minimax|mimo|muse-spark|hy[0-9]|gpt-|longcat|gemini/.test(name)) {
    return ["off", "low", "medium", "high"];
  }
  return ["off"];
}

export function resolveThinking(id, hint = {}) {
  const explicit = (hint.levels || []).map(normalizeThinking).filter(Boolean);
  let chosen = ["off"];
  if (explicit.length) chosen = explicit;
  else if (hint.reasoning === true) chosen = ["off", "low", "medium", "high"];
  else chosen = inferredLevels(id);
  const levels = THINKING_ORDER.filter((level) => new Set([...chosen, "off"]).has(level));
  const preferred = normalizeThinking(hint.defaultLevel);
  let defaultThinking = "off";
  if (levels.includes(preferred)) defaultThinking = preferred;
  else if (/^step-5/.test(id)) defaultThinking = levels.includes("high") ? "high" : "off";
  else if (levels.includes("medium")) defaultThinking = "medium";
  else if (levels.some((level) => level !== "off")) defaultThinking = levels.find((level) => level !== "off");
  if (levels.length === 1) defaultThinking = "off";
  return { thinkingLevels: levels, defaultThinking };
}

function rememberModel(bucket, id, hint = {}) {
  const name = usableModel(id);
  if (!name) return;
  const prev = bucket.get(name) || { id: name };
  bucket.set(name, {
    id: name,
    levels: hint.levels || prev.levels,
    defaultLevel: hint.defaultLevel || prev.defaultLevel,
    reasoning: hint.reasoning === true || prev.reasoning === true,
  });
}

function collectClaudeModels(settings, meta) {
  const models = [];
  const env = settings.env && typeof settings.env === "object" ? settings.env : {};
  const sources = [settings, env];
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (!/model/i.test(key) || /description|name/i.test(key)) continue;
      if (typeof value === "string") pushModel(models, usableModel(value));
    }
  }
  const routes = meta?.claudeDesktopModelRoutes;
  if (routes && typeof routes === "object") {
    for (const route of Object.values(routes)) {
      if (route && typeof route === "object") pushModel(models, usableModel(route.model));
    }
  }
  const configured = settings.modelSettings;
  if (configured && typeof configured === "object") {
    for (const id of Object.keys(configured)) pushModel(models, usableModel(id));
  }
  return models;
}

function modelIdsFromPayload(body) {
  const list = Array.isArray(body) ? body : (body?.data || body?.models || []);
  if (!Array.isArray(list)) return [];
  return list.map((item) => (typeof item === "string" ? item : (item?.id || item?.name || ""))).filter(Boolean);
}

async function fetchModelIds(provider) {
  const base = String(provider.baseUrl || "").replace(/\/+$/, "");
  if (!base || !provider.apiKey) return [];
  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    Accept: "application/json",
    "User-Agent": "ai-toolbox/1.0",
  };
  if (provider.appType === "claude" || provider.appType === "claude-desktop") headers["x-api-key"] = provider.apiKey;
  if (base.includes("opencode.ai")) headers["x-opencode-session"] = "ai-toolbox-models";
  const response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) return [];
  return modelIdsFromPayload(await response.json());
}

function listLocalIqProviders() {
  const db = ccSwitchDbPath();
  if (!existsSync(db)) throw new Error(`找不到 cc-switch 数据库: ${db}`);
  const rows = sqliteJson(
    db,
    "SELECT id, app_type, name, settings_config, meta FROM providers ORDER BY app_type, name",
  );
  const providers = [];
  for (const row of rows) {
    const settings = parseJson(row.settings_config);
    const meta = parseJson(row.meta);
    const bucket = new Map();
    let baseUrl = null;
    let apiKey = null;
    if (row.app_type === "opencode") {
      baseUrl = chatBase(settings.options?.baseURL);
      apiKey = settings.options?.apiKey || null;
      for (const [id, info] of Object.entries(settings.models || {})) {
        rememberModel(bucket, id, { reasoning: info?.reasoning === true });
      }
    } else if (row.app_type === "codex") {
      const config = typeof settings.config === "string" ? settings.config : "";
      baseUrl = chatBase(codexBaseUrl(config));
      apiKey = settings.auth?.OPENAI_API_KEY || null;
      const effort = config.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1];
      const configured = usableModel(codexModel(config));
      if (configured) rememberModel(bucket, configured, { defaultLevel: effort });
      for (const item of settings.modelCatalog?.models || []) {
        const levels = item.reasoningLevels || item.reasoning_levels;
        rememberModel(bucket, item.model || item.slug, {
          levels: Array.isArray(levels) ? levels : undefined,
          defaultLevel: item.defaultReasoningLevel || item.default_reasoning_level,
          reasoning: item.reasoning === true,
        });
      }
    } else if (row.app_type === "claude" || row.app_type === "claude-desktop") {
      const env = settings.env && typeof settings.env === "object" ? settings.env : {};
      baseUrl = chatBase(env.ANTHROPIC_BASE_URL);
      apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || null;
      for (const id of collectClaudeModels(settings, meta)) rememberModel(bucket, id);
    }
    if (row.app_type === "claude-desktop") continue;
    if (!baseUrl || !apiKey) continue;
    if (baseUrl.includes("opencode.ai/zen/go")) rememberModel(bucket, "space-bunny-free");
    const models = [...bucket.values()].map((item) => ({ id: item.id, ...resolveThinking(item.id, item) }));
    if (row.id === "codex-official" || row.name === "OpenAI Official") continue;
    if (row.id === "claude-official" || row.id === "claude-desktop-official") continue;
    providers.push({
      id: String(row.id),
      appType: String(row.app_type),
      name: String(row.name),
      baseUrl,
      models,
      apiKey,
      configText: row.app_type === "codex" && typeof settings.config === "string" ? settings.config : null,
      env: settings.env && typeof settings.env === "object" ? settings.env : null,
    });
  }
  return providers;
}

export async function listIqProviders() {
  const providers = listLocalIqProviders();
  await Promise.all(providers.map(async (provider) => {
    let ids = [];
    try {
      ids = await fetchModelIds(provider);
    } catch {
      ids = [];
    }
    const seen = new Set(provider.models.map((item) => item.id));
    for (const id of ids) {
      const name = usableModel(id);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      provider.models.push({ id: name, ...resolveThinking(name) });
    }
    provider.models.sort((a, b) => a.id.localeCompare(b.id));
  }));
  return providers.filter((provider) => provider.models.length);
}

export function findIqProvider(query) {
  const providers = listLocalIqProviders();
  const raw = String(query || "").trim();
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const appType = raw.slice(0, slash);
    const id = raw.slice(slash + 1);
    const exact = providers.find((item) => item.appType === appType && (item.id === id || item.name === id));
    if (exact) return exact;
  }
  const q = raw.toLowerCase();
  return (
    providers.find((item) => `${item.appType}/${item.id}`.toLowerCase() === q) ??
    providers.find((item) => item.id.toLowerCase() === q) ??
    providers.find((item) => item.name.toLowerCase() === q && item.baseUrl.includes("opencode.ai")) ??
    providers.find((item) => item.name.toLowerCase() === q) ??
    providers.find((item) => item.name.toLowerCase().includes(q)) ??
    null
  );
}

export function publicIqProvider(provider) {
  return {
    id: provider.id,
    appType: provider.appType,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: provider.models,
  };
}
