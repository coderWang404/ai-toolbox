// 本地 Markdown ↔ ima 正文的转换。
// 两种回写策略可插拔，等 notes-probe 实测出 ima 到底能不能返回 Markdown 再定默认值：
//   markdown —— 远端能保真返回 Markdown，直接全文覆盖本地
//   append   —— 远端只给纯文本，只把「远端比本地多出来的行」追加进本地补记块，绝不覆盖原文
// append 模式下，补记块在推送前会被剥离，避免本地/远端互相搬运形成死循环。
import { sha256 } from "./vault.mjs";

export const PULL_MODE = Object.freeze({ MARKDOWN: "markdown", APPEND: "append" });
export const APPEND_HEADING = /^## ima 补记 /m;

/** 剥离从 ima 回写进来的补记块，得到可以推回 ima 的「正文」。 */
export function stripImaAppendix(text) {
  if (typeof text !== "string") return "\n";
  const idx = text.search(APPEND_HEADING);
  const base = idx >= 0 ? text.slice(0, idx) : text;
  // 无论有没有补记块都做同样的末尾规范化，否则回写后 canonicalHash 会漂移，
  // 下一轮误判成「本地改过」并反复回推，形成同步死循环。
  return `${base.replace(/\s*$/, "")}\n`;
}

/** 推送用的规范 hash：两边都基于「剥离补记块后的正文」计算，保证可比对。 */
export function canonicalHash(text) {
  return sha256(Buffer.from(stripImaAppendix(text), "utf8"));
}

/** 本地 → ima：剥离补记块，其余原样保留（不改写 wikilink / callout / frontmatter）。 */
export function toIma(localContent) {
  return stripImaAppendix(localContent);
}

/** 找出远端有、本地没有的行（按去空白后的行内容比对），保序。 */
export function newLinesFrom(remoteText, localText) {
  const known = new Set(
    String(localText ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  );
  return String(remoteText ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !known.has(line.trim()));
}

/**
 * 把 ima 侧的改动并回本地。
 * @returns {{content:string, changed:boolean, mode:string, addedLines:number}}
 */
export function mergeRemoteIntoLocal(localContent, remoteContent, opts = {}) {
  const mode = opts.mode ?? PULL_MODE.APPEND;
  const local = String(localContent ?? "");
  const remote = String(remoteContent ?? "");

  if (mode === PULL_MODE.MARKDOWN) {
    const changed = remote !== local;
    return { content: remote, changed, mode, addedLines: 0 };
  }

  const added = newLinesFrom(remote, stripImaAppendix(local));
  if (added.length === 0) {
    return { content: local, changed: false, mode, addedLines: 0 };
  }
  const stamp = opts.stamp ?? new Date().toISOString().slice(0, 16).replace("T", " ");
  const base = stripImaAppendix(local).replace(/\s*$/, "");
  const previous = local.search(APPEND_HEADING) >= 0
    ? local.slice(local.search(APPEND_HEADING)).replace(/^## ima 补记 [^\n]*\n/, "").trim()
    : "";
  const mergedLines = previous
    ? [...previous.split("\n"), ...added.filter((l) => !previous.includes(l))]
    : added;
  return {
    content: `${base}\n\n## ima 补记 ${stamp}\n\n${mergedLines.join("\n")}\n`,
    changed: true,
    mode,
    addedLines: added.length,
  };
}

/** 把标题变成可落盘的文件名。 */
export function safeName(title) {
  return String(title || "未命名")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "未命名";
}
