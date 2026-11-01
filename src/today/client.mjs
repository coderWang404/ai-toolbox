/**
 * Today AI（api.todayai.cn）API 客户端。
 *
 * 传输方式：通过 CDP 在 Today.app 的页面上下文里执行 fetch。
 * Today 的 Electron 主进程用 webRequest.onBeforeSendHeaders 给 api.todayai.cn
 * 注入短期 JWT，页面同源 fetch 会自动带上；wrapper 不需要自己管理登录态。
 *
 * 前置条件：Today.app 正在运行，且启动参数带 --remote-debugging-port=9222。
 */
import { randomUUID } from "node:crypto";

const DEFAULT_CDP = process.env.TODAY_CDP_HTTP || "http://127.0.0.1:9222";
const DEFAULT_POLL_MS = Number(process.env.TODAY_POLL_INTERVAL_MS || 2000);
const DEFAULT_TIMEOUT_MS = Number(process.env.TODAY_CHAT_TIMEOUT_MS || 180000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 生成 Today 后端接受的 clientMessageId（ULID 风格，前缀 00001）。 */
export function makeClientMessageId(now = Date.now()) {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ALPHABET[Math.floor(Math.random() * 32)];
  return `00001${time}${rand}`;
}

/** 从消息 parts 中提取纯文本，兼容 content.text 与 text 两种形状。 */
export function extractText(message) {
  const parts = message?.body?.parts || [];
  const texts = [];
  for (const part of parts) {
    if (typeof part?.text === "string") texts.push(part.text);
    else if (typeof part?.content?.text === "string") texts.push(part.content.text);
  }
  return texts.join("\n").trim();
}

export class TodayClient {
  constructor({
    cdpHttp = DEFAULT_CDP,
    pollIntervalMs = DEFAULT_POLL_MS,
    chatTimeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
  } = {}) {
    this.cdpHttp = cdpHttp;
    this.pollIntervalMs = pollIntervalMs;
    this.chatTimeoutMs = chatTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.pageUrl = null;
    this.msgId = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
  }

  /** 找到 Today.app 里 today-desktop.localhost 的页面 target 并连接 CDP。 */
  async connect() {
    const response = await this.fetchImpl(`${this.cdpHttp}/json/list`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`CDP /json/list 返回 ${response.status}`);
    const targets = await response.json();
    const page = targets.find(
      (target) => target.type === "page" && /today-desktop\.localhost/.test(target.url || ""),
    );
    if (!page) {
      throw new Error(
        "未找到 Today.app 的页面。请确认：1) Today.app 正在运行；2) 启动参数带 --remote-debugging-port=9222",
      );
    }
    await this._openWs(page.webSocketDebuggerUrl);
    this.pageUrl = page.url;
    return page.url;
  }

  async _openWs(url) {
    if (!this.WebSocketImpl) throw new Error("当前 Node 没有 WebSocket 支持（需要 Node 22+）");
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* 忽略 */
      }
      this.ws = null;
    }
    this._rejectAllPending(new Error("重新连接"));
    const ws = new this.WebSocketImpl(url);
    this.msgId = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP 连接超时")), 8000);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onclose = () => {
        this._rejectAllPending(new Error("CDP WebSocket 已关闭"));
      };
      ws.onerror = () => {
        const error = new Error("CDP WebSocket 错误");
        this._rejectAllPending(error);
        if (!opened) {
          clearTimeout(timer);
          reject(error);
        }
      };
    });
    this.ws = ws;
    await this._send("Runtime.enable", {}, 8000);
  }

  _send(method, params = {}, timeoutMs = 15000) {
    if (!this.ws) return Promise.reject(new Error("CDP 尚未连接"));
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`CDP 发送失败: ${error.message}`));
      }
    });
  }

  _rejectAllPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* 忽略 */
      }
      this.ws = null;
    }
    this._rejectAllPending(new Error("客户端已关闭"));
  }

  /** 在页面上下文执行表达式（支持 awaitPromise，带超时）。 */
  async _eval(expression, timeoutMs = 30000) {
    const result = await this._send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new Error(
        `页面执行异常: ${JSON.stringify(
          result.exceptionDetails.exception?.description || result.exceptionDetails.text,
        )}`,
      );
    }
    return result.result?.value;
  }

  /**
   * 调用 Today API。页面同源 fetch，主进程自动注入 Bearer。
   * 断线时自动重连一次。
   */
  async api(method, path, body = undefined, { retry = true } = {}) {
    const bodyLiteral = body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body));
    const expression = `(async () => {
      const response = await fetch('https://api.todayai.cn${path}', {
        method: '${method}',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: ${bodyLiteral}
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return JSON.stringify({ status: response.status, json, text: json ? null : text.slice(0, 500) });
    })()`;
    try {
      const raw = await this._eval(expression);
      return JSON.parse(raw);
    } catch (error) {
      if (retry && /WebSocket|CLOSED|closed|连接/i.test(String(error))) {
        await this.connect();
        return this.api(method, path, body, { retry: false });
      }
      throw error;
    }
  }

  /** 模型目录：GET /v1/pricing/status → data.status.modelOptions。 */
  async getModelCatalog() {
    const response = await this.api("GET", "/v1/pricing/status");
    if (response.status !== 200) {
      throw new Error(`pricing/status ${response.status}: ${JSON.stringify(response.json)}`);
    }
    const options = response.json?.data?.status?.modelOptions;
    if (!options) throw new Error("响应中没有 modelOptions（账号可能未开放模型选择）");
    return options;
  }

  /** 切换全局模型选项（PUT /v1/pricing/model-option）。 */
  async setModel(optionId) {
    const response = await this.api("PUT", "/v1/pricing/model-option", { optionId });
    if (response.status !== 200) {
      throw new Error(`切换模型失败 ${response.status}: ${JSON.stringify(response.json || response.text)}`);
    }
    return response.json?.data?.modelOptions;
  }

  /** 发送一条消息并等待助手最终回复。 */
  async chat(text, { model, timeoutMs = this.chatTimeoutMs } = {}) {
    const run = this.queue.then(() => this._chatOnce(text, { model, timeoutMs }));
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async _chatOnce(text, { model, timeoutMs }) {
    let usedModel = model || null;
    if (model) {
      const catalog = await this.getModelCatalog();
      const ids = catalog.options.map((option) => option.id);
      if (!ids.includes(model)) {
        throw new Error(`模型 ${model} 不在可用列表：${ids.join(", ")}`);
      }
      if (catalog.selectedOptionId !== model) await this.setModel(model);
    } else {
      const catalog = await this.getModelCatalog().catch(() => null);
      usedModel = catalog?.selectedOptionId || null;
    }

    const clientMessageId = makeClientMessageId();
    const post = await this.api("POST", "/v1/messages", {
      body: { parts: [{ id: randomUUID(), type: "text", text }] },
      clientMessageId,
      isMainChat: true,
    });
    if (post.status !== 202) {
      throw new Error(`发送失败 ${post.status}: ${JSON.stringify(post.json || post.text)}`);
    }
    const { threadId, messageId } = post.json;
    const cursor = post.json?.canonicalMessage?.cursor;

    const deadline = Date.now() + timeoutMs;
    let lastItems = 0;
    while (Date.now() < deadline) {
      await sleep(this.pollIntervalMs);
      const query = `/v1/conversations/messages?isMainChat=true&limit=50${
        cursor ? `&after=${encodeURIComponent(cursor)}` : ""
      }`;
      const response = await this.api("GET", query);
      if (response.status !== 200) continue;
      const items = response.json?.data?.items || [];
      lastItems = items.length;
      const hit = items.find(
        (item) =>
          item.role === "assistant" &&
          item.isFinal &&
          item.originClientMessageId === clientMessageId,
      );
      if (hit) {
        return {
          content: extractText(hit),
          threadId,
          messageId,
          model: usedModel,
          raw: hit,
        };
      }
    }
    throw new Error(`等待回复超时（${timeoutMs}ms，轮询到 ${lastItems} 条消息）`);
  }
}

export default TodayClient;
