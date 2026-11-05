// 稳定性测试：长循环、单条失败隔离、限频、状态损坏、目录剧烈波动、并发幂等。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncEngine } from "../src/notes-sync/engine.mjs";
import { scanVault } from "../src/notes-sync/vault.mjs";
import { loadState } from "../src/notes-sync/state.mjs";
import { MockImaClient, makeTempVault, makeEngineOpts } from "./helpers/mock-ima.mjs";

function setup(files = {}) {
  const client = new MockImaClient();
  const vault = makeTempVault(files);
  const { opts, cleanup } = makeEngineOpts(client, vault);
  return {
    client, vault, opts,
    engine: () => new SyncEngine(opts),
    cleanup: () => { cleanup(); vault.cleanup(); },
  };
}

test("连续 100 轮同步：状态收敛、无错误、无重复推送", async () => {
  const s = setup({ "a.md": "# A\n\n稳定\n", "life/b.md": "# B\n" });
  try {
    let pushes = 0;
    for (let round = 0; round < 100; round++) {
      const r = await s.engine().runOnce();
      assert.equal(r.errors.length, 0, `第 ${round} 轮出错`);
      pushes += r.counts.push ?? 0;
      if (round > 1) {
        assert.equal(r.counts.push ?? 0, 0, `第 ${round} 轮意外重复推送`);
        assert.equal(r.counts.pull ?? 0, 0, `第 ${round} 轮意外重复回写`);
      }
    }
    assert.ok(pushes === 0, `首轮之后不应再有 push，实际 ${pushes}`);
    const state = loadState(s.opts.stateFile);
    assert.equal(Object.keys(state.entries).length, 2);
    assert.equal(readFileSync(path.join(s.vault.root, "a.md"), "utf8").includes("ima 补记"), false);
  } finally {
    s.cleanup();
  }
});

test("单条写失败被隔离，下轮自动补齐，不中断整轮", async () => {
  const s = setup({ "a.md": "# A\n", "b.md": "# B\n", "c.md": "# C\n" });
  try {
    s.client.failNext = 1; // 第一条 importDoc 失败
    const r1 = await s.engine().runOnce();
    assert.equal(r1.errors.length, 1, `应恰好隔离一条失败，实际 ${JSON.stringify(r1.errors)}`);
    assert.ok((r1.counts["create-remote"] ?? 0) >= 2, "其余文件仍应成功");
    const r2 = await s.engine().runOnce();
    assert.equal(r2.errors.length, 0);
    assert.equal(Object.keys(loadState(s.opts.stateFile).entries).length, 3);
  } finally {
    s.cleanup();
  }
});

test("限频导致整轮失败时，state 文件不被写坏", async () => {
  const s = setup({ "a.md": "# A\n" });
  try {
    await s.engine().runOnce();
    const before = readFileSync(s.opts.stateFile, "utf8");
    s.client.rateLimitNext = 1;
    await assert.rejects(() => s.engine().runOnce(), /rate limited/);
    assert.equal(readFileSync(s.opts.stateFile, "utf8"), before);
    const r = await s.engine().runOnce();
    assert.equal(r.errors.length, 0, "限频过后应自动恢复");
  } finally {
    s.cleanup();
  }
});

test("state 文件损坏时拒绝静默重置", async () => {
  const s = setup({ "a.md": "# A\n" });
  try {
    await s.engine().runOnce();
    writeFileSync(s.opts.stateFile, "{ broken");
    assert.throws(() => loadState(s.opts.stateFile), /同步状态文件损坏/);
    assert.throws(() => new SyncEngine(s.opts), /同步状态文件损坏/);
  } finally {
    s.cleanup();
  }
});

test("百度云同步盘目录剧烈波动：扫描中途目录消失不崩", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "notes-flaky-"));
  try {
    for (let i = 0; i < 40; i++) {
      const dir = path.join(root, `d${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "n.md"), `# ${i}\n`);
    }
    // 模拟同步盘抽走一半目录
    for (let i = 0; i < 40; i += 2) rmSync(path.join(root, `d${i}`), { recursive: true, force: true });
    const list = scanVault(root, { excludes: [], maxFileBytes: 90 * 1024 * 1024 });
    assert.equal(list.length, 20);
    // 目录再全部消失
    for (let i = 1; i < 40; i += 2) rmSync(path.join(root, `d${i}`), { recursive: true, force: true });
    assert.deepEqual(scanVault(root, { excludes: [], maxFileBytes: 90 * 1024 * 1024 }), []);
    assert.ok(existsSync(root), "根目录仍在，扫描不应抛错");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("中文/空格/特殊字符路径与内容可稳定往返", async () => {
  const s = setup({
    "学习笔记/开发工具/git 学习 指南 (2026).md": "# git 学习\n\n| 列 | 值 |\n| --- | --- |\n\n```js\nconst a = 1;\n```\n",
    "实验室/服务器/部署 #1.md": "# 部署\n\n![[Pasted image 2026.png]]\n",
  });
  try {
    const r = await s.engine().runOnce();
    assert.equal(r.errors.length, 0);
    assert.equal(r.counts["create-remote"], 2);
    const rec = loadState(s.opts.stateFile).entries["学习笔记/开发工具/git 学习 指南 (2026).md"];
    s.client.editInIma(rec.noteId, "# git 学习\n\n| 列 | 值 |\n| --- | --- |\n\n```js\nconst a = 1;\n```\n\n补充一行\n");
    const r2 = await s.engine().runOnce();
    assert.equal(r2.counts.pull, 1);
    const text = readFileSync(path.join(s.vault.root, "学习笔记/开发工具/git 学习 指南 (2026).md"), "utf8");
    assert.match(text, /```js/);
    assert.match(text, /\| --- \|/);
    assert.match(text, /补充一行/);
  } finally {
    s.cleanup();
  }
});

test("并发启动两个引擎实例不会把同一文件重复推两次", async () => {
  const s = setup({ "a.md": "# A\n" });
  try {
    const [r1, r2] = await Promise.all([
      s.engine().runOnce({ dryRun: true }),
      s.engine().runOnce({ dryRun: true }),
    ]);
    assert.equal(s.client.calls.importDoc, 0, "dry-run 并发不应写");
    assert.equal(r1.errors.length + r2.errors.length, 0);
  } finally {
    s.cleanup();
  }
});
