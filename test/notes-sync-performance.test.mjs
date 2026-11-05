// 性能测试：真实 vault 全库扫描、决策热路径、state 大表、引擎单轮吞吐。
// 阈值刻意放宽，只在出现数量级退化时失败；实测数值直接打印便于复核。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { scanVault } from "../src/notes-sync/vault.mjs";
import { decide, Decision } from "../src/notes-sync/reconcile.mjs";
import { emptyState, putRecord, saveState, loadState } from "../src/notes-sync/state.mjs";
import { SyncEngine } from "../src/notes-sync/engine.mjs";
import { loadConfig } from "../src/notes-sync/config.mjs";
import { MockImaClient, makeTempVault, makeEngineOpts } from "./helpers/mock-ima.mjs";

function pctl(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function ms(fn) {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

test("真实 vault 全库扫描（不做目录排除）", () => {
  const config = loadConfig();
  if (!statSync(config.vaultRoot, { throwIfNoEntry: false })) {
    assert.ok(true, "vault 不存在，跳过真实数据扫描");
    return;
  }
  const samples = [];
  let last;
  for (let i = 0; i < 3; i++) {
    const r = ms(() => scanVault(config.vaultRoot, config));
    samples.push(r.ms);
    last = r.value;
  }
  const median = pctl(samples, 0.5);
  console.log(`    [真实库] ${last.length} 文件 / ${(last.reduce((n, f) => n + f.size, 0) / 1024 / 1024).toFixed(1)}MB，扫描 p50 ${median.toFixed(1)}ms`);
  assert.ok(median < 15000, `全库扫描退化: ${median.toFixed(1)}ms`);
});

test("1000 文件合成库：冷扫描与内容缓存加速", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "notes-perf-"));
  try {
    for (let i = 0; i < 1000; i++) {
      const dir = path.join(root, `d${i % 20}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `n${i}.md`), `# ${i}\n\n${"内容".repeat(30)}\n`);
    }
    const opts = { excludes: [], maxFileBytes: 90 * 1024 * 1024 };
    const cache = new Map();
    const cold = ms(() => scanVault(root, { ...opts, contentCache: cache }));
    const samples = [];
    for (let i = 0; i < 5; i++) {
      samples.push(ms(() => scanVault(root, { ...opts, contentCache: cache })).ms);
    }
    const median = pctl(samples, 0.5);
    console.log(`    [合成库] 1000 文件冷扫描 ${cold.ms.toFixed(1)}ms / 缓存命中 p50 ${median.toFixed(1)}ms（加速 ${(cold.ms / median).toFixed(0)}×）`);
    assert.equal(cache.size, 1000);
    // 冷扫描受沙箱 readFileSync 约 6.5ms/次限制，只防止数量级退化。
    assert.ok(cold.ms < 15000, `冷扫描退化: ${cold.ms.toFixed(1)}ms`);
    assert.ok(median < 500, `缓存命中路径退化: ${median.toFixed(1)}ms`);

    // 文件内容变化后缓存必须失效并重新读盘
    const target = path.join(root, "d0", "n0.md");
    writeFileSync(target, "# 0\n\n改动过了\n");
    const after = scanVault(root, { ...opts, contentCache: cache });
    assert.match(after.find((f) => f.path === "d0/n0.md").content, /改动过了/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("三方比对热路径 10 万次", () => {
  const input = {
    localExists: true, localHash: "L", remoteExists: true, remoteHash: "B",
    baseHash: "B", baseLocalHash: "B", baseRemoteHash: "B", hadRecord: true,
  };
  const r = ms(() => {
    let n = 0;
    for (let i = 0; i < 100_000; i++) {
      if (decide(input) === Decision.PUSH) n += 1;
    }
    return n;
  });
  console.log(`    [决策] 10 万次 ${r.ms.toFixed(1)}ms (${(100000 / r.ms * 1000).toFixed(0)} 次/秒)`);
  assert.equal(r.value, 100_000);
  assert.ok(r.ms < 5000, `决策热路径退化: ${r.ms.toFixed(1)}ms`);
});

test("state 1000 条记录读写", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "notes-perf-state-"));
  const file = path.join(dir, "state.json");
  try {
    const state = emptyState();
    for (let i = 0; i < 1000; i++) {
      putRecord(state, `学习笔记/d${i % 20}/n${i}.md`, {
        title: `n${i}`, noteId: `nt_${i}`, mediaId: `md_${i}`,
        baseLocalHash: "a".repeat(64), baseRemoteHash: "b".repeat(64),
        remoteModifyTime: 1700000000000 + i, lastSyncAt: 1700000000000 + i,
      });
    }
    const write = ms(() => saveState(state, file));
    const read = ms(() => loadState(file));
    console.log(`    [state] 写 ${write.ms.toFixed(1)}ms / 读 ${read.ms.toFixed(1)}ms / 1000 条`);
    assert.equal(Object.keys(read.value.entries).length, 1000);
    assert.ok(write.ms < 2000 && read.ms < 2000, "state 读写退化");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("引擎单轮吞吐：200 文件全量推送", async () => {
  const files = {};
  for (let i = 0; i < 200; i++) files[`学习笔记/d${i % 10}/n${i}.md`] = `# N${i}\n\n内容 ${i}\n`;
  const client = new MockImaClient();
  const vault = makeTempVault(files);
  const { opts, cleanup } = makeEngineOpts(client, vault);
  try {
    const t0 = performance.now();
    const r = await new SyncEngine(opts).runOnce();
    const elapsed = performance.now() - t0;
    console.log(`    [引擎] 200 文件首轮 ${elapsed.toFixed(1)}ms，错误 ${r.errors.length}`);
    assert.equal(r.errors.length, 0);
    assert.equal((r.counts["create-remote"] ?? 0), 200);
    assert.ok(elapsed < 15000, `单轮吞吐退化: ${elapsed.toFixed(1)}ms`);
  } finally {
    cleanup();
    vault.cleanup();
  }
});
