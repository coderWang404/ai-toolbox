// 常驻同步循环：复用同一个引擎实例，跨轮共享 contentCache，
// 稳态下每轮只有一次远端列举 + 本地目录 stat，不重复读盘。
import { SyncEngine } from "./engine.mjs";
import { loadSession } from "./cgi.mjs";
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
    this._warnedTokenExpiry = 0;
  }

  stop() { this.stopped = true; }

  /**
   * 小票（IMA-TOKEN，2 小时）可以靠 refresh 无限续；
   * 大票（refreshToken，30 天）实测 refresh 接口不回新的，只能靠重新登录。
   * 到期前 7 天开始每天提醒一次，避免某天突然同步不动还不知道原因。
   */
  checkRefreshExpiry() {
    try {
      const session = loadSession();
      const leftMs = Number(session.refreshTokenExpiredTime ?? 0) - Date.now();
      if (!leftMs || leftMs > 7 * 86400_000) return;
      if (Date.now() - this._warnedTokenExpiry < 86400_000) return;
      this._warnedTokenExpiry = Date.now();
      this.log(`⚠ 网页登录态大票还剩 ${(leftMs / 86400_000).toFixed(1)} 天，到期后需重新扫码登录一次 ima 网页端`);
    } catch {
      // 登录态文件缺失/损坏时由请求路径自己报错，这里不额外抛
    }
  }

  async tick() {
    this.checkRefreshExpiry();
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
