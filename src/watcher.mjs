// watch 模式：监控 config.toml，检测到变化时自动热重启 app-server。
// 用轮询（内容 hash）而不是 fs.watch，避免原子写（rename）导致监听丢失。
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { codexConfigPath } from "./paths.mjs";
import { reloadAppServers, discoverCodexProcesses, selectTargets } from "./reloader.mjs";
import { syncRemotes } from "./remote-sync.mjs";
import { preserveProjectState, repairProjectState } from "./codex-project-state.mjs";
import { ensureProviderCatalog } from "./switcher.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function configHash() {
  const p = codexConfigPath();
  if (!existsSync(p)) return null;
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * 持续监控配置变化并热重启。
 * @param {{intervalMs:number, scope:'chatgpt'|'all', drainTimeoutMs:number, once:boolean, log:Function, onReload:Function}} opts
 */
export async function watchConfig({
  intervalMs = 800,
  scope = "chatgpt",
  drainTimeoutMs = 8000,
  once = false,
  dryRun = false,
  hard = false,
  syncRemote = true,
  log = console.log,
  onReload = null,
} = {}) {
  let last = configHash();
  if (last === null) {
    throw new Error(`找不到配置文件: ${codexConfigPath()}`);
  }
  log(`👀 正在监控 ${codexConfigPath()}`);
  log(`   切换供应商（cc-switch 界面或 ai-toolbox switch）后会自动重启 Codex 的 app-server。`);
  log(`   Codex 退出时会自动把被账号隔离寄存的项目状态写回。`);
  log(`   按 Ctrl-C 退出。\n`);

  for (;;) {
    await sleep(intervalMs);
    const current = configHash();
    if (current === null || current === last) continue;

    // 防抖：等写入稳定（原子写仍可能连续触发）
    let stable = current;
    for (let i = 0; i < 5; i++) {
      await sleep(150);
      const again = configHash();
      if (again === null || again === stable) break;
      stable = again;
    }
    last = stable;

    const { appServers, tuis } = discoverCodexProcesses();
    const targets = selectTargets(appServers, scope);
    log(`🔁 检测到配置变化 ${new Date().toLocaleTimeString()} — ${dryRun ? "[dry-run] 将重启" : "重启"} ${targets.length} 个 app-server`);
    if (tuis.length) {
      log(`   ⚠️  检测到 ${tuis.length} 个终端 codex 会话：它们需要自行重启才能生效`);
    }

    if (dryRun) {
      for (const t of targets) log(`   [dry-run] 将重启 pid ${t.pid} (${t.owner}/${t.kind})`);
      if (onReload) await onReload({ targets, outcomes: [] });
      if (once) return { targets, outcomes: [] };
      continue;
    }

    // 切换供应商会连带换掉登录态，桌面端可能把项目列表寄存；先快照再重启。
    const preserved = preserveProjectState({ log });
    // cc-switch 可能把 model_catalog_json 指回自己的旧目录，先确保目录能覆盖当前模型。
    let catalogState = null;
    try {
      catalogState = await ensureProviderCatalog({ log });
    } catch (err) {
      log(`   ⚠️  模型目录检查失败: ${err.message}`);
    }
    const result = await reloadAppServers({ scope, drainTimeoutMs, hard, log });
    // 先让本机热重启生效，再做 SSH 同步：远程不可达时不应该拖住本机。
    if (syncRemote) {
      try {
        await syncRemotes({ dryRun, log });
      } catch (err) {
        log(`   ⚠️  远程同步失败: ${err.message}`);
      }
    }
    const projectState = repairProjectState({ log });
    result.preserved = preserved;
    result.projectState = projectState;
    result.catalogState = catalogState;
    const killed = result.outcomes.filter((o) => o.outcome === "killed").length;
    if (result.outcomes.length) {
      log(
        killed
          ? `   ✅ 已强制重启（如有任务被中断属预期）。应用界面若提示异常，点一次「Restart ChatGPT」即可。`
          : `   ✅ app-server 已平滑退出。应用会在你下次操作时自动拉起新实例。`,
      );
    } else {
      log(`   ℹ️  当前没有运行中的 app-server，下次启动 Codex 时自动生效。`);
    }

    if (onReload) await onReload(result);
    if (once) return result;
  }
}
