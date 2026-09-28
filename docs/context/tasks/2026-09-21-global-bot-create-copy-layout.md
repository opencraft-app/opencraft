## goal

让国际站创建 Bot 弹窗的英文创建方式更自然，让继承说明标签在支持语种下保持单行、对齐且不挤压正文，并补齐国际站多 Bot 官网文档。

## non_goals

- 不修改 Bot 创建模式、继承范围、配额、站点门禁或后端接口。
- 不修改国内站文档，不合并 MR、不发布。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户截图：创建方式中的 `Create blank` 翻译需要校正；`Not inherited` 标签换行影响可读性。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-settings-page.tsx`：创建 Bot 弹窗。
- `frontend/src/i18n/generated/en-US.json`：`空白创建` 的英文译文。
- 保持 `createBotMode` 与 clone/blank 请求契约不变。

## history_context

- `current_design_refs`：`frontend/DESIGN.md`、`docs/context/domains/site-environment-routing.md`。
- `relevant_evolution`：MR !4308 已将多 Bot 前端能力带到国际站，本任务只处理上线后的文案与排版反馈。
- `superseded_refs`：无。

## acceptance

- 英文 `空白创建` 显示为自然、紧凑且符合实际继承行为的 `Basic setup`。
- `Inherited`、`Not inherited` 与 `Skills` 标签在说明区保持单行并按最长标签自动对齐。
- 创建模式及说明正文内容不变；聚焦测试、i18n 和前端检查通过。
- 国际站英文、简体中文文档准确说明多 Bot 创建方式、继承范围、切换与删除边界，并同步生成繁体中文产物、通过文档门禁；既有印尼语配置总览同步修正 Bot/Agent 事实。

## affected_paths

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/i18n/generated/en-US.json`
- `frontend/src/config/docs-sidebar.ts`
- `frontend/scripts/sync-fumadocs-content.mjs`
- `frontend/src/content/docs/{en,global,id}/05-configuration.md`
- `frontend/src/content/docs/{en,global}/configuration/bots.md`
- `frontend/src/content/docs/{es,ja,ko}/05-configuration.md`
- `frontend/src/content/docs/{es,ja,ko}/configuration/bots.md`
- `frontend/scripts/international-docs-parity.test.ts`
- `frontend/next-site/docs-route-manifest.ts`
- `frontend/src/content/docs/last-updated.json`
- `wiki/growth-state/lightvela-docs-content-categories.md`
- `docs/context/tasks/2026-09-21-global-bot-create-copy-layout.md`

## required_context

- `site-environment-routing`
- `frontend-product-surface`
- `adjacency-frontend-runtime-openspec-i18n`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@0ce20f94d` | 国际站 locale 边界 | 仅更新国际站英文翻译，不硬编码区域判断 |
| `docs/context/project/services/frontend.md@0ce20f94d` | 前端验证边界 | 选择聚焦测试与 locale parity 检查 |
| `frontend/AGENTS.md@0ce20f94d` | 前端硬规则 | 保持生成 contract 并补布局测试 |
| `frontend/DESIGN.md@0ce20f94d` | 弹窗与排版规范 | 使用正常文档流，不引入定位补丁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@0ce20f94d` | i18n 生成物邻接 | 核对生成入口、字典和相邻测试 |
| `frontend/src/i18n/index.ts@0ce20f94d` | 中文 key 运行时链路 | 保持中文 key，仅覆盖英文译文 |
| `frontend/scripts/i18n-extract.mjs@0ce20f94d` | 字典生成规则 | 避免新增或误删 hash key |
| `frontend/scripts/i18n-apply.mjs@0ce20f94d` | 翻译写入入口 | 通过中文原文定位并安全覆盖英文译文 |
| `docs/context/flows/tapd-gongfeng-delivery.md@d66a0b5f4` | MR CI 修复与交付边界 | 在现有 MR 上追加最小修复并重新核验远端状态 |

## evidence

- 英文 `空白创建` 通过 `i18n-apply` 覆盖为 `Basic setup`，未新增或删除 i18n key。
- 说明区使用 `grid-cols-[max-content_minmax(0,1fr)]`；生产构建 CSS 已包含对应 `grid-template-columns`。
- 聚焦 Vitest 3 文件 65/65 通过；`pnpm i18n:check` 与 `pnpm i18n:validate` 通过，0 个结构错误。
- `pnpm check` 通过，0 个新增 TypeScript 诊断；国际站构建 650/650 页面通过。
- 本地国际站首页及 `/agents/settings/?create=1` 返回有效页面且无 Next 错误覆盖层；localhost 无登录态，目标弹窗的浏览器截图验证未完成。
- 新增国际站 `configuration/bots`：英文与简中源文件齐备，`pnpm docs:sync` 已生成 `en-us`、`zh-sg`、`zh-hant` 页面；用户未要求新增印尼语页面，`id-id` 不生成该路由，既有印尼语配置总览已同步修正。
- 文档源文件 58 个相对链接均可解析；新增页无图片，配置总览继续使用现有 3 组英文/中文截图资源；源文件与生成物内部信息扫描无命中。
- `pnpm check` 再次通过，0 个新增 TypeScript 诊断；国际站完整构建通过，653/653 个静态页面生成，42 条公开路由 SEO 检查通过。
- 文档聚焦回归中，本次新增页的摘要结构问题已修复；最终仅剩 16 篇既有定时任务 use-case 缺少测试期望的摘要标题，未改动这些文件。

## risks

- `max-content` 标签列可能挤压窄屏正文；使用 `minmax(0,1fr)` 保留正文收缩能力，并在桌面/移动宽度检查。
- 英文翻译变更只影响 `空白创建` 标签，可回滚单个字典值。
- 国际站新建入口仍默认隐藏；文档明确标注分阶段开放，不把 `show()` 作为用户流程。

## validation

- 聚焦 Vitest：创建弹窗源码守卫与多 Bot 交互测试。
- `pnpm i18n:check`、`pnpm check`。
- 国际站本地预览截图，覆盖桌面及窄屏弹窗。
- `pnpm docs:sync` 并核对 `en-us`、`zh-sg`、`zh-hant`、`id-id` 生成页面。
- documentation、change-impact、diff-check。

## decisions

- 采用 `Basic setup`，比 `Create blank` 更符合英语产品文案，并准确体现仍保留基础模型、凭据和系统 Skills；长度也适合分段按钮。
- 说明区改为 `max-content + minmax(0,1fr)` 两列网格；不为单一语言写死宽度。
- 官网文档归入国际站「功能与配置 / Manage Bots」；同步英文与国际站中文，由同步器生成繁中。用户未要求新增印尼语页面，因此仅修正既有印尼语配置总览，国内站文档不新增页面。

## scan_scope

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- 相邻测试与 i18n 生成入口。

## scan_output

- 精确搜索命中创建弹窗、英文词条和一份源码守卫测试；未扩大扫描。

## handoff

- 当前：文案、布局和回归测试已完成，本地改动尚未提交或推送。
- 下一步：等待用户确认视觉方向后提交 MR；若需要目标弹窗截图，需在已登录 Chrome 中授权本地代理映射。
- 阻塞：localhost 无法复用国际站登录态，仅阻塞目标弹窗的浏览器截图，不阻塞源码与构建验证。

## MR 提交 checkpoint（2026-09-22）

- 用户已明确授权提交 MR。源码提交 `8425028ed` 后合并最新 `origin/master@7595dcaeb`，没有文本冲突；相对最新 master 的变更仍限定为本任务 14 个文件。
- 合并后聚焦回归 4 个文件共 50 项通过；唯一失败为 master 既有的 16 篇定时任务 use-case 缺少摘要标题，本任务新增页面的摘要、链接与语言结构检查均通过。
- 合并后 `pnpm check` 通过：TypeScript 171 current / 171 baseline / 0 new，i18n 结构错误 0；`pnpm build:global` 通过，654/654 个静态页面生成，42 条公开路由 SEO 检查通过。
- 文档完整性检查 errors 0、broken links 0、warnings 0；构建产生的字体子集噪声已恢复，工作树干净。
- 下一步：推送 `codex/global-bot-create-copy-layout` 并创建指向 `master` 的 MR；不执行合并或发布。

## MR !4391 CI 修复 checkpoint（2026-09-22）

- CI 的 `frontend` 守卫失败不是业务代码回归，而是新增英文与国际站中文 `configuration/bots` 后，完整语种日语、韩语、西班牙语仍停留在 71 条路由，和英文 72 条路由不一致；失败步骤共 10 个 parity 断言。
- 补齐 `es`、`ja`、`ko` 的 Bot 管理页和配置总览入口，同步文档更新时间与生成路由清单；印尼语仍按非完整语种保留 69 条路由，国内站保持 47 条路由。
- 国际站文档 parity 聚焦测试 44/44 通过；CI 同款 7 个测试文件 129/129 通过；`pnpm check` 通过，TypeScript 171 current / 171 baseline / 0 new。
- `pnpm build:global` 通过，657/657 个静态页面生成，42 条公开路由 SEO 检查通过。
- 当前：准备在现有 MR !4391 上提交并推送 CI 修复；不执行流水线重试、合并或发布。
