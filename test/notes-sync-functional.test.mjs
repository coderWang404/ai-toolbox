// 功能测试：本地 mock IMA 跑通同步引擎全链路 + 真实 HTTP mock 验证 API 层。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import path from "node:path";
import { SyncEngine } from "../src/notes-sync/engine.mjs";
import { ImaClient, rawCall, setBaseUrl } from "../src/notes-sync/ima-api.mjs";
import { loadState } from "../src/notes-sync/state.mjs";
import {
  MockImaClient, startMockHttpServer, makeTempVault, makeEngineOpts, TEST_KB,
} from "./helpers/mock-ima.mjs";

function setup(files = {}, overrides = {}) {
  const client = new MockImaClient();
  const vault = makeTempVault(files);
  const { opts, cleanup } = makeEngineOpts(client, vault, overrides);
  return {
    client, vault, opts,
    engine: () => new SyncEngine(opts),
    cleanup: () => { cleanup(); vault.cleanup(); },
  };
}

test("首次同步全库、第二次完全幂等（life/ 与 image/ 不再被排除）", async () => {
  const s = setup({
    "学习笔记/a.md": "# A\n\n内容 A\n",
    "life/原则库.md": "# 原则\n\n私密内容\n",
    "image/x.png": "PNG-BYTES",
  });
  try {
    const r1 = await s.engine().runOnce();
    assert.equal(r1.counts["create-remote"], 2);
    assert.equal(r1.counts.push, 1, "二进制走 push");
    assert.equal(r1.errors.length, 0);
    assert.equal(s.client.kb.size, 3);
    assert.equal(s.client.notes.size, 2);
    assert.equal(s.client.uploads.size, 1, "图片已上传");

    const r2 = await s.engine().runOnce();
    const active = Object.keys(r2.counts).filter((k) => k !== "noop");
    assert.deepEqual(active, [], `第二次不应有动作，实际 ${JSON.stringify(r2.counts)}`);
    assert.equal(r2.errors.length, 0);
  } finally {
    s.cleanup();
  }
});

test("本地改动 → push，ima 侧内容同步更新", async () => {
  const s = setup({ "a.md": "# A\n\n旧内容\n" });
  try {
    await s.engine().runOnce();
    writeFileSync(path.join(s.vault.root, "a.md"), "# A\n\n新内容\n");
    const r = await s.engine().runOnce();
    assert.equal(r.counts.push, 1);
    const newRec = loadState(s.opts.stateFile).entries["a.md"];
    assert.match(s.client.notes.get(newRec.noteId).content, /新内容/);
    assert.equal(r.errors.length, 0);
  } finally {
    s.cleanup();
  }
});

test("ima 里编辑 → 回写本地，原文不丢、只追加补记块", async () => {
  const s = setup({ "a.md": "# A\n\n本地原文\n" });
  try {
    await s.engine().runOnce();
    const rec = loadState(s.opts.stateFile).entries["a.md"];
    s.client.editInIma(rec.noteId, "# A\n\n本地原文\n\n在 ima 里补的一行\n");
    const r = await s.engine().runOnce();
    assert.equal(r.counts.pull, 1, JSON.stringify(r.counts));
    const text = readFileSync(path.join(s.vault.root, "a.md"), "utf8");
    assert.match(text, /本地原文/);
    assert.match(text, /## ima 补记/);
    assert.match(text, /在 ima 里补的一行/);
    assert.equal(r.actions.find((a) => a.decision === "pull").addedLines > 0, true);
  } finally {
    s.cleanup();
  }
});

test("回写后不会形成推拉死循环（canonicalHash 不漂移）", async () => {
  const s = setup({ "a.md": "# A\n\n原文\n" });
  try {
    await s.engine().runOnce();
    const rec = loadState(s.opts.stateFile).entries["a.md"];
    s.client.editInIma(rec.noteId, "# A\n\n原文\n\n补记\n");
    await s.engine().runOnce(); // pull
    const callsBefore = s.client.calls.importDoc;
    const r = await s.engine().runOnce();
    assert.equal(s.client.calls.importDoc, callsBefore, "不应重复推送");
    assert.deepEqual(Object.keys(r.counts).filter((k) => k !== "noop"), []);
  } finally {
    s.cleanup();
  }
});

test("两端都改 → newest-wins，不生成任何冲突副本", async () => {
  const s = setup({ "a.md": "# A\n\n原文\n" });
  try {
    await s.engine().runOnce();
    const rec = loadState(s.opts.stateFile).entries["a.md"];
    s.client.editInIma(rec.noteId, "# A\n\n原文\n\n远端赢\n");
    // 本地 mtime 明确设为更早，远端应胜出
    const full = path.join(s.vault.root, "a.md");
    writeFileSync(full, "# A\n\n原文\n\n本地输\n");
    const past = new Date(Date.now() - 60_000);
    utimesSync(full, past, past); // 本地明确更旧，远端应胜出
    const r = await s.engine().runOnce();
    assert.ok(r.counts.pull >= 1, `期望远端胜出，实际 ${JSON.stringify(r.counts)}`);
    const text = readFileSync(full, "utf8");
    assert.doesNotMatch(text, /note-conflict|冲突副本/);
    assert.match(text, /远端赢/);
    assert.equal(existsSync(path.join(s.vault.root, "a (note-conflict 2026-01-01 000000).md")), false);
  } finally {
    s.cleanup();
  }
});

test("ima 里新建的笔记 → 落到 inbox，并登记映射", async () => {
  const s = setup({ "a.md": "# A\n" });
  try {
    await s.engine().runOnce();
    const data = await s.client.importDoc("# 手机随手记\n\n在 ima App 里写的\n");
    const added = await s.client.addKnowledge({ noteId: data.note_id, title: "手机随手记" });
    assert.ok(added.media_id);
    const r = await s.engine().runOnce();
    assert.equal(r.counts["create-local"], 1, JSON.stringify(r.counts));
    const target = path.join(s.vault.root, "ima-inbox", "手机随手记.md");
    assert.equal(existsSync(target), true);
    assert.match(readFileSync(target, "utf8"), /在 ima App 里写的/);
  } finally {
    s.cleanup();
  }
});

test("dry-run 不写本地、不写 ima、不改 state", async () => {
  const s = setup({ "a.md": "# A\n" });
  try {
    const r = await s.engine().runOnce({ dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(s.client.calls.importDoc, 0);
    assert.equal(s.client.calls.addKnowledge, 0);
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
    assert.equal(s.client.kb.size, 3);
  } finally {
    s.cleanup();
  }
});

test("本地删除传播到 ima 回收站，且不会被当成 ima 新笔记拉回", async () => {
  const s = setup({ "a.md": "# A\n\n内容\n" }, { config: { recycleFolderId: "folder_recycle" } });
  try {
    await s.engine().runOnce();
    rmSync(path.join(s.vault.root, "a.md"));
    const r = await s.engine().runOnce();
    assert.equal(r.counts["local-deleted"], 1, JSON.stringify(r.counts));
    assert.equal(s.client.calls.moveKnowledge, 1, "应把条目移进回收站");
    assert.equal(loadState(s.opts.stateFile).entries["a.md"].deleted, true);

    const r2 = await s.engine().runOnce();
    assert.equal(r2.counts["create-local"] ?? 0, 0, "不能把已删的 note 拉回来");
    assert.equal(existsSync(path.join(s.vault.root, "a.md")), false);
    assert.equal(s.client.calls.moveKnowledge, 1, "墓碑生效，不重复移动");
  } finally {
    s.cleanup();
  }
});

test("未配置回收站文件夹时，删除只报告、不误动云端", async () => {
  const s = setup({ "a.md": "# A\n" });
  try {
    await s.engine().runOnce();
    rmSync(path.join(s.vault.root, "a.md"));
    const r = await s.engine().runOnce();
    const action = r.actions.find((a) => a.decision === "local-deleted");
    assert.ok(action, JSON.stringify(r.counts));
    assert.match(action.reason, /未配置回收站文件夹/);
    assert.equal(s.client.calls.moveKnowledge, 0);
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
