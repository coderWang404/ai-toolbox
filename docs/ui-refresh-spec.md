# 界面重做 spec：贴近 macOS 系统设置的风格

给执行这份 spec 的 agent：这是一次纯界面改造。所有功能、CLI 调用、数据流保持原样，只改 AppKit 视图层。

## 1. 目标

主窗口看起来要像 macOS Sonoma / Sequoia 的「系统设置」：

- 侧边栏是系统原生的半透明侧栏，顶到标题栏，红绿灯按钮浮在侧栏上方。
- 右侧内容是浅灰底上的白色圆角分组（inset grouped），每组一行一个设置，行之间用细分隔线。
- 字号、间距、控件尺寸都用系统默认值，少用自定义颜色，浅色和深色模式都要好看。
- 每一页都有清楚的层级：页面标题、分组标题、分组内容、分组下方的说明小字。

现状的主要问题（以 `智商测试` 页截图为例）：

- 侧栏没有和标题栏融为一体，标题栏是一条单独的灰条，写着「Codex – 智商测试」。
- 侧栏选中项是整块饱和蓝底加两行白字，比系统的选中样式重。
- 智商测试页控件行和状态文字之间有一大片空白，网页预览贴边、自带灰色滚动条、没有圆角。
- 弹出菜单、按钮都是默认灰色胶囊，排在一行里显得挤，没有分组承托。
- 各页的「当前供应商」大标题、状态文字、开关行排法不一致。

## 2. 不能动的东西

- `app/Backend.swift`、`app/Models.swift`、`bin/`、`src/` 不改。界面只调用已有方法。
- 所有 `@objc` 动作、`UserDefaults` 键（`mainPage`、`watchEnabled`、`watchClaudeEnabled`、`syncRemote`、`syncCcSwitch`、`scope`、`focusChatGPT`、`showNameInMenuBar`）、通知名保持不变。
- 页面编号保持不变：`0` Codex、`1` cc-switch、`2` Claude Desktop、`3` 智商测试。`selectPage(_:)` 的对外签名不变，`main.swift` 菜单栏还在用它。
- 菜单栏图标和菜单（`app/main.swift` 里的 `menuNeedsUpdate`）不在这次范围内，只在第 7 节列出的地方顺手对齐文案。
- 保留这几个已经踩过的坑的修复：
  - `SidebarRow.hitTest` 用 `convert(point, from: superview)`。如果换成原生侧栏就整个删掉 `SidebarRow`，但点击切页必须双向可用。
  - 不要放全高的 `NSBox` 分隔线且保留 required 的竖向 hugging，否则窗口会被压成标题栏高度（约 760×33）。
  - `window.isRestorable = false`。
- 不引入 SwiftUI，不加第三方依赖。继续用 `swiftc` 直接编译 `app/*.swift`，框架只能是 AppKit、CryptoKit、WebKit、ServiceManagement（`build-app.sh` 已经带上）。

## 3. 窗口骨架

把现在手工拼的「侧栏视图 + 分隔线 + 滚动区」换成系统侧栏：

1. 新建 `app/MainSplitController.swift`，里面是一个 `NSSplitViewController`：
   - 第一个 item 用 `NSSplitViewItem(sidebarWithViewController:)`，宽度 `minimumThickness = 200`、`maximumThickness = 260`、默认 220，`canCollapse = false`。
   - 第二个 item 用 `NSSplitViewItem(contentListWithViewController:)` 或普通 `viewController:`，内容是当前页。
2. 窗口：
   - `styleMask` 加 `.fullSizeContentView`。
   - `titlebarAppearsTransparent = true`，`titleVisibility = .hidden`。
   - 加一个空的 `NSToolbar`，`toolbarStyle = .unified`，这样红绿灯位置和系统设置一致。
   - 默认尺寸 880×640，`minSize` 760×520。
3. 侧栏用 `NSOutlineView`（`style = .sourceList`）或 `NSTableView`（`style = .sourceList`），单列，不显示表头：
   - 每行：18pt SF Symbol + 标题，13pt 常规字重。选中样式交给系统，不自己画蓝块。
   - 图标：Codex `arrow.left.arrow.right`，Claude Desktop `bubble.left.and.bubble.right`，cc-switch `arrow.triangle.2.circlepath`，智商测试 `brain.head.profile`。图标用 `.hierarchical` 渲染，按系统设置的做法给每项一个小的彩色圆角底（可选：`systemBlue`、`systemOrange`、`systemGreen`、`systemPurple`），底块 20×20、圆角 5。
   - 副标题（现在的 `setDetail` 文案，比如「hetucodex · gpt-6-sol」）改成 11pt 次要色，放在标题下方，行高 40。选中时副标题跟随系统选中文字色。
   - 行顺序：Codex、Claude Desktop、cc-switch、智商测试（和现在一致）。
4. 内容区顶部的页面标题放在内容视图里，不放在窗口标题栏：
   - 页面标题 22pt semibold，左对齐，距顶 52pt（让出透明标题栏的高度），左右边距 28pt。
   - 每页标题下面一行 12pt 次要色的一句话说明，例如「跟随 cc-switch 热切换 Codex 供应商」。

## 4. 设计约定

统一放进 `enum Chrome`（在现有位置扩写），全部用系统语义色：

| 用途 | 取值 |
| --- | --- |
| 内容区底色 | `NSColor.windowBackgroundColor`，深色模式自动适配。删掉现在手写的 `page` 灰 |
| 分组底色 | `NSColor.controlBackgroundColor`（浅色为白，深色为深灰）。删掉手写的 `card` |
| 分组圆角 | 10 |
| 分组描边 | 0.5pt `NSColor.separatorColor`，只在深色模式或分组和底色对比不足时画 |
| 分组内边距 | 行左右 14、上下 10；行最小高度 36 |
| 分组间距 | 22 |
| 分组标题 | 13pt semibold，`labelColor`，在分组上方 6pt |
| 分组脚注 | 11pt `secondaryLabelColor`，在分组下方 6pt，多行换行 |
| 行分隔线 | 从左内边距开始，到右边缘，`separatorColor` |
| 状态文字 | 12pt `secondaryLabelColor`，出错时 `systemRed`，成功时 `systemGreen` 的小圆点前缀 |

控件尺寸：

- 开关一律 `NSSwitch`，`controlSize = .small`，放在行的最右边。
- 按钮用 `.rounded` bezel，`controlSize = .regular`。主操作（「开始测试」「重新加载」「重新打开」）设为窗口 `defaultButtonCell` 或用 `bezelColor = .controlAccentColor`，每页最多一个主按钮。
- 弹出菜单用 `NSPopUpButton`，`controlSize = .regular`，放在分组行的右侧，宽度随内容但最小 180。
- 所有 emoji 状态前缀（✔ ❌ ⚡ ℹ️ ⚠️）改成 SF Symbol 小图标 + 文字，图标 11pt，颜色见上表。文案本身不变。

提炼这些共用构件（放在 `app/Components.swift`，新文件）：

- `GroupBox(rows: [NSView])`：白色圆角分组，自动加行分隔线。替换现有 `card(containing:)`、`groupedStack(_:)`、`addGrouped`、`separatorRow`。
- `SettingRow(title:, subtitle: String? = nil, accessory: NSView)`：左边标题（可带次要色副标题），右边控件。替换 `settingsLine`、`labeledSwitch`。
- `SectionView(title: String?, content: NSView, footer: String?)`：分组标题 + 分组 + 脚注。替换 `sectionBlock`。
- `StatusLine`：图标 + 文字，提供 `set(_ text: String, tone: .info/.success/.warning/.error)`。替换各页 `statusLabel`、`claudeStatusLabel`、`ccStatusLabel`、`iqStatusLabel` 的直接 `stringValue` 赋值。旧的 `setStatus(_:)`、`setClaudeStatus(_:)` 保留为薄包装，根据文案开头的 emoji 推断 tone，再去掉 emoji。
- `PageView(title:, subtitle:, sections: [NSView])`：页面标题 + 滚动容器。内容过长时整页滚动，滚动条 `.overlay`。

## 5. 各页布局

### 5.1 Codex（页 0）

从上到下：

1. 页面标题「Codex」，说明「跟随 cc-switch 热切换 Codex 供应商」。
2. 「当前供应商」分组，只有一行，比现在的 20pt 大字更克制：
   - 左边：供应商名 15pt semibold，下面一行 12pt 次要色「模型 · 实际端点 · key …尾号」。
   - 右边：「重新加载」按钮（次要样式）+ 进度转圈（`spinner`，平时隐藏）。
   - 一致性提示（现在 `updateHeader` 里拼出的「cc-switch 记录的是…」）放到这个分组的脚注里，用 warning tone。
3. 「供应商」分组：现有 `tableView` 放进 `GroupBox`，表格背景透明，行高 44：
   - 行左边一个 8pt 圆点：当前项 `systemGreen`，其他不显示。
   - 行文字：名称 13pt；下面一行 11pt 次要色「模型 · 主机 · 目录 N」。
   - 右侧「官方」改为小号圆角标签（10pt，`quaternaryLabelColor` 底）。
   - 当前行不要淡蓝底色块，改为圆点 + 名称 medium 字重。去掉 `ProviderRowView` 的手绘底色，悬停时给系统默认的浅色高亮。
   - 表格高度改为按行数自适应，最多 8 行高（约 352pt），超出在分组内部滚动。
4. 「自动跟随」分组，两行：
   - 「自动跟随 cc-switch」开关，副标题「cc-switch 里切换后自动热重启 Codex」。
   - 「远程同步」开关（现在的 `remoteSwitch`）。
5. 「远程机器」分组：现有 `remoteRows`，每行左边主机标签 + 次要色的状态文字，右边开关和删除按钮。删除按钮改为悬停才出现的 `minus.circle` 图标。分组下方放「添加机器…」链接按钮。
6. 「通用」分组：重启范围（弹出菜单）、热重启后聚焦 ChatGPT（开关）、登录时启动（开关）。
7. 页底 `StatusLine`。

### 5.2 Claude Desktop（页 2）

结构和 Codex 页对称：

1. 页面标题「Claude Desktop」，说明「跟随 cc-switch 的 Claude Desktop 供应商，切换后重新打开应用」。
2. 「当前供应商」分组：名称 + 「实际网关 · key …尾号」，右边「重新打开」按钮。当前供应商是代理模式时，副标题写「经 cc-switch 本机代理」。不一致提示放脚注。
3. 「供应商」分组：`claudeTableView`，行样式同 Codex 页。代理模式的供应商右侧加一个「代理」小标签，官方项加「官方」小标签。
4. 「自动跟随」分组一行：开关 + 副标题「切换后退出并重新打开 Claude Desktop，并置于最前」。
5. 页底 `StatusLine`。

### 5.3 cc-switch（页 1）

1. 页面标题「cc-switch 同步」，说明「以本机 cc-switch 为准，同步到远程机器」。
2. 「实时同步」分组一行：开关（`ccSyncSwitch`），右侧再放一个「立即检查」次要按钮（调用现有的检查动作）。
3. 「远程机器」分组：现有 `ccRows`。每行左边主机标签，右边状态胶囊：
   - 已一致：`systemGreen` 小圆点 + 「已与本机一致」。
   - 等待连接：`systemOrange` 圆点 + 「等待连接」。
   - 失败：`systemRed` 圆点 + 错误摘要，鼠标悬停显示完整错误（`toolTip`）。
4. 页底 `StatusLine`。

### 5.4 智商测试（页 3）

1. 页面标题「智商测试」，说明「用最小运行时让模型完成「SVG 鹈鹕骑自行车动画」，结束后在这里看效果」。
2. 「测试对象」分组，两行 + 一个操作行：
   - 「供应商」：右侧 `iqProviderPopup`。
   - 「模型」：右侧 `iqModelPopup`。
   - 分组下方右对齐主按钮「开始测试」。运行中按钮变成「测试中…」并禁用，旁边显示转圈。
3. 「结果」分组：
   - 顶部一行元信息：「供应商 / 模型 · N 轮 · 用时 · SVG 和动画都有」，用小标签分开，检查结果用绿色或橙色圆点。
   - 下面是 `iqWeb` 预览：放在圆角 10、`separatorColor` 0.5pt 描边的容器里，宽度填满分组，高度 = 宽度 × 0.75，最小 360。去掉 WebView 自己的背景，预览内部滚动条隐藏。
   - 预览右上角两个无边框图标按钮：`safari`「在浏览器打开」（`NSWorkspace.shared.open` 打开 HTML 文件），`folder`「在访达中显示」（`activateFileViewerSelecting`）。这两个是新增的纯界面动作，只用 `result.htmlPath`。
   - 没有结果时显示空状态：居中 SF Symbol `hare` 40pt + 「选择模型后点「开始测试」」。
4. 删除控件行和状态文字之间的大片空白：检查是 `iqPane` 在 `stack` 里被拉伸，给 `iqWeb` 定高后让 `PageView` 顶部对齐即可。
5. 页底 `StatusLine` 用来显示错误（比如「模型没有写出文件也没有说明」）。

## 6. 动效和细节

- 切页时内容区做 0.15s 淡入（`NSAnimationContext` 改 `alphaValue`），不要做滑动。
- 忙碌状态（`setBusy`）时，只禁用当前页的主按钮和表格，不要把整个窗口变灰。
- 所有文字字段 `isSelectable = false`，除了错误信息允许选中复制。
- 表格行、侧栏行都支持键盘上下移动，回车触发现有的 `rowClicked` / `claudeRowClicked`。
- 深色模式：逐页截图检查，分组和底色必须有可见差别，文字对比度不低于系统默认。
- 窗口缩放到最小尺寸时，不出现文字截断成「…」的分组标题，不出现横向滚动条。

## 7. 文案对齐

- 窗口不再显示「Codex – xxx」标题。`window.title` 保留为「AI 工具箱」（给窗口菜单和 Mission Control 用），`titleVisibility = .hidden`。
- 删掉 `showPage` 里设置 `window.subtitle` 的代码。
- 侧栏副标题保持现有逻辑（`codexSidebarDetail`、`claudeSidebarDetail`、`ccSidebarDetail`），智商测试的副标题改为最近一次测试的「模型名」，没有记录时显示「鹈鹕骑车」。

## 8. 代码组织

- `MainWindowController.swift` 现在约 1900 行。拆成：
  - `MainWindowController.swift`：窗口、split controller 装配、`show`、`selectPage`、`refresh` 入口、对外方法（`setWatchState`、`setClaudeWatchState`、`setRemoteSyncEnabled`、`setCcSyncEnabled`、`checkCcSwitchFromMenu`、`barHostLines`、`autoReloadAfterChange`、`autoReloadClaude`、`refreshClaude`、`setStatus` 等 `main.swift` 用到的都保留在这个类上）。
  - `Pages/CodexPage.swift`、`Pages/ClaudePage.swift`、`Pages/CcSwitchPage.swift`、`Pages/IqPage.swift`：每页一个 `NSViewController`，页面内部的构建和刷新逻辑搬过去。
  - `Components.swift`：第 4 节的共用构件。
  - `Sidebar.swift`：侧栏数据源和行视图。
- `build-app.sh` 用的是 `"$SRC_DIR/app/"*.swift`，子目录不会被编译进去。要么把新文件都放在 `app/` 根目录（文件名加前缀如 `PageCodex.swift`），要么把这一行改成 `$(find "$SRC_DIR/app" -name '*.swift')`。二选一，写清楚。
- 移动代码时先搬再改，每搬完一页编译一次，避免一次性大改后排错。

## 9. 验收

每一条都要有证据（截图或命令输出），不能只凭代码判断：

1. `./build-app.sh` 无警告编译通过，`swiftc -typecheck` 通过。
2. 启动 `dist/AI 工具箱.app`，四个页面在浅色、深色模式各截一张图（用 `screencapture -l <windowId>`），共 8 张，放在 `docs/screenshots/`。
3. 侧栏点击：从每一页都能点到其他三页，截图或 `System Events` 读取窗口里当前页标题证明。键盘上下键也能切。
4. 功能回归，每项手动点一遍并记录结果：
   - Codex 页点一个供应商（cc-switch 运行时会弹出原有的提示框）。
   - Codex 页「重新加载」。
   - 自动跟随开关打开 / 关闭，菜单栏菜单里的勾同步变化。
   - Claude Desktop 页「重新打开」。
   - cc-switch 页「立即检查」，远程机器状态正常显示。
   - 智商测试页：进入后自动显示上一次结果（`~/.ai-toolbox/iq-last.json`），「在浏览器打开」「在访达中显示」可用。不要求重新跑一次模型测试。
5. 窗口缩到最小尺寸截一张图，没有重叠、截断和横向滚动。
6. 退出再打开，停在上次的页面（`mainPage`）。
7. `git diff --stat` 里 `app/Backend.swift`、`app/Models.swift`、`bin/`、`src/` 没有变化。
