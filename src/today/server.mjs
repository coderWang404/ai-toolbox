/**
 * Today AI 的 OpenAI 兼容网关。
 *
 * 端点：
 *   POST /v1/chat/completions
 *   GET  /v1/models
 *   GET  /v1/models/:id
 *   GET  /health
 *
 * 传输：CDP → Today.app 页面上下文 fetch（自动注入 Bearer）。
 * 环境变量见 README / CLI 帮助。
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import TodayClient from "./client.mjs";

export const DEFAULT_PORT = Number(process.env.PORT || 8317);

/** 友好别名 → Today optionId */
export const MODEL_ALIASES = {
  today: null,
  "today-auto": null,
  deepseek: "model.deepseek-v4.1-flash",
  "deepseek-v4.1-flash": "model.deepseek-v4.1-flash",
  "deepseek-flash": "model.deepseek-v4.1-flash",
  minimax: "model.minimax-m31-flash",
  "minimax-m3.1-flash": "model.minimax-m31-flash",
  "minimax-flash": "model.minimax-m31-flash",
  glm: "model.glm-5.3",
  "glm-5.3": "model.glm-5.3",
  "claude-opus-4.8": "mode.power",
  opus: "mode.power",
  power: "mode.power",
  balanced: "mode.balanced",
  fast: "mode.fast",
};

export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk + other / 4);
}

/** OpenAI messages[] → 一段纯文本（Today 后端是单轮接口 + 主聊天记忆）。 */
export function serializeMessages(messages) {
  const lines = [];
  for (const message of messages) {
    const content =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((part) => (typeof part === "string" ? part : part.text || ""))
              .join("\n")
          : "";
    if (!content.trim()) continue;
    if (message.role === "system") lines.push(`【系统指令】\n${content.trim()}`);
    else if (message.role === "user") lines.push(`用户：${content.trim()}`);
    else if (message.role === "assistant") lines.push(`助手：${content.trim()}`);
    else lines.push(`${message.role}：${content.trim()}`);
  }
  return lines.join("\n\n");
}

export function resolveModel(requested) {
  if (!requested) return null;
  const key = String(requested).toLowerCase();
  if (key in MODEL_ALIASES) return MODEL_ALIASES[key];
  if (key.startsWith("model.") || key.startsWith("mode.")) return key;
  return requested;
}

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

function streamCompletion(res, { model, content, origin }) {
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
  const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;
  const created = Math.floor(Date.now() / 1000);
  const sendChunk = (delta, finish = null) => {
    res.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
  };
  sendChunk({ role: "assistant" });
  const pieces = content.match(/[^。！？!?.\n]+[。！？!?.\n]*/g) || [content];
  for (const piece of pieces) sendChunk({ content: piece });
  sendChunk({}, "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * 创建 HTTP 服务。client 必须实现 getModelCatalog()/chat()/api()。
 * 把 client 注入进来是为了能在测试里不依赖真实 Today.app。
 */
export function createTodayServer({
  client,
  port = DEFAULT_PORT,
  apiKey = "",
  sendHistory = true,
  host = "127.0.0.1",
} = {}) {
  if (!client) throw new Error("createTodayServer 需要 client");
  const server = http.createServer(async (req, res) => {
    const origin = allowedOrigin(req);
    try {
      if (req.method === "OPTIONS") {
        const headers = {
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          Vary: "Origin",
        };
        if (origin) headers["Access-Control-Allow-Origin"] = origin;
        res.writeHead(204, headers);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${host}:${port}`);
      if (url.pathname === "/health") {
        let ok = false;
        let detail = "";
        try {
          await client.api("GET", "/v1/users/me");
          ok = true;
        } catch (error) {
          detail = String(error.message || error);
        }
        return sendJson(res, ok ? 200 : 503, {
          status: ok ? "ok" : "degraded",
          gateway: "today",
          upstream: "api.todayai.cn",
          transport: "cdp-page-fetch",
          cdpConnected: !!client.ws,
          page: client.pageUrl,
          detail: detail || undefined,
        }, origin);
      }

      if (apiKey) {
        const auth = req.headers.authorization || "";
        if (auth !== `Bearer ${apiKey}`) {
          return sendJson(res, 401, { error: { message: "Invalid API key", type: "auth_error" } }, origin);
        }
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        const catalog = await client.getModelCatalog();
        const models = catalog.options.map((option) => ({
          id: option.id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "today",
          display_name: option.display?.title,
          subtitle: option.display?.subtitle,
          availability: option.display?.availabilityLabel || undefined,
          disabled: option.disabled || false,
        }));
        for (const alias of ["deepseek", "minimax", "glm", "today-auto"]) {
          if (!models.some((model) => model.id === alias)) {
            models.push({
              id: alias,
              object: "model",
              created: 0,
              owned_by: "today",
              alias_of: MODEL_ALIASES[alias] || "current",
            });
          }
        }
        return sendJson(res, 200, { object: "list", data: models }, origin);
      }

      const modelMatch = url.pathname.match(/^\/v1\/models\/([\w.-]+)$/);
      if (modelMatch && req.method === "GET") {
        const requested = decodeURIComponent(modelMatch[1]);
        const resolved = resolveModel(requested);
        const catalog = await client.getModelCatalog();
        const option = catalog.options.find((item) => item.id === (resolved || requested));
        if (!option) {
          if (requested in MODEL_ALIASES) {
            return sendJson(res, 200, {
              id: requested,
              object: "model",
              created: 0,
              owned_by: "today",
              alias_of: MODEL_ALIASES[requested] || "current",
            }, origin);
          }
          return sendJson(res, 404, { error: { message: "模型不存在", type: "invalid_request_error" } }, origin);
        }
        return sendJson(res, 200, {
          id: option.id,
          object: "model",
          created: 0,
          owned_by: "today",
          display_name: option.display?.title,
          subtitle: option.display?.subtitle,
        }, origin);
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const body = await readBody(req);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (!messages.length) {
          return sendJson(res, 400, { error: { message: "messages 不能为空", type: "invalid_request_error" } }, origin);
        }
        const model = resolveModel(body.model);
        const prompt = sendHistory
          ? serializeMessages(messages)
          : serializeMessages(messages.slice(-1));
        if (!prompt.trim()) {
          return sendJson(res, 400, { error: { message: "messages 没有可发送的文本", type: "invalid_request_error" } }, origin);
        }

        let result;
        try {
          result = await client.chat(prompt, {
            model,
            timeoutMs: Number(process.env.TODAY_CHAT_TIMEOUT_MS || 180000),
          });
        } catch (error) {
          const message = String(error.message || error);
          const status = /模型 .* 不在可用列表/.test(message) ? 400 : /超时/.test(message) ? 504 : 502;
          return sendJson(res, status, { error: { message, type: "upstream_error" } }, origin);
        }

        const promptTokens = estimateTokens(prompt);
        const completionTokens = estimateTokens(result.content);
        if (body.stream) {
          return streamCompletion(res, {
            model: result.model || body.model || "today",
            content: result.content,
            origin,
          });
        }
        return sendJson(res, 200, {
          id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: result.model || body.model || "today",
          choices: [{
            index: 0,
            message: { role: "assistant", content: result.content },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
          x_today: {
            threadId: result.threadId,
            messageId: result.messageId,
            modelOptionId: result.model,
            token_usage_estimated: true,
          },
        }, origin);
      }

      sendJson(res, 404, { error: { message: "Not found", type: "invalid_request_error" } }, origin);
    } catch (error) {
      sendJson(res, 500, { error: { message: String(error.message || error), type: "internal_error" } }, origin);
    }
  });
  return server;
}

export async function startTodayServer({
  client = new TodayClient(),
  port = DEFAULT_PORT,
  apiKey = process.env.TODAY_API_KEY || "",
  sendHistory = (process.env.TODAY_SEND_HISTORY || "1") !== "0",
  log = console.log,
} = {}) {
  let catalog = null;
  try {
    await client.connect();
    catalog = await client.getModelCatalog();
    log(`[today-api] CDP 已连接（${client.pageUrl}）`);
    log(`[today-api] 当前模型: ${catalog.selectedOptionId}`);
    log(`[today-api] 可用模型: ${catalog.options.map((item) => `${item.id}(${item.display?.title})`).join(", ")}`);
  } catch (error) {
    log(`[today-api] 警告: ${error.message}`);
    log("[today-api] 服务仍会启动；请在 Today.app 带 --remote-debugging-port=9222 运行后重试");
  }
  const server = createTodayServer({ client, port, apiKey, sendHistory });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  log(`[today-api] OpenAI 兼容服务已启动: http://127.0.0.1:${port}/v1`);
  log(`[today-api] 健康检查: curl http://127.0.0.1:${port}/health`);
  return { server, client, port, catalog };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  startTodayServer({ port }).catch((error) => {
    console.error(`[today-api] 启动失败: ${error.message}`);
    process.exitCode = 1;
  });
}
