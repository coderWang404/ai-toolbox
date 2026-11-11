#!/usr/bin/env node
// ai-toolbox — 不重启 Codex 应用，热切换 cc-switch 管理的第三方模型供应商。
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  listCodexProviders,
  getCurrentProvider,
  findProvider,
  syncCurrentProvider,
  getCodexCommonConfig,
} from "../src/ccswitch-db.mjs";
import { switchProvider, isOfficialProvider, ensureProviderCatalog } from "../src/switcher.mjs";
import { reloadAppServers, discoverCodexProcesses, waitForRespawn, selectTargets } from "../src/reloader.mjs";
import { watchConfig } from "../src/watcher.mjs";
import { loadRemotes, syncRemotes, inspectRemotes } from "../src/remote-sync.mjs";
import { syncCcSwitch } from "../src/ccswitch-remote.mjs";
import { localFingerprint } from "../src/ccswitch-snapshot.mjs";
import { findCodexBinary, readEffectiveConfig } from "../src/verify-client.mjs";
import { findIqProvider, listIqProviders, publicIqProvider, resolveThinking } from "../src/iq-catalog.mjs";
import { iqTopic, runIqTest } from "../src/iq-runtime.mjs";
import { addKeys, applySelectedKey, listKeys, parseKeyText, queryAll, removeKey, setPlan } from "../src/go-quota.mjs";
import { addKeys as addClineKeys, listKeys as listClineKeys, parseKeyText as parseClineKeyText, queryAll as queryClineQuota, removeKey as removeClineKey } from "../src/cline-quota.mjs";
import { completeChat, startServer, status as grokStatus } from "../src/grok-bot.mjs";
import { networkInfo, runSpeedTest } from "../src/net-speed.mjs";
import {
  qoderStatus,
  applyQoderFix,
  restoreQoderDefaults,
  setHttpdnsDisabled,
  patchClash,
  setHosts,
  clearQoderCaches,
  restartQoder,
  openQoder,
  qoderRemoteStatus,
  qoderRemoteAction,
} from "../src/qoder-network.mjs";
import {
  todayStatus,
  todayModels,
  todayChat,
  todaySetModel,
  serveTodayGateway,
  launchTodayWithDebugPort,
  todayPort,
  todayGatewayToken,
} from "../src/today-gateway.mjs";
import { readFileSync } from "node:fs";
import { codexConfigPath, codexHome, ccSwitchDbPath } from "../src/paths.mjs";
import {
  preserveProjectState,
  repairProjectState,
  projectStateReport,
} from "../src/codex-project-state.mjs";
import { ensureAuthPreserved } from "../src/codex-auth.mjs";
import { probeRemotes, latestVersions, planUpdates, updateHost, localApplications } from "../src/remote-versions.mjs";
import { listClaudeProviders, getCurrentClaudeProvider, switchClaudeProvider, claudeStatus } from "../src/claude-code.mjs";
import {
  listClaudeDesktopProviders,
  claudeDesktopSummary,
  currentClaudeDesktopId,
  findClaudeDesktopProvider,
  applyClaudeDesktopProvider,
  syncClaudeDesktopCurrent,
  readAppliedProfile,
  restartClaudeDesktop,
} from "../src/claude-desktop.mjs";
import { syncClaudeRemotes } from "../src/claude-remote.mjs";
import { installCcSwitchBinary, installCodexBinary } from "../src/remote-install.mjs";

const HELP = `ai-toolbox — 不重启 Codex，热切换第三方模型供应商

用法:
  ai-toolbox list                  列出所有 codex 供应商
  ai-toolbox current               查看当前供应商与生效配置
  ai-toolbox switch <名称/ID>      切换供应商并热重启 Codex（核心命令）
  ai-toolbox claude-list           列出 Claude Code 供应商
  ai-toolbox claude-current        查看 Claude Code 当前生效的配置
  ai-toolbox claude-switch <名称/ID>  切换 Claude Code 供应商并自动同步远端（--no-sync-remote 跳过）
  ai-toolbox cdesktop-list         列出 Claude Desktop 供应商
  ai-toolbox cdesktop-current      查看 Claude Desktop 当前网关
  ai-toolbox cdesktop-switch <名称/ID>  切换 Claude Desktop（写 Claude-3p 配置并重启应用）
  ai-toolbox claude-sync-remote    把本机 Claude Code 配置同步到远程（只换 env）
  ai-toolbox reload                仅热重启 app-server（常用于 cc-switch 界面切换后）
  ai-toolbox project-state         查看 Codex 项目状态是否被账号隔离寄存
  ai-toolbox repair-projects       把被寄存的项目/会话归属恢复到 Codex 界面（Codex 需退出）
  ai-toolbox watch                 持续监控配置，切换后自动热重启（推荐常驻）
  ai-toolbox sync-remote           把本机供应商配置同步到远程 Codex，并重启远程 app-server
  ai-toolbox remote-status         查看远程正在使用的供应商和密钥尾号
  ai-toolbox remote-versions       检查远端 Codex / cc-switch CLI 版本是否有更新
  ai-toolbox remote-update         把远端 Codex / cc-switch 更新到最新（默认只更新过期的）
  ai-toolbox sync-ccswitch         把本机 cc-switch 配置同步到远程（连不上则等待重试）
  ai-toolbox iq-list               列出可用 OpenAI 协议的供应商和模型
  ai-toolbox iq-run <供应商>       用最小运行时测试模型（--model 指定模型）
  ai-toolbox go-keys               列出本机保存的 OpenCode Go 密钥（只显示尾号）
  ai-toolbox go-keys-plan <id> <plan> 设置密钥套餐（go|plus）
  ai-toolbox go-keys-use <id>      把这把密钥写入 cc-switch、Kimi Code、OpenCode 和 DeepSeek Harness，不改模型
  ai-toolbox go-quota              查询全部密钥的官方三窗口额度
  ai-toolbox cline-keys            列出本机保存的 ClinePass 密钥（只显示尾号）
  ai-toolbox cline-quota           查询全部 ClinePass 密钥的三窗口额度和余额
  ai-toolbox grok-status           读取本机 Grok Bot 登录、助手和网关状态
  ai-toolbox grok-chat             向 Grok Bot 发一条消息（stdin JSON）
  ai-toolbox grok-serve            在 127.0.0.1:8765 启动 OpenAI 兼容网关
  ai-toolbox net-info              查看当前网络接口、地址和出口
  ai-toolbox net-speed             测延迟、下载和上传，并持续输出过程
  ai-toolbox qoder-status          Qoder CN 网络状态（DNS/hosts/Clash/HTTPDNS/日志）
  ai-toolbox qoder-fix             修复本机 Qoder 网络（hosts + HTTPDNS + Clash，需管理员授权）
  ai-toolbox qoder-restore         还原 Qoder 网络修复
  ai-toolbox qoder-restart         重启 Qoder CN
  ai-toolbox qoder-open            打开 Qoder CN
  ai-toolbox qoder-remote-status   查看远程机器上的 Qoder 状态
  ai-toolbox qoder-remote-action --host <别名> --action <动作>  重启远程 watcher/代理/worker 或重新包装
  ai-toolbox qoder-httpdns <on|off> 开启/关闭 Qoder HTTPDNS
  ai-toolbox today-status          Today.app 登录态、模型目录与本地网关状态
  ai-toolbox today-models          列出 Today 账号可用的模型
  ai-toolbox today-chat <文本>     向 Today 助手发一条消息（--model 指定模型）
  ai-toolbox today-model <模型>    切换 Today 的全局模型选项
  ai-toolbox today-launch          以调试端口重启 Today.app（CDP 传输需要）
  ai-toolbox today-serve           启动 Today 的 OpenAI 兼容网关（--port 指定端口）
  ai-toolbox doctor                检查运行环境

选项:
  --scope <范围>        chatgpt（默认，主 app-server）| chatgpt-all（含 computer-use 会话）| all
  --drain <秒>          SIGTERM 平滑等待秒数（默认 8）
  --hard                跳过平滑退出，直接强制结束
  --force               cc-switch 正在运行时，仍强制从命令行切换（有卡片错位风险）
  --no-reload           只写配置，不重启 Codex
  --no-remote           不同步远程机器（内置机器见 src/remotes.json，自定义见 ~/.ai-toolbox/remotes.json）
  --no-model-probe      不向供应商 /models 拉取模型目录（只用 cc-switch 里配置的目录）
  --timeout <秒>        单次命令总超时（默认 120，watch / serve 不生效）
  --dry-run             只展示将写入的配置，不落盘
  --focus / --no-focus  重启后是否把 ChatGPT 窗口切到前台（默认 focus）
  --json                以 JSON 输出（供桌面 App / 脚本调用）
  --with-secrets        在 JSON 里包含完整密钥（默认只给尾号，供 App 复制时显式使用）
  -h, --help            显示帮助
`;

/** cc-switch 是否正在运行（它在运行时会把自己的内存状态回填到卡片，外部改配置有错位风险）。 */
function isCcSwitchRunning() {
  try {
    execFileSync("pgrep", ["-f", "CC Switch.app/Contents/MacOS/cc-switch"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeLogger(jsonMode) {
  const noop = () => {};
  return {
    log: jsonMode ? noop : console.log,
    warn: jsonMode ? noop : console.log,
    // 进度只走 stderr：桌面 App 可以边跑边显示当前卡在哪个阶段，也不会污染 stdout 的 JSON。
    progress: jsonMode ? (line) => process.stderr.write(`${line}\n`) : (line) => console.log(line),
  };
}

function fmtCurrent(p) {
  return p ? `${p.name} (${p.id})` : "(未知)";
}

function modelOf(configText) {
  return (configText?.match(/^\s*model\s*=\s*"([^"]+)"/m) ?? [])[1] ?? null;
}

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host;
  } catch {
    return null;
  }
}

function tokenTailOf(token) {
  return typeof token === "string" && token.length > 0 ? token.slice(-8) : null;
}

export function providerSummary(p, { includeSecrets = false } = {}) {
  const baseUrl = p.config.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  return {
    id: p.id,
    name: p.name,
    isCurrent: !!p.isCurrent,
    model: modelOf(p.config),
    catalogCount: p.modelCatalog?.models?.length ?? 0,
    official: isOfficialProvider(p),
    hasConfig: !!p.config.trim(),
    baseUrl,
    host: hostOf(baseUrl),
    tokenTail: tokenTailOf(p.auth?.OPENAI_API_KEY),
    token: includeSecrets ? p.auth?.OPENAI_API_KEY || null : null,
  };
}

/** 解析 config.toml 中实际生效的供应商表（base_url / token）。 */
function liveProviderInfo(configText, { includeSecrets = false } = {}) {
  const providerId = configText.match(/^\s*model_provider\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const lines = configText.split(/\r?\n/);
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = providerId
    ? new RegExp(`^\\s*\\[\\s*model_providers\\s*\\.\\s*(?:"${esc(providerId)}"|${esc(providerId)})\\s*\\]`)
    : null;
  let start = -1;
  if (header) {
    for (let i = 0; i < lines.length; i++) {
      if (header.test(lines[i])) { start = i; break; }
    }
  }
  if (start === -1) return { providerId, baseUrl: null, tokenTail: null, token: null, host: null, model: null };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join("\n");
  const baseUrl = body.match(/base_url\s*=\s*"([^"]+)"/)?.[1] ?? null;
  const token = body.match(/experimental_bearer_token\s*=\s*"([^"]+)"/)?.[1] ?? null;
  return {
    providerId,
    baseUrl,
    tokenTail: tokenTailOf(token),
    ...(includeSecrets ? { token } : {}),
    host: hostOf(baseUrl),
    model: configText.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null,
  };
}

function printProviderTable(summaries, currentId) {
  if (!summaries.length) {
    console.log("没有找到任何 codex 供应商。");
    return;
  }
  const nameW = Math.max(...summaries.map((p) => [...p.name].length), 4);
  for (const p of summaries) {
    const mark = p.id === currentId ? "●" : "○";
    const pad = " ".repeat(Math.max(0, nameW - [...p.name].length));
    const catalog = p.catalogCount ? ` | 目录 ${p.catalogCount} 模型` : "";
    const host = p.host ? ` | ${p.host}` : "";
    console.log(`  ${mark} ${p.name}${pad}  model=${p.model ?? "-"}${host}${catalog}  [${p.id}]`);
  }
  console.log("\n  ● = 当前供应商。切换: ai-toolbox switch <名称>");
}

async function effectiveConfig() {
  const bin = findCodexBinary();
  if (!bin) return { ok: false, error: "未找到 codex 二进制" };
  const res = await readEffectiveConfig({ codexBin: bin, codexHome: codexHome() });
  if (!res.ok) return { ok: false, error: res.error };
  const cfg = res.config;
  const pid = cfg.model_provider ?? cfg.modelProvider ?? null;
  const table = pid ? (cfg.model_providers?.[pid] ?? cfg.modelProviders?.[pid]) : null;
  return {
    ok: true,
    modelProvider: pid,
    model: cfg.model ?? null,
    baseUrl: table?.base_url ?? null,
    hasToken: !!table?.experimental_bearer_token,
    catalogJson: cfg.model_catalog_json ?? null,
  };
}

async function cmdList(opts) {
  const { log } = opts;
  const providers = listCodexProviders();
  const current = getCurrentProvider();
  const summaries = providers.map((provider) => providerSummary(provider, { includeSecrets: opts.secrets }));
  const currentId = current?.id ?? null;

  // 实际生效的配置（config.toml 是 Codex 真正读取的文件）
  let live = null;
  const configPath = codexConfigPath();
  if (existsSync(configPath)) {
    try {
      live = liveProviderInfo(readFileSync(configPath, "utf8"), { includeSecrets: opts.secrets });
    } catch {
      live = null;
    }
  }
  const matchedIds = live
    ? summaries
        .filter((s) => s.baseUrl && s.baseUrl === live.baseUrl && s.tokenTail && s.tokenTail === live.tokenTail)
        .map((s) => s.id)
    : [];
  const liveProviderId = matchedIds.includes(currentId) ? currentId : (matchedIds[0] ?? null);

  log(`\nCodex 供应商（共 ${providers.length} 个）:\n`);
  if (!opts.json) printProviderTable(summaries, currentId);
  return {
    command: "list",
    currentId,
    providers: summaries,
    live: live ? { ...live, matchedIds, liveProviderId } : null,
    ccSwitchRunning: isCcSwitchRunning(),
  };
}

async function cmdCurrent(opts) {
  const { log } = opts;
  const current = getCurrentProvider();
  log(`\ncc-switch 当前供应商: ${fmtCurrent(current)}`);
  log(`配置文件: ${codexConfigPath()}`);
  const eff = await effectiveConfig();
  if (eff.ok) {
    log(`实际生效: model_provider=${eff.modelProvider} model=${eff.model}`);
    if (eff.baseUrl) log(`          base_url=${eff.baseUrl}`);
  } else {
    log(`实际生效: (读取失败: ${eff.error})`);
  }
  const { appServers, tuis } = discoverCodexProcesses();
  log(`\n运行中的 app-server: ${appServers.length} 个`);
  for (const p of appServers) log(`  - pid ${p.pid} [${p.owner}/${p.kind}]`);
  if (tuis.length) log(`终端 codex 会话: ${tuis.length} 个（需要自行重启才能生效）`);
  return {
    command: "current",
    current: current ? { id: current.id, name: current.name } : null,
    configPath: codexConfigPath(),
    effective: eff,
    appServers: appServers.map((p) => ({ pid: p.pid, owner: p.owner, kind: p.kind, topLevel: p.topLevel })),
    tuiCount: tuis.length,
  };
}

function doReloadHuman(opts, { targets, terminated, killed, respawned }) {
  const { log } = opts;
  if (!targets.length) {
    log(`  ℹ️  没有运行中的 app-server。下次启动 Codex 时自动使用新配置。`);
    return;
  }
  log(`\n✅ 已重启 ${terminated + killed} 个 app-server（平滑 ${terminated}${killed ? `，强制 ${killed}` : ""}）`);
  if (killed) {
    log(`   ⚠️  强制结束会让界面显示恢复页：点一次「Restart ChatGPT」即可（不会丢失对话）。`);
  } else if (respawned) {
    log(`   🎉 应用已自动拉起新的 app-server (pid ${respawned.pid})，新供应商已生效。`);
  } else {
    log(`   ℹ️  点击 ChatGPT 里任意对话（或新建对话）即可让新供应商生效，无需重启应用。`);
  }
}

async function doReload(opts) {
  const { log } = opts;
  const { appServers, tuis } = discoverCodexProcesses();
  const targets = selectTargets(appServers, opts.scope);
  log(`\n♻️  热重启 Codex app-server（scope=${opts.scope}）...`);
  if (tuis.length) {
    log(`  ⚠️  检测到 ${tuis.length} 个终端 codex 会话：它们需要自行重启才能生效`);
  }
  if (!targets.length) {
    const result = { targets: [], terminated: 0, killed: 0, respawned: null, tuiCount: tuis.length };
    doReloadHuman(opts, result);
    return result;
  }
  if (opts.dryRun) {
    log(`  [dry-run] 将重启以下进程：${targets.map((t) => t.pid).join(", ")}`);
    return {
      targets: targets.map((t) => ({ pid: t.pid, owner: t.owner })),
      terminated: 0,
      killed: 0,
      respawned: null,
      dryRun: true,
      tuiCount: tuis.length,
    };
  }
  const knownPids = appServers.map((p) => p.pid);
  const result = await reloadAppServers({
    scope: opts.scope,
    drainTimeoutMs: opts.drainMs,
    hard: opts.hard,
    log: opts.log, // JSON 模式下为 no-op，避免污染 stdout
  });
  const killed = result.outcomes.filter((o) => o.outcome === "killed").length;
  const terminated = result.outcomes.filter((o) => o.outcome === "terminated").length;
  let respawned = null;
  if (!killed && terminated) {
    // ChatGPT 在窗口获得焦点时会重连并自动拉起新 app-server（实测）。
    // 需要等应用先感知到连接断开，再激活窗口，否则焦点事件会早于断连状态。
    const focusChatGPT = () => {
      if (!opts.focus) return;
      try {
        execFileSync("open", ["-a", "ChatGPT"]);
      } catch {
        /* 忽略 */
      }
    };
    focusChatGPT();
    respawned = await waitForRespawn(knownPids, { scope: opts.scope, timeoutMs: 4000 });
    if (!respawned) {
      // 再试一次：有些情况下第一次激活时应用尚未处理完断连
      focusChatGPT();
      respawned = await waitForRespawn(knownPids, { scope: opts.scope, timeoutMs: 6000 });
    }
  }
  const out = {
    targets: targets.map((t) => ({ pid: t.pid, owner: t.owner })),
    terminated,
    killed,
    respawned: respawned ? { pid: respawned.pid } : null,
    tuiCount: tuis.length,
  };
  doReloadHuman(opts, out);
  return out;
}

async function cmdSwitch(query, opts) {
  const { log } = opts;
  const startedAt = Date.now();
  const timings = {};
  let lastStamp = startedAt;
  const stamp = (key) => {
    const now = Date.now();
    timings[key] = now - lastStamp;
    lastStamp = now;
  };
  const phase = (name) => {
    opts.setPhase?.(name);
    opts.progress?.(`→ ${name}`);
  };

  phase("读取供应商配置");
  const provider = findProvider(query);
  if (!provider) {
    throw new Error(`找不到供应商「${query}」。可用: ai-toolbox list`);
  }
  if (isOfficialProvider(provider)) {
    throw new Error(
      `「${provider.name}」是官方供应商，涉及 ChatGPT 登录态（auth.json），请用 cc-switch 界面切换，然后运行 ai-toolbox reload`,
    );
  }

  // cc-switch 运行时，外部直接改 live 配置会被它回填到"它以为的当前卡片"，造成卡片内容错位。
  if (isCcSwitchRunning() && !opts.force) {
    throw new Error(
      `cc-switch 正在运行，为避免它把你的配置回填到错误的供应商卡片，本工具默认不直接切换。\n` +
        `  推荐做法：在 cc-switch 界面点击「${provider.name}」——本工具的「自动跟随」会自动热重启 Codex（效果完全一样）。\n` +
        `  如果确认要强制从命令行切换：加 --force（并建议随后在 cc-switch 里核对当前卡片）`,
    );
  }

  log(`\n🔀 切换到 ${fmtCurrent(provider)}`);

  // 切换供应商常常连带换掉 auth / ChatGPT 登录态，桌面端会把项目列表按账号寄存。
  // 先留一份本地快照，切换后再尝试恢复。
  phase("备份 Codex 项目状态");
  const preserved = preserveProjectState({ log });

  const common = getCodexCommonConfig();
  phase("写入配置并校验");
  const result = await switchProvider({
    provider,
    commonConfig: common,
    apiFormat: provider.meta?.apiFormat,
    dryRun: opts.dryRun,
    probeModels: opts.modelProbe,
    log,
  });
  stamp("writeAndVerify");

  if (opts.dryRun) {
    log("\n--- 将写入的 config.toml (dry-run) ---\n");
    log(result.preview);
    return {
      command: "switch",
      dryRun: true,
      provider: providerSummary(provider, { includeSecrets: opts.secrets }),
      preview: result.preview,
      preserved,
      timings,
    };
  }

  for (const w of result.warnings) log(`  ⚠️  ${w}`);

  phase("检查 ChatGPT 登录态");
  const authState = ensureAuthPreserved({ log });

  phase("同步 cc-switch 状态");
  let synced = false;
  if (!process.env.CODEX_HOME?.trim()) {
    synced = syncCurrentProvider(provider.id);
    if (synced) {
      log(`  已同步 cc-switch 当前供应商标记`);
    } else {
      log(`  ⚠️ 同步 cc-switch 当前供应商标记失败！这会让 cc-switch 后续把配置回填到错误的卡片，请手动在 cc-switch 里核对当前卡片`);
    }
  } else {
    log(`  已指定 CODEX_HOME，跳过 cc-switch 状态同步`);
  }

  let reload = null;
  if (opts.reload) {
    phase("重启 Codex app-server");
    reload = await doReload(opts);
    stamp("reload");
  } else {
    log(`  已跳过重启（--no-reload）。新开 Codex 会话时生效。`);
  }

  phase("同步远程机器");
  const remote = await maybeSyncRemotes(opts);
  stamp("remote");

  phase("恢复 Codex 项目状态");
  const projectState = repairProjectState({ log: opts.log });
  stamp("projectState");

  return {
    command: "switch",
    provider: providerSummary(provider, { includeSecrets: opts.secrets }),
    effective: result.effective,
    verified: result.verified,
    backupPath: result.backupPath,
    synced,
    warnings: result.warnings,
    reverted: result.reverted ?? null,
    catalogSource: result.catalogSource ?? "none",
    modelCount: result.modelCount ?? 0,
    modelProbe: result.modelProbe ? { ok: !!result.modelProbe.ok, error: result.modelProbe.error ?? null, ms: result.modelProbe.ms } : null,
    reload,
    remote,
    preserved,
    projectState,
    authState,
    timings: { ...timings, total: Date.now() - startedAt },
  };
}

async function maybeSyncRemotes(opts) {
  if (!opts.remote) return null;
  return syncRemotes({ dryRun: opts.dryRun, log: opts.log });
}

async function cmdReload(opts) {
  const { log } = opts;
  const startedAt = Date.now();
  const timings = {};
  const current = getCurrentProvider();
  log(`\n当前供应商: ${fmtCurrent(current)}`);
  const phase = (name) => {
    opts.setPhase?.(name);
    opts.progress?.(`→ ${name}`);
  };
  phase("备份 Codex 项目状态");
  const preserved = preserveProjectState({ log });
  phase("检查 ChatGPT 登录态");
  const authState = ensureAuthPreserved({ log });
  let lastStamp = Date.now();
  const stamp = (key) => {
    const now = Date.now();
    timings[key] = now - lastStamp;
    lastStamp = now;
  };
  stamp("preserve");
  phase("检查模型目录");
  let catalogState = null;
  try {
    catalogState = await ensureProviderCatalog({ log });
  } catch (err) {
    catalogState = { ok: false, error: err.message };
  }
  stamp("catalog");
  phase("同步远程机器");
  const remote = await maybeSyncRemotes(opts);
  stamp("remote");
  phase("重启 Codex app-server");
  const reload = await doReload(opts);
  stamp("reload");
  phase("恢复 Codex 项目状态");
  const projectState = repairProjectState({ log: opts.log });
  stamp("projectState");
  return {
    command: "reload",
    current: current ? { id: current.id, name: current.name } : null,
    reload,
    remote,
    preserved,
    projectState,
    catalogState,
    authState,
    timings: { ...timings, total: Date.now() - startedAt },
  };
}

async function cmdProjectState(opts) {
  const report = projectStateReport();
  if (!opts.json) {
    if (!report.ok) {
      opts.log(`\n❌ ${report.error}`);
      return report;
    }
    const { active, snapshots, needsRepair, codexRunning } = report;
    opts.log(`\nCodex 全局状态: ${report.stateFile}`);
    opts.log(`  活动状态: ${active.projects} 个项目 / ${active.assignments} 条会话归属`);
    opts.log(`  账号隔离层: ${report.accountScoped ? "存在" : "不存在（项目对所有账号可见）"}`);
    if (snapshots.length) {
      for (const s of snapshots) {
        opts.log(`  寄存快照 ${s.id.slice(0, 8)}: ${s.projects} 个项目 / ${s.assignments} 条归属`);
      }
    }
    opts.log(`  Codex 运行中: ${codexRunning ? "是" : "否"}`);
    opts.log(
      needsRepair
        ? `\n⚠️  检测到项目被寄存（${report.reason}）。退出 Codex 后运行: ai-toolbox repair-projects`
        : `\n✅ 项目状态正常（${report.reason}）`,
    );
  }
  return report;
}

function cmdRepairProjects(opts) {
  const { log } = opts;
  const result = repairProjectState({ dryRun: opts.dryRun, force: opts.force, log });
  if (!opts.json) {
    if (!result.ok) log(`❌ ${result.error}`);
    else if (result.dryRun) log(`[dry-run] 将恢复 ${result.plan.source.projects} 个项目`);
    else if (!result.repaired) log(`ℹ️  无需恢复: ${result.reason ?? result.hint ?? "状态已正常"}`);
    if (result.hint) log(`   ${result.hint}`);
  }
  return { command: "repair-projects", ...result };
}

async function cmdRemoteVersions(opts) {
  const { log } = opts;
  const [rows, latest, local] = await Promise.all([
    probeRemotes(),
    opts.latest ? latestVersions() : Promise.resolve(null),
    Promise.resolve(localApplications()),
  ]);
  const planned = latest ? planUpdates(rows, latest) : rows;
  if (!opts.json) {
    log("\n本机");
    log(
      `  ✔ ChatGPT.app ${local.codexApp ?? "未安装"}（codex CLI ${local.codexCli ?? "-"}）   CC Switch ${local.ccSwitchApp ?? "未安装"}${
        latest?.ccSwitchApp ? `（最新 ${latest.ccSwitchApp}）` : ""
      }`,
    );
    if (latest) {
      log(`\n远端（最新：codex ${latest.codex ?? "?"} · cc-switch-cli ${latest.ccswitch ?? "?"}）`);
      for (const [tool, err] of Object.entries(latest.errors ?? {})) if (err) log(`  ⚠️ ${tool} 版本查询失败: ${err}`);
    } else {
      log("\n远端版本");
    }
    for (const row of planned) {
      if (!row.ok) {
        log(`  ❌ ${row.label.padEnd(8)} ${row.error}`);
        continue;
      }
      const codex = row.codex
        ? `${row.codex}${row.codexUpdate ? ` → ${latest.codex}` : ""}`
        : "(无)";
      const cc = row.ccswitch
        ? `${row.ccswitch}${row.ccswitchUpdate ? ` → ${latest.ccswitch}` : ""}`
        : "(无)";
      const outdated = row.codexUpdate || row.ccswitchUpdate;
      log(`  ${outdated ? "↑" : "✔"} ${row.label.padEnd(8)} ${String(row.hostname ?? row.host).padEnd(20)} codex ${codex.padEnd(24)} cc-switch ${cc}`);
    }
    if (latest && planned.some((row) => row.codexUpdate || row.ccswitchUpdate)) {
      log("\n有更新可装：ai-toolbox remote-update");
    }
  }
  return { command: "remote-versions", latest, local, hosts: planned };
}

async function cmdRemoteUpdate(opts) {
  const { log } = opts;
  const hostList = Array.isArray(opts.hosts)
    ? opts.hosts
    : typeof opts.hosts === "string" && opts.hosts
      ? opts.hosts.split(",").map((item) => item.trim()).filter(Boolean)
      : [];
  const rows = await probeRemotes();
  const latest = await latestVersions();
  const planned = planUpdates(rows, latest);
  const wanted = (row) =>
    hostList.length === 0 || hostList.some((h) => h === row.label || h === row.host);
  const targets = planned.filter(
    (row) => row.ok && wanted(row) && (opts.force || row.codexUpdate || row.ccswitchUpdate),
  );
  const doCodex = opts.codex;
  const doCcSwitch = opts.ccswitch;

  if (opts.dryRun) {
    for (const row of targets) {
      log(`  [dry-run] ${row.label}: codex ${row.codex ?? "-"} → ${latest.codex ?? "?"}, cc-switch ${row.ccswitch ?? "-"} → ${latest.ccswitch ?? "?"}`);
    }
    return { command: "remote-update", dryRun: true, latest, hosts: planned, targets: targets.map((r) => r.label) };
  }

  const results = await Promise.all(
    targets.map(async (row) => {
      opts.progress?.(`→ 更新 ${row.label}…`);
      const result = await updateHost(
        { host: row.host, label: row.label },
        {
          codex: doCodex,
          ccswitch: doCcSwitch,
          codexVersion: row.codexUpdate ? latest.codex : null,
          ccswitchVersion: row.ccswitchUpdate ? latest.ccswitch : null,
        },
      );
      if (!opts.json) {
        if (!result.ok) {
          const detail = result.error ?? result.ccswitch?.output?.slice(-160) ?? "更新失败";
          log(`  ❌ ${row.label}: ${detail}`);
        } else {
          const parts = [];
          if (doCodex) parts.push(`codex ${row.codex ?? "-"} → ${result.codex.after ?? "?"}`);
          if (doCcSwitch) parts.push(`cc-switch ${row.ccswitch ?? "-"} → ${result.ccswitch.after ?? "?"}`);
          log(`  ✔ ${row.label}: ${parts.join(" · ")}`);
        }
      }
      return result;
    }),
  );

  // 远端常常访问不了 GitHub / 没有 npm：回退成本机下载 + scp 直装
  const fallback = [];
  if (opts.download) {
    for (const [index, result] of results.entries()) {
      const row = targets[index];
      if (!row) continue;
      if (doCcSwitch && result.ccswitch && result.ccswitch.exitCode !== 0) {
        fallback.push({ row, tool: "ccswitch", result });
      }
      if (doCodex && result.codex && result.codex.exitCode !== 0) {
        fallback.push({ row, tool: "codex", result });
      }
    }
    for (const item of fallback) {
      opts.progress?.(`→ ${item.row.label}: ${item.tool} 直装（本机下载后推送）…`);
      try {
        const installed =
          item.tool === "ccswitch"
            ? await installCcSwitchBinary({ host: item.row.host, label: item.row.label, user: item.row.user, port: item.row.port, identityFile: item.row.identityFile }, latest.ccswitch)
            : await installCodexBinary({ host: item.row.host, label: item.row.label, user: item.row.user, port: item.row.port, identityFile: item.row.identityFile }, latest.codex);
        item.result.ok = true;
        const after = installed.effectiveVersion || installed.version;
        const shadowed = installed.shadowed ? `（PATH 里仍是 ${installed.effectivePath}，新版本在 ${installed.installed}）` : "";
        if (item.tool === "ccswitch") item.result.ccswitch = { ...item.result.ccswitch, after, installedAt: installed.installed, shadowed: Boolean(installed.shadowed) };
        else item.result.codex = { ...item.result.codex, after, installedAt: installed.installed, shadowed: Boolean(installed.shadowed) };
        item.result.fallback = true;
        if (!opts.json) {
          log(`  ⤵ ${item.row.label}: ${item.tool} 直装完成 → ${after ?? "?"}（${installed.installed ?? "-"}）${shadowed}`);
        }
      } catch (err) {
        item.result.ok = false;
        if (!opts.json) log(`  ❌ ${item.row.label}: ${item.tool} 直装失败 ${String(err.message).slice(0, 160)}`);
      }
    }
  }

  return { command: "remote-update", latest, hosts: planned, results };
}

function cmdClaudeList(opts) {
  const providers = listClaudeProviders();
  const current = getCurrentClaudeProvider();
  if (!opts.json) {
    console.log(`\nClaude Code 供应商（共 ${providers.length} 个）:\n`);
    for (const p of providers) {
      const mark = current?.id === p.id ? "●" : "○";
      console.log(`  ${mark} ${p.name.padEnd(18)} ${(p.host ?? "-").padEnd(28)} model=${p.model ?? "-"}  [${p.id}]`);
    }
    console.log("\n  ● = 当前供应商。切换: ai-toolbox claude-switch <名称>");
  }
  return {
    command: "claude-list",
    currentId: current?.id ?? null,
    providers: providers.map(({ settings, ...rest }) => rest),
  };
}

function cmdClaudeCurrent(opts) {
  const status = claudeStatus();
  if (!opts.json) {
    opts.log(`\n配置文件: ${status.settingsPath ?? "-"}`);
    if (status.ok) {
      opts.log(`实际生效: ${status.host ?? "-"}  model=${status.model ?? "-"}`);
      opts.log(`cc-switch 记录: ${status.provider?.name ?? "(无)"}${status.matchesProvider === false ? "  ⚠️ 与生效端点不一致" : ""}`);
    } else {
      opts.log(`读取失败: ${status.error}`);
    }
  }
  return { command: "claude-current", ...status };
}

async function cmdClaudeSwitch(query, opts) {
  const result = switchClaudeProvider(query, { dryRun: opts.dryRun });
  let remote = null;
  if (!opts.json) {
    if (opts.dryRun) {
      opts.log(`[dry-run] 将切换到 ${result.provider.name}（${result.provider.host ?? "-"}）`);
    } else {
      opts.log(`\n✔ 已切换到 ${result.provider.name}（${result.endpoint ?? "-"}）`);
      opts.log(`  已写入: ${result.settingsPath}`);
      if (result.backupPath) opts.log(`  已备份: ${result.backupPath}`);
      if (!result.synced) opts.log("  ⚠️ 同步 cc-switch 当前标记失败，请在 cc-switch 里核对");
      opts.log("  新开 Claude Code 会话时生效");
    }
  }
  if (!opts.dryRun && opts.syncRemoteAfterSwitch !== false) {
    try {
      remote = await syncClaudeRemotes({ log: opts.log });
    } catch (err) {
      opts.warn?.(`  ⚠️ 远端同步失败: ${err.message ?? err}`);
    }
  }
  return {
    command: "claude-switch",
    ...result,
    provider: { id: result.provider.id, name: result.provider.name },
    remote,
  };
}

function cmdClaudeDesktopList(opts) {
  const providers = listClaudeDesktopProviders();
  const current = currentClaudeDesktopId();
  if (!opts.json) {
    console.log(`\nClaude Desktop 供应商（共 ${providers.length} 个）:\n`);
    for (const p of providers) {
      const mark = p.id === current ? "●" : "○";
      const mode = p.proxyMode ? "（走 cc-switch 代理）" : p.official ? "（官方）" : "";
      console.log(`  ${mark} ${p.name.padEnd(22)} ${(p.host ?? "-").padEnd(26)} ${mode}`);
    }
    console.log("\n  切换: ai-toolbox cdesktop-switch <名称>");
  }
  return {
    command: "cdesktop-list",
    currentId: current,
    providers: providers.map((p) => claudeDesktopSummary(p)),
    applied: readAppliedProfile(),
  };
}

function cmdClaudeDesktopCurrent(opts) {
  const applied = readAppliedProfile();
  const current = currentClaudeDesktopId();
  const provider = listClaudeDesktopProviders().find((p) => p.id === current) ?? null;
  if (!opts.json) {
    opts.log(`\ncc-switch 记录: ${provider?.name ?? "(无)"}`);
    opts.log(`实际网关: ${applied?.host ?? "-"}  ${applied ? `key …${applied.tokenTail ?? ""}` : ""}`);
    if (applied && provider?.baseUrl && applied.baseUrl !== provider.baseUrl) opts.log("  ⚠️ 与 cc-switch 记录不一致");
  }
  return { command: "cdesktop-current", applied, provider: provider ? { id: provider.id, name: provider.name } : null };
}

async function cmdClaudeDesktopSwitch(query, opts) {
  const provider = findClaudeDesktopProvider(query);
  if (!provider) throw new Error(`找不到 Claude Desktop 供应商「${query}」`);
  const applied = applyClaudeDesktopProvider(provider);
  syncClaudeDesktopCurrent(provider.id);
  let reload = null;
  if (opts.reload) reload = await restartClaudeDesktop({ log: opts.log });
  if (!opts.json) {
    opts.log(`\n✔ 已切换到 ${provider.name}（${applied?.host ?? "-"}）`);
    opts.log(`  skill ${reload ? "已重启 Claude Desktop" : "未重启，下次打开 Claude 生效"}`);
  }
  return { command: "cdesktop-switch", provider: claudeDesktopSummary(provider), applied, reload };
}

async function cmdClaudeSyncRemote(opts) {
  return syncClaudeRemotes({ dryRun: opts.dryRun, log: opts.log, hosts: opts.hosts?.length ? opts.hosts : null });
}

async function cmdSyncRemote(opts) {
  const remote = await syncRemotes({ dryRun: opts.dryRun, log: opts.log });
  return { command: "sync-remote", remote };
}

async function cmdSyncCcSwitch(opts) {
  const remote = await syncCcSwitch({ dryRun: opts.dryRun, log: opts.log, hosts: opts.hosts });
  return { command: "sync-ccswitch", fingerprint: remote.fingerprint ?? localFingerprint(), remote };
}

function cmdCcSwitchFingerprint() {
  return { command: "ccswitch-fingerprint", fingerprint: localFingerprint() };
}

async function cmdRemoteStatus(opts) {
  const remote = await inspectRemotes({ includeSecrets: opts.secrets });
  for (const host of remote.hosts) {
    if (!host.ok) {
      opts.log(`  ❌ ${host.label}: ${host.error ?? "读取失败"}`);
      continue;
    }
    const endpoint = hostOf(host.baseUrl) ?? host.baseUrl ?? "-";
    opts.log(`  ${host.label}: ${host.providerName ?? "-"} · ${endpoint} · key …${host.tokenTail ?? "-"}`);
  }
  return { command: "remote-status", remote };
}

async function cmdIqList(opts) {
  const providers = (await listIqProviders()).map(publicIqProvider);
  for (const provider of providers) {
    opts.log(`${provider.name} [${provider.appType}] ${provider.models.map((item) => item.id).join(", ")}`);
  }
  return { command: "iq-list", providers };
}

async function cmdIqRun(query, opts) {
  const provider = findIqProvider(query);
  if (!provider) throw new Error(`找不到供应商「${query}」。可用: ai-toolbox iq-list`);
  const known = provider.models.map((item) => item.id);
  const model = opts.model || known[0];
  const spec = provider.models.find((item) => item.id === model);
  if (!spec && opts.model) provider.models.push({ id: model, ...resolveThinking(model) });
  const thinking = opts.thinking || spec?.defaultThinking || "off";
  const topic = iqTopic(opts.topic);
  const progress = (line) => console.error(line);
  const result = await runIqTest({ provider, model, thinking, topic: topic.id, log: progress });
  opts.log(`\n${provider.name} / ${model}`);
  opts.log(result.htmlPath ? `HTML: ${result.htmlPath}` : "没有生成 HTML");
  opts.log(`用时 ${Math.round(result.elapsedMs / 1000)} 秒，${result.stopReason}`);
  return { command: "iq-run", ...result, provider: publicIqProvider(provider) };
}

async function cmdQoderStatus(opts) {
  const status = await qoderStatus();
  if (!opts.json) {
    opts.log(`\nQoder CN: ${status.app.installed ? `已安装 ${status.app.version ?? ""}` : "未安装"}${status.app.running ? " · 运行中" : " · 未运行"}`);
    opts.log(`hosts: ${status.hosts.pinned ? `已固定 ${status.hosts.ip}` : "未固定"}`);
    opts.log(`HTTPDNS: ${status.httpdns.disabled ? "已关闭" : "开启"} · LaunchAgent ${status.httpdns.agentInstalled ? "已安装" : "未安装"}`);
    opts.log(`Clash: TUN ${status.clash.tunEnabled ? "开" : "关"} · fake-IP ${status.clash.fakeIP ? "是" : "否"} · 系统 hosts ${status.clash.useSystemHosts ? "是" : "否"} · Qoder 直连 ${status.clash.qoderRules ? "有" : "无"}`);
    opts.log(`Qoder 日志: networkMode=${status.log.networkMode ?? "-"} httpdnsConfigured=${status.log.httpdnsConfigured ?? "-"} model=${status.log.lastModelStatus ?? "-"}`);
    for (const endpoint of status.endpoints) {
      opts.log(`  ${endpoint.name} [${endpoint.via}] ${endpoint.status ?? "-"} ${endpoint.timeMs ?? "-"}ms ${endpoint.remoteIP ?? ""}`);
    }
    if (status.issues.length) opts.log(`\n⚠️ ${status.issues.join("；")}`);
  }
  return status;
}

async function cmdQoderRemoteStatus(opts) {
  const result = await qoderRemoteStatus();
  if (!opts.json) {
    opts.log(`\n远程 Qoder（${result.configured ? result.file : "未配置"}）`);
    for (const host of result.hosts ?? []) {
      opts.log(`  ${host.label ?? host.host} [${host.health}] ${host.hostname ?? "-"} 安装 ${host.installs ?? 0} · 包装 ${host.wrapped ?? 0} · watcher ${host.watcher ?? "-"}`);
      opts.log(`    direct ${host.endpointDirectCode ?? 0} ${host.endpointDirectTimeMs ?? 0}ms · proxy ${host.endpointProxyCode ?? 0} ${host.endpointProxyTimeMs ?? 0}ms${host.issues?.length ? ` · ${host.issues.join("；")}` : ""}`);
    }
  }
  return result;
}

async function cmdQoderRemoteAction(opts) {
  if (!opts.host || !opts.action) throw new Error("用法: ai-toolbox qoder-remote-action --host <别名> --action <restart-watcher|restart-proxy|restart-worker|wrap|enable-watcher>");
  const result = await qoderRemoteAction(opts.host, opts.action);
  if (!opts.json) opts.log(`${result.ok ? "完成" : "失败"}: ${result.output ?? result.error ?? ""}`);
  return result;
}

async function cmdQoderFix(opts) {
  const result = await applyQoderFix({ restart: true });
  if (!opts.json && result.status) await cmdQoderStatus(opts);
  if (!result.ok) return { ...result, error: result.message ?? "Qoder 网络修复没有完成" };
  return result;
}

async function cmdQoderRestore(opts) {
  const result = await restoreQoderDefaults({ restart: true });
  if (!opts.json && result.status) await cmdQoderStatus(opts);
  return result;
}

async function cmdQoderHttpdns(value, opts) {
  if (value !== "on" && value !== "off") throw new Error("用法: ai-toolbox qoder-httpdns <on|off>");
  const result = await setHttpdnsDisabled(value === "off");
  if (!opts.json) opts.log(`Qoder HTTPDNS 已${value === "off" ? "关闭" : "开启"}`);
  return { command: "qoder-httpdns", value, ...result };
}

async function cmdTodayStatus(opts) {
  const info = await todayStatus({ port: opts.port ?? todayPort(), includeSecrets: opts.secrets });
  if (!opts.json) {
    opts.log(`\nToday CDP: ${info.cdp?.reachable ? "已连接" : "不可达"}`);
    if (info.pageUrl) opts.log(`页面: ${info.pageUrl}`);
    if (info.currentModel) opts.log(`当前模型: ${info.currentModel}`);
    for (const model of info.models ?? []) opts.log(`  ${model.id}  ${model.title ?? ""}`);
    opts.log(`网关: ${info.gateway?.running ? "运行中" : "未启动"} ${info.gateway?.baseUrl ?? ""}`);
    if (info.error) opts.log(`⚠️ ${info.error}`);
  }
  return info;
}

async function cmdTodayChat(query, opts) {
  const body = await readStdinJson();
  const text = typeof query === "string" && query.trim() ? query : body.text;
  const model = opts.model ?? body.model ?? null;
  const result = await todayChat({ text, model });
  if (!opts.json) {
    opts.log(`\n${result.model ?? "Today"}:`);
    opts.log(result.reply);
  }
  return result;
}

async function cmdTodayServe(opts) {
  const port = opts.port ?? todayPort();
  const apiKey = todayGatewayToken();
  const { server, client } = await serveTodayGateway({ port, apiKey });
  const address = server.address();
  console.log(JSON.stringify({
    ok: true,
    command: "today-serve",
    port: typeof address === "object" && address ? address.port : port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    ...(opts.secrets ? { apiKey } : {}),
  }));
  const shutdown = () => {
    try { client.close(); } catch { /* 忽略 */ }
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await new Promise(() => {});
}

async function cmdWatch(opts) {
  await watchConfig({
    intervalMs: 800,
    scope: opts.scope,
    drainTimeoutMs: opts.drainMs,
    dryRun: opts.dryRun,
    hard: opts.hard,
    syncRemote: opts.remote,
    json: opts.json,
    log: opts.json
      ? (line) => process.stdout.write(`${JSON.stringify({ event: "log", message: line })}\n`)
      : console.log,
  });
  return null;
}

function cmdDoctor(opts) {
  const { log } = opts;
  log("\n🩺 环境检查\n");
  const checks = [];
  const db = ccSwitchDbPath();
  checks.push({ ok: existsSync(db), label: `cc-switch 数据库: ${db}` });
  const cfg = codexConfigPath();
  checks.push({ ok: existsSync(cfg), label: `Codex 配置: ${cfg}` });
  const nodeVer = process.versions.node;
  checks.push({ ok: Number(nodeVer.split(".")[0]) >= 18, label: `Node.js: v${nodeVer}` });
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    checks.push({ ok: true, label: "sqlite3 CLI: 可用" });
  } catch {
    checks.push({ ok: false, label: "sqlite3 CLI: 不可用（macOS 自带，若缺失请 brew install sqlite）" });
  }
  const bin = findCodexBinary();
  checks.push({ ok: !!bin, label: `codex 二进制: ${bin ?? "未找到"}` });
  const remotes = loadRemotes();
  checks.push({
    ok: remotes.length > 0,
    label: remotes.length
      ? `远程主机: ${remotes.map((item) => item.label).join(", ")}（SSH 密钥走 ~/.ssh/config）`
      : "远程主机: 未配置 src/remotes.json",
  });
  const { appServers, tuis } = discoverCodexProcesses();
  checks.push({ ok: true, label: `运行中的 app-server: ${appServers.length} 个` });
  if (tuis.length) checks.push({ ok: true, label: `终端 codex 会话: ${tuis.length} 个（切换后需自行重启）` });

  const projectState = projectStateReport();
  if (projectState.ok) {
    checks.push({
      ok: !projectState.needsRepair,
      label: projectState.needsRepair
        ? `Codex 项目状态被寄存（${projectState.active.projects} 个活动 / 快照 ${projectState.snapshots[0]?.projects ?? 0} 个）→ 退出 Codex 后运行 ai-toolbox repair-projects`
        : `Codex 项目状态: ${projectState.active.projects} 个项目 / ${projectState.active.assignments} 条归属`,
    });
  }

  for (const c of checks) log(`  ${c.ok ? "✅" : "❌"} ${c.label}`);
  const failed = checks.filter((c) => !c.ok).length;
  log(failed ? `\n有 ${failed} 项需要处理。` : "\n一切就绪。");
  return { command: "doctor", checks, failed };
}

async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function cmdGoKeys(opts) {
  return { command: "go-keys", keys: listKeys({ includeSecrets: opts.secrets }) };
}

async function cmdGoKeysAdd(opts) {
  const body = await readStdinJson();
  const plan = body.plan === "plus" ? "plus" : "go";
  const entries = body.text != null ? parseKeyText(body.text) : [{ name: body.name, key: body.key }];
  const result = addKeys(entries, plan, { includeSecrets: opts.secrets });
  return { command: "go-keys-add", keys: result.keys, added: result.added };
}

function cmdGoKeysRemove(id, opts) {
  if (!id) throw new Error("用法: ai-toolbox go-keys-remove <id>");
  return { command: "go-keys-remove", keys: removeKey(id, { includeSecrets: opts.secrets }) };
}

function cmdGoKeysPlan(id, plan, opts) {
  if (!id || !plan) throw new Error("用法: ai-toolbox go-keys-plan <id> <go|plus>");
  return { command: "go-keys-plan", keys: setPlan(id, plan, { includeSecrets: opts.secrets }) };
}

async function cmdGrokStatus(opts) {
  const info = await grokStatus({ includeSecrets: opts.secrets });
  if (!opts.json) {
    if (info.email) opts.log(`\nGrok Bot: ${info.email}`);
    opts.log(`网关: ${info.gateway?.running ? "运行中" : "未启动"} ${info.gateway?.baseUrl ?? ""}`);
    for (const agent of info.agents ?? []) opts.log(`  ${agent.name}  ${agent.legacyAgentId ?? agent.id}`);
    if (info.error) opts.log(`⚠️ ${info.error}`);
  }
  return info;
}

async function cmdGrokChat() {
  const body = await readStdinJson();
  const result = await completeChat({ model: body.model, text: body.text, messages: body.messages });
  return { command: "grok-chat", ...result };
}

async function cmdGrokServe() {
  const server = await startServer();
  const address = server.address();
  console.log(JSON.stringify({ ok: true, command: "grok-serve", port: address.port, baseUrl: `http://127.0.0.1:${address.port}/v1` }));
  await new Promise(() => {});
}

function cmdClineKeys(opts) {
  return { command: "cline-keys", keys: listClineKeys({ includeSecrets: opts.secrets }) };
}

async function cmdClineKeysAdd(opts) {
  const body = await readStdinJson();
  const entries = body.text != null ? parseClineKeyText(body.text) : [{ name: body.name, key: body.key }];
  const result = addClineKeys(entries, { includeSecrets: opts.secrets });
  return { command: "cline-keys-add", keys: result.keys, added: result.added };
}

function cmdClineKeysRemove(id, opts) {
  if (!id) throw new Error("用法: ai-toolbox cline-keys-remove <id>");
  return { command: "cline-keys-remove", keys: removeClineKey(id, { includeSecrets: opts.secrets }) };
}

async function cmdGoKeysUse(id) {
  if (!id) throw new Error("用法: ai-toolbox go-keys-use <id>");
  return applySelectedKey(id);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scope: { type: "string", default: "chatgpt" },
      drain: { type: "string" },
      hard: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "no-reload": { type: "boolean", default: false },
      "no-remote": { type: "boolean", default: false },
      "no-model-probe": { type: "boolean", default: false },
      "no-sync-remote": { type: "boolean", default: false },
      "no-latest": { type: "boolean", default: false },
      "no-download": { type: "boolean", default: false },
      codex: { type: "boolean", default: false },
      ccswitch: { type: "boolean", default: false },
      timeout: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "with-secrets": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      host: { type: "string", multiple: true },
      focus: { type: "boolean" },
      "no-focus": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      model: { type: "string" },
      thinking: { type: "string" },
      topic: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      action: { type: "string" },
    },
  });

  const json = values.json;
  const { log, warn, progress } = makeLogger(json);
  let currentPhase = "启动";
  const opts = {
    json,
    log: json ? log : console.log,
    warn: json ? warn : console.log,
    scope: ["all", "chatgpt-all", "chatgpt"].includes(values.scope) ? values.scope : "chatgpt",
    drainMs: values.drain ? Math.max(0, Number(values.drain)) * 1000 : 8000,
    reload: !values["no-reload"],
    remote: !values["no-remote"],
    modelProbe: !values["no-model-probe"],
    syncRemoteAfterSwitch: !values["no-sync-remote"],
    latest: !values["no-latest"],
    download: !values["no-download"],
    codex: values.codex || !values.ccswitch,
    ccswitch: values.ccswitch || !values.codex,
    timeoutMs: values.timeout ? Math.max(10, Number(values.timeout)) * 1000 : 120000,
    setPhase: (name) => {
      currentPhase = name;
    },
    progress,
    hard: values.hard,
    force: values.force,
    dryRun: values["dry-run"],
    secrets: values["with-secrets"],
    focus: values["no-focus"] ? false : values.focus !== false,
    hosts: values.host ?? [],
    model: values.model,
    thinking: values.thinking,
    topic: values.topic,
    port: values.port ? Number(values.port) : null,
    host: values.host,
    action: values.action,
  };

  const [command, arg] = positionals;
  if (!values.timeout) {
    const defaults = {
      "remote-update": 1800 * 1000,
      "remote-versions": 300 * 1000,
      "sync-remote": 300 * 1000,
      "sync-ccswitch": 600 * 1000,
      "claude-switch": 300 * 1000,
      "claude-sync-remote": 300 * 1000,
    };
    opts.timeoutMs = defaults[command] ?? 120 * 1000;
  }
  if (values.help || !command) {
    if (json) console.log(JSON.stringify({ command: "help", text: HELP }));
    else console.log(HELP);
    return;
  }

  // 长驻命令不设总超时；其余命令超时后明确报出卡在哪个阶段，避免界面一直转圈。
  const LONG_RUNNING = new Set(["watch", "today-serve", "grok-serve", "net-speed"]);
  if (!LONG_RUNNING.has(command)) {
    currentPhase = command;
    const watchdog = setTimeout(() => {
      const message = `命令超时（${Math.round(opts.timeoutMs / 1000)}s），卡在阶段：${currentPhase}`;
      if (json) {
        console.log(JSON.stringify({ ok: false, error: message, phase: currentPhase, timeout: true }));
      } else {
        console.error(`\n❌ ${message}`);
        console.error(`   config.toml 已按原子写落盘；可运行 ai-toolbox current 查看当前状态，或重试。`);
      }
      process.exit(1);
    }, opts.timeoutMs);
    watchdog.unref?.();
  }

  let result;
  switch (command) {
    case "list":
      result = await cmdList(opts);
      break;
    case "current":
      result = await cmdCurrent(opts);
      break;
    case "switch":
      if (!arg) throw new Error("用法: ai-toolbox switch <名称/ID>");
      result = await cmdSwitch(arg, opts);
      break;
    case "reload":
      result = await cmdReload(opts);
      break;
    case "project-state":
      result = await cmdProjectState(opts);
      break;
    case "repair-projects":
      result = cmdRepairProjects(opts);
      break;
    case "sync-remote":
      result = await cmdSyncRemote(opts);
      break;
    case "claude-list":
      result = cmdClaudeList(opts);
      break;
    case "claude-current":
      result = cmdClaudeCurrent(opts);
      break;
    case "claude-sync-remote":
      result = await cmdClaudeSyncRemote(opts);
      break;
    case "cdesktop-list":
      result = cmdClaudeDesktopList(opts);
      break;
    case "cdesktop-current":
      result = cmdClaudeDesktopCurrent(opts);
      break;
    case "cdesktop-switch":
      if (!arg) throw new Error("用法: ai-toolbox cdesktop-switch <名称/ID>");
      result = await cmdClaudeDesktopSwitch(arg, opts);
      break;
    case "claude-switch":
      if (!arg) throw new Error("用法: ai-toolbox claude-switch <名称/ID>");
      result = await cmdClaudeSwitch(arg, opts);
      break;
    case "remote-versions":
      result = await cmdRemoteVersions(opts);
      break;
    case "remote-update":
      result = await cmdRemoteUpdate(opts);
      break;
    case "remote-status":
      result = await cmdRemoteStatus(opts);
      break;
    case "sync-ccswitch":
      result = await cmdSyncCcSwitch(opts);
      break;
    case "ccswitch-fingerprint":
      result = cmdCcSwitchFingerprint();
      break;
    case "watch":
      result = await cmdWatch(opts);
      break;
    case "iq-list":
      result = await cmdIqList(opts);
      break;
    case "iq-run":
      if (!arg) throw new Error("用法: ai-toolbox iq-run <供应商> --model <模型>");
      result = await cmdIqRun(arg, opts);
      break;
    case "go-keys":
      result = cmdGoKeys(opts);
      if (!json) for (const key of result.keys) log(`${key.name}  …${key.tail}  ${key.plan}`);
      break;
    case "go-keys-add":
      result = await cmdGoKeysAdd(opts);
      break;
    case "go-keys-remove":
      result = cmdGoKeysRemove(arg, opts);
      break;
    case "go-keys-plan":
      result = cmdGoKeysPlan(arg, positionals[2], opts);
      break;
    case "go-keys-use":
      result = await cmdGoKeysUse(arg);
      break;
    case "go-quota":
      result = await queryAll({ includeSecrets: opts.secrets });
      if (!json) {
        for (const key of result.keys) {
          if (!key.ok) {
            log(`${key.name} …${key.tail} 查询失败: ${key.error}`);
            continue;
          }
          const parts = ["rolling", "weekly", "monthly"].map((name) => {
            const window = key.windows?.[name];
            return window ? `${name} ${window.percent}%` : `${name} -`;
          });
          log(`${key.name} …${key.tail}  ${parts.join(" · ")}`);
        }
      }
      break;
    case "cline-keys":
      result = cmdClineKeys(opts);
      if (!json) for (const key of result.keys) log(`${key.name}  …${key.tail}`);
      break;
    case "cline-keys-add":
      result = await cmdClineKeysAdd(opts);
      break;
    case "cline-keys-remove":
      result = cmdClineKeysRemove(arg, opts);
      break;
    case "cline-quota":
      result = await queryClineQuota({ includeSecrets: opts.secrets });
      if (!json) {
        for (const key of result.keys) {
          if (!key.ok) {
            log(`${key.name} …${key.tail} 查询失败: ${key.error}`);
            continue;
          }
          const parts = ["rolling", "weekly", "monthly"].map((name) => {
            const window = key.windows?.[name];
            return window ? `${name} ${window.percent}%` : `${name} -`;
          });
          log(`${key.name} …${key.tail}  余额 ${key.balance ?? "-"}  ${parts.join(" · ")}`);
        }
      }
      break;
    case "grok-status":
      result = await cmdGrokStatus(opts);
      break;
    case "grok-chat":
      result = await cmdGrokChat();
      break;
    case "grok-serve":
      await cmdGrokServe();
      return;
    case "net-info":
      result = await networkInfo();
      break;
    case "net-speed":
      await runSpeedTest((event) => console.log(JSON.stringify(event)));
      return;
    case "qoder-status":
      result = await cmdQoderStatus(opts);
      break;
    case "qoder-fix":
      result = await cmdQoderFix(opts);
      break;
    case "qoder-restore":
      result = await cmdQoderRestore(opts);
      break;
    case "qoder-restart":
      result = await restartQoder();
      break;
    case "qoder-open":
      result = await openQoder();
      break;
    case "qoder-httpdns":
      result = await cmdQoderHttpdns(arg, opts);
      break;
    case "qoder-remote-status":
      result = await cmdQoderRemoteStatus(opts);
      break;
    case "qoder-remote-action":
      result = await cmdQoderRemoteAction(opts);
      break;
    case "today-status":
      result = await cmdTodayStatus(opts);
      break;
    case "today-models":
      result = await todayModels();
      if (!json) {
        for (const model of result.models ?? []) log(`${model.id}  ${model.title ?? ""}`);
      }
      break;
    case "today-chat":
      result = await cmdTodayChat(arg, opts);
      break;
    case "today-model":
      if (!arg) throw new Error("用法: ai-toolbox today-model <模型ID>");
      result = await todaySetModel(arg);
      break;
    case "today-launch":
      result = { command: "today-launch", ...(await launchTodayWithDebugPort()) };
      break;
    case "today-serve":
      await cmdTodayServe(opts);
      return;
    case "doctor":
      result = cmdDoctor(opts);
      break;
    default:
      throw new Error(`未知命令: ${command}`);
  }

  if (json && result != null) {
    console.log(JSON.stringify({ ok: true, ...result }));
  }
}

main().catch((err) => {
  const json = process.argv.includes("--json");
  if (json) console.log(JSON.stringify({ ok: false, error: String(err.message ?? err) }));
  else console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
