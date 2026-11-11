import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCodexVersion,
  parseCcSwitchVersion,
  parseClaudeVersion,
  compareVersions,
  isOutdated,
  planUpdates,
} from "../src/remote-versions.mjs";

test("解析 codex / cc-switch 版本输出", () => {
  assert.equal(parseCodexVersion("codex-cli 0.151.0"), "0.151.0");
  assert.equal(parseCodexVersion("codex-cli 0.156.0-alpha.14\n"), "0.156.0-alpha.14");
  assert.equal(parseCodexVersion(""), null);
  assert.equal(parseCcSwitchVersion("cc-switch 5.10.5"), "5.10.5");
  assert.equal(parseCcSwitchVersion("v5.11.3"), "5.11.3");
  assert.equal(parseClaudeVersion("2.1.322 (Claude Code)"), "2.1.322");
  assert.equal(parseClaudeVersion("2.1.221"), "2.1.221");
});

test("语义化版本比较（含预发布）", () => {
  assert.equal(compareVersions("0.151.0", "0.167.1"), -1);
  assert.equal(compareVersions("5.10.5", "5.11.3"), -1);
  assert.equal(compareVersions("5.10.10", "5.10.9"), 1);
  assert.equal(compareVersions("v5.11.3", "5.11.3"), 0);
  assert.equal(compareVersions("0.156.0-alpha.14", "0.156.0"), -1);
  assert.equal(compareVersions("0.156.0", "0.156.0-alpha.14"), 1);
});

test("isOutdated 只在落后时为 true", () => {
  assert.equal(isOutdated("0.151.0", "0.167.1"), true);
  assert.equal(isOutdated("0.167.1", "0.167.1"), false);
  assert.equal(isOutdated("0.168.0", "0.167.1"), false);
  assert.equal(isOutdated(null, "0.167.1"), false);
  assert.equal(isOutdated("0.151.0", null), false);
});

test("planUpdates 标出需要更新的主机与工具", () => {
  const rows = [
    { label: "231", host: "a", ok: true, codex: "0.151.0", ccswitch: "5.11.3", claude: "2.1.322" },
    { label: "217", host: "b", ok: true, codex: "0.167.1", ccswitch: "5.10.5", claude: "2.1.221" },
    { label: "219", host: "c", ok: true, codex: null, ccswitch: "5.11.3", claude: null },
    { label: "230", host: "d", ok: false, codex: null, ccswitch: null, claude: null },
  ];
  const planned = planUpdates(rows, { codex: "0.167.1", ccswitch: "5.11.3", claude: "2.1.322" });
  assert.deepEqual(
    planned.map((row) => [row.label, row.codexUpdate, row.ccswitchUpdate, row.claudeUpdate]),
    [
      ["231", true, false, false],
      ["217", false, true, true],
      ["219", true, false, true], // 没装 codex / claude：也要标记为待安装
      ["230", false, false, false],
    ],
  );
});
