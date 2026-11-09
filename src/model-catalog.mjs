// 供应商模型列表：cc-switch 里大多数供应商没有配置 modelCatalog，
// 桌面端就只能显示 Codex 内置模型，切过去后「模型拉不出来」。
// 这里直接用供应商自己的 OpenAI 兼容 /models 端点补齐，并转成 Codex 的 catalog。
import { buildCatalog } from "./catalog.mjs";

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
 * 用供应商返回的模型 id 生成 Codex catalog（复用 catalog.mjs 的模板逻辑）。
 * @returns {{models: object[]} | null}
 */
export function buildCatalogFromModelIds(ids, { configText, apiFormat, preferred = null } = {}) {
  const selected = selectCatalogModels(ids, { preferred });
  if (!selected.length) return null;
  return buildCatalog({
    settings: { modelCatalog: { models: selected.map((model) => ({ model })) } },
    configText,
    apiFormat,
    isOfficial: false,
  });
}
