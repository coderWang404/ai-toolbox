// 功能测试：本地 mock 远端跑通「路径镜像 + 逐字节」同步 + 真实 HTTP mock 验证 API 层。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import path from "node:path";
import { SyncEngine } from "../src/notes-sync/engine.mjs";
import { ImaClient, rawCall, setBaseUrl } from "../src/notes-sync/ima-api.mjs";
import { loadState } from "../src/notes-sync/state.mjs";
import { MockRemoteStore } from "./helpers/mock-remote.mjs";
import { startMockHttpServer, makeTempVault, makeEngineOpts } from "./helpers/mock-ima.mjs";

function setup(files = {}, overrides = {}) {
  const store = new MockRemoteStore();
  const vault = makeTempVault(files);
  const { opts, cleanup } = makeEngineOpts(store, vault, overrides);
  return {
    store, vault, opts,
    engine: () => new SyncEngine(opts),
    cleanup: () => { cleanup(); vault.cleanup(); },
  };
}

test("首次同步：全库按相对路径镜像到远端，第二次完全幂等", async () => {
  const s = setup({
    "学习笔记/a.md": "# A\n\n内容 A\n",
    "life/原则库.md": "# 原则\n\n私密内容\n",
    "image/x.png": "PNG-BYTES",
  });
  try {
    const r1 = await s.engine().runOnce();
    assert.equal(r1.errors.length, 0, JSON.stringify(r1.errors));
    assert.equal(r1.counts["create-remote"], 3, JSON.stringify(r1.counts));
    assert.deepEqual(s.store.remotePaths(), ["image/x.png", "life/原则库.md", "学习笔记/a.md"]);
    assert.equal(s.store.dirs.has("学习笔记"), true, "远端应建出同名目录");
    assert.equal(s.store.remoteBytes("image/x.png").toString(), "PNG-BYTES", "二进制逐字节保真");

    const r2 = await s.engine().runOnce();
    assert.deepEqual(
      Object.keys(r2.counts).filter((k) => k !== "noop"), [],
      `第二次不应有动作，实际 ${JSON.stringify(r2.counts)}`
    );
  } finally {
    s.cleanup();
  }
});

test("本地改动 → push，远端内容同步更新", async () => {
  const s = setup({ "a.md": "# A\n\n旧内容\n" });
  try {
    await s.engine().runOnce();
    writeFileSync(path.join(s.vault.root, "a.md"), "# A\n\n新内容\n");
    const r = await s.engine().runOnce();
    assert.equal(r.counts.push, 1, JSON.stringify(r.counts));
    assert.equal(s.store.remoteBytes("a.md").toString(), "# A\n\n新内容\n");
    assert.equal(r.errors.length, 0);
  } finally {
    s.cleanup();
  }
});

test("远端改动 → pull 覆盖本地，旧版本进回收站且不留冲突副本", async () => {
  const s = setup({ "a.md": "# A\n\n本地原文\n" });
  try {
    await s.engine().runOnce();
    s.store.editRemote("a.md", "# A\n\n远端改的\n");
    const r = await s.engine().runOnce();
    assert.equal(r.counts.pull, 1, JSON.stringify(r.counts));
    const text = readFileSync(path.join(s.vault.root, "a.md"), "utf8");
    assert.equal(text, "# A\n\n远端改的\n");
    assert.doesNotMatch(text, /note-conflict|冲突副本/);
    assert.equal(existsSync(s.opts.trashRoot), true, "被覆盖的本地版本应进回收站");
  } finally {
    s.cleanup();
  }
});

test("回写后不会形成推拉死循环", async () => {
  const s = setup({ "a.md": "# A\n\n原文\n" });
  try {
    await s.engine().runOnce();
    s.store.editRemote("a.md", "# A\n\n原文\n\n补记\n");
    await s.engine().runOnce(); // pull
    const before = s.store.calls.replace + s.store.calls.upload;
    const r = await s.engine().runOnce();
    assert.equal(s.store.calls.replace + s.store.calls.upload, before, "不应重复上传");
    assert.deepEqual(Object.keys(r.counts).filter((k) => k !== "noop"), []);
  } finally {
    s.cleanup();
  }
});

test("两端都改 → newest-wins，远端更新时远端胜出", async () => {
  const s = setup({ "a.md": "# A\n\n原文\n" });
  try {
    await s.engine().runOnce();
    s.store.editRemote("a.md", "# A\n\n原文\n\n远端赢\n");
    const full = path.join(s.vault.root, "a.md");
    writeFileSync(full, "# A\n\n原文\n\n本地输\n");
    const past = new Date(Date.now() - 60_000);
    utimesSync(full, past, past);
    const r = await s.engine().runOnce();
    assert.equal(r.counts.pull, 1, JSON.stringify(r.counts));
    assert.match(readFileSync(full, "utf8"), /远端赢/);
  } finally {
    s.cleanup();
  }
});

test("两端都改 → 本地 mtime 更新时本地胜出", async () => {
  const s = setup({ "a.md": "# A\n\n原文\n" });
  try {
    await s.engine().runOnce();
    s.store.editRemote("a.md", "# A\n\n原文\n\n远端输\n");
    const full = path.join(s.vault.root, "a.md");
    writeFileSync(full, "# A\n\n原文\n\n本地赢\n");
    const future = new Date(Date.now() + 600_000);
    utimesSync(full, future, future);
    const r = await s.engine().runOnce();
    assert.equal(r.counts.push, 1, JSON.stringify(r.counts));
    assert.match(s.store.remoteBytes("a.md").toString(), /本地赢/);
  } finally {
    s.cleanup();
  }
});

test("dry-run 不写本地、不上传、不改 state", async () => {
  const s = setup({ "a.md": "# A\n" });
  try {
    const r = await s.engine().runOnce({ dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(s.store.calls.upload, 0);
    assert.equal(s.store.calls.add, 0);
    assert.equal(Object.keys(loadState(s.opts.stateFile).entries).length, 0);
  } finally {
    s.cleanup();
  }
});

test("全库同步：不排除任何内容目录，只过滤技术噪声", async () => {
  const s = setup({
    "life/原则库.md": "# 原则\n",
    "image/p.png": "IMG",
    "学习笔记/开发工具/git.md": "# git\n",
    "学习笔记/.hidden.md": "# 隐藏\n",
    "学习笔记/x.tmp": "TMP",
    "学习笔记/a_冲突文件_beiwe.md": "# 冲突\n",
  });
  try {
    const r = await s.engine().runOnce();
    assert.equal(r.localFiles, 3, `应扫到 3 个有效文件，实际 ${r.localFiles}`);
    assert.equal(s.store.remotePaths().length, 3);
  } finally {
    s.cleanup();
  }
});

test("本地删除传播到远端，删完不会被拉回", async () => {
  const s = setup({ "a.md": "# A\n\n内容\n" });
  try {
    await s.engine().runOnce();
    rmSync(path.join(s.vault.root, "a.md"));
    const r = await s.engine().runOnce();
    assert.equal(r.counts["local-deleted"], 1, JSON.stringify(r.counts));
    assert.equal(s.store.remotePaths().includes("a.md"), false);
    assert.equal(loadState(s.opts.stateFile).entries["a.md"], undefined);

    const r2 = await s.engine().runOnce();
    assert.equal(r2.counts["create-local"] ?? 0, 0, "不能把已删条目拉回来");
    assert.equal(existsSync(path.join(s.vault.root, "a.md")), false);
  } finally {
    s.cleanup();
  }
});

test("远端新增条目 → 落到本地同路径", async () => {
  const s = setup({ "a.md": "# A\n" });
  try {
    await s.engine().runOnce();
    s.store.putRemote("学习笔记/新笔记.md", "# 新\n\n远端写的\n");
    const r = await s.engine().runOnce();
    assert.equal(r.counts["create-local"], 1, JSON.stringify(r.counts));
    const target = path.join(s.vault.root, "学习笔记/新笔记.md");
    assert.equal(existsSync(target), true);
    assert.match(readFileSync(target, "utf8"), /远端写的/);
  } finally {
    s.cleanup();
  }
});

test("远端被替换成相同内容时只刷新基线，不覆盖本地", async () => {
  const s = setup({ "a.md": "# A\n\n内容\n" });
  try {
    await s.engine().runOnce();
    s.store.editRemote("a.md", "# A\n\n内容\n");
    const r = await s.engine().runOnce();
    assert.equal(r.counts.pull ?? 0, 0, JSON.stringify(r.counts));
    const action = r.actions.find((a) => a.path === "a.md");
    assert.match(action.reason ?? "", /remote-touched-only/);
  } finally {
    s.cleanup();
  }
});

test("ima 里手写的笔记 → 落下本地 inbox，且不会被推回去", async () => {
  const s = setup({ "a.md": "# A\n" });
  try {
    await s.engine().runOnce(); // 第一轮建立 inbox 基线
    s.store.putNote({
      noteId: "7524000000000001",
      title: "手机随手记",
      content: "# 随手记\n\n在 ima App 里写的\n",
    });
    const r = await s.engine().runOnce();
    const hit = r.actions.find((a) => a.decision === "note-inbox");
    assert.ok(hit, JSON.stringify(r.counts));
    const target = path.join(s.vault.root, "ima-inbox/手机随手记.md");
    assert.equal(existsSync(target), true);
    assert.match(readFileSync(target, "utf8"), /在 ima App 里写的/);

    const uploadsBefore = s.store.calls.upload;
    await s.engine().runOnce();
    assert.equal(s.store.calls.upload, uploadsBefore, "inbox 文件不应推回 ima");
    assert.equal(s.store.remotePaths().some((p) => p.startsWith("ima-inbox/")), false);
  } finally {
    s.cleanup();
  }
});

test("本地新建目录会在远端逐级补出来", async () => {
  const s = setup({ "a/深/层/x.md": "# x\n" });
  try {
    await s.engine().runOnce();
    assert.deepEqual([...s.store.dirs.keys()].sort(), ["", "a", "a/深", "a/深/层"]);
  } finally {
    s.cleanup();
  }
});

test("HTTP 层：鉴权头、分页、限频退避、业务错误码", async () => {
  const server = await startMockHttpServer();
  try {
    const creds = { clientId: "cid-test", apiKey: "key-test" };
    const res = await rawCall("openapi/note/v1/list_notebook", { cursor: "0", limit: 1 }, creds,
      { baseUrl: server.url });
    assert.equal(res.httpStatus, 200);
    assert.equal(res.code, 0);
    const recorded = server.state.requests.at(-1);
    assert.equal(recorded.clientId, "cid-test");
    assert.equal(recorded.apiKey, "key-test");

    for (let i = 0; i < 5; i++) {
      await rawCall("openapi/note/v1/import_doc",
        { content: `# N${i}\n`, content_format: 1 }, creds, { baseUrl: server.url });
    }
    setBaseUrl(server.url);
    const client = new ImaClient(creds);
    const notes = await client.allNotes({ folderId: "", limit: 2, maxPages: 10 });
    // 每页上限被 server 压到 2，验证分页游标能拉全
    assert.equal(notes.length, 5, `分页应拿到 5 条，实际 ${notes.length}`);
    setBaseUrl(undefined);

    // 禁止重试时能观察到限频码；默认重试 3 次则应自动退避并恢复。
    server.state.rateLimitOnce = 1;
    const limited = await rawCall("openapi/note/v1/list_note_by_folder_id",
      { folder_id: "", cursor: "", limit: 2 }, creds, { baseUrl: server.url, retries: 1 });
    assert.equal(limited.code, 200001);
    server.state.rateLimitOnce = 1;
    const recovered = await rawCall("openapi/note/v1/list_note_by_folder_id",
      { folder_id: "", cursor: "", limit: 2 }, creds, { baseUrl: server.url, retries: 3 });
    assert.equal(recovered.code, 0, "限频应被退避重试吸收");

    const unknown = await rawCall("openapi/note/v1/does_not_exist", {}, creds,
      { baseUrl: server.url });
    assert.equal(unknown.code, 99999);
  } finally {
    await server.close();
  }
});
