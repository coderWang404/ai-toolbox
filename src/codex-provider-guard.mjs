// 供应商鉴权守卫：第三方供应商不能带 requires_openai_auth = true。
//
// 这一行由 Codex 桌面端解释成"这个供应商使用 OpenAI 登录态"：
//   account/read 会返回 ChatGPT 账号（planType / workspaceName / workspaceRouting）
//   桌面端身份从 "signed-out" 变成 sha256([userId, accountId])
//   → 按身份寄存的侧边栏状态（远端对话、项目展开、最近文件）全部读不到
//   → 账号菜单、部分请求也会落到 ChatGPT 后台上
// 切换供应商的工具（cc-switch 界面、手工编辑）不一定写对，所以这里做统一体检与修复。
//
// 判定规则：
//   - 官方保留 id（openai / ollama / ...）不动
//   - base_url 指向 OpenAI / ChatGPT 后端的不动（那种供应商确实要用登录态）
//   - 其余第三方供应商一律要求 false；只有它自己带了凭证（bearer / env_key /
//     auth 段 / Authorization 头）时才自动改，避免把"靠 ChatGPT 登录的中转"改坏
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { codexConfigPath } from "./paths.mjs";
import { forceProviderAuthLocal, providerAuthState } from "./toml-edit.mjs";

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.guard-${process.pid}`);
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, filePath);
}

function analyze(provider) {
  const needsFix = Boolean(
    provider && !provider.reserved && !provider.openAiBackend && provider.requiresOpenaiAuth,
  );
  return {
    needsFix,
    autoFixable: needsFix && Boolean(provider.hasBearerToken || provider.hasOwnAuth),
  };
}

/**
 * 体检当前生效配置。
 * @returns {{ok:boolean, reason?:string, provider?:object, needsFix:boolean, autoFixable:boolean}}
 */
export function inspectProviderAuth(configPath = codexConfigPath()) {
  if (!existsSync(configPath)) {
    return { ok: false, reason: "no-config", needsFix: false, autoFixable: false };
  }
  const text = readFileSync(configPath, "utf8");
  const provider = providerAuthState(text);
  if (!provider) {
    return { ok: false, reason: "no-provider-table", needsFix: false, autoFixable: false };
  }
  return { ok: true, provider, ...analyze(provider) };
}

/**
 * 体检并可修复。
 * @returns {{ok:boolean, reason?:string, provider?:object, needsFix:boolean,
 *            autoFixable:boolean, fixed:boolean, changed:boolean, blocked?:boolean}}
 */
export function guardProviderAuth({ configPath = codexConfigPath(), fix = false, log = null } = {}) {
  const inspected = inspectProviderAuth(configPath);
  if (!inspected.ok || !inspected.needsFix) {
    return { ...inspected, fixed: false, changed: false };
  }
  if (!inspected.autoFixable) {
    if (log && fix) {
      log(
        `  ⚠️  「${inspected.provider?.name ?? inspected.provider?.providerId}」requires_openai_auth=true，` +
          "但它没有自带凭证；为避免改坏登录方式，未自动修改",
      );
    }
    return { ...inspected, fixed: false, changed: false, blocked: true };
  }
  if (!fix) return { ...inspected, fixed: false, changed: false };

  const text = readFileSync(configPath, "utf8");
  const { text: next, changed } = forceProviderAuthLocal(text);
  if (changed) {
    writeAtomic(configPath, next);
    if (log) {
      const name = inspected.provider?.name ?? inspected.provider?.providerId ?? "当前供应商";
      log(`  已修正「${name}」的 requires_openai_auth → false`);
    }
  }
  return { ...inspected, fixed: changed, changed };
}

/** 给 UI 用的一句话说明。 */
export function explainProviderAuth(provider) {
  if (!provider) return "";
  const name = provider.name ?? provider.providerId;
  if (provider.reserved) return `${name}：官方供应商，使用 ChatGPT 登录态`;
  if (provider.openAiBackend) return `${name}：指向 OpenAI 后端，使用 ChatGPT 登录态`;
  if (!provider.requiresOpenaiAuth) return `${name}：第三方供应商，只带自己的凭证`;
  return `${name}：requires_openai_auth=true，会借用 ChatGPT 账号（侧边栏远端对话会被隐藏）`;
}
