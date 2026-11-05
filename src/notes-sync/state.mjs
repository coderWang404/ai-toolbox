// 同步映射表：path ↔ ima note_id / media_id，以及上次一致的内容基线。
// 放在 ~/.ai-toolbox/ 下（vault 外），不进百度云同步盘。
import { readFileSync, existsSync } from "node:fs";
import { dataFile } from "../paths.mjs";
import { atomicWrite } from "./vault.mjs";

export const STATE_VERSION = 1;

export function statePath() {
  return process.env.NOTES_SYNC_STATE || dataFile("notes-sync-state.json");
}

export function emptyState() {
  return { version: STATE_VERSION, updatedAt: 0, entries: {}, inboxNotes: {}, inboxInitialized: false };
}

export function loadState(file = statePath()) {
  if (!existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed.entries !== "object" || parsed.entries === null) {
      return emptyState();
    }
    return {
      version: STATE_VERSION,
      updatedAt: parsed.updatedAt ?? 0,
      entries: parsed.entries,
      inboxNotes: parsed.inboxNotes ?? {},
      inboxInitialized: Boolean(parsed.inboxInitialized),
    };
  } catch {
    // 状态文件损坏时不能静默重置（否则会把全库当成首次同步，造成重复导入）。
    throw new Error(`同步状态文件损坏，拒绝覆盖：${file}。请手工检查或从备份恢复。`);
  }
}

export function saveState(state, file = statePath()) {
  const payload = {
    version: STATE_VERSION,
    updatedAt: Date.now(),
    entries: state.entries,
    inboxNotes: state.inboxNotes ?? {},
    inboxInitialized: Boolean(state.inboxInitialized),
  };
  atomicWrite(file, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
  return payload;
}

/** 一条映射记录的字段（v2 路径镜像）：
 * path, mediaId, fileSize, baseLocalHash, remoteUpdateTime, lastSyncAt
 * v1 的 noteId / baseHash / remoteHash / remoteModifyTime 已不再写入。
 */
export function recordFor(state, relPath) {
  return state.entries[relPath] ?? null;
}

export function putRecord(state, relPath, record) {
  state.entries[relPath] = { path: relPath, ...record };
}

export function removeRecord(state, relPath) {
  delete state.entries[relPath];
}

export function statsOf(state) {
  const entries = Object.values(state.entries);
  return {
    total: entries.length,
    withMediaId: entries.filter((e) => e.mediaId).length,
    withBaseHash: entries.filter((e) => e.baseLocalHash).length,
    lastSyncAt: entries.reduce((max, e) => Math.max(max, e.lastSyncAt ?? 0), 0),
  };
}
