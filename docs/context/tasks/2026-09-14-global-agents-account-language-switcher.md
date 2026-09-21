---
id: global-agents-account-language-switcher-2026-09-14
type: task
scope: Move the international Agent console language switcher into the account menu.
triggers: ["global Agent language switcher", "Agent account menu", "international locale menu"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-14-global-agents-account-language-switcher.md
status: active
reviewed_at: 2026-09-15
review_due: 2026-10-14
revision: 1.0.1
precedence: task
derived: false
---

## goal
把国际站 Agent 管理页头部的语言/站点入口移入用户账号菜单，只提供国际站已发布语言的切换。

## non_goals
- 不修改公开营销页、账号页或订阅页的语言切换入口。
- 不改变国内站 Agent 页面、跨站路由、登录、退出或账户管理行为。
- 不新增 locale，不修改后端、GitOps 或生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图反馈：国际站 Agent 页面左上角语言/站点入口应移到左下角头像和名称展开的菜单；菜单内保留国际站语言，移除国内站切换。

## interface_refs / data_structure_refs
- `frontend/src/components/site/language-switcher.tsx`：locale 注册表派生选项与切换行为。
- `frontend/src/components/site/user-avatar-menu.tsx`：桌面侧栏和移动端共用的账号菜单。
- `frontend/src/components/site/product-chrome.tsx`：产品页 header 是否展示语言入口的边界。
- `frontend/next-site/agents-page-client.tsx`、`frontend/next-site/app-route-shell.tsx`：Agent 正常态和加载态 header。
- 国际站语言列表必须来自 `SWITCHER_VISIBLE_LOCALES`，不得包含 `zh-CN` 国内站选项。

## history_context
- `current_design_refs`：`frontend/openspec/specs/marketing.md` 的区域隔离与语言切换约束。
- `relevant_evolution`：Agent 桌面端账号入口已移至左侧栏底部，header 仍保留国际站语言/站点切换器。
- `superseded_refs`：无。

## acceptance
- 国际站 Agent 正常态与加载态 header 不再渲染顶部语言/站点切换入口。
- 桌面侧栏账号区支持鼠标移入打开菜单；未进入右侧语言浮层时，鼠标移出后收起，同时保留点击与键盘操作。
- 国际站账号菜单展示“语言”二级菜单；桌面端鼠标移入该行即在一级菜单右侧打开独立选项框，点击和键盘触发仍然可用。
- 当前语言置顶且只显示选中对勾；鼠标 hover 打开时不自动聚焦第一项，选项行不显示灰色焦点框，键盘操作以文字下划线保留可见焦点，其余已发布国际站语言保持原顺序。
- 语言列表不展示“中国站”或其他跨站跳转；选择语言沿用 Agent 页 reload 行为。
- 国内站账号菜单不展示语言入口，现有行为不变。
- 键盘可操作，具有展开态与当前选项的可访问状态。
- 聚焦 Vitest、i18n 门禁、`pnpm check`、双区域构建及浏览器回归通过。

## affected_paths
- `frontend/src/components/site/language-switcher.tsx`
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/site/product-chrome.tsx`
- `frontend/next-site/agents-page-client.tsx`
- `frontend/next-site/app-route-shell.tsx`
- 相关测试与生成字典

## required_context
- Pack：`site-environment-routing`
- 前端服务规则：`frontend/AGENTS.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@a986f252f` | 仓库硬边界 | 约束 Task Pack、验证与提交权限 |
| `frontend/AGENTS.md@a986f252f` | 前端服务规则 | 确定 i18n、测试、构建和视觉验证门禁 |
| `docs/context/domains/site-environment-routing.md@a986f252f` | 路由器 must_read | 约束国内/国际站编译期隔离 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@a986f252f` | 前端邻接卡 | 检查 locale 真源、生成字典与构建邻居 |
| `frontend/openspec/specs/marketing.md@a986f252f` | 当前产品壳规范 | 保持 `isGlobal` 区域分支与 locale 只影响文案 |

## evidence
- TDD RED：实现前新增 4 条断言失败，分别锁定国际站语言清单、账号菜单入口与 Agent 正常/加载态 header 边界。
- 聚焦 GREEN：语言菜单与账号菜单 2 个测试文件、24 条用例通过；覆盖账号区 hover 打开/移出关闭、语言行 hover 展开、点击打开、当前语言置顶且仅显示对勾，以及进入右侧语言浮层后一级账号菜单不误关。
- MR !4010 CR 修复：国际语言列表增加精确 locale code 顺序断言；国际站旧菜单预期补齐日语和韩语；header 账号菜单进入 Portal 语言浮层时不再被 `mouseLeave` 误关；账号触发器连续点击仍保持打开的产品意图已由测试锁定。
- CR 后双区域聚焦验证：国内站 3 文件 29/29，国际站 3 文件 29/29。
- CR 后 `pnpm check`：通过；i18n 提取 2874 条、0 error，TypeScript 相对基线 0 个新增诊断。
- `pnpm check`：通过；i18n 提取 2866 条、0 error，TypeScript 相对基线 0 个新增诊断。
- `pnpm build:cn`：通过，97 个静态页面。
- `NEXT_PUBLIC_LOCAL_PREVIEW_AUTH=1 pnpm build:global`：通过，607 个静态页面。
- Chrome 国际站桌面实测：顶部语言按钮 0 个；账号菜单包含 7 个国际站 locale，China Site/中国站入口 0 个；页面无横向溢出。
- Chrome 国际站桌面二级菜单实测：语言浮层位于一级菜单右侧（一级菜单右边缘 236px，浮层左边缘 244px），一级菜单高度不因语言选项展开而增加。
- Chrome 国际站移动端实测：语言浮层宽度收窄并自动向左避让，左边缘 24px、未被视口裁切；页面仍有约 15–27px 既有横向溢出，本任务不扩大范围修复。
- 选择 `zh-SG` 实测触发 reload，文档语言切换为简体中文。

## risks
- 隐藏 header 入口后移动端无语言入口：Agent 移动端继续使用同一 `UserAvatarMenu`，语言项随账号菜单可达。
- 语言列表漂移：只从 `SWITCHER_VISIBLE_LOCALES` 派生，并补回归测试。
- 回滚：回退本任务 UI 与测试变更即可恢复原入口。

## validation
- 聚焦 Vitest：语言切换、账号菜单、Agent 加载边界。
- `pnpm i18n:extract`、`pnpm i18n:check`、`pnpm i18n:validate`。
- `pnpm check`、`pnpm build:global`、`pnpm build:cn`、`git diff --check`。
- 国际站桌面与移动端浏览器验证；国内站负向 smoke。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。

## decisions
- `ProductReturnHomeHeader` 增加显式可覆盖开关，默认保持其他产品页现状；仅 Agent 正常态和加载态关闭顶部入口。
- 账号菜单语言项复用现有 locale 注册表和切换函数，不复制语言常量，不提供跨站按钮。

## scan_scope
- `frontend/src/components/site/`
- `frontend/next-site/`
- `frontend/src/i18n/`
- `frontend/openspec/`

## scan_output
- 已有界定位产品 header、账号菜单、语言切换器、Agent 加载壳及对应测试。

## handoff
- 状态：MR !4010 CR 修复已在本地实现并通过验证，尚未 commit、push 或更新 MR。
- 阻塞项：无。
