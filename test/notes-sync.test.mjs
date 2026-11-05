// notes-sync 核心纯逻辑测试：不联网、不碰真实 vault。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decide, Decision, conflictPathFor, summarize } from "../src/notes-sync/reconcile.mjs";
import { isIgnored, sha256, scanVault, atomicWrite, titleFor, moveToTrash } from "../src/notes-sync/vault.mjs";
import { loadState, saveState, putRecord, recordFor, removeRecord, statsOf, emptyState } from "../src/notes-sync/state.mjs";

const local = "L";
const base = "B";
const remote = "R";

test("三方比对：都没变 → noop", () => {
  assert.equal(decide({
    localExists: true, localHash: base, remoteExists: true, remoteHash: base,
    baseHash: base, hadRecord: true,
  }), Decision.NOOP);
});

test("三方比对：只有本地变 → push", () => {
  assert.equal(decide({
    localExists: true, localHash: local, remoteExists: true, remoteHash: base,
    baseHash: base, hadRecord: true,
  }), Decision.PUSH);
});

test("三方比对：只有 ima 变 → pull（双向的关键分支）", () => {
  assert.equal(decide({
    localExists: true, localHash: base, remoteExists: true, remoteHash: remote,
    baseHash: base, hadRecord: true,
  }), Decision.PULL);
});

test("三方比对：两端都改但收敛到同一内容 → noop", () => {
  assert.equal(decide({
    localExists: true, localHash: local, remoteExists: true, remoteHash: local,
    baseHash: base, hadRecord: true,
  }), Decision.NOOP);
});

test("三方比对：两端都改且不同 → conflict", () => {
  assert.equal(decide({
    localExists: true, localHash: local, remoteExists: true, remoteHash: remote,
    baseHash: base, hadRecord: true,
  }), Decision.CONFLICT);
});

test("首次同步：本地有、远端无 → create-remote", () => {
  assert.equal(decide({
    localExists: true, localHash: local, remoteExists: false, remoteHash: null,
    baseHash: null, hadRecord: false,
  }), Decision.CREATE_REMOTE);
});

test("首次同步：ima 里新建的笔记 → create-local", () => {
  assert.equal(decide({
    localExists: false, localHash: null, remoteExists: true, remoteHash: remote,
    baseHash: null, hadRecord: false,
  }), Decision.CREATE_LOCAL);
});

test("首次同步：无基线且两边内容不同 → 不猜，判冲突", () => {
  assert.equal(decide({
    localExists: true, localHash: local, remoteExists: true, remoteHash: remote,
    baseHash: null, hadRecord: false,
  }), Decision.CONFLICT);
});

test("首次同步：无基线但两边内容相同 → 直接登记", () => {
  assert.equal(decide({
    localExists: true, localHash: local, remoteExists: true, remoteHash: local,
    baseHash: null, hadRecord: false,
  }), Decision.NOOP);
});

test("删除语义：本地删除且远端未改 → local-deleted；远端也改过 → 冲突保内容", () => {
  assert.equal(decide({
    localExists: false, localHash: null, remoteExists: true, remoteHash: base,
    baseHash: base, hadRecord: true,
  }), Decision.LOCAL_DELETED);
  assert.equal(decide({
    localExists: false, localHash: null, remoteExists: true, remoteHash: remote,
    baseHash: base, hadRecord: true,
  }), Decision.CONFLICT);
});

test("删除语义：远端消失且本地未改 → remote-deleted", () => {
  assert.equal(decide({
    localExists: true, localHash: base, remoteExists: false, remoteHash: null,
    baseHash: base, hadRecord: true,
  }), Decision.REMOTE_DELETED);
});

test("冲突副本命名沿用 note-sync 约定，且不破坏扩展名", () => {
  const d = new Date(2026, 9, 26, 8, 19, 48);
  assert.equal(conflictPathFor("学习笔记/git/git学习指南.md", d),
    "学习笔记/git/git学习指南 (note-conflict 2026-10-26 081948).md");
  assert.equal(conflictPathFor("根目录", d),
    "根目录 (note-conflict 2026-10-26 081948)");
});

test("决策汇总计数", () => {
  assert.deepEqual(summarize(["push", "pull", "push", "noop"]),
    { push: 2, pull: 1, noop: 1 });
});

test("忽略规则：全库同步，只过滤技术噪声，不排除任何内容目录", () => {
  assert.equal(isIgnored("life/原则库.md"), false);
  assert.equal(isIgnored("image/Pasted image 2026.png"), false);
  assert.equal(isIgnored("学习笔记/a.pdf"), false);
  assert.equal(isIgnored(".obsidian/plugins/x.md"), true);
  assert.equal(isIgnored("学习笔记/a_冲突文件_beiwe.md"), true);
  assert.equal(isIgnored("学习笔记/旧 (note-conflict 2026-10-26 081948).md"), true);
  assert.equal(isIgnored("学习笔记/a.tmp.123"), true);
  assert.equal(isIgnored("学习笔记/a.unknownext"), true, "ima 不认识的扩展名不上传");
});

test("忽略规则：正常笔记放行", () => {
  assert.equal(isIgnored("学习笔记/开发工具/git/git学习指南.md"), false);
  assert.equal(isIgnored("实验室/服务器/部署.md"), false);
  assert.equal(isIgnored("归档规范.md"), false);
});

test("sha256 稳定且与内容一致", () => {
  assert.equal(sha256(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("scanVault 全库收录文本与图片，只跳过技术噪声", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "notes-vault-"));
  try {
    mkdirSync(path.join(root, "学习笔记"), { recursive: true });
    mkdirSync(path.join(root, "life"), { recursive: true });
    mkdirSync(path.join(root, "image"), { recursive: true });
    writeFileSync(path.join(root, "学习笔记/a.md"), "A");
    writeFileSync(path.join(root, "学习笔记/b.md"), "B");
    writeFileSync(path.join(root, "life/原则库.md"), "SECRET");
    writeFileSync(path.join(root, "image/x.png"), "IMG");
    writeFileSync(path.join(root, "学习笔记/冲突文件.md"), "NOISE");
    const list = scanVault(root);
    assert.deepEqual(list.map((f) => f.path), [
      "image/x.png", "life/原则库.md", "学习笔记/a.md", "学习笔记/b.md",
    ]);
    const a = list.find((f) => f.path === "学习笔记/a.md");
    assert.equal(a.hash, sha256(Buffer.from("A")));
    assert.equal(a.content, "A");
    const img = list.find((f) => f.path === "image/x.png");
    assert.equal(img.isText, false);
    assert.equal(img.content, null, "二进制不转 UTF-8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomicWrite 不留下 .tmp 残留，内容可读", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "notes-write-"));
  try {
    const file = path.join(dir, "sub", "a.md");
    atomicWrite(file, "你好 ima");
    assert.equal(readFileSync(file, "utf8"), "你好 ima");
    assert.equal(existsSync(`${file}.notes-sync-${process.pid}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("moveToTrash 把文件移出 vault 且保留原相对路径", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "notes-trash-src-"));
  const trash = mkdtempSync(path.join(os.tmpdir(), "notes-trash-dst-"));
  try {
    mkdirSync(path.join(root, "学习笔记"), { recursive: true });
    writeFileSync(path.join(root, "学习笔记/a.md"), "A");
    const dest = moveToTrash(root, trash, "学习笔记/a.md", new Date(2026, 10, 5, 8, 30, 0));
    assert.equal(existsSync(path.join(root, "学习笔记/a.md")), false);
    assert.equal(readFileSync(dest, "utf8"), "A");
    assert.match(dest, /20261105-083000/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(trash, { recursive: true, force: true });
  }
});

test("titleFor 去扩展名、保留中文", () => {
  assert.equal(titleFor("学习笔记/git/git学习指南.md"), "git学习指南");
  assert.equal(titleFor("归档规范.md"), "归档规范");
});

test("state 读写：映射表落盘、可回读、统计正确", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "notes-state-"));
  const file = path.join(dir, "state.json");
  try {
    const state = loadState(file);
    assert.deepEqual(state, emptyState());
    putRecord(state, "学习笔记/a.md", {
      title: "a", noteId: "nt_1", mediaId: "md_1", kbId: "ima_kb_x",
      baseHash: "H", remoteHash: "H", remoteModifyTime: 123,
      lastSyncAt: 456, lastLocalMtimeMs: 789,
    });
    saveState(state, file);
    const back = loadState(file);
    assert.equal(recordFor(back, "学习笔记/a.md").noteId, "nt_1");
    assert.deepEqual(statsOf(back), { total: 1, withNoteId: 1, withBaseHash: 1, lastSyncAt: 456 });
    removeRecord(back, "学习笔记/a.md");
    assert.equal(recordFor(back, "学习笔记/a.md"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state 损坏时拒绝静默重置（否则会把全库当首次同步重复导入）", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "notes-state-bad-"));
  const file = path.join(dir, "state.json");
  try {
    writeFileSync(file, "{ broken json");
    assert.throws(() => loadState(file), /同步状态文件损坏/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
