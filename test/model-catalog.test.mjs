import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  modelsUrl,
  isChatModel,
  selectCatalogModels,
  fetchProviderModels,
  buildCatalogFromModelIds,
} from "../src/model-catalog.mjs";

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test("modelsUrl handles base_url variants", () => {
  assert.equal(modelsUrl("https://a.com"), "https://a.com/models");
  assert.equal(modelsUrl("https://a.com/v1/"), "https://a.com/v1/models");
  assert.equal(modelsUrl("https://a.com/v1/models"), "https://a.com/v1/models");
  assert.equal(modelsUrl(""), null);
  assert.equal(modelsUrl(null), null);
});

test("isChatModel drops non-chat endpoints", () => {
  assert.equal(isChatModel("gpt-6.1-sol"), true);
  assert.equal(isChatModel("deepseek-v4-pro"), true);
  assert.equal(isChatModel("stepaudio-2.5-tts"), false);
  assert.equal(isChatModel("text-embedding-3-large"), false);
  assert.equal(isChatModel("whisper-1"), false);
  assert.equal(isChatModel("dall-e-3"), false);
  assert.equal(isChatModel("gpt-image-1"), false);
  assert.equal(isChatModel("bge-rerank-v2"), false);
});

test("selectCatalogModels puts configured model first and caps size", () => {
  const ids = ["gpt-6-sol", "tts-1", "gpt-6.1-sol", "gpt-6-sol", ...Array.from({ length: 60 }, (_, i) => `m-${i}`)];
  const selected = selectCatalogModels(ids, { preferred: "gpt-6.1-sol", limit: 10 });
  assert.equal(selected[0], "gpt-6.1-sol");
  assert.equal(selected.length, 10);
  assert.equal(new Set(selected).size, selected.length);
  assert.equal(selected.includes("tts-1"), false);
});

test("fetchProviderModels parses OpenAI data[] and models[] payloads", async () => {
  const a = await serve((req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer sk-test");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "gpt-a" }, { id: "gpt-b" }] }));
  });
  const first = await fetchProviderModels({ baseUrl: `${a.baseUrl}/v1`, token: "sk-test" });
  a.server.close();
  assert.equal(first.ok, true);
  assert.deepEqual(first.models, ["gpt-a", "gpt-b"]);

  const b = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: ["gpt-c", { id: "gpt-d" }] }));
  });
  const second = await fetchProviderModels({ baseUrl: b.baseUrl, token: "sk-test" });
  b.server.close();
  assert.deepEqual(second.models, ["gpt-c", "gpt-d"]);
});

test("fetchProviderModels reports HTTP errors, bad JSON and missing credentials", async () => {
  const a = await serve((req, res) => {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized");
  });
  const unauthorized = await fetchProviderModels({ baseUrl: a.baseUrl, token: "sk-bad" });
  a.server.close();
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.error, /HTTP 401/);

  const b = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>nope</html>");
  });
  const notJson = await fetchProviderModels({ baseUrl: b.baseUrl, token: "sk-test" });
  b.server.close();
  assert.equal(notJson.ok, false);
  assert.match(notJson.error, /JSON/);

  const empty = await fetchProviderModels({ baseUrl: "https://example.com", token: "sk-test", timeoutMs: 50 });
  assert.equal(empty.ok, false);

  const noToken = await fetchProviderModels({ baseUrl: "https://example.com", token: "" });
  assert.equal(noToken.ok, false);
  assert.match(noToken.error, /API key/);
});

test("fetchProviderModels times out instead of hanging", async () => {
  const slow = await serve(() => {
    /* 永不响应 */
  });
  const started = Date.now();
  const result = await fetchProviderModels({ baseUrl: slow.baseUrl, token: "sk-test", timeoutMs: 150 });
  slow.server.close();
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
  assert.ok(Date.now() - started < 3000);
});

test("buildCatalogFromModelIds produces Codex catalog entries", () => {
  const configText = `model = "gpt-6.1-sol"\n\n[model_providers.custom]\nbase_url = "https://example.com/v1"\nwire_api = "responses"\n`;
  const catalog = buildCatalogFromModelIds(["gpt-6-sol", "tts-1", "gpt-6.1-sol"], {
    configText,
    apiFormat: null,
    preferred: "gpt-6.1-sol",
  });
  assert.ok(catalog?.models?.length);
  assert.equal(catalog.models[0].slug, "gpt-6.1-sol");
  assert.equal(catalog.models.some((m) => m.slug === "tts-1"), false);
  assert.equal(typeof catalog.models[0].context_window, "number");
});
