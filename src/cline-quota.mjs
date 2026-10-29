// ClinePass 额度：多密钥查官方三窗口和账户余额。
// 密钥只落在 ~/.ai-toolbox/clinepass-keys.json。
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataFile } from "./paths.mjs";

const API = "https://api.cline.bot/api/v1";
const CLIENT_VERSION = "3.5.54";
const WINDOWS = [
  { type: "five_hour", key: "rolling", label: "5小时滚动" },
  { type: "weekly", key: "weekly", label: "本周" },
  { type: "monthly", key: "monthly", label: "本月" },
];

export function keysPath() {
  return dataFile("clinepass-keys.json");
}

export function redact(text) {
  return String(text ?? "").replace(/sk_[A-Za-z0-9]{8,}/g, "sk_…");
}

export function isClineKey(value) {
  return /^sk_[A-Za-z0-9]{16,}$/.test(String(value ?? "").trim());
}

function emptyStore() {
  return { keys: [] };
}

function readStore() {
  const path = keysPath();
  if (!existsSync(path)) return emptyStore();
  try { chmodSync(path, 0o600); } catch { /* 仍只在本机读取 */ }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || !Array.isArray(parsed.keys)) return emptyStore();
  return parsed;
}

function writeStore(store) {
  const path = keysPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function tailOf(key) {
  const text = String(key ?? "");
  return text.length >= 4 ? text.slice(-4) : "";
}

function publicKey(item) {
  return { id: item.id, name: item.name, tail: tailOf(item.key), key: item.key };
}

export function listKeys() {
  return readStore().keys.map(publicKey);
}

function defaultName(key, used) {
  const base = `密钥 …${tailOf(key)}`;
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function parseKeyText(text) {
  const rows = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const found = line.match(/sk_[A-Za-z0-9]{16,}/);
    if (!found) throw new Error("有一行不是 sk_… 密钥");
    const key = found[0];
    const name = line.slice(0, found.index).trim().replace(/[:：,，\s]+$/g, "");
    rows.push({ name, key });
  }
  if (!rows.length) throw new Error("没有可导入的密钥");
  return rows;
}

export function addKeys(entries) {
  const store = readStore();
  const names = new Set(store.keys.map((item) => item.name));
  const seen = new Set(store.keys.map((item) => item.key));
  let added = 0;
  for (const entry of entries) {
    const key = String(entry.key ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (!isClineKey(key)) throw new Error("密钥格式不对，需要 sk_…");
    if (seen.has(key)) continue;
    const name = String(entry.name ?? "").trim() || defaultName(key, names);
    names.add(name);
    seen.add(key);
    store.keys.push({ id: randomUUID(), name, key });
    added += 1;
  }
  writeStore(store);
  return { keys: store.keys.map(publicKey), added };
}

export function removeKey(id) {
  const store = readStore();
  const next = store.keys.filter((item) => item.id !== id);
  if (next.length === store.keys.length) throw new Error("找不到这个密钥");
  store.keys = next;
  writeStore(store);
  return store.keys.map(publicKey);
}

function clientHeaders(key) {
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": "cline-desktop",
    "X-CLIENT-VERSION": CLIENT_VERSION,
    "User-Agent": `Cline/${CLIENT_VERSION}`,
  };
}

async function clineGet(key, path) {
  const response = await fetch(`${API}${path}`, {
    headers: clientHeaders(key),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("Cline 没有返回 JSON");
  }
  if (!response.ok || body?.success === false) {
    throw new Error(`Cline ${response.status} ${redact(body?.error || raw).slice(0, 180)}`);
  }
  return body?.data ?? body;
}

function money(micro) {
  const n = Number(micro);
  if (!Number.isFinite(n) || n < 0) return null;
  const dollars = n / 1e6;
  if (dollars === 0 || dollars >= 0.01) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(4)}`;
}

async function fetchOne(item) {
  const started = Date.now();
  const pub = publicKey(item);
  try {
    const limitsTask = clineGet(item.key, "/users/me/plan/usage-limits");
    const meTask = clineGet(item.key, "/users/me");
    let limits = [];
    let note = null;
    let me = null;
    const [limitsOutcome, meOutcome] = await Promise.allSettled([limitsTask, meTask]);
    if (limitsOutcome.status === "fulfilled") {
      const limitsBody = limitsOutcome.value;
      limits = Array.isArray(limitsBody?.limits) ? limitsBody.limits : [];
    } else {
      const message = redact(limitsOutcome.reason?.message ?? limitsOutcome.reason);
      if (!/\b404\b/.test(message)) throw limitsOutcome.reason;
      note = "没有 ClinePass 订阅窗口，只显示账户余额";
    }
    if (meOutcome.status === "fulfilled") me = meOutcome.value;
    const windows = {};
    for (const spec of WINDOWS) {
      const found = limits.find((entry) => entry?.type === spec.type);
      if (!found) continue;
      const percent = Number(found.percentUsed ?? 0);
      windows[spec.key] = {
        status: percent >= 100 ? "rate-limited" : "ok",
        percent,
        resetsAt: found.resetsAt ?? null,
      };
    }
    let balance = null;
    try {
      const userId = me?.clineUserId || me?.subject || me?.id;
      if (userId) {
        const bal = await clineGet(item.key, `/users/${encodeURIComponent(userId)}/balance`);
        balance = money(bal?.balance);
      }
    } catch {
      balance = null;
    }
    return {
      ...pub,
      ok: true,
      latencyMs: Date.now() - started,
      error: null,
      note,
      balance,
      windows,
    };
  } catch (error) {
    return {
      ...pub,
      ok: false,
      latencyMs: null,
      error: redact(error?.message ?? error),
      note: null,
      balance: null,
      windows: null,
    };
  }
}

export async function queryAll() {
  const keys = await Promise.all(readStore().keys.map((item) => fetchOne(item)));
  return { command: "cline-quota", fetchedAt: new Date().toISOString(), keys };
}
