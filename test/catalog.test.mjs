import test from "node:test";
import assert from "node:assert/strict";
import { resolveCatalogProfile } from "../src/catalog.mjs";

test("official-looking suffix cannot spoof DeepSeek host", () => {
  assert.equal(
    resolveCatalogProfile({
      apiFormat: null,
      configText: 'base_url = "https://deepseek.com.evil.example/v1"',
      isOfficial: false,
    }),
    "ProxyChat",
  );
});

test("deepseek official host resolves to NativeResponses", () => {
  assert.equal(
    resolveCatalogProfile({
      apiFormat: null,
      configText: 'base_url = "https://api.deepseek.com"',
      isOfficial: false,
    }),
    "NativeResponses",
  );
});
