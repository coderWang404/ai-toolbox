import test from "node:test";
import assert from "node:assert/strict";
import {
  managerFromMeta,
  MAGPIE_PROFILE_ID,
  CLAUDE_DESKTOP_PROFILE_ID,
} from "../src/claude-desktop.mjs";

test("Magpie profile id 是 magpie 的十六进制后缀", () => {
  assert.equal(MAGPIE_PROFILE_ID, `00000000-0000-4000-8000-${Buffer.from("magpie").toString("hex")}`);
});

test("appliedId 指向 CC Switch 时识别为 cc-switch", () => {
  const result = managerFromMeta({
    appliedId: CLAUDE_DESKTOP_PROFILE_ID,
    entries: [
      { id: CLAUDE_DESKTOP_PROFILE_ID, name: "CC Switch" },
      { id: MAGPIE_PROFILE_ID, name: "magpie" },
    ],
  });
  assert.equal(result.manager, "cc-switch");
  assert.equal(result.name, "CC Switch");
});

test("appliedId 指向 Magpie 时识别为 magpie", () => {
  const result = managerFromMeta({
    appliedId: MAGPIE_PROFILE_ID,
    entries: [{ id: MAGPIE_PROFILE_ID, name: "magpie" }],
  });
  assert.equal(result.manager, "magpie");
  assert.equal(result.name, "magpie");
});

test("id 不认识时按名字兜底识别", () => {
  assert.equal(
    managerFromMeta({ appliedId: "custom-1", entries: [{ id: "custom-1", name: "Magpie 接管" }] }).manager,
    "magpie",
  );
  assert.equal(
    managerFromMeta({ appliedId: "custom-2", entries: [{ id: "custom-2", name: "cc-switch" }] }).manager,
    "cc-switch",
  );
});

test("没有 appliedId 时返回 none", () => {
  assert.equal(managerFromMeta(null).manager, "none");
  assert.equal(managerFromMeta({}).manager, "none");
  assert.equal(managerFromMeta({ entries: [] }).name, "未设置");
});

test("未知接管方保持 unknown 并保留名字", () => {
  const result = managerFromMeta({ appliedId: "x", entries: [{ id: "x", name: "Other" }] });
  assert.equal(result.manager, "unknown");
  assert.equal(result.name, "Other");
});
