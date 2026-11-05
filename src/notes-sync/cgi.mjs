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
export const AUTH_LOGIN = `${CGI_BASE}/auth_login`;

// IMA-TOKEN 只有 2 小时（tokenValidTime=7200），提前 5 分钟续，避免同步跑到一半断掉。
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
// 固定心跳：即使小票还没到临期，也用这个间隔主动刷一次。
// 目的是把「宁可能被服务端滑动续期」的可能性吃满——只要进程活着就一直有活跃续期。
export const DEFAULT_HEARTBEAT_MS = 30 * 60 * 1000;

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

/** 有并发上限的 map，保持结果顺序。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
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

/**
 * 用 refreshToken 换一张新的小票（IMA-TOKEN），并把结果写回登录态文件。
 *
 * 端点来自 bundle：`LoginHttpServiceUrlPrefix = "auth_login"`，方法 `refresh(e)` 发
 * `${urlPrefix}/refresh`，body 经前端 `q()` 驼转蛇 → `{ user_id, refresh_token, token_type }`。
 * 回包是扁平的 `{ code, msg, token, token_valid_time, user_id }`，没有 data 包装。
 *
 * 为什么必须有：小票只有 2 小时，过期后**所有** cgi 接口都返回 `600001 服务繁忙`，
 * 与真正的限频同一个码，肉眼完全分不出来。实测 2026-11-05 14:08 过期，
 * 之后 get_home_page_data / get_knowledge_list 全部 600001。
 */
export async function refreshSession({ session, file = sessionPath(), fetchImpl } = {}) {
  const current = session ?? loadSession(file);
  if (!current.refreshToken) {
    throw new CgiError("登录态里没有 refreshToken，只能重新登录 ima 网页端再抓一次", {
      endpoint: "auth_login/refresh",
    });
  }
  const res = await (fetchImpl ?? globalThis.fetch)(`${AUTH_LOGIN}/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      from_browser_ima: "1",
      Referer: "https://ima.qq.com/wikis",
      "x-ima-cookie": cookieHeader(current),
      "x-ima-bkn": String(bkn(current.token)),
    },
    body: JSON.stringify({
      user_id: current.userId,
      refresh_token: current.refreshToken,
      token_type: Number(current.tokenType ?? 0),
    }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CgiError(`续期返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`, {
      httpStatus: res.status, endpoint: "auth_login/refresh",
    });
  }
  if (json.code !== 0 || !json.token) {
    throw new CgiError(`续期失败：${json.msg || `code ${json.code}`}`, {
      code: json.code, httpStatus: res.status, endpoint: "auth_login/refresh",
    });
  }
  const validTime = Number(json.token_valid_time ?? 0) || Number(current.tokenValidTime ?? 0) || 7200;
  const next = {
    ...current,
    token: json.token,
    tokenValidTime: validTime,
    tokenExpiredTime: Date.now() + validTime * 1000,
  };
  // 服务端目前不回新 refreshToken，回了就一并接住，免得丢掉轮换后的票据。
  if (json.refresh_token) next.refreshToken = json.refresh_token;
  saveSession(next, file);
  return next;
}

export class CgiClient {
  constructor({
    session, baseUrl = CGI_BASE, fetchImpl, referer = "https://ima.qq.com/wikis",
    autoRefresh = true, heartbeatMs = DEFAULT_HEARTBEAT_MS,
  } = {}) {
    this.session = session ?? loadSession();
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.referer = referer;
    this.autoRefresh = autoRefresh;
    this.heartbeatMs = heartbeatMs;
    this._lastRefreshAt = 0;
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

  /** 小票临期、到心跳点、或被强制时续期，返回当前可用的登录态。 */
  async ensureFresh({ force = false, heartbeat = true } = {}) {
    if (!this.autoRefresh) return this.session;
    const exp = Number(this.session.tokenExpiredTime ?? 0);
    const nearExpiry = !(exp > 0 && exp - Date.now() > TOKEN_REFRESH_MARGIN_MS);
    const heartbeatDue = heartbeat && this.heartbeatMs > 0
      && Date.now() - this._lastRefreshAt > this.heartbeatMs;
    if (!force && !nearExpiry && !heartbeatDue) return this.session;

    // 常驻进程会把登录态一直放在内存里；用户重新抓了 cookie 之后磁盘上可能已经更新，
    // 先读一次磁盘，能少一次网络续期，也能接住外部手写的登录态。
    try {
      const fromDisk = loadSession();
      const diskExp = Number(fromDisk.tokenExpiredTime ?? 0);
      if (fromDisk.token !== this.session.token) {
        this.session = fromDisk;
        if (diskExp - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
          this._lastRefreshAt = Date.now();
          return this.session;
        }
      }
    } catch {
      // 磁盘上没有/读不出来，照常走续期
    }

    this.session = await refreshSession({ session: this.session, fetchImpl: this.fetch });
    this._lastRefreshAt = Date.now();
    return this.session;
  }

  async request(servicePath, body) {
    const res = await this.fetch(`${this.baseUrl}/${servicePath}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new CgiError(`返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`, {
        httpStatus: res.status, endpoint: servicePath,
      });
    }
  }

  async call(servicePath, body = {}) {
    await this.ensureFresh();
    const tokenBefore = this.session.token;
    const json = await this.request(servicePath, body);
    if (json.code === 0) return json;

    // 600001 既可能是真限频，也可能是小票刚刚过期。只有确实换到了新小票才值得重试一次，
    // 否则真限频会被我们放大成两次请求。
    if (json.code === 600001 && this.autoRefresh) {
      let refreshed = true;
      try {
        await this.ensureFresh({ force: true });
      } catch (err) {
        refreshed = false;
        throw new CgiError(`${json.msg || `code ${json.code}`}（续期失败：${err.message}）`, {
          code: json.code, endpoint: servicePath,
        });
      }
      if (refreshed && this.session.token !== tokenBefore) {
        const retry = await this.request(servicePath, body);
        if (retry.code === 0) return retry;
        throw new CgiError(retry.msg || `code ${retry.code}`, {
          code: retry.code, endpoint: servicePath,
        });
      }
    }

    throw new CgiError(json.msg || `code ${json.code}`, {
      code: json.code, endpoint: servicePath,
    });
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

  /**
   * 整棵树，返回扁平的 [{path, mediaId, title, mediaType, folderId}]，path 用 / 分隔。
   *
   * 按层并发：串行递归 71 个目录要 30 秒以上，同步轮询完全等不起；
   * 每层 8 路并发之后整棵树降到 2-4 秒。
   */
  async listTree({ knowledgeBaseId, folderId = "", prefix = "", maxDepth = 12, concurrency = 8 } = {}) {
    const out = [];
    let level = [{ folderId, prefix }];
    for (let depth = 0; level.length && depth < maxDepth; depth++) {
      const batches = await mapLimit(level, concurrency, async (node) => {
        const items = await this.listAll({ knowledgeBaseId, folderId: node.folderId });
        return items.map((it) => ({
          ...it,
          path: node.prefix ? `${node.prefix}/${it.title}` : it.title,
          folderId: node.folderId,
        }));
      });
      const flat = batches.flat();
      out.push(...flat);
      level = flat
        .filter((it) => it.mediaType === MEDIA_TYPE.FOLDER)
        .map((it) => ({ folderId: it.mediaId, prefix: it.path }));
    }
    return out;
  }

  // ---------- 媒体 ----------

  /**
   * 取条目的媒体信息，里面有**带签名的下载地址** `jump_url`。
   *
   * 为什么必须靠它：条目上的 `raw_file_url` 只是 COS key（形如
   * `2/<bucket>/file_manager/<hash>.md`），直接 GET 会 403 missing parameter t；
   * 签名只有这个接口会下发。实测下载回来的字节与本地文件 sha256 完全一致，
   * 所以文件型条目是可以无损双向的，不必为了「能读回正文」而转成 note 型。
   */
  async media({ mediaId }) {
    const j = await this.call("file_manager/get_media", { media_id: mediaId });
    const info = j.jump_url_info ?? {};
    return {
      mediaId,
      contentType: j.content_type ?? "",
      fileSize: Number(j.file_size ?? 0),
      url: j.jump_url ?? info.url ?? "",
      headers: info.headers ?? {},
      raw: j,
    };
  }

  /** 下载文件型条目的原始字节。 */
  async downloadMedia({ mediaId }) {
    const info = await this.media({ mediaId });
    if (!info.url) {
      throw new CgiError("get_media 没有返回 jump_url", { endpoint: "file_manager/get_media" });
    }
    const res = await this.fetch(info.url, { headers: info.headers });
    if (!res.ok) {
      throw new CgiError(`下载条目失败 HTTP ${res.status}`, {
        httpStatus: res.status, endpoint: "media",
      });
    }
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: info.contentType };
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
