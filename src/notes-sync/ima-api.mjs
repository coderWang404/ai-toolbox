// ima OpenAPI 客户端。全部端点是 POST + JSON，Base URL https://ima.qq.com。
// 鉴权头：ima-openapi-clientid / ima-openapi-apikey
// 响应：{ code: 0, msg, data }；code 非 0 为业务错误。
// 端点与字段依据 zhonxia/obsidian-ima-sync 的 src/api.ts、公开 skill 文档整理，
// 尚未在本机凭证下实测的端点在 probe.mjs 里标记为「待验证」。
import { loadCredentials } from "./config.mjs";

export const BASE_URL = "https://ima.qq.com";
// 测试时指向本地 mock server；生产永远是上面的官方地址。
let currentBaseUrl = BASE_URL;
export function setBaseUrl(url) {
  currentBaseUrl = url || BASE_URL;
}
export function getBaseUrl() {
  return currentBaseUrl;
}
export const EP = Object.freeze({
  LIST_NOTEBOOK: "openapi/note/v1/list_notebook",
  LIST_NOTE_BY_FOLDER: "openapi/note/v1/list_note_by_folder_id",
  LIST_NOTE: "openapi/note/v1/list_note",
  SEARCH_NOTE: "openapi/note/v1/search_note",
  SEARCH_NOTE_BOOK: "openapi/note/v1/search_note_book",
  GET_DOC_CONTENT: "openapi/note/v1/get_doc_content",
  EXPORT_NOTE: "openapi/note/v1/export_note",
  IMPORT_DOC: "openapi/note/v1/import_doc",
  APPEND_DOC: "openapi/note/v1/append_doc",
  GET_ADDABLE_KB: "openapi/wiki/v1/get_addable_knowledge_base_list",
  GET_KNOWLEDGE_LIST: "openapi/wiki/v1/get_knowledge_list",
  ADD_KNOWLEDGE: "openapi/wiki/v1/add_knowledge",
  CREATE_MEDIA: "openapi/wiki/v1/create_media",
  MOVE_KNOWLEDGE: "openapi/wiki/v1/move_knowledge",
  RENAME_KNOWLEDGE: "openapi/wiki/v1/rename_knowledge",
});

export const RATE_LIMIT_CODE = 200001;

export class ImaApiError extends Error {
  constructor(message, { code = null, httpStatus = null, endpoint = null } = {}) {
    super(message);
    this.name = "ImaApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.endpoint = endpoint;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 原始调用，保留 httpStatus / code / msg / data 供 probe 输出证据。 */
export async function rawCall(endpoint, body, creds, opts = {}) {
  const { timeoutMs = 15000, retries = 3 } = opts;
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    let res;
    try {
      res = await fetch(`${opts.baseUrl ?? currentBaseUrl}/${endpoint}`, {
        method: "POST",
        headers: {
          "ima-openapi-clientid": creds.clientId,
          "ima-openapi-apikey": creds.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = new ImaApiError(`网络错误: ${err.message}`, { endpoint });
      if (attempt < retries - 1) await sleep(400 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ImaApiError(`HTTP ${res.status} 返回非 JSON: ${text.slice(0, 200)}`, {
        httpStatus: res.status, endpoint,
      });
    }
    if (json.code === RATE_LIMIT_CODE && attempt < retries - 1) {
      await sleep(400 * 2 ** attempt);
      continue;
    }
    return {
      httpStatus: res.status,
      code: json.code,
      msg: json.msg ?? "",
      data: json.data ?? null,
      raw: json,
    };
  }
  throw lastError ?? new ImaApiError("调用失败", { endpoint });
}

/** 业务成功才返回 data，否则抛错。 */
export async function call(endpoint, body, creds, opts) {
  const r = await rawCall(endpoint, body, creds, opts);
  if (r.code !== 0) {
    throw new ImaApiError(`${endpoint} 返回 code=${r.code} ${r.msg}`, {
      code: r.code, httpStatus: r.httpStatus, endpoint,
    });
  }
  return r.data;
}

export class ImaClient {
  constructor(creds = loadCredentials()) {
    this.creds = creds;
  }

  listNotebook({ cursor = "0", limit = 50 } = {}) {
    return call(EP.LIST_NOTEBOOK, { cursor, limit }, this.creds);
  }

  /** folderId 空串表示全部笔记本；cursor 首次传空串。 */
  listNotes({ folderId = "", cursor = "", limit = 50 } = {}) {
    return call(EP.LIST_NOTE_BY_FOLDER, { folder_id: folderId, cursor, limit }, this.creds);
  }

  /** 分页拉全部笔记，返回 [{noteId, title, modifyTime, ...}]。 */
  async allNotes({ folderId = "", limit = 50, maxPages = 50 } = {}) {
    const out = [];
    let cursor = "";
    for (let page = 0; page < maxPages; page++) {
      const data = await this.listNotes({ folderId, cursor, limit });
      const list = data?.note_book_list ?? data?.note_list ?? [];
      for (const item of list) {
        const info = item?.basic_info?.basic_info ?? item?.basic_info ?? item;
        out.push({
          noteId: info.note_id ?? info.docid ?? info.doc_id ?? null,
          title: info.title ?? "",
          modifyTime: Number(info.modify_time ?? 0),
          createTime: Number(info.create_time ?? 0),
          folderId: info.note_ext_info?.folder_id ?? item?.note_ext_info?.folder_id ?? "",
          raw: item,
        });
      }
      cursor = data?.next_cursor ?? data?.cursor ?? "";
      if (!cursor || data?.is_end === true || list.length === 0) break;
    }
    return out;
  }

  /** targetContentFormat: 0 = 纯文本（官方推荐）；其他取值待 probe 验证。 */
  getDocContent(docId, targetContentFormat = 0) {
    return call(EP.GET_DOC_CONTENT, {
      doc_id: docId,
      target_content_format: targetContentFormat,
    }, this.creds);
  }

  exportNote(docId) {
    return call(EP.EXPORT_NOTE, { doc_id: docId }, this.creds);
  }

  importDoc(content, { folderId, folderName } = {}) {
    const body = { content, content_format: 1 };
    if (folderId) body.folder_id = folderId;
    if (folderName) body.folder_name = folderName;
    return call(EP.IMPORT_DOC, body, this.creds);
  }

  appendDoc(docId, content) {
    return call(EP.APPEND_DOC, {
      doc_id: docId, content, content_format: 1,
    }, this.creds);
  }

  addableKnowledgeBases({ cursor = "", limit = 50 } = {}) {
    return call(EP.GET_ADDABLE_KB, { cursor, limit }, this.creds);
  }

  /** media_type 11 = 笔记；note_info.content_id 指向 import_doc 返回的 note_id。 */
  addKnowledge({ noteId, title, knowledgeBaseId, folderId, duplicateNameStrategy } = {}) {
    const body = {
      media_type: 11,
      title,
      knowledge_base_id: knowledgeBaseId,
      note_info: { content_id: noteId },
    };
    if (folderId) body.folder_id = folderId;
    if (duplicateNameStrategy) body.duplicate_name_strategy = duplicateNameStrategy;
    return call(EP.ADD_KNOWLEDGE, body, this.creds);
  }

  /** 文件型条目：申请 mediaId 与预签名直传地址。 */
  createMedia({ fileName, fileSize, contentType, fileExt, knowledgeBaseId } = {}) {
    return call(EP.CREATE_MEDIA, {
      apply_upload_mode: 1,
      file_name: fileName,
      file_size: fileSize,
      content_type: contentType,
      file_ext: fileExt,
      knowledge_base_id: knowledgeBaseId,
    }, this.creds);
  }

  /** 预签名 PUT：必须原样带上服务端下发的 auth_headers（含精确的 Content-Length）。 */
  async uploadBinary(uploadUrl, bytes) {
    const res = await fetch(uploadUrl.presigned_url, {
      method: "PUT",
      headers: uploadUrl.auth_headers ?? {},
      body: bytes,
    });
    if (!res.ok) {
      throw new ImaApiError(`COS 上传失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, {
        httpStatus: res.status, endpoint: "cos-put",
      });
    }
    return true;
  }

  addKnowledgeByMedia({ mediaId, title, knowledgeBaseId, folderId, duplicateNameStrategy } = {}) {
    const body = { media_id: mediaId, title, knowledge_base_id: knowledgeBaseId };
    if (folderId) body.folder_id = folderId;
    if (duplicateNameStrategy) body.duplicate_name_strategy = duplicateNameStrategy;
    return call(EP.ADD_KNOWLEDGE, body, this.creds);
  }

  getKnowledgeList({ knowledgeBaseId, folderId = "", cursor = "", limit = 50 } = {}) {
    return call(EP.GET_KNOWLEDGE_LIST, {
      knowledge_base_id: knowledgeBaseId, folder_id: folderId, cursor, limit,
    }, this.creds);
  }

  moveKnowledge({ mediaId, knowledgeBaseId, targetFolderId } = {}) {
    return call(EP.MOVE_KNOWLEDGE, {
      media_id: mediaId,
      knowledge_base_id: knowledgeBaseId,
      target_folder_id: targetFolderId,
    }, this.creds);
  }
}
