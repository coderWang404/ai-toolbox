// 远端（ima 知识库）的门面：把 OpenAPI 与 cgi 两套接口收成一个「按路径读写文件」的接口。
//
// 为什么要有这一层：同步引擎只关心「路径 → 字节」，不该知道底层是哪个端点。
// 两套接口的分工（2026-11-05 全部实测）：
//   cgi     列树 / 建目录 / 删除 / 原地替换 / 下载签名
//   OpenAPI 申请媒体（COS 凭证） / 挂条目 / 读 ima 原生笔记正文
//
// 为什么主链路一律用**文件型**条目（media_type=1）而不是 note 型：
//   文件型下载回来的字节与本地 sha256 逐字节一致；
//   note 型会被 ima 规范化 Markdown（`-` → `*`、表头加粗、空行增删），
//   实测 555 字节的原文回读成 750 字节，做双向同步会无限改写。
//
// 路径身份：条目在 ima 里靠「父文件夹 + 标题」定位，payload 里没有相对路径字段，
// 所以 relPath 由 listTree 递归时拼出来，标题即文件名。
import { CgiClient, MEDIA_TYPE } from "./cgi.mjs";
import { ImaClient } from "./ima-api.mjs";
import { loadConfig } from "./config.mjs";
import { mimeFor, extOf } from "./vault.mjs";

/** note 型条目的 media_id 形如 note_cls1_<hash>_<noteId>，最后一段才是 OpenAPI 的 doc_id。 */
export function noteIdFromMediaId(mediaId) {
  const m = /^note_.*_(\d+)$/.exec(String(mediaId ?? ""));
  return m ? m[1] : null;
}

export const DEFAULT_KB_NAME = "个人知识库";
export const DEFAULT_ROOT_PATH = "笔记";
const FILE_MEDIA_TYPE = 1;

export class RemoteStore {
  constructor({ config = loadConfig(), cgi, ima, indexCache = null } = {}) {
    this.config = config;
    this.cgi = cgi ?? new CgiClient();
    this.ima = ima ?? new ImaClient();
    this._kb = null;
    this._dirs = new Map(); // 相对路径（"" 表示 root 自身）→ folderId
    // { version, kbId, index } —— 知识库级版本号没变就直接复用上一轮的整棵树，
    // 稳态一轮同步从「71 个目录 7 秒」降到「1 次请求」。
    this._cache = indexCache;
  }

  /**
   * 解析知识库的两套 ID。cgi 侧按显示名找（个人知识库 = userId），
   * OpenAPI 侧的名字不一样（同一库在 OpenAPI 里叫「二十九画生的知识库」），
   * 所以 OpenAPI ID 只在配置里给，找不到才退化成列举匹配。
   */
  async kb() {
    if (this._kb) return this._kb;
    const name = this.config.knowledgeBaseName || DEFAULT_KB_NAME;
    const cgiId = await this.cgi.resolveKnowledgeBaseId(name);
    let openapiId = this.config.knowledgeBaseId || "";
    if (!openapiId) {
      const list = await this.ima.addableKnowledgeBases({ limit: 50 });
      const hit = (list?.addable_knowledge_base_list ?? []).find((k) => k.id === cgiId);
      openapiId = hit?.id ?? "";
    }
    if (!openapiId) {
      throw new Error(
        `无法确定「${name}」的 OpenAPI 知识库 ID。请在 notes-sync.json 里设置 knowledgeBaseId（形如 ima_kb_xxxxxxxx）。`
      );
    }
    this._kb = { cgiId, openapiId, name };
    return this._kb;
  }

  /**
   * 建远端索引：一次全树列举，得到 path → {mediaId, title, mediaType, updateTime, fileSize}。
   * 同步引擎每轮只调一次这个，再逐条决定传什么，避免 N 次往返。
   */
  async index() {
    const { cgiId } = await this.kb();
    const rootPath = this.config.rootPath || DEFAULT_ROOT_PATH;
    const segments = String(rootPath).split("/").filter(Boolean);

    let folderId = cgiId;
    for (const seg of segments) {
      const items = await this.cgi.listAll({ knowledgeBaseId: cgiId, folderId });
      const hit = items.find((i) => i.mediaType === MEDIA_TYPE.FOLDER && i.title === seg);
      if (!hit) { folderId = null; break; }
      folderId = hit.mediaId;
    }
    if (!folderId) {
      throw new Error(`知识库里找不到根文件夹「${rootPath}」，请先在 ima 里建好，或改配置 rootPath`);
    }

    // 先花一次请求问版本号：内容没变就不必重新爬整棵树。
    const probe = await this.cgi.listPage({ knowledgeBaseId: cgiId, folderId, limit: 20 });
    if (this._cache && this._cache.kbId === cgiId && this._cache.version === probe.version) {
      this._dirs = new Map(this._cache.index.dirs);
      this._cache.index.hitCache = true;
      return this._cache.index;
    }

    const items = await this.cgi.listTree({ knowledgeBaseId: cgiId, folderId });
    const byPath = new Map();
    const dirs = new Map([["", folderId]]);
    for (const it of items) {
      if (it.mediaType === MEDIA_TYPE.FOLDER) {
        dirs.set(it.path, it.mediaId);
      } else {
        byPath.set(it.path, {
          mediaId: it.mediaId,
          title: it.title,
          mediaType: it.mediaType,
          updateTime: Number(it.updateTime ?? it.raw?.update_time ?? 0),
          fileSize: Number(it.fileSize ?? it.raw?.file_size ?? 0),
        });
      }
    }
    this._dirs = dirs;
    const flat = [
      ...dirs.entries()
        .filter(([p]) => p !== "")
        .map(([p, mediaId]) => ({ path: p, title: p.split("/").pop(), mediaId, mediaType: MEDIA_TYPE.FOLDER, updateTime: 0, fileSize: 0 })),
      ...[...byPath.entries()].map(([p, v]) => ({ path: p, ...v })),
    ];
    const index = { kbId: cgiId, rootPath, rootFolderId: folderId, byPath, dirs, items: flat, version: probe.version };
    this._cache = { version: probe.version, kbId: cgiId, index };
    return index;
  }

  /** 我们自己写过之后版本号必然变，主动让缓存失效，下一轮重新列举。 */
  invalidateIndex() {
    this._cache = null;
  }

  /** 逐级建出远端目录，返回最末一级的 folderId。已建过的走缓存，不重复往返。 */
  async ensureFolder(relDir) {
    const clean = String(relDir || "").replace(/^\/+|\/+$/g, "");
    if (this._dirs.has(clean)) return this._dirs.get(clean);
    if (!this._dirs.has("")) throw new Error("ensureFolder 之前必须先调用 index()");

    const segments = clean.split("/").filter(Boolean);
    let parent = "";
    let folderId = this._dirs.get("");
    for (const seg of segments) {
      const next = parent ? `${parent}/${seg}` : seg;
      if (this._dirs.has(next)) {
        folderId = this._dirs.get(next);
      } else {
        const created = await this.cgi.createFolder({
          knowledgeBaseId: (await this.kb()).cgiId, title: seg, folderId,
        });
        if (!created?.mediaId) throw new Error(`建远端目录失败：${next}`);
        this._dirs.set(next, created.mediaId);
        folderId = created.mediaId;
      }
      parent = next;
    }
    return folderId;
  }

  /** 申请媒体位并把字节传到 COS，返回 {mediaId, cosKey, contentType, size}。 */
  async upload({ relPath, bytes }) {
    const { openapiId } = await this.kb();
    const contentType = mimeFor(relPath) || "application/octet-stream";
    const name = relPath.split("/").pop();
    const created = await this.ima.createMedia({
      fileName: name,
      fileSize: bytes.length,
      contentType,
      fileExt: extOf(relPath),
      knowledgeBaseId: openapiId,
    });
    const mediaId = created?.media_id ?? created?.mediaId;
    if (!mediaId) throw new Error("create_media 没有返回 media_id");
    const cred = created?.cos_credential;
    if (!cred) throw new Error("create_media 没有返回 COS 凭证");
    await this.ima.uploadToCos(cred, bytes, contentType);
    return { mediaId, cosKey: cred.cos_key, contentType, size: bytes.length };
  }

  /** 把已上传的媒体挂成知识库条目（文件型）。返回服务端确认的 mediaId。 */
  async add({ relPath, upload, folderId }) {
    const { openapiId } = await this.kb();
    const added = await this.ima.addKnowledgeByMedia({
      mediaId: upload.mediaId,
      title: relPath.split("/").pop(),
      knowledgeBaseId: openapiId,
      folderId,
      mediaType: FILE_MEDIA_TYPE,
    });
    return added?.media_id ?? added?.mediaId ?? upload.mediaId;
  }

  /**
   * 原地替换条目内容。实测：替换后目录里仍然只有一条，media_id 会换成新的，
   * 所以调用方必须把新 mediaId 写回 state。
   */
  async replace({ relPath, originMediaId, upload, folderId }) {
    const { cgiId } = await this.kb();
    const replaced = await this.cgi.replace({
      knowledgeBaseId: cgiId,
      originMediaId,
      folderId,
      replaceInfo: {
        media_id: upload.mediaId,
        media_type: FILE_MEDIA_TYPE,
        file_info: {
          content_type: upload.contentType,
          cos_key: upload.cosKey,
          file_name: relPath.split("/").pop(),
          file_size: upload.size,
        },
      },
    });
    // replace_knowledge 会回一条完整条目，update_time 可以直接当新基线用（省掉一次列举）。
    return {
      mediaId: replaced?.mediaId ?? upload.mediaId,
      updateTime: Number(replaced?.updateTime ?? 0),
    };
  }

  /**
   * 新建条目之后回查 update_time。add_knowledge 只回 media_id，没有时间戳，
   * 而基线里的 update_time 是下一轮判断「远端是否变过」的唯一依据。
   * 按父目录批量查，一次请求覆盖该目录下所有新建条目。
   */
  async refreshEntries(relPaths) {
    const byDir = new Map();
    for (const relPath of relPaths) {
      const dir = relPath.split("/").slice(0, -1).join("/");
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(relPath);
    }
    const out = new Map();
    const { cgiId } = await this.kb();
    for (const [dir, paths] of byDir) {
      const folderId = this._dirs.get(dir);
      if (!folderId) continue;
      const items = await this.cgi.listAll({ knowledgeBaseId: cgiId, folderId });
      for (const relPath of paths) {
        const title = relPath.split("/").pop();
        const hit = items.find((i) => i.title === title);
        if (hit) {
          out.set(relPath, {
            mediaId: hit.mediaId,
            updateTime: Number(hit.updateTime ?? 0),
            fileSize: Number(hit.fileSize ?? 0),
          });
        }
      }
    }
    return out;
  }

  /** 按路径批量删除。目录会连带子树，所以命中目录时跳过其子路径。 */
  async remove(paths, index) {
    const targets = [];
    const wantedDirs = [];
    const missing = [];
    for (const p of paths) {
      const hit = index.byPath.get(p) ?? null;
      if (hit) { targets.push({ path: p, mediaId: hit.mediaId }); continue; }
      const dirId = index.dirs.get(p);
      if (dirId) { targets.push({ path: p, mediaId: dirId }); wantedDirs.push(`${p}/`); continue; }
      missing.push(p);
    }
    const filtered = targets.filter((t) => !wantedDirs.some((pre) => t.path.startsWith(pre)));
    const removed = [];
    const fail = [];
    const { cgiId } = await this.kb();
    for (let i = 0; i < filtered.length; i += 20) {
      const batch = filtered.slice(i, i + 20);
      const r = await this.cgi.deleteMany({
        knowledgeBaseId: cgiId, mediaIds: batch.map((t) => t.mediaId),
      });
      const ok = new Set(r.success);
      for (const t of batch) {
        if (ok.has(t.mediaId)) removed.push(t.path);
        else fail.push({ path: t.path, retCode: r.fail.find((f) => f.mediaId === t.mediaId)?.retCode ?? null });
      }
    }
    return { removed, missing, fail };
  }

  /** 下载文件型条目的原始字节（签名地址由 get_media 下发）。 */
  async download(mediaId) {
    const { bytes } = await this.cgi.downloadMedia({ mediaId });
    return bytes;
  }

  /**
   * 按条目类型取内容：
   * 文件型 → 走签名地址下载原始字节（逐字节保真）；
   * note 型 → 走 OpenAPI 读 Markdown（服务端会规范化排版，但这是唯一能拿到正文的路，
   *           get_media 对 note 型直接失败：实测 fetch failed）。
   */
  async readEntry(relPath, info) {
    if (info.mediaType === MEDIA_TYPE.NOTE) {
      const noteId = noteIdFromMediaId(info.mediaId);
      if (!noteId) throw new Error(`无法从 media_id 解析 noteId：${info.mediaId}`);
      const text = await this.readNote(noteId);
      return Buffer.from(text, "utf8");
    }
    return this.download(info.mediaId);
  }

  /**
   * ima 原生笔记（note 型）：用户在 App 里手写的内容。
   * 这类条目拿不到原始字节，只能走 OpenAPI 读 Markdown（会被服务端规范化），
   * 所以只落到 inbox，不回写回原路径，也不参与主链路的逐字节比对。
   */
  async listNotes() {
    const notes = await this.ima.allNotes();
    return notes.filter((n) => n.noteId);
  }

  async readNote(noteId) {
    const data = await this.ima.getDocContent(noteId, this.config.contentFormat ?? 1);
    return String(data?.content ?? "");
  }
}
