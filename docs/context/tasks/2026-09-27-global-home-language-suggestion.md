## goal
国际站英文首页根据首次访问者的浏览器首选语言提示切换到已发布语言页面，并记住用户选择。

## non_goals
- 不自动跳转、不改变 SEO URL/canonical/hreflang、不改国内站或登录后路径。
- 不合并 MR、不发布或变更生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本会话确认的方案：首次进入国际站英文首页时，浏览器首选简体中文应提示切换；用户继续英文或选择中文后记住选择；无痕模式关闭后选择消失。
- 用户提供的 `CR-MR4677.md` 指出裸英文公开页自动写入会误判选择，并授权修复后更新原 MR。
- 用户本轮截图反馈：提示弹窗应在浏览器窗口居中，两个按钮居中，右上角增加叉号；点击叉号等同于继续使用英语。
- 用户后续反馈：弹窗高度在当前效果上再增加约 40%。
- 用户再次反馈：加高后的弹窗内部布局显得不协调，按钮应下移并整体优化留白。

## interface_refs / data_structure_refs
- `frontend/src/i18n/index.ts`：`lw-locale` 与 `setLocale`。
- `frontend/src/i18n/locales.config.ts`：已发布 locale 注册表。
- `frontend/src/lib/region.ts`：公开页面语言 URL。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`、`frontend/openspec/changes/2026-09-02-international-home-performance-v2-design.md`。
- relevant_evolution: 国际站根页面当前静态渲染英文，其他语言有独立公开 URL。
- superseded_refs: 无。

## acceptance
- 国际站 `/` 无偏好且浏览器首选为已发布非英文语言时显示提示；简体中文目标为 `/zh-sg/`。
- 首次先进入裸英文 `/subscribe` 等公开页，再访问 `/` 时仍可收到提示；手动切换或访问带语言前缀的 URL 后不重复提示。
- 明确语言 URL、已保存选择、英文或未支持浏览器语言、国内站均不提示。
- 切换和继续英文均保存选择；无痕存储清除后可再次提示。
- 提示弹窗水平与垂直居中，操作按钮居中；右上角关闭入口保留英文并保存明确选择。
- 简体中文提示的弹窗高度约从 108px 增至 150px，内容仍垂直居中；较长语言文案可自然撑高。
- 150px 弹窗中文案居中处于上半部，按钮行靠下；320px 窄屏换行时内容不溢出。
- 前端聚焦测试、`pnpm check`、`pnpm build:global` 与 change-impact 门禁通过；全量测试及首页性能预算的基线问题单独记录。

## affected_paths
- `frontend/src/components/site/browser-language-suggestion.tsx`
- `frontend/src/i18n/index.ts`
- `frontend/next-site/international-home-runtime.tsx`
- `frontend/next-site/__tests__/international-home-rendering.test.tsx`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- `site-environment-routing`、`frontend-product-surface`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@master` | 站点与 locale 边界 | 保持国内/国际分离 |
| `docs/context/project/services/frontend.md@master` | 前端服务边界 | 定位构建与测试门禁 |
| `frontend/AGENTS.md@master` | 前端实现规范 | 复用组件与验证命令 |
| `frontend/DESIGN.md@master` | UI 规范 | 提示层样式和交互 |
| `docs/engineering/domains/site-environment-routing.md@master` | 正式站点设计 | 同步本次 locale 决策 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@master` | i18n 邻接 | 检查注册表、实现与测试 |
| `docs/context/tasks/TASK-TEMPLATE.md@c42acf642` | Task Pack 结构 | 记录本轮需求和证据 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md@c42acf642` | 交接结构 | 更新验证与下一步 |
| `frontend/openspec/changes/2026-09-02-international-home-performance-v2-design.md@master` | 首页性能约束 | 保持静态首页与 SEO 输出 |
| `docs/context/domains/site-environment-routing.md@master` | CI 修复时复核 locale 边界 | 保持生成物修复不改变站点行为 |
| `docs/context/flows/tapd-gongfeng-delivery.md@master` | MR 交付边界 | 核验远端源提交与检查状态 |
| `opencraft/AGENTS.md@master` | OpenCraft 生成物契约 | 使用官方同步命令，不手改副本 |
| `opencraft/MONO2_MIGRATION.md@master` | mono2 与 OpenCraft 真源关系 | 明确 frontend 为真源 |
| `docs/context/project/upstream-subtrees.md@master` | OpenCraft 导入边界 | 不进行 subtree 操作 |

## evidence
- `pnpm exec vitest run ... --api.host 127.0.0.1`：首页、语言切换、页头和新提示 6 个测试文件、139 个测试通过。
- `pnpm check`：通过；TypeScript 171 current / 171 baseline，0 new。
- `pnpm build:global`：通过；664 静态页，SEO 检查 42 条公开路由。
- `pnpm build:cn`：通过；106 静态页，SEO 检查 8 条公开路由。
- 本地国际站开发预览 `http://127.0.0.1:5184/`：浏览器返回 200，英文首页正文、页头语言菜单和 Cookie 横幅可见，未见错误覆盖层；浏览器当前首选英文，中文提示由聚焦测试验证。
- `pnpm check:homepage-performance`：本轮与干净 master 均未通过，脚本数同为 28；raw 从 2,768,651 增至 2,771,192 字节，gzip 从 938,977 增至 939,796 字节。
- 全量 `vitest run --api.host 127.0.0.1` 出现多处非本次范围失败并长时间无进展后中断；其中 `scripts/intl-only-pages.test.ts` 失败已在干净 master 单独复现。
- `validate_documentation.py`：0 broken first-party links；`validate_change_impact.py --staged`：通过。
- MR !4677 的 CI 日志在 OpenCraft guard 报 `i18n/index.ts` vendored 副本漂移；本地 `check:mono2-agent-console` 复现相同 source/target SHA。运行 `sync:mono2-agent-console` 后，`check:mono2-agent-console` 校验 130 个文件通过；只变更生成副本与 `UPSTREAM.json`。
- OpenCraft `@opencraft/plugin-lightvela-hermes` 类型检查通过；`tests/lightvela-hermes-plugin.test.ts` 83 项通过。
- CR 后续修复：前端 6 个聚焦测试文件 147 项通过，国际站配置下 3 个聚焦测试文件 90 项通过；`pnpm check` 为 171 current / 171 baseline、0 new；`build:global` 为 664 静态页及 42 条公开 SEO 路由，`build:cn` 为 106 静态页及 8 条公开 SEO 路由。
- 本轮国际站首页性能预算仍未通过：28 个脚本（预算 22），raw 2,772,960、gzip 940,546 字节；相较上次 MR 构建分别增加 1,768 与 750 字节。
- 合入当前 `origin/master` 的 `3d6077da7` 后：前端聚焦测试 92 项、国际站配置测试 90 项、OpenCraft 插件测试 83 项通过；`pnpm check` 为 171 current / 171 baseline、0 new；国际站构建 664 静态页、42 条公开 SEO 路由通过，国内站构建 107 静态页、8 条公开 SEO 路由通过。
- 合并后使用官方脚本重新同步 OpenCraft 130 个文件并通过检查，插件类型检查通过；文档检查 0 条损坏的一方链接。
- 合并后的国内站构建产物仍未通过首页性能预算：28 个脚本、raw 2,772,944、gzip 940,134 字节；该预算在干净 master 上也未通过。
- 本轮布局与关闭优化：`browser-language-suggestion.test.tsx` 21 项通过；`pnpm check` 通过，TypeScript 171 current / 171 baseline、0 new。
- 本地 Chrome 在国际站英文首页、简体中文浏览器偏好下目视确认弹窗处于视口中心、按钮居中且右上角有关闭叉号；点击叉号后弹窗消失，刷新后仍不再显示。
- 本轮 `pnpm build:global` 通过：664 个静态页、42 条公开路由 SEO 检查通过；`validate_documentation.py` 结果为 0 条损坏的一方链接。构建生成的字体文件已还原，未纳入改动。
- 高度调整：浏览器实测简体中文提示高 150px，位于视口垂直中心；本地截图 `international-language-popup-taller.jpg`。组件测试 21 项与 `pnpm check` 通过，TypeScript 171 current / 171 baseline、0 new。
- 高度调整后的 `pnpm build:global` 通过：664 个静态页、42 条公开路由 SEO 检查；构建生成的字体文件已还原。
- 布局优化后本地 Chrome 桌面与 390px、320px 视口截图确认：文案和按钮有明确上下层次，按钮在窄屏自然换行且未溢出；桌面截图 `international-language-popup-balanced.jpg`。
- 布局优化后的组件测试 21 项、`pnpm check` 和 `pnpm build:global` 通过；TypeScript 171 current / 171 baseline、0 new；国际站生成 664 个静态页并检查 42 条公开 SEO 路由。生成的字体文件已还原。
- 英文和西语文案已在本地 Chrome 截图检查；截图专用触发代码已移除。原 MR !4677 已合并，本轮从最新 `origin/master` 的 `661d52da1` 开独立分支交付。

## risks
- 新增客户端组件增加首页脚本；运行首页性能预算。
- 提示与 Cookie 横幅同时出现；提示在视口中心，横幅在底部。
- 旧版仅存 `lw-locale=en-US` 的来源不可判定，可能再显示一次提示；`lw-language-suggestion-seen` 继续保证最多一次。

## validation
- 聚焦组件测试、前端 check/test/build 与仓库 change-impact 检查。

## decisions
- 只在裸英文首页提示，不进行自动跳转，以保留可直达的语言 URL 与静态 SEO 内容。
- 复用 `lw-locale` 保存当前语言，另记明确选择来源；无痕关闭后由浏览器清除。
- 用 `lw-locale-explicit` 区分手动切换、语言前缀 URL 与裸英文公开页的自动连续性写入；旧版非英文存储按明确选择迁移，来源不明的旧版英文存储允许再提示一次。

## scan_scope
- `frontend/src/i18n`、`frontend/src/components/site`、`frontend/next-site` 中的语言入口与测试。

## scan_output
- 精确检索命中 `frontend/src/i18n/index.ts`、`frontend/src/lib/region.ts` 与 `frontend/next-site/international-home-runtime.tsx`。

## handoff
- 用户已授权提交本轮布局与关闭优化的独立 MR；提交与远端状态以工蜂实时结果为准，未发布。
