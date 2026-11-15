import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inspectProviderAuth,
  guardProviderAuth,
  explainProviderAuth,
} from "../src/codex-provider-guard.mjs";

function withConfig(text) {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-test-"));
  const file = path.join(dir, "config.toml");
  writeFileSync(file, text);
  return { file, dir };
}

const RELAY = `model_provider = "custom"
[model_providers.custom]
name = "梦汐中转站"
base_url = "https://api.mengxiapi.com/v1"
requires_openai_auth = true
experimental_bearer_token = "sk-x"
`;

test("inspectProviderAuth flags a relay with requires_openai_auth=true", () => {
  const { file, dir } = withConfig(RELAY);
  try {
    const r = inspectProviderAuth(file);
    assert.equal(r.ok, true);
    assert.equal(r.needsFix, true);
    assert.equal(r.autoFixable, true);
    assert.match(explainProviderAuth(r.provider), /借用 ChatGPT 账号/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guardProviderAuth dry inspection does not touch the file", () => {
  const { file, dir } = withConfig(RELAY);
  try {
    const r = guardProviderAuth({ configPath: file, fix: false });
    assert.equal(r.needsFix, true);
    assert.equal(r.changed, false);
    assert.equal(readFileSync(file, "utf8"), RELAY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guardProviderAuth --fix rewrites the live config", () => {
  const { file, dir } = withConfig(RELAY);
  try {
    const r = guardProviderAuth({ configPath: file, fix: true });
    assert.equal(r.fixed, true);
    const text = readFileSync(file, "utf8");
    assert.match(text, /requires_openai_auth = false/);
    assert.equal(/requires_openai_auth = true/.test(text), false);
    // 其他字段原样保留
    assert.match(text, /experimental_bearer_token = "sk-x"/);
    assert.equal(inspectProviderAuth(file).needsFix, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guardProviderAuth refuses to rewrite a relay without its own credential", () => {
  const config = `model_provider = "custom"
[model_providers.custom]
name = "OAuth Relay"
base_url = "https://oauth-relay.example.com/v1"
requires_openai_auth = true
`;
  const { file, dir } = withConfig(config);
  try {
    const r = guardProviderAuth({ configPath: file, fix: true });
    assert.equal(r.needsFix, true);
    assert.equal(r.autoFixable, false);
    assert.equal(r.blocked, true);
    assert.equal(readFileSync(file, "utf8"), config);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guardProviderAuth leaves OpenAI-backed providers alone", () => {
  const config = `model_provider = "custom"
[model_providers.custom]
base_url = "https://chatgpt.com/backend-api"
requires_openai_auth = true
`;
  const { file, dir } = withConfig(config);
  try {
    const r = guardProviderAuth({ configPath: file, fix: true });
    assert.equal(r.needsFix, false);
    assert.equal(readFileSync(file, "utf8"), config);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing config is reported, not thrown", () => {
  const r = inspectProviderAuth("/nonexistent/config.toml");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-config");
});
