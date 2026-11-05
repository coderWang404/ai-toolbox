// 常驻同步循环：复用同一个引擎实例，跨轮共享 contentCache，
// 稳态下每轮只有一次远端列举 + 本地目录 stat，不重复读盘。
import { SyncEngine } from "./engine.mjs";
import { loadConfig } from "./config.mjs";
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function defaultLogFile() {
  return path.join(os.homedir(), "Library", "Logs", "notes-sync.log");
}

export function fileLogger(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  return (line) => {
    const stamp = new Date().toISOString();
    appendFileSync(file, `time=${stamp} ${line}\n`);
  };
}

export class SyncDaemon {
  constructor({ config = loadConfig(), intervalMs, log, store, stateFile, vaultRoot } = {}) {
    this.config = config;
    this.intervalMs = intervalMs ?? config.remotePollMs ?? 10_000;
    this.log = log ?? (() => {});
    this.contentCache = new Map();
    this.engine = new SyncEngine({
      config, store, stateFile, vaultRoot, contentCache: this.contentCache, log: this.log,
    });
    this.stopped = false;
    this.rounds = 0;
  }

  stop() { this.stopped = true; }

  async tick() {
    const r = await this.engine.runOnce();
    this.rounds += 1;
    const active = Object.entries(r.counts).filter(([k]) => k !== "noop");
    if (active.length || r.errors.length) {
      this.log(
        `round=${this.rounds} actions=${JSON.stringify(Object.fromEntries(active))} ` +
        `errors=${r.errors.length} local=${r.localFiles} remote=${r.remoteFiles}`
      );
      for (const e of r.errors.slice(0, 5)) this.log(`  ✗ ${e.path}: ${e.message}`);
    }
    return r;
  }

  /** @param {{once?:boolean}} opts once=true 时只跑一轮（供测试与手动触发）。 */
  async start({ once = false } = {}) {
    do {
      const t0 = Date.now();
      try {
        await this.tick();
      } catch (err) {
        this.log(`round failed: ${err.message}`);
      }
      if (once || this.stopped) break;
      await sleep(Math.max(0, this.intervalMs - (Date.now() - t0)));
    } while (!this.stopped);
  }
}
