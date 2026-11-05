// 远端（ima 知识库）侧的统一入口：按「路径」组织，而不是按 noteId。
//
// 为什么按路径：用户的知识库里本来就是 vault 的镜像结构（笔记/life/原则库.md），
// 路径是唯一稳定的身份标识；media_id 在「删了重建」时会变，标题在 ima 里允许重名。
//
// 远端读写全部走 cgi（网页端接口），因为 OpenAPI 没有删除/改名/建目录能力。
import { CgiClient, MEDIA_TYPE } from "./cgi.mjs";
import { loadConfig } from "./config.mjs";

export const DEFAULT_KB_NAME = "个人知识库";
export const DEFAULT_ROOT_PATH = "笔记";

/** 建远端索引：相对路径 → 条目。rootPath 之前的层级会从 path 里剥掉。 */
export async function buildRemoteIndex({
  kbName = DEFAULT_KB_NAME,
  rootPath = DEFAULT_ROOT_PATH,
  client,
  config = loadConfig(),
} = {}) {
  const cgi = client ?? new CgiClient();
  const kbId = await cgi.resolveKnowledgeBaseId(kbName || config.knowledgeBaseName || DEFAULT_KB_NAME);

  // 定位 rootPath 对应的文件夹（逐级下钻）；没有就退回知识库根目录。
  let rootFolderId = kbId;
  const rootSegments = String(rootPath || "").split("/").filter(Boolean);
  const top = await cgi.listAll({ knowledgeBaseId: kbId });
  let walk = top;
  for (const seg of rootSegments) {
    const hit = walk.find((i) => i.mediaType === MEDIA_TYPE.FOLDER && i.title === seg);
    if (!hit) { walk = []; rootFolderId = null; break; }
    rootFolderId = hit.mediaId;
    walk = await cgi.listAll({ knowledgeBaseId: kbId, folderId: rootFolderId });
  }

  const items = [];
  if (rootFolderId) {
    items.push(...(await cgi.listTree({ knowledgeBaseId: kbId, folderId: rootFolderId })));
  }
  const byPath = new Map();
  for (const it of items) byPath.set(it.path, it);
  return {
    kbId,
    kbName,
    rootPath: rootSegments.join("/"),
    rootFolderId,
    items,
    byPath,
    client: cgi,
  };
}

/** 只打印目录树，文件按扩展名折叠统计，避免 600 行刷屏。 */
export function formatRemoteTree(index, { maxFiles = 0 } = {}) {
  const { items } = index;
  const dirs = items.filter((i) => i.mediaType === MEDIA_TYPE.FOLDER);
  const files = items.filter((i) => i.mediaType !== MEDIA_TYPE.FOLDER);
  const byExt = new Map();
  for (const f of files) {
    const m = /\.([^.]+)$/.exec(f.title);
    const ext = m ? m[1].toLowerCase() : "(无扩展名)";
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const lines = [
    `知识库 ${index.kbName} (${index.kbId})  根路径 ${index.rootPath || "/"}`,
    `共 ${items.length} 个节点：目录 ${dirs.length}，文件 ${files.length}`,
    `文件类型：${[...byExt.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join("  ")}`,
  ];
  const show = maxFiles > 0 ? files.slice(0, maxFiles) : [];
  if (show.length) {
    lines.push("", "文件列表（前若干条）：");
    for (const f of show) lines.push(`  ${f.path}  [${f.mediaId}]`);
  }
  return lines.join("\n");
}

/**
 * 按相对路径删除。目录删除会连带整棵子树，所以命中目录时跳过其子路径，避免重复删。
 * 返回 { removed:[path], missing:[path], fail:[{path,retCode}] }
 */
export async function deleteRemotePaths(index, relPaths) {
  const removed = [];
  const missing = [];
  const fail = [];
  const targets = [];
  const wantsDirPrefix = [];

  for (const p of relPaths) {
    const hit = index.byPath.get(p);
    if (!hit) { missing.push(p); continue; }
    targets.push(hit);
    if (hit.mediaType === MEDIA_TYPE.FOLDER) wantsDirPrefix.push(`${p}/`);
  }
  const filtered = targets.filter(
    (t) => !wantsDirPrefix.some((pre) => t.path.startsWith(pre))
  );

  for (let i = 0; i < filtered.length; i += 20) {
    const batch = filtered.slice(i, i + 20);
    const r = await index.client.deleteMany({
      knowledgeBaseId: index.kbId,
      mediaIds: batch.map((t) => t.mediaId),
    });
    const okSet = new Set(r.success);
    for (const t of batch) {
      if (okSet.has(t.mediaId)) removed.push(t.path);
      else fail.push({ path: t.path, retCode: r.fail.find((f) => f.mediaId === t.mediaId)?.retCode ?? null });
    }
  }
  return { removed, missing, fail };
}
