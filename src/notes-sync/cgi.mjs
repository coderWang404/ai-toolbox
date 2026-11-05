// ima 网页端内部接口（cgi-bin）客户端。
//
// 为什么需要它：OpenAPI（openapi/note/v1、openapi/wiki/v1）**没有删除、改名、建文件夹**的能力。
// 网页端走的是另一套接口 `knowledge_tab_{writer,reader}/*`，能力齐全。
//
// === 关键坑（2026-11-05 实测，踩了很久）===
// `knowledge_base_id` 必须传 **cgi 侧的 ID**，不是 OpenAPI 的 `ima_kb_xxx`。
//   - 个人知识库  → 就等于 userId，例如 `001a89f805c0269a`
//   - 我创建的知识库 → 纯数字，例如 `7522549495787019`
// 传 `ima_kb_RoTVyqfL` 这类 OpenAPI ID，所有接口一律返回 `{"code":51,"msg":"参数错误"}`，
// 而且**每个接口都报同样的 51**，极易误判成「鉴权失败」或「参数名写错了」。
// 用对的 ID 之后，del/rename/create_folder 全部 code 0。
//
// === 鉴权（从 bundle 逆向，已实测）===
//   headers: { "x-ima-cookie": "PLATFORM=H5; IMA-UID=..; IMA-TOKEN=..; IMA-REFRESH-TOKEN=..;
//              UID-TYPE=..; TOKEN-TYPE=..", from_browser_ima: "1", "x-ima-bkn": String(bkn(IMA-TOKEN)) }
// bkn 是 DJB 变体：h=5381; for ch: h += (h<<5)+ch; return h & 0x7fffffff
// 不需要真实的 Cookie 请求头，也不需要 cookie 里的其它字段。
//
// === 请求体风格 ===
// 前端用 `q(e)` 把 body 递归转 snake_case 再发，所以这里**全部写 snake_case**。
// 分页：cursor 首屏传空串 ""（传 "0" 会 500011 服务繁忙），后续用响应里的 next_cursor。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CGI_BASE = "https://ima.qq.com/cgi-bin";
export const WRITER = `${CGI_BASE}/knowledge_tab_writer`;
export const READER = `${CGI_BASE}/knowledge_tab_reader`;

/** 条目类型（实测值）。 */
export const MEDIA_TYPE = Object.freeze({
  FOLDER: 99,      // 文件夹
  NOTE: 11,        // ima 原生笔记
  MARKDOWN: 7,     // .md 文件
  WORD: 3,         // .docx
  IMAGE: 1,
});

export function sessionPath() {
  return path.join(os.homedir(), ".config", "ima", "session.json");
}

/** 读取网页端登录态（由 `ima-auth` 或手工写入）。 */
export function loadSession(file = sessionPath()) {
  if (!existsSync(file)) {
    throw new Error(`未找到登录态 ${file}。请先执行 ai-toolbox ima-auth capture，或手工写入。`);
  }
  const s = JSON.parse(readFileSync(file, "utf8"));
  for (const k of ["token", "refreshToken", "userId", "idType", "tokenType"]) {
    if (!s[k]) throw new Error(`登录态缺少字段 ${k}`);
  }
  return s;
}

/** ima 前端的 bkn 哈希（与 bundle 中 $g 完全一致）。 */
export function bkn(token) {
  let t = 5381;
  for (let i = 0; i < token.length; i++) t += (t << 5) + token.charCodeAt(i);
  return t & 2147483647;
}

/** 组装 x-ima-cookie 头。字段名与前端 cookieInfo 一致。 */
export function cookieHeader(session) {
  const parts = {
    PLATFORM: "H5",
    "IMA-UID": session.userId,
    "IMA-TOKEN": session.token,
    "IMA-REFRESH-TOKEN": session.refreshToken,
    "UID-TYPE": String(session.idType),
    "TOKEN-TYPE": String(session.tokenType),
  };
  return Object.entries(parts).map(([k, v]) => `${k}=${v}`).join("; ");
}

export class CgiError extends Error {
  constructor(message, { code, httpStatus, endpoint } = {}) {
    super(message);
    this.name = "CgiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.endpoint = endpoint;
  }
}

export class CgiClient {
  constructor({ session, baseUrl = CGI_BASE, fetchImpl, referer = "https://ima.qq.com/wikis" } = {}) {
    this.session = session ?? loadSession();
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.referer = referer;
    this._kbCache = null;
  }

  headers() {
    return {
      "Content-Type": "application/json",
      from_browser_ima: "1",
      Referer: this.referer,
      "x-ima-cookie": cookieHeader(this.session),
      "x-ima-bkn": String(bkn(this.session.token)),
    };
  }

  async call(servicePath, body = {}) {
    const url = `${this.baseUrl}/${servicePath}`;
    const res = await this.fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CgiError(`返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`, {
        httpStatus: res.status, endpoint: servicePath,
      });
    }
    if (json.code !== 0) {
      throw new CgiError(json.msg || `code ${json.code}`, {
        code: json.code, httpStatus: res.status, endpoint: servicePath,
      });
    }
    return json;
  }

  // ---------- 读 ----------

  /** 首页数据：返回 [{id, name, total, group}]，id 才是 cgi 侧知识库 ID。 */
  async knowledgeBases({ refresh = false } = {}) {
    if (this._kbCache && !refresh) return this._kbCache;
    const j = await this.call("knowledge_tab_reader/get_home_page_data", {});
    const out = [];
    for (const group of j.results ?? []) {
      for (const kb of group.knowledge_base_list ?? []) {
        out.push({
          id: kb.id,
          name: kb.basic_info?.name ?? "",
          total: Number(kb.basic_info?.knowledge_total_size ?? 0),
          group: group.knowledge_base_list_name ?? "",
          type: kb.new_type,
        });
      }
    }
    this._kbCache = out;
    return out;
  }

  /**
   * 把「知识库名称」或「已解析的 cgi ID」统一成 cgi ID。
   * 个人知识库的特殊之处：它的 cgi ID 等于 userId。
   */
  async resolveKnowledgeBaseId(nameOrId) {
    if (!nameOrId) return this.session.userId; // 默认落到个人知识库
    const kbs = await this.knowledgeBases();
    const byId = kbs.find((k) => k.id === nameOrId);
    if (byId) return byId.id;
    const byName = kbs.find((k) => k.name === nameOrId);
    if (byName) return byName.id;
    throw new CgiError(`找不到知识库「${nameOrId}」，可用：${kbs.map((k) => `${k.name}(${k.id})`).join("、")}`);
  }

  /** 单页列举。folderId 为空表示知识库根目录。 */
  async listPage({ knowledgeBaseId, folderId = "", limit = 50, cursor = "" } = {}) {
    const body = { knowledge_base_id: knowledgeBaseId, limit, cursor };
    if (folderId) body.folder_id = folderId;
    const j = await this.call("knowledge_tab_reader/get_knowledge_list", body);
    return {
      items: (j.knowledge_list ?? []).map(normalizeItem),
      isEnd: j.is_end !== false,
      nextCursor: j.next_cursor ?? "",
      totalSize: Number(j.total_size ?? 0),
      currentPath: j.current_path ?? [],
      version: j.version,
    };
  }

  /** 一页页拉到底。 */
  async listAll({ knowledgeBaseId, folderId = "", limit = 50, maxPages = 200 } = {}) {
    const out = [];
    let cursor = "";
    for (let page = 0; page < maxPages; page++) {
      const r = await this.listPage({ knowledgeBaseId, folderId, limit, cursor });
      out.push(...r.items);
      if (r.isEnd || !r.nextCursor || r.items.length === 0) break;
      cursor = r.nextCursor;
    }
    return out;
  }

  /** 递归整棵树，返回扁平的 [{path, mediaId, title, mediaType, folderId}]，path 用 / 分隔。 */
  async listTree({ knowledgeBaseId, folderId = "", prefix = "", maxDepth = 12 } = {}) {
    const items = await this.listAll({ knowledgeBaseId, folderId });
    const out = [];
    for (const it of items) {
      const p = prefix ? `${prefix}/${it.title}` : it.title;
      out.push({ ...it, path: p, folderId });
      if (it.mediaType === MEDIA_TYPE.FOLDER && maxDepth > 0) {
        const sub = await this.listTree({
          knowledgeBaseId, folderId: it.mediaId, prefix: p, maxDepth: maxDepth - 1,
        });
        out.push(...sub);
      }
    }
    return out;
  }

  // ---------- 写 ----------

  /** 批量删除。返回 {success:[mediaId], fail:[{mediaId,retCode}]}。 */
  async deleteMany({ knowledgeBaseId, mediaIds }) {
    if (!mediaIds?.length) return { success: [], fail: [] };
    const j = await this.call("knowledge_tab_writer/del_knowledge", {
      knowledge_base_id: knowledgeBaseId,
      media_ids: mediaIds,
    });
    const results = j.results ?? {};
    const success = [];
    const fail = [];
    for (const id of mediaIds) {
      const r = results[id];
      if (r && Number(r.ret_code) === 0) success.push(id);
      else fail.push({ mediaId: id, retCode: r ? r.ret_code : "no-result" });
    }
    return { success, fail };
  }

  /** 改名/重命名文件夹。action 0 = RenameActionDefault。 */
  async rename({ knowledgeBaseId, mediaId, title, folderId = "", mediaType = MEDIA_TYPE.NOTE }) {
    const j = await this.call("knowledge_tab_writer/rename_knowledge", {
      media_id: mediaId,
      title,
      knowledge_base_id: knowledgeBaseId,
      folder_id: folderId,
      action: 0,
      media_type: mediaType,
      is_searching: false,
    });
    return j.knowledge ? normalizeItem(j.knowledge) : null;
  }

  /** 建文件夹。folderId 必须是**有效父目录 ID**（根目录传知识库自己的 ID），传空串会 51。 */
  async createFolder({ knowledgeBaseId, title, folderId }) {
    const parent = folderId || knowledgeBaseId;
    const j = await this.call("knowledge_tab_writer/create_folder", {
      knowledge_base_id: knowledgeBaseId,
      folder_id: parent,
      title,
    });
    return j.knowledge ? normalizeItem(j.knowledge) : null;
  }

  /**
   * 原地替换条目内容（真正的「更新」，media_id 不变）。
   * 前置条件：新文件已通过 create_media + COS 上传拿到 media_id / cos_key。
   */
  async replace({ knowledgeBaseId, originMediaId, folderId = "", replaceInfo }) {
    const j = await this.call("knowledge_tab_writer/replace_knowledge", {
      origin_media_id: originMediaId,
      knowledge_base_id: knowledgeBaseId,
      folder_id: folderId,
      replace_info: replaceInfo,
    });
    return j.knowledge ? normalizeItem(j.knowledge) : null;
  }
}

/** 把 cgi 条目压成同步引擎友好的形状。 */
export function normalizeItem(it) {
  const folderInfo = it.folder_info ?? null;
  return {
    mediaId: it.media_id,
    title: it.title ?? folderInfo?.name ?? "",
    mediaType: Number(it.media_type ?? (folderInfo ? MEDIA_TYPE.FOLDER : 0)),
    parentFolderId: folderInfo?.parent_folder_id ?? it.parent_folder_id ?? "",
    createTime: Number(it.create_time ?? 0),
    updateTime: Number(it.update_time ?? it.last_modify_time ?? 0),
    fileSize: Number(it.file_size ?? 0),
    md5: it.md5_sum ?? "",
    raw: it,
  };
}

/** 更新本地登录态文件（token 自动续期后回写）。 */
export function saveSession(session, file = sessionPath()) {
  writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
}
