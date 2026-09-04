---
id: agent-persona-skillhub-link-placement-task
type: task
scope: 将人设页 SkillHub 来源链接移入人设卡片容器右上角。
triggers: ["persona SkillHub link", "人设卡片右上角", "SkillHub 跳转按钮"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/agent-persona-skillhub-link-placement.md
status: active
reviewed_at: 2026-09-04
review_due: 2026-09-11
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：Agent 人设页 SkillHub 链接对齐

## goal

将“灵感来自 SkillHub”链接从页面说明行移到人设卡片大框右上角，并与“人设卡片”标题高度对齐。

## non_goals

- 不改变 SkillHub 链接地址、文案或新窗口行为。
- 不改变人设卡片、抽卡、注入或编辑逻辑。
- 不提交、发布或修改外部服务。

## requirement_ids / requirement_refs / requirement_excerpt

- `user-request-2026-09-04-persona-skillhub-link-placement`
- 用户截图指定红框链接移至人设卡片大框右上角，高度与“人设卡片”对齐。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-buddy-panel.tsx`：页面说明区、人设卡片工具栏和 SkillHub 链接。
- 不变量：链接仍指向 `https://skillhub.cn/soul`，并保留 `target="_blank"` 与 `rel="noopener noreferrer"`。

## history_context

- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：上一次文案任务保留了链接在顶部说明行的旧布局；本次用户明确要求移入卡片大框。
- `superseded_refs`：`docs/context/tasks/agent-persona-description-copy.md` 中关于 SkillHub 链接位置的原验收表述。

## acceptance

- 顶部说明行不再包含 SkillHub 链接。
- SkillHub 链接与“人设卡片”标题位于同一工具栏。
- 标题保持居中，链接固定于工具栏右侧并垂直居中。
- 链接地址、外链属性和文案不变。

## affected_paths

- `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/context/tasks/agent-persona-description-copy.md`
- `docs/context/tasks/agent-persona-skillhub-link-placement.md`

## required_context

- `frontend-product-surface`
- `frontend-service-detail`
- `site-environment-routing`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库 Context、验证与外部写入规则 | 限定变更与交付范围 |
| `frontend/AGENTS.md@working-tree` | 前端服务级规则 | 确定视觉变更的聚焦测试与截图要求 |
| `docs/context/project/services/frontend.md@working-tree` | 前端服务 Context | 确认双站和视觉验证边界 |
| `docs/context/domains/site-environment-routing.md@working-tree` | 双站与 locale 派生 Context | 确认共享人设组件边界 |
| `docs/engineering/domains/site-environment-routing.md@working-tree` | change-impact 对应的正式设计 | 同步 SkillHub 来源链接的展示位置 |

## evidence

- 人设页聚焦测试通过：1 个测试文件、33 个用例通过；新断言确认链接与“人设卡片”处于同一工具栏。
- `pnpm check` 通过：i18n 生成与结构校验通过，TypeScript 诊断 191，基线 276，新增 0。
- Baseline UI 检查：未新增动画、自定义间距、交互原语或可访问性退化；链接文本、外链属性和图标保持不变。

## risks

- 容器过窄时右侧链接可能与居中标题接近；链接保持短文案与 `white-space: nowrap`，并通过浏览器截图检查实际桌面宽度。

## validation

- `pnpm vitest run src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- `pnpm check`
- 国内站 5174 人设页聚焦截图。
- `git diff --check`

## decisions

- 工具栏保持标题居中，链接使用 `absolute inset-y-0 right-6` 在右侧垂直居中，不改动现有 CSS；owner 为 `wisp/mono2-maintainers`。

## scan_scope

- `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- `frontend/src/styles.css` 中 `lv-buddy-panel` 相关规则。

## scan_output

- 精确搜索确认 SkillHub 链接、人设卡片标题和容器工具栏均在 `BuddyPanel` 同一渲染分支；无需新增样式文件。

## handoff

- 本地实现与聚焦验证完成；未提交、未推送、未发布。
