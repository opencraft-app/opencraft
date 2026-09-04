---
id: agent-memory-content-line-breaks-task
type: task
scope: 修复 Agent 记忆页面将 MEMORY.md 和 USER.md 内容压成单行的问题。
triggers: ["agent memory line breaks", "记忆内容换行", "MEMORY.md display"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/agent-memory-content-line-breaks.md
status: active
reviewed_at: 2026-09-04
review_due: 2026-09-11
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：Agent 记忆内容换行

## goal

让 Agent 记忆页面忠实显示 `MEMORY.md` 和 `USER.md` 每条内容的原始换行，并让长行在容器内自动折行。

## non_goals

- 不引入 Markdown 富文本渲染。
- 不改变 Hermes 记忆文件的读取、分隔、保存或限额逻辑。
- 不发布或修改外部服务。

## requirement_ids / requirement_refs / requirement_excerpt

- `user-request-2026-09-04-memory-line-breaks`
- 用户截图与描述：记忆页面的具体 Markdown 文档内容没有换行；外部 Issue 或 TAPD 引用为 `unknown`。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-settings-page.tsx`：`MemoryEntries` 展示组件。
- `frontend/src/pages/marketing/agent-memory.ts`：`splitHermesMemoryEntries` 保持按 `§` 分条。
- 不变量：不改变 `HermesMemorySnapshot`、命令协议或记忆文件内容。

## history_context

- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：当前实现自引入以来主动将每条内容压缩为单行并截断；本任务只撤销该展示限制。
- `superseded_refs`：无。

## acceptance

- 记忆条目保留 `\n` 换行。
- 无换行的长内容在容器内自动折行，不再单行截断。
- 国内站与国际站共享行为；不增加 locale 文案。

## affected_paths

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-memory.ts`
- `frontend/src/pages/marketing/__tests__/agent-memory.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-memory-page-boundary.test.ts`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/context/tasks/agent-memory-content-line-breaks.md`
- `docs/context/.context/catalog.jsonl`
- `docs/context/decisions/ADR-0001-context-engineering-v2.md`

## required_context

- `frontend-product-surface`
- `frontend-service-detail`
- `adjacency-frontend-runtime-openspec-i18n`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库 P0、Context 与 change-impact 规则 | 确认验证、外部写入和文档同步边界 |
| `docs/context/project/services/frontend.md@working-tree` | 路由要求的前端服务 Context | 选择前端聚焦测试与双站验证边界 |
| `frontend/AGENTS.md@working-tree` | 最近的服务级规则 | 确定最小 lint/type/test 门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 前端实现与测试邻接卡 | 检查相邻实现、测试和 OpenSpec |
| `docs/engineering/domains/site-environment-routing.md@working-tree` | change-impact 映射的正式设计 | 记录国内/国际站共享的记忆展示事实 |
| `docs/context/decisions/ADR-0001-context-engineering-v2.md@working-tree` | catalog 变更命中的 Context 正式设计 | 记录 Task Pack 与可重建 catalog 的关系 |

## evidence

- 聚焦测试在实现前失败：缺少 `whitespace-pre-wrap`，且现有条目使用 `toSingleLineMemoryEntry` 与 `truncate`。
- 聚焦测试通过：2 个测试文件、31 个用例通过。
- `pnpm check` 通过：i18n、文档同步与 TypeScript baseline 均无新增错误。
- Documentation Validator、docs-impact 与 `git diff --check` 通过。
- Context Validator 已生成本 Task Pack 的 catalog 记录，但最新 `origin/master` 自带的 `docs/context/tasks/2026-09-04-persona-injected-summary.md` 缺少 Context frontmatter，导致全仓 Context gate 基线失败；本 MR 不修改该无关文件。

## risks

- 多行内容会增加页面纵向高度；这是完整展示文件内容的预期结果，条目仍保持现有分组和视觉容器。
- 超长连续文本可能溢出；通过 `break-words` 在容器内折行。

## validation

- `pnpm vitest run src/pages/marketing/__tests__/agent-memory.test.ts src/pages/marketing/__tests__/agent-memory-page-boundary.test.ts`
- `pnpm check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`

## decisions

- 使用 CSS `white-space: pre-wrap` 保留换行，而不引入 Markdown 解析器；owner 为 `wisp/mono2-maintainers`。
- 删除仅服务于旧单行预览的 helper，保持实现最小。

## scan_scope

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-memory.ts`
- 相邻记忆测试与 `frontend/openspec/` 精确命中。

## scan_output

- 精确搜索确认 `toSingleLineMemoryEntry` 只用于记忆条目单行预览及其测试。

## handoff

- 代码、测试与设计事实已完成本地验证；用户已明确授权 commit、push 和创建 MR，但未授权合并或发布。

## checkpoint

### stage

本地实现与验证完成，下一道门禁为创建并核实远端 MR。

### verified

- 原始换行由 `whitespace-pre-wrap` 保留，长内容由 `break-words` 折行。
- 旧的单行压缩 helper 与 `truncate` 已移除。
- 聚焦测试、`pnpm check`、Documentation Validator、docs-impact 与差异格式检查通过。

### unverified

- 尚未在已登录的真实 Agent 记忆页面做浏览器截图回归。
- 全仓 Context Validator 仍被最新 `origin/master` 中无关 Task Pack 的缺失 frontmatter 阻断。

### discard

- 实现前失败断言和临时绑定 `127.0.0.1` 的 Vitest 配置；临时配置未保留在仓库。

### restore

- 续接时只需读取本 Task Pack、上述 affected paths 与当前 `git diff`。

### next_action

- 提交并推送 `codex/fix-memory-content-line-breaks`，创建目标为 `master` 的 MR，再核实 source SHA、文件范围与 MR 状态。
