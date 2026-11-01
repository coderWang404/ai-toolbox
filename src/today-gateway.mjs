// Today AI 独立模块：CDP 登录态、模型目录、对话测试与 OpenAI 兼容网关。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dataDir, dataFile } from "./paths.mjs";
import TodayClient from "./today/client.mjs";
import { createTodayServer, startTodayServer } from "./today/server.mjs";

const TOKEN_FILE = "today-gateway-token";

export function todayPort() {
  const value = Number(process.env.TODAY_GATEWAY_PORT || 8317);
  return Number.isInteger(value) && value >= 1024 && value < 65536 ? value : 8317;
}

/** 本地网关的 Bearer token；TODAY_API_KEY 可覆盖，否则自动生成并保存 0600。 */
export function todayGatewayToken() {
  const fromEnv = process.env.TODAY_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = dataFile(TOKEN_FILE);
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, "utf8").trim();
      if (saved) return saved;
    }
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    const token = `today_${randomBytes(24).toString("hex")}`;
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* 忽略 */
    }
    return token;
  } catch {
    return `today_${randomBytes(24).toString("hex")}`;
  }
}

export function todayBaseUrl(port = todayPort()) {
  return `http://127.0.0.1:${port}/v1`;
}

export async function cdpInfo(cdpHttp = process.env.TODAY_CDP_HTTP || "http://127.0.0.1:9222") {
  try {
    const response = await fetch(`${cdpHttp}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { reachable: false, error: `CDP ${response.status}` };
    const data = await response.json();
    return { reachable: true, browser: data.Browser ?? null, debuggerUrl: data.webSocketDebuggerUrl ?? null };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

export async function todayGatewayHealth(port = todayPort()) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = await response.json().catch(() => null);
    // 503 表示网关进程在跑，只是 Today 侧未登录/不可用，仍然算“已启动”。
    return {
      running: response.status === 200 || response.status === 503,
      port,
      status: body?.status ?? null,
      detail: body?.detail ?? null,
    };
  } catch {
    return { running: false, port, status: null, detail: null };
  }
}

function publicModel(option) {
  return {
    id: option.id,
    title: option.display?.title ?? option.id,
    subtitle: option.display?.subtitle ?? null,
    availability: option.display?.availabilityLabel ?? null,
    disabled: !!option.disabled,
  };
}

/**
 * 状态汇总：Today.app/CDP、当前模型、模型目录、本地网关。
 * 失败不抛错，返回 error 让 App 显示“降级”状态。
 */
export async function todayStatus({ port = todayPort(), includeSecrets = false } = {}) {
  const token = todayGatewayToken();
  const health = await todayGatewayHealth(port);
  const gateway = {
    running: health.running,
    port,
    baseUrl: todayBaseUrl(port),
    ...(health.status ? { status: health.status } : {}),
    ...(includeSecrets ? { apiKey: token } : {}),
  };
  const cdp = await cdpInfo();
  if (!cdp.reachable) {
    return {
      command: "today-status",
      cdp,
      pageUrl: null,
      currentModel: null,
      models: [],
      gateway,
      error: `Today.app 没有带调试端口运行，或没有启动（${cdp.error ?? "CDP 不可达"}）`,
    };
  }
  const client = new TodayClient();
  try {
    await client.connect();
    const catalog = await client.getModelCatalog();
    return {
      command: "today-status",
      cdp,
      pageUrl: client.pageUrl,
      currentModel: catalog.selectedOptionId ?? null,
      models: catalog.options.map(publicModel),
      gateway,
    };
  } catch (error) {
    return {
      command: "today-status",
      cdp,
      pageUrl: client.pageUrl,
      currentModel: null,
      models: [],
      gateway,
      error: String(error?.message ?? error),
    };
  } finally {
    client.close();
  }
}

export async function todayModels() {
  const client = new TodayClient();
  try {
    await client.connect();
    const catalog = await client.getModelCatalog();
    return {
      command: "today-models",
      currentModel: catalog.selectedOptionId ?? null,
      models: catalog.options.map(publicModel),
    };
  } finally {
    client.close();
  }
}

export async function todayChat({ text, model = null, timeoutMs = 180000 } = {}) {
  if (!text || !String(text).trim()) throw new Error("没有要发送的内容");
  const client = new TodayClient();
  try {
    await client.connect();
    const started = Date.now();
    const result = await client.chat(String(text), { model, timeoutMs });
    return {
      command: "today-chat",
      reply: result.content,
      model: result.model,
      threadId: result.threadId,
      messageId: result.messageId,
      elapsedMs: Date.now() - started,
    };
  } finally {
    client.close();
  }
}

export async function todaySetModel(optionId) {
  const client = new TodayClient();
  try {
    await client.connect();
    const catalog = await client.setModel(optionId);
    return {
      command: "today-model",
      currentModel: catalog?.selectedOptionId ?? optionId,
      models: catalog?.options?.map(publicModel) ?? [],
    };
  } finally {
    client.close();
  }
}

/** 启动本地 OpenAI 兼容网关；调用方负责保持进程存活。 */
export async function serveTodayGateway({
  port = todayPort(),
  apiKey = todayGatewayToken(),
  client = new TodayClient(),
} = {}) {
  return startTodayServer({ client, port, apiKey, log: console.log });
}

/** 以调试端口重启 Today.app（用户点击“启动 Today”时才会调用）。 */
export async function launchTodayWithDebugPort({ cdpPort = 9222, timeoutMs = 20000 } = {}) {
  try {
    execFileSync("osascript", ["-e", 'quit app "Today"'], { stdio: "ignore" });
  } catch {
    /* 没在运行 */
  }
  execFileSync("open", ["-a", "Today", "--args", `--remote-debugging-port=${cdpPort}`]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await cdpInfo(`http://127.0.0.1:${cdpPort}`);
    if (info.reachable) return info;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Today.app 启动后 CDP 仍未就绪");
}

export { createTodayServer };
