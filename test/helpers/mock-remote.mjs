// 测试替身：内存版 RemoteStore（路径镜像 + 逐字节保真），不碰网络、不碰 ima。
import { sha256 } from "../../src/notes-sync/vault.mjs";

/**
 * 模拟 src/notes-sync/remote-store.mjs 的对外接口。
 * 与真实实现一样按「相对路径」定位条目，标题即文件名，文件夹层级自动补建。
 */
export class MockRemoteStore {
  constructor({ names = { cgiId: "kb_cgi_test", openapiId: "ima_kb_test0001", name: "个人知识库" } } = {}) {
    this.files = new Map(); // relPath -> {mediaId, bytes, updateTime, folderId}
    this.dirs = new Map([["", "folder_root"]]);
    this.kbInfo = names;
    this.seq = 0;
    // 以真实时间为基准：引擎会用 Date.now() 比对 update_time。
    this.clock = Date.now();
    this.failNext = 0;
    this.failIndexNext = 0;
    this.calls = { upload: 0, add: 0, replace: 0, remove: 0, download: 0, mkdir: 0 };
  }

  tick() { this.clock += 1000; return this.clock; }
  id(prefix) { return `${prefix}_${++this.seq}`; }
  maybeFail() {
    if (this.failNext > 0) { this.failNext -= 1; throw new Error("模拟网络错误"); }
  }

  async kb() { return this.kbInfo; }

  async index() {
    if (this.failIndexNext > 0) { this.failIndexNext -= 1; throw new Error("rate limited"); }
    const byPath = new Map();
    for (const [relPath, f] of this.files) {
      byPath.set(relPath, {
        mediaId: f.mediaId,
        title: relPath.split("/").pop(),
        mediaType: 7,
        updateTime: f.updateTime,
        fileSize: f.bytes.length,
      });
    }
    return {
      kbId: this.kbInfo.cgiId,
      rootPath: "笔记",
      rootFolderId: this.dirs.get(""),
      byPath,
      dirs: new Map(this.dirs),
    };
  }

  async ensureFolder(relDir) {
    const clean = String(relDir || "").replace(/^\/+|\/+$/g, "");
    if (this.dirs.has(clean)) return this.dirs.get(clean);
    const segs = clean.split("/").filter(Boolean);
    let acc = "";
    for (const seg of segs) {
      const next = acc ? `${acc}/${seg}` : seg;
      if (!this.dirs.has(next)) {
        this.dirs.set(next, this.id("folder"));
        this.calls.mkdir += 1;
      }
      acc = next;
    }
    return this.dirs.get(clean);
  }

  async upload({ relPath, bytes }) {
    this.maybeFail();
    this.calls.upload += 1;
    return {
      mediaId: this.id("media"),
      cosKey: `cos/${relPath}`,
      contentType: "application/octet-stream",
      size: bytes.length,
      bytes: Buffer.from(bytes),
    };
  }

  async add({ relPath, upload, folderId }) {
    this.maybeFail();
    this.calls.add += 1;
    this.files.set(relPath, {
      mediaId: upload.mediaId,
      bytes: Buffer.from(upload.bytes),
      updateTime: this.tick(),
      folderId,
    });
    return upload.mediaId;
  }

  async replace({ relPath, originMediaId, upload, folderId }) {
    this.maybeFail();
    this.calls.replace += 1;
    if (!this.files.has(relPath)) throw new Error(`替换失败，远端已无 ${relPath}`);
    this.files.set(relPath, {
      mediaId: upload.mediaId,
      bytes: Buffer.from(upload.bytes),
      updateTime: this.tick(),
      folderId,
    });
    return upload.mediaId;
  }

  async refreshEntries(relPaths) {
    const out = new Map();
    for (const relPath of relPaths) {
      const f = this.files.get(relPath);
      if (f) out.set(relPath, { mediaId: f.mediaId, updateTime: f.updateTime, fileSize: f.bytes.length });
    }
    return out;
  }

  async remove(paths, index) {
    this.maybeFail();
    this.calls.remove += 1;
    const removed = [];
    const missing = [];
    for (const p of paths) {
      if (this.files.has(p)) { this.files.delete(p); removed.push(p); }
      else missing.push(p);
    }
    return { removed, missing, fail: [] };
  }

  async download(mediaId) {
    this.calls.download += 1;
    for (const [, f] of this.files) if (f.mediaId === mediaId) return Buffer.from(f.bytes);
    throw new Error(`media 不存在: ${mediaId}`);
  }

  async listNotes() { return []; }
  async readNote() { return ""; }

  // ---------- 测试辅助 ----------

  /** 模拟 ima 侧把某个条目换成新内容（会推进 update_time）。 */
  editRemote(relPath, content) {
    const f = this.files.get(relPath);
    if (!f) throw new Error(`远端没有 ${relPath}`);
    f.bytes = Buffer.from(content, "utf8");
    f.updateTime = this.tick();
  }

  /** 模拟 ima 侧直接新增一个条目（用户在其他端上传）。 */
  putRemote(relPath, content) {
    const folderId = this.dirs.get(relPath.split("/").slice(0, -1).join("/")) ?? this.dirs.get("");
    this.files.set(relPath, {
      mediaId: this.id("media"),
      bytes: Buffer.from(content, "utf8"),
      updateTime: this.tick(),
      folderId,
    });
  }

  remotePaths() { return [...this.files.keys()].sort(); }
  remoteBytes(relPath) {
    const f = this.files.get(relPath);
    return f ? Buffer.from(f.bytes) : null;
  }
  remoteHash(relPath) {
    const f = this.files.get(relPath);
    return f ? sha256(f.bytes) : null;
  }
}
