import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTodayServer, resolveModel, serializeMessages } from "../src/today/server.mjs";
import { extractText, makeClientMessageId } from "../src/today/client.mjs";

const catalog = {
  selectedOptionId: "model.deepseek-v4.1-flash",
  options: [
    { id: "model.deepseek-v4.1-flash", display: { title: "DeepSeek V4.1 Flash", subtitle: "1×" } },
    { id: "model.glm-5.3", display: { title: "GLM 5.3", subtitle: "4×" } },
  ],
};

class FakeClient {
  constructor() {
    this.ws = {};
    this.pageUrl = "http://today-desktop.localhost/";
  }
  async api() {
    return { status: 200, json: {} };
  }
  async getModelCatalog() {
    return structuredClone(catalog);
  }
  async chat(prompt, { model } = {}) {
    return {
      content: "第一句。第二句。",
      model: model || "model.deepseek-v4.1-flash",
      threadId: "thread-1",
      messageId: "message-1",
    };
  }
}

async function withServer(fn) {
  const server = createTodayServer({
    client: new FakeClient(),
    port: 0,
    apiKey: "secret",
    sendHistory: true,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("today helpers", () => {
  assert.equal(serializeMessages([{ role: "user", content: "hi" }]), "用户：hi");
  assert.equal(resolveModel("deepseek"), "model.deepseek-v4.1-flash");
  assert.equal(extractText({ body: { parts: [{ content: { text: "a" } }, { text: "b" }] } }), "a\nb");
  const id = makeClientMessageId(1700000000000);
  assert.equal(id.length, 31);
  assert.ok(id.startsWith("00001"));
});

test("health is public, models require the token", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");

    const denied = await fetch(`${base}/v1/models`);
    assert.equal(denied.status, 401);

    const models = await fetch(`${base}/v1/models`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(models.status, 200);
    const body = await models.json();
    const ids = body.data.map((item) => item.id);
    assert.ok(ids.includes("model.deepseek-v4.1-flash"));
    assert.ok(ids.includes("deepseek"));
  });
});

test("chat completion and alias model route", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, "第一句。第二句。");
    assert.equal(body.model, "model.deepseek-v4.1-flash");
    assert.equal(body.x_today.threadId, "thread-1");

    const alias = await fetch(`${base}/v1/models/deepseek`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(alias.status, 200);
    const aliasBody = await alias.json();
    assert.ok(aliasBody.id === "model.deepseek-v4.1-flash" || aliasBody.alias_of === "model.deepseek-v4.1-flash");
  });
});

test("stream chunks carry deltas, not cumulative text", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const chunks = text
      .split("\n\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(6)));
    const content = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || "").join("");
    assert.equal(content, "第一句。第二句。");
    assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  });
});
