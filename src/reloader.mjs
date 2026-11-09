// 发现并优雅重启 Codex app-server 进程（不重启整个应用）。
import { execFileSync } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function psSnapshot() {
  const out = execFileSync("ps", ["-eo", "pid,ppid,tty,stat,command"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const rows = [];
  for (const line of out.split("\n").slice(1)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      tty: m[3],
      stat: m[4],
      command: m[5],
    });
  }
  return rows;
}

/**
 * 判断 app-server 真正属于谁：看父进程链，而不是只看 codex 命令行。
 * 同一个 ChatGPT.app 里的 codex 二进制可能被别的应用（DeepSeek Harness、Trae…）
 * 或 SSH 远程会话拉起，误杀它们会让「切换后新配置不生效」。
 */
export function attributeOwner(row, byPid) {
  let cur = byPid.get(row.ppid);
  const hasParentInfo = cur != null;
  for (let depth = 0; depth < 4 && cur; depth++) {
    const cmd = cur.command;
    if (/ChatGPT\.app\/Contents\/MacOS\/ChatGPT(\s|$)/.test(cmd)) return "chatgpt";
    if (/(^|\/)ssh\s/.test(cmd)) return "remote";
    if (cmd.includes("/.trae-cn/")) return "trae";
    if (cmd.includes("WorkBuddy")) return "workbuddy";
    cur = byPid.get(cur.ppid);
  }
  // 父进程链查得到但都不是已知宿主：说明是被其它程序拉起的，不要算成 ChatGPT。
  if (hasParentInfo) return "other";
  // 只有完全拿不到父进程信息时，才回退到命令行特征。
  const cmd = row.command;
  if (cmd.includes("/Applications/ChatGPT.app/")) return "chatgpt";
  if (cmd.includes("/.trae-cn/")) return "trae";
  if (cmd.includes("WorkBuddy")) return "workbuddy";
  return "other";
}

export function classifyProcess(row, byPid) {
  const cmd = row.command;
  const tokens = cmd.split(/\s+/);
  // ssh 客户端命令行里也会出现 `codex app-server`（远程要执行的命令），别把它当成 app-server。
  const executable = tokens[0] ?? "";
  if (/(^|\/)(ssh|scp|sftp)$/.test(executable)) return null;
  // 兼容两种启动方式：直接执行 codex，或 node /path/to/codex.js。
  const codexIndex = tokens.findIndex((token) => /(^|\/)codex(\.js)?$/.test(token));
  if (codexIndex === -1) return null;

  const args = tokens.slice(codexIndex + 1);
  const isAppServer = args.includes("app-server") && !args.includes("proxy");
  // 真实参数是 `--listen unix:///path`，不能只匹配裸的 `unix://`。
  const isDaemonUnix = isAppServer && args.some((arg) => arg.startsWith("unix://"));

  if (isAppServer) {
    return {
      kind: isDaemonUnix ? "app-server-daemon" : "app-server",
      owner: attributeOwner(row, byPid),
    };
  }

  // 终端里的 TUI 会话（无 app-server 子参数，挂载在 tty 上）
  if (row.tty !== "??" && row.tty !== "-") {
    return { kind: "tui" };
  }
  return null;
}

/** 判断 app-server 是否为顶层实例（非 CUA/node_repl 的会话内实例）。 */
function isTopLevel(pid, byPid) {
  let cur = byPid.get(pid);
  for (let depth = 0; depth < 4 && cur; depth++) {
    if (
      /node_repl|cua_node|kernel\.js|trusted-worker|codex-code-mode-host/.test(cur.command)
    ) {
      return false;
    }
    cur = byPid.get(cur.ppid);
  }
  return true;
}

/**
 * 找出本地 codex 进程。
 * @returns {{appServers: Array, tuis: Array}}
 */
export function discoverCodexProcesses() {
  const rows = psSnapshot();
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const appServers = [];
  const tuis = [];
  for (const row of rows) {
    const c = classifyProcess(row, byPid);
    if (!c) continue;
    const entry = {
      pid: row.pid,
      ppid: row.ppid,
      tty: row.tty,
      command: row.command,
      topLevel: c.kind === "app-server" ? isTopLevel(row.pid, byPid) : true,
      ...c,
    };
    if (c.kind === "tui") tuis.push(entry);
    else appServers.push(entry);
  }
  return { appServers, tuis };
}

function isAlive(pid) {
  try {
    const out = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
    if (!out) return false;
    return !out.startsWith("Z"); // 僵尸进程视为已退出
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(150);
  }
  return !isAlive(pid);
}

/**
 * 平滑终止一个 app-server：SIGTERM →（超时后）SIGKILL。
 * @returns {Promise<{pid:number, outcome:'terminated'|'killed'|'gone'}>}
 */
export async function terminateAppServer(pid, { drainTimeoutMs = 8000, log = console.log } = {}) {
  if (!isAlive(pid)) return { pid, outcome: "gone" };
  log(`  → 发送 SIGTERM 给 app-server (pid ${pid})，等待平滑退出...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if (err.code === "ESRCH") return { pid, outcome: "gone" };
    throw err;
  }
  if (await waitForExit(pid, drainTimeoutMs)) {
    return { pid, outcome: "terminated" };
  }
  log(`  → 平滑退出超时（可能有任务在运行），发送 SIGKILL`);
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if (err.code === "ESRCH") return { pid, outcome: "terminated" };
    throw err;
  }
  await waitForExit(pid, 3000);
  return { pid, outcome: "killed" };
}

/** 按 scope 选择要重启的 app-server。 */
export function selectTargets(appServers, scope) {
  switch (scope) {
    case "all":
      return appServers;
    case "chatgpt-all":
      return appServers.filter((p) => p.owner === "chatgpt");
    case "chatgpt":
    default:
      return appServers.filter((p) => p.owner === "chatgpt" && p.topLevel);
  }
}

/**
 * 重启所有匹配的 app-server。
 * @param {{scope:'chatgpt'|'all', drainTimeoutMs:number, dryRun:boolean, hard:boolean, log:Function}} opts
 */
export async function reloadAppServers({
  scope = "chatgpt",
  drainTimeoutMs = 8000,
  dryRun = false,
  hard = false,
  log = console.log,
} = {}) {
  const { appServers, tuis } = discoverCodexProcesses();
  const targets = selectTargets(appServers, scope);
  const result = { targets, others: appServers.filter((p) => !targets.includes(p)), tuis, outcomes: [] };

  if (!targets.length) {
    return result;
  }
  if (dryRun) return result;

  for (const t of targets) {
    const outcome = hard
      ? await killAppServer(t.pid, log)
      : await terminateAppServer(t.pid, { drainTimeoutMs, log });
    result.outcomes.push({ ...t, ...outcome });
  }
  return result;
}

/** 直接 SIGKILL：界面会显示恢复页，点一次「Restart ChatGPT」即恢复。 */
async function killAppServer(pid, log = console.log) {
  if (!isAlive(pid)) return { pid, outcome: "gone" };
  log(`  → 直接强制结束 app-server (pid ${pid})`);
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if (err.code === "ESRCH") return { pid, outcome: "gone" };
    throw err;
  }
  await waitForExit(pid, 3000);
  return { pid, outcome: "killed" };
}

/**
 * 等待应用自动拉起新的 app-server（用户下次交互时触发）。
 * @returns {Promise<{pid:number}|null>}
 */
export async function waitForRespawn(knownPids = [], { timeoutMs = 12000, scope = "chatgpt" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { appServers } = discoverCodexProcesses();
    const fresh = selectTargets(appServers, scope).find((p) => !knownPids.includes(p.pid));
    if (fresh) return fresh;
    await sleep(400);
  }
  return null;
}
