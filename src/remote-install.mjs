// 远端直装（绕过 GitHub）：远端机器通常访问不了 GitHub，cc-switch 自更新和
// npm 装 codex 都会失败。这里在本机下载 release 资产，再用 scp 推过去替换。
import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { dataDir } from "./paths.mjs";
import { sshArgs } from "./remote-sync.mjs";

const execFileAsync = promisify(execFile);
const MARKER = "AI_TOOLBOX_REMOTE_JSON:";

const CCSWITCH_ASSET = (version) =>
  `https://github.com/SaladDay/cc-switch-cli/releases/download/v${String(version).replace(/^v/, "")}/cc-switch-cli-linux-x64.tar.gz`;
const CODEX_ASSET = (version) =>
  `https://github.com/openai/codex/releases/download/rust-v${String(version).replace(/^v/, "")}/codex-x86_64-unknown-linux-musl.tar.gz`;

function cacheDir() {
  const dir = path.join(dataDir(), "cache");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function download(url, target) {
  if (existsSync(target) && statSync(target).size > 1024) return target;
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "ai-toolbox" },
    signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  return target;
}

async function extract(archive, member, into) {
  await execFileAsync("tar", ["-xzf", archive, "-C", into], { timeout: 180000 });
  const extracted = path.join(into, member);
  if (!existsSync(extracted)) throw new Error(`压缩包里没有 ${member}`);
  return extracted;
}

function scpArgs(entry, local, remote) {
  const args = ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=12"];
  if (entry.port) args.push("-P", String(entry.port));
  if (entry.identityFile) {
    const identity = String(entry.identityFile).replace(/^~(?=$|\/)/, homedir());
    args.push("-i", identity, "-o", "IdentitiesOnly=yes");
  }
  const target = entry.user ? `${entry.user}@${entry.host}` : entry.host;
  args.push(local, `${target}:${remote}`);
  return args;
}

async function sshJson(entry, program, timeoutMs = 180000) {
  const { stdout } = await execFileAsync("ssh", sshArgs(entry, program), {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  const line = stdout
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith(MARKER));
  if (!line) throw new Error(stdout.trim().slice(-180) || "远程没有返回结果");
  return JSON.parse(line.slice(MARKER.length));
}

function installProgram(kind, tmpPath) {
  const binName = kind === "codex" ? "codex" : "cc-switch";
  return `
import json, os, shutil, subprocess
src = ${JSON.stringify(tmpPath)}
name = ${JSON.stringify(binName)}
def out(cmd):
    try:
        return subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=40).stdout.strip()
    except Exception:
        return ""
current = out("command -v " + name + " || true")
home_bin = os.path.expanduser("~/.local/bin/" + name)
targets = ([current] if current else []) + [home_bin]
installed = None
errors = []
for target in targets:
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp_target = target + ".new"
        shutil.copyfile(src, tmp_target)
        os.chmod(tmp_target, 0o755)
        os.replace(tmp_target, target)
        installed = target
        break
    except Exception as exc:
        errors.append("%s: %s" % (target, exc))
version = out(name + " --version 2>/dev/null | head -1")
print(${JSON.stringify(MARKER)} + json.dumps({"installed": installed, "version": version, "errors": errors}))
`;
}

async function pushAndInstall(entry, kind, localBinary, version) {
  const remoteTmp = `/tmp/ai-toolbox-${kind}-${Date.now()}`;
  await execFileAsync("scp", scpArgs(entry, localBinary, remoteTmp), { timeout: 600000, maxBuffer: 1024 * 1024 });
  const result = await sshJson(entry, installProgram(kind, remoteTmp), 240000);
  try {
    await execFileAsync("ssh", sshArgs(entry, `import os\nos.remove(${JSON.stringify(remoteTmp)})\n`), { timeout: 30000 });
  } catch {
    /* 清理失败无妨 */
  }
  return { ...result, version: result.version || null, requested: version };
}

/** 本机下载 cc-switch-cli 的 linux-x64 包并解出二进制（带缓存）。 */
export async function prepareCcSwitchBinary(version) {
  const dir = cacheDir();
  const archive = path.join(dir, `cc-switch-cli-${version}-linux-x64.tar.gz`);
  await download(CCSWITCH_ASSET(version), archive);
  const work = path.join(dir, `extract-cc-switch-${version}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  return extract(archive, "cc-switch", work);
}

/** 本机下载 codex 的 x86_64 linux 静态包并解出二进制（带缓存）。 */
export async function prepareCodexBinary(version) {
  const dir = cacheDir();
  const archive = path.join(dir, `codex-${version}-linux-x64.tar.gz`);
  await download(CODEX_ASSET(version), archive);
  const work = path.join(dir, `extract-codex-${version}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  return extract(archive, "codex", work);
}

export async function installCcSwitchBinary(entry, version) {
  const binary = await prepareCcSwitchBinary(version);
  return pushAndInstall(entry, "ccswitch", binary, version);
}

export async function installCodexBinary(entry, version) {
  const binary = await prepareCodexBinary(version);
  return pushAndInstall(entry, "codex", binary, version);
}
