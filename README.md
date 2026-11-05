# AI 工具箱

本地 AI 小工具集合。核心能力是在不重启 Codex 应用的前提下，热切换 cc-switch 管理的第三方模型供应商；此外还包含 Claude Desktop 跟随、cc-switch 远程同步、Today / Grok Bot 本地网关、额度查询和网络测速。

## 包含的工具

| 页面 | 作用 |
| --- | --- |
| Codex | 供应商热切换、自动跟随、远程同步 |
| Claude Desktop | 跟随 cc-switch 的桌面供应商，切换后重新打开应用 |
| cc-switch | 以本机为真源，实时同步远程整库 |
| 智商测试 | 用统一题目横向比较各供应商模型 |
| OpenCode 额度 | OpenCode Go 多密钥三窗口额度，可把密钥写入本机应用 |
| ClinePass 额度 | ClinePass 多密钥三窗口额度和余额 |
| Grok Bot | 读取本机登录态，在本机启动 OpenAI 兼容网关 |
| 网络测速 | 出口信息、延迟、上下行测速 |
| Qoder 网络 | 本机 Qoder CN + 远程机器的 DNS/hosts、Clash、HTTPDNS 状态与管理 |
| Today | 独立模块：通过 CDP 使用 Today.app，导出 OpenAI 兼容网关 |
| 笔记同步 | 本机 Obsidian 知识库 ↔ ima 知识库，按路径镜像双向同步 |

- **桌面 App**：`AI 工具箱.app`（原生菜单栏/窗口应用，内置全部逻辑，双击即用）
- **命令行版**：`ai-toolbox` CLI（适合脚本/终端用户）

![界面](docs/screenshot.png)

> 截图来自旧版 6 页界面；当前侧栏已有 9 页，Today 等新页面尚未重新截图。

## 它解决什么问题

用 cc-switch 切换 Codex 供应商后，正在运行的 Codex 仍在使用旧供应商，必须重启才生效：

- **模型选择器**里还是旧供应商的模型列表（模型目录在 app-server 启动时就固定了）；
- **已经开着的对话**仍然把请求发往旧供应商；
- 只有"新建对话"会读到新配置，但模型选择器是过期的，体验割裂。

本工具在切换配置后，**只重启 Codex 的 app-server 子进程**（不是重启 ChatGPT 应用）。
ChatGPT 应用会自动拉起新的 app-server，从而一次性刷新：模型目录 + 所有对话 + 鉴权配置。

## 桌面 App（推荐）

```bash
# 构建（需要 macOS 命令行工具，已自带 swiftc）
./build-app.sh

# 运行
open "dist/AI 工具箱.app"

# 安装到应用程序目录（推荐，登录启动功能依赖标准路径）
cp -R "dist/AI 工具箱.app" /Applications/
```

界面说明：

| 区域 | 功能 |
| --- | --- |
| 当前供应商 | **以 `config.toml`（Codex 真正读取的文件）为准**显示正在使用的卡片、实际端点、key 尾号、token 校验 |
| 一致性提示 | 若某张卡片的配置内容被改成了别的端点（卡片名与实际不一致），或有多张卡片内容重复，会在底部明确提示 |
| 供应商列表 | **单击任意供应商即完成热切换**（当前项有蓝色圆点）；每行都显示该卡片的实际端点主机名 |
| ♻ 重新加载 Codex | 在 cc-switch 界面切换后点它，Codex 立即生效 |
| ⚡ 自动跟随 | 开启后，你在 cc-switch 里一切换，App 自动热重启 Codex |
| 重启范围 | 仅主 app-server / 含 computer-use 会话 / 全部 |
| ☑ 热重启后聚焦 ChatGPT | 聚焦会触发应用立即拉起新 app-server，切换即时生效 |
| ☐ 登录时启动 | 开机自动常驻，配合自动跟随最省心 |

> 关于菜单栏图标：macOS 菜单栏图标数量有限（尤其带刘海的机型），
> 当菜单栏没有空位时系统会隐藏新图标。此时 App 主窗口 + Dock 图标仍可正常使用。
> 想要菜单栏快捷入口，可以先退出一个不常用的菜单栏图标再启动本 App。

## 命令行版

要求：macOS 14+ + Node.js ≥ 22.5 + cc-switch + Codex。只有智商测试需要 `npm install`（`@mariozechner/pi-coding-agent`）；其余命令只用 Node 内置模块和系统自带的 `sqlite3`/`ps`/`ssh`。

```bash
# 方式一：直接跑
node bin/ai-toolbox.mjs list

# 方式二：注册全局命令
npm link

ai-toolbox list                    # 列出所有 codex 供应商（● = 当前）
ai-toolbox current                 # 查看当前供应商 + 实际生效配置 + 运行中的 app-server
ai-toolbox switch <名称或 ID>       # 切换供应商并热重启 Codex（核心命令）
ai-toolbox reload                  # 只热重启（在 cc-switch 界面切换后用这个）
ai-toolbox watch                   # 常驻监控：cc-switch 里一切换就自动热重启（推荐）
ai-toolbox sync-remote             # 把本机供应商同步到远程，并重启远程 app-server
ai-toolbox remote-status           # 查看远程正在使用的供应商和密钥尾号
ai-toolbox claude-list             # 列出 Claude Desktop 供应商
ai-toolbox iq-list                 # 列出可用于智商测试的供应商
ai-toolbox go-quota                # 查询 OpenCode Go 三窗口额度
ai-toolbox cline-quota             # 查询 ClinePass 三窗口额度和余额
ai-toolbox qoder-status            # Qoder 网络状态（DNS/hosts/Clash/HTTPDNS/日志）
ai-toolbox qoder-fix               # 修复 Qoder 网络（会请求管理员授权改 hosts）
ai-toolbox qoder-restore           # 还原 Qoder 网络修复
ai-toolbox qoder-remote-status     # 查看远程机器上的 Qoder 状态
ai-toolbox qoder-remote-action --host <别名> --action <动作>
ai-toolbox today-status            # Today.app 登录态、模型目录、本地网关状态
ai-toolbox today-models            # 列出 Today 账号可用模型
ai-toolbox today-chat "你好"        # 向 Today 发一条消息
ai-toolbox today-serve             # 启动 Today 的 OpenAI 兼容网关
ai-toolbox doctor                  # 环境自检
```

常用选项：

| 选项 | 说明 |
| --- | --- |
| `--scope chatgpt` | 默认。只重启 ChatGPT 应用的主 app-server |
| `--scope chatgpt-all` | 包含 computer-use 会话的 app-server |
| `--scope all` | 包含 Trae/Windsurf 等其它应用的 codex app-server |
| `--hard` | 跳过平滑退出，直接强制结束（界面会出现「Restart ChatGPT」恢复页，点一次即恢复） |
| `--drain <秒>` | SIGTERM 平滑等待时间，默认 8 秒 |
| `--no-reload` | 只写配置，不重启 Codex |
| `--dry-run` | 只展示将要写入的配置 / 将要重启的进程 |
| `--no-focus` | 热重启后不把 ChatGPT 窗口切到前台 |
| `--json` | 输出 JSON（桌面 App 与脚本调用） |

## 切换后会发生什么

1. `~/.codex/config.toml` 被原子写入（原文件自动备份为 `config.toml.bak_<时间戳>`）；
2. 若该供应商配置了模型目录，`~/.codex/cc-switch-model-catalog.json` 同步更新；
3. Codex 的 app-server 收到 SIGTERM，平滑退出（有任务在跑时最多等 `--drain` 秒，然后强制结束）；
4. **ChatGPT 应用无需重启**：聚焦/点击 ChatGPT 即触发应用自动拉起新 app-server，供应商立即生效；
5. 终端里的 `codex` CLI 会话不受影响，但它们需要**自行重启**才会生效（会提示数量）。

## 原理（为什么不用重启应用）

实测与源码确认的 Codex 行为：

- app-server 每次 `thread/start` 都会**重新读取** `config.toml`，所以新对话本来就能拿到新供应商；
- 但**模型目录（model/list）**和**已有对话的运行时配置**都在 app-server 启动时固定，无法在运行中刷新；
- 因此"换供应商"必须换 app-server 进程，而不是换配置文件；
- app-server 收到 SIGTERM 会**优雅退出（exit code 0）**，ChatGPT 应用检测到干净退出后不会报错，
  在下一次需要 app-server 时（激活窗口/点击对话）自动重新拉起它 —— 这就是"不重启应用"的关键；
- 本工具复刻了 cc-switch 写入 `config.toml` 的完整流程（通用配置合并 → bearer token 注入 →
  模型目录生成），并用一次性 app-server 实例校验后再切换，保证与 cc-switch 原生产物一致。

## 与 cc-switch 的协作方式（重要）

**推荐工作流：在 cc-switch 里切换供应商 + 本 App 开「自动跟随」。** 两边状态永远一致，不会出问题。

原因：cc-switch 有一个「离开某张卡片时，把当前 config.toml 回填进那张卡片」的机制。
如果外部工具（本工具/手工编辑）在 cc-switch 不知情的情况下改了 config.toml，
cc-switch 可能把这份配置回填到"它以为的当前卡片"，造成**卡片名与卡片内容错位**。

因此本工具加了保护：

| 场景 | 行为 |
| --- | --- |
| cc-switch 正在运行 + 命令行 `switch` | **默认拒绝**并提示改用 cc-switch 界面（要强制需 `--force`） |
| cc-switch 正在运行 + App 里点供应商行 | 弹窗提示，默认引导「打开 cc-switch」，可选强制切换 |
| 同步 cc-switch 状态失败 | 显式告警（不再静默） |
| 界面显示 | 始终展示「cc-switch 记录 vs 实际生效」，错位一眼可见 |

另外：用 `CODEX_HOME` 指定其它配置目录时，本工具不会写入 cc-switch 状态。

## 测试与构建

```bash
npm test                 # Node 单元 + CLI 集成测试（35 项）
npm run typecheck        # swiftc -typecheck
npm run build            # 构建 dist/AI 工具箱.app（macOS 14+）
```

> 本机网关安全：Grok Bot 和 Today 的 OpenAI 兼容网关默认要求
> `Authorization: Bearer <token>`，token 分别保存在
> `~/.ai-toolbox/grok-gateway-token`、`~/.ai-toolbox/today-gateway-token`（0600），
> App 页面里可以直接复制。设置 `GROKBOT_ALLOW_ANONYMOUS=1` 才会关闭 Grok 鉴权。

## Qoder 网络

Qoder 页把「Qoder CN 校园网 443 拦截」那套排查做成了可视化：

- Qoder 版本/运行状态、日志里的 `networkMode` / `httpdnsConfigured` / 最近模型请求
- `/etc/hosts` 是否固定到 `8.153.206.47`
- 系统 DNS 与 Clash DNS 的解析结果、是否 fake-IP
- Clash TUN、`use-system-hosts`、Qoder 直连规则及规则序号
- gateway / openapi 固定入口与系统 DNS 的实测 HTTP 状态和耗时
- 一键修复：写 hosts（系统管理员授权）、关闭 HTTPDNS 并安装 LaunchAgent、给 Clash 加直连规则、清理缓存、重启 Qoder
- 恢复默认：反向移除上述改动

对应命令：`qoder-status` / `qoder-fix` / `qoder-restore` / `qoder-httpdns on|off` / `qoder-restart` / `qoder-open`。

页面里的「本机详情」默认折叠；「远程 Qoder」默认折叠，第一次展开时才通过 SSH 检查，不会拖慢每次打开页面。

### Qoder 远程

远程机器通过 `~/.ai-toolbox/qoder-remotes.json` 配置，不把主机地址写进仓库：

```json
{
  "hosts": [
    { "host": "qoder-a100", "label": "A100", "proxy": "http://proxy-host:18443" },
    { "host": "qoder-4080", "label": "4080", "role": "proxy" }
  ]
}
```

`host` 是 `~/.ssh/config` 里的别名；`proxy` 是可选代理；`role: "proxy"` 表示这台机器自己跑 `qoder-proxy`。远程页会显示 SSH 延迟、Qoder 远程安装/包装数量、watcher、runtime、hosts、HTTPDNS、直连入口和代理入口，并可执行：

- 重新包装 `wrap`
- 重启 watcher
- 重启 worker
- 代理机器重启 `qoder-proxy`

远程操作只走 SSH 密钥（`BatchMode=yes`），不会在 App 里保存密码。

## Today 独立模块

Today 页是一个完全独立的模块：它不碰 Codex 配置，只通过 CDP 在 Today.app 的页面上下文里调用 `api.todayai.cn`，再把模型导出成 OpenAI 兼容网关。

前置条件：

- Today.app 已安装并登录；
- Today.app 带 `--remote-debugging-port=9222` 启动。App 里的「启动 Today（调试端口）」会退出并重开它；
- 不需要把 Today 的账号密码或 token 填进本工具。

```bash
ai-toolbox today-status             # CDP、当前模型、网关
ai-toolbox today-models             # DeepSeek / MiniMax / GLM 等
ai-toolbox today-chat "用一句话介绍自己"
ai-toolbox today-launch             # 以调试端口重启 Today.app
ai-toolbox today-serve --port 8317  # OpenAI 兼容网关
```

网关默认要求 `Authorization: Bearer <token>`，token 自动生成在 `~/.ai-toolbox/today-gateway-token`（0600），App 的 Today 页可以直接复制 Base URL / API Key。模型切换是 Today 账号的全局设置，切换后 Today App 里的选择也会变；Agent 调用会进入 Today 的主聊天。

## 笔记同步（ima）

把本机 vault（`~/baidusync/笔记`）和 ima 知识库里的同名文件夹做成**按路径镜像的双向同步**：本地新建、修改、删除都会同步过去，ima 侧被替换的条目也会拉回本地。常驻进程 10 秒一轮。

```bash
ai-toolbox notes-status                # 本地全库规模与已映射条目（只读、不联网）
ai-toolbox notes-sync --dry-run        # 预演一轮，看清会做什么
ai-toolbox notes-sync                  # 真跑一轮
ai-toolbox notes-remote                # 查看 ima 侧现状（--files N 列出文件）
ai-toolbox notes-daemon --once         # 只跑一轮常驻循环（--interval 秒）
```

配置在 `~/.ai-toolbox/notes-sync.json`：

```json
{
  "vaultRoot": "/Users/MacBook/baidusync/笔记",
  "knowledgeBaseName": "个人知识库",
  "knowledgeBaseId": "ima_kb_RoVtyqfL",
  "rootPath": "笔记"
}
```

`knowledgeBaseName` 是 cgi 侧的名字（个人知识库的 cgi ID 等于 userId），`knowledgeBaseId` 是 OpenAPI 侧的 `ima_kb_xxx`，两套 ID 不通用。`rootPath` 是 vault 根在知识库里对应的文件夹名。

### 为什么整条链路只用文件型条目

ima 有两条写通道，能力不一样：

- **OpenAPI**（`openapi/note|wiki/v1`）：能建笔记、读正文、传文件，但**没有删除、改名、建目录**。
- **cgi**（`cgi-bin/knowledge_tab_{reader,writer}`，网页端内部接口）：能列树、建目录、删条目、改名、原地替换，还能下发**带签名的下载地址**。

同步全部用**文件型条目**（`media_type=1`），因为：

- 下载回来逐字节保真（实测 606 个文件抽样 sha256 全一致，含 16MB 的 PDF）；
- note 型会被 ima 服务端规范化 Markdown（`-` → `*`、表头加粗、空行增删），555 字节的原文回读成 750 字节，做双向会无限改写。

代价是 ima App 里不能直接编辑条目正文——这与「手机只读 ima」的用法一致。

### 差异检测

不靠内容 hash 来回拉：每轮先问一次根目录的 `version`，没变就直接复用上一轮的整棵树（1 次请求）；变了才重新爬（71 个目录并发列举约 7 秒）。逐文件用「本地 sha256 / 远端 update_time + media_id / state 基线」三方比对，只有远端 update_time 变了才下载。

`update_time` 是唯一可靠的远端变化信号：`md5_sum` 与本地文件 md5 并不一致（大小相同、哈希不同），不能直接拿来比。

### 踩过的坑

- 小票（IMA-TOKEN）只有 **2 小时**，过期后**所有** cgi 接口都返回 `600001 服务繁忙`，和真限频同一个码。已用 `auth_login/refresh` 自动续期（`refreshToken` 有效期 30 天），续期结果写回 `~/.config/ima/session.json`。
- `knowledge_base_id` 必须传 cgi 侧 ID（个人知识库 = userId，自建库 = 纯数字）；传 OpenAPI 的 `ima_kb_xxx` 时每个接口都只回同一个 `code 51 参数错误`。
- 分页 `limit` 上限 20，首屏 `cursor` 必须传空串（传 `"0"` 会 `500011`）。
- `create_folder` 的 `folder_id` 必须是有效父目录 ID，根目录传知识库自己的 ID，传空串会 51。
- `replace_knowledge` 是真·原地替换（目录里仍只有一条），但 **media_id 会换成新的**，必须写回 state。
- `add_knowledge` 只回 `media_id`，没有 `update_time`；新建后要按父目录回查一次补基线，否则下一轮会把自己刚推的那份当成远端变化又拉回来。

### 常驻

`scripts/notes-daemon.sh` + `~/Library/LaunchAgents/com.coderwang404.notes-sync.plist`（`KeepAlive`，重启后自动拉起）。日志在 `~/Library/Logs/notes-sync.log`，只在有动作或错误时写行。

## 网络测速

默认调用 macOS 自带的 `/usr/bin/networkQuality -s -c`，并把测试绑定到当前物理网卡。
这样即使 Clash/Surge 的 TUN/fake-IP 把 `speed.cloudflare.com` 解析成 `198.18.x.x`，
测的也是物理线路，而不是代理出口（页面会显示“代理检测”和测速节点）。
旧版 Cloudflare 路径只作为 `networkQuality` 不可用时的兜底；旧版测速记录会自动隐藏。
一次测速约 30 秒。

## 兼容性说明

- **官方 OpenAI 供应商**（ChatGPT 登录态走 `auth.json`）：请用 cc-switch 界面切换，然后用 `reload`；
  本工具不代写官方登录态，避免破坏你的 ChatGPT 凭据。
- **终端 CLI（codex TUI）**：TUI 的运行中会话无法热刷新，重启该终端会话即可。
- cc-switch 升级后如果改变了配置写法，本工具会因校验失败而报错并保留备份，可用备份随时回滚。

## 远程同步

打开「自动跟随」和「远程同步」后，在 cc-switch 里切换供应商，本机会热重启，并把供应商、模型、端点和密钥同步到已启用的远程机器，同时重启那些机器上当前 SSH 账号的 Codex app-server。

机器在界面里添加，保存在本机 `~/.ai-toolbox/remotes.json`。登录走 `~/.ssh/config` 里的用户和密钥，不要把地址、账号或密码写进仓库。`src/remotes.json` 默认是空列表。

> cc-switch 整库同步是“以本机为真源”的镜像：远端数据库里本机没有的供应商、prompts 会被清掉。写入前会自动备份远端 `cc-switch.db`（0600），失败会回滚。

```json
{
  "disabled": [],
  "hosts": [
    { "label": "实验室 A", "host": "lab-a.example.com", "user": "me", "enabled": true }
  ]
}
```

同步只替换决定请求去向的字段。远程自己的项目路径、桌面设置和 MCP 保持不动。

## 数据目录

本地状态统一放在 `~/.ai-toolbox/`（远程机器、测速历史、密钥、测试结果、Today/Grok 网关 token）。CLI 的 JSON 默认只给密钥尾号；只有 App 在需要复制时显式传 `--with-secrets`。从旧名字升级时，首次启动会自动把 `~/.codex-hotswitch/` 整体搬过来，偏好设置也会迁移。

## 目录结构

```
bin/ai-toolbox.mjs        CLI 入口（--json 供 App 调用）
src/ccswitch-db.mjs       读取/同步 cc-switch SQLite
src/switcher.mjs          切换编排（生成配置 → 校验 → 写入 → 同步）
src/toml-edit.mjs         bearer token 注入 / catalog 字段管理
src/common-config.mjs     通用配置片段的合并与剥离
src/catalog.mjs           模型目录生成（移植自 cc-switch）
src/verify-client.mjs     一次性 app-server 校验
src/reloader.mjs          app-server 发现 + 平滑重启
src/watcher.mjs           watch 模式
src/remote-sync.mjs       远程供应商同步
src/qoder-network.mjs     Qoder 网络状态、修复与还原
src/today-gateway.mjs     Today 模块：状态、模型、对话、网关
src/today/                vendored Today CDP 客户端与 OpenAI 兼容服务
src/remotes.json          内置远程机器（默认空）
test/                     Node 单元与集成测试
docs/screenshot.png       界面演示图
src/templates/            cc-switch 的模型目录模板（vendored）
app/                      桌面 App（Swift / AppKit，含 TodayPane、QoderNetworkPane）
tools/make-icon.swift     图标生成
build-app.sh              一键构建 .app
dist/AI 工具箱.app         构建产物
```
