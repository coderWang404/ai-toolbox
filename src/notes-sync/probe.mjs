// 端点探测：拿真实凭证把 ima OpenAPI 的能力边界跑一遍，输出可复核的原始证据。
// 默认纯只读，不发任何写请求；笔记正文默认不外显，只在 --show-content 时给截断样本。
//
// 重点回答四个决定架构的问题：
//   1. get_doc_content 的 target_content_format 有没有能返回 Markdown 的取值（决定回写保真度）
//   2. export_note 是否存在、返回什么
//   3. list_note 是否给出 modify_time（决定能不能做远端增量检测）
//   4. 知识库条目与 note 是不是同一个 content_id（决定双向闭环能否成立）
import { loadCredentials } from "./config.mjs";
import { EP, rawCall } from "./ima-api.mjs";

const MD_MARKERS = ["# ", "## ", "```", "| ---", "![", "- [ ]", "> ", "[[", "---"];

function detectMarkdown(text) {
  if (typeof text !== "string") return { isString: false, markers: [] };
  return {
    isString: true,
    length: text.length,
    markers: MD_MARKERS.filter((m) => text.includes(m)),
    sample: null,
  };
}

function shape(data) {
  if (data == null) return { type: "null" };
  if (Array.isArray(data)) return { type: "array", length: data.length, keys: Object.keys(data[0] ?? {}) };
  if (typeof data === "object") return { type: "object", keys: Object.keys(data) };
  return { type: typeof data };
}

async function probeOne(label, endpoint, body, creds, opts = {}) {
  const entry = { label, endpoint, request: body };
  try {
    const r = await rawCall(endpoint, body, creds, { timeoutMs: opts.timeoutMs ?? 15000 });
    entry.httpStatus = r.httpStatus;
    entry.code = r.code;
    entry.msg = r.msg;
    entry.dataShape = shape(r.data);
    if (opts.inspect) entry.inspect = opts.inspect(r.data, r.raw);
    // 默认也检测 Markdown 特征（只看标记符号与长度，不落正文），否则无法判断回写保真度。
    const text = [r.data?.content, r.data?.markdown, r.data?.text, r.data?.doc_content]
      .find((v) => typeof v === "string") ?? null;
    if (text) {
      entry.contentProbe = {
        ...detectMarkdown(text),
        sample: opts.showContent ? text.slice(0, 300) : null,
      };
    }
  } catch (err) {
    entry.error = String(err.message ?? err);
    entry.httpStatus = err.httpStatus ?? null;
    entry.code = err.code ?? null;
  }
  return entry;
}

function notesShape(data, raw) {
  const list = data?.note_book_list ?? data?.note_list ?? [];
  const first = list[0];
  return {
    listKey: data?.note_book_list ? "note_book_list" : data?.note_list ? "note_list" : null,
    count: list.length,
    nextCursor: data?.next_cursor ?? null,
    isEnd: data?.is_end ?? null,
    firstItemKeys: first ? Object.keys(first) : [],
    firstInfoKeys: first?.basic_info?.basic_info ? Object.keys(first.basic_info.basic_info) : Object.keys(first?.basic_info ?? {}),
    firstNoteId: first?.basic_info?.basic_info?.docid
      ?? first?.basic_info?.basic_info?.note_id
      ?? first?.basic_info?.docid
      ?? first?.basic_info?.note_id
      ?? first?.note_id ?? null,
    firstModifyTime: first?.basic_info?.basic_info?.modify_time ?? first?.basic_info?.modify_time ?? first?.modify_time ?? null,
    rawTopKeys: raw ? Object.keys(raw) : [],
  };
}

/**
 * @param {{showContent?:boolean, creds?:object}} opts
 * @returns 结构化证据对象
 */
export async function runProbe(opts = {}) {
  const creds = opts.creds ?? loadCredentials();
  const showContent = Boolean(opts.showContent);
  const results = [];

  const listNotebook = await probeOne(
    "笔记本列表", EP.LIST_NOTEBOOK, { cursor: "0", limit: 1 }, creds
  );
  results.push(listNotebook);

  const listByFolder = await probeOne(
    "全部笔记（按文件夹列举）", EP.LIST_NOTE_BY_FOLDER,
    { folder_id: "", cursor: "", limit: 3 }, creds, { inspect: notesShape }
  );
  results.push(listByFolder);

  const listNote = await probeOne(
    "全部笔记（list_note 别名）", EP.LIST_NOTE,
    { cursor: "", limit: 3 }, creds, { inspect: notesShape }
  );
  results.push(listNote);

  const kb = await probeOne(
    "可写入知识库列表", EP.GET_ADDABLE_KB, { cursor: "", limit: 50 }, creds,
    { inspect: (d) => ({ keys: Object.keys(d ?? {}), list: d?.addable_knowledge_base_list ?? null }) }
  );
  results.push(kb);

  // 取第一篇笔记，逐一试探正文读取格式。
  const firstNoteId =
    listByFolder.inspect?.firstNoteId ?? listNote.inspect?.firstNoteId ?? null;
  const contentProbes = [];
  if (firstNoteId) {
    for (const format of [0, 1, 2, 3]) {
      contentProbes.push(await probeOne(
        `读取正文 target_content_format=${format}`,
        EP.GET_DOC_CONTENT,
        { doc_id: firstNoteId, target_content_format: format },
        creds,
        { showContent, inspect: (d) => ({ keys: Object.keys(d ?? {}), contentLength: typeof d?.content === "string" ? d.content.length : null }) }
      ));
    }
    contentProbes.push(await probeOne(
      "export_note（是否存在 / 返回什么）", EP.EXPORT_NOTE,
      { doc_id: firstNoteId }, creds,
      { showContent, inspect: (d) => ({ keys: Object.keys(d ?? {}), shape: shape(d) }) }
    ));
  }
  results.push(...contentProbes);

  const firstKbId = kb.inspect?.list?.[0]?.id ?? null;
  if (firstKbId) {
    results.push(await probeOne(
      "知识库条目列表", EP.GET_KNOWLEDGE_LIST,
      { knowledge_base_id: firstKbId, folder_id: "", cursor: "", limit: 3 }, creds,
      { inspect: (d) => ({ keys: Object.keys(d ?? {}), count: d?.knowledge_list?.length ?? null, total: d?.total_size ?? null }) }
    ));
  }

  const formatEntries = contentProbes.filter((r) => r.endpoint === EP.GET_DOC_CONTENT);
  const markdownFormats = formatEntries
    .filter((r) => r.contentProbe?.markers?.length > 0)
    .map((r) => r.request.target_content_format);

  return {
    probedAt: new Date().toISOString(),
    baseUrl: "https://ima.qq.com",
    credentialSource: creds.source ?? "provided",
    firstNoteId,
    firstKbId,
    results,
    conclusions: {
      hasModifyTime: Boolean(listByFolder.inspect?.firstModifyTime ?? listNote.inspect?.firstModifyTime),
      listEndpointWorks: listByFolder.code === 0 || listNote.code === 0,
      workingListEndpoint: listByFolder.code === 0 ? EP.LIST_NOTE_BY_FOLDER : listNote.code === 0 ? EP.LIST_NOTE : null,
      exportNoteExists: contentProbes.find((r) => r.endpoint === EP.EXPORT_NOTE)?.code === 0,
      contentFormatsOk: formatEntries.filter((r) => r.code === 0).map((r) => r.request.target_content_format),
      markdownPreservingFormats: markdownFormats,
      note: "REPLACE 策略与 move_knowledge 属于写操作，默认不探测；需显式 --write-probe 且会创建测试条目。",
    },
  };
}

/** CLI 友好输出：只打印证据摘要，不打印笔记正文。 */
export function formatProbeSummary(report) {
  const lines = [];
  lines.push(`探测时间: ${report.probedAt}`);
  lines.push(`凭证来源: ${report.credentialSource}`);
  lines.push(`样本笔记: ${report.firstNoteId ?? "无"}  样本知识库: ${report.firstKbId ?? "无"}`);
  lines.push("");
  lines.push("端点                                             HTTP  code    说明");
  lines.push("─".repeat(88));
  for (const r of report.results) {
    const ep = r.endpoint.padEnd(46);
    const http = String(r.httpStatus ?? "-").padEnd(5);
    const code = String(r.code ?? r.error ?? "-").slice(0, 20).padEnd(8);
    lines.push(`${ep} ${http} ${code} ${r.label}`);
  }
  lines.push("");
  lines.push("结论:");
  lines.push(`  可用列表端点: ${report.conclusions.workingListEndpoint ?? "无"}`);
  lines.push(`  有 modify_time（可做远端增量检测）: ${report.conclusions.hasModifyTime}`);
  lines.push(`  get_doc_content 可用 format: ${JSON.stringify(report.conclusions.contentFormatsOk)}`);
  lines.push(`  保真 Markdown 的 format: ${JSON.stringify(report.conclusions.markdownPreservingFormats)}`);
  lines.push(`  export_note 存在: ${report.conclusions.exportNoteExists}`);
  return lines.join("\n");
}
