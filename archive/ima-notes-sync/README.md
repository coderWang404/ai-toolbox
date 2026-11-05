# ima 同步模块（已停用，2026-11-05 归档）

## 为什么归档

2026-11-05 上午起尝试把 Obsidian vault 与 ima 知识库做双向同步，当天下午放弃，原因是**可用性不够**：

1. **ima App 里改不了同步过去的笔记**。为了让内容逐字节保真，全链路用文件型条目（`media_type=1`），
   ima 对文件型条目只提供预览，没有编辑入口。等于「手机上只能看」。
2. **note 型虽然能编辑，但服务端会规范化 Markdown**（`-` → `*`、表头加粗、空行增删），
   555 字节原文回读成 750 字节。用它做主链路会导致每次往返都改写文件。
3. 两条通道混用还会让同一份笔记在 ima 里出现两条记录（note 型 + 文件型），无法收敛。
4. ima 没有删除 note 的接口，探针测试产生的条目只能手工清理。

结论：ima 适合当「只读导出目的地」，不适合当双向同步的一端。旧的三端 note-sync（自建 notesyncd）
已经能满足需求，重新启用即可。

## 里面的东西

| 文件 | 作用 |
| --- | --- |
| `src/` | 12 个模块：engine（路径镜像）、remote-store（OpenAPI/cgi 门面）、cgi（网页端接口）、daemon 等 |
| `test/` | 83 个用例（含 mock 远端、性能、稳定性） |
| `notes-sync.json` | 运行配置样例（**不含凭证**） |

未归档、已删除的运行时数据：`~/.ai-toolbox/notes-sync-state.json`（606 条映射）、
`~/.ai-toolbox/notes-sync-trash/`、`~/Library/Logs/notes-sync.log`。
凭证 `~/.config/ima/`（client_id / api_key / session.json）保留在原处，未删。

## 如果以后要捡回来

技术结论都在代码注释里，重点几条：

- OpenAPI（`openapi/note/v1`）没有删除/改名/建目录；cgi（`cgi-bin/knowledge_tab_{reader,writer}`）才有。
- `knowledge_base_id` 必须传 cgi 侧 ID（个人知识库 = userId，自建库 = 纯数字），
  传 OpenAPI 的 `ima_kb_xxx` 时所有接口都只回 `code 51 参数错误`。
- `file_manager/get_media` 下发签名下载地址（`jump_url`），能拿回原始字节（实测 sha256 一致）。
- `auth_login/refresh` 能续小票（2 小时）；响应不回新 refreshToken，大票（30 天）疑似服务端滑动续期。
- 小票过期后**所有** cgi 接口都返回 `600001 服务繁忙`，与真限频同码，极易误判。
- 列树按层并发 + 根目录 `version` 短路：71 目录 30s → 7s，稳态 1 次请求。

## 远端数据

知识库里的 606 个条目**没有删除**（个人知识库/笔记/），留着当只读副本。
如果要彻底清掉，用归档前的 `notes-remote --delete` 逻辑批量删，或直接在 ima App 里操作。
