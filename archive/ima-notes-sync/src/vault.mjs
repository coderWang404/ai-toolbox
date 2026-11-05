// 本地 vault 扫描与写入。只处理 markdown，图片/附件一概不动。
// 百度云同步盘会让目录条目数剧烈波动，所有 stat/read 失败一律跳过而不是抛错。
import {
  readdirSync, readFileSync, statSync, writeFileSync, renameSync,
  mkdirSync, existsSync, chmodSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_EXCLUDES } from "./config.mjs";

const IGNORED_NAMES = new Set(["Thumbs.db", "desktop.ini", ".DS_Store"]);
// 这些都是技术噪声，不是知识内容。百度云冲突副本会被单独清理，同步时也不推。
const IGNORED_PATTERNS = [
  /\.tmp$/, /\.tmp\.\d+$/, /\.swp$/, /\.bak$/, /^~\$/,
  /\.crdownload$/, /\.part$/,
  /冲突文件/, /冲突副本/, /\(note-conflict /,
];

// ima OpenAPI create_media 的 MIME 对照表（不在表内的扩展名不允许猜测上传）。
export const MIME_BY_EXT = Object.freeze({
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  xmind: "application/x-xmind",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp3: "audio/mpeg",
  m4a: "audio/x-m4a",
  wav: "audio/wav",
  html: "text/html",
  epub: "application/epub+zip",
  aac: "audio/aac",
});

const TEXT_EXT = new Set(["md", "markdown", "txt", "csv", "html"]);
const BINARY_MEDIA_TYPE = 1;

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function extOf(relPath) {
  const name = relPath.split("/").pop();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function mimeFor(relPath) {
  return MIME_BY_EXT[extOf(relPath)] ?? null;
}

export function isTextFile(relPath) {
  return TEXT_EXT.has(extOf(relPath));
}

/** ima media_type：笔记型 11 / 文件型 1；未知扩展名返回 null（拒绝上传）。 */
export function mediaTypeFor(relPath) {
  if (isTextFile(relPath)) return 11;
  return mimeFor(relPath) ? BINARY_MEDIA_TYPE : null;
}

export function isIgnored(relPath, excludes = DEFAULT_EXCLUDES) {
  const parts = relPath.split("/");
  if (parts.some((p) => p.startsWith("."))) return true; // 点目录/点文件（.obsidian 等应用配置）
  const name = parts[parts.length - 1];
  if (IGNORED_NAMES.has(name)) return true;
  if (IGNORED_PATTERNS.some((re) => re.test(name))) return true;
  for (const prefix of excludes) {
    const clean = prefix.replace(/\/$/, "");
    if (relPath === clean || relPath.startsWith(`${clean}/`)) return true;
  }
  // 全库同步：不再按扩展名排除，但 ima 不认识的扩展名不上传。
  return mediaTypeFor(relPath) === null;
}

function excludedDir(relPath, excludes) {
  return excludes.some((prefix) => {
    const clean = prefix.replace(/\/$/, "");
    return relPath === clean || relPath.startsWith(`${clean}/`);
  });
}

/**
 * 扫描 vault，返回 [{path, hash, mtimeMs, size, content}]，按路径排序。
 * 符号链接不跟随；超过 maxFileBytes 跳过。
 */
export function scanVault(root, opts = {}) {
  const excludes = opts.excludes ?? DEFAULT_EXCLUDES;
  const maxBytes = opts.maxFileBytes ?? 10 * 1024 * 1024;
  const out = [];
  // contentCache 由常驻 daemon 跨轮持有：size+mtime 未变的文件直接复用上一轮的
  // 内容与 hash，不重复读盘。实测 macOS 沙箱下 readFileSync 约 6.5ms/次，
  // 606 文件全量读要 4 秒，命中缓存后降到几十毫秒，才能做到秒级轮询。
  walk(root, "", out, { excludes, maxBytes, cache: opts.contentCache ?? null });
  // 路径排序用字节字典序即可（localeCompare 每次比较都要初始化 Intl.Collator）。
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function walk(root, rel, out, opts) {
  let entries;
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      if (excludedDir(childRel, opts.excludes)) continue;
      walk(root, childRel, out, opts);
      continue;
    }
    if (!entry.isFile()) continue; // 不跟随符号链接
    if (isIgnored(childRel, opts.excludes)) continue;
    const full = path.join(root, childRel);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.size > opts.maxBytes) continue;
    const cached = opts.cache?.get(childRel);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      out.push(cached.entry);
      continue;
    }
    let buf;
    try {
      buf = readFileSync(full);
    } catch {
      continue;
    }
    const text = isTextFile(childRel);
    const fileEntry = {
      path: childRel,
      hash: sha256(buf),
      mtimeMs: st.mtimeMs,
      size: st.size,
      isText: text,
      mime: mimeFor(childRel),
      mediaType: mediaTypeFor(childRel),
      // 二进制不转 UTF-8（会变成乱码），上传时按 path 重新读取原始字节。
      content: text ? buf.toString("utf8") : null,
    };
    out.push(fileEntry);
    if (opts.cache) {
      opts.cache.set(childRel, { size: st.size, mtimeMs: st.mtimeMs, entry: fileEntry });
    }
  }
}

/** 原子写，避免百度云同步盘读到半截文件。 */
export function atomicWrite(fullPath, content, mode = 0o600) {
  mkdirSync(path.dirname(fullPath), { recursive: true });
  const tmp = `${fullPath}.notes-sync-${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, fullPath);
  try {
    chmodSync(fullPath, mode);
  } catch {
    // 某些同步盘不支持 chmod，忽略
  }
}

/** 删除前先移进回收站，保留 trashRetentionDays 天。 */
export function moveToTrash(vaultRoot, trashRoot, relPath, now = new Date()) {
  const source = path.join(vaultRoot, relPath);
  if (!existsSync(source)) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const dest = path.join(trashRoot, stamp, relPath);
  mkdirSync(path.dirname(dest), { recursive: true });
  renameSync(source, dest);
  return dest;
}

/** 标题取文件名（去扩展名），与归档规范「不用 frontmatter」保持一致。 */
export function titleFor(relPath) {
  const name = relPath.split("/").pop();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
