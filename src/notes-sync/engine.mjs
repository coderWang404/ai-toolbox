// 同步引擎：一轮完整的双向同步。client 可注入（本地 mock server 即可跑端到端测试）。
// 单条失败不中断整轮；所有写操作都经过 state 基线，保证重跑幂等。
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { dataFile } from "../paths.mjs";
import {
  scanVault, sha256, atomicWrite, moveToTrash, titleFor, extOf, mimeFor,
} from "./vault.mjs";
import { loadState, saveState, putRecord, removeRecord } from "./state.mjs";
import { ImaClient } from "./ima-api.mjs";
import { decide, Decision, resolveConflict, summarize } from "./reconcile.mjs";
import {
  canonicalHash, toIma, mergeRemoteIntoLocal, PULL_MODE, safeName,
} from "./transform.mjs";

const REPLACE = "DUPLICATE_NAME_STRATEGY_REPLACE";

export class SyncEngine {
  constructor(opts = {}) {
    this.config = opts.config ?? loadConfig();
    this.client = opts.client ?? new ImaClient(opts.creds);
    this.state = opts.state ?? loadState(opts.stateFile);
    this.stateFile = opts.stateFile;
    this.vaultRoot = opts.vaultRoot ?? this.config.vaultRoot;
    this.trashRoot = opts.trashRoot ?? dataFile("notes-sync-trash");
    this.log = opts.log ?? (() => {});
    this.pullMode = opts.pullMode ?? this.config.pullMode ?? PULL_MODE.APPEND;
    this.useReplace = opts.useReplace ?? this.config.useReplace ?? true;
    this.recycleFolderId = opts.recycleFolderId ?? this.config.recycleFolderId ?? "";
    this.contentFormat = opts.contentFormat ?? this.config.contentFormat ?? 0;
  }

  /** 每完成一个动作就落盘，长任务中途失败也能续传，不用从头再来。 */
  persist() {
    if (!this._dryRun) saveState(this.state, this.stateFile);
  }

  persistRecord(relPath, record) {
    putRecord(this.state, relPath, record);
    this.persist();
  }

  /** @param {{dryRun?:boolean}} opts @returns 一轮同步报告 */
  async runOnce({ dryRun = false } = {}) {
    this._dryRun = dryRun;
    const files = scanVault(this.vaultRoot, this.config);
    const localByPath = new Map(files.map((f) => [f.path, f]));
    const notes = await this.client.allNotes();
    const byNoteId = new Map(notes.filter((n) => n.noteId).map((n) => [n.noteId, n]));
    const mappedIds = new Set(
      Object.values(this.state.entries).map((e) => e.noteId).filter(Boolean)
    );
    // 推送时 ima 会新建 note（无覆盖更新），旧 note 可能仍出现在列表里。
    // 按标题去重，避免把自己刚推上去的历史版本当成「ima 新建笔记」拉回 inbox。
    const mappedTitles = new Set(
      Object.values(this.state.entries).map((e) => e.title).filter(Boolean)
    );

    const actions = [];
    const errors = [];
    // 本轮刚从 ima 落到 inbox 的文件不在扫描快照里，第 3 步不能把它们误判成「本地已删除」。
    const createdThisRun = new Set();

    // 1. 本地存在的文件
    for (const file of files) {
      try {
        const item = await this.processLocal(file, byNoteId, { dryRun });
        if (item) actions.push(item);
      } catch (err) {
        errors.push({ path: file.path, message: String(err.message ?? err) });
        this.log(`  ✗ ${file.path}: ${err.message}`);
      }
    }

    // 2. ima 里新建、本地没有映射的笔记 → 落到 inbox
    for (const note of notes) {
      if (!note.noteId || mappedIds.has(note.noteId) || mappedTitles.has(note.title)) continue;
      try {
        const item = await this.processRemoteNew(note, { dryRun });
        if (item) {
          actions.push(item);
          createdThisRun.add(item.path);
        }
      } catch (err) {
        errors.push({ path: note.title, message: String(err.message ?? err) });
      }
    }

    // 3. 本地已删除的文件 → 传播到 ima；ima 里消失的条目 → 清理映射
    for (const [relPath, rec] of Object.entries(this.state.entries)) {
      if (createdThisRun.has(relPath)) continue;
      if (localByPath.has(relPath)) {
        // 文件被恢复（曾经传播过删除）→ 取消删除标记并清空基线，下一轮重新推送
        if (rec.deleted && !dryRun) {
          rec.deleted = false;
          delete rec.deletedAt;
          rec.baseLocalHash = null;
          actions.push({ path: relPath, decision: "restored-locally" });
        }
        continue;
      }
      if (rec.deleted) continue; // 已传播过，保留墓碑防止被当成 ima 新笔记拉回
      const remoteNote = rec.noteId ? byNoteId.get(rec.noteId) : null;
      if (!remoteNote) {
        if (!dryRun) removeRecord(this.state, relPath);
        continue;
      }
      try {
        actions.push(await this.propagateDelete(relPath, rec, remoteNote, { dryRun }));
      } catch (err) {
        errors.push({ path: relPath, message: String(err.message ?? err) });
      }
    }

    if (!dryRun) saveState(this.state, this.stateFile);
    return {
      at: new Date().toISOString(),
      dryRun,
      localFiles: files.length,
      remoteNotes: notes.length,
      counts: summarize(actions.map((a) => a.decision)),
      actions,
      errors,
    };
  }

  async processLocal(file, byNoteId, { dryRun }) {
    const rec = this.state.entries[file.path] ?? null;
    const remoteNote = rec?.noteId ? byNoteId.get(rec.noteId) : null;
    const remoteExists = Boolean(remoteNote);
    const modifyTime = Number(remoteNote?.modifyTime ?? 0);
    const dirty = remoteExists && modifyTime > Number(rec?.remoteModifyTime ?? 0);

    // 二进制（图片/附件）：ima 不能在 App 里编辑文件型条目，因此只做本地 → 云端单向推送。
    if (!file.isText) {
      const hash = file.hash;
      if (rec && hash === rec.baseLocalHash) {
        return { path: file.path, decision: Decision.NOOP, reason: "binary-unchanged" };
      }
      return this.pushBinary(file, rec, { dryRun });
    }

    const localHash = canonicalHash(file.content ?? "");
    let remoteHash = rec?.baseRemoteHash ?? rec?.remoteHash ?? null;
    let remoteText = null;
    if (dirty && rec?.noteId) {
      const data = await this.client.getDocContent(rec.noteId, this.contentFormat);
      remoteText = String(data?.content ?? "");
      remoteHash = sha256(Buffer.from(remoteText, "utf8"));
    }

    let decision = decide({
      localExists: true,
      localHash,
      remoteExists,
      remoteHash,
      baseHash: rec?.baseLocalHash ?? rec?.baseHash ?? null,
      baseLocalHash: rec?.baseLocalHash ?? rec?.baseHash ?? null,
      baseRemoteHash: rec?.baseRemoteHash ?? rec?.baseHash ?? null,
      hadRecord: Boolean(rec),
    });

    if (decision === Decision.CONFLICT) {
      // 用户要求：不要冲突版本，以最新的为准。
      const resolved = resolveConflict({
        localMtimeMs: file.mtimeMs,
        remoteModifyTimeMs: modifyTime,
        localHash,
        remoteHash,
        strategy: this.config.conflictStrategy,
      });
      decision = resolved === "conflict-copy" ? Decision.CONFLICT : resolved;
    }

    if (decision === Decision.NOOP) {
      // 时间戳推进但不改内容时，也要刷新远端基线，避免下轮重复拉取。
      if (!dryRun && dirty && rec) {
        this.persistRecord( file.path, {
          ...rec, remoteModifyTime: modifyTime, baseRemoteHash: remoteHash,
        });
      }
      return { path: file.path, decision, reason: dirty ? "remote-touched-only" : "in-sync" };
    }

    if (decision === Decision.PUSH || decision === Decision.CREATE_REMOTE) {
      return this.pushText(file, rec, modifyTime, { dryRun });
    }

    if (decision === Decision.PULL) {
      if (remoteText === null && rec?.noteId) {
        const data = await this.client.getDocContent(rec.noteId, this.contentFormat);
        remoteText = String(data?.content ?? "");
        remoteHash = sha256(Buffer.from(remoteText, "utf8"));
      }
      return this.pullText(file, rec, remoteText, remoteHash, modifyTime, { dryRun });
    }

    return { path: file.path, decision, reason: "no-action" };
  }

  async pushText(file, rec, modifyTime, { dryRun }) {
    const content = toIma(file.content ?? "");
    const title = titleFor(file.path);
    if (dryRun) return { path: file.path, decision: rec ? Decision.PUSH : Decision.CREATE_REMOTE, reason: "dry-run" };

    const imported = await this.client.importDoc(content, { folderId: this.config.folderId || undefined });
    const noteId = imported?.note_id ?? imported?.noteId;
    if (!noteId) throw new Error("import_doc 未返回 note_id");

    const added = await this.client.addKnowledge({
      noteId,
      title,
      knowledgeBaseId: this.config.knowledgeBaseId,
      folderId: this.config.folderId || undefined,
      duplicateNameStrategy: this.useReplace ? REPLACE : undefined,
    });

    // 未启用 REPLACE 时才需要把旧条目挪进回收站（REPLACE 由服务端按同名替换）。
    if (!this.useReplace && rec?.mediaId && this.recycleFolderId) {
      try {
        await this.client.moveKnowledge({
          mediaId: rec.mediaId,
          knowledgeBaseId: this.config.knowledgeBaseId,
          targetFolderId: this.recycleFolderId,
        });
      } catch (err) {
        this.log(`  ! 旧条目移入回收站失败（不影响新版本）: ${err.message}`);
      }
    }

    const baseLocalHash = sha256(Buffer.from(content, "utf8"));
    // 推送后回读一次：ima 会把 Markdown 规范化（- → *、表头加粗、表格列宽对齐），
    // 远端实际内容与推送原文并不逐字节相同。不记录真实远端 hash 的话，
    // 下一轮会一直判定「远端改过」，形成无休止的回写。
    let baseRemoteHash = baseLocalHash;
    try {
      const back = await this.client.getDocContent(noteId, this.contentFormat);
      baseRemoteHash = sha256(Buffer.from(String(back?.content ?? ""), "utf8"));
    } catch (err) {
      this.log(`  ! 推送后回读失败，下一轮会再校准: ${err.message}`);
    }
    this.persistRecord( file.path, {
      title, noteId, mediaId: added?.media_id ?? rec?.mediaId ?? null,
      kbId: this.config.knowledgeBaseId,
      baseLocalHash,
      baseRemoteHash,
      remoteModifyTime: modifyTime || Date.now(),
      lastSyncAt: Date.now(),
      lastLocalMtimeMs: file.mtimeMs,
    });
    return { path: file.path, decision: rec ? Decision.PUSH : Decision.CREATE_REMOTE, noteId };
  }

  async pullText(file, rec, remoteText, remoteHash, modifyTime, { dryRun }) {
    const merged = mergeRemoteIntoLocal(file.content ?? "", remoteText ?? "", {
      mode: this.pullMode,
      stamp: new Date().toISOString().slice(0, 16).replace("T", " "),
    });
    if (dryRun) return { path: file.path, decision: Decision.PULL, reason: "dry-run", changed: merged.changed };

    const full = path.join(this.vaultRoot, file.path);
    if (merged.changed) atomicWrite(full, merged.content, 0o600);
    const baseLocalHash = canonicalHash(merged.content);
    this.persistRecord( file.path, {
      ...(rec ?? { title: titleFor(file.path), noteId: null, mediaId: null }),
      kbId: this.config.knowledgeBaseId,
      baseLocalHash,
      baseRemoteHash: remoteHash,
      remoteModifyTime: modifyTime || Date.now(),
      lastSyncAt: Date.now(),
      lastLocalMtimeMs: existsSync(full) ? undefined : rec?.lastLocalMtimeMs,
    });
    return {
      path: file.path, decision: Decision.PULL, changed: merged.changed,
      addedLines: merged.addedLines, mode: merged.mode,
    };
  }

  async pushBinary(file, rec, { dryRun }) {
    const title = file.path.split("/").pop();
    if (dryRun) return { path: file.path, decision: Decision.PUSH, reason: "dry-run-binary" };
    const bytes = readFileSync(path.join(this.vaultRoot, file.path));
    const created = await this.client.createMedia({
      fileName: title,
      fileSize: bytes.length,
      contentType: mimeFor(file.path),
      fileExt: extOf(file.path),
      knowledgeBaseId: this.config.knowledgeBaseId,
    });
    if (created?.upload_url?.presigned_url) {
      await this.client.uploadBinary(created.upload_url, bytes);
    } else if (created?.cos_credential) {
      // 实测返回的是 COS 临时凭证而不是预签名 URL。
      await this.client.uploadToCos(created.cos_credential, bytes, mimeFor(file.path));
    } else {
      throw new Error("create_media 既没返回 presigned_url 也没返回 cos_credential");
    }
    await this.client.addKnowledgeByMedia({
      mediaId: created?.media_id ?? created?.mediaId,
      title,
      knowledgeBaseId: this.config.knowledgeBaseId,
      folderId: this.config.folderId || undefined,
      duplicateNameStrategy: this.useReplace ? REPLACE : undefined,
    });
    this.persistRecord( file.path, {
      title, noteId: null, mediaId: created?.media_id ?? null,
      kbId: this.config.knowledgeBaseId,
      baseLocalHash: file.hash, baseRemoteHash: file.hash,
      remoteModifyTime: Date.now(), lastSyncAt: Date.now(),
      lastLocalMtimeMs: file.mtimeMs,
    });
    return { path: file.path, decision: Decision.PUSH, kind: "binary" };
  }

  /**
   * 本地删除传播到 ima。ima 没有删除接口（delete_knowledge 是 404），
   * 只能把知识库条目 move 进「回收站」文件夹；note 本体删不掉，
   * 所以 state 里保留 deleted 墓碑，避免下一轮把它当成「ima 新建笔记」拉回本地。
   * 若删除后远端又被改过，按 newest-wins 恢复本地文件。
   */
  async propagateDelete(relPath, rec, remoteNote, { dryRun }) {
    const remoteModified = Number(remoteNote.modifyTime ?? 0);
    // 判断「远端在我们上次同步后是否又改过」不能用时钟对时钟（两端时钟不同源，
    // 服务端 modify_time 常比本地 Date.now() 超前）。用内容 hash 比最可靠。
    let remoteChanged = false;
    if (rec.noteId && rec.baseRemoteHash) {
      if (dryRun) {
        remoteChanged = remoteModified > Number(rec.remoteModifyTime ?? 0);
      } else {
        const probe = await this.client.getDocContent(rec.noteId, this.contentFormat);
        const probeText = String(probe?.content ?? "");
        remoteChanged = sha256(Buffer.from(probeText, "utf8")) !== rec.baseRemoteHash;
      }
    }

    if (remoteChanged) {
      if (dryRun) return { path: relPath, decision: "restore-from-remote", reason: "dry-run" };
      const data = await this.client.getDocContent(rec.noteId, this.contentFormat);
      const text = String(data?.content ?? "");
      atomicWrite(path.join(this.vaultRoot, relPath), text, 0o600);
      this.persistRecord( relPath, {
        ...rec,
        deleted: false,
        deletedAt: undefined,
        baseLocalHash: canonicalHash(text),
        baseRemoteHash: sha256(Buffer.from(text, "utf8")),
        remoteModifyTime: remoteModified,
        lastSyncAt: Date.now(),
      });
      return { path: relPath, decision: "restore-from-remote" };
    }

    if (!this.recycleFolderId) {
      return {
        path: relPath, decision: Decision.LOCAL_DELETED,
        reason: "未配置回收站文件夹，删除未传播到 ima",
      };
    }
    if (dryRun) return { path: relPath, decision: Decision.LOCAL_DELETED, reason: "dry-run" };

    if (rec.mediaId) {
      await this.client.moveKnowledge({
        mediaId: rec.mediaId,
        knowledgeBaseId: this.config.knowledgeBaseId,
        targetFolderId: this.recycleFolderId,
      });
    }
    this.persistRecord( relPath, { ...rec, deleted: true, deletedAt: Date.now() });
    return { path: relPath, decision: Decision.LOCAL_DELETED, movedToRecycle: Boolean(rec.mediaId) };
  }

  async processRemoteNew(note, { dryRun }) {
    const relPath = `${this.config.inboxDir}/${safeName(note.title)}.md`;
    if (dryRun) return { path: relPath, decision: Decision.CREATE_LOCAL, reason: "dry-run" };
    if (existsSync(path.join(this.vaultRoot, relPath))) {
      return { path: relPath, decision: Decision.NOOP, reason: "inbox-file-exists" };
    }
    const data = await this.client.getDocContent(note.noteId, this.contentFormat);
    const remoteText = String(data?.content ?? "");
    const merged = mergeRemoteIntoLocal("", remoteText, {
      mode: PULL_MODE.MARKDOWN,
    });
    atomicWrite(path.join(this.vaultRoot, relPath), merged.content, 0o600);
    this.persistRecord( relPath, {
      title: note.title, noteId: note.noteId, mediaId: null,
      kbId: this.config.knowledgeBaseId,
      baseLocalHash: canonicalHash(merged.content),
      baseRemoteHash: sha256(Buffer.from(remoteText, "utf8")),
      remoteModifyTime: note.modifyTime,
      lastSyncAt: Date.now(),
    });
    return { path: relPath, decision: Decision.CREATE_LOCAL, noteId: note.noteId };
  }
}
