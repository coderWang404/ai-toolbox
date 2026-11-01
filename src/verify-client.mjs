// 通过临时 app-server 实例校验写入后的配置（只读，不触碰正在运行的实例）。
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { CHATGPT_CODEX_BIN } from "./paths.mjs";

function executable(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 在 PATH 里找一个可执行文件（GUI App 的 PATH 已由 Backend 补齐）。 */
function which(program) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, program);
    if (executable(candidate)) return candidate;
  }
  return null;
}

/** 扫描版本目录，按数字版本从大到小排序。 */
function versionsWith(root, suffix) {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((name) => existsSync(path.join(root, name, suffix)))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

/** 找到一个可用的 codex 二进制：优先 ChatGPT 应用内置，其次 PATH，再其次常见安装位置。 */
export function findCodexBinary() {
  const home = process.env.HOME || os.homedir();
  const candidates = [
    CHATGPT_CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    which("codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(home, ".local/bin/codex"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (executable(candidate)) return candidate;
  }

  for (const version of versionsWith(path.join(home, ".nvm/versions/node"), "bin/codex")) {
    const candidate = path.join(home, ".nvm/versions/node", version, "bin/codex");
    if (executable(candidate)) return candidate;
  }
  for (const version of versionsWith(path.join(home, ".local/share/fnm/node-versions"), "installation/bin/codex")) {
    const candidate = path.join(home, ".local/share/fnm/node-versions", version, "installation/bin/codex");
    if (executable(candidate)) return candidate;
  }
  return null;
}

/**
 * 启动一次性 app-server，读取生效配置。
 * @returns {Promise<{ok: boolean, config?: object, error?: string}>}
 */
export function readEffectiveConfig({ codexBin, codexHome, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    const child = spawn(codexBin, ["app-server", "--listen", "stdio://"], {
      env: { ...process.env, CODEX_HOME: codexHome, RUST_LOG: "error" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    let nextId = 1;
    const pending = new Map();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      done({ ok: false, error: "校验超时" });
    }, timeoutMs);
    timer.unref?.();

    // 不消费 stderr 会在输出较多时把子进程堵死。
    child.stderr.on("data", () => {});

    function request(method, params) {
      const id = nextId++;
      return new Promise((res, rej) => {
        const reqTimer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rej(new Error(`timeout: ${method}`));
          }
        }, timeoutMs - 2000);
        reqTimer.unref?.();
        pending.set(id, { res, rej, timer: reqTimer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    }

    child.stdout.on("data", (d) => {
      buffer += d.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { res, rej, timer: reqTimer } = pending.get(msg.id);
          clearTimeout(reqTimer);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(JSON.stringify(msg.error)));
          else res(msg.result);
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, error: `无法启动 codex 二进制: ${err.message}` });
    });

    (async () => {
      try {
        await request("initialize", {
          clientInfo: { name: "ai-toolbox", title: "verify", version: "1.0.0" },
          capabilities: { experimentalApi: false },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
        const res = await request("config/read", {});
        clearTimeout(timer);
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        done({ ok: true, config: res.config ?? {} });
      } catch (err) {
        clearTimeout(timer);
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        done({ ok: false, error: err.message });
      }
    })();
  });
}
