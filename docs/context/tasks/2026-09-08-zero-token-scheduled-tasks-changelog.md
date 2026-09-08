## goal

在国内站与国际站产品动态中发布通知任务、脚本任务两种新定时任务类型，明确两者均不调用模型且模型 Token 消耗为 0，并覆盖国际站全部可见语言。

## non_goals

- 不修改定时任务业务逻辑、接口或产品界面。
- 不复用无法展示新任务类型的旧截图。
- 不合并 MR 或发布到生产环境。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户需求（2026-09-08）：新增两种新类型的定时任务——通知任务、脚本任务；不需要调用模型，0 Token 消耗；更新国内站、国际站 Changelog；历史动态统一为“定时任务”；单独提交新 MR；9 月工作台动态改为强调在 LightVela 中创建个人工作台并以静态网站形式管理。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/changelog-page.tsx` 的 `ChangelogEntry` 与国内站、国际站 `2026-09` 分组。
- 保持现有静态 Changelog 渲染模型与站点分支不变。

## history_context

- `current_design_refs`：`frontend/AGENTS.md`、`docs/context/project/services/frontend.md`。
- `relevant_evolution`：当前 `master` 已把历史 Changelog 任务动态统一为“定时任务 / Scheduled Tasks”，本变更只新增 0 Token 产品动态。
- `superseded_refs`：无。

## acceptance

- 国内站 2026 年 9 月分组首条展示通知任务、脚本任务及 0 Token 说明。
- 国际站同一动态覆盖简体中文、繁体中文、英语、印度尼西亚语、西班牙语、日语和韩语。
- 国内站与国际站历史任务动态继续使用“定时任务 / Scheduled Tasks”，不回退到“自动任务 / Automations”。
- 国内站使用简体中文通知任务弹窗截图；国际站随当前语言展示对应的通知任务弹窗截图。
- 国内站、国际站聚焦测试与 i18n 门禁通过。

## affected_paths

- `frontend/src/pages/marketing/changelog-page.tsx`
- `frontend/src/pages/marketing/__tests__/channel-copy.test.tsx`
- `frontend/src/pages/marketing/__tests__/global-changelog.test.tsx`
- `frontend/src/i18n/generated/`
- `frontend/public/assets/changelog/scheduled-tasks-notification-*.png`
- `docs/context/tasks/2026-09-08-zero-token-scheduled-tasks-changelog.md`

## required_context

- `frontend-product-surface` Pack。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@1c223852a` | 前端服务规则 | 确定测试、i18n 和交付门禁 |
| `docs/context/project/services/frontend.md@2.1.0` | 路由要求的权威入口 | 确定静态页面与验证边界 |
| `.agents/skills/product-skills/lightvela-changelog-update/SKILL.md` | Changelog 专用流程 | 确定双站、翻译、测试与图片策略 |
| `.agents/skills/product-skills/lv-vibe-coding/SKILL.md` | 研发协作流程 | 确定独立分支、MR 与交付边界 |
| `.agents/skills/gongfeng/SKILL.md` | 工蜂操作流程 | 确定鉴权、查重、创建和回查要求 |
| `/Users/pablozhong/.codex/skills/karpathy-guidelines/SKILL.md` | 代码变更规范 | 保持改动有界并使用可验证的成功标准 |

## evidence

- `origin/master@1c223852a` 已统一历史 Changelog 的定时任务命名；新分支直接从该提交创建，未携带 MR !3712 的其他改动。
- 国内站与国际站 `2026-09` 分组首位复用同一条新动态；使用真实的“新建定时任务”弹窗并选中“通知任务”，国内站使用简体中文图，国际站覆盖全部七种可见语言。
- 新增两条中文源文案；英语、印度尼西亚语、西班牙语、日语和韩语手工补齐，繁体中文由仓库脚本生成。
- 9 月工作台动态的国内站和国际站七种语言已同步改为“在 LightVela 中创建个人工作台，并以静态网站形式发布和管理”的产品表述。
- 回归测试覆盖国内站顺序、0 Token 文案、国内站截图、国际站七种语言截图，以及历史命名不得回退。
- 国内站与国际站聚焦测试共 20 个用例通过；`pnpm check` 通过，TypeScript 0 个新增诊断，现有 51 个 i18n 告警未新增错误。
- 文档完整性校验通过：0 个 first-party 断链、0 个 warning。

## risks

- “0 Token”容易被误解为整个任务没有任何运行资源成本；文案限定为“模型 Token 消耗为 0”。
- 国际站翻译可能遗漏；通过全部可见语言矩阵测试与 i18n 检查约束。

## validation

- 聚焦运行国内站与国际站 Changelog 测试。
- 运行 i18n 提取、繁体中文生成与一致性检查。
- 运行 `pnpm check`、`git diff --check`、文档完整性与 staged change-impact 校验。

## decisions

- 两种任务类型作为同一条产品动态发布，避免拆分同一能力。
- 截图只裁取新建弹窗，避免把账号任务数据带入产品动态；各语言截图保持相同尺寸和“通知任务”选中状态。
- 英文标题采用 Title Case；英文正文明确“不调用模型”和“模型 Token 消耗为 0”。

## scan_scope

- `frontend/src/pages/marketing/changelog-page.tsx`
- `frontend/src/pages/marketing/__tests__/channel-copy.test.tsx`
- `frontend/src/pages/marketing/__tests__/global-changelog.test.tsx`

## scan_output

- 源码核对确认国内站与国际站共用 Changelog 页面但拥有独立的 2026 年 9 月分组；历史任务动态在当前 `master` 中已完成命名统一。

## handoff

- 独立分支：`frontsandbox/scheduled-tasks-changelog`。
- 目标分支：`master`。
- 只提交 Changelog、生成的多语言资源、回归测试与本 Task Pack；不合并、不发布。
