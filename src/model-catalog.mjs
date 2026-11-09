// 供应商模型列表：cc-switch 里大多数供应商没有配置 modelCatalog，
// 桌面端就只能显示 Codex 内置模型，切过去后「模型拉不出来」。
// 这里直接用供应商自己的 OpenAI 兼容 /models 端点补齐，并转成 Codex 的 catalog。
//
// 注意：模板里的能力（推理档位、上下文窗口）是通用占位值，直接用会把 gpt-6.x
// 这类模型降级成 none/high + 128k，导致推理强度选不了。所以生成时优先从
// Codex 自己的模型清单（models_cache.json）里按 slug 继承真实能力。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildCatalog } from "./catalog.mjs";
import { codexHome } from "./paths.mjs";

const NON_CHAT_PATTERNS = [
  /(^|[/_.-])(tts|asr|whisper|audio|speech|realtime|embed|embedding|embeddings|rerank|moderation)([/_.-]|$)/i,
  /(^|[/_.-])(image|images|dall-?e|sora|video|ocr)([/_.-]|$)/i,
  /(^|[/_.-])(vision-only|guard|classifier)([/_.-]|$)/i,
];

const MAX_CATALOG_MODELS = 40;

export function normalizeBaseUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

/** 供应商 /models 地址：兼容 base_url 已经带 /v1 或直接给到 /models 的情况。 */
export function modelsUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return null;
  if (/\/models$/i.test(base)) return base;
  return `${base}/models`;
}

export function isChatModel(id) {
  const value = String(id ?? "").trim();
  if (!value) return false;
  return !NON_CHAT_PATTERNS.some((re) => re.test(value));
}

/**
 * 过滤 + 排序：配置里的 model 排第一，然后按供应商返回顺序；
 * 过滤掉音频 / 向量 / 图像等非对话模型，并限制条目数量。
 */
export function selectCatalogModels(ids, { preferred = null, limit = MAX_CATALOG_MODELS } = {}) {
  const seen = new Set();
  const out = [];
  const push = (id) => {
    const value = String(id ?? "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  if (preferred) push(preferred);
  for (const id of ids ?? []) {
    if (!isChatModel(id)) continue;
    push(id);
  }
  return out.slice(0, limit);
}

function parseModelIds(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  return rows
    .map((row) => {
      if (typeof row === "string") return row;
      if (!row || typeof row !== "object") return null;
      return row.id ?? row.slug ?? row.model ?? row.name ?? null;
    })
    .filter((id) => typeof id === "string" && id.trim());
}

/**
 * 请求供应商的 /models。
 * @returns {Promise<{ok:boolean, models:string[], ms:number, status?:number, error?:string}>}
 */
export async function fetchProviderModels({ baseUrl, token, timeoutMs = 8000 } = {}) {
  const url = modelsUrl(baseUrl);
  const started = Date.now();
  if (!url) return { ok: false, models: [], ms: 0, error: "供应商没有 base_url" };
  if (!token) return { ok: false, models: [], ms: 0, error: "供应商没有可用的 API key" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        models: [],
        ms: Date.now() - started,
        status: response.status,
        error: `HTTP ${response.status}: ${text.slice(0, 120)}`,
      };
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, models: [], ms: Date.now() - started, status: response.status, error: "返回不是 JSON" };
    }
    const models = parseModelIds(payload);
    if (!models.length) {
      return { ok: false, models: [], ms: Date.now() - started, status: response.status, error: "供应商返回 0 个模型" };
    }
    return { ok: true, models, ms: Date.now() - started, status: response.status };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return {
      ok: false,
      models: [],
      ms: Date.now() - started,
      error: aborted ? `请求超时（${Math.round(timeoutMs / 1000)}s）` : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读 Codex 自己的模型清单（桌面端上次拉到的 manifest），按 slug 提供真实能力：
 * 推理档位、上下文窗口、工具支持等。没有这份文件时返回空 Map。
 */
export function loadReferenceModels(home = codexHome()) {
  const files = ["models_cache.json", "models_cache.codex_work_desktop.json"];
  const reference = new Map();
  for (const name of files) {
    const file = path.join(home, name);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      for (const entry of parsed?.models ?? []) {
        const slug = typeof entry?.slug === "string" ? entry.slug.trim().toLowerCase() : "";
        if (!slug || reference.has(slug)) continue;
        reference.set(slug, entry);
      }
    } catch {
      /* 缓存损坏就跳过 */
    }
  }
  return reference;
}

/** 没有参考能力时的兜底：gpt/codex 系模型给常见档位，避免只剩 none/high。 */
const GPT_FAMILY_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const LEVEL_DESCRIPTIONS = {
  none: "Disable Thinking",
  minimal: "Minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
  ultra: "Ultra reasoning depth",
};

function upgradeReasoningLevels(entry, { requiredEffort = null } = {}) {
  const existing = (entry.supported_reasoning_levels ?? []).map((level) => level.effort);
  const looksGpt = /(^|[/_.-])(gpt|codex)([/_.-]|\d|$)/i.test(entry.slug ?? "");
  if (!looksGpt || existing.includes("xhigh")) return entry;
  const levels = [...GPT_FAMILY_LEVELS];
  if (requiredEffort && !levels.includes(requiredEffort)) levels.push(requiredEffort);
  entry.supported_reasoning_levels = levels.map((effort) => ({ effort, description: LEVEL_DESCRIPTIONS[effort] ?? effort }));
  if (!levels.includes(entry.default_reasoning_level)) entry.default_reasoning_level = "medium";
  return entry;
}

/**
 * 用供应商返回的模型 id 生成 Codex catalog（复用 catalog.mjs 的模板逻辑）。
 * @param {{configText?:string, apiFormat?:string, preferred?:string|null,
 *   reference?:Map<string,object>, requiredEffort?:string|null}} opts
 * @returns {{models: object[]} | null}
 */
export function buildCatalogFromModelIds(
  ids,
  { configText, apiFormat, preferred = null, reference = new Map(), requiredEffort = null } = {},
) {
  const selected = selectCatalogModels(ids, { preferred });
  if (!selected.length) return null;
  const catalog = buildCatalog({
    settings: { modelCatalog: { models: selected.map((model) => ({ model })) } },
    configText,
    apiFormat,
    isOfficial: false,
  });
  if (!catalog) return null;

  catalog.models = catalog.models.map((entry) => {
    const ref = reference.get(String(entry.slug).trim().toLowerCase());
    if (ref) {
      // 继承真实能力（档位 / 上下文 / 工具），只保留本次生成的标识与排序。
      const merged = {
        ...structuredClone(ref),
        slug: entry.slug,
        display_name: entry.display_name,
        description: entry.description,
        priority: entry.priority,
        input_modalities: entry.input_modalities,
      };
      return upgradeReasoningLevels(merged, { requiredEffort });
    }
    return upgradeReasoningLevels(entry, { requiredEffort });
  });
  return catalog;
}
