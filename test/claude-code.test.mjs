import test from "node:test";
import assert from "node:assert/strict";
import { mergeClaudeSettings } from "../src/claude-code.mjs";

test("供应商卡片覆盖同名顶层键，保留用户自己的设置", () => {
  const live = { env: { OLD: "1" }, theme: "dark", skipDangerousModePermissionPrompt: false };
  const provider = {
    env: { ANTHROPIC_BASE_URL: "https://relay.example", ANTHROPIC_AUTH_TOKEN: "sk-x" },
    modelSettings: { temperature: 0.2 },
  };
  const next = mergeClaudeSettings(live, provider);
  assert.equal(next.theme, "dark"); // 用户设置保留
  assert.deepEqual(next.env, { ANTHROPIC_BASE_URL: "https://relay.example", ANTHROPIC_AUTH_TOKEN: "sk-x" });
  assert.deepEqual(next.modelSettings, { temperature: 0.2 });
});

test("env 整块替换，不残留上一个供应商的键", () => {
  const live = { env: { ANTHROPIC_BASE_URL: "https://old", ANTHROPIC_MODEL: "claude-old" } };
  const provider = { env: { ANTHROPIC_BASE_URL: "https://new" } };
  const next = mergeClaudeSettings(live, provider);
  assert.deepEqual(next.env, { ANTHROPIC_BASE_URL: "https://new" });
});

test("空输入不报错", () => {
  assert.deepEqual(mergeClaudeSettings(null, null), {});
  assert.deepEqual(mergeClaudeSettings({ theme: "dark" }, {}), { theme: "dark" });
});
