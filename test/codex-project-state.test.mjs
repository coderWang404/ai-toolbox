import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const codexHome = mkdtempSync(path.join(os.tmpdir(), "ai-toolbox-codex-home-"));
const dataHome = mkdtempSync(path.join(os.tmpdir(), "ai-toolbox-data-"));
process.env.CODEX_HOME = codexHome;
process.env.CODEX_HOMESWITCH_HOME = dataHome;
process.env.AI_TOOLBOX_FAKE_CODEX_RUNNING = "0";

import {
  statePath,
  readState,
  writeState,
  projectStateReport,
  planProjectStateRepair,
  applyProjectStateRepair,
  repairProjectState,
  preserveProjectState,
  saveStateSnapshot,
  snapshotDir,
  ACCOUNT_STATE_KEY,
  LOCAL_PROJECTS_KEY,
} from "../src/codex-project-state.mjs";

const ROOT = "/tmp/projects";

function project(id, name, folder) {
  return { id, name, rootPaths: [path.join(ROOT, folder)], createdAt: 1, updatedAt: 2 };
}

/** 复刻真实场景：项目被搬进 inactive 桶，活动状态只剩一个重复项目。 */
function parkedState() {
  const legacy = {
    alpha: project("alpha", "Alpha", "alpha"),
    beta: project("beta", "Beta", "beta"),
  };
  return {
    "electron-persisted-atom-state": { "sidebar-width": 300, "unified-sidebar-project-order-v1": ["codex:project:alpha"] },
    "local-projects": { dup: project("dup", "Alpha", "alpha") },
    "project-order": ["dup"],
    "thread-project-assignments": {},
    "app-server-project-id-by-legacy-project-id-by-host": {
      "local:/x": { alpha: "srv-alpha", dup: "srv-dup" },
    },
    [ACCOUNT_STATE_KEY]: {
      owner: null,
      inactive: {
        oldhash: {
          atoms: { "unified-sidebar-project-order-v1": ["codex:project:alpha", "codex:project:beta"] },
          globals: {
            "local-projects": legacy,
            "project-order": ["beta", "alpha"],
            "thread-project-assignments": {
              t1: { projectKind: "local", projectId: "alpha" },
              t2: { projectKind: "local", projectId: "beta" },
            },
            "app-server-project-id-by-legacy-project-id-by-host": {
              "local:/x": { alpha: "srv-alpha", beta: "srv-beta" },
            },
          },
        },
      },
    },
  };
}

test("report detects parked project state", () => {
  const report = projectStateReport(parkedState());
  assert.equal(report.ok, true);
  assert.equal(report.active.projects, 1);
  assert.equal(report.needsRepair, true);
  assert.equal(report.snapshots[0].projects, 2);
  assert.equal(report.snapshots[0].assignments, 2);
});

test("repair restores projects, assignments and removes account scoping", () => {
  const state = parkedState();
  const plan = planProjectStateRepair(state);
  assert.equal(plan.needsRepair, true);
  const { state: fixed, restored, droppedProjectIds } = applyProjectStateRepair(state, plan);

  assert.equal(restored.projects, 2);
  assert.equal(restored.assignments, 2);
  assert.deepEqual(droppedProjectIds, ["dup"]);
  assert.equal(fixed[ACCOUNT_STATE_KEY], undefined);
  assert.deepEqual(Object.keys(fixed[LOCAL_PROJECTS_KEY]).sort(), ["alpha", "beta"]);
  assert.deepEqual(fixed["project-order"], ["beta", "alpha"]);
  // 重复项目（同目录）的 id 映射被清理
  assert.deepEqual(fixed["app-server-project-id-by-legacy-project-id-by-host"]["local:/x"], {
    alpha: "srv-alpha",
    beta: "srv-beta",
  });
  // atoms 合并：快照里的侧边栏项目顺序恢复，设备级 atom 保留
  assert.equal(fixed["electron-persisted-atom-state"]["sidebar-width"], 300);
  assert.deepEqual(fixed["electron-persisted-atom-state"]["unified-sidebar-project-order-v1"], [
    "codex:project:alpha",
    "codex:project:beta",
  ]);
});

test("healthy state is left alone", () => {
  const state = parkedState();
  state[LOCAL_PROJECTS_KEY] = { alpha: project("alpha", "Alpha", "alpha"), beta: project("beta", "Beta", "beta") };
  const plan = planProjectStateRepair(state);
  assert.equal(plan.needsRepair, false);
  assert.equal(plan.reason, "healthy");
  writeState(state, statePath());
  const fixed = repairProjectState({ log: null });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.repaired, false);
});

test("state without snapshots needs no repair", () => {
  const plan = planProjectStateRepair({ "local-projects": { a: project("a", "A", "a") } });
  assert.equal(plan.needsRepair, false);
  assert.equal(plan.reason, "healthy");

  const empty = planProjectStateRepair({});
  assert.equal(empty.needsRepair, false);
  assert.equal(empty.reason, "no-snapshot");
});

test("writeState is atomic and refreshes the backup", () => {
  const state = parkedState();
  const file = statePath();
  writeState(state, file);
  assert.equal(readState(file)[LOCAL_PROJECTS_KEY].dup.name, "Alpha");
  assert.equal(existsSync(`${file}.bak`), true);
  const bak = JSON.parse(readFileSync(`${file}.bak`, "utf8"));
  assert.equal(bak[LOCAL_PROJECTS_KEY].dup.name, "Alpha");
});

test("preserve writes a snapshot copy", () => {
  const state = parkedState();
  writeState(state, statePath());
  const result = preserveProjectState({ state, log: null });
  assert.equal(result.projects, 1);
  assert.equal(existsSync(result.file), true);
  const names = readdirSync(snapshotDir());
  assert.ok(names.some((n) => n.startsWith("snapshot-")));
});

test("repair refuses to write while Codex is running unless forced", () => {
  const state = parkedState();
  writeState(state, statePath());
  process.env.AI_TOOLBOX_FAKE_CODEX_RUNNING = "1";
  const skipped = repairProjectState();
  assert.equal(skipped.repaired, false);
  assert.equal(skipped.reason, "codex-running");
  const forced = repairProjectState({ force: true });
  assert.equal(forced.repaired, true);
  process.env.AI_TOOLBOX_FAKE_CODEX_RUNNING = "0";
});

test("snapshot files stay capped", () => {
  for (let i = 0; i < 14; i++) saveStateSnapshot({ state: parkedState(), reason: "test" });
  const files = readdirSync(snapshotDir()).filter((n) => n.startsWith("snapshot-"));
  assert.ok(files.length <= 10, `expected <= 10 snapshots, got ${files.length}`);
});
