## goal
手机页面休眠、断网或重连时，后台 Host 与已接纳的 Turn 继续运行；恢复页面不自动把浏览器标签状态作为用户消息上下文提交。

## non_goals
- 不改变显式 Stop、Turn interrupt 和服务进程关闭语义。
- 不实现跨服务进程重启的 Turn 存活或离线时由客户端执行浏览器工具。
- 不把单用户直连部署改造为多租户鉴权 Hub。
- 不提交或推送源码。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-25-mobile-reconnect`：手机锁屏、页面休眠后重连，后台应持续工作，不应看到浏览器状态注入。
- `user-2026-09-25-ownership`：按所有权建模修复。

## interface_refs / data_structure_refs
- `opencraft/packages/app-host-server/src/index.ts`：Renderer claim 与物理 Host transport 的生命周期。
- `opencraft/apps/opencraft-daemon/src/main.ts`、`opencraft/scripts/headless-server.mjs`：进程级 Host owner。
- `opencraft/apps/workbench-web/src/app.tsx`：Composer SubmitIntent 附加浏览器状态的入口。
- `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`：Codex 待处理 Server request 的 Thread 归属、断线撤销与重连投递。
- `opencraft/docs/execution-ownership.md`：Turn 与 View/Client attachment 的独立寿命。

## history_context
- `current_design_refs`：`opencraft/docs/execution-ownership.md`、`opencraft/docs/platform-architecture.md`、`opencraft/docs/opencraft-browser-use-reference.md`。
- `relevant_evolution`：当前 AppHostServer 在最后一个页面 claim 离开时关闭物理 transport；Browser ambient context 在每次普通提交时添加。
- `superseded_refs`：无。

## acceptance
- 浏览器连接离开只撤销自身 logical client 与租约；进程级 Host 保持活动，服务关闭才释放物理 transport。
- 断线期间物理 Host 可以完成 Turn；重连 Client 复用同一 Host generation 并重新读取 Thread。
- 普通提交与恢复不自动附加浏览器标签状态；浏览器工具仍能按需列出和操作标签。
- Codex 待答复请求在 logical Client 断线后保留；旧连接不能答复，也不发给任意在线 Client；新的 Client 成功恢复 Thread 后收到原始请求，迟到的旧恢复回执不抢回所有权。
- 聚焦测试、相关 workspace 类型检查、平台边界与发布包 smoke 通过；运行预览确认新 buildId。

## affected_paths
- `opencraft/packages/app-host-server/src/index.ts`
- `opencraft/apps/opencraft-daemon/src/main.ts`
- `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`
- `opencraft/scripts/headless-server.mjs`
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/apps/workbench-web/src/browser/browser-ambient-context.ts`
- `opencraft/tests/app-host.test.ts`
- `opencraft/tests/codex-engine-adapter.test.ts`
- `opencraft/tests/fixtures/fake-codex-stdio-appserver.mjs`
- `opencraft/tests/workbench-browser-ambient-context.test.ts`
- `opencraft/tests/headless-server.test.mjs`
- `opencraft/docs/execution-ownership.md`
- `opencraft/docs/platform-architecture.md`
- `opencraft/docs/opencraft-browser-use-reference.md`

## required_context
- Context Router 查询 `opencraft mobile browser reconnect apphost host execution ownership background turn ambient browser context` 未匹配 Pack；之后有界读取上述权威文件。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库行为与验证边界 | 约束 Task Pack、发布和门禁 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft 所有权规范 | 区分 Renderer、Client、Host 与 Turn |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | 维护方法 | 先定对象寿命与证伪用例 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | 验证矩阵 | 选择断线、重连和晚到帧测试 |
| `opencraft/docs/execution-ownership.md@working-tree` | 正式执行所有权 | Host 持有进程、Turn 执行权不随 View 消失 |
| `opencraft/docs/platform-architecture.md@working-tree` | 现有直连拓扑 | 保持 logical client 隔离 |
| `opencraft/docs/opencraft-browser-use-reference.md@working-tree` | 旧 ambient 语义 | 按用户新要求更新自动注入策略 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 前端邻接卡 | 核对相邻测试和构建入口 |

## evidence
- 源码确认 `removeConnection()`、`disconnectClaim()` 在最后一个 claim 离开时调用 `stopSlot()`；Codex adapter 关闭会终止子进程。
- `2026-09-25 08:09:01 +08:00` 的现场中断与服务部署重启重叠，不能单凭这一例断言页面断线致因。
- 源码确认 `withBrowserAmbientContext()` 在普通提交附加全部标签，并以 `visible: true` 进入 AppServer `additionalContext`。
- 本会话再次复现：2026-09-25 08:26:11 +08:00 旧服务记录 `client-disconnect`，08:26:12 同一 Codex AppServer PID `1794999` `appserver-exit` 且 `intentional:true`，08:26:21 重连拉起 PID `1804244`；这段没有 `turn-interrupt` 日志。该序列与最后 claim 关闭物理 Host 的源码路径一致。
- `tests/app-host.test.ts`：9/9 通过，覆盖最后页面断开、无人在线时 Turn 完成、重连同一 generation、显式 lease 释放及服务关闭释放。
- `npm run test:headless-server`：15/15 通过，真实 headless WebSocket 网关重连后复用物理 transport。
- Browser tool 聚焦测试、AppHostServer/Workbench Web/Daemon typecheck、`check:boundaries`、`git diff --check` 通过；文档校验无错误。
- Linux headless 包 smoke 通过：buildId `20260925002406-2b4d4040331e`；SHA-256 `53c9ea3eaf58e6d0ab956111c6d6b35320fe969239dd5dc98bb7c990a90cbcf8`。打包 Web 资源中不含旧自动注入的固定状态块标记。
- 新包已独立暂存到 `/opt/opencraft-server/releases/53c9ea3eaf58e6d0`，暂存校验 `STAGED_OK`；切换前现服务仍为 release `63b1e70db2b2c2ca` 且健康。
- 首轮所有权修复已上线，现服务 release 为 `53c9ea3eaf58e6d0`；后续审查发现 Codex adapter 原本在断线时删除 server request 路由，且无订阅者时回退到任意初始化 Client。
- 本轮补齐 Codex adapter 的有界待答复路由表：保留原始请求帧与 Thread ID，断线只撤销答复权；成功 `thread/resume` 认领无主请求；独立 `serverRequest/resolved` 删除路由；有 Thread 身份但无订阅者的通知不再广播。
- Codex adapter 聚焦测试 4/4、AppHost + Codex 13/13、headless 15/15 通过；Daemon typecheck、`check:boundaries` 与 `git diff --check` 通过。
- 对 `thread/resume` 回执增加 Thread ID 一致性检查，异常回执不能认领交互；再次通过 Codex 聚焦测试 4/4、Daemon typecheck 与 `git diff --check`。
- 最终 Linux headless 包 smoke 通过：buildId `20260925010234-cf363a381056`；SHA-256 `00dabc60f1901b13bfeb855ab6719d8b4469fe7bcdc13f6958e5fcdecdfe4f1d`。已独立暂存至 `/opt/opencraft-server/releases/00dabc60f1901b13` 且 `STAGED_OK`；切换前现服务 `/opt/opencraft-server/releases/53c9ea3eaf58e6d0` 健康。

## risks
- 离线期间需要 Renderer 回答的 approval/browser tool 可能等待客户端重连；本次只保证引擎进程和 Turn 不因页面连接消失而被关闭。
- 待答复路由表只在同一物理 Host generation 内存活，最多保留 256 个请求；物理进程重启不是本次保证范围。
- 进程级 Host 在无页面 claim 时继续占用资源；当前 daemon/headless 的本地 Host 集合有界，服务关闭时统一释放。

## validation
- `tests/app-host.test.ts`、`tests/headless-server.test.mjs`、`tests/workbench-browser-ambient-context.test.ts`。
- `tests/codex-engine-adapter.test.ts`：断线、无主请求、错误客户端答复、成功恢复与迟到恢复回执。
- 受影响 workspace TypeScript 检查、`npm run check:boundaries`、`git diff --check`。
- Linux headless 包构建、smoke、部署后 health/buildId 核验。

## decisions
- Renderer claim 只拥有路由与订阅；Daemon/headless 服务拥有物理 Host transport；Codex AppServer 拥有已接纳 Turn 的执行。
- Codex AppServer 拥有待处理交互真相；Host adapter 只持有同物理 generation 内的投递路由，logical Client lease 持有当前答复权。
- AppHostServer 默认维持现有最后 claim 释放行为；进程级入口显式选择 server lifetime。
- 普通提交不自动携带浏览器标签状态；模型需要标签时使用 Browser tool 查询。

## scan_scope
- `opencraft/packages/app-host-server`、`opencraft/apps/opencraft-daemon`、`opencraft/scripts/headless-server.mjs`、`opencraft/apps/workbench-web/src/browser`、对应聚焦测试。

## scan_output
- Context Router 无匹配；有界符号检索定位物理 Host close 与自动 ambient context 提交入口。

## handoff
- 首轮 release `53c9ea3eaf58e6d0` 已切换且健康；后续 Codex 待答复交互路由修复已落源码，通过聚焦验证，新包完成构建、smoke 和独立暂存；切换与运行态核验待完成。
