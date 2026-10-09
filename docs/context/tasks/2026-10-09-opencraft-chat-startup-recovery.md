## goal
让国内站 OpenCraft 对话模块加载失败时自动恢复一次，仍失败时给用户可操作的页面重载入口，同时保留会话连接重试语义。

## non_goals
- 不修改 OpenCraft Host 的 WebSocket 重连协议。
- 不发布生产站或修改 GitOps。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-09 对 Firefox 国内站登录后对话加载失败的反馈及本轮三点要求：自动恢复一次、失败后“重新加载对话”、模块加载与会话连接分离。

## interface_refs / data_structure_refs
- `frontend/src/lib/opencraft-embedded-resources.ts` 的模块 Promise 与 30 秒截止时间。
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx` 的 `opencraft-connection` 事件及 `reconnect()`；连接失败不得清空已挂载的输入草稿。
- `window.location.reload()` 保留当前 URL 中的 Bot 参数；`sessionStorage` 限制同一标签页自动刷新次数。

## history_context
- `current_design_refs`: `frontend/DESIGN.md` 的 Chat Initial Loading；当前嵌入加载器与相邻测试。
- `relevant_evolution`: 2026-10-09 Firefox 现场先出现动态模块加载错误及嵌入模块超时，强制刷新后恢复，普通刷新仍可进入对话。
- `superseded_refs`: 旧 `AgentChatPanel` 的连接 UI 不作为当前 OpenCraft 所有者。

## acceptance
- 模块加载失败最多自动整页刷新一次；第二次失败显示“对话加载失败”和“重新加载对话”。
- 启动失败按钮整页刷新并保留当前 Bot URL；真正的连接中断继续调用 `reconnect()` 且保留草稿。
- 聚焦测试、多语言检查、前端 `check`/`test`/`build` 及 OpenCraft 同步检查给出命令证据。

## affected_paths
- `frontend/src/lib/opencraft-embedded-resources.ts`
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`
- 相邻测试与 `frontend/src/i18n/generated/`。

## required_context
- `frontend-product-surface`, `service-frontend`, `site-environment-routing`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@1b9faf845` | 前端门禁和 OpenCraft 同步约束 | 确定验证命令 |
| `docs/context/project/services/frontend.md@1b9faf845` | 服务边界 | 限定宿主 UI 范围 |
| `docs/context/domains/site-environment-routing.md@1b9faf845` | 国内站交付面 | 不推断国际站或线上部署 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1b9faf845` | i18n 与测试邻居 | 追踪生成译文和组件测试 |
| `frontend/DESIGN.md@1b9faf845` | 对话加载和错误状态规范 | 沿用既有覆盖层 |
| `docs/context/tasks/TASK-TEMPLATE.md@1b9faf845` | Task Pack 结构 | 记录本次状态 |

## evidence
- Firefox 现场：动态模块加载失败和 `Embedded Workbench loading timed out`；强制刷新后恢复。
- 代码：原启动失败按钮与连接失败共用“重新连接”，模块失败只重建组件。
- `pnpm exec vitest run` 聚焦恢复测试 4/4 通过；`pnpm check` 通过（TypeScript 新增诊断 0）；`pnpm build` 通过。
- 完整 `pnpm test` 出现多个失败后卡住并中断，未取得全量通过结果。
- OpenCraft 同步检查报告 locale 生成副本漂移，需在前端真源提交后按仓库门禁同步。

## risks
- `sessionStorage` 不可用时禁用自动刷新，保留手动入口，避免循环。
- 浏览器资源持续不可用时刷新不能修复，第二次失败停止自动刷新。
- 用户已授权提交 MR；未授权合并、发布或生产写入。

## validation
- 聚焦 Vitest、`pnpm check`、`pnpm test`、`pnpm build`、`npm --prefix opencraft run check:mono2-agent-console`。

## decisions
- 模块加载失败才自动刷新；连接中断继续 `reconnect()`，因为整页刷新会丢失已输入草稿。
- 启动失败与尚未挂载画布的超长等待显示页面重载按钮；已挂载画布的连接异常显示连接重试按钮。

## scan_scope
- `frontend/src/lib/opencraft-embedded-*`、`frontend/src/pages/marketing/opencraft-embedded-workbench*` 及相邻测试、生成 locale。

## scan_output
- 有界 `rg` 命中及聚焦测试输出；不保存敏感浏览器网络记录。

## handoff
- 本地独立工作树已实现并完成聚焦验证；用户已授权提交和创建 MR。合并和发布未获授权。
