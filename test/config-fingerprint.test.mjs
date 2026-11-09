import test from "node:test";
import assert from "node:assert/strict";
import { providerFingerprint, providerSummaryFromText } from "../src/config-fingerprint.mjs";

const providerA = `model_provider = "custom"
model = "gpt-6.1-sol"
model_reasoning_effort = "xhigh"
service_tier = "priority"
model_catalog_json = "cc-switch-model-catalog.json"

[model_providers.custom]
name = "梦汐中转站"
base_url = "https://menxinb.shop/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "sk-aaa"

[desktop]
sansFontSize = 14

[mcp_servers.node_repl]
command = "/Applications/ChatGPT.app/cua_node/bin/node_repl"

[mcp_servers.node_repl.env]
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab,mcpapps"

[projects."/Users/me/x"]
trust_level = "trusted"
`;

// 应用每次启动会重写这些段落（版本号/能力开关/顺序），但供应商没变
const providerASameAppNoise = `model_provider = "custom"
model = "gpt-6.1-sol"
model_reasoning_effort = "xhigh"
service_tier = "priority"
model_catalog_json = "cc-switch-model-catalog.json"

[model_providers.custom]
name = "梦汐中转站"
base_url = "https://menxinb.shop/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "sk-aaa"

[desktop]
sansFontSize = 15

[mcp_servers.node_repl]
command = "/Applications/ChatGPT.app/cua_node/bin/node_repl"

[mcp_servers.node_repl.env]
BROWSER_USE_AVAILABLE_BACKENDS = "chrome"
NODE_REPL_INSTRUCTION_VERSION = "2"

[projects."/Users/me/y"]
trust_level = "trusted"
`;

const providerB = providerASameAppNoise.replace("https://menxinb.shop/v1", "https://other.example/v1");

test("应用自管段落的变化不影响供应商指纹", () => {
  assert.equal(providerFingerprint(providerA), providerFingerprint(providerASameAppNoise));
});

test("供应商 / 模型 / 密钥变化会改变指纹", () => {
  assert.notEqual(providerFingerprint(providerA), providerFingerprint(providerB));

  const tokenChanged = providerA.replace("sk-aaa", "sk-bbb");
  assert.notEqual(providerFingerprint(providerA), providerFingerprint(tokenChanged));

  const modelChanged = providerA.replace('model = "gpt-6.1-sol"', 'model = "gpt-6.1-terra"');
  assert.notEqual(providerFingerprint(providerA), providerFingerprint(modelChanged));

  const catalogChanged = providerA.replace('model_catalog_json = "cc-switch-model-catalog.json"', 'model_catalog_json = null');
  assert.notEqual(providerFingerprint(providerA), providerFingerprint(catalogChanged));
});

test("指纹能取出 provider 摘要", () => {
  const summary = providerSummaryFromText(providerA);
  assert.equal(summary.providerId, "custom");
  assert.equal(summary.baseUrl, "https://menxinb.shop/v1");
  assert.equal(summary.model, "gpt-6.1-sol");
});

test("空配置不报错", () => {
  assert.equal(providerFingerprint(""), "");
  assert.equal(providerFingerprint(null), null);
});
