---
id: multi-bot-changelog-2026-09-23
type: task
scope: 国内站与国际站 Changelog 的多 Bot 产品动态和全语言文案。
triggers: ["multi-Bot changelog", "支持创建多个 Bot", "multiple Bots update"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-23-multi-bot-changelog.md
  - frontend/src/pages/marketing/changelog-page.tsx
status: active
reviewed_at: 2026-09-23
review_due: 2026-12-22
revision: 1.0.0
precedence: task
derived: false
---

## goal

在国内站与国际站 2026 年 9 月产品动态中新增“支持创建多个 Bot”，并覆盖国际站全部可见语言。

## non_goals

- 不修改多 Bot 的业务逻辑、套餐配额、站点门禁或后端接口。
- 不生成或编辑产品截图，不调整 Changelog 页面布局。
- 不合并、发布或修改生产环境。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户需求（2026-09-23）：国内站和国际站 Changelog 增加一条支持创建多 Bot 的动态。
- 用户补充（2026-09-23）：配图使用创建第二个 Bot 的界面截图。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/changelog-page.tsx` 的 `ChangelogEntry` 与双站 `2026-09` 分组。
- 保持现有静态 Changelog、`isGlobal` 站点分支与 i18n 中文源文案契约不变。

## history_context

- `current_design_refs`：`docs/context/domains/site-environment-routing.md`、`frontend/AGENTS.md`。
- `relevant_evolution`：多 Bot 已进入双站共用源码与国际站文档；国际站追加 Bot 入口仍保留 `show()` 分阶段门禁。
- `superseded_refs`：无。

## acceptance

- 国内站与国际站 2026 年 9 月分组均展示“支持创建多个 Bot”的独立动态。
- 国际站简体中文、繁体中文、英语、印度尼西亚语、西班牙语、日语和韩语文案完整。
- 英文标题使用 Title Case；描述强调多个 Bot 各司其职，并准确列出 Profile 级隔离范围，不承诺全面开放或套餐上限。
- 新条目复用文档站已有的真实 Bot 创建截图；国内站与国际站中文 locale 使用中文图，国际站其他 locale 使用英文图。
- 双站聚焦测试、i18n 门禁、前端检查与构建通过。

## affected_paths

- `frontend/src/pages/marketing/changelog-page.tsx`
- `frontend/src/pages/marketing/__tests__/channel-copy.test.tsx`
- `frontend/src/pages/marketing/__tests__/global-changelog.test.tsx`
- `frontend/src/i18n/generated/`
- `docs/context/tasks/2026-09-23-multi-bot-changelog.md`

## required_context

- `site-environment-routing`
- `frontend-product-surface`
- `adjacency-frontend-runtime-openspec-i18n`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@2fc50c1ca` | 双站多 Bot 与 locale 边界 | 分别验证国内、国际展示，不修改门禁 |
| `docs/context/project/services/frontend.md@2fc50c1ca` | 前端验证边界 | 选择聚焦测试、检查与构建 |
| `frontend/AGENTS.md@2fc50c1ca` | 前端服务规则 | 保持静态页面与生成资源约定 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@2fc50c1ca` | i18n 与相邻测试 | 通过生成入口维护多语言字典 |
| `.agents/skills/product-skills/lightvela-changelog-update/SKILL.md` | 产品动态专用流程 | 使用双站、多语言、无图静态条目方案 |
| `/Users/pablozhong/.codex/skills/karpathy-guidelines/SKILL.md` | 代码变更规范 | 采用最小改动与可验证成功标准 |
| `docs/context/tasks/2026-09-21-global-bot-create-copy-layout.md@2fc50c1ca` | 国际站多 Bot 当前边界 | 避免在动态中写成全面开放 |

## evidence

- `ChangelogContent` 新增共享 `multiBotEntry`，并作为国内站、国际站 2026 年 9 月分组首条；使用 `visual: "multiBot"` 复用现有真实 Bot 创建截图，未新增或编辑图片文件。
- 新增中文源标题与描述，英语、印尼语、西班牙语、日语、韩语人工补齐，繁体中文由仓库脚本转换；国际站七种可见语言均由矩阵测试覆盖。
- 国内站与国际站 Changelog 聚焦测试 2 个文件、21 个用例全部通过。
- `pnpm i18n:check`、`pnpm i18n:zh-hant:check` 通过；`pnpm i18n:validate` 为 0 个错误，仅保留 50 个既有告警。
- `pnpm check` 通过，TypeScript diagnostics 为 171 current / 171 baseline / 0 new。
- 国内站 `pnpm build` 通过，生成 106/106 个静态页面；国际站 `pnpm build:global` 通过，生成 664/664 个静态页面。
- 国际站构建产物中，默认英文与 `zh-sg`、`zh-hant`、`id-id`、`es`、`ja-jp`、`ko-kr` 共七个 Changelog 路由均包含对应多 Bot 标题。
- 本地浏览器预览确认国内站显示中文 Bot 创建截图，国际站英文页面显示英文图、`zh-sg` 页面显示中文图；卡片内使用无损 CSS 放大裁切，表单比例正常。
- `validate_documentation.py --format json` 通过：errors 0、broken links 0；构建产生的字体与 Context catalog 噪声不纳入变更。

## risks

- 国际站入口仍分阶段开放；文案仅说明能力，不写“全面开放”或套餐上限。
- 多语言漏译会造成国际站回退中文；使用七语种矩阵测试与 i18n 检查约束。

## validation

- 聚焦运行国内站与国际站 Changelog 测试。
- 运行 `pnpm i18n:extract`、翻译写入、`pnpm i18n:zh-hant`、`pnpm i18n:check` 与 `pnpm i18n:validate`。
- 运行 `pnpm check`、`pnpm build`、`pnpm build:global`、`git diff --check` 与 documentation 门禁。

## decisions

- 条目标题使用“LightVela 支持创建多个 Bot”，正文强调多个 Bot 各司其职，并列出记忆、技能、定时任务、模型和通道配置相互隔离。
- 条目放在 2026 年 9 月分组首位，反映当前新增动态。
- 使用 `visual: "multiBot"`，复用文档站已有的中英文 Bot 创建截图，避免重复资源与不真实插图。

## scan_scope

- `frontend/src/pages/marketing/changelog-page.tsx`
- 两个相邻 Changelog 测试。
- i18n 生成与写入脚本。

## scan_output

- 精确搜索确认当前 Changelog 无多 Bot 条目；双站共用页面但分别维护 2026 年 9 月数组。

## handoff

- 当前：MR !4534 已创建；创建第二个 Bot 的真实界面截图、双站预览和回归均已完成。
- 下一步：等待 MR 评审与 CI。
- 阻塞：无。
