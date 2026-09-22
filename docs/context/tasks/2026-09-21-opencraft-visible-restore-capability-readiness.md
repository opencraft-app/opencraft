## goal

让本地 DSH 会话在首屏历史恢复完成后立即结束全页 Restoring 状态，同时保持动态工具在执行前完成注册。

## non_goals

- 不缩短或取消 `thread/resume` 自身的协议 deadline。
- 不绕过动态工具 schema 校验、Host capability lease 或执行 admission。
- 不改变历史分页、持久化与 Conversation 身份。
- 不提交、推送、打包或发布。

## requirement_ids / requirement_refs / requirement_excerpt

- `USER-2026-09-21-DSH-RESTORE-LATENCY`：本地 DSH 模式下 Restoring conversation 偶尔停留很久。

## interface_refs / data_structure_refs

- `ThreadResumeCoordinatorService.resume`：`thread/resume` 与首屏历史 authority。
- `hydrateBinding`：Conversation 可见恢复与 Replica authoritative promotion。
- `runtime/capabilities/register`：Thread scoped 动态工具 capability lease。
- 不变量：读路径完成即可呈现；执行路径必须等待 capability readiness。

## history_context

- `current_design_refs`：`opencraft/docs/chat-ui-architecture.md`、`opencraft/docs/platform-connectors.md`。
- `relevant_evolution`：动态工具注册已支持 cold deferred，但当前仍串行占据 visible hydration critical path。
- `superseded_refs`：无。

## acceptance

- 人工悬挂 `runtime/capabilities/register` 时，`thread/resume` 历史仍能成为 authoritative 并退出 Restoring。
- 同一时刻发送消息不会越过未完成的 capability lease；注册完成后原提交继续。
- 注册失败不污染历史 authority，后续执行可以重试注册并就近失败。
- 原恢复、重连、动态工具和本地 Host 测试通过。

## affected_paths

- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- `opencraft/tests/chat-workbench-draft.test.ts`
- `opencraft/docs/chat-ui-architecture.md`
- `opencraft/design/invariants.md`

## required_context

- 根与 OpenCraft `AGENTS.md`
- `opencraft-maintenance`
- `opencraft/docs/chat-ui-architecture.md`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | 恢复 owner、异步代次和验收纪律 | 约束修复层级 |
| `opencraft/docs/chat-ui-architecture.md@working-tree` | Conversation/Replica/Host 边界 | 定义可见恢复与执行 readiness |
| `opencraft/packages/appserver-session/src/resume-coordinator.ts@working-tree` | Resume authority | 确认历史完成点 |
| `opencraft/packages/workbench-runtime/src/appserver-runtime.ts@working-tree` | visible hydration 与 capability 注册调用点 | 定位关键链路 |
| `opencraft/apps/local-agent-host/src/main.ts@working-tree` | DSH capability lease/admission | 保留执行前门禁 |

## evidence

- 新回归先失败：悬挂 `runtime/capabilities/register` 时 authoritative 等待超时，坐实它占据 visible hydration critical path。
- 实现后 `chat-workbench-draft` 新增慢注册与失败重试两例；聚焦恢复/capability 套件 30/30 通过。
- `npm run test:chat`：通过。
- `npm run test:dsh-bridge`：228/228 通过，包含真实 Local Host WebSocket 与 DSH history 投影。
- `tests/appserver-session.test.ts`：31/31 通过。
- Workbench Runtime/Web typecheck、平台边界检查、Electron 构建、文档校验与 `git diff --check`：通过。
- 最新隔离 Electron profile `/tmp/opencraft-restore-preview-Yg0t7W` 在 CDP 9462 启动完成，`document.readyState=complete`、Root 已挂载；空 profile 无真实历史，未将此启动证据冒充恢复性能实测。

## risks

- 若只把注册改成 fire-and-forget，用户可能在工具未挂载时发送；提交必须复用并等待同一 readiness Promise。
- 重连和 View 释放后旧注册结果不得影响新 generation；继续由 AppServer client generation/Host lease 校验收敛。

## validation

- `npx tsx --test tests/chat-workbench-draft.test.ts tests/chat-workbench-reconnect-policy.test.ts tests/dsh-capability-broker.test.ts`
- `npm run typecheck --workspace @opencraft/workbench-runtime`
- `npm run typecheck --workspace @opencraft/workbench-web`
- `npm run check:boundaries`
- 隔离 Electron/DSH：短会话恢复时确认历史先于 capability 慢路径可见。

## decisions

- Conversation authority 与 execution capability readiness 是两个状态，不共用一个 loading gate。
- capability 注册仍由 Thread binding 持有并共享单 flight；执行命令显式等待。

## scan_scope

- Resume Coordinator、Workbench binding hydration、Local Host capability broker、恢复与动态工具测试。

## scan_output

- Context Router 未匹配；记录查询 `OpenCraft local DSH restoring conversation loading history occasionally hangs` 后执行有界精确搜索。

## handoff

- 当前状态：实现、模型回归、Chat/DSH/Session 测试、类型/边界/构建与隔离 Electron 启动验收完成；最新预览窗口保持打开。
- 阻塞项：未在用户真实存量 DSH 会话和连接器目录上做付费/账号态实测；未提交、未推送、未打包 DMG。
