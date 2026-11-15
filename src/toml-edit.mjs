// 行级 TOML 编辑：复刻 cc-switch 写入 config.toml 的关键行为
// （experimental_bearer_token 注入 + model_catalog_json 字段管理）。
// 只处理 cc-switch 生成的标准形状（[model_providers.<id>]  section 表头）。

/** Codex 保留供应商 id：token 不能进入这些内置表，只能放顶层。 */
const RESERVED_PROVIDER_IDS = new Set([
  "amazon-bedrock",
  "amazon-bedrock-runtime",
  "openai",
  "ollama",
  "lmstudio",
]);

const CC_SWITCH_CATALOG_FILENAME = "cc-switch-model-catalog.json";

function isCommentOrBlank(line) {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/** 把任意字符串写成 TOML basic string（token 里可能出现引号、反斜杠、换行）。 */
export function tomlString(value) {
  const escaped = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** 解析 section 表头，支持裸键、引号键、子表和 [[数组表]]。 */
export function parseSectionHeader(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[")) return null;
  const array = trimmed.startsWith("[[");
  const open = array ? 2 : 1;
  const close = array ? "]]" : "]";
  if (!trimmed.endsWith(close)) {
    // 允许行尾注释
    const comment = trimmed.indexOf("#");
    if (comment === -1) return null;
    const head = trimmed.slice(0, comment).trimEnd();
    if (!head.endsWith(close)) return null;
    return parseSectionHeader(head);
  }
  const inner = trimmed.slice(open, trimmed.length - close.length).trim();
  if (!inner) return null;

  const parts = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuote) {
      if (ch === "\\" && i + 1 < inner.length) {
        buf += inner[i + 1];
        i++;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === ".") {
      const part = buf.trim();
      if (part) parts.push(part);
      buf = "";
    } else {
      buf += ch;
    }
  }
  const last = buf.trim();
  if (last) parts.push(last);
  return parts.length ? { path: parts, array } : null;
}

function samePath(a, b) {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

function isDescendant(parent, child) {
  return child.length > parent.length && parent.every((part, i) => part === child[i]);
}

/** 匹配顶层键（第一个 section 之前、行首无缩进、非注释）。 */
function topLevelKeyLine(lines, key) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentOrBlank(line)) continue;
    if (parseSectionHeader(line)) break; // 进入 section 域
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (m && m[1] === key) return i;
  }
  return -1;
}

/** 读取顶层字符串键值。 */
export function readTopLevelString(text, key) {
  const lines = text.split(/\r?\n/);
  const idx = topLevelKeyLine(lines, key);
  if (idx === -1) return null;
  const m = lines[idx].match(/=\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  return m[1]
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** 当前生效的 model_provider id。 */
export function activeProviderId(text) {
  return readTopLevelString(text, "model_provider");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function providerSectionPath(providerId) {
  return ["model_providers", providerId];
}

/** 某个 section 表头的行下标（返回全部匹配；重复表只处理第一处，但保留检测能力）。 */
function sectionHeaderIndices(lines, path) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (isCommentOrBlank(lines[i])) continue;
    const header = parseSectionHeader(lines[i]);
    if (header && !header.array && samePath(header.path, path)) hits.push(i);
  }
  return hits;
}

/** 父 section 的直属 body：到下一个任意表头为止。 */
function directBodyEnd(lines, headerIdx) {
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (isCommentOrBlank(lines[i])) continue;
    if (parseSectionHeader(lines[i])) return i;
  }
  return lines.length;
}

/** 父 section 的完整 block：包含子表（[a.b]、[[a.b]]），到下一个非子表表头为止。 */
function sectionBlockEnd(lines, headerIdx, path) {
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (isCommentOrBlank(lines[i])) continue;
    const header = parseSectionHeader(lines[i]);
    if (!header) continue;
    if (samePath(header.path, path) || isDescendant(path, header.path)) continue;
    return i;
  }
  return lines.length;
}

/** 直属 body 内的键匹配（不含子表）。 */
function directKeyLines(lines, headerIdx, key) {
  const end = directBodyEnd(lines, headerIdx);
  const re = new RegExp(`^\\s*("?${escapeRegExp(key)}"?)\\s*=`);
  const hits = [];
  for (let i = headerIdx + 1; i < end; i++) {
    if (isCommentOrBlank(lines[i])) continue;
    if (re.test(lines[i])) hits.push(i);
  }
  return hits;
}

/** 表内是否声明了自己的鉴权来源（auth/aws/env_key 子表，或 Authorization 头）。 */
function sectionDeclaresAuth(lines, headerIdx, path) {
  const end = sectionBlockEnd(lines, headerIdx, path);
  const body = lines.slice(headerIdx + 1, end);

  // 直属键 auth / aws / env_key
  for (const key of ["auth", "aws", "env_key"]) {
    if (directKeyLines(lines, headerIdx, key).length) return true;
  }

  const requiresOpenaiAuth = directKeyLines(lines, headerIdx, "requires_openai_auth");
  if (requiresOpenaiAuth.length && /true/i.test(lines[requiresOpenaiAuth[0]])) return false;

  for (const line of body) {
    if (isCommentOrBlank(line)) continue;
    const header = parseSectionHeader(line);
    if (header) continue;
    // 子表里的 Authorization = "..." 或 http_headers = { Authorization = ... }
    if (/^\s*"?authorization"?\s*=/i.test(line)) return true;
    if (/^\s*(http_headers|env_http_headers)\s*=/.test(line) && /authorization/i.test(line)) {
      return true;
    }
  }

  // 子表 [model_providers.x.http_headers] 内的 Authorization
  for (let i = headerIdx + 1; i < end; i++) {
    const header = parseSectionHeader(lines[i]);
    if (!header) continue;
    if (!/(http_headers|env_http_headers)/.test(header.path.join("."))) continue;
    const subEnd = directBodyEnd(lines, i);
    for (let j = i + 1; j < subEnd; j++) {
      if (/^\s*"?authorization"?\s*=/i.test(lines[j])) return true;
    }
  }
  return false;
}

/**
 * 注入 experimental_bearer_token，规则与 cc-switch 一致：
 * - 供应商表已声明自有鉴权 → 不动
 * - 保留 id 或找不到表 → 放顶层
 * - 否则写入 [model_providers.<id>] 表内（子表之前）
 */
export function injectBearerToken(text, token) {
  if (!text.trim()) {
    throw new Error("第三方供应商的 config 为空，无法写入 bearer token");
  }
  if (!token) return text;

  const lines = text.split(/\r?\n/);
  const providerId = activeProviderId(text);
  const assignment = `experimental_bearer_token = ${tomlString(token)}`;

  const putTopLevel = () => {
    const idx = topLevelKeyLine(lines, "experimental_bearer_token");
    if (idx !== -1) {
      lines[idx] = assignment;
    } else {
      let insertAt = lines.length;
      for (let i = 0; i < lines.length; i++) {
        if (!isCommentOrBlank(lines[i]) && parseSectionHeader(lines[i])) {
          insertAt = i;
          break;
        }
      }
      let j = insertAt;
      while (j > 0 && isCommentOrBlank(lines[j - 1])) j--;
      lines.splice(j, 0, assignment);
    }
    return lines.join("\n");
  };

  if (!providerId || RESERVED_PROVIDER_IDS.has(providerId)) {
    return putTopLevel();
  }

  const headers = sectionHeaderIndices(lines, providerSectionPath(providerId));
  if (!headers.length) {
    // 找不到供应商表（可能是 inline table 形状）：退回顶层
    return putTopLevel();
  }

  let changed = false;
  for (const headerIdx of headers) {
    if (sectionDeclaresAuth(lines, headerIdx, providerSectionPath(providerId))) continue;
    const existing = directKeyLines(lines, headerIdx, "experimental_bearer_token");
    if (existing.length) {
      lines[existing[0]] = assignment;
      changed = true;
      continue;
    }
    // cc-switch 用 toml_edit 的 table.insert：键追加在表直属 body 末尾（子表之前）
    const end = directBodyEnd(lines, headerIdx);
    let insertAt = end;
    while (insertAt > headerIdx + 1 && isCommentOrBlank(lines[insertAt - 1])) insertAt--;
    lines.splice(insertAt, 0, assignment);
    changed = true;
  }
  return changed ? lines.join("\n") : text;
}

/**
 * 读当前供应商表的鉴权字段。
 * requiresOpenaiAuth=true 表示 Codex 会把 ChatGPT 登录态挂到这个供应商上：
 * app-server 的 account/read 会返回账号（planType/workspaceName），桌面端身份随之
 * 从 signed-out 变成 sha256([userId, accountId])，按身份寄存的侧边栏状态（远端对话、
 * 项目展开、最近文件）就"消失"了；部分请求还会走 chatgpt.com 后端。
 */
export function providerAuthState(text) {
  const providerId = activeProviderId(text);
  if (!providerId) return null;
  const lines = text.split(/\r?\n/);
  const headers = sectionHeaderIndices(lines, providerSectionPath(providerId));
  if (!headers.length) return null;
  const headerIdx = headers[0];
  const valueOf = (key) => {
    const idx = directKeyLines(lines, headerIdx, key)[0];
    if (idx === undefined) return null;
    const raw = lines[idx].slice(lines[idx].indexOf("=") + 1).trim();
    const quoted = raw.match(/^"((?:[^"\\]|\\.)*)"/);
    if (quoted) return quoted[1].replace(/\\"/g, '"');
    return raw.replace(/\s+#.*$/, "");
  };
  const auth = valueOf("requires_openai_auth");
  const baseUrl = valueOf("base_url");
  const hasTableKey = (key) => directKeyLines(lines, headerIdx, key).length > 0;
  const hasOwnAuth =
    hasTableKey("env_key") ||
    hasTableKey("auth") ||
    hasTableKey("aws") ||
    hasTableKey("http_headers") ||
    hasTableKey("env_http_headers");
  return {
    providerId,
    reserved: RESERVED_PROVIDER_IDS.has(providerId),
    name: valueOf("name"),
    baseUrl,
    requiresOpenaiAuth: auth === "true",
    hasBearerToken: Boolean(valueOf("experimental_bearer_token")),
    hasOwnAuth,
    openAiBackend: isOpenAiBackendUrl(baseUrl),
  };
}

/**
 * 供应商是否真的连 OpenAI / ChatGPT 后端。
 * 只有这种供应商才应该借用 ChatGPT 登录态（requires_openai_auth = true）；
 * 任何第三方中转都不该借用。
 */
export function isOpenAiBackendUrl(baseUrl) {
  if (!baseUrl) return false;
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    const m = String(baseUrl).match(/^[a-z]+:\/\/([^/:?#]+)/i);
    host = m ? m[1].toLowerCase() : String(baseUrl).toLowerCase();
  }
  return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chatgpt.ai" || host === "openai.com" || host.endsWith(".openai.com");
}

/**
 * 第三方供应商必须 requires_openai_auth = false，否则 ChatGPT 登录态会被带进来
 * （账号菜单显示 team、signed-out 命名空间下的侧边栏状态全部隐藏）。
 * 官方供应商的保留 id、以及真的连 OpenAI 后端的供应商不动。
 */
export function forceProviderAuthLocal(text) {
  const state = providerAuthState(text);
  if (!state || state.reserved) return { text, changed: false };
  if (isOpenAiBackendUrl(state.baseUrl)) return { text, changed: false };

  const lines = text.split(/\r?\n/);
  const headers = sectionHeaderIndices(lines, providerSectionPath(state.providerId));
  if (!headers.length) return { text, changed: false };

  let changed = false;
  for (const headerIdx of headers) {
    const existing = directKeyLines(lines, headerIdx, "requires_openai_auth");
    if (existing.length) {
      for (const idx of existing) {
        if (/^\s*requires_openai_auth\s*=\s*false\s*$/i.test(lines[idx])) continue;
        const indent = lines[idx].match(/^\s*/)[0];
        lines[idx] = `${indent}requires_openai_auth = false`;
        changed = true;
      }
      continue;
    }
    const end = directBodyEnd(lines, headerIdx);
    let insertAt = end;
    while (insertAt > headerIdx + 1 && isCommentOrBlank(lines[insertAt - 1])) insertAt--;
    lines.splice(insertAt, 0, "requires_openai_auth = false");
    changed = true;
  }
  return { text: changed ? lines.join("\n") : text, changed };
}

function catalogValue(lines, idx) {
  const raw = lines[idx].slice(lines[idx].indexOf("=") + 1).trim();
  if (raw.startsWith('"')) {
    const m = raw.match(/^"((?:[^"\\]|\\.)*)"/);
    return m ? m[1].replace(/\\"/g, '"') : null;
  }
  if (/^null\b/.test(raw)) return null;
  return undefined; // 其它表达式/外部变量：不要碰
}

/** 读取顶层 model_catalog_json 的原始值（缺失返回 null，非字面量返回 undefined）。 */
export function catalogJsonValue(text) {
  const lines = text.split(/\r?\n/);
  const idx = topLevelKeyLine(lines, "model_catalog_json");
  if (idx === -1) return null;
  return catalogValue(lines, idx);
}

/**
 * 管理顶层 model_catalog_json 字段：
 * - on=true  且字段缺失或为 null → 注入；`force` 为 true 时覆盖已有值
 *   （用于把 cc-switch 钉死的旧目录改回我们生成的 catalog）
 * - on=false 且字段指向 cc-switch 文件或为 null → 移除
 */
export function setCatalogJsonField(text, on, { force = false } = {}) {
  const lines = text.split(/\r?\n/);
  const idx = topLevelKeyLine(lines, "model_catalog_json");
  const currentValue = idx === -1 ? undefined : catalogValue(lines, idx);
  const assignment = `model_catalog_json = "${CC_SWITCH_CATALOG_FILENAME}"`;

  if (on) {
    if (idx !== -1) {
      const owned = force || currentValue === CC_SWITCH_CATALOG_FILENAME || currentValue === null;
      if (owned) {
        lines[idx] = assignment;
        return lines.join("\n");
      }
      return text; // 用户自管的外部 catalog 文件，不动
    }
    let insertAt = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (!isCommentOrBlank(lines[i]) && parseSectionHeader(lines[i])) {
        insertAt = i;
        break;
      }
    }
    let j = insertAt;
    while (j > 0 && isCommentOrBlank(lines[j - 1])) j--;
    lines.splice(j, 0, assignment);
    return lines.join("\n");
  }

  if (idx !== -1 && (currentValue === CC_SWITCH_CATALOG_FILENAME || currentValue === null)) {
    lines.splice(idx, 1);
    return lines.join("\n");
  }
  return text;
}
