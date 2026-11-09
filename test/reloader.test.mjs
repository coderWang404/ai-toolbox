import test from "node:test";
import assert from "node:assert/strict";
import { classifyProcess, attributeOwner } from "../src/reloader.mjs";

const rows = [
  { pid: 1, ppid: 0, tty: "??", command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
  {
    pid: 2,
    ppid: 1,
    tty: "??",
    command:
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/../CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default",
  },
  { pid: 3, ppid: 0, tty: "??", command: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" },
  {
    pid: 4,
    ppid: 3,
    tty: "??",
    command: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/../CodexCLI.app/Contents/MacOS/codex app-server",
  },
  { pid: 5, ppid: 1, tty: "??", command: "/usr/bin/ssh -T -o BatchMode=yes 124.220.196.185 codex app-server" },
  {
    pid: 6,
    ppid: 5,
    tty: "??",
    command: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/../CodexCLI.app/Contents/MacOS/codex app-server",
  },
  { pid: 7, ppid: 0, tty: "??", command: "/Library/Developer/CommandLineTools/usr/bin/node /usr/local/bin/codex.js app-server unix:///tmp/x" },
  { pid: 8, ppid: 0, tty: "ttys003", command: "/usr/local/bin/codex" },
  { pid: 9, ppid: 0, tty: "??", command: "/usr/local/bin/codex proxy" },
];

const byPid = new Map(rows.map((r) => [r.pid, r]));
const find = (pid) => rows.find((r) => r.pid === pid);

test("app-server owner follows the parent chain, not the binary path", () => {
  assert.equal(attributeOwner(find(2), byPid), "chatgpt");
  assert.equal(attributeOwner(find(4), byPid), "other"); // 被 DeepSeek Harness 拉起
  assert.equal(attributeOwner(find(6), byPid), "remote"); // SSH 远程会话
});

test("classifyProcess identifies app-servers, daemons and TUIs", () => {
  assert.equal(classifyProcess(find(2), byPid).kind, "app-server");
  assert.equal(classifyProcess(find(2), byPid).owner, "chatgpt");
  assert.equal(classifyProcess(find(4), byPid).owner, "other");
  assert.equal(classifyProcess(find(6), byPid).owner, "remote");
  assert.equal(classifyProcess(find(7), byPid).kind, "app-server-daemon");
  assert.equal(classifyProcess(find(8), byPid).kind, "tui");
  assert.equal(classifyProcess(find(9), byPid), null); // proxy 不是 app-server
});

test("unrelated processes are ignored", () => {
  assert.equal(classifyProcess({ pid: 99, ppid: 0, tty: "??", command: "/usr/bin/python3 main.py" }, new Map()), null);
  // ssh 客户端命令行里的 `codex app-server` 是远程要执行的命令，不是本机进程
  assert.equal(classifyProcess(find(5), byPid), null);
});
