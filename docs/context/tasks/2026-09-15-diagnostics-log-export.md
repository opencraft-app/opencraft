## goal
修复 Agent 诊断中心日志导出仅返回 Hermes 默认 50 行的问题，同时保持现有 Bot/Profile 隔离行为不变。

## non_goals
- 不调整 Bot/Profile 的选择、映射或隔离逻辑。
- 不修改 Hermes、CTL、网关或后端 API contract。
- 不扩展到 Hermes 轮转日志文件，也不改诊断中心信息架构和对外文档。
- 不合并 MR、发布或操作生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-request-2026-09-15`：用户要求“先修一下已知问题；Profile 隔离不用改”，并授权追加到 MR !4033。
- 实测证据：同一 Profile 下 `hermes ... logs --since 24h` 只命中 21 行，显式 `-n 1000` 命中 83 行，证明默认行数限制会截短导出。

## interface_refs / data_structure_refs
- `frontend/src/repositories/types.ts`：`BotRepository.execDebugCommandStream`；必须继续以当前 `botId` 解析实例作用域。
- `frontend/src/pages/marketing/agent-diagnostics-panel.tsx`：`buildLogsCommand`、`buildLogsExportCommand` 和 `AgentDiagnosticsPanel`。
- 不变量：Hermes 命令继续通过 `withHermesProfile(..., profileId)` 生成；主 Bot 的 `main` 仍只在 Hermes 边界转换为 `default`。

## history_context
- `current_design_refs`：`frontend/openspec/specs/marketing.md` 的“Agent 诊断中心”；`docs/context/domains/agent-gateway-runtime.md`。
- `relevant_evolution`：`06ac65836f` 曾移除 Hermes 不支持的 `--limit`；当前 Hermes 支持的参数是 `-n/--lines`，并已在实际两个 Bot 环境只读验证。`b13783d06c` 将查看和导出拆开，但导出未指定行数，仍继承默认 50 行。
- `superseded_refs`：旧 `openclaw-agent-diagnostics-panel` 文件名与 `--limit` 方案仅用于理解历史，不作为当前实现入口。

## acceptance
- 页面查看日志使用明确的 50 行预览命令。
- 导出使用明确的大行数命令，并从 SSE 分片组装下载内容，不被最终同步结果的 128 KiB 截断覆盖。
- named Profile 的命令包装和 shell quoting 保持不变。
- 聚焦测试、前端统一检查与仓库变更门禁通过。

## affected_paths
- `frontend/src/pages/marketing/agent-diagnostics-panel.tsx`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-panel.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`
- `docs/context/tasks/2026-09-15-diagnostics-log-export.md`

## required_context
- Pack：`agent-gateway-runtime`
- 邻接：`frontend-runtime-openspec-i18n`
- 服务规则：`frontend/AGENTS.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@4216ff1` | 仓库硬边界与 Task Pack 要求 | 约束变更、验证和交付范围 |
| `docs/context/domains/agent-gateway-runtime.md@4216ff1` | 路由命中流式行为 | 要求验证流式传输而非只看最终状态 |
| `frontend/AGENTS.md@4216ff1` | 最近服务规则 | 确定前端类型、测试和门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@4216ff1` | 前端历史改动邻接 | 检查 OpenSpec 与相邻测试 |
| `frontend/openspec/specs/marketing.md@4216ff1` | 当前诊断中心产品规格 | 保持入口和维护动作范围不变 |
| `frontend/vitest.config.ts@4216ff1` | 相邻测试配置 | 确定聚焦 Vitest 运行入口 |

## evidence
- MR 基线：`codex/main-bot-diagnostics-copy@c7b3e787703190046bf8184148f3ca38ddc39842`，目标 `master@4216ff19773c246d2f7a05fd93abfe9af70058cd`。
- 代码图查询确认调用链：`AgentDiagnosticsPanel -> buildLogsExportCommand / downloadDiagnosticLogs`，入口为 `agent-settings-page.tsx`。
- RED：聚焦测试在旧实现下 9 项中 6 项失败，分别覆盖预览/导出行数和流式输出收集。
- GREEN：诊断面板、多 Bot 边界与 HTTP repository 三个测试文件共 `85 passed / 1 skipped`，覆盖 Profile 命令、SSE transport callback 和超过 128 KiB 的导出收集。
- `pnpm check` 通过：i18n/文档/Fumadocs 检查通过，TypeScript `0 new diagnostics`。
- `validate_change_impact.py` 与 `validate_documentation.py` 通过；`git diff --check` 通过。
- 代码提交 `402de530cfd668c78495e7a845e347074c0472fa` 已推送到 MR !4033；推送后工蜂提交检查重新进入 `pending / blocking`。

## risks
- 导出数据可能大于同步执行结果上限：通过消费 SSE chunk 并优先使用已收集分片规避。
- SSE 无 stdout/stderr 分片但存在最终结果：回退使用最终 `output`。
- Hermes 当前活动日志之外的轮转文件仍不包含在本次导出：保持为明确非目标。
- 回滚方式：恢复三个前端实现/测试文件；不涉及数据迁移或后端状态。

## validation
- `corepack pnpm@10.23.0 exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/agent-diagnostics-panel.test.ts src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx src/repositories/__tests__/http-repositories.test.ts --api.host 127.0.0.1`：通过，`85 passed / 1 skipped`。
- `corepack pnpm@10.23.0 typecheck`：通过，`0 new diagnostics`。
- `corepack pnpm@10.23.0 check`：通过；当前 package 未定义独立 `lint` script，由统一 `check` 执行仓库现有前端门禁。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file ...`：通过，无映射设计文档命中。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过，0 errors / 0 warnings。
- `git diff --check`：通过。

## decisions
- 预览固定 50 行，避免页面查看产生不必要的大响应。
- 导出使用 `-n 100000` 覆盖当前活动日志的实用上限，并通过 SSE 分片保留超过 CTL 最终结果缓冲上限的内容。
- 不改 repository 的通用返回语义，避免影响其他流式命令消费者；只在诊断日志导出层优先使用本次回调收集的分片。

## scan_scope
- `frontend/src/pages/marketing/agent-diagnostics-panel.tsx`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/repositories/{types,http-repositories}.ts`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-panel.test.ts`
- `frontend/openspec/specs/marketing.md`

## scan_output
- 有界源码和 Git 历史摘要记录于本 Task Pack；未生成独立扫描文件。

## handoff
- 状态：实现、本地验证与 MR !4033 推送完成；工蜂提交检查运行中。
- 下一步：等待 CI 完成并由评审人审阅；不得把 pending 状态描述为 CI 通过。
- 阻塞项：无。
- 所需权限：本次 commit/push 授权已完成；合并和发布仍未授权。
