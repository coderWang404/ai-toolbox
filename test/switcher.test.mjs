import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderConfig, catalogHealth, catalogPathIsManaged } from "../src/switcher.mjs";

test("live app sections replace stale provider snapshots", () => {
  const provider = {
    id: "p",
    name: "P",
    config: `model_provider = "p"
model = "m"

[model_providers.p]
base_url = "https://example.com"

[desktop]
locale = "en"
old = 1

[plugins]
stale = true
`,
    auth: { OPENAI_API_KEY: "sk-test-123456789" },
    meta: {},
  };
  const live = `[desktop]
locale = "zh"

[projects."/tmp/x"]
trust_level = "trusted"
`;
  const { text } = buildProviderConfig({
    provider,
    commonConfig: null,
    apiFormat: null,
    liveConfigText: live,
    dryRun: true,
  });
  assert.match(text, /\[desktop\]\nlocale = "zh"/);
  assert.equal(text.includes("old = 1"), false);
  assert.equal(text.includes("stale = true"), false);
  assert.match(text, /\[projects\."\/tmp\/x"\]/);
  assert.match(text, /experimental_bearer_token = "sk-test-123456789"/);
});

test("catalogPathIsManaged only claims files inside CODEX_HOME", () => {
  const home = "/Users/me/.codex";
  assert.equal(catalogPathIsManaged("cc-switch-model-catalog.json", home), true);
  assert.equal(catalogPathIsManaged(`${home}/desktop-model-catalog.json`, home), true);
  assert.equal(catalogPathIsManaged("/tmp/other-catalog.json", home), false);
  assert.equal(catalogPathIsManaged(null, home), false);
});

test("catalogHealth detects a missing model or unsupported effort", () => {
  assert.equal(catalogHealth(null).reason, "missing");
  const catalog = {
    models: [
      {
        slug: "gpt-6.1-terra",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      },
    ],
  };
  assert.equal(catalogHealth(catalog, { model: "gpt-6.1-terra" }).ok, true);
  assert.equal(catalogHealth(catalog, { model: "gpt-6.1-terra", requiredEffort: "xhigh" }).reason, "effort-missing");
  assert.equal(catalogHealth(catalog, { model: "gpt-6.1-terra", requiredEffort: "high" }).ok, true);
  assert.equal(catalogHealth(catalog, { model: "gpt-6.1-sol" }).reason, "model-missing");
});

test("third-party provider config is normalized to requires_openai_auth=false", () => {
  const provider = {
    id: "p",
    name: "Relay",
    config: `model_provider = "p"
model = "m"

[model_providers.p]
name = "Relay"
base_url = "https://relay.example.com/v1"
requires_openai_auth = true
`,
    auth: { OPENAI_API_KEY: "sk-relay" },
    meta: {},
  };
  const { text, authNormalized } = buildProviderConfig({
    provider,
    commonConfig: null,
    apiFormat: null,
    liveConfigText: null,
    dryRun: true,
  });
  assert.equal(authNormalized, true);
  assert.match(text, /requires_openai_auth = false/);
  assert.equal(/requires_openai_auth = true/.test(text), false);
});

test("official provider keeps its ChatGPT auth flag", () => {
  const provider = {
    id: "p",
    name: "OpenAI",
    config: `model_provider = "openai"
model = "m"

[model_providers.openai]
base_url = "https://chatgpt.com/backend-api"
requires_openai_auth = true
`,
    auth: {},
    meta: {},
  };
  const { authNormalized } = buildProviderConfig({
    provider,
    commonConfig: null,
    apiFormat: null,
    liveConfigText: null,
    dryRun: true,
  });
  assert.equal(authNormalized, false);
});
