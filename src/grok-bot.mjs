// Grok Bot 本机网关：用 Keychain 里的登录调用官方助手，并提供 OpenAI 兼容接口。
import { createDecipheriv, pbkdf2Sync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export const GROK_PORT = Number(process.env.GROKBOT_PORT || 8765);
const SECRETS_PATH = join(homedir(), "Library/Application Support/Grok Bot/sand-secrets.json");
const MODELS = [
  { id: "grok-bot-default", description: "Grok Bot 官方标准对话模型" },
  { id: "grok-bot-automation", description: "Grok Bot 官方任务自动化模型" },
];

let cachedAuth = null;
let cachedAgentId = null;

function secretsPath() {
  return SECRETS_PATH;
}

function keychainPassword() {
  try {
    return execFileSync("security", ["find-generic-password", "-s", "Grok Bot Safe Storage", "-w"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error("无法从钥匙串读取 Grok Bot Safe Storage");
  }
}

function decryptSafeStorage(encBase64, password) {
  const encBuf = Buffer.from(encBase64, "base64");
  const ciphertext = encBuf.subarray(3);
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, " ");
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function loadAuth() {
  if (!existsSync(secretsPath())) throw new Error("没有找到 Grok Bot 的本机登录");
  const secrets = JSON.parse(readFileSync(secretsPath(), "utf8"));
  const password = keychainPassword();
  const machineId = decryptSafeStorage(secrets["cursor-machine-id"], password);
  const accounts = JSON.parse(secrets["cursor-accounts"]);
  const active = accounts.accounts?.[accounts.active];
  if (!active) throw new Error("Grok Bot 没有当前账号");
  const accessToken = decryptSafeStorage(active["cursor-access-token"], password);
  const refreshToken = decryptSafeStorage(active["cursor-refresh-token"], password);
  let email = null;
  try {
    const profile = JSON.parse(decryptSafeStorage(active["cursor-account-profile"], password));
    email = typeof profile.email === "string" ? profile.email : null;
  } catch {
    email = null;
  }
  return { machineId, accessToken, refreshToken, email };
}

function computeChecksum(machineId) {
  const t = Math.floor(Date.now() / 1e6);
  const n = new Uint8Array([
    (t >> 40) & 255,
    (t >> 32) & 255,
    (t >> 24) & 255,
    (t >> 16) & 255,
    (t >> 8) & 255,
    t & 255,
  ]);
  let b = 165;
  for (let i = 0; i < n.length; i++) {
    n[i] = ((n[i] ^ b) + (i % 256)) & 255;
    b = n[i];
  }
  return `${Buffer.from(n).toString("base64url")}${machineId}`;
}

function getAuth() {
  if (!cachedAuth) cachedAuth = loadAuth();
  return cachedAuth;
}

function scrub(text, auth) {
  let out = String(text ?? "");
  for (const secret of [auth?.accessToken, auth?.refreshToken, auth?.machineId]) {
    if (secret && secret.length > 8) out = out.split(secret).join("…");
  }
  return out.slice(0, 240);
}

async function callRpc(service, method, body = {}) {
  const auth = getAuth();
  const response = await fetch(`https://api2.cursor.sh/aiserver.v1.${service}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${auth.accessToken}`,
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Sand/0.70.2 Safari/537.36",
      "x-cursor-client-type": "desktop",
      "x-cursor-client-version": "0.70.2",
      "x-cursor-client-os": "darwin",
      "x-cursor-client-source": "sand-desktop",
      "x-cursor-checksum": computeChecksum(auth.machineId),
      "x-ghost-mode": "false",
      "x-request-id": randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Grok Bot ${response.status} ${scrub(text, auth)}`);
  return JSON.parse(text);
}

export async function listAgents() {
  const res = await callRpc("GrokBotService", "ListGrokBotAgents");
  return (res.agents || []).map((agent) => ({
    id: String(agent.id ?? ""),
    legacyAgentId: agent.legacyAgentId ? String(agent.legacyAgentId) : null,
    name: String(agent.name ?? "未命名"),
    description: agent.description ? String(agent.description) : null,
    kind: agent.kind ? String(agent.kind) : null,
  }));
}

async function defaultAgentId() {
  if (cachedAgentId) return cachedAgentId;
  try {
    const agents = await listAgents();
    const target = agents.find((agent) => agent.name.includes("日常问答")) || agents[0];
    if (target) {
      cachedAgentId = target.legacyAgentId || target.id;
      return cachedAgentId;
    }
  } catch {
    /* 用脚本里的默认助手 */
  }
  cachedAgentId = "02e2c3f5-5acb-418f-8cd2-70b26614a3a7";
  return cachedAgentId;
}

export async function executeTurn(agentId, prompt, onDelta = null) {
  const initRes = await callRpc("GrokBotService", "ListGrokBotTranscriptEntries", {
    agent_id: agentId,
    limit: 1,
  });
  const startSeq = initRes.entries && initRes.entries.length > 0 ? BigInt(initRes.entries[0].seq) : 0n;
  const clientNonce = randomUUID();
  await callRpc("GrokBotService", "SendGrokBotUserMessage", {
    agent_id: agentId,
    message_id: clientNonce,
    text: prompt,
    sent_at_ms: Date.now().toString(),
    is_fork: false,
    source: 1,
  });

  let fullReply = "";
  const seenSeqs = new Set();
  const startTime = Date.now();
  while (Date.now() - startTime < 120000) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const transcript = await callRpc("GrokBotService", "ListGrokBotTranscriptEntries", {
      agent_id: agentId,
      limit: 6,
    });
    if (!transcript.entries) continue;
    for (const entry of transcript.entries.slice().reverse()) {
      const seq = BigInt(entry.seq);
      if (seq <= startSeq || seenSeqs.has(entry.seq)) continue;
      if (entry.entryKind !== "send-message" || !entry.body) continue;
      seenSeqs.add(entry.seq);
      const bodyObj = JSON.parse(Buffer.from(entry.body, "base64").toString("utf8"));
      const content = bodyObj.message?.content;
      if (!content) continue;
      fullReply = content;
      if (onDelta) onDelta(content);
      if (content.length > 30 || (!content.includes("查一下") && !content.includes("马上"))) return fullReply;
    }
  }
  return fullReply || "请求超时";
}

function promptFrom(messages) {
  if (!Array.isArray(messages) || !messages.length) return "";
  if (messages.length === 1) return String(messages[0].content ?? "");
  return `${messages.map((message) => `${String(message.role ?? "user").toUpperCase()}: ${message.content ?? ""}`).join("\n\n")}\n\nASSISTANT:`;
}

export async function completeChat({ model, messages, text }) {
  const modelUsed = model === "grok-bot-automation" ? "grok-bot-automation" : "grok-bot-default";
  const prompt = text != null ? String(text) : promptFrom(messages);
  if (!prompt.trim()) throw new Error("没有要发送的内容");
  const started = Date.now();
  const agentId = await defaultAgentId();
  const reply = await executeTurn(agentId, prompt);
  return { model: modelUsed, reply, agentId, elapsedMs: Date.now() - started };
}

export function gatewayBaseUrl(port = GROK_PORT) {
  return `http://127.0.0.1:${port}/v1`;
}

export async function gatewayRunning(port = GROK_PORT) {
  try {
    const response = await fetch(`${gatewayBaseUrl(port)}/models`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function status() {
  const running = await gatewayRunning();
  const gateway = { running, port: GROK_PORT, baseUrl: gatewayBaseUrl() };
  try {
    cachedAuth = null;
    const auth = loadAuth();
    cachedAuth = auth;
    let agents = [];
    let agentsError = null;
    try {
      agents = await listAgents();
    } catch (error) {
      agentsError = scrub(error?.message ?? error, auth);
    }
    return {
      command: "grok-status",
      email: auth.email,
      token: auth.accessToken,
      refreshToken: auth.refreshToken,
      machineId: auth.machineId,
      agents,
      agentsError,
      models: MODELS,
      gateway,
    };
  } catch (error) {
    return {
      command: "grok-status",
      email: null,
      token: null,
      refreshToken: null,
      machineId: null,
      agents: [],
      agentsError: null,
      models: MODELS,
      gateway,
      error: String(error?.message ?? error),
    };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startServer(port = GROK_PORT) {
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && path.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: MODELS.map((model) => ({
          id: model.id,
          object: "model",
          created: 1729000000,
          owned_by: "xai",
          permission: [],
          description: model.description,
        })),
      }));
      return;
    }
    if (req.method === "POST" && path.endsWith("/chat/completions")) {
      try {
        const body = JSON.parse(await readBody(req));
        const modelUsed = body.model === "grok-bot-automation" ? "grok-bot-automation" : "grok-bot-default";
        const stream = body.stream === true;
        const prompt = promptFrom(body.messages);
        const agentId = await defaultAgentId();
        const reqId = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          await executeTurn(agentId, prompt, (delta) => {
            const chunk = {
              id: reqId,
              object: "chat.completion.chunk",
              created,
              model: modelUsed,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          });
          res.write(`data: ${JSON.stringify({
            id: reqId,
            object: "chat.completion.chunk",
            created,
            model: modelUsed,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        const reply = await executeTurn(agentId, prompt);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: reqId,
          object: "chat.completion",
          created,
          model: modelUsed,
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: prompt.length,
            completion_tokens: reply.length,
            total_tokens: prompt.length + reply.length,
          },
        }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: scrub(error?.message ?? error, cachedAuth), type: "server_error" } }));
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not Found" } }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
