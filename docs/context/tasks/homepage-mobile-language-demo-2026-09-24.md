## goal
修复双站首页移动端语言切换入口，并让国际站首屏聊天演示使用当前页面语言。

## non_goals
- 不改动登录、计费或实际聊天产品逻辑；不发布生产。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮反馈：移动端无法从页面切换语言；多语言首屏演示混用语言。截图展示繁体中文演示中残留简体字。

## interface_refs / data_structure_refs
- `frontend/next-site/home-mobile-navigation.tsx` 的移动菜单。
- `frontend/next-site/language-switcher.tsx` 与 `frontend/src/components/site/language-switcher.tsx` 的现有站点和路由切换规则。
- `frontend/scripts/import-international-homepage.mjs` 的按语言静态片段生成规则。

## history_context
- `current_design_refs`: `docs/context/domains/site-environment-routing.md`、`docs/context/project/services/frontend.md`。
- `relevant_evolution`: 首屏演示四个聊天平台的静态片段来自导入脚本。

## acceptance
- 国内站与国际站移动首页可在菜单内找到并使用语言切换。
- 国际站七个语言版本的首屏演示四个聊天平台不再出现明显的源语言残留；繁体中文演示不残留简体字。
- 前端相关测试、检查和构建通过；在本地预览检查窄屏菜单与语言路由。

## affected_paths
- `frontend/next-site/home-mobile-navigation.tsx`
- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/`
- 前端测试。

## required_context
- site-environment-routing Pack；frontend 服务说明和 `frontend/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@b2573c45a` | 双站 URL 和语言边界 | 维持站点切换规则 |
| `docs/context/project/services/frontend.md@b2573c45a` | 前端服务边界 | 确定测试范围 |
| `frontend/AGENTS.md@b2573c45a` | 前端门禁 | 确定验证命令 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@b2573c45a` | 语言相邻模块 | 检查生成片段和测试邻居 |
| `docs/context/tasks/TASK-TEMPLATE.md@b2573c45a` | Task Pack 格式 | 记录本次工作 |

## evidence
- 初始隔离工作树：`origin/master` 的 `b2573c45a`；生产截图与当前静态片段均显示混语。
- 移动端 390×844 本地检查：国内站与国际站菜单均显示语言选项；国际站繁体切西语后到 `/es/`，首屏聊天为西语。
- 国际站片段中的 `zh-Hant` 简体残留已转换；`id-ID`、`es`、`ja-JP`、`ko-KR` 四个平台聊天片段已补齐源语言残留。刷新脚本重复运行的文件哈希不变。
- MR !4573 首次 CI 的 frontend guard 已通过；opencraft guard 在执行 `node` 前因 CI 环境找不到命令失败。该 guard 由 `frontend/src/**` 触发，本次唯一命中的源码文件是共享语言切换器中的“中国站”文案。为保留两项 P1 改动并缩小 CI 触发范围，后续提交撤回此额外文案调整；移动端站点切换及繁体聊天演示保持不变。

## risks
- 静态片段下次导入时可能覆盖手工翻译；需同步修正导入脚本并增加回归检查。
- 繁体语言菜单的中国站入口沿用共享组件原有的简体“中国站”标签；后续需要在 opencraft guard 的 Node 环境修复后单独处理。

## validation
- 定向 Vitest：国内站 44/44 通过；国际站 14/14 通过。
- `pnpm check` 通过；TypeScript 171 项既有基线、0 项新增。
- `pnpm build:cn` 与 `pnpm build:global` 均通过；`git diff --check` 与脚本语法检查通过。
- 全量 `pnpm test` 涉及模型配置、文档、Agent 设置等多处既有失败并长时间无输出，已中止；首页相关 `home-play-badges.test.ts` 唯一失败为韩语玩法卡旧文案与测试预期不一致，HEAD 上已存在同一文案，未受本次改动影响。
- CI 触发范围修复后，`home-mobile-navigation.test.tsx` 在 CN / global 各 1/1 通过；`pnpm check` 通过（171 项既有 TypeScript 基线，新增 0 项）。

## decisions
- 复用现有 inline 语言切换器，避免出现另一套站点路由。

## scan_scope
- `frontend/next-site`、`frontend/scripts/import-international-homepage.mjs`、`frontend/public/lightvela-intl-home/index-fragment.*.html`。

## scan_output
- 有界源码搜索与静态片段抽样输出；无独立扫描产物。

## handoff
- MR !4573 已创建；本次针对失败 CI 的缩范围修复待复验并推送。主工作区未改动，未发布。
