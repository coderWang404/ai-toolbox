import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSections,
  mergeCommonConfig,
  parseBlocks,
  stripSections,
} from "../src/common-config.mjs";

test("parseBlocks keeps multi-line arrays in one entry", () => {
  const parsed = parseBlocks(`array = [\n  "a",\n  "b",\n]\n\n[desktop]\nlocale = "zh"\n`);
  assert.equal(parsed.top.length, 1);
  assert.equal(parsed.top[0].key, "array");
  assert.match(parsed.top[0].line, /"b"/);
  assert.equal(parsed.sections[0].path[0], "desktop");
});

test("merge replaces multi-line values without leaving stale lines", () => {
  const base = `array = [\n  "old",\n]\n\n[desktop]\nlocale = "en"\n`;
  const snippet = `array = [\n  "new1",\n  "new2",\n]\n\n[desktop]\nlocale = "zh"\n`;
  const out = mergeCommonConfig(base, snippet);
  assert.match(out, /"new2"/);
  assert.equal(out.includes('"old"'), false);
  assert.match(out, /locale = "zh"/);
});

test("extractSections keeps array tables inside the namespace", () => {
  const out = extractSections(
    `[desktop]\na = 1\n\n[[plugins]]\nid = "p1"\n\n[other]\nx = 1\n`,
    ["desktop", "plugins"],
  );
  assert.match(out, /\[desktop\]/);
  assert.match(out, /\[\[plugins\]\]/);
  assert.match(out, /id = "p1"/);
  assert.equal(out.includes("[other]"), false);
});

test("stripSections removes the namespace and its subtables", () => {
  const out = stripSections(
    `x = 1\n[desktop]\na = 1\n[desktop.sub]\nb = 2\n[other]\nc = 3\n`,
    ["desktop"],
  );
  assert.equal(out.includes("[desktop"), false);
  assert.match(out, /\[other\]/);
  assert.match(out, /c = 3/);
});
