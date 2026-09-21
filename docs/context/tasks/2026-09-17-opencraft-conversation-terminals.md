## goal
建设 OpenCraft 统一的会话级终端语义层，让应用按 Conversation Scope 管理终端集合、当前终端和有界输出快照，并让 DSH Agent 通过 `read_thread_terminal` 读取当前会话终端。

## non_goals
- 不改变 AppServer `process/*` 协议或 Host 对 PTY 的所有权。
- 不让 Agent 任意枚举或读取其他会话的终端。
- 不改变 xterm 字符网格、样式或终端命令执行权限。
- 不提交、推送、发布或操作用户真实终端。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户要求“建设统一会话级终端语义层”；上下文明确要求对齐 Codex 的 in-app terminal 会话目录与当前缓冲区读取能力。

## interface_refs / data_structure_refs
- `AppServerTerminalSession`：Host-owned PTY 的 Renderer 投影。
- `ConversationBindingStore`：`Host + Thread` 到 Conversation Scope 的唯一映射。
- `WorkbenchPanelService`：Terminal tab 激活状态的呈现权威。
- `item/tool/call` / `DynamicToolSpec`：DSH Agent 动态工具边界。
- 不变量：PTY 由 Host 持有；Conversation terminal directory 只持有语义关联和投影；Agent 只能读取调用 Thread 对应 Scope 的当前终端。

## history_context
- `current_design_refs`：`opencraft/docs/platform-architecture.md`、`opencraft/design/invariants.md`。
- `relevant_evolution`：现有 Registry 已能按 owner 保存 terminal session，AppServer controller 已保留可重放输出；缺少 active session、会话快照与 Agent-facing read projection。
- `superseded_refs`：`ref/codex` 固定版本仅用于核对状态模型和工具行为，不作为 OpenCraft 运行时真源。

## acceptance
- 同一 Conversation Scope 可拥有多个终端，并有稳定的 session 顺序与 active session。
- Panel 激活某个 Terminal tab 时更新会话当前终端；切到非 Terminal tab 不丢失最近当前终端。
- session 关闭后 active session 合理回退；Scope 释放后不再可读。
- `read_thread_terminal` 无参数，只能解析调用 `hostId + threadId` 对应 Scope，返回 cwd、shell、状态和最新有界输出。
- 未绑定 Thread、无终端、非法参数和 Host/Thread 隔离均有明确失败结果。
- 聚焦测试、相关 workspace typecheck、边界检查和变更影响检查通过。

## affected_paths
- `opencraft/packages/workbench-runtime/src/`
- `opencraft/plugins/terminal/src/`
- `opencraft/apps/workbench-web/src/runtime/`
- `opencraft/tests/workbench-terminal.test.ts`
- `opencraft/docs/platform-architecture.md`
- `opencraft/design/invariants.md`

## required_context
- mono2 根与 OpenCraft `AGENTS.md`。
- `opencraft-maintenance` Skill 与验证清单。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库 P0 与 Task Pack 要求 | 限定变更和验证边界 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft ownership/topology | 选择 Application/Host/Conversation 生命周期 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | OpenCraft 维护方法 | 先定 owner、生命周期和可证伪行为 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | 验证入口 | 选择 Terminal、Host、协议聚焦门禁 |
| `opencraft/docs/platform-architecture.md@working-tree` | 平台架构真源 | 对齐 Supervisor、Host resource 与 Conversation Scope |
| `opencraft/docs/plugin-architecture.md@working-tree` | 插件和能力边界 | 保持 Terminal UI 投影与 Agent capability 分层 |
| `opencraft/plugins/terminal/src/index.tsx@working-tree` | 当前终端 Registry/Panel | 提取语义层并保留现有几何改动 |
| `opencraft/packages/workbench-runtime/src/appserver-terminal.ts@working-tree` | 当前 PTY 投影 | 复用输出、状态与重连投影 |
| `ref/codex/terminal/broadcast-query-cache-invalidation-01744.ts@current-pin` | Codex 参考状态模型 | 核对 session 集合、active session 与有界 buffer |
| `ref/codex/conversations/resolve-thread-terminal-snapshot-03223.ts@current-pin` | Codex 工具参考 | 核对当前 Thread 的 read-only terminal snapshot 行为 |

## evidence
- 新增 Conversation terminal directory 聚焦测试 3/3 通过：有序集合/active/关闭回退、UTF-8 有界输出、Panel owner 与 resource owner 分离、Thread 隔离和无参数工具。
- 既有 Terminal 聚焦测试 8/8 通过，含真实 PTY 输入、resize、输出、退出、detach/reattach 与重连。
- Workbench unit 259/259、DSH bridge、AppServer 166/166 通过；三个受影响 workspace typecheck 与 platform boundaries 通过。
- `npm run build:web` 通过；只生成本地构建产物，未启动或替换用户窗口。
- 文档完整性无错误；显式变更集合的 `validate_change_impact.py` 通过并提示 `wisp/mono2-maintainers` owner review。

## risks
- Panel owner 与 Conversation resource owner 不同：session 自身保存 resource owner，激活同步以 session identity 回写对应 Conversation。
- 输出含 UTF-8/ANSI 且可能很大：按字节顺序一次解码，再截取最新有界字符；不读取 DOM。
- Host 重连和 Scope 销毁晚到事件：session subscription 随 Registry entry 释放，销毁后不发布。
- 现有终端几何改动未提交：只拆分/调用 Registry，不重写 xterm Panel 实现。

## validation
- `npx tsx --test tests/workbench-terminal.test.ts`
- `npm run typecheck --workspace @opencraft/workbench-runtime`
- `npm run typecheck --workspace @opencraft/plugin-terminal`
- `npm run typecheck --workspace @opencraft/workbench-web`
- `npm run check:boundaries`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`（若使用 staging 前；否则对本次路径做人工/聚焦检查）
- `git diff --check`

## decisions
- 采用 Conversation Scope 作为 Renderer application resource owner；Thread 只通过 Binding Store 解析到 Scope。
- Host `process/*` 继续拥有 PTY；统一语义层不复制第二套进程生命周期。
- Terminal Panel 是 active selection 的写入适配器，Agent tool 是只读消费者。
- Agent 工具只读取 active terminal，不暴露跨会话枚举接口。

## scan_scope
- OpenCraft terminal plugin、Workbench runtime、Panel state、Conversation binding、dynamic tool registration。
- 固定版本 Codex terminal session/read tool 实现。

## scan_output
- Context Router 无匹配 Pack；完成有界精确搜索。现有 adjacency 卡没有 Terminal/AppServer 对应边界，未扩展到无关卡片。

## handoff
- 状态模型、Panel 写入适配、DSH 动态工具装配、正式设计与聚焦/边界/构建验证均完成。
- 未提交、推送、发布；未在付费模型或用户真实终端中发起 Agent tool call。
