// 智商测试：在独立工作目录里嵌一套最小的 pi，用完即回收。
// cc-switch 只读。渠道的协议差异在这里适配，不写回 cc-switch。
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDir, dataFile } from "./paths.mjs";
import readline from "node:readline";

process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";

export const IQ_TOPICS = [
  {
    id: "pelican",
    title: "鹈鹕骑自行车",
    scene: "一只鹈鹕骑着自行车向前行进。要能看出鸟嘴、车轮和踏板在动。",
  },
  {
    id: "qin",
    title: "秦始皇骑自行车买菜",
    scene: "秦始皇穿着龙袍、戴着冕冠，骑着自行车去买菜。车筐里装着青菜，车轮在转，人在往前走。",
  },
  {
    id: "banana",
    title: "香蕉人开小汽车",
    scene: "一个香蕉形状的人开着一辆小汽车在路上行驶。要能看出香蕉的身体、方向盘，以及车轮在转。",
  },
  {
    id: "candy",
    title: "摸糖保证题",
    kind: "text",
  },
];

export function iqTopic(id) {
  return IQ_TOPICS.find((item) => item.id === id) || IQ_TOPICS[0];
}

const CANDY_PROMPT = [
  "在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。",
  "不同口味、不同形状的数量如下：",
  "苹果味：圆形 7 颗，五角星形 7 颗。",
  "桃子味：圆形 9 颗，五角星形 6 颗。",
  "西瓜味：圆形 8 颗，五角星形 4 颗。",
  "参赛者要在活动前决定摸出的糖果数目。最少取出多少颗，才能保证手中同时有不同形状的苹果味和桃子味？",
  "下面两种都算达到要求：圆形苹果味配五角星桃子味，或者圆形桃子味配五角星苹果味。",
  "不许联网，不许读文件，不许执行命令，只在这条回复里自己计算。",
  "先写出推理，最后单独一行写「答案：」加一个正整数。",
].join("\n");

export function iqPrompt(id) {
  const topic = iqTopic(id);
  if (topic.kind === "text") return CANDY_PROMPT;
  return [
    `用 SVG 画一个会动的 2D 场景：${topic.scene}`,
    "把完整页面写到当前工作目录的 index.html，打开就能看到动画。",
    "你可以多次调用 write、edit 和 read，把画面改到自己满意。写完后用 read 读回源码，确认里面有 svg，并且有 CSS、SMIL 或 requestAnimationFrame 动画，然后自己结束。",
    "边界：只写当前工作目录里的 index.html。不要创建别的文件，不要读工作目录以外的路径，不要联网，不要执行命令。",
  ].join("\n");
}

export const IQ_PROMPT = iqPrompt("pelican");

const TOOL_LABEL = {
  read: "读取文件",
  write: "写入文件",
  edit: "修改文件",
  bash: "执行命令",
};

function runsRoot() {
  return path.join(dataDir(), "iq-runs");
}

function clearPreviousRuns() {
  const root = runsRoot();
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    rmSync(path.join(root, name), { recursive: true, force: true });
  }
  const last = lastRunPath();
  if (existsSync(last)) rmSync(last, { force: true });
}

export function lastRunPath() {
  return dataFile("iq-last.json");
}

function htmlPathOf(dir) {
  return path.join(dir, "index.html");
}

function inspectHtml(dir) {
  const file = htmlPathOf(dir);
  if (!existsSync(file)) {
    return { exists: false, bytes: 0, hasSvg: false, hasAnimation: false, hints: [] };
  }
  const text = readFileSync(file, "utf8");
  const hints = [];
  if (/@keyframes|animation\s*:/i.test(text)) hints.push("css");
  if (/<animate|<animatetransform|<animatemotion/i.test(text)) hints.push("smil");
  if (/requestAnimationFrame|setInterval\s*\(/i.test(text)) hints.push("script");
  return {
    exists: true,
    bytes: Buffer.byteLength(text),
    hasSvg: /<svg[\s>]/i.test(text),
    hasAnimation: hints.length > 0,
    hints,
  };
}

function adaptChannel(provider) {
  const raw = String(provider.baseUrl || "").replace(/\/+$/, "");
  const anthropic = provider.appType === "claude"
    || provider.appType === "claude-desktop"
    || raw.includes("/step_plan");
  if (anthropic) {
    const baseUrl = raw.endsWith("/v1") ? raw.slice(0, -3) : raw;
    return { api: "anthropic-messages", baseUrl, authHeader: true };
  }
  const baseUrl = raw.endsWith("/v1") ? raw : `${raw}/v1`;
  return { api: "openai-completions", baseUrl, authHeader: false };
}

function writeModels(agentDir, provider, model, thinking) {
  const channel = adaptChannel(provider);
  const spec = (provider.models || []).find((item) => item.id === model || item === model);
  const supportsThinking = (spec?.thinkingLevels || []).some((level) => level !== "off") || thinking !== "off";
  const modelEntry = {
    id: model,
    name: model,
    reasoning: supportsThinking,
    input: ["text"],
    maxTokens: supportsThinking ? 32768 : 16384,
  };
  if (channel.api === "openai-completions" && supportsThinking) {
    modelEntry.compat = { supportsReasoningEffort: true, thinkingFormat: "openai" };
  }
  const providerConfig = {
    baseUrl: channel.baseUrl,
    api: channel.api,
    apiKey: provider.apiKey,
    authHeader: channel.authHeader,
    models: [modelEntry],
  };
  if (channel.baseUrl.includes("opencode.ai")) {
    providerConfig.headers = {
      "User-Agent": "opencode/1.18.32",
      "x-opencode-client": "opencode",
      "x-opencode-session": randomUUID(),
      "x-opencode-request": randomUUID(),
    };
  }
  const config = { providers: { hotswitch: providerConfig } };
  mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, "models.json");
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return channel;
}

function attachControl(session, control) {
  if (process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin });
  control.close = () => rl.close();
  rl.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.cmd === "pause") {
      control.paused = true;
      session.abort().catch(() => {});
      return;
    }
    if (message.cmd === "resume") {
      control.paused = false;
      const wake = control.wake;
      control.wake = null;
      wake?.();
      return;
    }
    if (message.cmd === "cancel") {
      control.cancelled = true;
      control.paused = false;
      const wake = control.wake;
      control.wake = null;
      wake?.();
      session.abort().catch(() => {});
    }
  });
}

function waitControl(control) {
  return new Promise((resolve) => {
    control.wake = resolve;
  });
}

function extractAnswer(text) {
  const matched = String(text || "").match(/答案\s*[:：]\s*(\d+)/);
  return matched ? matched[1] : null;
}

function assistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function publicError(message) {
  return String(message || "模型这次没有完成")
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function describeEvent(event, log, problems) {
  if (event.type === "tool_execution_start") {
    log(`STEP ${TOOL_LABEL[event.toolName] || event.toolName}`);
    return;
  }
  if (event.type === "tool_execution_end" && event.isError) {
    log(`STEP ${TOOL_LABEL[event.toolName] || event.toolName}失败`);
    return;
  }
  if (event.type === "message_end") {
    const text = assistantText(event.message);
    if (text) log(`STEP ${text.slice(0, 160)}`);
    if (event.message?.stopReason === "error" && event.message.errorMessage) {
      problems.text = publicError(event.message.errorMessage);
      log(`STEP ${problems.text}`);
    }
  }
}

const THINKING_LABEL = {
  off: "关闭",
  minimal: "极轻",
  low: "轻",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

function anthropicThinkingExtension(channel, thinking, model) {
  return (pi) => {
    pi.on("before_provider_request", (event) => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") return undefined;
      if (channel.api !== "anthropic-messages") return undefined;
      const stepfun = channel.baseUrl.includes("stepfun") || channel.baseUrl.includes("step_plan");
      const adaptive = /opus-5|sonnet-5|claude-[a-z]+-5/i.test(model);
      if (!stepfun && !adaptive) return undefined;
      if (!thinking || thinking === "off") {
        delete payload.thinking;
        delete payload.output_config;
        return payload;
      }
      const effort = thinking === "minimal" ? "low" : thinking === "xhigh" ? "high" : thinking;
      if (stepfun) delete payload.thinking;
      else payload.thinking = { type: "adaptive" };
      payload.output_config = { ...(payload.output_config || {}), effort };
      return payload;
    });
  };
}

export async function runIqTest({ provider, model, thinking = "off", topic = "pelican", prompt, log = console.error } = {}) {
  if (!model) throw new Error("缺少模型名");
  if (!provider?.apiKey || !provider?.baseUrl) throw new Error("这个供应商没有可用的地址或密钥");
  const {
    AuthStorage,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
    createAgentSession,
  } = await import("@mariozechner/pi-coding-agent");

  clearPreviousRuns();
  const dir = path.join(runsRoot(), new Date().toISOString().replace(/[:.]/g, "-"));
  const agentDir = path.join(dir, ".pi");
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const htmlFile = htmlPathOf(dir);
  let announced = false;
  let session = null;
  const watch = setInterval(() => {
    if (!announced && existsSync(htmlFile)) {
      announced = true;
      log(`HTML ${htmlFile}`);
    }
  }, 400);
  const control = { paused: false, cancelled: false, wake: null };
  const chosen = iqTopic(topic);
  const task = prompt || iqPrompt(chosen.id);
  let failure = "";
  let reply = "";
  try {
    const channel = writeModels(agentDir, provider, model, thinking);
    const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
    const found = modelRegistry.find("hotswitch", model);
    if (!found) throw new Error(`pi 没有接上模型 ${model}`);
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [anthropicThinkingExtension(channel, thinking, model)],
      systemPrompt: chosen.kind === "text"
        ? "你是在做一道闭卷计算题。只在回复里自己算。不要调用工具，不要读写文件，不要联网，不要执行命令。推理写完后，最后单独一行给出「答案：」和正整数。"
        : "你是嵌在本机测试里的编程助手。只在当前工作目录写 index.html。可以用 read、write、edit 把这一页做完，确认有 SVG 和动画后就结束。不要访问工作目录以外的路径，不要联网，不要执行命令。",
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir,
      authStorage,
      modelRegistry,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(dir),
      settingsManager: SettingsManager.create(dir, agentDir),
      model: found,
      tools: chosen.kind === "text" ? [] : ["read", "write", "edit"],
      thinkingLevel: thinking,
    }));
    attachControl(session, control);
    const problems = { text: "" };
    session.subscribe((event) => describeEvent(event, log, problems));
    const toolNames = (session.agent?.state?.tools || []).map((tool) => tool.name).filter(Boolean);
    log(`RUN_DIR ${dir}`);
    log(`STEP 已启动 pi · ${channel.api}`);
    if (toolNames.length) log(`STEP 工具 ${toolNames.join("、")}`);
    log(`STEP ${provider.name} / ${model}`);
    log(`STEP 题目 ${chosen.title}`);
    log(`STEP 思考强度 ${THINKING_LABEL[thinking] || thinking}`);

    let instruction = task;
    let reminders = 0;
    let fixes = 0;
    const textTask = chosen.kind === "text";
    while (!control.cancelled) {
      log("STATE running");
      if (control.cancelled) break;
      try {
        const pending = session.prompt(instruction);
        if (control.cancelled || control.paused) session.abort().catch(() => {});
        await pending;
      } catch (error) {
        if (!(control.paused || control.cancelled)) throw error;
      }
      if (control.cancelled) break;
      if (control.paused) {
        log("STATE paused");
        log("STEP 已暂停");
        await waitControl(control);
        if (control.cancelled) break;
        instruction = textTask
          ? "继续用文字把这道题算完。不要调用工具，不要联网。最后单独一行写「答案：」和正整数。"
          : "继续完成 index.html。写完并确认后就结束。";
        continue;
      }
      if (textTask) {
        const messages = session.messages || [];
        const last = [...messages].reverse().find((item) => item.role === "assistant");
        reply = assistantText(last);
        if (last?.stopReason === "error") {
          failure = problems.text || publicError(last.errorMessage);
          break;
        }
        if (reply) break;
        if (reminders >= 1) break;
        reminders += 1;
        instruction = "请直接用文字作答，不要调用工具，不要联网，不要读写文件。最后单独一行写「答案：」和正整数。";
        continue;
      }
      if (existsSync(htmlFile)) {
        const look = inspectHtml(dir);
        if (look.hasSvg && look.hasAnimation) break;
        if (fixes >= 1) break;
        fixes += 1;
        const missing = [];
        if (!look.hasSvg) missing.push("SVG 图形");
        if (!look.hasAnimation) missing.push("动画（CSS、SMIL 或 requestAnimationFrame）");
        log(`STEP 页面还缺${missing.join("和")}`);
        instruction = `index.html 已经写好，但还缺${missing.join("和")}。请用 edit 或 write 补上，再用 read 确认，然后结束。只改当前工作目录里的 index.html。`;
        continue;
      }
      const messages = session.messages || [];
      const last = [...messages].reverse().find((item) => item.role === "assistant");
      if (last?.stopReason === "error") {
        failure = problems.text || publicError(last.errorMessage);
        break;
      }
      if (reminders >= 2) break;
      reminders += 1;
      instruction = "index.html 还不存在。请现在调用 write 工具，把完整 HTML 写入 index.html，然后结束。";
    }
  } finally {
    clearInterval(watch);
    if (!announced && existsSync(htmlFile)) {
      announced = true;
      log(`HTML ${htmlFile}`);
    }
    try {
      session?.dispose();
    } catch {
      /* 回收时会话可能已经结束 */
    }
    rmSync(agentDir, { recursive: true, force: true });
    control.close?.();
  }

  if (control.cancelled) log("STATE cancelled");
  const inspect = inspectHtml(dir);
  const summary = {
    providerId: provider.id,
    providerName: provider.name,
    model,
    thinking,
    topic: chosen.id,
    topicTitle: chosen.title,
    reply: reply || null,
    answer: extractAnswer(reply),
    runDir: dir,
    htmlPath: existsSync(htmlFile) ? htmlFile : null,
    turns: null,
    elapsedMs: Date.now() - started,
    stopReason: control.cancelled ? "cancelled" : (failure ? "error" : "completed"),
    inspect,
    prompt: task,
  };
  writeFileSync(lastRunPath(), `${JSON.stringify(summary, null, 2)}\n`);
  if (control.cancelled) {
    log("STEP 已取消");
    return summary;
  }
  if (chosen.kind === "text") {
    if (!summary.reply) throw new Error(failure || "模型没有给出文字答案");
    log(`STEP 结束 ${summary.stopReason}${summary.answer ? ` 答案 ${summary.answer}` : ""}`);
    return summary;
  }
  if (!summary.htmlPath) throw new Error(failure || "pi 结束了，但没有找到 index.html");
  log(`STEP 结束 ${summary.stopReason}`);
  return summary;
}
