---
id: agents-daily-explore-navigation-task
type: task
scope: 将 Agents 侧栏改为日常与探索两栏，并整理侧栏账号菜单中的低频入口。
triggers: ["Agents 日常探索导航", "Agents sidebar Daily Explore"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-04-agents-daily-explore-navigation.md
status: active
reviewed_at: 2026-10-04
review_due: 2026-10-18
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：Agents 日常与探索导航

## goal

在最新 `origin/master` 上按用户确认的信息架构调整 Agents 左侧导航，保留现有页面、Bot 作用域与可见性；执行中删除会话须先停止并确认，再删除。

## non_goals

- 不更改通道、技能、定时任务、诊断或实验室页面功能。
- `show()` 隐藏工具和连接器的归属暂不额外重设计。
- 不提交、推送、创建 MR、发布或修改外部服务。

## requirement_ids / requirement_refs / requirement_excerpt

- `user-request-2026-10-04-agents-daily-explore-navigation`：日常含通道、技能、定时任务、对话及最近会话；探索按成长（人设、持久记忆、成就）→管理（模型、诊断中心、高级设置）→实验室（我的工作台、DeepSeek Harness）排列；侧栏底部小箭头菜单保留云存储等账户入口。
- 模型页面原有套餐权限逻辑维持；桌面及移动导航均需可达。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-settings-page.tsx`：侧栏 Tab、分组、会话列表与 Bot 作用域。
- `frontend/src/components/site/sidebar-user-menu-controller.tsx`：侧栏底部小箭头菜单内容。
- `frontend/src/lib/agent-plan-navigation.ts`：原 AI 类型套餐入口判断，仅作历史语义对照。
- `frontend/src/lib/agent-routes.ts`：现有路由路径不变。

## history_context

- `current_design_refs`：本轮用户逐项确认的导航结构；当前 `origin/master` 实现与相邻测试。
- `relevant_evolution`：现有侧栏是「探索／对话」双 Tab，设置分组中含使用、成长、管理、实验室。
- `superseded_refs`：`frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md` 仅用于理解原会话桥接，旧 Tab 结构不再作为目标。

## acceptance

- 日常和探索 Tab 在支持的 locale 中显示正确文案，深链与 Bot 切换打开相应导航。
- 对话与会话列表在日常栏可达；不可聊天的 Bot 仍显示准确禁用反馈。
- 对话标题在日常各页面默认展开，也可手动收起；加号从日常任意页面可新建会话，每个会话有图标，原重命名和删除入口保持可用。
- 执行中的会话在对应列表项显示转圈状态，任务完成后停止；状态与会话真实执行状态一致。
- 国内站执行中会话确认删除后先中断任务，等 Hermes 明确报告停止才关闭和删除；中断失败或超时保留会话。
- 探索按成长、管理、实验室排列；管理内依次为模型、诊断中心、高级设置；实验室既有 Beta 与云桌面条件保留。
- 实验室上方使用与日常对话区相同的分隔线，在桌面和移动导航中保持可见。
- 桌面侧栏的长会话列表在「对话」标题下独立滚动并显示纵向滚动条；日常入口、标题及底部账号入口保持可见，末尾会话操作菜单不被裁剪。
- 侧栏底部小箭头菜单保留云存储，移除模型、诊断中心和高级设置的重复入口。
- 聚焦交互测试、`pnpm check`、`pnpm test`、`pnpm build` 和相关 Context 检查取得结果。

## affected_paths

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`
- `frontend/src/pages/marketing/__tests__/opencraft-embedded-workbench-preload.cn.test.tsx`
- `frontend/src/styles.css`
- `frontend/src/components/site/sidebar-user-menu-controller.tsx`
- `frontend/src/components/site/sidebar-user-menu.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-*.test.*`
- `frontend/src/components/site/__tests__/sidebar-user-menu-controller.test.tsx`
- `frontend/src/i18n/generated/*.json`
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter.ts`
- `opencraft/tests/lightvela-hermes-plugin.test.ts`
- `opencraft/docs/chat-ui-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`
- 本 Task Pack。

## required_context

- Pack：`frontend-product-surface`。
- `must_read`：`docs/context/project/services/frontend.md`；最近服务入口：`frontend/AGENTS.md`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
| --- | --- | --- |
| `AGENTS.md@f3db0e91f` | 仓库边界 | 约束变更与交接 |
| `frontend/AGENTS.md@f3db0e91f` | 服务验证与 UI 规则 | 选择门禁 |
| `docs/context/project/services/frontend.md@f3db0e91f` | 路由 must_read | 双站边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@f3db0e91f` | 导航邻接 | 检查测试、规格和 i18n |
| `frontend/DESIGN.md@f3db0e91f` | 现有 UI 规范 | 沿用组件与样式 |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@f3db0e91f` | 旧导航历史 | 保留会话桥接约束 |
| `docs/context/domains/site-environment-routing.md` | 最新导航路由 must_read | 确认双站边界 |
| `docs/context/project/services/opencraft.md`、`docs/context/domains/agent-gateway-runtime.md`、`docs/context/domains/site-environment-routing.md`、`docs/context/project/upstream-subtrees.md`、`docs/context/project/services/ctl.md` | Hermes 删除路径路由 must_read | 确认执行归属和双站边界 |
| `opencraft/AGENTS.md`、`opencraft/docs/platform-architecture.md`、`opencraft/docs/chat-ui-architecture.md` | OpenCraft 服务与 Chat 事实 | 确认 Thread/Turn 生命周期与验证 |
| `docs/context/domains/site-environment-routing.md@f3db0e91f` | 本轮路由 must_read | 确认国内站 OpenCraft 边界 |
| `docs/context/domains/identity-access.md@f3db0e91f` | 本轮路由 must_read | 确认未触及登录会话契约 |
| `opencraft/AGENTS.md@f3db0e91f` | 嵌入工作台服务入口 | 执行状态桥接与验证 |
| `opencraft/docs/platform-architecture.md@f3db0e91f` | OpenCraft 邻接设计 | 确认嵌入部署边界 |
| `opencraft/docs/chat-ui-architecture.md@f3db0e91f` | 会话 UI 设计 | 对齐执行状态来源 |

## evidence

- `git fetch origin master` 后新 worktree HEAD：`f3db0e91f`，起始状态干净。
- 路由器命中 `frontend-product-surface`；有界精确搜索定位侧栏 Tab、分组、底部账号菜单、模型套餐判断及相邻测试。
- `pnpm check` 通过：TypeScript 0 个新增错误，i18n 结构校验通过。
- 用户确认英文使用 `Daily`；已将 `日常` 的 en-US 译文从 `Everyday` 调整为 `Daily`，复跑 `pnpm check` 通过。
- 按 2026-10-04 后续截图反馈，日常栏「对话」改为可展开标题、右侧加号与带图标的会话列表；非对话页点击加号会先进入对话并在会话命令就绪后创建。`pnpm check`、44 项聚焦导航测试、`pnpm build:cn` 通过。
- 根据后续反馈，日常各页面的对话区默认展开，箭头与列表统一按手动折叠状态变化；44 项聚焦导航测试、`pnpm check`（新增 TypeScript 诊断 0 项）通过。
- 根据截图反馈，将对话区箭头改为表达下一步动作：展开时朝上、收起时朝下，避免朝右被理解为页面导航。
- 会话菜单原有重命名与删除实现依赖聊天页加载 SDK/嵌入式工作台；国内站在日常栏展开时预备隐藏聊天实例，接收真实会话列表和操作句柄。默认会话仍不可删除，删除仍需二次确认；触屏设备的三点菜单按钮保持可见。聚焦测试 51/51、`pnpm check`（新增 TypeScript 诊断 0 项）、`pnpm build:cn` 通过，5174 预览已恢复 HTTP 200。
- 从其他日常页点会话进入聊天会重挂嵌入工作台；首次会话回传现在保留宿主已选中的有效会话，避免切回默认项。聚焦测试 51/51、`pnpm check`、`pnpm build:cn` 复跑通过，文档验证零错误零告警。
- 聚焦静态导航与侧栏账号菜单测试 59/59 通过；完整页面组件测试在 Vitest 导入阶段触发 worker heap OOM，未取得断言结果。
- `pnpm build:cn`、`pnpm build:global` 通过；`validate_documentation.py` 通过。
- `validate_context.py --build-catalog` 因仓库既有旧 Task Pack 缺元数据而失败，本 Task Pack 未出现在错误列表。
- 国内站本地开发服务器在 `127.0.0.1:5174` 可访问；匿名 `/agents/` 显示登录页，登录后视觉验证待补。
- 会话转圈状态由 OpenCraft 的 thread catalog `running` 投影到嵌入事件；Hermes 适配器把已缓存会话的执行状态传入 thread 列表。对应会话结束即移除状态，减少动态效果偏好时停止旋转。
- OpenCraft 相关测试 89/89、工作台与 Hermes 插件 typecheck、边界检查、预览桥接和嵌入工作台构建均通过；Frontend 聚焦测试 52/52、`pnpm check`、`pnpm build:cn` 通过。
- 国内站 `/agents/` 5174 与本地 OpenCraft 脚本 10001 均返回 HTTP 200；`validate_documentation.py` 无错误或告警，`git diff --check` 通过。
- Chrome/Whistle 登录态复核发现跨源本地 Vite 模块在加载阶段失败，页面显示「会话加载失败」。本地预览改为把已构建的 OpenCraft 静态包通过忽略的 `frontend/public/__opencraft` 符号链接挂在 5174，并将预览环境变量指向 `https://lightvela.com/__opencraft/embedded-workbench.js`；浏览器随后加载 3 条真实会话和历史消息。未修改 Whistle 规则或产品源码以处理此环境问题。
- 对话区加号改用现有 Portal Tooltip，hover/focus 文案为「新建对话」，移除原生 `title`；六种翻译已补齐。Chrome/Whistle 中聚焦检查确认提示框未受侧栏裁剪，聚焦测试 39/39、`pnpm check`（新增 TypeScript 诊断 0 项）和 `git diff --check` 通过。
- 对话列表展示标题时隐藏末尾 `· Oct 02 19:38` 这类英文日期时间后缀，原始会话标题不写回修改；重启后的 Chrome/Whistle 登录态列表已由「是的发生的 · Oct 02 19:38」变为「是的发生的」，会话操作仍在。相关测试 54/54、`pnpm check`（新增 TypeScript 诊断 0 项）、`pnpm build:cn` 通过，5174 预览已恢复。
- 对话区加号 hover 提示文案按最新反馈恢复为「新建对话」，与按钮无障碍名称一致；重新抽取 i18n，移除未使用的「新建一个对话」文案。
- 执行中删除的确认弹窗说明先停止任务；Hermes 适配器先中断，再读取执行状态，确认停止后才关闭/删除会话；失败时保留会话。
- 最新反馈将模型、诊断中心、高级设置从底部菜单移入探索「管理」，分组位于成长与实验室之间；云存储留在底部菜单，深链进入三个页面均选中探索。
- 本轮聚焦导航与账号菜单测试 60/60 通过；`pnpm check` 新增 TypeScript 诊断 0 项，国内站和国际站构建、文档检查、`git diff --check` 均通过。完整页面导航测试在 Vitest worker 导入阶段触发 OOM，未取得断言结果。
- Chrome/Whistle 登录态已确认探索中依次显示「成长 → 管理 → 实验室」，管理内依次是「模型 → 诊断中心 → 高级设置」；展开右下账号菜单仅显示云存储、套餐与费用、账号。5174 预览返回 HTTP 200。
- 移动端 Chrome/Whistle 登录态分别用 390px 和 320px 视口检查探索布局；320px 下日常的对话区默认展开，探索的模型入口可点击并进入模型页，`documentElement.scrollWidth` 与视口宽度同为 320px。国际站使用同一侧栏组件，`pnpm build:global` 已通过；本地未配置国际站的登录态代理，未做国际站浏览器视觉验证。
- 实验室上方已复用日常对话区的 1px 分隔线与上下间距；Chrome/Whistle 登录态在桌面和 390px 视口均能看到，移动页面宽度与视口相同。实验室现有 DSH、云桌面仍接收 `activeBot.id`；用户提出“不区分 Bot”的范围正在确认，未将视觉分隔误认为功能已解耦。
- 长会话列表已在桌面侧栏内独立滚动并显示 6px 滚动条；Chrome/Whistle 登录态用 15 条真实会话确认列表滚动到末尾时标题、日常入口和底部账号入口位置不变，末尾会话操作菜单完整可见。390px 移动端继续使用原抽屉整体滚动，实测内容高度超过抽屉高度时可滚动。
- 按 `frontend/AGENTS.md` 检查 OpenCraft Agent Console 生成副本时发现前端 i18n 与模型 locale 真源漂移；在提交前端真源后运行同步脚本，生成副本与 `UPSTREAM.json` 已更新，复跑只读同步检查及 Hermes 插件 typecheck 均通过。
- Hermes 插件完整测试 88/88（含三项删除生命周期测试）、37 项前端侧栏测试、OpenCraft 插件 typecheck/边界检查、`pnpm check`、国内站构建、嵌入工作台构建和文档验证通过；5174 页面与同源嵌入脚本均返回 HTTP 200。未对真实执行中的用户会话执行删除。

## risks

- 最新 `master` 的 AI 套餐模型入口曾在侧栏右下的账号菜单，其他套餐曾在主导航；本次统一移动到探索「管理」，模型页面自身的套餐权限逻辑保持不变。
- 日常合并会话列表后，需保留非主 Bot 的聊天禁用反馈、移动导航与会话操作。
- 国内站展开的日常栏会提前初始化隐藏的 OpenCraft 聊天实例以获取会话；跨路由会随主面板重新挂载。Chrome/Whistle 登录态已验证真实会话列表，但未对真实执行中的用户会话做破坏性删除验证。
- 原工作区存在大量未提交改动；所有实现仅在独立 worktree 完成。
- Hermes 仅能为本工作台已缓存的会话提供 `running` 状态；未缓存的其他客户端会话暂没有可信执行状态来源。匿名本地预览无法验证真实执行中的可视效果。

## validation

- 聚焦导航与账号菜单组件测试；国内站与国际站、窄屏入口检查。
- `cd frontend && pnpm check`、聚焦 Vitest 测试、国内站与国际站构建。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`。
- `git diff --check` 与适用的 change-impact 检查。

## decisions

- 本轮最终导航分组以用户最新消息为准；owner：用户。
- 侧栏底部保持现有小箭头触发，不新增「更多／管理」可见文案；owner：用户。
- 最新 `master` 中小箭头即账号菜单；最新位置决策为模型、诊断中心、高级设置进入探索「管理」，云存储保留在该菜单，套餐限制仍由模型页面自身处理。

## scan_scope

- `frontend/src/pages/marketing/agent-settings-page.tsx`、侧栏账号菜单、路由与模型套餐判断、相邻测试、旧 OpenSpec。

## scan_output

- 精确查询：`sidebarTab|settingsGroups|showHiddenAgentTools|云存储|模型|诊断中心|高级设置`；命中实现与聚焦测试。

## handoff

- 本地实现完成，5174 经 Chrome/Whistle 可访问并加载真实会话；转圈状态仍需执行中会话进行目视验证。移动端国内站 320/390px 已核对，国际站构建通过。待提交 MR，未合并、未发布。
