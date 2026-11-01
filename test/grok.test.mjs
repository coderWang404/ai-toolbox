import test from "node:test";
import assert from "node:assert/strict";
import { executeTurn } from "../src/grok-bot.mjs";

test("executeTurn waits for content to stabilize and sends deltas", async () => {
  let listCalls = 0;
  const rpc = async (service, method) => {
    if (method === "ListGrokBotTranscriptEntries") {
      listCalls += 1;
      if (listCalls === 1) return { entries: [{ seq: "10" }] };
      if (listCalls === 2) return { entries: [{ seq: "11", entryKind: "send-message", body: encode("你好") }] };
      if (listCalls === 3) return { entries: [{ seq: "12", entryKind: "send-message", body: encode("你好，世界") }] };
      return { entries: [] };
    }
    if (method === "SendGrokBotUserMessage") return {};
    throw new Error(`unexpected ${method}`);
  };
  const deltas = [];
  const reply = await executeTurn("agent", "hi", (delta) => deltas.push(delta), {
    rpc,
    pollMs: 1,
    timeoutMs: 5000,
  });
  assert.equal(reply, "你好，世界");
  assert.deepEqual(deltas, ["你好", "，世界"]);
});

function encode(text) {
  return Buffer.from(JSON.stringify({ message: { content: text } }), "utf8").toString("base64");
}
