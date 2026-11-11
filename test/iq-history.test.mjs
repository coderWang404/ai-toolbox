import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHistoryEntry,
  mergeHistory,
  IQ_HISTORY_LIMIT,
  IQ_REPLY_LIMIT,
} from "../src/iq-history.mjs";

test("normalizeHistoryEntry 补齐字段并去掉密钥", () => {
  const entry = normalizeHistoryEntry({
    topic: "candy",
    topicTitle: "摸糖保证题",
    reply: "先算一下 sk-1234567890abcdef 再说",
    elapsedMs: 198123,
  });
  assert.equal(entry.topic, "candy");
  assert.equal(entry.topicTitle, "摸糖保证题");
  assert.match(entry.id, /\d+/);
  assert.equal(entry.reply.includes("sk-1234567890abcdef"), false);
  assert.equal(entry.elapsedMs, 198123);
  assert.equal(entry.answer, null);
  assert.equal(entry.replyTruncated, false);
});

test("超长回复会被截断并标记", () => {
  const entry = normalizeHistoryEntry({ reply: "x".repeat(IQ_REPLY_LIMIT + 100) });
  assert.equal(entry.reply.length, IQ_REPLY_LIMIT);
  assert.equal(entry.replyTruncated, true);
});

test("mergeHistory 新结果在前，超出上限丢最旧", () => {
  const old = Array.from({ length: IQ_HISTORY_LIMIT }, (_, index) => ({
    id: `old-${index}`,
    at: new Date(2026, 0, 1, 0, index).toISOString(),
  }));
  const merged = mergeHistory(old, { id: "new", at: "2026-01-02T00:00:00.000Z" });
  assert.equal(merged.length, IQ_HISTORY_LIMIT);
  assert.equal(merged[0].id, "new");
  assert.equal(merged[merged.length - 1].id, `old-${IQ_HISTORY_LIMIT - 2}`);
  assert.equal(merged.some((item) => item.id === `old-${IQ_HISTORY_LIMIT - 1}`), false);
});

test("mergeHistory 兼容空或非法输入", () => {
  const merged = mergeHistory(null, { id: "a" });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "a");
  assert.equal(merged[0].reply, null);
  assert.equal(merged[0].elapsedMs, null);
});
