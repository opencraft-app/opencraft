---
id: agent-persona-description-copy-task
type: task
scope: 更新 Agent 人设页顶部的 SOUL.md 说明文案。
triggers: ["agent persona description", "SOUL.md 文案", "人设页说明"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/agent-persona-description-copy.md
status: active
reviewed_at: 2026-09-04
review_due: 2026-09-11
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：Agent 人设页说明文案

## goal

将人设页顶部说明改为“设置人设文件（SOUL.md），让你的 Agent 拥有独特的性格与表达方式”。

## non_goals

- 不改变人设选择、注入、编辑或下载逻辑。
- 不改变页面标题或 SkillHub 链接。
- 不提交、发布或修改外部服务。

## requirement_ids / requirement_refs / requirement_excerpt

- `user-request-2026-09-04-persona-description-copy`
- 用户指定了新文案的完整字面内容。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-buddy-panel.tsx`：人设页顶部说明文案。
- 不变量：`SOUL.md` 文件读写和人设状态结构不变。

## history_context

- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：原文案仅表达“独特灵魂”，新文案明确了 `SOUL.md` 文件与人设价值。
- `superseded_refs`：原页面文案。

## acceptance

- 页面源码和聚焦测试使用用户指定的新文案。
- 说明文案允许正常折行；SkillHub 来源链接的后续布局由 `agent-persona-skillhub-link-placement-task` 覆盖。
- 开放 locale 的生成资源通过一致性检查。

## affected_paths

- `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- `frontend/src/i18n/generated/`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/context/tasks/agent-persona-description-copy.md`

## required_context

- `frontend-product-surface`
- `frontend-service-detail`
- `site-environment-routing`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库 Context、验证与外部写入规则 | 限定变更与交付范围 |
| `frontend/AGENTS.md@working-tree` | 前端服务级规则 | 选择聚焦测试和 i18n 门禁 |
| `docs/context/project/services/frontend.md@working-tree` | 前端服务 Context | 确认 locale parity 要求 |
| `docs/context/domains/site-environment-routing.md@working-tree` | 双站与 locale 派生 Context | 确认共享组件的双站边界 |
| `docs/engineering/domains/site-environment-routing.md@working-tree` | change-impact 对应的正式设计 | 同步人设页文案定位 |

## evidence

- 人设页聚焦测试通过：1 个测试文件、33 个用例通过。
- `pnpm check` 通过：i18n 生成与结构校验通过，TypeScript 诊断 191，基线 276，新增 0。
- 新文案的 en-US、zh-Hant、id-ID、es、ja-JP 和 ko-KR 资源已通过项目脚本生成或写入。

## risks

- 新文案更长，可能在窄容器内折行；现有 `min-w-0` 和 `text-pretty` 允许说明文本正常折行，SkillHub 链接保持 `shrink-0`。

## validation

- `pnpm i18n:extract`
- `pnpm i18n:check`
- `pnpm vitest run src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- `pnpm check`
- `git diff --check`

## decisions

- 按用户指定文案原样替换，不调整标题区布局；owner 为 `wisp/mono2-maintainers`。

## scan_scope

- `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- `frontend/src/i18n/generated/`

## scan_output

- 精确搜索确认原文案只有一个运行时渲染点、两个聚焦测试断言，其余命中为生成词典。

## handoff

- 本地实现与聚焦验证完成；未提交、未推送、未发布。
