# Today 模块（vendored）

来源：本机逆向目录里的 `today-api-wrapper`（2026-10-31 版本），
接入 AI 工具箱时做了三件事：

1. `client.mjs` 增加可注入的 CDP/fetch/WebSocket 依赖、超时清理与 `content.text` 兼容；
2. `server.mjs` 拆出 `createTodayServer` / `startTodayServer`，加入本地 Bearer token、
   限制 CORS 到 localhost，并让测试可以注入假 client；
3. 由 `src/today-gateway.mjs` 统一提供状态、模型目录、对话测试、网关启动和调试端口启动。

运行时不需要 Today 的账号密码：Today.app 的 Electron 主进程会把短期 JWT 注入
`api.todayai.cn` 请求，模块只通过 CDP 在页面上下文里 fetch。
