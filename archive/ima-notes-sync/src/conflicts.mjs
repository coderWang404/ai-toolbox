// 百度云冲突副本分析（只读）。逐个比对主文件与副本的内容 hash、mtime、文件名时间戳，
// 判定哪一份才是「最新的保留本」，输出可复核清单。本模块不删除任何文件。
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./vault.mjs";
import { loadConfig } from "./config.mjs";

const CONFLICT_RE = /^(.+)_冲突文件_(.+)_(\d{14})(\.[^.]+)$/;

function statSafe(full) {
  try {
    const st = statSync(full);
    return { size: st.size, mtimeMs: st.mtimeMs, mtime: new Date(st.mtimeMs).toISOString() };
  } catch {
    return null;
  }
}

function digestSafe(full) {
  try {
    return sha256(readFileSync(full));
  } catch {
    return null;
  }
}

/** 扫描 vault 内所有百度云冲突副本。 */
export function scanConflicts(vaultRoot = loadConfig().vaultRoot) {
  const found = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(path.join(vaultRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(child);
        continue;
      }
      if (!e.isFile()) continue;
      const m = e.name.match(CONFLICT_RE);
      if (!m) continue;
      const [, base, host, stamp, ext] = m;
      const mainRel = rel ? `${rel}/${base}${ext}` : `${base}${ext}`;
      const mainFull = path.join(vaultRoot, mainRel);
      const mainExists = existsSync(mainFull);
      const copyStat = statSafe(path.join(vaultRoot, child));
      const mainStat = mainExists ? statSafe(mainFull) : null;
      const copyHash = digestSafe(path.join(vaultRoot, child));
      const mainHash = mainExists ? digestSafe(mainFull) : null;
      const sameContent = mainHash !== null && copyHash !== null && mainHash === copyHash;
      const newer = !mainStat || (copyStat?.mtimeMs ?? 0) > mainStat.mtimeMs;

      let recommendation;
      if (!mainExists) recommendation = "orphan-keep";
      else if (sameContent) recommendation = "delete-duplicate";
      else if (!newer) recommendation = "delete-older";
      else recommendation = "promote-to-main";

      found.push({
        path: child,
        mainPath: mainRel,
        mainExists,
        host,
        nameStamp: stamp,
        copy: { ...copyStat, hash: copyHash?.slice(0, 16) ?? null },
        main: mainStat ? { ...mainStat, hash: mainHash?.slice(0, 16) ?? null } : null,
        sameContent,
        newer,
        recommendation,
      });
    }
  };
  walk("");
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function summarizeConflicts(items) {
  const by = {};
  for (const item of items) by[item.recommendation] = (by[item.recommendation] ?? 0) + 1;
  return {
    total: items.length,
    byRecommendation: by,
    inNotesContent: items.filter((i) => !i.path.startsWith(".obsidian/")).length,
    inObsidianConfig: items.filter((i) => i.path.startsWith(".obsidian/")).length,
    bytesOfDeletable: items
      .filter((i) => i.recommendation.startsWith("delete-"))
      .reduce((n, i) => n + (i.copy.size ?? 0), 0),
  };
}

export function formatConflictReport(items) {
  const s = summarizeConflicts(items);
  const lines = [];
  lines.push(`冲突副本总数: ${s.total}`);
  lines.push(`  笔记正文目录: ${s.inNotesContent}    Obsidian 配置目录: ${s.inObsidianConfig}`);
  lines.push(`建议直接删除（重复或更旧）: ${(s.byRecommendation["delete-duplicate"] ?? 0) + (s.byRecommendation["delete-older"] ?? 0)}`);
  lines.push(`副本内容更新，应提升为主本: ${s.byRecommendation["promote-to-main"] ?? 0}`);
  lines.push(`主文件已不存在的孤儿副本: ${s.byRecommendation["orphan-keep"] ?? 0}`);
  lines.push(`可释放空间: ${(s.bytesOfDeletable / 1024).toFixed(1)} KB`);
  lines.push("");

  const needAttention = items.filter((i) =>
    i.recommendation === "promote-to-main" || i.recommendation === "orphan-keep");
  if (needAttention.length) {
    lines.push("需要你确认的（副本比主文件新，或主文件已不存在）:");
    for (const i of needAttention) {
      lines.push(`  ${i.recommendation.padEnd(16)} ${i.path}`);
      lines.push(`      主本 ${i.mainPath}  mtime=${i.main?.mtime ?? "不存在"}  副本 mtime=${i.copy.mtime}`);
    }
    lines.push("");
  }

  const deletable = items.filter((i) => i.recommendation.startsWith("delete-"));
  lines.push(`可直接删除的清单（前 15 条，共 ${deletable.length} 条）:`);
  for (const i of deletable.slice(0, 15)) {
    lines.push(`  ${i.recommendation.padEnd(17)} ${i.path}`);
  }
  if (deletable.length > 15) lines.push(`  ... 其余 ${deletable.length - 15} 条用 --json 查看完整清单`);
  return lines.join("\n");
}
