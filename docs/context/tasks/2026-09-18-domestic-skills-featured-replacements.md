---
id: domestic-skills-featured-replacements-2026-09-18
type: task
scope: 国内站 Skills 页面精选分类技能替换
owner: codex
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/skills-demo/domestic-skill-catalog.ts
  - frontend/src/pages/marketing/skills-demo/curated-skill-overviews.zh.ts
status: complete
reviewed_at: 2026-09-18
review_due: 2026-12-17
revision: 1.0.0
precedence: task
derived: false
---

## goal

将国内站 `理财分析`、`常用工具`、`教育学习` 分类中的四张人工精选技能卡替换为用户指定的 SkillHub 技能。

同步每张新卡的中文结构化详情模板和回归断言。

## non_goals

- 不修改国际站 Skills 页面。
- 不修改 Featured 顶部横幅资源。
- 不浏览外部页面、不做浏览器预览、不运行 pnpm 命令。
- 不提交、推送或创建 MR。

## requirement_refs

- 用户提供的四个 SkillHub 页面链接和替换关系。
- 新技能 slug：`cnfinancialscraper`、`multi-search-engine`、`anti-fraud`、`parenting-expert`。

## interface_refs / data_structure_refs

- `DOMESTIC_SKILL_CATEGORIES` 是国内站 Discover 分类的人工配置真源。
- `CURATED_SKILL_OVERVIEWS_ZH` 为国内站中文详情模板真源。
- 国内技能安装身份必须保持 `registry: "skillhub"` 与完整 SkillHub slug 一致。

## history_context

- `docs/context/domains/site-environment-routing.md`：国内站与国际站独立交付。
- `docs/context/tasks/2026-09-12-domestic-finance-advisor-skill-swap.md`：同一 Skills catalog 的历史替换范例。
- `graphify-out/GRAPH_REPORT.md`：确认 catalog、overview、`SkillsDemoPanel` 和 SkillHub 数据层之间的关系。

## acceptance

- 理财分析以 `cnfinancialscraper` 替换 `financial-report-analysis`。
- 常用工具以 `multi-search-engine` 替换 `meeting-notes-assistant`，以 `anti-fraud` 替换 `pptx-generator`。
- 教育学习以 `parenting-expert` 替换 `academic-learning-assistant`。
- 四个新 slug 均有中文结构化详情模板。
- 四类仍各有六张卡，所有固定卡仍使用 SkillHub registry。
- 运行定向测试或等价静态检查，并通过 `git diff --check`。

## affected_paths

- `frontend/src/pages/marketing/skills-demo/domestic-skill-catalog.ts`
- `frontend/src/pages/marketing/skills-demo/domestic-skill-catalog.test.ts`
- `frontend/src/pages/marketing/skills-demo/curated-skill-overviews.zh.ts`

## required_context

- `site-environment-routing`
- `frontend/AGENTS.md`
- `frontend/openspec/plan.md`
- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md` | 确认国内站边界 | 仅修改国内站人工 catalog |
| `frontend/AGENTS.md` | 确认前端约束和验证入口 | 保持现有 React/TypeScript 实现和定向检查 |
| `frontend/openspec/plan.md` | 确认前端历史计划状态 | 避免扩大到无关前端范围 |
| `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx` | 确认分类与详情调用关系 | 保持复用现有卡片、弹窗和安装状态 |
| `docs/context/tasks/2026-09-12-domestic-finance-advisor-skill-swap.md` | 核对同类替换的历史做法 | 沿用 raw ID、详情模板和安装断言的一致性要求 |
| `graphify-out/GRAPH_REPORT.md` | 确认技能页相关邻接关系 | 定位 catalog、overview、SkillHub 数据层邻居 |

## evidence

- 初始工作区已在 `master` 且与 `origin/master` 对齐。
- 初始 catalog 四类均为六张 SkillHub 卡。
- 新技能详情内容依据用户提供的 SkillHub slug 和名称编写，未调用外部浏览。
- `frontend/node_modules/.bin/vitest run src/pages/marketing/skills-demo/domestic-skill-catalog.test.ts`：5 tests passed。
- `frontend/node_modules/.bin/tsc --noEmit --pretty false`：exit 0。
- `git diff --check`：exit 0。
- SkillHub API（2026-09-18）已核对四个指定页面的 `iconUrl`，并写入 `DOMESTIC_ICON_SNAPSHOT`。

## risks

- 固定卡片的图标 URL 是 SkillHub 快照；若远端资源迁移或 slug 变更，需重新核对并更新 catalog 和测试。
- 下载量和安装量仍不作猜测，固定卡不新增未经本轮需求授权的热度行为。

## validation

- 运行相关 Vitest 定向测试（若本地依赖可用）。
- 运行 `git diff --check`。
- 不运行 pnpm 命令，符合本轮用户要求。

## decisions

- `育儿大师.Skill` 替换当前展示名为“学科专家生成”的 `academic-learning-assistant`，保留相邻的“课题小助手”。
- 新卡不写入未经验证的 SkillHub 下载量、安装量或图标 URL。

## scan_scope

- `frontend/src/pages/marketing/skills-demo/`

## scan_output

- 使用 `rg` 和 `graphify-out/GRAPH_REPORT.md` 完成有界定位。

## handoff

- 当前状态：四张国内站分类技能卡、中文详情和回归断言已完成。
- 下一步：如需上线，另行执行用户确认后的提交、推送和发布流程。
- 阻塞项：未运行 pnpm 全量门禁，符合本轮用户要求。
