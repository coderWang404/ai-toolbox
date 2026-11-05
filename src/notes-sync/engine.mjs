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

  /** @param {{dryRun?:boolean}} opts @returns 一轮同步报告 */
  async runOnce({ dryRun = false } = {}) {
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
        if (item) actions.push(item);
      } catch (err) {
        errors.push({ path: note.title, message: String(err.message ?? err) });
      }
    }

    // 3. state 里有映射、但两端都已消失的记录 → 清理映射
    for (const [relPath, rec] of Object.entries(this.state.entries)) {
      if (localByPath.has(relPath)) continue;
      const stillRemote = rec.noteId && byNoteId.has(rec.noteId);
      if (!stillRemote && !dryRun) removeRecord(this.state, relPath);
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
        putRecord(this.state, file.path, {
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
    putRecord(this.state, file.path, {
      title, noteId, mediaId: added?.media_id ?? rec?.mediaId ?? null,
      kbId: this.config.knowledgeBaseId,
      baseLocalHash,
      baseRemoteHash: baseLocalHash,
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
    putRecord(this.state, file.path, {
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
    }
    await this.client.addKnowledgeByMedia({
      mediaId: created?.media_id ?? created?.mediaId,
      title,
      knowledgeBaseId: this.config.knowledgeBaseId,
      folderId: this.config.folderId || undefined,
      duplicateNameStrategy: this.useReplace ? REPLACE : undefined,
    });
    putRecord(this.state, file.path, {
      title, noteId: null, mediaId: created?.media_id ?? null,
      kbId: this.config.knowledgeBaseId,
      baseLocalHash: file.hash, baseRemoteHash: file.hash,
      remoteModifyTime: Date.now(), lastSyncAt: Date.now(),
      lastLocalMtimeMs: file.mtimeMs,
    });
    return { path: file.path, decision: Decision.PUSH, kind: "binary" };
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
    putRecord(this.state, relPath, {
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
