---
id: 2026-10-01-ai-companion-status-copy
type: task
scope: AI 伙伴连接失败提示文案与翻译同步。
triggers: ["AI 伙伴状态", "连接失败提示", "重试文案"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/opencraft-embedded-workbench.tsx
status: active
reviewed_at: 2026-10-01
review_due: 2026-10-08
revision: 1.0.0
precedence: task
derived: false
---

## goal
将嵌入式聊天连接失败提示“请检查 AI 伙伴配置后重试”改为“请检查 AI 伙伴状态后重试”，并保持双站翻译与 OpenCraft 生成副本一致。

## non_goals
- 不改变连接失败判定、重连行为或发布状态。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-01 截图反馈：将指定提示改为“请检查 AI 伙伴状态后重试”。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx` 的 `intervention:configuration-required` 提示。
- `frontend/src/i18n/generated/` 为中文源文案生成的各语种字典；OpenCraft 通过同步脚本复制。

## history_context
- `current_design_refs`: `frontend/AGENTS.md`、`opencraft/AGENTS.md`、`opencraft/MONO2_MIGRATION.md`。
- `relevant_evolution`: OpenCraft Agent Console 从 `frontend/src` 机械同步；不得手改其 upstream 副本。
- `superseded_refs`: 无。

## acceptance
- 中文页面及测试使用新文案；各目标语言翻译不为空。
- 前端 i18n、相关组件测试与 OpenCraft 同步检查通过。

## affected_paths
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx` 与相邻测试。
- `frontend/src/i18n/generated/`、`opencraft/plugins/lightvela-hermes/src/upstream/mono2/`、`opencraft/scripts/smoke-console-embedded.mjs`。

## required_context
- `frontend-product-surface`；`docs/context/project/services/frontend.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@HEAD` | Context Router must_read | 前端 i18n 与服务验证边界 |
| `frontend/AGENTS.md@HEAD` | 最近服务规则 | 真源与校验命令 |
| `opencraft/AGENTS.md@HEAD` | 生成副本边界 | 禁止手改 upstream，要求同步 |
| `opencraft/MONO2_MIGRATION.md@HEAD` | 同步机制 | 确定生成入口和漂移检查 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 邻接卡 | 检查生成脚本与测试邻居 |

## evidence
- 精确搜索定位一处前端源码、两处组件断言、两处 OpenCraft smoke 断言和生成字典。
- `pnpm i18n:extract` 生成新 key；`pnpm i18n:zh-hant` 生成繁体，其他语种翻译已补齐。
- `npm run sync:mono2-agent-console` 同步 130 个受管文件，`check:mono2-agent-console` 通过。
- 前端聚焦组件测试 14/14、`pnpm check`、`pnpm build` 通过；OpenCraft 插件类型检查、i18n 检查及 10 项测试通过。
- `pnpm test` 总门禁出现多项无关测试失败及 Vitest worker 内存溢出；单独复现侧栏静态断言失败，期望的布局类名与当前源码不符。
- Context 单测总门禁有 4 项失败，输出指向仓库中既有 Task Pack 元数据与字段缺失；本 Task Pack 和 checkpoint 已按当前校验要求补齐，定向校验不再报错。
- MR !4897 的 CI 日志在 `e76488e7c294a6bcebb5057a2a3840aa5baf1b8d` 报出 `UPSTREAM.json` 的 `sourceRevision` 漂移：记录值 `2a65b0388ba612d99b62c5fe6ef42b8b9cc91632`，期望值为该提交。前端提交后重新运行同步脚本，只更新 manifest 这一字段，并通过 130 文件检查。

## risks
- 中文源串变化会产生新 i18n key；通过补齐翻译、重新生成和同步降低空翻译风险。
- `opencraft/scripts/smoke-console-embedded.mjs` 的断言文案触发高风险设计文档门禁；通过精确排除此 smoke 脚本，避免为纯文案修改写无关架构文档。

## validation
- `pnpm check`、相关组件测试、`pnpm build`；`npm run check:mono2-agent-console` 与变更影响校验。

## decisions
- 保留现有 `failureCode` 映射，仅改面向用户的提示；不扩大为连接逻辑改动。
- `.agents/context/change-impact.json` 仅对这条 smoke 断言脚本增加精确排除；其他 OpenCraft 运行时代码仍受原规则约束。

## scan_scope
- `frontend/src/pages/marketing/`、`frontend/src/i18n/generated/`、`opencraft/plugins/lightvela-hermes/src/upstream/mono2/i18n/generated/`。

## scan_output
- 有界精确搜索命中记录于本轮工具输出。

## handoff
- 源码和聚焦验证已完成；按 CI 要求再提交独立的 manifest 修复，并核验 MR !4897 的新一轮检查。前端全量测试与 Context 单测总门禁的已知失败仍保留在 MR 描述中。
