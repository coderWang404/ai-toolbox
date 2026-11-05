// 测试替身：内存版 IMA client（跑同步引擎全链路）+ 真实 HTTP mock server（测 API 层）。
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../../src/notes-sync/vault.mjs";

export const TEST_KB = "ima_kb_test0001";

/** 符合 ImaClient 接口的内存实现，可注入错误与限频。 */
export class MockImaClient {
  constructor() {
    this.notes = new Map();      // noteId -> {noteId,title,content,modifyTime,createTime,archived}
    this.kb = new Map();         // title -> {mediaId,noteId,title}
    this.uploads = new Map();
    // 必须以真实时间为基准：engine 在首次推送后会把 remoteModifyTime 记为 Date.now()，
    // 若 mock 时钟停在 2023 年，远端编辑永远不会被判定为「更新」。
    this.clock = Date.now();
    this.seq = 0;
    this.failNext = 0;          // 下次任意写操作抛错
    this.rateLimitNext = 0;     // 下次 allNotes 抛限频
    this.calls = { importDoc: 0, addKnowledge: 0, appendDoc: 0, getDocContent: 0, createMedia: 0, moveKnowledge: 0 };
  }

  tick() { this.clock += 1000; return this.clock; }
  id(prefix) { return `${prefix}_${++this.seq}`; }
  maybeFail() {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("模拟网络错误");
    }
  }

  async allNotes() {
    if (this.rateLimitNext > 0) {
      this.rateLimitNext -= 1;
      const err = new Error("rate limited");
      err.code = 200001;
      throw err;
    }
    return [...this.notes.values()]
      .filter((n) => !n.archived)
      .map((n) => ({
        noteId: n.noteId, title: n.title, modifyTime: n.modifyTime,
        createTime: n.createTime, folderId: "", raw: n,
      }));
  }

  async getDocContent(noteId) {
    this.calls.getDocContent += 1;
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`note 不存在: ${noteId}`);
    return { content: note.content };
  }

  async importDoc(content) {
    this.maybeFail();
    this.calls.importDoc += 1;
    const noteId = this.id("nt");
    const now = this.tick();
    this.notes.set(noteId, {
      noteId, title: content.split("\n")[0].replace(/^#\s*/, "") || "untitled",
      content, modifyTime: now, createTime: now, archived: false,
    });
    return { note_id: noteId };
  }

  async appendDoc(noteId, content) {
    this.maybeFail();
    this.calls.appendDoc += 1;
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`note 不存在: ${noteId}`);
    note.content += content;
    note.modifyTime = this.tick();
    return {};
  }

  async addKnowledge({ noteId, title, duplicateNameStrategy }) {
    this.maybeFail();
    this.calls.addKnowledge += 1;
    const existing = this.kb.get(title);
    if (existing && duplicateNameStrategy === "DUPLICATE_NAME_STRATEGY_REPLACE") {
      // 同名替换：旧 note 归档（模拟服务端回收），条目指向新 note。
      const old = this.notes.get(existing.noteId);
      if (old) old.archived = true;
      existing.noteId = noteId;
      existing.mediaId = this.id("md");
      const note = this.notes.get(noteId);
      if (note) { note.title = title; note.modifyTime = this.tick(); }
      return { media_id: existing.mediaId };
    }
    const mediaId = this.id("md");
    this.kb.set(title, { mediaId, noteId, title });
    const note = this.notes.get(noteId);
    if (note) { note.title = title; note.modifyTime = this.tick(); }
    return { media_id: mediaId };
  }

  async createMedia({ fileName, fileSize, contentType }) {
    this.maybeFail();
    this.calls.createMedia += 1;
    const mediaId = this.id("md");
    const key = this.id("up");
    this.uploads.set(key, null);
    return {
      media_id: mediaId,
      upload_mode: 1,
      upload_url: {
        presigned_url: `mock://upload/${key}`,
        auth_headers: { "Content-Type": contentType, "Content-Length": String(fileSize) },
        url_expired_ts: Math.floor(Date.now() / 1000) + 3600,
      },
    };
  }

  async uploadBinary(uploadUrl, bytes) {
    this.maybeFail();
    const key = String(uploadUrl.presigned_url).split("/").pop();
    this.uploads.set(key, sha256(bytes));
    return true;
  }

  async addKnowledgeByMedia({ mediaId, title, duplicateNameStrategy }) {
    this.maybeFail();
    this.calls.addKnowledge += 1;
    const existing = this.kb.get(title);
    if (existing && duplicateNameStrategy === "DUPLICATE_NAME_STRATEGY_REPLACE") {
      existing.mediaId = mediaId;
      return { media_id: mediaId };
    }
    this.kb.set(title, { mediaId, noteId: null, title });
    return { media_id: mediaId };
  }

  async moveKnowledge({ mediaId }) {
    this.maybeFail();
    this.calls.moveKnowledge += 1;
    return { moved: mediaId };
  }

  /** 模拟用户在 ima App 里编辑某篇笔记。 */
  editInIma(noteId, newContent) {
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`note 不存在: ${noteId}`);
    note.content = newContent;
    note.modifyTime = this.tick();
    return note.modifyTime;
  }
}

/** 真实 HTTP server，用于验证 ima-api 的鉴权头、分页、限频退避、错误码。 */
export async function startMockHttpServer() {
  const state = { notes: new Map(), kb: [], seq: 0, rateLimitOnce: 0, requests: [] };
  const clock = () => 1700000000000 + ++state.seq * 1000;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
    const endpoint = req.url.replace(/^\//, "").split("?")[0];
    state.requests.push({
      endpoint,
      clientId: req.headers["ima-openapi-clientid"] ?? null,
      apiKey: req.headers["ima-openapi-apikey"] ?? null,
      body,
    });
    const send = (code, data = {}, msg = "") => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code, msg, data }));
    };

    if (endpoint === "__fail") {
      res.writeHead(500); res.end("boom"); return;
    }
    if (state.rateLimitOnce > 0 && endpoint.endsWith("list_note_by_folder_id")) {
      state.rateLimitOnce -= 1;
      send(200001, {}, "rate limited");
      return;
    }
    switch (endpoint) {
      case "openapi/note/v1/list_notebook":
        send(0, { note_folder_infos: [{ folder_id: "f1", name: "默认" }] });
        return;
      case "openapi/note/v1/list_note_by_folder_id": {
        const list = [...state.notes.values()];
        const start = Number(body.cursor || 0);
        const limit = Math.min(Number(body.limit || 50), 2);
        send(0, {
          note_book_list: list.slice(start, start + limit).map((n) => ({
            basic_info: { basic_info: { note_id: n.noteId, title: n.title, modify_time: n.modifyTime } },
          })),
          next_cursor: start + limit < list.length ? String(start + limit) : "",
          is_end: start + limit >= list.length,
        });
        return;
      }
      case "openapi/note/v1/get_doc_content":
        send(0, { content: state.notes.get(body.doc_id)?.content ?? "" });
        return;
      case "openapi/note/v1/import_doc": {
        const noteId = `nt_${++state.seq}`;
        const now = clock();
        state.notes.set(noteId, { noteId, title: "imported", content: body.content, modifyTime: now });
        send(0, { note_id: noteId });
        return;
      }
      case "openapi/wiki/v1/get_addable_knowledge_base_list":
        send(0, { addable_knowledge_base_list: [{ id: TEST_KB, name: "测试库" }], is_end: true });
        return;
      case "openapi/wiki/v1/add_knowledge":
        send(0, { media_id: `md_${++state.seq}` });
        return;
      default:
        send(99999, {}, `未知端点 ${endpoint}`);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    async addNote(title, content) {
      const noteId = `nt_${++state.seq}`;
      state.notes.set(noteId, { noteId, title, content, modifyTime: clock() });
      return noteId;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function makeTempVault(files = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "notes-e2e-vault-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function configFor(overrides = {}) {
  return {
    vaultRoot: overrides.vaultRoot,
    knowledgeBaseId: TEST_KB,
    folderId: "",
    excludes: [],
    inboxDir: "ima-inbox",
    conflictStrategy: "newest-wins",
    includeBinary: true,
    pullMode: "append",
    useReplace: true,
    recycleFolderId: "",
    contentFormat: 0,
    localPollMs: 1000,
    remotePollMs: 10000,
    maxFileBytes: 90 * 1024 * 1024,
    trashRetentionDays: 30,
    ...overrides,
  };
}

export function makeEngineOpts(client, vault, overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "notes-e2e-data-"));
  return {
    opts: {
      client,
      config: configFor({ vaultRoot: vault.root, ...overrides.config }),
      stateFile: path.join(dir, "state.json"),
      trashRoot: path.join(dir, "trash"),
      vaultRoot: vault.root,
      ...overrides.opts,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
