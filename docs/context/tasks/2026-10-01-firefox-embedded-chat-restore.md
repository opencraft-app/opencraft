## goal
Prevent the domestic embedded Chat from opening a conversation belonging to an unrelated prior Host after login.

## non_goals
- Change Hermes session storage or recover a genuinely deleted conversation.
- Deploy, publish, or change a production instance.

## requirement_ids / requirement_refs / requirement_excerpt
- User report, 2026-10-01: Firefox login reaches `/agents/chat` and displays “无法恢复此会话”.

## interface_refs / data_structure_refs
- `activeThreadStorageKey(hostId)` and the legacy `vela.active-thread-id` preference.
- Embedded Host identity includes instance and Profile; `thread/resume` receives a Thread ID owned by that Host.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md` Embedded Workbench Shell; `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: current startup reads a Host-scoped preference, then falls back to a global legacy ID. The embedded app uses configured ephemeral Host profiles and memory navigation.
- `superseded_refs`: none.

## acceptance
- A configured embedded Host with no Host-scoped selection starts a Draft even if a global legacy Thread ID exists.
- A Host-scoped selection still restores its own Thread; the ordinary Workbench keeps legacy fallback compatibility.
- Run focused tests, affected typecheck/build gates, and context impact validation.

## affected_paths
- `opencraft/apps/workbench-web/src/runtime/`
- `opencraft/tests/`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `frontend-product-surface`, `service-frontend`, `site-environment-routing`, `agent-gateway-runtime`, `upstream-subtrees`, `service-opencraft`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 嵌入宿主边界 | 确认前端门禁与验证要求 |
| `docs/context/project/services/frontend.md` | 服务路由 | 定位宿主与 OpenCraft 边界 |
| `docs/context/domains/site-environment-routing.md` | 国内站范围 | 限定站点结论 |
| `docs/context/domains/agent-gateway-runtime.md` | Chat/Host 恢复 | 确认执行权与传输验证 |
| `docs/context/project/upstream-subtrees.md` | OpenCraft 源码归属 | 只改 mono2 真源 |
| `docs/context/project/services/opencraft.md` | 服务路由 | 确认 OpenCraft 验证要求 |
| `opencraft/AGENTS.md` | 服务硬规则 | 遵守当前客户端与源码证据分层 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接 | 核对 OpenSpec 和邻近测试 |
| `opencraft/docs/platform-architecture.md` | 当前设计 | 保留嵌入 Host 与 Profile 身份 |
| `opencraft/docs/chat-ui-architecture.md` | 恢复语义 | 不把连接与 Thread 恢复混同 |
| `docs/engineering/domains/agent-gateway-runtime.md` | 正式设计 | 更新活动会话启动规则 |

## evidence
- Firefox 当前页：初始 `thread/resume` 返回 Hermes `4007 session not found`；点选侧栏已有会话后历史正常显示，刷新后仍正常恢复。
- `config/read` 与 `connectors/managed/list` 另报 unsupported；不把它们当作本次恢复失败的原因。

## risks
- 普通 Workbench 可能仍需迁移旧全局会话 ID，保留其回退路径。
- 真正缺失的 Host-scoped Thread 仍会显示恢复错误，避免掩盖数据问题。

## validation
- `npx tsx --test tests/workbench-web-host-definitions.test.ts tests/embedded-connection-recovery.test.ts tests/chat-workbench-reconnect-policy.test.ts`：25/25 通过。
- `npm run typecheck --workspace @opencraft/workbench-web`：通过。
- `npm run build:embedded-workbench:release`：通过，存在原有动态导入和大 chunk 提示。
- `npm run check:boundaries`：通过。
- `git diff --check`：通过。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：通过，匹配 `agent-gateway-runtime`。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过，首方链接无损坏。

## decisions
- 嵌入式 configured Host 不读取全局 legacy Thread ID；Host-scoped 记忆继续生效。

## scan_scope
- `frontend/src/pages/marketing/`, `opencraft/apps/workbench-web/src/`, `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/`.

## scan_output
- 有界符号搜索结果在本轮工具输出中；不保存原始网络或会话凭据。

## handoff
- 已在隔离 worktree 实现 Host-scoped 启动选择，保留独立 Workbench 的旧偏好兼容回退；尚未提交、推送、部署。
- Firefox 生产页仅验证了切换侧栏已有会话并刷新可恢复；新源码未部署，故没有生产回归结论。
