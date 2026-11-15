import test from "node:test";
import assert from "node:assert/strict";
import { injectBearerToken, parseSectionHeader, setCatalogJsonField, tomlString, catalogJsonValue, providerAuthState, forceProviderAuthLocal, isOpenAiBackendUrl } from "../src/toml-edit.mjs";

test("tomlString escapes quotes, backslashes and newlines", () => {
  assert.equal(tomlString('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
});

test("parseSectionHeader handles quoted, nested and array tables", () => {
  assert.deepEqual(parseSectionHeader('[model_providers."my.id"]'), {
    path: ["model_providers", "my.id"],
    array: false,
  });
  assert.deepEqual(parseSectionHeader("[[plugins]]"), { path: ["plugins"], array: true });
});

test("token goes into the provider table and is escaped", () => {
  const config = `model_provider = "x"
[model_providers.x]
base_url = "https://example.com"
`;
  const out = injectBearerToken(config, 'a"b\\c');
  assert.match(out, /experimental_bearer_token = "a\\"b\\\\c"/);
  assert.ok(out.indexOf("experimental_bearer_token") > out.indexOf("[model_providers.x]"));
});

test("token stays in parent table, before child tables", () => {
  const config = `model_provider = "x"
[model_providers.x]
base_url = "https://example.com"
[model_providers.x.http_headers]
X-Test = "1"
`;
  const out = injectBearerToken(config, "tok");
  const parent = out.indexOf("[model_providers.x]");
  const child = out.indexOf("[model_providers.x.http_headers]");
  const token = out.indexOf("experimental_bearer_token");
  assert.ok(parent < token && token < child);
});

test("a child table Authorization suppresses token injection", () => {
  const config = `model_provider = "x"
[model_providers.x]
base_url = "https://example.com"
[model_providers.x.http_headers]
Authorization = "Bearer old"
`;
  assert.equal(injectBearerToken(config, "new"), config);
});

test("catalog field handles null and external values", () => {
  const withNull = `model_provider = "x"\nmodel_catalog_json = null\n`;
  assert.match(setCatalogJsonField(withNull, true), /model_catalog_json = "cc-switch-model-catalog\.json"/);
  assert.equal(setCatalogJsonField(withNull, false).includes("model_catalog_json"), false);

  const external = `model_provider = "x"\nmodel_catalog_json = "/tmp/my-catalog.json"\n`;
  assert.equal(setCatalogJsonField(external, true), external);
  assert.equal(setCatalogJsonField(external, false), external);
});

test("force rewrites a catalog pointer that cc-switch pinned to its own file", () => {
  const pinned = `model_provider = "x"\nmodel_catalog_json = "/Users/me/.codex/desktop-model-catalog.json"\n`;
  assert.equal(catalogJsonValue(pinned), "/Users/me/.codex/desktop-model-catalog.json");
  const forced = setCatalogJsonField(pinned, true, { force: true });
  assert.match(forced, /model_catalog_json = "cc-switch-model-catalog\.json"/);
  assert.equal(forced.includes("desktop-model-catalog"), false);
  // 不加 force 时保持外部文件不动（用户自管目录仍受保护）
  assert.equal(setCatalogJsonField(pinned, true), pinned);
});

test("catalogJsonValue distinguishes missing and literal null", () => {
  assert.equal(catalogJsonValue(`model_provider = "x"\n`), null);
  assert.equal(catalogJsonValue(`model_provider = "x"\nmodel_catalog_json = null\n`), null);
});

// ---- requires_openai_auth 归一化（供应商身份守卫）----

test("providerAuthState reads the active provider table", () => {
  const config = `model_provider = "custom"
[model_providers.custom]
name = "梦汐中转站"
base_url = "https://api.mengxiapi.com/v1"
requires_openai_auth = true
experimental_bearer_token = "sk-x"
`;
  const state = providerAuthState(config);
  assert.equal(state.providerId, "custom");
  assert.equal(state.name, "梦汐中转站");
  assert.equal(state.requiresOpenaiAuth, true);
  assert.equal(state.hasBearerToken, true);
  assert.equal(state.openAiBackend, false);
  assert.equal(state.reserved, false);
});

test("forceProviderAuthLocal rewrites true to false for a relay", () => {
  const config = `model_provider = "custom"
[model_providers.custom]
base_url = "https://api.example.com/v1"
requires_openai_auth = true
experimental_bearer_token = "sk-x"
`;
  const { text, changed } = forceProviderAuthLocal(config);
  assert.equal(changed, true);
  assert.match(text, /requires_openai_auth = false/);
  assert.equal(/requires_openai_auth = true/.test(text), false);
});

test("forceProviderAuthLocal inserts the key when missing", () => {
  const config = `model_provider = "custom"
[model_providers.custom]
base_url = "https://api.example.com/v1"
experimental_bearer_token = "sk-x"

[desktop]
locale = "zh"
`;
  const { text, changed } = forceProviderAuthLocal(config);
  assert.equal(changed, true);
  const inserted = text.indexOf("requires_openai_auth = false");
  assert.ok(inserted > text.indexOf("[model_providers.custom]"));
  assert.ok(inserted < text.indexOf("[desktop]"));
});

test("forceProviderAuthLocal leaves official provider ids alone", () => {
  const config = `model_provider = "openai"
[model_providers.openai]
base_url = "https://chatgpt.com/backend-api"
requires_openai_auth = true
`;
  const { text, changed } = forceProviderAuthLocal(config);
  assert.equal(changed, false);
  assert.equal(text, config);
});

test("forceProviderAuthLocal leaves OpenAI/ChatGPT backends alone", () => {
  const config = `model_provider = "custom"
[model_providers.custom]
base_url = "https://chatgpt.com/backend-api"
requires_openai_auth = true
`;
  assert.equal(forceProviderAuthLocal(config).changed, false);
  assert.equal(isOpenAiBackendUrl("https://api.openai.com/v1"), true);
  assert.equal(isOpenAiBackendUrl("https://chatgpt.com/backend-api"), true);
  assert.equal(isOpenAiBackendUrl("https://api.mengxiapi.com/v1"), false);
  assert.equal(isOpenAiBackendUrl("https://notopenai.com/v1"), false);
});
