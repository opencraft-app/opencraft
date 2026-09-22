## goal
让 DSH 会话中的 steer 在 Host 接纳后立即完成命令回执，并以权威 `queued -> steering -> user/message` 状态连续呈现，直到下一 step 真正消费。

## non_goals
- 不改变 DSH “在下一 step 边界消费 steer”的执行语义。
- 不用 steer 隐式取消当前 provider 请求、工具调用或整个 turn。
- 不提交、发布或覆盖 `/Applications/OpenCraft.app`。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户反馈：`steer 功能，在DSH引擎下，好像不是很及时`；确认根因为 OpenCraft 等待队列快照并丢弃 `placement: steering` 后，用户授权“整改”。

## interface_refs / data_structure_refs
- `session.prompt(mode: "steer")`：DSH 接纳直发 steer。
- `session.updateQueue(action: { kind: "steer" })`：DSH 将既有 queued occurrence 原子迁移到 next-step。
- `session/queue.items[].placement`：`queued | steering | context`；OpenCraft 只公开用户写入的前两种。
- `thread/queue/list`：保留现有 `data` 队列 ABI，并以可选 `steering` 扩展携带权威中途引导投影。
- 不变量：RPC accepted 不等于模型已经消费；steering 在匹配的 durable `user/message` 到达前持续可见且不重复。

## history_context
- `current_design_refs`：`opencraft/docs/platform-architecture.md`、`opencraft/docs/chat-ui-architecture.md`。
- `relevant_evolution`：Conversation Runtime 已有 direct steer optimistic/durable identity handoff，但 queued-message strict steer 尚未进入相同状态机。
- `superseded_refs`：无。

## acceptance
- `thread/queue/steer` 在 DSH `session.updateQueue` 返回 accepted 后立即返回，不等待后续 mux snapshot。
- queued item 点击 steer 后立即从 Queue 转为会话内 pending steering，命令未完成时也无空档。
- `session/queue` 的 `placement: steering` 可在刷新/重连后恢复，并在匹配 `user/message` 到达后无重复交接。
- 当前 step 仍按 DSH 原生边界完成；不宣称硬中断。

## affected_paths
- `opencraft/apps/local-agent-host/src/dsh-appserver-adapter.ts`
- `opencraft/packages/appserver-protocol/src/methods.ts`
- `opencraft/packages/chat-runtime/src/replica-conversation-runtime.ts`
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- `opencraft/tests/local-agent-host.test.ts`
- `opencraft/tests/chat-runtime.test.ts`
- `opencraft/docs/chat-ui-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- 根 `AGENTS.md`、`identity-access`（Context Router 的弱触发结果）、`opencraft/AGENTS.md`。
- `opencraft-maintenance` 与其验证清单。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/identity-access.md@2.0.0` | Router 因 `session` 弱命中 | 确认本任务不触及账户会话域 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft 局部边界 | 确认 Host/协议/Chat owner 与验证要求 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | OpenCraft 行为整改方法 | 约束状态所有权和真实运行时证据 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | 协议/Host 验证矩阵 | 选择 appserver、DSH bridge、chat 门禁 |
| `opencraft/docs/platform-architecture.md@working-tree` | Host/Runtime 所有权 | 保持 adapter 与 Conversation Runtime 分层 |
| `opencraft/docs/chat-ui-architecture.md@working-tree` | Chat/Composer 正式设计 | 定义 steering handoff 不变量 |
| `docs/engineering/domains/agent-gateway-runtime.md@working-tree` | change-impact 映射的正式领域文档 | 固化 DSH/AppServer steer 跨层边界 |

## evidence
- TDD red：held `session/queue` snapshot 时，旧 `thread/queue/steer` 与 live-turn `thread/queue/start` 均在 500ms 门限失败，实际悬挂到 5s timeout。
- TDD green：`tests/local-agent-host.test.ts` 9/9；accepted 回执不再等待 snapshot，后续 snapshot 同时包含空 queued data 与一个 steering projection。
- TDD red/green：strict queued steer 原先在 Host promise pending 时仍停留 Queue；整改后立即投影一个 active-Turn user row。权威 steering baseline、durable handoff 和去重用例通过。
- `tests/chat-runtime.test.ts` 33/33。
- `@opencraft/appserver-protocol`、`@opencraft/chat-runtime`、`@opencraft/workbench-runtime`、`@opencraft/local-agent-host` typecheck 全部通过。
- `npm run test:dsh-bridge`、`npm run test:chat`、`npm run test:appserver`、`npm run check:boundaries` 全部 exit 0。
- `git diff --check` 与 `validate_documentation.py --repo . --format json` 通过。
- `validate_change_impact.py` 对本次精确 changed-file 集合通过。

## risks
- 乱序 `session/queue` 与 `user/message` 造成重复气泡；以 client message identity 和目标 turn 去重。
- Host 不支持 `steering` 扩展；字段保持可选，现有 Codex AppServer 返回不受影响。
- 工作树已有大量用户改动；只在上述精确边界增量修改，不回退其他改动。

## validation
- `npx tsx --test tests/local-agent-host.test.ts`
- `npx tsx --test tests/chat-runtime.test.ts`
- 受影响 workspace typecheck。
- `npm run check:boundaries`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`（有 staged 变更时）。

## decisions
- 命令回执以 DSH unary accepted 为边界；mux snapshot 是异步权威状态同步，不是 RPC 完成屏障。
- `context` placement 仍不进入用户会话；只有 `steering` 进入 Conversation Runtime。
- 保留 DSH next-step 语义，不制造 step-only abort。

## scan_scope
- `opencraft/apps/local-agent-host/src/dsh-appserver-adapter.ts`
- `opencraft/packages/{appserver-protocol,chat-runtime,workbench-runtime}`
- 对应聚焦测试与 DSH 0.1.1-rc.2 已安装 runtime contract。

## scan_output
- 有界源码定位，无独立扫描产物。

## handoff
- 当前：源码、协议、Host、Conversation Runtime、Workbench 接线、正式设计与回归测试已完成。
- 未执行：未覆盖、终止或重启用户当前 `/Applications/OpenCraft.app`；未发送真实付费模型 steer。
- 后续：如需桌面验收，应从当前源码构建新产物并使用隔离 profile/会话，不复用用户正在运行的任务。
