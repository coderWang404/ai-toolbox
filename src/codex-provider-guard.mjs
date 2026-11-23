// 供应商配置守卫：第三方中转不该带的字段，统一体检与修复。
//
// 目前守两类问题，都是"Codex 默认会写、但中转不认"的：
//
// 1) requires_openai_auth = true
//    Codex 会把它解释成"这个供应商使用 OpenAI 登录态"：
//    account/read 返回 ChatGPT 账号、桌面端身份从 signed-out 变成
//    sha256([userId, accountId])，按身份寄存的侧边栏状态（远端对话、项目展开、
//    最近文件）全部读不到；bearer 一旦缺失还会把 ChatGPT OAuth token 发到中转。
//
// 2) 联网检索（web_search）默认开启
//    Codex 默认声明 {"type":"web_search","external_web_access":true}。部分中转
//    （实测梦汐 /v1/responses）直接 400：
//    `basispoints_request_invalid: 该托管工具需要原生通道；请使用原生账号，或移除不支持的声明`
//    换成 web_search = "disabled" 后不再声明该工具，请求恢复正常。
//
// 判定规则：
//   - 官方保留 id（openai / ollama / ...）不动
//   - base_url 指向 OpenAI / ChatGPT 后端的不动（那种供应商确实要用登录态与联网）
//   - 其余第三方供应商：关闭 requires_openai_auth；关闭联网检索
//   - 只有供应商自带凭证（bearer / env_key / auth 段 / Authorization 头）时才自动
//     改 requires_openai_auth，避免把"靠 ChatGPT 登录的中转"改坏
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { codexConfigPath } from "./paths.mjs";
import {
  disableWebSearch,
  forceProviderAuthLocal,
  providerAuthState,
  webSearchDisabled,
} from "./toml-edit.mjs";

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.guard-${process.pid}`);
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, filePath);
}

function isThirdParty(provider) {
  return Boolean(provider && !provider.reserved && !provider.openAiBackend);
}

function analyze(provider, text) {
  const thirdParty = isThirdParty(provider);
  const authNeedsFix = Boolean(thirdParty && provider.requiresOpenaiAuth);
  const searchNeedsFix = Boolean(thirdParty && !webSearchDisabled(text));
  return {
    needsFix: authNeedsFix || searchNeedsFix,
    authNeedsFix,
    searchNeedsFix,
    autoFixable: authNeedsFix
      ? Boolean(provider.hasBearerToken || provider.hasOwnAuth) || searchNeedsFix
      : searchNeedsFix,
  };
}

/**
 * 体检当前生效配置。
 * @returns {{ok:boolean, reason?:string, provider?:object, needsFix:boolean,
 *            authNeedsFix:boolean, searchNeedsFix:boolean, autoFixable:boolean}}
 */
export function inspectProviderAuth(configPath = codexConfigPath()) {
  const empty = { needsFix: false, authNeedsFix: false, searchNeedsFix: false, autoFixable: false };
  if (!existsSync(configPath)) {
    return { ok: false, reason: "no-config", ...empty };
  }
  const text = readFileSync(configPath, "utf8");
  const provider = providerAuthState(text);
  if (!provider) {
    return { ok: false, reason: "no-provider-table", ...empty };
  }
  return { ok: true, provider, ...analyze(provider, text) };
}

/**
 * 体检并可修复。
 * @returns {{ok:boolean, reason?:string, provider?:object, needsFix:boolean,
 *            authNeedsFix:boolean, searchNeedsFix:boolean, autoFixable:boolean,
 *            fixed:boolean, changed:boolean, blocked?:boolean, applied:string[]}}
 */
export function guardProviderAuth({ configPath = codexConfigPath(), fix = false, log = null } = {}) {
  const inspected = inspectProviderAuth(configPath);
  const none = { fixed: false, changed: false, applied: [] };
  if (!inspected.ok || !inspected.needsFix) return { ...inspected, ...none };

  const name = inspected.provider?.name ?? inspected.provider?.providerId ?? "当前供应商";
  if (!fix) return { ...inspected, ...none };

  const blockedByAuth = inspected.authNeedsFix && !inspected.provider?.hasBearerToken && !inspected.provider?.hasOwnAuth;
  let text = readFileSync(configPath, "utf8");
  const applied = [];

  if (inspected.searchNeedsFix) {
    const result = disableWebSearch(text);
    if (result.changed) {
      text = result.text;
      applied.push("web_search");
    }
  }

  if (inspected.authNeedsFix && !blockedByAuth) {
    const result = forceProviderAuthLocal(text);
    if (result.changed) {
      text = result.text;
      applied.push("requires_openai_auth");
    }
  }

  if (applied.length) writeAtomic(configPath, text);
  if (log) {
    if (applied.includes("requires_openai_auth")) {
      log(`  已修正「${name}」的 requires_openai_auth → false`);
    }
    if (applied.includes("web_search")) {
      log(`  已关闭「${name}」的联网检索声明（web_search = "disabled"），避免中转整轮拒绝`);
    }
    if (blockedByAuth) {
      log(`  ⚠️  「${name}」requires_openai_auth=true，但它没有自带凭证；为避免改坏登录方式，未自动修改`);
    }
  }

  return {
    ...inspected,
    fixed: applied.length > 0,
    changed: applied.length > 0,
    blocked: blockedByAuth,
    applied,
  };
}

/** 给 UI 用的一句话说明。 */
export function explainProviderAuth(provider, { webSearchDisabled: searchOff = false } = {}) {
  if (!provider) return "";
  const name = provider.name ?? provider.providerId;
  const searchNote = searchOff ? "，联网检索已关闭" : "";
  if (provider.reserved) return `${name}：官方供应商，使用 ChatGPT 登录态`;
  if (provider.openAiBackend) return `${name}：指向 OpenAI 后端，使用 ChatGPT 登录态`;
  if (!provider.requiresOpenaiAuth) return `${name}：第三方供应商，只带自己的凭证${searchNote}`;
  return `${name}：requires_openai_auth=true，会借用 ChatGPT 账号（侧边栏远端对话会被隐藏）`;
}
