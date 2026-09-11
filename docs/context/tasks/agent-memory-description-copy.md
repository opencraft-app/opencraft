---
id: agent-memory-description-copy-task
type: task
scope: 明确 Agent 记忆页面说明中 MEMORY.md 的持久记忆定位。
triggers: ["agent memory description", "持久记忆文案", "记忆页说明"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/agent-memory-description-copy.md
status: active
reviewed_at: 2026-09-04
review_due: 2026-09-11
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：Agent 记忆页说明文案

## goal

将记忆页说明中的“记忆”改为“持久记忆”，与页面标题和 `MEMORY.md` 用途保持一致。

## non_goals

- 不改变记忆文件的展示、读写或限额逻辑。
- 不发布或修改外部服务。

## requirement_ids / requirement_refs / requirement_excerpt

- `user-request-2026-09-04-memory-description-copy`
- 用户指定文案：“查看当前 Hermes Agent 的持久记忆和用户画像文件”。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-settings-page.tsx`：记忆页 `AgentSectionHeader` 说明文案。
- 不变量：不改变 `HermesMemorySnapshot` 或 Agent 运行时协议。

## history_context

- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：记忆页标题已使用“持久记忆”，本次只对齐说明文案。
- `superseded_refs`：无。

## acceptance

- 页面源码使用用户指定的新文案。
- i18n 生成资源通过一致性检查。
- 现有记忆换行测试保持通过。

## affected_paths

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-memory-page-boundary.test.ts`
- `frontend/src/i18n/generated/`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/context/tasks/agent-memory-description-copy.md`

## required_context

- `frontend-product-surface`
- `frontend-service-detail`
- `site-environment-routing`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库 Context、验证与外部写入规则 | 限定变更和交付范围 |
| `frontend/AGENTS.md@working-tree` | 前端服务级规则 | 选择最小测试和 i18n 门禁 |
| `docs/context/project/services/frontend.md@working-tree` | 前端服务 Context | 确认 locale parity 要求 |
| `docs/context/domains/site-environment-routing.md@working-tree` | 双站与 locale 派生 Context | 确认共享组件的双站边界 |
| `docs/engineering/domains/site-environment-routing.md@working-tree` | change-impact 对应的正式设计 | 同步记忆页文案定位 |

## evidence

- 边界测试通过：1 个测试文件、7 个用例通过。
- `pnpm i18n:check` 与 `pnpm i18n:validate` 通过，本次新文案的 6 个非中文语种均已补齐。
- `pnpm i18n:zh-hant` 已按当前转换规则生成繁体资源，并一并规范化了既有版权文案的标点漂移。
- `pnpm check` 通过：TypeScript 诊断 191，基线 276，新增 0。
- Context catalog 已登记本 Task Pack；全仓 Context Validator 仍被无关的 `docs/context/tasks/2026-09-04-persona-injected-summary.md` 缺少 frontmatter 阻断。

## risks

- 新中文源文案会生成新的 i18n key；通过项目脚本更新，不手工维护生成键。

## validation

- `pnpm i18n:extract`
- `pnpm i18n:check`
- `pnpm vitest run src/pages/marketing/__tests__/agent-memory-page-boundary.test.ts`
- `git diff --check`

## decisions

- 按用户指定文案原样替换，不改写其他文案；owner 为 `wisp/mono2-maintainers`。

## scan_scope

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-memory-page-boundary.test.ts`
- `frontend/src/i18n/generated/`

## scan_output

- 精确搜索确认旧文案仅有一个运行时渲染点，其余命中为生成词典。

## handoff

- 本地实现与聚焦验证完成；未提交、未推送、未发布。
