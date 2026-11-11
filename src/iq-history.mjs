// 智商测试的历史结果：只存摘要和回复文本，不存密钥；最多保留 50 条。
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./paths.mjs";

export const IQ_HISTORY_LIMIT = 50;
export const IQ_REPLY_LIMIT = 20000;

export function iqHistoryPath() {
  return dataFile("iq-history.json");
}

function scrub(text) {
  return String(text ?? "").replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-…");
}

/** 统一字段并截断超长回复；纯函数，便于测试。 */
export function normalizeHistoryEntry(entry) {
  const rawReply = typeof entry?.reply === "string" ? entry.reply : "";
  const reply = rawReply ? scrub(rawReply).slice(0, IQ_REPLY_LIMIT) : null;
  return {
    id: String(entry?.id ?? `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
    at: String(entry?.at ?? new Date().toISOString()),
    topic: entry?.topic ?? null,
    topicTitle: entry?.topicTitle ?? null,
    providerId: entry?.providerId ?? null,
    providerName: entry?.providerName ?? null,
    model: entry?.model ?? null,
    thinking: entry?.thinking ?? null,
    answer: entry?.answer ?? null,
    reply,
    replyTruncated: rawReply.length > IQ_REPLY_LIMIT,
    elapsedMs: Number.isFinite(entry?.elapsedMs) ? Math.max(0, Math.round(entry.elapsedMs)) : null,
    stopReason: entry?.stopReason ?? null,
    htmlPath: entry?.htmlPath ?? null,
    inspect: entry?.inspect ?? null,
    error: entry?.error ? scrub(entry.error).slice(0, 300) : null,
  };
}

/** 新结果放最前，超出上限丢弃最旧的；纯函数。 */
export function mergeHistory(entries, entry, limit = IQ_HISTORY_LIMIT) {
  const list = Array.isArray(entries) ? entries : [];
  return [normalizeHistoryEntry(entry), ...list].slice(0, Math.max(1, limit));
}

export function readIqHistory(limit = 20) {
  const file = iqHistoryPath();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(parsed) ? parsed : [];
    return list.slice(0, Math.max(0, limit));
  } catch {
    return [];
  }
}

function writeHistory(entries) {
  const file = iqHistoryPath();
  const tmp = path.join(path.dirname(file), `.iq-history.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* 忽略 */
  }
  renameSync(tmp, file);
}

export function appendIqHistory(entry) {
  const entries = mergeHistory(readIqHistory(IQ_HISTORY_LIMIT), entry);
  writeHistory(entries);
  return entries;
}

export function clearIqHistory() {
  writeHistory([]);
}
