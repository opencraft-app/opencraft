## goal
核对最近三天 mono2 对话交互变更与双站官网现状，更新国内站和国际站文档中已过时的对话入口、操作说明及站内截图。

## non_goals
- 不修改产品交互、发布站点或操作生产资源。
- 不改第三方聊天软件界面截图。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-10-05）：完整检查国内站和国际站官网文档中涉及“对话”的功能、描述和截图，更新需要更新的内容。
- 用户补充：筛查最近三天 mono2 与 chat 模块相关的 MR。
- 用户后续授权（2026-10-06）：提交 MR。

## interface_refs / data_structure_refs
- `frontend/src/config/docs-sidebar.ts`：双站 sidebar 与 slug 映射。
- `frontend/scripts/sync-fumadocs-content.mjs`：文档注册与 locale 生成。
- `frontend/src/content/docs/`：文档源文件。

## history_context
- current_design_refs: 当前双站 `/agents/chat/` 页面、已合并 MR 与 `frontend/src/content/docs/` 源文件。
- relevant_evolution: 2026-10-02 至 2026-10-05 的 !5000、!5012 将国际站默认对话接入 OpenCraft；!4969、!4990、!4997 更新侧栏会话；!4994、!4947 更新国内站欢迎与加载态；!4941、!4965、!4967、!4978、!5014 更新移动端布局与键盘交互。
- superseded_refs: 无。

## acceptance
- 列出双站已注册文档中真正依赖旧对话交互的页面与图片，并更新过时处。
- 国内站与国际站文案各自符合实际功能；国际站已存在的翻译源同步。
- 图片从对应区域真实页面核对；无法复现的截图明确记录。
- `pnpm docs:sync` 和文档链接、图片、生成产物检查通过。

## affected_paths
- `frontend/src/content/docs/` 中命中的页面与图片。
- `frontend/public/docs-images/` 中同步的图片。

## required_context
- `site-environment-routing`、`frontend-product-surface`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@2.0.0` | 双站边界 | 内容分别核实 |
| `docs/context/project/services/frontend.md@2.1.0` | 文档真源 | 仅编辑源文件 |
| `frontend/AGENTS.md@current` | 前端验证边界 | 选择验证命令 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端邻接 | 核对实现与生成入口 |
| `frontend/src/content/docs/{configuration,global/configuration,en/configuration,id/configuration}/agent-chat.md@current` | 现有对话说明 | 找出过时描述 |

## evidence
- 工蜂只读鉴权成功，查询最近三天 mono2 MR；关键已合并 MR：!5000、!5012、!4969、!4990、!4994、!4997、!5018、!4947、!4941、!4965、!4967、!4978、!5014。
- 已登录 Chrome 中核对国内 `lightvela.com/agents/chat/` 与国际 `lightvela.ai/agents/chat/`：双站均显示新的欢迎语、输入框及 Daily/Explore 侧栏；国际站英语和简中均检查。未发送消息。
- Chrome 实际页面截图替换 `cn-chat-overview.webp`、`chat-overview.webp`、`chat-overview-en.webp`、`workbench-04-zh.webp`、`workbench-04.webp`，裁去底部账号头像；适配最新主线采用的 WebP 资源。
- 改写国内和国际既有 6 语言的对话说明、快速入门、首次创建、配置总览和产品概览；工作台截图/说明同步。国际站 `zh-hant` 由 `global` 源生成。最新主线的状态表已经标记 CN/GLOBAL 均已覆盖，无需改动。
- 从最新 `origin/master` 的独立工作树整合：主线最近重写了同批文档，因此以其套餐、Bot、图片格式和导航内容为底稿，仅迁入新版对话交互说明。
- 有界搜索：`rg` 在 `frontend/src/content/docs` 查 `AgentChat|对话页|聊天窗口|chat page|chat window|chat-overview|workbench-04`；第三方消息软件中的“聊天界面”与产品机制文章无需随网页 Chat 改动。
- `pnpm docs:sync` 在最新主线成功，生成 521 篇文档；改动文档的 391 个相对链接和图片引用均可解析；`git diff --check` 成功。
- 使用最新锁文件安装依赖后 `pnpm check` 通过（TS 诊断 166、baseline 171、新增 0）。初次借用旧工作区依赖软链产生缺包误报，已排除。
- 定向测试 international-docs-parity、docs-image-assets、doc-summary、docs-route-publication：58/58 通过；五张 WebP 源图均为 13–19 KiB。
- `validate_documentation.py`：0 错误、0 断链、0 未分类。

## risks
- 截图使用已登录页面中的空白新会话和未发送建站草稿，未验证真实模型回复、删除会话或移动端真机交互。操作说明其余部分依据已合并 MR 与源码。
- 原工作树已有大量非本任务改动；已在最新 `origin/master` 的独立工作树处理，不覆盖现存改动。

## validation
- `cd frontend && pnpm docs:sync`：最新主线通过。
- `cd frontend && pnpm check`：通过，新增 TS 诊断 0。
- 定向文档测试与图片检查：58/58 通过。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：0 错误、0 断链。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：暂存后执行。

## decisions
- 用户明确指定 `region: both`；国际站需检查已有印尼语源。

## scan_scope
- 已注册的双站文档、最近三天 chat MR、关联对话页面实现。

## scan_output
- 命中类别：对话主文档、快速入门、首次创建、配置总览、产品概览、工作台；涉及 CN、global/en/id/es/ja/ko 源，共 42 篇 Markdown、5 张源图、5 张同步图。状态表在最新主线已经准确。

## handoff
- 独立工作树 `codex/dual-site-chat-docs-refresh` 验证完成，待提交 MR；不合并或发布。
