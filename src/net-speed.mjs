// 本机网络信息和测速。
//
// 重要：speed.cloudflare.com 在 Clash/Surge 的 TUN/fake-IP 模式下会被解析到
// 198.18.x.x，测速流量实际走代理，而不是物理线路；这时 Cloudflare 的数值会
// 严重偏低，TCP 延迟也变成到本地代理的 1~2ms。默认改用 macOS 自带的
// networkQuality（可绑定物理网卡），Cloudflare 只作为旧系统/失败时的兜底。
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
import { setDefaultResultOrder } from "node:dns";

setDefaultResultOrder("ipv4first");

const DOWN_BYTES = Number(process.env.NET_DOWN_BYTES || 40_000_000);
const UP_BYTES = Number(process.env.NET_UP_BYTES || 12_000_000);
const PHASE_MS = Number(process.env.NET_PHASE_MS || 8000);
const NETWORK_QUALITY = "/usr/bin/networkQuality";

function run(command, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      resolve(typeof stdout === "string" ? stdout : "");
    });
  });
}

function runCapture(command, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function pick(text, pattern) {
  return text.match(pattern)?.[1] ?? null;
}

function hardwarePorts(text) {
  const ports = [];
  let current = {};
  for (const line of text.split(/\r?\n/)) {
    const port = line.match(/Hardware Port:\s*(.+)/)?.[1];
    const device = line.match(/Device:\s*(\S+)/)?.[1];
    if (port) current = { name: port.trim() };
    if (device && current.name) {
      ports.push({ name: current.name, device });
      current = {};
    }
  }
  return ports;
}

function kindOf(name) {
  if (!name) return "其他";
  if (/wi-?fi|airport/i.test(name)) return "Wi-Fi";
  if (/ethernet|lan|thunderbolt|usb/i.test(name)) return "有线";
  return name;
}

function ipv6Of(text) {
  const found = [...text.matchAll(/inet6 (\S+)/g)].map((item) => item[1].split("%")[0]);
  return found.find((item) => !item.startsWith("fe80")) || found[0] || null;
}

function dnsOf(text) {
  const servers = [];
  let inFirst = false;
  for (const line of text.split(/\r?\n/)) {
    if (/resolver #1/.test(line)) inFirst = true;
    else if (/resolver #\d+/.test(line)) inFirst = false;
    if (!inFirst) continue;
    const server = line.match(/nameserver\[\d+\]\s*:\s*(\S+)/)?.[1];
    if (server && !servers.includes(server)) servers.push(server);
  }
  return servers.slice(0, 3);
}

/** fake-IP 段（Clash/Surge 常用 198.18.0.0/15），命中说明 DNS 被代理接管。 */
export function isFakeIP(address) {
  if (!address) return false;
  const parts = String(address).split(".").map(Number);
  return parts.length === 4 && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

async function proxyDetection() {
  const result = { detected: false, address: null, note: null };
  try {
    const found = await lookup("speed.cloudflare.com", { family: 4 });
    result.address = found.address;
    if (isFakeIP(found.address)) {
      result.detected = true;
      result.note = `speed.cloudflare.com 解析到 fake-IP ${found.address}，Cloudflare 测速会走代理；已改用 macOS networkQuality`;
    }
  } catch {
    /* DNS 失败时继续 */
  }
  return result;
}

export async function networkInfo() {
  const route = await run("route", ["-n", "get", "default"]);
  const interfaceName = pick(route, /interface:\s*(\S+)/);
  const gateway = pick(route, /gateway:\s*(\S+)/);
  const ports = hardwarePorts(await run("networksetup", ["-listallhardwareports"]));
  const port = ports.find((item) => item.device === interfaceName);
  const ifaceText = interfaceName ? await run("ifconfig", [interfaceName]) : "";
  const localIPv4 = pick(ifaceText, /inet (\d+\.\d+\.\d+\.\d+)/);
  const localIPv6 = ipv6Of(ifaceText);
  const media = pick(ifaceText, /media:\s*(.+)/)?.replace(/\s+/g, " ") ?? null;
  let ssid = null;
  if (interfaceName) {
    const summary = await run("ipconfig", ["getsummary", interfaceName]);
    ssid = pick(summary, /SSID\s*:\s*(.+)/)?.trim() || null;
  }
  const dns = dnsOf(await run("scutil", ["--dns"]));
  const counters = interfaceName ? countersOf(await run("netstat", ["-I", interfaceName, "-b"])) : { bytesIn: null, bytesOut: null };
  const trace = await traceInfo();
  const proxy = await proxyDetection();
  const status = pick(ifaceText, /status:\s*(\S+)/);
  const link = [media, status].filter(Boolean).join(" · ") || null;
  return {
    command: "net-info",
    interfaceName,
    interfaceKind: kindOf(port?.name),
    portName: port?.name ?? null,
    media: link,
    localIPv4,
    localIPv6,
    gateway,
    dns,
    ssid,
    bytesIn: counters.bytesIn,
    bytesOut: counters.bytesOut,
    publicIP: trace.ip,
    place: trace.loc,
    colo: trace.colo,
    isp: null,
    asn: null,
    httpProtocol: trace.protocol,
    proxyDetected: proxy.detected,
    proxyAddress: proxy.address,
    proxyNote: proxy.note,
    speedMethod: "networkQuality",
  };
}

function countersOf(text) {
  const line = text.split(/\r?\n/).find((item) => /<Link/.test(item));
  if (!line) return { bytesIn: null, bytesOut: null };
  const parts = line.trim().split(/\s+/);
  if (parts.length < 7) return { bytesIn: null, bytesOut: null };
  const bytesIn = Number(parts[parts.length - 5]);
  const bytesOut = Number(parts[parts.length - 2]);
  if (!Number.isFinite(bytesIn) || !Number.isFinite(bytesOut)) return { bytesIn: null, bytesOut: null };
  return { bytesIn, bytesOut };
}

async function traceInfo() {
  try {
    const response = await fetch("https://speed.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return {};
    const text = await response.text();
    const ip = pick(text, /^ip=(.+)$/m);
    const colo = pick(text, /^colo=(.+)$/m);
    const loc = pick(text, /^loc=(.+)$/m);
    const http = pick(text, /^http=(.+)$/m);
    const tls = pick(text, /^tls=(.+)$/m);
    const protocol = [http, tls].filter(Boolean).join(" · ") || null;
    return { ip, colo, loc, protocol };
  } catch {
    return {};
  }
}

function emitLine(emit, event) {
  emit(event);
}

/** 解析 macOS networkQuality -s -c 的 JSON。 */
export function parseNetworkQuality(raw) {
  let text = String(raw ?? "").trim();
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }
  const data = JSON.parse(text);
  const downloadMbps = Number(data.dl_throughput) / 1e6;
  const uploadMbps = Number(data.ul_throughput) / 1e6;
  const pingMs = Number(data.base_rtt);
  if (!Number.isFinite(downloadMbps) || !Number.isFinite(uploadMbps)) {
    throw new Error("networkQuality 没有返回吞吐量");
  }
  const samples = Array.isArray(data.il_h2_req_resp)
    ? data.il_h2_req_resp.map(Number).filter(Number.isFinite)
    : [];
  let jitterMs = null;
  if (samples.length > 1) {
    let total = 0;
    for (let i = 1; i < samples.length; i += 1) total += Math.abs(samples[i] - samples[i - 1]);
    jitterMs = total / (samples.length - 1);
  }
  return {
    downloadMbps,
    uploadMbps,
    pingMs: Number.isFinite(pingMs) ? pingMs : null,
    jitterMs,
    loss: null,
    dlBytes: Number(data.dl_bytes_transferred) || 0,
    ulBytes: Number(data.ul_bytes_transferred) || 0,
    endpoint: data.test_endpoint ?? null,
    interfaceName: data.interface_name ?? null,
    downloadDuration: Number(data.dl_phase_duration) || null,
    uploadDuration: Number(data.ul_phase_duration) || null,
    raw: data,
  };
}

async function runNetworkQuality(interfaceName) {
  const base = ["-s", "-c"];
  const bounded = interfaceName && /^(en|wl|utun|ppp)\d+/.test(interfaceName);
  const args = bounded ? [...base, "-I", interfaceName] : base;
  try {
    return await runCapture(NETWORK_QUALITY, args, 75000);
  } catch (error) {
    // -I 在某些网卡/权限下不可用，退回系统自己选路；超时则不要重试。
    if (bounded && !error.killed) return runCapture(NETWORK_QUALITY, base, 75000);
    throw error;
  }
}

async function measureWithNetworkQuality(interfaceName, emit) {
  emitLine(emit, { type: "phase", phase: "ping" });
  const { stdout } = await runNetworkQuality(interfaceName);
  const result = parseNetworkQuality(stdout);
  emitLine(emit, { type: "latency", pingMs: result.pingMs, jitterMs: result.jitterMs, loss: result.loss });
  emitLine(emit, { type: "phase", phase: "download" });
  emitLine(emit, {
    type: "sample",
    phase: "download",
    mbps: result.downloadMbps,
    averageMbps: result.downloadMbps,
    bytes: result.dlBytes,
  });
  emitLine(emit, { type: "phase", phase: "upload" });
  emitLine(emit, {
    type: "sample",
    phase: "upload",
    mbps: result.uploadMbps,
    averageMbps: result.uploadMbps,
    bytes: result.ulBytes,
  });
  return result;
}

function tcpPing(host, port) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = connect({ host, port, family: 4 });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => finish(performance.now() - started));
    socket.once("timeout", () => finish(null));
    socket.once("error", () => finish(null));
  });
}

async function measurePing(emit) {
  const samples = [];
  for (let seq = 1; seq <= 5; seq += 1) {
    const ms = await tcpPing("speed.cloudflare.com", 443);
    if (ms != null) samples.push(ms);
    emitLine(emit, { type: "ping", seq, ms });
  }
  if (!samples.length) return { pingMs: null, jitterMs: null, loss: 1 };
  const pingMs = samples.reduce((sum, item) => sum + item, 0) / samples.length;
  let jitter = 0;
  for (let i = 1; i < samples.length; i += 1) jitter += Math.abs(samples[i] - samples[i - 1]);
  const jitterMs = samples.length > 1 ? jitter / (samples.length - 1) : 0;
  return { pingMs, jitterMs, loss: (5 - samples.length) / 5 };
}

async function measureDownload(emit) {
  const started = performance.now();
  const response = await fetch(`https://speed.cloudflare.com/__down?bytes=${DOWN_BYTES}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(PHASE_MS + 8000),
  });
  if (!response.ok || !response.body) throw new Error(`下载测速失败 ${response.status}`);
  const reader = response.body.getReader();
  let received = 0;
  let mark = started;
  let markBytes = 0;
  try {
    while (received < DOWN_BYTES && performance.now() - started < PHASE_MS) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      const now = performance.now();
      if (now - mark >= 160) {
        const instant = ((received - markBytes) * 8) / ((now - mark) / 1000) / 1e6;
        const average = (received * 8) / ((now - started) / 1000) / 1e6;
        emitLine(emit, { type: "sample", phase: "download", mbps: instant, averageMbps: average, bytes: received });
        mark = now;
        markBytes = received;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* 主动停掉剩余流量 */ }
  }
  const elapsed = Math.max(performance.now() - started, 1);
  return (received * 8) / (elapsed / 1000) / 1e6;
}

async function measureUpload(emit) {
  const started = performance.now();
  let sent = 0;
  let mark = started;
  let markBytes = 0;
  const chunkSize = 64 * 1024;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= UP_BYTES || performance.now() - started >= PHASE_MS) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, UP_BYTES - sent);
      controller.enqueue(new Uint8Array(size));
      sent += size;
      const now = performance.now();
      if (now - mark >= 160) {
        const instant = ((sent - markBytes) * 8) / ((now - mark) / 1000) / 1e6;
        const average = (sent * 8) / ((now - started) / 1000) / 1e6;
        emitLine(emit, { type: "sample", phase: "upload", mbps: instant, averageMbps: average, bytes: sent });
        mark = now;
        markBytes = sent;
      }
    },
  });
  const response = await fetch("https://speed.cloudflare.com/__up", {
    method: "POST",
    body: stream,
    duplex: "half",
    headers: { "content-type": "application/octet-stream" },
    signal: AbortSignal.timeout(PHASE_MS + 8000),
  });
  if (!response.ok) throw new Error(`上传测速失败 ${response.status}`);
  await response.arrayBuffer().catch(() => {});
  const elapsed = Math.max(performance.now() - started, 1);
  return (sent * 8) / (elapsed / 1000) / 1e6;
}

async function cloudflareFallback(emit) {
  emitLine(emit, { type: "phase", phase: "ping" });
  const latency = await measurePing(emit);
  emitLine(emit, { type: "latency", ...latency });
  emitLine(emit, { type: "phase", phase: "download" });
  const downloadMbps = await measureDownload(emit);
  emitLine(emit, { type: "phase", phase: "upload" });
  const uploadMbps = await measureUpload(emit);
  return { downloadMbps, uploadMbps, pingMs: latency.pingMs, jitterMs: latency.jitterMs, loss: latency.loss, method: "cloudflare" };
}

export async function runSpeedTest(emit) {
  try {
    const info = await networkInfo();
    emitLine(emit, { type: "info", ...info });

    let result;
    try {
      result = await measureWithNetworkQuality(info.interfaceName, emit);
      result.method = "networkQuality";
    } catch (error) {
      const reason = String(error?.message ?? error);
      if (error?.killed || /ETIMEDOUT|timed out/i.test(reason)) throw error;
      if (!/ENOENT|not found/i.test(reason)) {
        emitLine(emit, { type: "warning", message: `networkQuality 失败，回退 Cloudflare：${reason}` });
      }
      result = await cloudflareFallback(emit);
    }

    emitLine(emit, {
      type: "done",
      downloadMbps: result.downloadMbps,
      uploadMbps: result.uploadMbps,
      pingMs: result.pingMs,
      jitterMs: result.jitterMs,
      loss: result.loss,
      method: result.method,
      endpoint: result.endpoint ?? null,
      proxyDetected: info.proxyDetected,
    });
  } catch (error) {
    const raw = String(error?.message ?? error);
    const message = /aborted|timeout|timed out/i.test(raw) ? "测速超时，当前线路太慢或中途断了" : raw;
    emitLine(emit, { type: "error", message });
  }
}
