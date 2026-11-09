// Codex 桌面端「项目 / 会话归属」状态保护。
//
// 背景：从 Codex 桌面版 0.157 起，渲染进程把项目列表（local-projects）、
// 会话→项目归属（thread-project-assignments）、项目排序等全局键按 ChatGPT
// 账号隔离，存在 `electron-account-renderer-state-v1` 的 owner/inactive 桶里。
// 一旦账号身份变成「未登录」或换成另一个账号（切换第三方供应商、auth 过期、
// cc-switch 改写 auth.json 都会触发），selectRendererOwner 会把当前账号的
// 全局键从活动状态删除并塞进 inactive[旧 hash]，界面上就表现为「项目全没了，
// 只剩对话」。数据其实还在，只是被寄存了。
//
// 本模块负责：在切换供应商前后快照 + 把寄存的项目状态恢复到活动状态。
// 恢复时直接删掉 electron-account-renderer-state-v1 并保留顶层全局键：
// 该键缺失时桌面端 selectRendererOwner 会直接 return，不再按账号删键，
// 项目因此对任何账号 / 未登录状态都可见。

import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { codexHome, dataDir } from "./paths.mjs";

export const STATE_FILE_NAME = ".codex-global-state.json";
export const ACCOUNT_STATE_KEY = "electron-account-renderer-state-v1";
export const ATOM_STATE_KEY = "electron-persisted-atom-state";
export const LOCAL_PROJECTS_KEY = "local-projects";
export const PROJECT_ORDER_KEY = "project-order";
export const ASSIGNMENTS_KEY = "thread-project-assignments";
export const PROJECT_ID_MAP_KEY = "app-server-project-id-by-legacy-project-id-by-host";

const SNAPSHOT_DIR_NAME = "codex-project-state";
const SNAPSHOT_KEEP = 10;

export function statePath(home = codexHome()) {
  return path.join(home, STATE_FILE_NAME);
}

export function snapshotDir() {
  return path.join(dataDir(), SNAPSHOT_DIR_NAME);
}

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${p(d.getMilliseconds(), 3)}`;
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** 读桌面端全局状态。文件不存在或损坏时返回 null。 */
export function readState(filePath = statePath()) {
  return readJson(filePath);
}

/** 原子写入：同目录临时文件 + rename；同时刷新 .bak，保持与桌面端一致。 */
export function writeState(state, filePath = statePath()) {
  const text = JSON.stringify(state);
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, filePath);
  const bak = `${filePath}.bak`;
  try {
    writeFileSync(bak, text, { mode: 0o644 });
  } catch {
    /* 备份失败不影响主文件 */
  }
  return filePath;
}

/** Codex 桌面端是否在运行（运行中写全局状态会被它下一次 flush 覆盖）。 */
export function isCodexDesktopRunning() {
  const override = process.env.AI_TOOLBOX_FAKE_CODEX_RUNNING;
  if (override === "1") return true;
  if (override === "0") return false;
  try {
    execFileSync("pgrep", ["-f", "ChatGPT.app/Contents/MacOS/ChatGPT"], { stdio: "ignore" });
    return true;
  } catch {
    try {
      execFileSync("pgrep", ["-f", "Codex.app/Contents/MacOS/Codex"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

function countKeys(obj) {
  return obj && typeof obj === "object" && !Array.isArray(obj) ? Object.keys(obj).length : 0;
}

function statsOf(globals) {
  return {
    projects: countKeys(globals?.[LOCAL_PROJECTS_KEY]),
    assignments: countKeys(globals?.[ASSIGNMENTS_KEY]),
  };
}

export function activeProjectStats(state) {
  return statsOf(state ?? {});
}

/**
 * 列出所有被寄存的账号状态桶。
 * @returns {Array<{id:string, atoms:object, globals:object, projects:number, assignments:number}>}
 */
export function collectProjectSnapshots(state) {
  const account = state?.[ACCOUNT_STATE_KEY];
  const inactive = account && typeof account === "object" ? account.inactive : null;
  if (!inactive || typeof inactive !== "object") return [];
  return Object.entries(inactive)
    .map(([id, bucket]) => ({
      id,
      owner: account.owner ?? null,
      atoms: bucket?.atoms ?? {},
      globals: bucket?.globals ?? {},
      ...statsOf(bucket?.globals),
    }))
    .sort((a, b) => b.projects - a.projects || b.assignments - a.assignments);
}

/** 给 CLI / App 用的状态摘要。 */
export function projectStateReport(state = readState()) {
  if (!state) {
    return { ok: false, error: "找不到 Codex 全局状态文件", stateFile: statePath() };
  }
  return {
    ok: true,
    stateFile: statePath(),
    codexRunning: isCodexDesktopRunning(),
    accountScoped: state[ACCOUNT_STATE_KEY] != null,
    active: activeProjectStats(state),
    snapshots: collectProjectSnapshots(state).map(({ id, owner, projects, assignments }) => ({
      id,
      owner,
      projects,
      assignments,
    })),
    ...planProjectStateRepair(state),
  };
}

function normalizeRoots(project) {
  const roots = Array.isArray(project?.rootPaths) ? project.rootPaths : [];
  return roots
    .map((p) => path.resolve(String(p)).replace(/\/+$/, ""))
    .sort()
    .join("\u0000");
}

/**
 * 把「活动状态里的项目」和「寄存快照里的项目」合并：
 * 同一目录（rootPaths 完全一致）只保留快照里的那个，避免恢复后出现重复项目。
 */
function mergeLocalProjects(snapshotProjects, activeProjects, snapshotOrder, activeOrder) {
  const merged = { ...(snapshotProjects ?? {}) };
  const seen = new Map();
  for (const [id, project] of Object.entries(merged)) {
    const key = normalizeRoots(project) || `id:${id}`;
    if (!seen.has(key)) seen.set(key, id);
  }
  const droppedProjectIds = new Set();
  for (const [id, project] of Object.entries(activeProjects ?? {})) {
    if (merged[id]) continue;
    const key = normalizeRoots(project) || `id:${id}`;
    if (seen.has(key)) {
      droppedProjectIds.add(id);
      continue;
    }
    seen.set(key, id);
    merged[id] = project;
  }

  const order = [];
  const push = (id) => {
    if (merged[id] && !order.includes(id)) order.push(id);
  };
  for (const id of snapshotOrder ?? []) push(id);
  for (const id of activeOrder ?? []) push(id);
  for (const id of Object.keys(merged)) push(id);

  return { localProjects: merged, projectOrder: order, droppedProjectIds };
}

/**
 * 计算修复方案（纯函数，不改 state）。
 * @returns {{needsRepair:boolean, reason:string, source?:object, target?:object, droppedProjectIds?:string[]}}
 */
export function planProjectStateRepair(state) {
  if (!state) return { needsRepair: false, reason: "no-state" };
  const active = activeProjectStats(state);
  const snapshots = collectProjectSnapshots(state);
  const best = snapshots.find((s) => s.projects > 0) ?? null;
  if (!best) {
    return {
      needsRepair: false,
      reason: active.projects > 0 ? "healthy" : "no-snapshot",
      active,
    };
  }
  if (active.projects >= best.projects) {
    return {
      needsRepair: false,
      reason: "healthy",
      active,
      best: { id: best.id, projects: best.projects, assignments: best.assignments },
    };
  }
  return {
    needsRepair: true,
    reason: "projects-parked",
    active,
    source: { id: best.id, projects: best.projects, assignments: best.assignments },
  };
}

/**
 * 应用修复：把寄存快照写回顶层全局键，合并 atoms，并移除账号隔离层。
 * @returns {{state:object, restored:{projects:number, assignments:number}, droppedProjectIds:string}}
 */
export function applyProjectStateRepair(state, plan) {
  const snapshots = collectProjectSnapshots(state);
  const best = plan?.source ? snapshots.find((s) => s.id === plan.source.id) : snapshots[0];
  if (!best) throw new Error("没有可恢复的项目快照");

  const merged = mergeLocalProjects(
    best.globals?.[LOCAL_PROJECTS_KEY],
    state[LOCAL_PROJECTS_KEY],
    best.globals?.[PROJECT_ORDER_KEY],
    state[PROJECT_ORDER_KEY],
  );

  for (const [key, value] of Object.entries(best.globals ?? {})) {
    state[key] = structuredClone(value);
  }
  state[LOCAL_PROJECTS_KEY] = merged.localProjects;
  state[PROJECT_ORDER_KEY] = merged.projectOrder;

  // 被合并掉的重复项目：清掉它在 id 映射和归属里的残留
  if (merged.droppedProjectIds.size > 0) {
    const map = state[PROJECT_ID_MAP_KEY];
    if (map && typeof map === "object") {
      for (const hostMap of Object.values(map)) {
        if (!hostMap || typeof hostMap !== "object") continue;
        for (const id of merged.droppedProjectIds) delete hostMap[id];
      }
    }
    const assignments = state[ASSIGNMENTS_KEY];
    if (assignments && typeof assignments === "object") {
      for (const [threadId, assignment] of Object.entries(assignments)) {
        if (assignment?.projectKind === "local" && merged.droppedProjectIds.has(assignment.projectId)) {
          delete assignments[threadId];
        }
      }
    }
  }

  const atoms = { ...(state[ATOM_STATE_KEY] ?? {}) };
  for (const [key, value] of Object.entries(best.atoms ?? {})) {
    atoms[key] = structuredClone(value);
  }
  state[ATOM_STATE_KEY] = atoms;

  // 关键：移除账号隔离层，桌面端 selectRendererOwner 会直接返回，
  // 顶层项目状态不再被按账号搬走 / 删除。
  delete state[ACCOUNT_STATE_KEY];

  return {
    state,
    restored: statsOf(state),
    droppedProjectIds: [...merged.droppedProjectIds],
  };
}

/** 把当前状态整份存到本地快照目录（防止桌面端把寄存桶也覆盖掉）。 */
export function saveStateSnapshot({ state = readState(), reason = "manual" } = {}) {
  if (!state) return null;
  const dir = snapshotDir();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `snapshot-${timestamp()}-${reason}.json`);
  writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), reason, state }), { mode: 0o600 });
  try {
    writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ savedAt: new Date().toISOString(), reason, state }), {
      mode: 0o600,
    });
  } catch {
    /* 忽略 */
  }
  pruneSnapshots();
  return file;
}

function pruneSnapshots() {
  try {
    const dir = snapshotDir();
    const files = readdirSync(dir)
      .filter((name) => name.startsWith("snapshot-") && name.endsWith(".json"))
      .map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(SNAPSHOT_KEEP)) {
      try {
        unlinkSync(path.join(dir, stale.name));
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 忽略 */
  }
}

/** 切换供应商前调用：留一份本地快照。 */
export function preserveProjectState({ state = readState(), log = null } = {}) {
  const active = activeProjectStats(state);
  const parked = collectProjectSnapshots(state).reduce((sum, s) => sum + s.projects, 0);
  const file = active.projects > 0 || parked > 0 ? saveStateSnapshot({ state, reason: "preswitch" }) : null;
  if (log && active.projects > 0) log(`  已备份 Codex 项目状态: ${active.projects} 个项目 / ${active.assignments} 条归属`);
  return { file, ...active };
}

/**
 * 切换供应商后（或 Codex 退出后）调用：把被账号隔离寄存的项目状态恢复回活动状态。
 * @param {{dryRun?:boolean, force?:boolean, log?:Function}} opts
 */
export function repairProjectState({ dryRun = false, force = false, log = null } = {}) {
  const file = statePath();
  const state = readState(file);
  if (!state) return { ok: false, error: "找不到 Codex 全局状态文件", stateFile: file };

  const running = isCodexDesktopRunning();
  preserveProjectState({ state, log: null });
  const plan = planProjectStateRepair(state);

  if (!plan.needsRepair) {
    return {
      ok: true,
      repaired: false,
      reason: plan.reason,
      stateFile: file,
      codexRunning: running,
      active: plan.active,
    };
  }
  if (dryRun) {
    return { ok: true, repaired: false, dryRun: true, stateFile: file, codexRunning: running, plan };
  }
  if (running && !force) {
    return {
      ok: true,
      repaired: false,
      reason: "codex-running",
      stateFile: file,
      codexRunning: true,
      plan,
      hint: "Codex 正在运行，等它退出后会自动恢复（或加 --force 强制写入，重启 Codex 后生效）",
    };
  }

  const backup = saveStateSnapshot({ state, reason: "prerepair" });
  const result = applyProjectStateRepair(state, plan);
  writeState(state, file);
  if (log) {
    const dropped = result.droppedProjectIds.length ? `（合并重复项目 ${result.droppedProjectIds.length} 个）` : "";
    log(`  ✅ 已恢复 Codex 项目状态: ${result.restored.projects} 个项目 / ${result.restored.assignments} 条会话归属${dropped}`);
  }
  return {
    ok: true,
    repaired: true,
    stateFile: file,
    codexRunning: running,
    restored: result.restored,
    droppedProjectIds: result.droppedProjectIds,
    source: plan.source,
    backup,
  };
}
