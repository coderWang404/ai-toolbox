// notes-sync 配置与凭证。所有敏感文件都在 vault 之外，绝不写进百度云同步盘。
// 凭证优先级：环境变量 → ~/.config/ima/{client_id,api_key} → ~/.ai-toolbox/notes-sync.json
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataFile } from "../paths.mjs";

export const DEFAULT_VAULT = "/Users/MacBook/baidusync/笔记";
// 用户明确要求全库同步，不做目录级排除。百度云是私人云盘。
// 仅保留技术性过滤（临时文件、系统垃圾、点目录、冲突副本），不针对任何内容目录。
export const DEFAULT_EXCLUDES = [];
export const DEFAULT_INBOX = "ima-inbox";

function readTrimmed(file) {
  if (!file || !existsSync(file)) return null;
  try {
    const value = readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function loadCredentials() {
  const fromEnv = {
    clientId: process.env.IMA_OPENAPI_CLIENTID?.trim() || null,
    apiKey: process.env.IMA_OPENAPI_APIKEY?.trim() || null,
  };
  if (fromEnv.clientId && fromEnv.apiKey) return { ...fromEnv, source: "env" };

  const imaDir = path.join(os.homedir(), ".config", "ima");
  const fromFiles = {
    clientId: readTrimmed(path.join(imaDir, "client_id")),
    apiKey: readTrimmed(path.join(imaDir, "api_key")),
  };
  if (fromFiles.clientId && fromFiles.apiKey) return { ...fromFiles, source: "~/.config/ima" };

  const configFile = process.env.NOTES_SYNC_CONFIG || dataFile("notes-sync.json");
  let fromJson = null;
  try {
    fromJson = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : null;
  } catch {
    fromJson = null;
  }
  if (fromJson?.clientId && fromJson?.apiKey) {
    return { clientId: fromJson.clientId, apiKey: fromJson.apiKey, source: configFile };
  }

  throw new Error(
    `缺少 ima OpenAPI 凭证。请打开 https://ima.qq.com/agent-interface 获取 Client ID 与 API Key，` +
      `然后写入 ~/.config/ima/client_id 和 ~/.config/ima/api_key（权限 600），或设置环境变量。`
  );
}

/** 非敏感配置，可放 ~/.ai-toolbox/notes-sync.json，与凭证共存于同一文件。 */
export function loadConfig(overrides = {}) {
  const configFile = process.env.NOTES_SYNC_CONFIG || dataFile("notes-sync.json");
  let file = {};
  try {
    file = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  } catch {
    file = {};
  }
  return {
    vaultRoot: overrides.vaultRoot || file.vaultRoot || DEFAULT_VAULT,
    knowledgeBaseId: overrides.knowledgeBaseId || file.knowledgeBaseId || "",
    folderId: overrides.folderId || file.folderId || "",
    excludes: overrides.excludes || file.excludes || DEFAULT_EXCLUDES,
    inboxDir: overrides.inboxDir || file.inboxDir || DEFAULT_INBOX,
    // newest-wins：两端都改过时以较新时间戳者为准，不生成任何冲突副本。
    conflictStrategy: overrides.conflictStrategy || file.conflictStrategy || "newest-wins",
    // 全库同步：图片/附件也走文件型上传通道。
    includeBinary: overrides.includeBinary ?? file.includeBinary ?? true,
    // 回写策略，待 notes-probe 实测后决定默认值（append = 只追加新增行，不覆盖原文）。
    pullMode: overrides.pullMode || file.pullMode || "append",
    // add_knowledge 的同名替换策略；OpenAPI 侧待验证，失效时自动退回「新建 + 旧条目移回收站」。
    useReplace: overrides.useReplace ?? file.useReplace ?? true,
    recycleFolderId: overrides.recycleFolderId || file.recycleFolderId || "",
    contentFormat: overrides.contentFormat ?? file.contentFormat ?? 0,
    localPollMs: overrides.localPollMs ?? file.localPollMs ?? 1000,
    remotePollMs: overrides.remotePollMs ?? file.remotePollMs ?? 10000,
    // 与旧 note-sync 一致：单文件 90MB 以上才跳过并告警，不做内容级排除。
    maxFileBytes: overrides.maxFileBytes ?? file.maxFileBytes ?? 90 * 1024 * 1024,
    // ima 无删除接口，本地删除只进回收站，不主动删云端条目。
    trashRetentionDays: overrides.trashRetentionDays ?? file.trashRetentionDays ?? 30,
  };
}
