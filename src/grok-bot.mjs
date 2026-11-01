// Grok Bot 本机网关：用 Keychain 里的登录调用官方助手，并提供 OpenAI 兼容接口。
import { createDecipheriv, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir, dataFile } from "./paths.mjs";

export const GROK_PORT = Number(process.env.GROKBOT_PORT || 8765);
const SECRETS_PATH = join(homedir(), "Library/Application Support/Grok Bot/sand-secrets.json");
const GATEWAY_TOKEN_FILE = "grok-gateway-token";
const MODELS = [
  { id: "grok-bot-default", description: "Grok Bot 官方标准对话模型" },
  { id: "grok-bot-automation", description: "Grok Bot 官方任务自动化模型" },
];

let cachedAuth = null;
let cachedAgentId = null;
let cachedGatewayToken = null;

function secretsPath() {
  return SECRETS_PATH;
}

/**
 * 本机网关的 Bearer token。默认自动生成并保存到 ~/.ai-toolbox/grok-gateway-token，
 * 让任何网页都无法直接调用 127.0.0.1 上的网关。可用 GROKBOT_TOKEN 覆盖，
 * 或 GROKBOT_ALLOW_ANONYMOUS=1 显式关闭鉴权。
 */
export function gatewayToken() {
  const fromEnv = process.env.GROKBOT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (cachedGatewayToken) return cachedGatewayToken;
  const file = dataFile(GATEWAY_TOKEN_FILE);
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, "utf8").trim();
      if (saved) {
        cachedGatewayToken = saved;
        return saved;
      }
    }
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    const token = `grok_${randomBytes(24).toString("hex")}`;
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* 忽略 */
    }
    cachedGatewayToken = token;
    return token;
  } catch {
    // 数据目录不可写时退回进程内随机 token（重启后失效，但不会裸奔）。
    cachedGatewayToken = `grok_${randomBytes(24).toString("hex")}`;
    return cachedGatewayToken;
  }
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

/**
 * 发一条消息并轮询转写，直到内容连续两次不再增长才认为完成。
 * onDelta 只收到新增的文本（不是累计全文）。
 */
export async function executeTurn(
  agentId,
  prompt,
  onDelta = null,
  { rpc = callRpc, pollMs = 1200, timeoutMs = 120000 } = {},
) {
  const initRes = await rpc("GrokBotService", "ListGrokBotTranscriptEntries", {
    agent_id: agentId,
    limit: 1,
  });
  const startSeq = initRes.entries && initRes.entries.length > 0 ? BigInt(initRes.entries[0].seq) : 0n;
  const clientNonce = randomUUID();
  await rpc("GrokBotService", "SendGrokBotUserMessage", {
    agent_id: agentId,
    message_id: clientNonce,
    text: prompt,
    sent_at_ms: Date.now().toString(),
    is_fork: false,
    source: 1,
  });

  let fullReply = "";
  let sent = "";
  let lastPolled = "";
  let stablePolls = 0;
  const seenSeqs = new Set();
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const transcript = await rpc("GrokBotService", "ListGrokBotTranscriptEntries", {
      agent_id: agentId,
      limit: 10,
    });
    if (transcript.entries) {
      for (const entry of transcript.entries.slice().reverse()) {
        const seq = BigInt(entry.seq);
        if (seq <= startSeq || seenSeqs.has(entry.seq)) continue;
        if (entry.entryKind !== "send-message" || !entry.body) continue;
        seenSeqs.add(entry.seq);
        let bodyObj;
        try {
          bodyObj = JSON.parse(Buffer.from(entry.body, "base64").toString("utf8"));
        } catch {
          continue;
        }
        const content = bodyObj.message?.content;
        if (typeof content !== "string" || !content) continue;
        fullReply = content;
        if (onDelta) {
          if (content.startsWith(sent)) {
            const delta = content.slice(sent.length);
            if (delta) onDelta(delta);
          } else if (content !== sent) {
            // 某些情况下服务端会替换整段内容，退回发送全文。
            onDelta(content);
          }
          sent = content;
        }
      }
    }
    if (fullReply) {
      if (fullReply === lastPolled) stablePolls += 1;
      else stablePolls = 0;
      lastPolled = fullReply;
      // 连续两轮（约 2.4s）不再增长，认为助手已经说完。
      if (stablePolls >= 2) return fullReply;
    }
  }
  if (fullReply) return fullReply;
  throw new Error("Grok Bot 回复超时");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function promptFrom(messages) {
  if (!Array.isArray(messages) || !messages.length) return "";
  if (messages.length === 1) return contentText(messages[0].content);
  return `${messages
    .map((message) => `${String(message.role ?? "user").toUpperCase()}: ${contentText(message.content)}`)
    .join("\n\n")}\n\nASSISTANT:`;
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

export async function gatewayRunning(port = GROK_PORT, token = gatewayToken()) {
  try {
    const response = await fetch(`${gatewayBaseUrl(port)}/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function status({ includeSecrets = false, port = GROK_PORT } = {}) {
  const token = gatewayToken();
  const running = await gatewayRunning(port, token);
  const gateway = {
    running,
    port,
    baseUrl: gatewayBaseUrl(port),
    ...(includeSecrets ? { token } : {}),
  };
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
      ...(includeSecrets
        ? {
            token: auth.accessToken,
            refreshToken: auth.refreshToken,
            machineId: auth.machineId,
          }
        : {}),
      agents,
      agentsError,
      models: MODELS,
      gateway,
    };
  } catch (error) {
    return {
      command: "grok-status",
      email: null,
      ...(includeSecrets ? { token: null, refreshToken: null, machineId: null } : {}),
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
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 只允许本机页面跨域，避免任意 https 页面把 127.0.0.1 当跳板。 */
function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
        (url.protocol === "http:" || url.protocol === "https:")) {
      return origin;
    }
  } catch {
    /* 非法 Origin */
  }
  return null;
}

function sendJson(res, status, payload, origin) {
  const headers = { "Content-Type": "application/json" };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

export function startServer(port = GROK_PORT) {
  const token = gatewayToken();
  const anonymous = process.env.GROKBOT_ALLOW_ANONYMOUS === "1";
  const server = createServer(async (req, res) => {
    const origin = allowedOrigin(req);
    if (req.method === "OPTIONS") {
      const headers = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        Vary: "Origin",
      };
      if (origin) headers["Access-Control-Allow-Origin"] = origin;
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { status: "ok", gateway: "grok-bot", port }, origin);
      return;
    }
    if (!anonymous) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${token}`) {
        sendJson(res, 401, { error: { message: "Invalid API key", type: "auth_error" } }, origin);
        return;
      }
    }
    if (req.method === "GET" && path.endsWith("/models")) {
      sendJson(res, 200, {
        object: "list",
        data: MODELS.map((model) => ({
          id: model.id,
          object: "model",
          created: 1729000000,
          owned_by: "xai",
          permission: [],
          description: model.description,
        })),
      }, origin);
      return;
    }
    if (req.method === "POST" && path.endsWith("/chat/completions")) {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        sendJson(res, 400, { error: { message: String(error.message || error), type: "invalid_request_error" } }, origin);
        return;
      }
      try {
        const modelUsed = body.model === "grok-bot-automation" ? "grok-bot-automation" : "grok-bot-default";
        const stream = body.stream === true;
        const prompt = promptFrom(body.messages);
        const agentId = await defaultAgentId();
        const reqId = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        if (stream) {
          const headers = {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          };
          if (origin) {
            headers["Access-Control-Allow-Origin"] = origin;
            headers.Vary = "Origin";
          }
          res.writeHead(200, headers);
          const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
          const finish = () => {
            send({
              id: reqId,
              object: "chat.completion.chunk",
              created,
              model: modelUsed,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            });
            res.write("data: [DONE]\n\n");
            res.end();
          };
          try {
            await executeTurn(agentId, prompt, (delta) => {
              send({
                id: reqId,
                object: "chat.completion.chunk",
                created,
                model: modelUsed,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
              });
            });
            finish();
          } catch (error) {
            send({ error: { message: scrub(error?.message ?? error, cachedAuth), type: "server_error" } });
            res.write("data: [DONE]\n\n");
            res.end();
          }
          return;
        }
        const reply = await executeTurn(agentId, prompt);
        sendJson(res, 200, {
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
        }, origin);
      } catch (error) {
        sendJson(res, 500, { error: { message: scrub(error?.message ?? error, cachedAuth), type: "server_error" } }, origin);
      }
      return;
    }
    sendJson(res, 404, { error: { message: "Not Found" } }, origin);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.gatewayToken = token;
      resolve(server);
    });
  });
}
