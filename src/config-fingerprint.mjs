// 供应商指纹：只提取「切换供应商真正需要重启 app-server」的那部分配置。
//
// 为什么不能直接 hash 整个 config.toml：Codex 应用每次启动 app-server 都会重写
// [mcp_servers.node_repl.*]、tui、plugins 等段落（版本号、能力开关会变），
// 整文件 hash 一变，监听器就再触发一次热重启 —— 于是切换一次供应商会进入
// 「重启 → 应用改写 config → 又重启」的死循环。

const PROVIDER_TOP_KEYS = new Set([
  "model",
  "model_provider",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "model_context_window",
  "model_auto_compact_token_limit",
  "model_post_turn_compact_threshold_percent",
  "model_catalog_json",
  "service_tier",
  "disable_response_storage",
  "personality",
  "profile",
  "forced_login_method",
  "forced_chatgpt_workspace_id",
]);

const PROVIDER_TABLE = /^model_providers(\s*$|\s*\.)/;

/**
 * 提取与供应商标识相关的配置片段：
 * 顶层 provider/model 键 + 所有 [model_providers.*] 表。
 * 忽略 desktop / marketplaces / plugins / projects / mcp_servers / tui 等应用自管段落。
 */
export function providerFingerprint(text) {
  if (typeof text !== "string") return null;
  const out = [];
  let inProviderTable = false;
  let inOtherTable = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      const name = header[1].trim();
      inProviderTable = PROVIDER_TABLE.test(name);
      inOtherTable = !inProviderTable;
      if (inProviderTable) out.push(`[${name}]`);
      continue;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (inProviderTable) {
      out.push(trimmed);
      continue;
    }
    if (inOtherTable) continue;
    if (/^[ \t]/.test(rawLine)) continue; // 缩进行属于某个表
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (PROVIDER_TOP_KEYS.has(key)) out.push(trimmed);
  }
  return out.join("\n");
}

/** 只看指纹里的 provider 名与端点，日志/提示用。 */
export function providerSummaryFromText(text) {
  const slice = providerFingerprint(text) ?? "";
  const providerId = /^model_provider\s*=\s*"([^"]+)"/m.exec(slice)?.[1] ?? null;
  const baseUrl = /^\s*base_url\s*=\s*"([^"]+)"/m.exec(slice)?.[1] ?? null;
  const model = /^model\s*=\s*"([^"]+)"/m.exec(slice)?.[1] ?? null;
  return { providerId, baseUrl, model };
}
