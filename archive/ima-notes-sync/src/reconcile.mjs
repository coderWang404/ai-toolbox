// 三方比对决策：本地 / ima 远端 / 上次同步时双方一致的基线。
// 纯函数，不碰文件与网络，全部分支用 node --test 覆盖。
// 决策逻辑移植自 note-sync 的 LWW，但改为「基线比对」而非单纯比 mtime：
// 两端都可写时，只有 mtime 无法区分「对方改了」和「我改了」。

export const Decision = Object.freeze({
  NOOP: "noop",
  PUSH: "push",
  PULL: "pull",
  CONFLICT: "conflict",
  CREATE_REMOTE: "create-remote",
  CREATE_LOCAL: "create-local",
  LOCAL_DELETED: "local-deleted",
  REMOTE_DELETED: "remote-deleted",
});

/**
 * @param {object} e
 * @param {boolean} e.localExists      本地 md 是否存在
 * @param {string|null} e.localHash    本地内容 hash
 * @param {boolean} e.remoteExists     ima 侧对应 note 是否存在
 * @param {string|null} e.remoteHash   从 ima 拉回正文算出的 hash
 * @param {string|null} e.baseHash     上次成功同步时双方一致的内容 hash；null = 从未同步
 * @param {boolean} e.hadRecord        state 里是否已有该路径的映射
 * @returns {string} Decision
 */
export function decide(e) {
  const { localExists, localHash, remoteExists, remoteHash, baseHash, hadRecord } = e;

  // 没有基线：不能靠时间戳猜谁赢，两边都有且内容不同一律判冲突。
  if (!hadRecord || baseHash == null) {
    if (localExists && remoteExists) {
      return localHash === remoteHash ? Decision.NOOP : Decision.CONFLICT;
    }
    if (localExists) return Decision.CREATE_REMOTE;
    if (remoteExists) return Decision.CREATE_LOCAL;
    return Decision.NOOP;
  }

  // 两端表示可能不同（例如 ima 只给纯文本、本地是完整 Markdown），
  // 因此各自保存自己的基线；未提供时退化为单一 baseHash，保持向后兼容。
  const baseLocal = e.baseLocalHash ?? baseHash;
  const baseRemote = e.baseRemoteHash ?? baseHash;
  const localChanged = localExists ? localHash !== baseLocal : true;
  const remoteChanged = remoteExists ? remoteHash !== baseRemote : true;

  if (!localExists && !remoteExists) return Decision.NOOP;

  // 一端消失且另一端也改过 → 不自动删，留冲突让人工判断。
  if (!localExists) {
    return remoteChanged ? Decision.CONFLICT : Decision.LOCAL_DELETED;
  }
  if (!remoteExists) {
    return localChanged ? Decision.CONFLICT : Decision.REMOTE_DELETED;
  }

  if (!localChanged && !remoteChanged) return Decision.NOOP;
  if (localChanged && !remoteChanged) return Decision.PUSH;
  if (!localChanged && remoteChanged) return Decision.PULL;
  // 两边都改过但收敛到同一内容：无需冲突，只需刷新基线。
  if (localHash === remoteHash) return Decision.NOOP;
  return Decision.CONFLICT;
}

/** 冲突副本命名沿用 note-sync 约定，避免百度云再套一层「冲突副本」。 */
export function conflictPathFor(relPath, date = new Date()) {
  const slash = relPath.lastIndexOf("/");
  const dir = slash >= 0 ? relPath.slice(0, slash + 1) : "";
  const name = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${dir}${stem} (note-conflict ${stamp})${ext}`;
}

/**
 * 冲突消解。默认 newest-wins：以两端时间戳较新者为准，直接覆盖，不生成任何冲突副本。
 * 时间戳相等时用 hash 字典序确定性决胜，避免每次同步结果抖动。
 * @returns {string} Decision.PUSH | Decision.PULL | "conflict-copy"
 */
export function resolveConflict({
  localMtimeMs, remoteModifyTimeMs, localHash, remoteHash,
  strategy = "newest-wins",
}) {
  if (strategy === "keep-both") return "conflict-copy";
  if (strategy === "local-wins") return Decision.PUSH;
  if (strategy === "remote-wins") return Decision.PULL;

  const l = Number(localMtimeMs ?? 0);
  const r = Number(remoteModifyTimeMs ?? 0);
  if (l > r) return Decision.PUSH;
  if (r > l) return Decision.PULL;
  return String(localHash ?? "") > String(remoteHash ?? "")
    ? Decision.PUSH
    : Decision.PULL;
}

/** 把决策汇总成人类可读的一轮报告。 */
export function summarize(decisions) {
  const counts = {};
  for (const d of decisions) counts[d] = (counts[d] ?? 0) + 1;
  return counts;
}
