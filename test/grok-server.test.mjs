import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/grok-bot.mjs";

test("Grok gateway requires a Bearer token and limits CORS", async () => {
  process.env.GROKBOT_TOKEN = "testtoken";
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);

    const denied = await fetch(`${base}/v1/models`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${base}/v1/models`, {
      headers: { authorization: "Bearer testtoken", origin: "http://127.0.0.1:5173" },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");

    const evil = await fetch(`${base}/v1/models`, {
      headers: { authorization: "Bearer testtoken", origin: "https://evil.example" },
    });
    assert.equal(evil.status, 200);
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.GROKBOT_TOKEN;
  }
});
