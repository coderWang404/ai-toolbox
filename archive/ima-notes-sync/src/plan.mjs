// 只读预演：不写本地、不写 ima，输出「这一轮同步会做什么」。
// 远端增量靠 list_note 的 modify_time 判断，不逐篇拉正文，避免限频。
// 正文中到底能不能保真 Markdown，须由 probe.mjs 实测后再定稿 PULL 转换器。
import { loadConfig, loadCredentials } from "./config.mjs";
import { scanVault, titleFor } from "./vault.mjs";
import { loadState, statsOf } from "./state.mjs";
import { ImaClient } from "./ima-api.mjs";
import { decide, Decision, summarize } from "./reconcile.mjs";

// 远端 modify_time 变了但正文尚未拉取时的哨兵：只用于让三方比对得出 pull/conflict，
// 不等于真实内容 hash，绝不写进 state。
const REMOTE_DIRTY = "__remote_dirty_unfetched__";

export function localStatus(config = loadConfig()) {
  const files = scanVault(config.vaultRoot, config);
  const state = loadState();
  const mapped = files.filter((f) => state.entries[f.path]).length;
  return {
    vaultRoot: config.vaultRoot,
    excludes: config.excludes,
    totalFiles: files.length,
    textFiles: files.filter((f) => f.isText).length,
    binaryFiles: files.filter((f) => !f.isText).length,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    mapped,
    unmapped: files.length - mapped,
    state: statsOf(state),
    files: files.map((f) => ({
      path: f.path, hash: f.hash.slice(0, 12), size: f.size,
      mtimeMs: f.mtimeMs, kind: f.isText ? "text" : "binary",
    })),
  };
}

function safeName(title) {
  return String(title || "未命名")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "未命名";
}

/**
 * @param {object} config
 * @param {object} creds  可选；缺省时从 ~/.config/ima 读
 * @returns 决策清单（只读，不落盘）
 */
export async function buildPlan(config = loadConfig(), creds = undefined) {
  const client = new ImaClient(creds ?? loadCredentials());
  const files = scanVault(config.vaultRoot, config);
  const state = loadState();
  const notes = await client.allNotes();

  const byNoteId = new Map(notes.filter((n) => n.noteId).map((n) => [n.noteId, n]));
  const mappedNoteIds = new Set(
    Object.values(state.entries).map((e) => e.noteId).filter(Boolean)
  );
  const items = [];

  for (const file of files) {
    const rec = state.entries[file.path] ?? null;
    const remoteNote = rec?.noteId ? byNoteId.get(rec.noteId) : null;
    const remoteExists = Boolean(remoteNote);
    const modifyTime = Number(remoteNote?.modifyTime ?? 0);
    const knownModifyTime = Number(rec?.remoteModifyTime ?? 0);
    const dirty = remoteExists && modifyTime > knownModifyTime;
    const remoteHash = !remoteExists
      ? null
      : dirty ? REMOTE_DIRTY : (rec?.remoteHash ?? rec?.baseHash ?? null);

    const decision = decide({
      localExists: true,
      localHash: file.hash,
      remoteExists,
      remoteHash,
      baseHash: rec?.baseHash ?? null,
      hadRecord: Boolean(rec),
    });
    items.push({
      path: file.path,
      title: titleFor(file.path),
      decision,
      noteId: rec?.noteId ?? null,
      remoteModifyTime: modifyTime || null,
      dirty,
    });
  }

  // ima 里新建、本地映射表里没有的笔记 → 准备落到 inbox 目录
  for (const note of notes) {
    if (!note.noteId || mappedNoteIds.has(note.noteId)) continue;
    items.push({
      path: `${config.inboxDir}/${safeName(note.title)}.md`,
      title: note.title,
      decision: Decision.CREATE_LOCAL,
      noteId: note.noteId,
      remoteModifyTime: note.modifyTime,
      dirty: true,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    vaultRoot: config.vaultRoot,
    remoteNotes: notes.length,
    counts: summarize(items.map((i) => i.decision)),
    items,
  };
}

export function formatPlan(plan) {
  const lines = [];
  lines.push(`预演时间: ${plan.generatedAt}`);
  lines.push(`本地 vault: ${plan.vaultRoot}`);
  lines.push(`ima 侧笔记: ${plan.remoteNotes} 篇`);
  lines.push(`决策汇总: ${JSON.stringify(plan.counts)}`);
  lines.push("");
  const interesting = plan.items.filter((i) => i.decision !== Decision.NOOP);
  if (interesting.length === 0) {
    lines.push("两端一致，无需同步。");
    return lines.join("\n");
  }
  lines.push("待处理:");
  for (const item of interesting) {
    lines.push(`  ${item.decision.padEnd(14)} ${item.path}${item.dirty ? "  (ima 侧有改动)" : ""}`);
  }
  const skipped = plan.items.length - interesting.length;
  if (skipped > 0) lines.push(`\n另有 ${skipped} 篇两端一致，跳过。`);
  return lines.join("\n");
}
