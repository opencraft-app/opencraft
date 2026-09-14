## goal
让 Agent 管理页的桌面端左侧导航更靠近浏览器左侧，把 LightVela Logo 放到侧栏顶部，并把用户头像与账户菜单从右上角移到侧栏底部；移动端保持原顶部 Header 与账户入口。

## non_goals
- 不调整 Agent/Bot、设置分组的既有导航顺序、路由、文案或宽度。
- 不调整账户页等其他复用 `.lw-settings-shell` 的页面。
- 不扩展账户菜单功能或修改登录、退出、套餐逻辑。
- 不提交、推送、创建 MR 或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户需求（2026-09-13）：调整 LightVela Agent 管理页面布局，让左侧导航靠近浏览器左侧；开始前同步 master。
- 用户截图反馈（2026-09-13）：48px 仍然偏中间，参考 Viktor 贴近视口左侧的侧栏位置继续调整。
- 用户截图反馈（2026-09-13）：参考 Viktor，把右上角头像和点击后的管理列表移到左侧导航最下面。
- 用户截图反馈（2026-09-13）：Bot 信息下方、反馈入口上方、账户入口上方三条分隔线应撑满左侧导航内容宽度。
- 用户再次截图反馈（2026-09-13）：`100%` 仍停在 28px 右内边距前，三条线应继续延伸到侧栏最右竖分隔线。
- 用户第三次截图反馈（2026-09-13）：底部账户分隔线右端已对齐，但左端仍应越过 16px shell 留白贴到视口左边。
- 用户 Viktor 参考截图（2026-09-13）：桌面 Agent 页的 LightVela Logo 应位于左侧导航顶部，而不是由横跨内容区的顶部导航承载。
- 用户 Logo 调整后截图反馈（2026-09-13）：Logo 区与侧栏主体之间的右侧竖线不能断开，且两者之间空白需要明显收紧。
- 用户紧凑布局截图反馈（2026-09-13）：Logo 区底部增加一条仅覆盖侧栏宽度的横向分隔线，与下面导航内容区分。
- 用户增加分隔线后截图反馈（2026-09-13）：Logo 与 Bot 信息组成的顶部区域过挤，需要在分隔线下方增加适度留白。
- 用户最新截图反馈（2026-09-13）：移除 Bot 信息下方、探索/对话切换上方的横向分隔线。
- 用户移除横线后截图反馈（2026-09-13）：Bot 信息与探索/对话切换之间的空白高度稍微缩小。
- 用户最新截图反馈（2026-09-13）：Logo 底部横线与 Logo 之间的间距稍微增大。
- 用户后续反馈（2026-09-13）：桌面左侧导航整体宽度稍微调小。
- 用户字体反馈（2026-09-13）：核对顶部 Bot 名称与左下角账户名称字号；若顶部更大，则将其调小并保持一致。
- 用户刷新态反馈（2026-09-13）：页面刷新期间的 loading 骨架仍使用旧版居中卡片布局，需要与当前 Agent 新布局保持一致。
- 用户确认（2026-09-13）：把“微信已被占用”提示移到通道标题说明文案下方、通道卡片之前，并检查其他 Agent 页面里的多 Bot 提示是否存在相同层级问题。
- 用户最新截图反馈（2026-09-13）：移除反馈入口上方横线，把“有建议？提交反馈”下移到账号区附近，去掉侧栏横向滚动条，并将右侧内容再整体上移一点。
- 用户追加截图反馈（2026-09-13）：缩小账号区分隔线与头像内容之间的空白高度。
- 用户 Logo 留白确认（2026-09-13）：上下留白应保持一致，下方留白可以比现状小。
- 用户 CR 修复确认（2026-09-14）：移除导航间距测试中与既有续费徽章单行契约冲突的新增断言；不改变续费展示行为，不扩大到非阻塞观察项。

## interface_refs / data_structure_refs
- 无 API、事件或数据结构变更；复用同一 `UserAvatarMenu` 账户动作。
- 保持 `/agents` 国内站与国际站复用同一 `AgentSettingsPage` 的不变量。
- 桌面端 Header 与侧栏之间任何时刻只挂载一份账户菜单；移动端仍由 Header 挂载。

## history_context
- `current_design_refs`：`frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`。
- `relevant_evolution`：`575146b587bda21e51c94f1538266495783719f2` 曾把 Agent 布局扩到 1760px；`26f7d9d69de4f24fe89f9977aeae7a23d621e346` 因共享静态入口将通用 shell 收回 1440px。
- `superseded_refs`：无。

## acceptance
- 1024px 及以上视口中，Agent 管理页 shell 使用 16px 左侧视口留白并以 1760px 为最大宽度。
- 共享 `.lw-settings-shell` 的 1440px/160px 规则保持不变。
- 1024px 以下 Agent 页面布局保持现状。
- 1024px 及以上时，Agent 设置页 Header 不再显示头像，侧栏底部显示头像、用户摘要及同一账户菜单；菜单向上展开。
- 1024px 以下时，侧栏账户入口不挂载，Header 头像保持可用。
- `/agents/workbench` 不具备设置侧栏，继续保留桌面 Header 头像。
- 1024px 及以上时，Agent 设置页 Header 仅占左侧 280px 视觉侧栏，Logo 与侧栏内容保持 16px 左对齐，右侧内容区不再出现横贯页面的 Header 底线。
- Agent Header、内部容器、主内容 shell 与侧栏 sticky 起点在桌面端统一为 68px，右侧竖线连续；32px Logo 上下留白均为 18px。
- Agent Header 底部使用与侧栏其余分隔线一致的 `#e9ecf1` 1px 横线，范围为 296px 侧栏列，不延伸进主内容区。
- 分隔线下方与 Bot 信息之间保留 12px 桌面侧栏内边距；移动端布局不变。
- Bot 信息下方和反馈入口上方不再绘制分隔线；保留 Logo 底部与账户入口上方的分隔线。
- Bot 信息容器底部间距由 16px 收紧为 8px；不改变 Logo 与 Bot 信息之间的 12px 顶部留白。
- 桌面侧栏网格轨道由 280px 收窄至 264px；包含 16px 左侧延伸区域的 Header 与侧栏视觉边界由 296px 收窄至 280px，内部 220px 导航项保持不变。
- 顶部 Bot 名称字号由 16px 调整为与左下角账户名称一致的 14px，行高同步为 20px；状态文字及其他导航字号保持不变。
- 鉴权 loading 与 Agent 数据 loading 复用同一骨架内容：桌面使用 68px 顶部、280px 视觉侧栏、264px 网格轨道、16px 左锚点和白色背景；移动端保持单列且无横向溢出。
- 1024px 以下与 `/agents/workbench` 的 Header 布局保持现状。
- 微信占用提示的顺序为通道标题、说明文案、占用提示、通道卡片；提示文案和“前往管理”交互保持不变。
- 检查 Agent 页面中的其他多 Bot 提示，页面级提示不得出现在对应标题上方；动作限制继续贴近按钮、toast 或对话框。
- 导航布局测试只覆盖本次布局边界，不重复或反向定义既有续费徽章的单行展示契约。
- 桌面端反馈入口使用剩余空间下沉到账号区上方，与账号区保持 8px 间距；无反馈入口的页面仍由账号区自身贴底。
- 账号区分隔线后的顶部内边距由 16px 收紧为 8px，分隔线、头像尺寸与账户菜单交互保持不变。
- 桌面侧栏滚动容器禁止横向滚动，不再显示横向滚动条；纵向滚动能力保持不变。
- 桌面右侧内容相对 shell 顶部上移 24px，Loading 与正式内容继续共用同一几何 class。
- 三条侧栏分隔线延伸到 280px 侧栏的右侧 1px 竖边界前，不再受 220px 导航项宽度或 28px 右内边距限制。
- 聚焦 Vitest、前端 lint/typecheck/test 门禁、`git diff --check` 通过，并完成桌面与窄视口的页面级检查。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-channel-panel.tsx`
- `frontend/src/pages/marketing/agent-settings-loading-view.tsx`
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/site/public-site-header.tsx`
- `frontend/src/components/site/product-chrome.tsx`
- `frontend/next-site/agents-page-client.tsx`
- `frontend/src/styles.css`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- `frontend/src/components/site/__tests__/site-header.test.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-channel-context-notice.test.tsx`
- `docs/context/tasks/2026-09-13-agent-nav-left-alignment.md`

## required_context
- `frontend-product-surface`
- `docs/context/project/services/frontend.md`
- `frontend/AGENTS.md`
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@2.1.0` | Context 路由 must_read | 确认双站复用与前端验证边界 |
| `frontend/AGENTS.md@5eeed5b80` | 最近服务级指令 | 确认视觉变更需聚焦截图或组件测试 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 布局变更邻接卡 | 核对 OpenSpec 与相邻测试入口 |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@5eeed5b80` | 当前侧栏结构历史 | 保持侧栏交互和主区路由不变 |
| `frontend/openspec/specs/marketing.md@5eeed5b80` | Header 响应式约束 | 保持账户菜单单实例与移动端入口 |
| `frontend/openspec/specs/auth.md@5eeed5b80` | 头像菜单职责 | 复用既有会话、账号与退出逻辑 |

## evidence
- `git fetch origin master`：工作基线为 `origin/master@5eeed5b8080abf06e3f54970eb18a6f11e94f796`。
- 有界搜索定位到 `AgentSettingsPage` 的 `.lw-settings-shell`、两列网格、`.lv-agents-sidebar` 与相邻 `agent-settings-nav-spacing.test.ts`。
- `git blame`/`git log -S` 证明通用 shell 当前桌面最大 1440px，历史 Agent 稳定布局曾使用最大 1760px。
- 第一轮为 Agent 页增加 `lv-agent-settings-shell`，桌面端左留白 48px；用户截图反馈后进一步收至 16px，宽度同步为 `min(1760px, calc(100vw - 32px))`；共享 shell 规则未改。
- 聚焦 Vitest 新增布局用例通过（1 passed）；当时完整相邻文件中本次两个布局用例通过，但该分支新增的 renewal badge 断言与既有单行契约冲突并失败。
- `pnpm check` 通过：i18n、文档、MDX 与类型基线完成，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- `pnpm typecheck` 通过：0 个新增诊断。`pnpm lint` 不可运行，因为当前 package 没有 `lint` script。
- `pnpm test` 完整运行：244 files / 3075 tests passed；16 files / 113 tests failed，另有 1 个 worker OOM，失败来自 master 既有模型配置 Python 依赖、静态资源、字典、价格与旧断言等基线，不涉及本次新增布局用例。
- 第二轮本地 CN `/agents/` 返回 HTTP 200，无 Next/Vite error overlay；自动化会话无登录态。真实 CSS 布局探针测得：1920px 时 shell/sidebar left=16px、shell width=1760px、sidebar width=280px；1024px 时 left=16px；900px 时保持原规则 left=80px、sidebar width=740px。
- 第二轮聚焦 Vitest 通过：2 passed / 1 skipped，覆盖 Agent 专用 shell 与既有桌面/移动间距边界。
- 第三轮复用 `UserAvatarMenu` 新增 `sidebar` 展示形态；`PublicSiteHeader` 可只移出桌面头像，移动端仍挂载，Next Agent 设置路由在 Workbench 之外启用该行为。
- 新增账户菜单、Header 响应式与侧栏落位 4 个聚焦断言；连同前两轮布局共 6 passed / 21 skipped。完整相关文件当时存在 1 条该分支新增但与既有续费徽章单行契约冲突的断言（源码与既有专项测试要求 `nowrap`，新增测试误写为 `normal`）。
- 第三轮 `pnpm check` 通过：i18n、文档、MDX 与类型基线完成，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- 第三轮浏览器验证：`/agents/` 与首页均成功加载、正文非空、无 Next/Vite error overlay；请求命中 `https://lightclaw.tech/auth/session` 与 `https://lightclaw.tech/v1/frontend/runtime-config`。自动化会话无登录态，因此头像下移的真实数据截图仍由用户当前登录会话验收。
- 5174 已按 `cn` region 与 `https://lightclaw.tech` 后端参数恢复运行。
- 第四轮仅将 `.lv-agent-profile-wrap`、`.lv-agent-feedback-link`、`.lv-agent-account-footer` 的宽度从导航项固定宽度调整为侧栏可用宽度 `100%`；三条原有边框的颜色、位置和交互内容保持不变。
- 第四轮聚焦 Vitest 通过：4 passed / 1 skipped，新增断言锁定三条分隔线均为 `width: 100%`，`git diff --check` 通过。
- 第四轮 `pnpm check` 通过：i18n、文档、MDX 与类型基线完成，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- 第四轮重启后的浏览器验证通过：`/agents/` HTTP 200、正文非空、无框架错误遮罩，请求继续命中北京环境 `lightclaw.tech`；5174 监听保持运行。
- 第五轮根据用户截图把三条容器宽度改为 `calc(100% + 28px)`，越过侧栏右内边距；账户菜单内容单独保持 220px，不随分隔线拉宽。
- 第五轮聚焦 Vitest 通过：2 passed / 3 skipped；浏览器几何检查测得侧栏 280px、右边框 1px，三条分隔线容器均为 279px，账户菜单仍为 220px，且无错误遮罩。
- 第六轮仅将底部账户分隔容器向左补齐 16px，并用同值 `padding-left` 保持账户头像、文字和 220px 菜单位置不变；聚焦 Vitest 1 passed / 4 skipped。
- 第六轮浏览器几何检查：侧栏左端 16px、右边界 295px，底部分隔线从 0px 到 295px，账户内容仍从 16px 开始且宽 220px；无错误遮罩。
- 用户说明截图来自代理到本地 5174 的域名环境；开发服务日志确认 `/agents/channels/` 请求实际命中本地进程，不能按地址栏域名判断是否为线上。
- 第七轮确认第六轮负边距绘制被 `.lv-agents-sidebar-scroll-isolated` 的滚动裁剪边界截断；将侧栏盒子向左移 16px、宽度从 280px 增到 296px，并补回 16px 左内边距，使裁剪边界到达视口左侧，同时保持右侧竖线和全部导航内容位置不变。
- 第七轮聚焦 Vitest 1 passed / 4 skipped；浏览器实测裁剪边界 `left=0`、侧栏 `right=296`、分隔线 `0..295`、账户菜单 `left=16 width=220`，左边缘命中账户分隔容器，无错误遮罩且请求继续命中 `lightclaw.tech`。
- 第八轮为 Agent 设置路由传入专用 `lv-agent-sidebar-header`，桌面将其限制为 `296px × 84px` 并补齐右侧竖边框；内部 Logo 使用 16px 水平内边距，Header 底边设为透明。Workbench 不传该 class，移动端规则不生效。
- 第八轮聚焦 Vitest 2 passed / 3 skipped，覆盖 Agent Header 的 296px 侧栏宽度、84px 高度、16px Logo 内边距及 Workbench 排除条件；最终 `pnpm check` 通过，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- 独立浏览器不复用用户代理页登录态，只验证到登录门；其请求确认命中 `https://lightclaw.tech/auth/session` 与 `https://lightclaw.tech/v1/frontend/runtime-config`，Logo 的登录后几何仍由用户当前代理会话目视确认。
- 第八轮 5174 重启后 `/agents/channels/` 返回 HTTP 200；未发现 Vite error overlay 或 Next 错误对话框，北京后端请求保持不变。
- 第八轮真实 Agent 壳 CSS 几何（仓库内置临时预览会话，5175，仅用于验证后已关闭）：1440px 视口下 Header `left=0 right=296 width=296 height=84`，Logo `left=16 top=14`，左右内边距均为 16px，底边透明且右边框 1px；初次探针发现 Tailwind `xl:px-[80px]` 覆盖，最终以 Agent 专用重要声明消除层叠冲突后复测通过。
- 第九轮定位到通用 `.lw-app-top-pad` 为 96px，而 Agent Header 为 84px，造成 12px 竖线断层；Logo 底部为 46px，至主体 96px 形成约 50px 空白。将 Agent Header、高度、主区 padding、侧栏 sticky/锁定 top 与视口高度计算统一为 60px。
- 第九轮真实 Agent 壳几何（临时 5175 预览会话验证后关闭）：Header `top=0 bottom=60`，main `padding-top=60`，shell `top=60`，两者 gap=0；Logo `top=14 bottom=46`，至主体起点剩 14px。无 Vite/Next 错误遮罩。
- 第九轮聚焦 Vitest 3 passed / 2 skipped；最终 `pnpm check` 通过，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- 第九轮恢复 5174 真实北京环境后，`/agents/channels/` 正常加载、无 Vite/Next 错误遮罩，请求命中 `https://lightclaw.tech/auth/session` 与运行时配置接口。
- 第十轮把 Agent Header 底边从透明改为 `#e9ecf1`；真实 Agent 壳实测横线 `left=0 right=296 width=296`、`border-bottom-width=1px`，Header bottom 与 shell top 均为 60px、gap=0，无框架错误遮罩。
- 第十轮聚焦 Vitest 3 passed / 2 skipped；最终 `pnpm check` 通过，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- 第十一轮仅在桌面 `.lv-agents-sidebar` 增加 `padding-top: 12px`。真实 Agent CSS 探针测得 Header bottom=60px、sidebar top=60px、profile top=72px，右侧 1px 竖线仍连续，内容偏移准确为 12px。
- 第十一轮聚焦 Vitest 3 passed / 2 skipped；最终 `pnpm check` 通过，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- 第十二轮从 `.lv-agent-profile-wrap` 删除 `border-bottom`，不改该容器宽度和 16px 底部间距；聚焦 Vitest 3 passed / 2 skipped，最终 `pnpm check` 通过，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- 第十三轮将 `.lv-agent-profile-wrap` 的 `padding-bottom` 从 16px 改为 8px，仅压缩 Bot 信息到探索/对话切换之间的空白；聚焦 Vitest 3 passed / 2 skipped，最终 `pnpm check` 通过，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- 第十四轮将 Agent Header、主区与侧栏顶部节奏由 60px 同步增加为 68px，使 Logo 底部到横线的间距从 14px 增加为 22px，同时保持右侧竖线连续。
- 第十四轮真实几何探针：Header `top=0 bottom=68 height=68`、Logo `top=14 bottom=46`、Logo 到横线 22px；main padding 与 shell top 均为 68px，Header 到 shell gap=0，底边和右边均为 1px，且无框架错误遮罩。
- 第十四轮聚焦 Vitest 通过：3 passed / 2 skipped；最终 `pnpm check` 通过，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- 第十四轮恢复 5174 真实 CN/北京配置后，`/agents/channels/` 返回 HTTP 200、页面有内容、无框架错误遮罩，请求命中 `https://lightclaw.tech/auth/session` 与运行时配置接口。
- 第十五轮将桌面侧栏网格轨道从 280px 收窄至 264px，并将 Header 与滚动侧栏的视觉宽度从 296px 同步收窄至 280px；内部 220px 导航项、16px 左对齐和 24px 主区间距保持不变。
- 第十五轮真实 CSS 探针测得 Header `left=0 right=280 width=280`、右边框 1px；1000px 宽探针中第一轨 264px、第二轨从 288px 开始、列间距 24px，无框架错误遮罩。
- 第十五轮聚焦 Vitest 通过：3 passed / 2 skipped；最终 `pnpm check` 通过，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- 第十五轮恢复 5174 真实 CN/北京配置后，`/agents/channels/` 返回 HTTP 200、页面有内容且无框架错误遮罩，请求继续命中 `lightclaw.tech`。
- 第十六轮确认 `.lv-agent-profile-name` 原为 16px/22px，而侧栏账户名称 `text-sm` 实际为 14px/20px；将前者同步调整为 14px/20px，字重均保持 600。
- 第十六轮浏览器 CSS 探针测得顶部 Bot 名称与左下账户名称均为 `14px / 20px / 600`，无框架错误遮罩，请求命中 `lightclaw.tech`。
- 第十六轮聚焦 Vitest 通过：4 passed / 1 skipped；最终 `pnpm check` 通过，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- 第十六轮恢复 5174 真实 CN/北京配置后，`/agents/models/` 返回 HTTP 200、页面有内容且无框架错误遮罩；字号复测仍为一致的 14px/20px/600，请求继续命中 `lightclaw.tech`。
- 第十七轮将鉴权阶段 `AgentsRouteLoading` 与 Agent 数据阶段 `AgentSettingsDataLoading` 收敛到共享 `AgentSettingsLoadingContent`，移除旧的灰底、居中 1440px shell、280px 旧轨道、84px sticky 起点和卡片式侧栏骨架。
- 第十七轮桌面鉴权 loading 实测：Header `0..280px`、高 68px，shell `left=16 top=68`，侧栏 `left=0 right=280 top=68`，main padding 为 68px、白色背景、无错误遮罩；截图为 `/tmp/lightvela-agent-loading-aligned.png`。
- 第十七轮 390×844 移动端鉴权 loading 实测：单列 342px、账户底栏隐藏、页面 scrollWidth=390、无横向溢出和错误遮罩；截图为 `/tmp/lightvela-agent-loading-mobile-aligned.png`。
- 第十七轮聚焦 Vitest 通过：5 passed / 1 skipped；最终 `pnpm check` 通过，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved。
- `validate_documentation.py`、显式 changed-file 的 change-impact 门禁与 `git diff --check` 通过。
- 第十七轮验证报告已生成：`/tmp/lightvela-agent-loading-validation/report.html`；5174 已按 CN/北京后端参数恢复，`/agents/models/` 返回 HTTP 200，自动化浏览器无错误遮罩且资源请求命中 `https://lightclaw.tech/auth/session` 与运行时配置接口。
- 第十八轮按用户反馈仅将桌面端右侧 `.lv-agent-settings-content` 上移 8px；正式内容与共享 Loading 骨架复用同一 class，左侧导航和移动端保持不变。浏览器实测 shell top=68px、右侧 content top=60px、margin-top=-8px，无错误遮罩；聚焦 Vitest 2 passed / 4 skipped，`pnpm check` 通过且 TypeScript 0 个新增诊断。
- 第十九轮参考 Viktor 将桌面右侧内容列限制为 1280px 并在第二列内水平居中，窄于该宽度时仍保持 100% 自适应；正式内容与 Loading 沿用同一 class。1728px 视口实测内容 `x=368..1648 width=1280px`，相对 1408px 可用列左右各收进 64px，无横向溢出和错误遮罩；聚焦 Vitest 2 passed / 4 skipped，`pnpm check` 通过且 TypeScript 0 个新增诊断。
- 第二十轮按用户反馈将桌面右侧内容列再上移 8px，即 `margin-top` 从 -8px 调整为 -16px；1280px 居中宽度、左侧导航与移动端均保持不变。1728px 视口实测 shell/sidebar top=68px、右侧 content top=52px、无横向溢出和错误遮罩；聚焦 Vitest 2 passed / 4 skipped，`pnpm check` 通过且 TypeScript 0 个新增诊断。
- 第二十一轮仅收窄用户标注的导航内容右侧空白：导航内容宽度与左起点保持 `220px` / `16px`，桌面侧栏和 Header 从 280px 收窄到 264px、网格第一轨从 264px 收窄到 248px、右内边距从 28px 收窄到 12px，并同步三条分隔线的补偿宽度。1728px 视口实测导航 `x=16..236` 不变、侧栏边界 `x=264`，右侧空白为 28px，分隔线到 `x=263`，无横向溢出和错误遮罩；聚焦 Vitest 4 passed / 2 skipped，`pnpm check` 通过且 TypeScript 0 个新增诊断。
- 第二十二轮将桌面侧栏主体的顶部内边距从 12px 增加到 20px，使 Bot 信息、切换器、导航与反馈整体下移 8px；底部账户区继续由 `margin-top: auto` 固定在原位，Logo、侧栏宽度和右侧内容不变。1728px 视口实测 profile/nav/feedback 均下移 8px，account top 仍为 907px，无横向溢出和错误遮罩；聚焦 Vitest 3 passed / 3 skipped，`pnpm check` 通过且 TypeScript 0 个新增诊断。
- 第二十三轮定位到微信占用横幅由 `AgentSettingsPage` 外层先于 `ChannelPanel` 渲染，导致其出现在通道标题上方；新增通道说明后的显式插槽，将横幅顺序调整为标题、说明、占用提示、通道卡片，文案与“前往管理”行为不变。
- 多 Bot 提示审计覆盖通道、对话、诊断、创建、删除与重置：对话限制位于不可用 tab 的 tooltip，诊断限制位于页面标题说明，创建配额位于创建按钮 tooltip/创建错误，删除和重置限制位于对应动作 tooltip/toast，均未发现同类页面标题错位。
- 第二十三轮聚焦 Vitest 通过：3 files / 43 tests；通道顺序测试直接断言标题、说明、提示和卡片的 DOM 先后关系。
- 第二十三轮最终 `pnpm check` 通过，TypeScript 为 174 current / 276 baseline / 0 new / 102 resolved；文档门禁、显式 changed-file change-impact 与 `git diff --check` 均通过。
- 第二十三轮验证报告为 `/tmp/lightvela-multibot-notice-validation/report.html`；5174 本地 CN 页面 `/agents/channels/` 返回 HTTP 200，进程继续监听北京后端预览端口。
- 第二十四轮移除 `.lv-agent-feedback-link` 的顶部边框，并在桌面端用自动外边距将其下沉；相邻账号区覆盖为 8px 顶部间距，无反馈入口时账号区原有 `margin-top: auto` 规则不变。
- 第二十四轮为 `.lv-agents-sidebar-scroll-isolated` 增加 `overflow-x: hidden`，保留 `overflow-y: auto`；右侧 `.lv-agent-settings-content` 的桌面偏移从 -16px 调整为 -24px。
- 第二十四轮聚焦 Vitest 通过：2 passed / 4 skipped；完整该测试文件当时另有已记录的续费徽章冲突断言失败，与本轮样式无关。`pnpm check` 通过，TypeScript 0 个新增诊断。
- 第二十四轮浏览器 CSS 探针：反馈入口 `border-top-width=0px`、反馈到账号区间距 8px、侧栏 `overflow-x=hidden`、shell top=68px、右侧 content top=44px（偏移 -24px）；5174 `/agents/channels/` 返回 HTTP 200。
- 第二十五轮按用户截图仅将 `.lv-agent-account-footer` 的顶部内边距从 16px 收紧为 8px；不改分隔线、反馈入口或账户触发器尺寸。
- 第二十五轮聚焦 Vitest 通过：2 passed / 4 skipped；`pnpm check`、documentation、change-impact 与 `git diff --check` 均通过。浏览器 CSS 探针确认账号区 `padding-top=8px`、分隔线仍为 1px，内容距容器顶部为 9px（含边框）。
- 第二十六轮将 Agent Header 内部容器从 60px 同步为 68px，使 32px Logo 从上 14px/下 22px 调整为上下各 18px；仅作用于桌面 Agent Header，不改变共享 Header、侧栏接缝或右侧内容位置。聚焦 Vitest 1 passed / 5 skipped；5174 编译后 CSS 浏览器探针确认 Header/内部容器/Logo 为 68px/68px/32px，上下留白为 18px/18px。
- 第二十七轮 CR 复核确认新增导航间距测试误要求 `white-space: normal`，与既有续费徽章专项测试及生产 CSS 的 `nowrap` 契约冲突；移除该越界用例，不修改生产 CSS 或续费行为。导航间距与续费徽章专项测试合跑为 2 files / 38 tests passed。

## risks
- 宽屏内容区变宽可能放大内部卡片；用 Agent 页作用域样式和桌面截图检查缓解。
- 共享类误改可能影响账户页；回归测试明确断言共享规则保持不变。
- 侧栏内容较多时底部账户入口与菜单需要共享侧栏滚动区域；桌面侧栏固定为视口剩余高度并让账户区 `margin-top: auto`，通过真实布局检查防止遮挡。
- Header/侧栏重复挂载会重复注册全局监听；按同一 1024px 断点条件挂载，聚焦测试覆盖桌面移出与移动保留。
- Agent 专用 Header 若继续占满视口会残留横贯内容区的视觉层；桌面将其外壳收窄为与侧栏一致的 280px，并保持 Workbench/移动端不受影响。
- Header、main 与 sticky sidebar 使用不同顶部常量会重新产生断线；聚焦测试同时锁定 68px Header、Agent main padding 与侧栏可用高度。
- 右侧上移若直接修改 main padding 会连带移动侧栏并破坏 68px 接缝；使用桌面限定的内容列 margin，仅影响第二列，并让 Loading 共用该 class。
- 右侧内容宽度只在桌面端设置 `max-width: 1280px` 与自动水平外边距，不收窄 shell 或侧栏轨道，避免重新影响左侧对齐与窄屏布局。
- 再次收窄侧栏时保持 `--lv-agents-nav-width: 220px` 与 16px 左内边距不变，只减少右内边距和对应外壳/网格宽度；避免把用户标注的空白压缩误做成导航内容缩放。
- 鉴权 loading 和数据 loading 若各自维护独立 DOM 会再次漂移；两条分支复用同一 `AgentSettingsLoadingContent`，聚焦测试锁定共享关系和桌面几何 class。
- 顶部留白直接加在侧栏内部，保持 sidebar box 从 68px 开始，避免为了视觉间距再次移动边框并制造断线。
- 反馈入口与账号区使用相邻选择器覆盖账号区自动外边距；这样只在反馈存在时将二者组成底部组，不改变对话页或国际站无反馈状态的账号贴底行为。
- 横向滚动条通过限制滚动容器的横向 overflow 消除，纵向 overflow 仍为 auto，避免内容较多时失去纵向可达性。
- 回滚方式：删除 Agent 页专用 class、CSS override 与对应测试断言。

## validation
- `pnpm exec vitest run ... -t "keeps the desktop Agent shell|uses compact desktop spacing"`：通过，2 passed / 1 skipped。
- `pnpm lint`：未运行，package 无此 script。
- `pnpm typecheck`：通过，0 个新增诊断。
- `pnpm check`：通过。
- 第三轮聚焦 Vitest：通过，6 passed / 21 skipped；首次无临时 host 参数因本机 `ENOTFOUND localhost` 未启动测试，改用一次性 `--api.host 127.0.0.1`。
- `pnpm test`：完整运行但 master 基线未全绿；本次布局用例通过。
- 桌面与窄视口页面级 CSS 几何检查：通过；无登录态，未取得真实 Agent 侧栏截图。
- 第三轮浏览器可用性、错误遮罩与北京后端请求检查：通过；登录态账户区由组件测试覆盖，等待用户会话目视确认。
- `git diff --check`：通过。

## decisions
- 采用 Agent 页专用 `lv-agent-settings-shell`，仅在 `min-width: 1024px` 使用 `min(1760px, calc(100vw - 32px))` 并左锚定 16px；不修改共享 `.lw-settings-shell`。
- 账户动作仍由 `UserAvatarMenu` 单一实现负责；只增加 Header/Sidebar 两种展示形态，不复制登出或路由逻辑。
- Agent 设置页桌面 Header 关闭头像、侧栏按同一断点挂载；Workbench 无设置侧栏，因此保留原 Header 头像。
- 分隔线复用 Logo Header 与账户容器的既有边框；反馈入口按最新反馈移除自身顶部边框，不增加伪元素或新的视觉层。
- 底部账户分隔线额外使用 `margin-left: -16px` 和等量 `padding-left` 贴到视口左边，同时保持账户内容原位。
- 为避免滚动容器裁掉负边距绘制，桌面侧栏滚动盒采用 `width: 280px; margin-left: -16px; padding-left: 16px`；其 margin box 占 264px 网格轨道。
- Agent 设置路由的桌面 Header 使用与侧栏绘制边界一致的 280px 宽度和 68px 高度，将 Logo 视觉归入侧栏顶部；针对 Header 工具类层叠仅在 Agent 专用选择器上强制 16px 内边距和 `#e9ecf1` 底边，并用 `lv-agent-settings-main` 同步 68px 主区起点。共享 Public Header、`.lw-app-top-pad`、移动端与 Workbench 默认规则不变。
- loading 内容采用独立展示组件并由鉴权 fallback 与页面数据 fallback 共同复用；组件沿用正式页 class，不复制布局常量，避免后续新设计与骨架再次分叉。
- 通道占用提示通过 `ChannelPanel` 的 `afterDescription` 插槽进入面板内部，不复制标题说明、不改共享提示组件，也不让模型页消费该插槽。
- owner：本轮用户需求；实现决策由当前 Agent 按最小变更原则执行。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/styles.css`
- `frontend/src/pages/marketing/__tests__`
- `frontend/openspec`

## scan_output
- 源码与测试入口均已定位；无生成物、配置或 i18n 变更。

## handoff
- 当前状态：已基于最新 master 在隔离 worktree完成全部布局调整并推送至工蜂 MR !3948；5174 北京环境预览保持运行。
- 下一步：等待 MR !3948 的 CI 与评审结果；合并、发布和生产验证仍需用户另行授权。
- 阻塞项：真实登录态截图缺失；全量测试存在 master 既有失败，且 package 无 lint script。
- 所需权限：提交、推送与创建 MR 已获授权并完成；合并、发布和生产操作未授权且未执行。
