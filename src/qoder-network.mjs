// Qoder CN 网络状态与管理：DNS/hosts、Clash TUN/fake-IP、HTTPDNS、Qoder 日志和入口探测。
// 只读写本机 Qoder 相关配置；写 /etc/hosts 时通过 osascript 弹出系统管理员授权。
import { execFile } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  statSync,
  readlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { dataDir } from "./paths.mjs";

const APP_PATH = "/Applications/Qoder CN.app";
const APP_BIN = path.join(APP_PATH, "Contents/MacOS/Qoder CN");
const QODER_HOME = path.join(homedir(), ".qoder-cn");
const LOG_DIR = path.join(QODER_HOME, "logs");
const CACHE_DIR = path.join(QODER_HOME, ".cache");
const CLASH_BASE = path.join(homedir(), "Library/Application Support/io.github.clash-verge-rev.clash-verge-rev");
const HOSTS_PATH = "/etc/hosts";
const HOSTS_MARKER = "# Qoder CN AI Toolbox workaround";
const OLD_HOSTS_MARKER = "# Qoder CN campus workaround";
const HTTPDNS_LABEL = "com.local.qoder-httpdns";
const HTTPDNS_PLIST = path.join(homedir(), "Library/LaunchAgents", `${HTTPDNS_LABEL}.plist`);
const LIVE_IP = "8.153.206.47";
const DEAD_IPS = ["8.160.169.15", "8.160.169.149"];
const DOMAINS = [
  "gateway.qoder.com.cn",
  "openapi.qoder.com.cn",
  "qoder.com.cn",
  "www.qoder.com.cn",
];
const QODER_RULES = [
  `IP-CIDR,${LIVE_IP}/32,DIRECT,no-resolve`,
  "DOMAIN-SUFFIX,qoder.com.cn,DIRECT",
  "DOMAIN-SUFFIX,qoder.cn,DIRECT",
  "DOMAIN-SUFFIX,aliyunga0018.com,DIRECT",
];

function run(command, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
        error,
      });
    });
  });
}

async function runOrThrow(command, args, timeout = 5000) {
  const result = await run(command, args, timeout);
  if (!result.ok) {
    const message = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(message || `${command} 执行失败`);
  }
  return result;
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function writeAtomic(file, content, mode = 0o644) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
  try { chmodSync(file, mode); } catch { /* 忽略 */ }
}

function isExecutable(file) {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

function redact(text, max = 220) {
  return String(text ?? "")
    .replace(/(?:sk|oc_sk|grok|today)_[A-Za-z0-9_-]{8,}/g, "…")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer …")
    .slice(0, max);
}

function parseHosts(text) {
  const entries = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const clean = line.replace(/#.*/, "").trim();
    if (!clean) continue;
    const parts = clean.split(/\s+/);
    if (parts.length < 2) continue;
    const ip = parts[0];
    for (const domain of parts.slice(1)) entries.push({ ip, domain });
  }
  return entries;
}

function qoderHosts(entries) {
  return entries.filter((entry) => DOMAINS.includes(entry.domain));
}

function hostsPinned(entries, ip = LIVE_IP) {
  return DOMAINS.every((domain) => entries.some((entry) => entry.domain === domain && entry.ip === ip));
}

async function systemDNS(domain) {
  const result = await run("dscacheutil", ["-q", "host", "-a", "name", domain], 4000);
  const addresses = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const address = line.match(/^\s*ip_address:\s*(\S+)/)?.[1];
    const ipv6 = line.match(/^\s*ipv6_address:\s*(\S+)/)?.[1];
    if (address) addresses.push(address);
    if (ipv6 && !ipv6.startsWith("fe80")) addresses.push(ipv6);
  }
  return [...new Set(addresses)];
}

async function clashDNS(domain) {
  const result = await run("dig", ["+short", "+time=2", "+tries=1", "@198.18.0.1", domain, "A"], 4000);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+\.\d+\.\d+\.\d+$/.test(line));
}

function fakeIP(address) {
  return /^198\.(18|19)\./.test(String(address ?? ""));
}

async function qoderApp() {
  const installed = existsSync(APP_PATH);
  let version = null;
  if (installed) {
    const result = await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(APP_PATH, "Contents/Info.plist")], 3000);
    version = result.stdout.trim() || null;
  }
  const processes = await run("pgrep", ["-f", APP_BIN], 3000);
  const pids = processes.stdout.split(/\r?\n/).map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
  return { installed, running: pids.length > 0, version, pids };
}

async function httpdnsStatus() {
  const envResult = await run("launchctl", ["getenv", "QODERCN_HTTPDNS"], 3000);
  const env = envResult.stdout.trim() || null;
  const installed = existsSync(HTTPDNS_PLIST);
  const uid = process.getuid?.() ?? 501;
  const loadedResult = await run("launchctl", ["print", `gui/${uid}/${HTTPDNS_LABEL}`], 3000);
  return {
    env,
    disabled: env === "false",
    agentInstalled: installed,
    agentLoaded: loadedResult.ok,
  };
}

function parseProfiles(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const current = lines.find((line) => /^current:\s*\S+/.test(line))?.replace(/^current:\s*/, "").trim() ?? null;
  const items = [];
  let item = null;
  let inOption = false;
  let inSelected = false;
  for (const line of lines) {
    const uid = line.match(/^- uid:\s*(\S+)/)?.[1];
    if (uid) {
      item = { uid, type: null, name: null, file: null, rules: null, merge: null, node: null };
      items.push(item);
      inOption = false;
      inSelected = false;
      continue;
    }
    if (!item) continue;
    const trimmed = line.trim();
    if (/^type:/.test(trimmed)) item.type = trimmed.slice(5).trim();
    else if (/^name:/.test(trimmed)) item.name = trimmed.slice(5).trim();
    else if (/^file:/.test(trimmed)) item.file = trimmed.slice(5).trim();
    else if (/^option:/.test(trimmed)) { inOption = true; inSelected = false; }
    else if (/^selected:/.test(trimmed)) { inSelected = true; inOption = false; }
    else if (inOption && /^rules:/.test(trimmed)) item.rules = trimmed.slice(6).trim();
    else if (inOption && /^merge:/.test(trimmed)) item.merge = trimmed.slice(6).trim();
    else if (inSelected && /^now:/.test(trimmed)) item.node = trimmed.slice(4).trim();
  }
  return { current, items };
}

function generatedClashState(base = CLASH_BASE) {
  const generatedPath = path.join(base, "clash-verge.yaml");
  const text = readText(generatedPath);
  const useSystemHosts = /^\s*use-system-hosts:\s*true\s*$/m.test(text);
  const qoderRules = QODER_RULES.some((rule) => text.includes(rule));
  const qoderHostsPresent = DOMAINS.every((domain) => new RegExp(`^\\s*"?${domain.replace(/\./g, "\\.")}"?\\s*:\\s*"?${LIVE_IP.replace(/\./g, "\\.")}"?\\s*$`, "m").test(text));
  const tun = /^\s*enable:\s*true\s*$/m.test(text.split(/^tun:/m)[1]?.split(/^[a-zA-Z]/m)[0] ?? "") || /enable_tun_mode:\s*true/.test(readText(path.join(base, "verge.yaml")));
  const fakeIPRange = text.match(/^\s*fake-ip-range:\s*(\S+)/m)?.[1] ?? null;
  const enhancedMode = text.match(/^\s*enhanced-mode:\s*(\S+)/m)?.[1] ?? null;
  return { generatedPath, useSystemHosts, qoderRules, qoderHostsPresent, tun, fakeIPRange, enhancedMode, updatedAt: fileMtime(generatedPath) };
}

function fileMtime(file) {
  try {
    return new Date(statSync(file).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

async function unixGet(socketPath, requestPath) {
  const result = await run("curl", [
    "-sS",
    "--max-time",
    "2",
    "--noproxy",
    "*",
    "--unix-socket",
    socketPath,
    `http://localhost${requestPath}`,
  ], 3000);
  if (!result.ok || !result.stdout.trim()) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

async function clashStatus(base = CLASH_BASE) {
  const processes = await run("pgrep", ["-f", "clash-verge|verge-mihomo|mihomo"], 3000);
  const running = processes.stdout.split(/\r?\n/).some((line) => Number(line.trim()) > 0);
  const installed = existsSync(base) || existsSync("/Applications/Clash Verge.app");
  const profiles = parseProfiles(readText(path.join(base, "profiles.yaml")));
  const currentItem = profiles.items.find((item) => item.uid === profiles.current) ?? null;
  const rulesId = currentItem?.rules || profiles.items.find((item) => item.type === "rules")?.uid;
  const mergeId = currentItem?.merge || profiles.items.find((item) => item.type === "merge")?.uid;
  const rulesFile = rulesId ? path.join(base, "profiles", `${rulesId}.yaml`) : null;
  const mergeFile = mergeId ? path.join(base, "profiles", `${mergeId}.yaml`) : null;
  const generated = generatedClashState(base);

  let runtimeRules = false;
  let runtimeRuleIndex = null;
  let runtimeTun = null;
  const socketRoot = "/var/run/clash-verge-service/users";
  let socketPath = null;
  try {
    for (const user of readdirSync(socketRoot)) {
      const candidate = path.join(socketRoot, user, "verge-mihomo.sock");
      if (existsSync(candidate)) { socketPath = candidate; break; }
    }
  } catch { /* 没有服务权限 */ }
  if (socketPath) {
    const rules = await unixGet(socketPath, "/rules");
    const list = Array.isArray(rules?.rules) ? rules.rules : [];
    const hit = list.find((rule) => {
      const payload = String(rule.payload ?? "");
      return payload.includes("qoder.com.cn") || payload === `${LIVE_IP}/32` || payload === LIVE_IP;
    });
    runtimeRules = !!hit;
    runtimeRuleIndex = hit?.index ?? null;
    const configs = await unixGet(socketPath, "/configs");
    runtimeTun = configs?.tun?.enable ?? null;
  }

  return {
    installed,
    running,
    tunEnabled: runtimeTun ?? generated.tun,
    fakeIP: generated.enhancedMode === "fake-ip" || String(generated.fakeIPRange ?? "").startsWith("198.18"),
    useSystemHosts: generated.useSystemHosts,
    qoderRules: runtimeRules || generated.qoderRules,
    ruleIndex: runtimeRuleIndex,
    qoderHostsPresent: generated.qoderHostsPresent,
    profile: currentItem?.name ?? currentItem?.uid ?? null,
    node: currentItem?.node ?? null,
    rulesFile,
    mergeFile,
    generatedPath: generated.generatedPath,
    generatedAt: generated.updatedAt,
    socketPath,
    runtimeTun,
  };
}

function qoderLog() {
  const latest = path.join(LOG_DIR, "latest");
  let runDir = null;
  try {
    const target = readlinkSync(latest);
    runDir = target ? path.resolve(LOG_DIR, target) : null;
  } catch { /* 忽略 */ }
  if (!runDir || !existsSync(runDir)) {
    try {
      const dirs = readdirSync(LOG_DIR).filter((name) => !name.startsWith(".")).sort();
      runDir = dirs.length ? path.join(LOG_DIR, dirs[dirs.length - 1]) : null;
    } catch { runDir = null; }
  }
  const logFile = runDir ? path.join(runDir, "qodercli.log") : null;
  if (!logFile || !existsSync(logFile)) {
    return { latestRun: runDir, networkMode: null, httpdnsConfigured: null, lastModelStatus: null, lastError: null, updatedAt: null };
  }
  const raw = readText(logFile);
  const text = raw.slice(-300_000);
  const networkModes = [...text.matchAll(/networkMode=([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
  const httpdnsValues = [...text.matchAll(/httpdnsConfigured=(true|false)/g)].map((match) => match[1] === "true");
  const modelStatuses = [...text.matchAll(/operation=modelCatalogFetch[^\n]*status=(\d{3})/g)].map((match) => Number(match[1]));
  const errorLines = text.split(/\r?\n/).filter((line) => /\b(ERROR|FAILED)\b/i.test(line));
  return {
    latestRun: runDir,
    networkMode: networkModes.at(-1) ?? null,
    httpdnsConfigured: httpdnsValues.at(-1) ?? null,
    lastModelStatus: modelStatuses.at(-1) ?? null,
    lastError: errorLines.length ? redact(errorLines.at(-1)) : null,
    updatedAt: fileMtime(logFile),
  };
}

async function probe(domain, ip, requestPath, { resolveIP = true, timeout = 6 } = {}) {
  const args = ["-sS", "-m", String(timeout), "--noproxy", "*", "-o", "/dev/null", "-w", "%{http_code}|%{time_total}|%{remote_ip}"];
  if (resolveIP) args.push("--resolve", `${domain}:443:${ip}`);
  args.push(`https://${domain}${requestPath}`);
  const started = Date.now();
  const result = await run("curl", args, (timeout + 2) * 1000);
  const [codeText, timeText, remoteIP] = result.stdout.trim().split("|");
  const code = Number(codeText);
  return {
    domain,
    ip,
    url: `https://${domain}${requestPath}`,
    status: Number.isFinite(code) && code > 0 ? code : null,
    timeMs: Number.isFinite(Number(timeText)) ? Math.round(Number(timeText) * 1000) : null,
    remoteIP: remoteIP || null,
    reachable: Number.isFinite(code) && code > 0 && code < 500,
    error: result.ok ? null : redact(result.stderr || result.error?.message || "curl 失败"),
    elapsedMs: Date.now() - started,
  };
}

async function endpoints() {
  const [gatewayLive, openapiLive, gatewaySystem, openapiSystem] = await Promise.all([
    probe("gateway.qoder.com.cn", LIVE_IP, "/api/v3/user/status", { resolveIP: true }),
    probe("openapi.qoder.com.cn", LIVE_IP, "/algo/api/v1/ping", { resolveIP: true }),
    probe("gateway.qoder.com.cn", LIVE_IP, "/api/v3/user/status", { resolveIP: false }),
    probe("openapi.qoder.com.cn", LIVE_IP, "/algo/api/v1/ping", { resolveIP: false }),
  ]);
  return [
    { name: "gateway", via: "固定入口", ...gatewayLive },
    { name: "openapi", via: "固定入口", ...openapiLive },
    { name: "gateway", via: "系统 DNS", ...gatewaySystem },
    { name: "openapi", via: "系统 DNS", ...openapiSystem },
  ];
}

export async function qoderStatus() {
  const app = await qoderApp();
  const hostsText = readText(HOSTS_PATH);
  const hostEntries = qoderHosts(parseHosts(hostsText));
  const hosts = {
    entries: hostEntries,
    pinned: hostsPinned(hostEntries),
    ip: hostEntries[0]?.ip ?? null,
    backup: ["/etc/hosts.bak.qoder-ai-toolbox", "/etc/hosts.bak.qoder"].find((file) => existsSync(file)) ?? null,
  };
  const [systemGateway, systemOpenapi, clashGateway, clashOpenapi, httpdns, clash, log, endpointList] = await Promise.all([
    systemDNS("gateway.qoder.com.cn"),
    systemDNS("openapi.qoder.com.cn"),
    clashDNS("gateway.qoder.com.cn"),
    clashDNS("openapi.qoder.com.cn"),
    httpdnsStatus(),
    clashStatus(),
    qoderLog(),
    endpoints(),
  ]);
  const dns = {
    system: { gateway: systemGateway, openapi: systemOpenapi },
    clash: { gateway: clashGateway, openapi: clashOpenapi },
    fakeIP: [...systemGateway, ...systemOpenapi, ...clashGateway, ...clashOpenapi].some(fakeIP),
    resolver: null,
  };

  const issues = [];
  if (!app.installed) issues.push("没有安装 Qoder CN");
  else if (!app.running) issues.push("Qoder CN 没有运行");
  if (app.installed && !hosts.pinned) issues.push("hosts 没有固定到可用入口");
  if (!httpdns.disabled) issues.push("Qoder HTTPDNS 仍处于开启状态");
  if (clash.running && clash.tunEnabled && !clash.useSystemHosts) issues.push("Clash TUN 没有使用系统 hosts");
  if (clash.running && !clash.qoderRules) issues.push("Clash 缺少 Qoder 直连规则");
  if (log.networkMode === "httpdns") issues.push("Qoder 日志仍在走 HTTPDNS");
  if (log.httpdnsConfigured === true) issues.push("Qoder 日志显示 HTTPDNS 已启用");
  const live = endpointList.filter((endpoint) => endpoint.via === "固定入口");
  if (live.some((endpoint) => !endpoint.reachable)) issues.push("Qoder 固定入口不可达");

  const broken = !app.installed || live.some((endpoint) => !endpoint.reachable);
  return {
    command: "qoder-status",
    app,
    hosts,
    dns,
    httpdns,
    clash,
    log,
    endpoints: endpointList,
    health: broken ? "broken" : issues.length ? "warning" : "ok",
    issues,
    checkedAt: new Date().toISOString(),
  };
}

// ---------- 本机修复（全部可逆） ----------

function hostsWithBlock(text, ip = LIVE_IP, enabled = true) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith(HOSTS_MARKER) || line.startsWith(OLD_HOSTS_MARKER)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (DOMAINS.some((domain) => line.includes(domain))) continue;
      if (!line.trim()) { skipping = false; continue; }
      skipping = false;
    }
    out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  if (enabled) {
    out.push("", HOSTS_MARKER);
    for (const domain of DOMAINS) out.push(`${ip} ${domain}`);
  }
  return `${out.join("\n")}\n`;
}

function ensureRules(text, enabled) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let start = lines.findIndex((line) => /^prepend:\s*$/.test(line.trim()) || /^prepend:\s*\[\]\s*$/.test(line.trim()));
  if (start === -1) {
    if (!enabled) return lines.join("\n");
    lines.push("", "prepend:", ...QODER_RULES.map((rule) => `  - ${rule}`));
    return `${lines.join("\n").replace(/\n+$/, "")}\n`;
  }
  if (/^prepend:\s*\[\]\s*$/.test(lines[start].trim())) {
    if (!enabled) return lines.join("\n");
    lines.splice(start, 1, "prepend:", ...QODER_RULES.map((rule) => `  - ${rule}`));
    return `${lines.join("\n").replace(/\n+$/, "")}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z0-9_-]+:\s*/.test(lines[i])) { end = i; break; }
  }
  const existing = new Set(
    lines.slice(start + 1, end)
      .map((line) => line.match(/^\s*-\s*(.+?)\s*$/)?.[1])
      .filter(Boolean),
  );
  if (enabled) {
    const missing = QODER_RULES.filter((rule) => !existing.has(rule));
    lines.splice(end, 0, ...missing.map((rule) => `  - ${rule}`));
  } else {
    for (let i = end - 1; i > start; i -= 1) {
      const value = lines[i].match(/^\s*-\s*(.+?)\s*$/)?.[1];
      if (value && QODER_RULES.includes(value)) lines.splice(i, 1);
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function sectionRange(lines, key) {
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z0-9_-]+:\s*/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function upsertIndented(lines, key, value, enabled) {
  const range = sectionRange(lines, key);
  if (!range) {
    if (!enabled) return;
    lines.push("", `${key}:`, `  ${value}`);
    return;
  }
  const keyName = value.split(":")[0];
  const existing = lines.slice(range.start + 1, range.end).findIndex((line) => new RegExp(`^\\s+${keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`).test(line));
  if (enabled) {
    if (existing === -1) {
      let insertAt = range.end;
      while (insertAt > range.start + 1 && !lines[insertAt - 1].trim()) insertAt -= 1;
      lines.splice(insertAt, 0, `  ${value}`);
    } else {
      lines[range.start + 1 + existing] = `  ${value}`;
    }
  } else if (existing !== -1) {
    lines.splice(range.start + 1 + existing, 1);
  }
}

function ensureMerge(text, enabled) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  for (const value of ["use-system-hosts: true", "use-hosts: true"]) upsertIndented(lines, "dns", value, enabled);
  // hosts 单独处理，支持引号键。
  let range = sectionRange(lines, "hosts");
  if (!range) {
    if (!enabled) return `${lines.join("\n").replace(/\n+$/, "")}\n`;
    lines.push("", "hosts:", ...DOMAINS.map((domain) => `  "${domain}": "${LIVE_IP}"`));
    return `${lines.join("\n").replace(/\n+$/, "")}\n`;
  }
  if (enabled) {
    for (const domain of DOMAINS) {
      range = sectionRange(lines, "hosts");
      const existing = lines.slice(range.start + 1, range.end).findIndex((line) => line.includes(domain));
      if (existing === -1) lines.splice(range.end, 0, `  "${domain}": "${LIVE_IP}"`);
    }
  } else {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (DOMAINS.some((domain) => lines[i].includes(domain))) lines.splice(i, 1);
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function backupFile(file, stamp) {
  const backup = `${file}.bak.ai-toolbox-${stamp}`;
  copyFileSync(file, backup);
  return backup;
}

function clashFiles(clash) {
  return [clash.rulesFile, clash.mergeFile].filter((file) => file && existsSync(file));
}

export async function patchClash(enabled = true) {
  const clash = await clashStatus();
  if (!clash.installed) {
    return { ok: false, skipped: true, message: "没有安装 Clash Verge" };
  }
  const files = clashFiles(clash);
  if (!files.length) {
    return { ok: false, skipped: true, message: "没有找到 Clash 的 rules/merge 增强文件" };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backups = [];
  for (const file of files) {
    const original = readText(file);
    const next = file === clash.rulesFile ? ensureRules(original, enabled) : ensureMerge(original, enabled);
    if (next === original) continue;
    backups.push(backupFile(file, stamp));
    writeAtomic(file, next);
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const after = await clashStatus();
  const applied = enabled
    ? after.qoderRules && after.useSystemHosts && after.qoderHostsPresent
    : !after.qoderRules && !after.qoderHostsPresent;
  return {
    ok: applied,
    applied,
    backups,
    message: applied ? null : "Clash 配置已写入，若未生效请在 Clash Verge 里点一次「重新加载」",
    clash: after,
  };
}

function hostsScript(enabled) {
  // 由 root 执行的 Python：只替换带标记的块，保留 hosts 其它内容。
  return `from pathlib import Path
import os, shutil, time
p = Path("/etc/hosts")
marker = ${JSON.stringify(HOSTS_MARKER)}
old_marker = ${JSON.stringify(OLD_HOSTS_MARKER)}
domains = ${JSON.stringify(DOMAINS)}
ip = ${JSON.stringify(LIVE_IP)}
enabled = ${enabled ? "True" : "False"}
text = p.read_text()
lines = text.splitlines()
out, skipping = [], False
for line in lines:
    if line.startswith(marker) or line.startswith(old_marker):
        skipping = True
        continue
    if skipping:
        if any(d in line for d in domains):
            continue
        if not line.strip():
            skipping = False
            continue
        skipping = False
    out.append(line)
while out and not out[-1].strip():
    out.pop()
if enabled:
    out.extend(["", marker] + [f"{ip} {d}" for d in domains])
stamp = time.strftime("%Y%m%d-%H%M%S")
backup = f"/etc/hosts.bak.qoder-ai-toolbox-{stamp}"
shutil.copy2(p, backup)
p.write_text("\\n".join(out) + "\\n")
os.chmod(p, 0o644)
print(backup)
`;
}

export async function setHosts(enabled = true) {
  const current = readText(HOSTS_PATH);
  const entries = qoderHosts(parseHosts(current));
  if (enabled && hostsPinned(entries)) {
    return { ok: true, skipped: true, message: "hosts 已经是固定入口" };
  }
  if (!enabled && entries.length === 0 && !current.includes(HOSTS_MARKER) && !current.includes(OLD_HOSTS_MARKER)) {
    return { ok: true, skipped: true, message: "hosts 没有 Qoder 固定条目" };
  }
  const script = hostsScript(enabled);
  const temp = path.join("/tmp", `qoder-ai-toolbox-hosts-${process.pid}.py`);
  writeFileSync(temp, script, { mode: 0o700 });
  const shell = `/usr/bin/python3 ${temp} && dscacheutil -flushcache && (killall -HUP mDNSResponder || true)`;
  const appleScript = `do shell script ${JSON.stringify(shell)} with administrator privileges`;
  try {
    const result = await runOrThrow("osascript", ["-e", appleScript], 120000);
    return { ok: true, backup: result.stdout.trim() || null };
  } catch (error) {
    return { ok: false, message: redact(error.message || "写入 hosts 失败或被取消") };
  } finally {
    try { unlinkSync(temp); } catch { /* 忽略 */ }
  }
}

function httpdnsPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${HTTPDNS_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string>
    <string>setenv</string>
    <string>QODERCN_HTTPDNS</string>
    <string>false</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/qoder-httpdns.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/qoder-httpdns.err</string>
</dict>
</plist>
`;
}

export async function setHttpdnsDisabled(disabled = true) {
  const uid = process.getuid?.() ?? 501;
  if (disabled) {
    writeAtomic(HTTPDNS_PLIST, httpdnsPlist(), 0o644);
    await run("launchctl", ["bootout", `gui/${uid}/${HTTPDNS_LABEL}`], 5000);
    await runOrThrow("launchctl", ["bootstrap", `gui/${uid}`, HTTPDNS_PLIST], 8000);
    await runOrThrow("launchctl", ["setenv", "QODERCN_HTTPDNS", "false"], 5000);
    return { ok: true, disabled: true };
  }
  await run("launchctl", ["bootout", `gui/${uid}/${HTTPDNS_LABEL}`], 5000);
  try { unlinkSync(HTTPDNS_PLIST); } catch { /* 忽略 */ }
  await run("launchctl", ["unsetenv", "QODERCN_HTTPDNS"], 5000);
  return { ok: true, disabled: false };
}

export async function clearQoderCaches() {
  const moved = [];
  try {
    for (const name of readdirSync(CACHE_DIR)) {
      if (name === "dns-cache.json" || name === "qoder-client-dns-cache.json" || name === "endpoint-cache-cn.json") {
        const src = path.join(CACHE_DIR, name);
        const dst = `${src}.bak.ai-toolbox-${Date.now()}`;
        renameSync(src, dst);
        moved.push(dst);
      }
    }
  } catch { /* 缓存目录不存在 */ }
  return moved;
}

export async function restartQoder() {
  await run("osascript", ["-e", 'quit app "Qoder CN"'], 10000);
  for (let i = 0; i < 20; i += 1) {
    const app = await qoderApp();
    if (!app.running) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const open = await run("open", ["-a", "Qoder CN"], 10000);
  return { ok: open.ok, message: open.ok ? null : redact(open.stderr || "打开 Qoder 失败") };
}

export async function openQoder() {
  const result = await run("open", ["-a", "Qoder CN"], 10000);
  return { ok: result.ok, message: result.ok ? null : redact(result.stderr || "打开 Qoder 失败") };
}

export async function applyQoderFix({ restart = true } = {}) {
  const steps = [];
  const hosts = await setHosts(true);
  steps.push({ step: "hosts", ...hosts });
  if (!hosts.ok) return { ok: false, steps, message: hosts.message };
  const httpdns = await setHttpdnsDisabled(true);
  steps.push({ step: "httpdns", ...httpdns });
  const clash = await patchClash(true);
  steps.push({ step: "clash", ...clash });
  const caches = await clearQoderCaches();
  steps.push({ step: "caches", ok: true, moved: caches });
  if (restart) {
    const restarted = await restartQoder();
    steps.push({ step: "restart", ...restarted });
  }
  const status = await qoderStatus();
  return { ok: status.health !== "broken", steps, status };
}

export async function restoreQoderDefaults({ restart = true } = {}) {
  const steps = [];
  const hosts = await setHosts(false);
  steps.push({ step: "hosts", ...hosts });
  if (!hosts.ok) return { ok: false, steps, message: hosts.message ?? "还原 hosts 失败或被取消" };
  const httpdns = await setHttpdnsDisabled(false);
  steps.push({ step: "httpdns", ...httpdns });
  const clash = await patchClash(false);
  steps.push({ step: "clash", ...clash });
  const caches = await clearQoderCaches();
  steps.push({ step: "caches", ok: true, moved: caches });
  if (restart) {
    const restarted = await restartQoder();
    steps.push({ step: "restart", ...restarted });
  }
  const status = await qoderStatus();
  return { ok: true, steps, status };
}

export {
  APP_PATH,
  APP_BIN,
  DOMAINS,
  HOSTS_MARKER,
  LIVE_IP,
  QODER_RULES,
  ensureMerge,
  ensureRules,
  hostsWithBlock,
  parseProfiles,
};
