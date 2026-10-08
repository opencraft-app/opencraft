---
id: agents-bot-rail-implementation
type: task
scope: Dual-site Agents Bot rail implementation and handoff.
triggers: ["agents bot rail", "agents overview removal", "agents frontend implementation"]
owner: pablozhong
authority: primary
source_of_truth:
  - wiki/prd-docs/2026-10-08-agents-bot-rail.md
status: active
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

# `/agents` Bot 独立竖栏实现

## goal
基于 `wiki/prd-docs/2026-10-08-agents-bot-rail.md` 实现双站 Bot 竖栏、切换后新会话、总览退场和账号权益入口。

## non_goals
- 不修改 Bot、套餐或会话后端 contract；不执行生产、GitOps、发布或外部写操作。
- 不重排「日常／探索」内的现有配置导航，不删除独立产品动态与定时任务功能。

## requirement_refs
- 用户 2026-10-08 确认双站同步、最左竖栏头像一键切换，后续明确移除总览、切换进入新会话、账号权益迁出总览；随后要求桌面多 Bot 宽侧栏移除 Bot 卡片。右上角账户入口试用后，用户决定恢复左下角位置。最新交互将 Bot 管理入口移至最左竖栏底部，配置分区取消 Bot／页面名称顶栏，头像间距加大且选中态使用头像同色系浅背景、无外圈描边。
- PRD 和可点击原型见 `wiki/prd-docs/2026-10-08-agents-bot-rail.md` 与同目录 `demos/2026-10-08-agents-bot-header-proposal.html`。

## requirement_ids / requirement_excerpt
- `agents-bot-rail-2026-10-08`：双站 Bot 头像独立切换；移除总览，进入目标 Bot 新会话；账户权益由左下角账户入口查看。

## interface_refs / data_structure_refs
- `frontend/src/lib/agent-routes.ts`：保留 `?bot=`，旧 overview URL 指向 chat。
- `frontend/src/pages/marketing/agent-settings-page.tsx`：`visibleBots`、`multiBotEnabled`、`handleSelectBot` 与会话命令，保持 Bot 作用域隔离。

## history_context
- current_design_refs：`wiki/prd-docs/2026-10-08-agents-bot-rail.md`、`frontend/DESIGN.md`。
- relevant_evolution：开发前 `origin/master` 同步到 `e32b6e8e9`；原宽栏 Bot 选择器与总览的账号信息需要迁出。
- superseded_refs：`wiki/prd-docs/2026-09-28-multi-bot-overview.md` 仅用于核对旧入口。

## acceptance
- 双站桌面竖栏与移动端头像条按能力开关显示；桌面宽侧栏从日常／探索开始，聊天顶栏仅保留已有会话名称与编辑入口，配置页不显示 Bot／页面名称顶栏，竖栏底部管理菜单与左下角账户入口可达；切换 Bot 新建会话；旧总览 URL 跳转。
- `pnpm check`、相关测试、双站构建和 OpenCraft 同步检查有明确结果。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`、`opencraft/apps/workbench-web/src/` 的嵌入式顶栏、相关组件、文案与测试。
- `docs/engineering/domains/agent-gateway-runtime.md`：OpenCraft 会话标题、重命名与预览开关所有权。
- `wiki/prd-docs/2026-10-08-agents-bot-rail.md` 及本 Task Pack。

## required_context
- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt
| 文件 | 用途 |
| --- | --- |
| `AGENTS.md`、`frontend/AGENTS.md` | 仓库边界、前端验证与 OpenCraft 同步门禁。 |
| `docs/context/project/services/frontend.md` | 双站前端责任。 |
| `docs/context/domains/identity-access.md` | 本轮路由器的会话关键字命中；确认未触及身份或授权边界。 |
| `docs/context/domains/site-environment-routing.md` | 双站发布与能力开关边界。 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 识别 OpenSpec、locale 与相邻测试。 |
| `frontend/DESIGN.md` | 布局、弹层与可访问性约束。 |
| `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css` | 当前 Bot 切换、侧栏、路由与响应式实现。 |
| `frontend/src/lib/agent-routes.ts`、`frontend/src/pages/marketing/agent-creating-loading.tsx`、`frontend/src/pages/marketing/__tests__/agent-create-bot-paths.test.tsx` | 新建 Bot 的历史状态、等待文案与路由回归。 |
| `frontend/src/components/site/sidebar-user-menu-controller.tsx`、`sidebar-user-menu.tsx` | 底部账户入口现有数据与弹层。 |

## baseline
- 用户要求动手前同步 master。已 `git fetch origin master` 并在当前独立工作树快进至 `e32b6e8e9`；本地 PRD／Demo 未丢失。
- 当前实现的选择器在 Bot 卡片 Popover；`handleSelectBot` 保留原分区。国内站默认总览，国际站默认通道。总览卡片独有资料编辑和复制 Bot。
- 当前账户菜单已有套餐名称及已用／总积分进度，需补服务天数、有效期、剩余积分、Bot 数及邀请数，避免误报未知值。

## implementation
- 最左竖栏列出当前可切换 Bot 并显示各自状态，头像间距 12px，选中态取头像同色系浅色背景（颜色混合比例 8%）、无外圈描边；新增入口固定，管理入口置于竖栏底部账户区上方，向右展开资料编辑、复制、重启／修复及删除菜单。移动端在导航抽屉顶部提供横向头像条。多 Bot 桌面端宽侧栏移除 Bot 卡片，聊天主内容顶栏仅显示已有会话名称与编辑入口，配置页不显示 Bot／页面名称顶栏；单 Bot 和移动端保留原卡片。对话标题与重命名仍由 OpenCraft 持有；嵌入新建会话隐藏右侧预览入口，已有会话保留预览能力。
- 桌面新增 Bot 的虚线框高 32px，与右侧会话行一致；外层按钮仍为 44px 点击区域。
- 桌面多 Bot 展开态为 56px Bot 竖栏加 232px 功能导航栏，顶部品牌区与底部账户区均宽 288px、高 60px；折叠态两列各宽 56px，上下区同高。
- 路由鉴权与 Bot 数据等待复用同一骨架组件；多 Bot 加载态按最终三列栅格与折叠宽度绘制，左侧去 Bot 卡片并保留账户占位，聊天主区使用问候语与输入框占位；单 Bot 保留原侧栏骨架。
- 选择另一 Bot 时清理旧会话句柄，导航到目标 `chat?bot=` 并创建空白新会话；重复点击当前 Bot 不做无谓操作。
- `/agents` 默认 chat；旧 overview URL 兼容跳转，保留合法 Bot 参数；创建和引导完成落到新会话。其他配置分区深链保持原落点。
- 已有 Bot 的新建入口将创建引导写入可返回的 URL 状态，浏览器返回恢复此前 `/agents` 分区；创建等待提示由“可能需要几分钟”改为通常 10 秒内完成，超时后显示实际等待秒数。
- 移除总览页面入口与其产品动态／定时任务推荐展示。账号级权益显示在左下角账户弹层；桌面多 Bot 的账号区横跨 Bot 竖栏与宽侧栏至页面左边缘，单 Bot 和移动端继续使用原侧栏入口。
- 桌面收起侧栏的 Bot 头像、新建 Bot 与功能导航图标统一使用右侧 Portal 提示，视觉对齐顶部「展开导航」；移动端头像条保留原有提示方向。

## validation
- 聚焦组件与路由测试覆盖切换、创建限制、管理入口、账户数据、总览旧链接与移动端。
- 运行 `frontend` 的 `pnpm check`、聚焦测试、双站构建及 `npm --prefix opencraft run check:mono2-agent-console`；必要时核对同步副本。
- 浏览器核对桌面与手机视口，检查无横向溢出和新会话落点。

## validation_result
- 已同步 `origin/master` 至 `e32b6e8e9`；`pnpm check` 无新增 TypeScript 诊断，国内站 `pnpm build`、国际站 `pnpm build:global` 均成功。
- 相关的 8 个测试文件单工作进程复跑：7 个文件 176 条通过；诊断页 mock 稳定后单独跑 13 条通过，共 189 条。旧总览入口、Bot 竖栏、创建后对话落点均有针对性断言。
- 全量 `pnpm test` 已执行，仓库中多个旧文案、旧路由和环境测试失败，另有既存重型测试在 Vitest worker 中内存耗尽；本需求相关回归集通过，未将全量门禁报告为通过。
- `npm --prefix opencraft run check:mono2-agent-console` 检出预期的生成副本漂移。按 `frontend/AGENTS.md`，须先获准提交 frontend 真源，再生成 OpenCraft 副本并独立提交，确保 `UPSTREAM.json` 中的 `sourceRevision` 指向实际源码提交。本次尚未获得 Git commit 授权，故未执行生成同步。
- `validate_documentation.py`、`git diff --check`、以全部 35 个实际改动路径运行的 `validate_change_impact.py --changed-files-file` 通过；本次源码未触及 change-impact 映射规则。
- `validate_context.py --build-catalog` 仍被仓库中大量既有 Task Pack 缺字段阻断；本次 Task Pack 的 frontmatter 已补齐，未把该全仓结果报告为通过。
- 顶栏原型获批后，`pnpm check` 再次通过（0 个新增类型诊断），OpenCraft 内嵌发布构建通过，侧栏聚焦测试 40/40、OpenCraft 导航测试 35/35、文档校验及 `git diff --check` 通过。国内站 5174 已登录桌面实测：新会话顶栏显示 Bot／新建对话、历史会话保留标题及重命名、管理菜单四项可展开、技能页顶栏与侧栏布局正常。嵌入式菜单触发器移到 Shadow DOM 外，修复了弹层立即关闭的问题。
- 本轮改动后的 `pnpm build:cn`、`pnpm build:global` 均通过；含 OpenCraft 源码的变更集合通过 `validate_change_impact.py --changed-files-file`，映射设计文档已同步。5174 按本地预览约定以 `NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL=/__opencraft/embedded-workbench.js` 重启，已登录 Chrome 再次看到真实会话与新建对话，预览继续可用。
- 账户入口右上角调整后，`pnpm check` 无新增 TypeScript 诊断，OpenCraft 内嵌构建成功，账户／侧栏聚焦测试 86/86。国内站 5174 实测：右上角显示头像、姓名、套餐，账户弹层向下展开并显示权益；技能页与折叠侧栏的入口仍可达。
- 最新右上角调整的 `pnpm build:cn`、`pnpm build:global`、文档校验、change-impact 及 `git diff --check` 通过。构建产生的 `next-env.d.ts` 和字体子集临时改动已还原；5174 带同源 OpenCraft 嵌入脚本参数恢复，已登录 Chrome 再次显示新建会话与右上角账户入口。
- 用户随后否决右上角试用，账户入口已恢复为宽侧栏左下角，账户弹层恢复向上展开；右上角只保留 Bot 管理菜单与原预览开关。最终门禁与 5174 回归结果见本轮交接。
- 用户进一步要求左下账号区延伸到最左侧；桌面多 Bot 账号区现固定横跨两条左栏，Bot 列表在账号区上方独立滚动。5174 实测展开时账号区从 x=0 至 x=304px，折叠时至 x=128px，账号入口和权益弹层可用；`pnpm check` 无新增类型诊断，4 个聚焦测试文件 85/85、OpenCraft 内嵌发布构建、文档校验、change-impact 与 `git diff --check` 通过。
- 用户要求新建会话隐藏右侧预览按钮，已有会话保留；Bot 管理入口移至顶栏名称旁并改用设置图标。OpenCraft 按内嵌会话身份控制右侧面板，站点宿主将管理菜单与 Bot 名称放入同一个顶栏 slot。5174 已登录页面实测新建页无按钮、历史会话有按钮、管理菜单可展开；前端聚焦测试 48/48、OpenCraft 内嵌呈现测试 1/1、嵌入发布构建与 `pnpm check` 通过。
- 最新反馈要求新建会话顶栏移除“新建对话”占位文案及其分隔符，已有会话标题保留由 OpenCraft 呈现；其他配置分区标题不变。5174 已登录页面实测新建顶栏仅含 Bot 名称和管理图标，打开历史会话后斜杠与原标题出现；聚焦测试 48/48、`pnpm check`（0 新增类型诊断）、文档校验与 `git diff --check` 通过。
- 最新交互将管理图标固定在最左 Bot 竖栏底部账户区上方，聊天页仅保留 Bot／已有会话标题，通道和技能等配置分区取消 Bot／页面名称顶栏；头像间距改为 10px，选中态取头像同色系。5174 已登录国内站核对菜单四项、真实聊天标题、通道与技能页、头像选中颜色和布局。3 个聚焦测试文件 61/61、`pnpm check`（0 新增类型诊断）、`pnpm build:cn`、`pnpm build:global`、文档检查、包含全部 44 个变动路径的 change-impact 检查及 `git diff --check` 均通过。构建临时生成文件已还原，5174 已恢复。
- 用户随后要求去掉选中头像的外圈线条；选中态仅保留同色系浅背景。5174 已登录国内站的计算样式确认边框为 `0px / none`，相关聚焦测试 48/48 通过。
- 用户要求会话页左上角只显示已有会话名称及编辑按钮。站点宿主已撤除 Bot 名称投影及无用的具名顶栏 slot，由 OpenCraft 独立呈现会话标题与重命名；新会话左上角无占位标题。5174 已登录国内站核对新会话空标题、已有会话名称及编辑按钮；前端定向测试 61/61、OpenCraft 定向测试 1/1、`pnpm check`（0 新增类型诊断）、内嵌构建、国内站及国际站构建、文档与完整变更影响检查均通过。前端 Vitest 默认监听曾因本机 `localhost` DNS 解析失败，改用 `--api.host 127.0.0.1` 后通过。

## risk_and_handoff
- 主页面体量大，修改保持局部；当前 Bot 切换时不得闪现旧 Bot 会话或让旧操作句柄作用于新 Bot。
- 新需求本地实现，Git commit、push、MR 与发布仍待用户分别明确确认。
- 国内站桌面顶栏已完成真实登录账号视觉与基础交互回归；国际站及手机视口仍需独立核对。
