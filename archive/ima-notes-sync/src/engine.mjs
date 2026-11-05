// 同步引擎 v2：按「路径镜像」双向同步整个 vault。
//
// 与 v1 的区别：v1 把 ima 当笔记仓库，靠 noteId 平铺 + inbox 落地；
// v2 直接以相对路径为身份，远端文件夹层级与本地一致（`笔记/life/原则库.md` 对 `life/原则库.md`）。
//
// 为什么整条链路都用文件型条目（media_type=1）：
//   - 文件型下载回来逐字节保真（实测 sha256 与本地一致），能做安全的双向；
//   - note 型会被 ima 服务端规范化 Markdown，回读长度 555 → 750，往返会无限改写。
//   ima 侧因此不能直接编辑条目正文 —— 这与「手机只读 ima App」的用法一致。
//
// 差异检测不靠内容 hash 往来拉取，而是三方比对：
//   本地 sha256（每轮扫描算） / 远端 update_time + media_id（一次全树列举） / state 里的基线。
// 只有「远端 update_time 变了」才下载，所以稳态下一轮同步只有 1 次列表 + 0 次下载。
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { dataFile } from "../paths.mjs";
import { scanVault, sha256, atomicWrite, moveToTrash, mimeFor } from "./vault.mjs";
import { loadState, saveState, putRecord, removeRecord } from "./state.mjs";
import { RemoteStore, noteIdFromMediaId } from "./remote-store.mjs";
import { safeName } from "./transform.mjs";
import { Decision, summarize } from "./reconcile.mjs";

const dirOf = (relPath) => relPath.split("/").slice(0, -1).join("/");

export class SyncEngine {
  constructor(opts = {}) {
    this.config = opts.config ?? loadConfig();
    this.store = opts.store ?? new RemoteStore({ config: this.config });
    this.state = opts.state ?? loadState(opts.stateFile);
    this.stateFile = opts.stateFile;
    this.vaultRoot = opts.vaultRoot ?? this.config.vaultRoot;
    this.trashRoot = opts.trashRoot ?? dataFile("notes-sync-trash");
    this.log = opts.log ?? (() => {});
    // 常驻进程跨轮持有：size+mtime 未变的文件不重复读盘。
    this.contentCache = opts.contentCache ?? null;
  }

  persist() {
    if (!this._dryRun) saveState(this.state, this.stateFile);
  }

  persistRecord(relPath, record) {
    putRecord(this.state, relPath, record);
    this.persist();
  }

  readBytes(file) {
    if (file.isText) return Buffer.from(file.content ?? "", "utf8");
    return readFileSync(path.join(this.vaultRoot, file.path));
  }

  /** @param {{dryRun?:boolean, verify?:boolean}} opts */
  async runOnce({ dryRun = false, verify = false } = {}) {
    this._dryRun = dryRun;
    const files = scanVault(this.vaultRoot, { ...this.config, contentCache: this.contentCache });
    const localByPath = new Map(files.map((f) => [f.path, f]));
    const remote = await this.store.index();
    const actions = [];
    const errors = [];
    this._created = [];

    // 1. 目录：本地有、远端没有的先建出来（浅的在前，父目录必须先存在）。
    const localDirs = new Set();
    for (const f of files) {
      const segs = f.path.split("/");
      segs.pop();
      let acc = "";
      for (const s of segs) {
        acc = acc ? `${acc}/${s}` : s;
        localDirs.add(acc);
      }
    }
    const missingDirs = [...localDirs]
      .filter((d) => !remote.dirs.has(d))
      .sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
    for (const d of missingDirs) {
      if (dryRun) { actions.push({ path: d, decision: "mkdir", reason: "dry-run" }); continue; }
      try {
        await this.store.ensureFolder(d);
        actions.push({ path: d, decision: "mkdir" });
      } catch (err) {
        errors.push({ path: d, message: String(err.message ?? err) });
      }
    }

    // 2. 本地每个文件。
    for (const file of files) {
      try {
        const item = await this.processLocal(file, remote, { dryRun, verify });
        if (item) actions.push(item);
      } catch (err) {
        errors.push({ path: file.path, message: String(err.message ?? err) });
        this.log(`  ✗ ${file.path}: ${err.message}`);
      }
    }

    // 3. 远端有、本地没有。
    for (const [relPath, r] of remote.byPath) {
      if (localByPath.has(relPath)) continue;
      try {
        actions.push(await this.handleRemoteOnly(relPath, r, remote, { dryRun }));
      } catch (err) {
        errors.push({ path: relPath, message: String(err.message ?? err) });
        this.log(`  ✗ ${relPath}: ${err.message}`);
      }
    }

    // 4. ima App 里手写的原生笔记（不在同步文件夹内）→ 本地 inbox。
    if (this.config.pullNotes !== false) {
      try {
        actions.push(...await this.pullInboxNotes({ dryRun }));
      } catch (err) {
        errors.push({ path: "(inbox)", message: String(err.message ?? err) });
      }
    }

    // 新建条目拿不到 update_time，轮末按目录回查一次补进基线，
    // 否则下一轮会把「自己刚推的那份」当成远端变化又拉回来。
    if (!dryRun && this._created.length) {
      try {
        const refreshed = await this.store.refreshEntries(this._created);
        for (const [relPath, info] of refreshed) {
          const rec = this.state.entries[relPath];
          if (!rec) continue;
          rec.mediaId = info.mediaId;
          rec.remoteUpdateTime = info.updateTime;
        }
      } catch (err) {
        errors.push({ path: "(refresh)", message: String(err.message ?? err) });
      }
    }

    if (!dryRun) saveState(this.state, this.stateFile);
    return {
      at: new Date().toISOString(),
      dryRun,
      localFiles: files.length,
      remoteFiles: remote.byPath.size,
      counts: summarize(actions.map((a) => a.decision)),
      actions,
      errors,
    };
  }

  async processLocal(file, remote, { dryRun, verify }) {
    const relPath = file.path;
    // inbox 是「从 ima 拉下来」的单向落地目录，dir 层面的 exclude 之外再兜一层。
    if (relPath.startsWith(`${this.config.inboxDir}/`)) {
      return { path: relPath, decision: "skip", reason: "inbox" };
    }
    if (!mimeFor(relPath)) {
      return { path: relPath, decision: "skip", reason: "ima 不支持的扩展名" };
    }

    const rec = this.state.entries[relPath] ?? null;
    const r = remote.byPath.get(relPath) ?? null;
    const localHash = file.hash;

    // ---- 远端没有：新建 ----
    if (!r) {
      if (dryRun) {
        return { path: relPath, decision: rec ? Decision.PUSH : Decision.CREATE_REMOTE, reason: "dry-run" };
      }
      const bytes = this.readBytes(file);
      const upload = await this.store.upload({ relPath, bytes });
      const folderId = await this.store.ensureFolder(dirOf(relPath));
      const mediaId = await this.store.add({ relPath, upload, folderId });
      this.persistRecord(relPath, {
        mediaId,
        fileSize: bytes.length,
        baseLocalHash: localHash,
        // 0 = 还没问到服务端这次给的 update_time；本轮回查后补上（见 runOnce 末尾）。
        remoteUpdateTime: 0,
        lastSyncAt: Date.now(),
      });
      this._created.push(relPath);
      return { path: relPath, decision: rec ? Decision.PUSH : Decision.CREATE_REMOTE, mediaId };
    }

    // ---- 首次见到这个路径：先用大小粗筛，避免为 600 个文件各下载一次 ----
    if (!rec) {
      if (r.fileSize === file.size && !verify) {
        this.persistRecord(relPath, {
          mediaId: r.mediaId,
          fileSize: r.fileSize,
          baseLocalHash: localHash,
          remoteUpdateTime: r.updateTime,
          lastSyncAt: Date.now(),
        });
        return { path: relPath, decision: Decision.NOOP, reason: "adopted-by-size" };
      }
      const bytes = await this.store.readEntry(relPath, r);
      if (sha256(bytes) === localHash) {
        this.persistRecord(relPath, {
          mediaId: r.mediaId,
          fileSize: bytes.length,
          baseLocalHash: localHash,
          remoteUpdateTime: r.updateTime,
          lastSyncAt: Date.now(),
        });
        return { path: relPath, decision: Decision.NOOP, reason: "adopted-by-hash" };
      }
      // 内容确实不同：谁新听谁的。
      const useRemote = Number(r.updateTime) > Number(file.mtimeMs);
      if (dryRun) {
        return { path: relPath, decision: useRemote ? Decision.PULL : Decision.PUSH, reason: "dry-run-no-baseline" };
      }
      // 首次没有基线但本地更新：直接以远端现有条目的 mediaId 为替换目标。
      return useRemote
        ? this.pullBytes(file, r, bytes, { dryRun })
        : this.pushFile(file, rec ?? { mediaId: r.mediaId }, { dryRun });
    }

    const localChanged = rec.baseLocalHash !== localHash;
    // remoteUpdateTime = 0 表示「我们推完之后还没问过服务端这次给的 update_time」，
    // 必须当成「可能变了」去下载校验一次，否则无法区分远端那点变化是不是自己刚推的。
    const remoteKnown = Number(rec.remoteUpdateTime ?? 0) > 0;
    const remoteChanged = r.mediaId !== rec.mediaId || !remoteKnown
      || Number(r.updateTime) > Number(rec.remoteUpdateTime);

    if (!localChanged && !remoteChanged) {
      return { path: relPath, decision: Decision.NOOP, reason: "in-sync" };
    }
    if (localChanged && !remoteChanged) {
      if (dryRun) return { path: relPath, decision: Decision.PUSH, reason: "dry-run" };
      return this.pushFile(file, rec, { dryRun });
    }

    // 远端变了（或两端都变）：必须下载才知道真实内容。
    const bytes = await this.store.readEntry(relPath, r);
    if (sha256(bytes) === localHash) {
      // 内容其实一致（例如远端只是被重命名/替换成同一份），只刷新基线。
      if (!dryRun) {
        this.persistRecord(relPath, {
          ...rec,
          mediaId: r.mediaId,
          fileSize: r.fileSize,
          remoteUpdateTime: r.updateTime,
          lastSyncAt: Date.now(),
        });
      }
      return { path: relPath, decision: Decision.NOOP, reason: "remote-touched-only" };
    }
    if (!localChanged) {
      return this.pullBytes(file, r, bytes, { dryRun });
    }

    // 两端都改过。基线未知时先认为「远端那次变化就是我们上一轮推的」，以本地为准，
    // 否则推送完的下一轮会被自己的版本反拉回去（远端 update_time 必然晚于本地 mtime）。
    if (!remoteKnown) {
      if (dryRun) return { path: relPath, decision: Decision.PUSH, reason: "dry-run-after-push" };
      return this.pushFile(file, rec, { dryRun });
    }
    // 有可靠基线：newest-wins，不生成冲突副本（用户明确要求）。
    const useRemote = Number(r.updateTime) > Number(file.mtimeMs);
    if (dryRun) {
      return { path: relPath, decision: useRemote ? Decision.PULL : Decision.PUSH, reason: "dry-run-conflict" };
    }
    return useRemote
      ? this.pullBytes(file, r, bytes, { dryRun })
      : this.pushFile(file, rec, { dryRun });
  }

  async pushFile(file, rec, { dryRun }) {
    const relPath = file.path;
    const bytes = this.readBytes(file);
    const upload = await this.store.upload({ relPath, bytes });
    const folderId = await this.store.ensureFolder(dirOf(relPath));
    const replaced = await this.store.replace({
      relPath, originMediaId: rec.mediaId, upload, folderId,
    });
    this.persistRecord(relPath, {
      ...rec,
      mediaId: replaced.mediaId,
      fileSize: bytes.length,
      baseLocalHash: file.hash,
      remoteUpdateTime: replaced.updateTime,
      lastSyncAt: Date.now(),
    });
    return { path: relPath, decision: Decision.PUSH, mediaId: replaced.mediaId };
  }

  async pullBytes(file, r, bytes, { dryRun }) {
    const relPath = file.path;
    if (dryRun) return { path: relPath, decision: Decision.PULL, reason: "dry-run" };
    const full = path.join(this.vaultRoot, relPath);
    if (this.config.backupBeforePull !== false && existsSync(full)) {
      moveToTrash(this.vaultRoot, this.trashRoot, relPath);
    }
    atomicWrite(full, bytes, 0o600);
    this.persistRecord(relPath, {
      mediaId: r.mediaId,
      fileSize: bytes.length,
      baseLocalHash: sha256(bytes),
      remoteUpdateTime: r.updateTime,
      lastSyncAt: Date.now(),
    });
    return { path: relPath, decision: Decision.PULL, bytes: bytes.length };
  }

  /**
   * ima App 里新建的笔记是 note 型，落在「笔记列表」而不是同步文件夹，
   * 主链路的远端索引根本看不到它们。这里单独把它们拉到本地 inbox，
   * 只拉不推（inbox 目录已在 config 的 excludes 里）。
   */
  async pullInboxNotes({ dryRun }) {
    const notes = await this.store.listNotes();
    const inbox = this.state.inboxNotes ?? (this.state.inboxNotes = {});
    const known = new Set();
    for (const rec of Object.values(this.state.entries)) {
      const id = rec.mediaId ? noteIdFromMediaId(rec.mediaId) : null;
      if (id) known.add(id);
    }
    // 首次启用只记录基线：知识库里可能已经堆着几十篇历史笔记（含早期探针残留），
    // 一次性灌进 vault 会很难看。之后新增的才自动落地；要全量导入用 notes-inbox --all。
    if (!this.state.inboxInitialized) {
      if (dryRun) return [];
      for (const note of notes) {
        inbox[note.noteId] = {
          title: note.title, modifyTime: Number(note.modifyTime ?? 0), baseline: true, path: null,
        };
      }
      this.state.inboxInitialized = true;
      this.persist();
      this.log(`  inbox 基线：跳过 ${notes.length} 篇历史笔记（notes-inbox --all 可手工导入）`);
      return [];
    }

    const actions = [];
    for (const note of notes) {
      if (known.has(note.noteId)) continue;
      const prev = inbox[note.noteId];
      const modifyTime = Number(note.modifyTime ?? 0);
      if (prev && modifyTime <= Number(prev.modifyTime ?? 0)) continue;
      const relPath = `${this.config.inboxDir}/${safeName(note.title)}.md`;
      if (dryRun) {
        actions.push({ path: relPath, decision: "note-inbox", reason: "dry-run" });
        continue;
      }
      const text = await this.store.readNote(note.noteId);
      atomicWrite(path.join(this.vaultRoot, relPath), text, 0o600);
      inbox[note.noteId] = {
        path: relPath, title: note.title, modifyTime,
        lastPullAt: Date.now(), baseHash: sha256(Buffer.from(text, "utf8")),
      };
      actions.push({ path: relPath, decision: "note-inbox" });
    }
    return actions;
  }

  /** 手工把 ima 里的手写笔记导入 inbox（`notes-inbox --pull all|noteId|标题`）。 */
  async importNotes({ all = false, ids = [] } = {}) {
    const notes = await this.store.listNotes();
    const inbox = this.state.inboxNotes ?? (this.state.inboxNotes = {});
    const targets = all
      ? notes
      : notes.filter((n) => ids.includes(n.noteId) || ids.includes(n.title));
    const out = [];
    for (const note of targets) {
      const relPath = `${this.config.inboxDir}/${safeName(note.title)}.md`;
      const text = await this.store.readNote(note.noteId);
      atomicWrite(path.join(this.vaultRoot, relPath), text, 0o600);
      inbox[note.noteId] = {
        path: relPath,
        title: note.title,
        modifyTime: Number(note.modifyTime ?? 0),
        lastPullAt: Date.now(),
        baseHash: sha256(Buffer.from(text, "utf8")),
      };
      out.push({ noteId: note.noteId, title: note.title, path: relPath, bytes: Buffer.byteLength(text) });
    }
    this.state.inboxInitialized = true;
    saveState(this.state, this.stateFile);
    return out;
  }

  async handleRemoteOnly(relPath, r, remote, { dryRun }) {
    const rec = this.state.entries[relPath] ?? null;

    // 以前同步过、现在本地没了 → 本地删除，传播到 ima。
    if (rec) {
      if (dryRun) return { path: relPath, decision: Decision.LOCAL_DELETED, reason: "dry-run" };
      const result = await this.store.remove([relPath], remote);
      if (result.fail.length) {
        return { path: relPath, decision: Decision.LOCAL_DELETED, failed: result.fail };
      }
      removeRecord(this.state, relPath);
      this.persist();
      return { path: relPath, decision: Decision.LOCAL_DELETED, removed: result.removed.length };
    }

    // 从没同步过的远端条目 → 拉到本地。
    if (dryRun) return { path: relPath, decision: Decision.CREATE_LOCAL, reason: "dry-run" };
    const bytes = await this.store.readEntry(relPath, r);
    atomicWrite(path.join(this.vaultRoot, relPath), bytes, 0o600);
    this.persistRecord(relPath, {
      mediaId: r.mediaId,
      fileSize: bytes.length,
      baseLocalHash: sha256(bytes),
      remoteUpdateTime: r.updateTime,
      lastSyncAt: Date.now(),
    });
    return { path: relPath, decision: Decision.CREATE_LOCAL, bytes: bytes.length };
  }
}
