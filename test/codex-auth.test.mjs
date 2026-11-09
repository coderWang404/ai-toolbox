import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAuthPreserved, usesThirdPartyProvider } from "../src/codex-auth.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "ai-toolbox-auth-"));

const thirdPartyConfig = `model_provider = "custom"
model = "gpt-6.1-sol"

[model_providers.custom]
base_url = "https://relay.example/v1"
requires_openai_auth = false
`;

const officialConfig = `model_provider = "openai"

[model_providers.openai]
name = "OpenAI"
requires_openai_auth = true
`;

function setup({ withAuth = false, withStash = false, config = thirdPartyConfig } = {}) {
  const dir = tmp();
  const authPath = path.join(dir, "auth.json");
  const stashPath = path.join(dir, "stash.json");
  const configPath = path.join(dir, "config.toml");
  writeFileSync(configPath, config);
  if (withAuth) writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "live" } }));
  if (withStash) {
    writeFileSync(
      stashPath,
      JSON.stringify({
        version: 1,
        last: "sub:google|x|account:acct",
        logins: {
          "sub:google|x|account:acct": { auth_mode: "chatgpt", tokens: { access_token: "stashed" }, OPENAI_API_KEY: null },
        },
      }),
    );
  }
  return { dir, authPath, stashPath, configPath };
}

test("已有登录态时不动", () => {
  const { authPath, stashPath, configPath } = setup({ withAuth: true, withStash: true });
  const result = ensureAuthPreserved({ authPath, stashPath, configPath });
  assert.equal(result.action, "kept");
  assert.equal(JSON.parse(readFileSync(authPath, "utf8")).tokens.access_token, "live");
});

test("第三方供应商 + 登录态被收走时自动还原", () => {
  const { authPath, stashPath, configPath } = setup({ withStash: true });
  assert.equal(existsSync(authPath), false);
  const result = ensureAuthPreserved({ authPath, stashPath, configPath });
  assert.equal(result.action, "restored");
  const restored = JSON.parse(readFileSync(authPath, "utf8"));
  assert.equal(restored.tokens.access_token, "stashed");
});

test("官方供应商不瞎还原", () => {
  const { authPath, stashPath, configPath } = setup({ withStash: true, config: officialConfig });
  const result = ensureAuthPreserved({ authPath, stashPath, configPath });
  assert.equal(result.action, "skipped");
  assert.equal(result.reason, "official-provider");
});

test("没有暂存文件时安全跳过", () => {
  const { authPath, stashPath, configPath } = setup();
  const result = ensureAuthPreserved({ authPath, stashPath, configPath });
  assert.equal(result.action, "skipped");
  assert.equal(result.reason, "no-stash");
});

test("dry-run 不落盘", () => {
  const { authPath, stashPath, configPath } = setup({ withStash: true });
  const result = ensureAuthPreserved({ authPath, stashPath, configPath, dryRun: true });
  assert.equal(result.action, "would-restore");
  assert.equal(existsSync(authPath), false);
});

test("usesThirdPartyProvider 识别 requires_openai_auth", () => {
  const a = setup({ config: thirdPartyConfig });
  const b = setup({ config: officialConfig });
  assert.equal(usesThirdPartyProvider(a.configPath), true);
  assert.equal(usesThirdPartyProvider(b.configPath), false);
});
