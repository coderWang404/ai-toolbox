// 远端 Codex / cc-switch 版本检测与更新。
//
// 远端装的是两套东西：
//   - Codex CLI：npm 全局包 @openai/codex，用 `npm i -g` 升级
//   - cc-switch CLI：saladday/cc-switch-cli（Rust，`cc-switch update` 自更新）
// 本机 GUI 的 CC Switch 是另一个项目（farion1231/cc-switch），不在这里管。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sshArgs, loadRemotes } from "./remote-sync.mjs";

const execFileAsync = promisify(execFile);

const CODEX_REGISTRY = "https://registry.npmjs.org/@openai/codex/latest";
const CCSWITCH_RELEASES = "https://api.github.com/repos/saladday/cc-switch-cli/releases/latest";
const MARKER = "AI_TOOLBOX_REMOTE_JSON:";

/** "codex-cli 0.151.0" / "0.151.0" → "0.151.0" */
export function parseCodexVersion(text) {
  if (!text) return null;
  const match = String(text).match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

/** "cc-switch 5.10.5" / "5.10.5" → "5.10.5" */
export function parseCcSwitchVersion(text) {
  return parseCodexVersion(text);
}

/** 语义化版本比较：a<b 返回 -1；预发布小于同号正式版。 */
export function compareVersions(a, b) {
  const split = (value) =>
    String(value ?? "")
      .trim()
      .replace(/^v/i, "")
      .split("-");
  const [coreA, preA = ""] = split(a);
  const [coreB, preB = ""] = split(b);
  const numsA = coreA.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const numsB = coreB.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(numsA.length, numsB.length); i += 1) {
    const x = numsA[i] ?? 0;
    const y = numsB[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (preA === preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA < preB ? -1 : 1;
}

export function isOutdated(current, latest) {
  if (!current || !latest) return false;
  return compareVersions(current, latest) < 0;
}

function probeProgram() {
  return `
import json, platform, subprocess
def sh(cmd):
    try:
        p = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=40)
        return ((p.stdout or "") + (p.stderr or "")).strip()
    except Exception:
        return ""
codex = sh("command -v codex >/dev/null 2>&1 && codex --version 2>/dev/null | head -1 || true")
ccswitch = sh("command -v cc-switch >/dev/null 2>&1 && cc-switch --version 2>/dev/null | head -1 || true")
print("${MARKER}" + json.dumps({"hostname": platform.node(), "codex": codex, "ccswitch": ccswitch}))
`;
}

function updateProgram({ codex, ccswitch, codexVersion, ccswitchVersion }) {
  const codexTarget = codexVersion ? `@${codexVersion}` : "@latest";
  const ccswitchArgs = ccswitchVersion ? ` --version v${String(ccswitchVersion).replace(/^v/, "")}` : "";
  return `
import json, subprocess
def sh(cmd, timeout=600):
    try:
        p = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=timeout)
        return {"code": p.returncode, "out": ((p.stdout or "") + (p.stderr or "")).strip()[-1200:]}
    except subprocess.TimeoutExpired:
        return {"code": -1, "out": "timeout"}
    except Exception as exc:
        return {"code": -1, "out": str(exc)}
result = {}
${
  codex
    ? `result["codex"] = sh("npm install -g @openai/codex${codexTarget}")`
    : ""
}
${
  ccswitch
    ? `result["ccswitch"] = sh("cc-switch update${ccswitchArgs}")`
    : ""
}
result["after"] = {
    "codex": sh("command -v codex >/dev/null 2>&1 && codex --version 2>/dev/null | head -1 || true", 30)["out"],
    "ccswitch": sh("command -v cc-switch >/dev/null 2>&1 && cc-switch --version 2>/dev/null | head -1 || true", 30)["out"],
}
print("${MARKER}" + json.dumps(result))
`;
}

async function runRemoteProgram(entry, program, timeoutMs) {
  const { stdout } = await execFileAsync("ssh", sshArgs(entry, program), {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  const line = stdout
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith(MARKER));
  if (!line) throw new Error(stdout.trim().slice(-180) || "远程没有返回结果");
  return JSON.parse(line.slice(MARKER.length));
}

/** 探测单台远端。 */
export async function probeHost(entry) {
  const started = Date.now();
  try {
    const data = await runRemoteProgram(entry, probeProgram(), 45000);
    return {
      host: entry.host,
      label: entry.label,
      ok: true,
      hostname: data.hostname ?? null,
      codex: parseCodexVersion(data.codex),
      ccswitch: parseCcSwitchVersion(data.ccswitch),
      raw: { codex: data.codex || null, ccswitch: data.ccswitch || null },
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      host: entry.host,
      label: entry.label,
      ok: false,
      hostname: null,
      codex: null,
      ccswitch: null,
      error: String(err?.stderr || err?.message || err).trim().split("\n").slice(-2).join(" ").slice(0, 200),
      ms: Date.now() - started,
    };
  }
}

export async function probeRemotes({ hosts = null } = {}) {
  const list = hosts ?? loadRemotes();
  return Promise.all(list.map((entry) => probeHost(entry)));
}

/** 查线上最新版本；任一失败不影响另一个。 */
export async function latestVersions({ fetchImpl = fetch } = {}) {
  const get = async (url) => {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "ai-toolbox" },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const [codex, ccswitch] = await Promise.allSettled([
    get(CODEX_REGISTRY).then((data) => data?.version ?? null),
    get(CCSWITCH_RELEASES).then((data) => parseCodexVersion(data?.tag_name ?? null)),
  ]);
  return {
    codex: codex.status === "fulfilled" ? codex.value : null,
    ccswitch: ccswitch.status === "fulfilled" ? ccswitch.value : null,
    errors: {
      codex: codex.status === "rejected" ? String(codex.reason?.message ?? codex.reason) : null,
      ccswitch: ccswitch.status === "rejected" ? String(ccswitch.reason?.message ?? ccswitch.reason) : null,
    },
  };
}

/** 生成「谁需要更新」的计划（纯函数，便于测试）。 */
export function planUpdates(rows, latest) {
  return rows.map((row) => ({
    ...row,
    codexUpdate: row.ok && isOutdated(row.codex, latest?.codex),
    ccswitchUpdate: row.ok && isOutdated(row.ccswitch, latest?.ccswitch),
  }));
}

/** 更新一台远端；codex 用 npm，cc-switch 用自带 update。 */
export async function updateHost(entry, { codex = true, ccswitch = true, codexVersion = null, ccswitchVersion = null } = {}) {
  const started = Date.now();
  try {
    const data = await runRemoteProgram(
      entry,
      updateProgram({ codex, ccswitch, codexVersion, ccswitchVersion }),
      900000,
    );
    const after = data.after ?? {};
    return {
      host: entry.host,
      label: entry.label,
      ok: !data.codex?.code && !data.ccswitch?.code,
      codex: {
        before: null,
        after: parseCodexVersion(after.codex),
        exitCode: data.codex?.code ?? null,
        output: data.codex?.out ?? null,
      },
      ccswitch: {
        before: null,
        after: parseCcSwitchVersion(after.ccswitch),
        exitCode: data.ccswitch?.code ?? null,
        output: data.ccswitch?.out ?? null,
      },
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      host: entry.host,
      label: entry.label,
      ok: false,
      error: String(err?.stderr || err?.message || err).trim().split("\n").slice(-2).join(" ").slice(0, 220),
      ms: Date.now() - started,
    };
  }
}
