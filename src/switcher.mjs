// 切换供应商：生成配置 → 校验 → 原子写入 → 同步 cc-switch 状态。
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, chmodSync } from "node:fs";
import path from "node:path";
import {
  codexConfigPath,
  codexHome,
  ccSwitchCatalogPath,
  CHATGPT_CODEX_BIN,
} from "./paths.mjs";
import { injectBearerToken, setCatalogJsonField } from "./toml-edit.mjs";
import { mergeCommonConfig, isCommonConfigSubset, extractSections, stripSections } from "./common-config.mjs";
import { buildCatalog } from "./catalog.mjs";
import { fetchProviderModels, buildCatalogFromModelIds } from "./model-catalog.mjs";
import { findCodexBinary, readEffectiveConfig } from "./verify-client.mjs";

const OFFICIAL_IDS = new Set(["codex-official"]);

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** 写文件：同目录临时文件 + rename，保证原子性。 */
function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, filePath);
}

/**
 * 判断该供应商是否启用 cc-switch 的"通用配置"合并
 * （对应 cc-switch provider_uses_common_config）。
 */
function providerUsesCommonConfig(provider, commonConfig) {
  if (!commonConfig?.trim()) return false;
  const explicit = provider.meta?.commonConfigEnabled;
  if (explicit !== undefined) return explicit === true;
  return isCommonConfigSubset(provider.config, commonConfig);
}

/**
 * 应用自身会往 config.toml 里持久化界面级配置（[desktop]、[marketplaces]、
 * [plugins]、项目信任 [projects.*]）。供应商存档里往往是旧快照，
 * 这里用 live 配置补齐，避免切换后丢失应用设置。
 */
const APP_MANAGED_NAMESPACES = ["desktop", "marketplaces", "plugins", "projects"];

/**
 * 依据 provider 记录生成最终的 config.toml 文本。
 * 顺序与 cc-switch 一致：provider config → 通用配置合并 → bearer token → catalog 字段；
 * 另外用 live 配置补齐应用管理的 section。
 */
export function buildProviderConfig({ provider, commonConfig, apiFormat, liveConfigText = null, dryRun = false }) {
  if (!provider.config.trim()) {
    throw new Error(
      `供应商「${provider.name}」没有可用的 config 配置（可能是官方供应商，请用 cc-switch 界面切换）。`,
    );
  }

  let text = provider.config;

  // 1. 通用配置片段：cc-switch 在切换时"只合并、不剥离"
  //    （剥离只发生在供应商编辑界面取消勾选/legacy 迁移时）
  if (commonConfig && providerUsesCommonConfig(provider, commonConfig)) {
    try {
      text = mergeCommonConfig(text, commonConfig);
    } catch (err) {
      throw new Error(`通用配置合并失败: ${err.message}`);
    }
  }

  // 2. 继承 live 配置里由应用管理的 section（desktop / marketplaces / plugins）
  if (liveConfigText) {
    const inherited = extractSections(liveConfigText, APP_MANAGED_NAMESPACES);
    // live 是应用自己维护的界面级配置：整体覆盖供应商存档里的旧快照，
    // 而不是只增不删（用户在应用里删掉的键不应该被旧配置复活）。
    if (inherited) text = mergeCommonConfig(stripSections(text, APP_MANAGED_NAMESPACES), inherited);
  }

  // 2. bearer token（来自 provider.auth.OPENAI_API_KEY）
  const token =
    typeof provider.auth?.OPENAI_API_KEY === "string" && provider.auth.OPENAI_API_KEY.trim()
      ? provider.auth.OPENAI_API_KEY.trim()
      : null;
  if (token) text = injectBearerToken(text, token);

  // 3. 模型目录
  const catalog = buildCatalog({
    settings: { modelCatalog: provider.modelCatalog },
    configText: text,
    apiFormat,
    isOfficial: false,
  });
  if (catalog) {
    if (!dryRun) writeAtomic(ccSwitchCatalogPath(), `${JSON.stringify(catalog, null, 2)}\n`);
    text = setCatalogJsonField(text, true);
  } else {
    text = setCatalogJsonField(text, false);
  }

  return { text, catalog };
}

/** 从 TOML 文本里取顶层键值（顶层键在 cc-switch 产物里都从第 0 列开始）。 */
function topLevelString(text, key) {
  const m = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m ? m[1] : null;
}

/** 取当前 model_provider 对应的 [model_providers.<id>] 表里的 base_url。 */
function providerBaseUrl(text) {
  const providerId = topLevelString(text, "model_provider");
  if (providerId) {
    const esc = providerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const header = new RegExp(`^\\s*\\[\\s*model_providers\\s*\\.\\s*(?:"${esc}"|${esc})\\s*\\]\\s*$`, "m");
    const match = header.exec(text);
    if (match) {
      const rest = text.slice(match.index + match[0].length);
      const end = rest.search(/^\s*\[/m);
      const body = end === -1 ? rest : rest.slice(0, end);
      const url = body.match(/^\s*base_url\s*=\s*"((?:[^"\\]|\\.)*)"/m);
      if (url) return url[1].replace(/\\"/g, '"');
    }
  }
  return text.match(/^\s*base_url\s*=\s*"((?:[^"\\]|\\.)*)"/m)?.[1] ?? null;
}

function providerToken(provider) {
  const fromAuth = typeof provider.auth?.OPENAI_API_KEY === "string" ? provider.auth.OPENAI_API_KEY.trim() : "";
  if (fromAuth) return fromAuth;
  const fromConfig = provider.config.match(/experimental_bearer_token\s*=\s*"([^"]+)"/)?.[1]?.trim();
  return fromConfig || null;
}

/**
 * 执行切换（不含重启）。
 * @returns {{backupPath: string|null, verified: boolean, effective: object|null, warnings: string[],
 *   timings: object, catalogSource: string, modelCount: number, modelProbe: object|null, reverted: object|null}}
 */
export async function switchProvider({
  provider,
  commonConfig,
  apiFormat,
  log = console.log,
  dryRun = false,
  probeModels = true,
}) {
  const configPath = codexConfigPath();
  const warnings = [];
  const timings = {};
  const startedAt = Date.now();

  const liveConfigText = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  let { text, catalog } = buildProviderConfig({
    provider,
    commonConfig,
    apiFormat,
    liveConfigText,
    dryRun,
  });
  timings.build = Date.now() - startedAt;

  let catalogSource = catalog ? "cc-switch" : "none";
  let modelCount = catalog?.models?.length ?? 0;
  let modelProbe = null;

  // cc-switch 里没有 modelCatalog 时（大多数第三方供应商都没有），
  // 直接问供应商的 /models，把真实模型写进 catalog —— 否则桌面端只有内置模型可选。
  if (!catalog && probeModels && !dryRun) {
    const baseUrl = providerBaseUrl(text);
    const token = providerToken(provider);
    if (baseUrl && token) {
      const probeStart = Date.now();
      modelProbe = await fetchProviderModels({ baseUrl, token, timeoutMs: 6000 });
      timings.modelProbe = Date.now() - probeStart;
      if (modelProbe.ok) {
        const built = buildCatalogFromModelIds(modelProbe.models, {
          configText: text,
          apiFormat,
          preferred: topLevelString(text, "model"),
        });
        if (built) {
          writeAtomic(ccSwitchCatalogPath(), `${JSON.stringify(built, null, 2)}\n`);
          text = setCatalogJsonField(text, true);
          catalogSource = "provider";
          modelCount = built.models.length;
        }
      } else {
        warnings.push(`供应商模型列表拉取失败（${modelProbe.error}），沿用 Codex 内置模型`);
      }
    }
  }

  log(`  目标供应商: ${provider.name} (${provider.id})`);
  if (modelCount > 0) {
    const source = catalogSource === "provider" ? "供应商 /models" : "cc-switch 配置";
    log(`  模型目录: ${modelCount} 个模型（来源: ${source}）`);
  }

  if (dryRun) {
    return {
      backupPath: null,
      verified: false,
      effective: null,
      warnings,
      preview: text,
      timings,
      catalogSource,
      modelCount,
      modelProbe,
      reverted: null,
    };
  }

  // 备份现有配置
  let backupPath = null;
  if (existsSync(configPath)) {
    backupPath = `${configPath}.bak_${timestamp()}`;
    copyFileSync(configPath, backupPath);
    try { chmodSync(backupPath, 0o600); } catch { /* 忽略 */ }
    log(`  已备份原配置: ${backupPath}`);
  }

  writeAtomic(configPath, text);
  timings.write = Date.now() - startedAt;
  log(`  已写入: ${configPath}`);

  // 写入后立刻回读：如果配置被外部程序（通常是运行中的 cc-switch）改回去了，直接说清楚。
  let reverted = null;
  {
    const after = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const liveProvider = topLevelString(after, "model_provider");
    const expectedProvider = topLevelString(text, "model_provider");
    const liveBase = after.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    const expectedBase = text.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    if (expectedProvider && liveProvider !== expectedProvider) {
      reverted = { expectedProvider, liveProvider };
    } else if (expectedBase && liveBase !== expectedBase) {
      reverted = { expectedBase, liveBase };
    }
    if (reverted) {
      warnings.push(
        `配置写入后又被改回去了（${reverted.expectedBase ?? reverted.expectedProvider} → ${reverted.liveBase ?? reverted.liveProvider}）。` +
          `多半是 cc-switch 正在运行并回填了卡片，请用 cc-switch 界面切换。`,
      );
      log(`  ⚠️  配置被外部改写，实际生效: ${reverted.liveBase ?? reverted.liveProvider}`);
    }
  }

  // 校验：用一次性 app-server 读取生效配置（12s 上限，失败只告警）
  const verifyStart = Date.now();
  const codexBin = findCodexBinary();
  if (!codexBin) {
    warnings.push("找不到 codex 二进制，跳过配置校验");
    timings.verify = Date.now() - verifyStart;
    return { backupPath, verified: false, effective: null, warnings, timings, catalogSource, modelCount, modelProbe, reverted };
  }
  const result = await readEffectiveConfig({ codexBin, codexHome: codexHome(), timeoutMs: 12000 });
  timings.verify = Date.now() - verifyStart;
  if (!result.ok) {
    warnings.push(`配置校验失败: ${result.error}（已写入的配置保留，可用备份回滚）`);
    return { backupPath, verified: false, effective: null, warnings, timings, catalogSource, modelCount, modelProbe, reverted };
  }

  const cfg = result.config;
  const effectiveProvider = cfg.model_provider ?? cfg.modelProvider ?? null;
  const effectiveModel = cfg.model ?? null;
  const providerTable =
    (effectiveProvider && (cfg.model_providers?.[effectiveProvider] ?? cfg.modelProviders?.[effectiveProvider])) ||
    null;
  log(`  生效配置: model_provider=${effectiveProvider} model=${effectiveModel}`);
  if (providerTable?.base_url) log(`  base_url: ${providerTable.base_url}`);

  // 校验 bearer token 是否随配置生效
  const token = provider.auth?.OPENAI_API_KEY?.trim();
  if (token && providerTable) {
    const effectiveToken = providerTable.experimental_bearer_token;
    if (!effectiveToken) {
      warnings.push("生效配置中未找到 experimental_bearer_token（可能该供应商使用其它鉴权方式）");
    } else if (effectiveToken !== token) {
      warnings.push("生效的 bearer token 与供应商配置不一致，请确认");
    } else {
      log(`  bearer token: 已生效 ✔`);
    }
  }

  // 校验 model 与供应商声明一致
  const expectedModel = (provider.config.match(/^\s*model\s*=\s*"([^"]+)"/m) ?? [])[1] ?? null;
  if (expectedModel && effectiveModel && expectedModel !== effectiveModel) {
    warnings.push(`生效模型 (${effectiveModel}) 与供应商声明 (${expectedModel}) 不一致（可能被其它配置层覆盖）`);
  }

  return {
    backupPath,
    verified: true,
    effective: {
      modelProvider: effectiveProvider,
      model: effectiveModel,
      baseUrl: providerTable?.base_url ?? null,
    },
    warnings,
    timings: { ...timings, total: Date.now() - startedAt },
    catalogSource,
    modelCount,
    modelProbe,
    reverted,
  };
}

export function isOfficialProvider(provider) {
  return OFFICIAL_IDS.has(provider.id);
}
