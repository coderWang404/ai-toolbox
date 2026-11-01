import test from "node:test";
import assert from "node:assert/strict";
import { applyProviderSlice, normalizeHost, providerSnapshot } from "../src/remote-sync.mjs";

test("normalizeHost rejects ssh option injection", () => {
  assert.equal(normalizeHost("-oProxyCommand=evil"), null);
  assert.equal(normalizeHost({ host: "ok.example", user: "-root" }), null);
  assert.equal(normalizeHost({ host: "ok.example", user: "me" })?.user, "me");
});

test("providerSnapshot hides token by default", () => {
  const config = `model_provider = "x"
[model_providers.x]
name = "Provider"
base_url = "https://api.example.com/v1"
experimental_bearer_token = "sk-1234567890abcdef"
`;
  const snap = providerSnapshot(config);
  assert.equal(snap.token, null);
  assert.equal(snap.tokenTail, "90abcdef");
  assert.equal(providerSnapshot(config, { includeSecrets: true }).token, "sk-1234567890abcdef");
});

test("applyProviderSlice only replaces routing fields", () => {
  const remote = `model_provider = "old"
model = "old-model"
notify = ["say done"]

[model_providers.old]
name = "Old"

[projects."/tmp/x"]
trust_level = "trusted"
`;
  const local = `model_provider = "new"
model = "new-model"

[model_providers.new]
name = "New"
base_url = "https://new.example/v1"
`;
  const result = applyProviderSlice(remote, local);
  assert.match(result.text, /model_provider = "new"/);
  assert.match(result.text, /model = "new-model"/);
  assert.match(result.text, /\[model_providers\.new\]/);
  assert.equal(result.text.includes("[model_providers.old]"), false);
  assert.match(result.text, /notify = \["say done"\]/);
  assert.match(result.text, /\[projects\."\/tmp\/x"\]/);
  assert.equal(result.changed, true);
});
