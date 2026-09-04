---
id: homepage-and-settings-copy-polish-task
type: task
scope: 优化国际站首页主标语与高级设置加载态文案。
triggers: ["always on hero copy", "Loading settings", "首页和高级设置文案"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/homepage-and-settings-copy-polish.md
status: active
reviewed_at: 2026-09-04
review_due: 2026-09-11
revision: 1.3.0
precedence: task
derived: false
---

# Task Pack：首页展示与高级设置文案优化

## goal

用 `always on` 与 `24/7` 明确国际站首页 Agent 始终在线的产品价值，将高级设置加载态改为简洁、面向用户的本地化文案，保证首页能力条在中等宽度下不发生内容重叠或越界，并按产品优先级调整页脚链接顺序。

## non_goals

- 不改变首页能力条以外的布局、动画节奏或其他 locale 的既有语义。
- 不改变页脚两个相关产品的名称、链接目标或外链行为。
- 不增删 Community 外链，也不改变其链接目标或外链行为。
- 不改变高级设置加载、错误、重试或保存逻辑。
- 不提交、推送、发布或修改外部服务。

## requirement_ids / requirement_refs / requirement_excerpt

- `user-request-2026-09-04-homepage-settings-copy-polish`
- 用户确认首页采用 `Your AI companion—always on, always evolving with you.`，并按建议把加载态改为 `Loading settings...` / “正在加载设置…”。

## interface_refs / data_structure_refs

- `frontend/scripts/import-international-homepage.mjs`：国际站首页导入与 locale 映射。
- `frontend/public/lightvela-intl-home/index-fragment*.html`：国际站运行时静态片段。
- `frontend/src/pages/marketing/agent-common-settings-panel.tsx`：高级设置加载态。

## history_context

- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：首页旧英文使用 `always here`；其他 locale 已自然表达长期在线。高级设置旧文案 `Reading current configuration…` 偏技术日志语气。
- `superseded_refs`：无。

## acceptance

- 国际站英文首页主标语显示 `Your AI companion—always on, always evolving with you.`。
- 首页导入脚本、默认/英文静态片段与聚焦测试一致；其他 locale 文案保持不变。
- 首页“始终在线”能力卡的所有开放 locale 均明确表达全天候在线，同时保留无需用户电脑持续开机的说明。
- 英文能力卡使用自然的 `leave your computer running` 与 `turn your feedback into a new rule` 表达，并加粗全天候云端运行和反馈沉淀两个关键词组。
- 高级设置中文显示“正在加载设置…”，英文显示 `Loading settings...`，其余开放 locale 无空翻译。
- 首页能力条轮播到 `Memory` / `User Profile` 时，文案在约 1000px 的中等视口内可收缩并省略，图标组保持在卡片边界内，且中间斜切不遮挡标签。
- 国际站所有开放 locale 的页脚“相关产品”均先展示 `Tencent EdgeOne`，再展示 `Tencent CloudBase`，两个链接仍在新窗口打开。
- 国际站所有开放 locale 的页脚 Community 均以 `X / Twitter` 为第一项，其后为 `Discord`、`WhatsApp`、`YouTube`。
- 聚焦测试、i18n 和前端门禁通过。

## affected_paths

- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/index-fragment*.html`
- `frontend/public/lightvela-intl-home/style.css`
- `frontend/next-site/__tests__/international-home-page.test.tsx`
- `frontend/next-site/__tests__/international-home-rendering.test.tsx`
- `frontend/src/pages/marketing/agent-common-settings-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx`
- `frontend/src/i18n/generated/*.json`
- `docs/engineering/domains/site-environment-routing.md`

## required_context

- `frontend-product-surface`
- `frontend-service-detail`
- `site-environment-routing`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库 Context 与验证规则 | 限定变更和交付边界 |
| `frontend/AGENTS.md@working-tree` | 前端服务规则 | 确定 locale 与视觉文案验证 |
| `docs/context/project/services/frontend.md@working-tree` | 前端服务 Context | 确认静态首页和 React 页面验证方式 |
| `docs/engineering/domains/site-environment-routing.md@working-tree` | 双站与 locale 真源 | 同步导入脚本、静态片段与测试 |

## evidence

- 首页与高级设置聚焦测试通过：3 个测试文件、83 个用例通过；新增首页导入脚本防回退断言单独复跑 26/26 通过。
- “始终在线”能力卡的七种国际站 locale 回归通过：首页两份聚焦测试共 33/33，覆盖用户可见的全天候文案与加粗强调。
- `pnpm check` 通过：i18n 2699 条文案结构校验通过，TypeScript 诊断 191，基线 276，新增 0。
- 新加载文案已补齐英文、繁中、印尼语、西班牙语、日语和韩语；国际站其他首页 locale 文案保持不变。
- 以 1001px 宽的本地国际站预览强制展示第二轮播态检查：`Memory` 与 `User Profile` 均留在各自半区内，描述按可用宽度省略，左右图标无越界；首页聚焦测试 26/26 通过。
- 页脚生成模板及 9 份静态片段已统一为 `Tencent EdgeOne` → `Tencent CloudBase`，聚焦测试固定英文默认片段的标签与链接顺序。
- 页脚 Community 生成模板及 9 份静态片段已统一为 `X / Twitter` → `Discord` → `WhatsApp` → `YouTube`，聚焦测试固定默认片段顺序。

## risks

- 仅修改静态片段会被下次首页导入覆盖；因此同步更新导入脚本映射键。
- 新中文 i18n 键可能造成其他 locale 空翻译；通过批量应用和 i18n 校验覆盖。
- 第二轮播态同时包含描述和图标，固定总宽会在中等窗口越界；改为文案区域弹性收缩、图标固定，并保留完整 `title` / `aria-label` 供查看与辅助技术读取。

## validation

- `pnpm vitest run next-site/__tests__/international-home-page.test.tsx next-site/__tests__/international-home-rendering.test.tsx src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx`
- `pnpm check`
- `git diff --check`

## decisions

- 英文首页使用破折号强化两个价值点；其他 locale 已表达长期在线，不做机械重译。owner 为 `wisp/mono2-maintainers`。
- 能力条不通过缩小字号规避冲突，而是在第二轮播态内增加安全内边距，并对文案区域使用 flex 收缩与省略；图标尺寸和动画保持不变。

## scan_scope

- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/index-fragment*.html`
- `frontend/src/pages/marketing/agent-common-settings-panel.tsx`
- 对应聚焦测试与 i18n 字典。

## scan_output

- 首页旧英文共出现在导入映射、默认/英文静态片段和两处回归测试；加载态由一个 React 渲染点和现有状态测试覆盖。

## handoff

- 本地实现与验证完成；计划并入现有 MR !3611，尚未提交或推送。
