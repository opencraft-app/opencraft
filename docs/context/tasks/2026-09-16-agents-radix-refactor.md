---
id: task-agents-radix-refactor-20260916
type: task
scope: Agents 全页面交互与组件重构，保持业务逻辑。
triggers: ["agents-radix-refactor", "agents-sidebar", "account-credit-menu"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/openspec/plan.md
  - .workflow/native/changes/agents-radix-refactor/brief.md
status: active
reviewed_at: 2026-09-16
review_due: 2026-10-16
revision: 1.0.0
precedence: task
derived: false
---

# Agents Radix 重构 Task Pack

## sidebar_switcher_b_20260917

- 交付授权：用户已确认本轮B的功能提交和标准sourceRevision记录提交一起推送到既有预览分支。仅上述5文件与生成清单；保留未知fixture，不合并master、不创建MR、不监控CI。以下“未提交”是本地验收时状态，交付实际结果见runtime/sidebar-switcher-b-push-report.md。
- 用户选择本轮独立探索/对话 Demo B，仅调整 `ConsoleSidebarTabs`：40px轻灰底板、4px内缩/间隔、白色选中项与 `shadow-sm`，去内外双框。两项集中复用本组件的 className；共享 `AgentTabs` / Tabs 默认、其他消费者、回调、Tooltip、数据和权限不变。不新增依赖、变体或动画。
- context_receipt：本轮根/frontend AGENTS、技能索引、FE-AI/global/flow-cost、UI/可访问性/TDD/验证规范已读；沿用上一轮已 fetch 的 master3165aca5a 前端规范及 DESIGN 对照。路由 `frontend ConsoleSidebarTabs segmented B variant` 无匹配；仅读取既知组件/相邻测试及 frontend-runtime-openspec-i18n 邻接。原工作区与未知 fixture 不动。
- 验证：RED 2 fail/8 pass → CN/global各5文件33通过；项目check exit0、170现有类型诊断/0新增、47既有i18n警告。标准OpenCraft只读check157通过，未写生成副本。浏览器实际桌面235×40px轨道、111.5×32px项、4px内缩/间隔、0px边框、白色选中/透明非选中/标准轻阴影；390px手机轨道279×40px，Sheet宽度/scrollWidth同319无横向溢出。Home/End、可见焦点和Esc回导航按钮已验，临时viewport已恢复。
- 仅本地样式验收，聊天后端为mock且token不可用，不声称聊天业务验证。未跑全量前端套件/双站构建/OpenCraft全量gate；未提交、推送或部署，旧交付授权不覆盖本次B。详情 `.workflow/runtime/sidebar-switcher-b-report.md`。

## preview_delivery_20260917

- 用户已确认两次提交后一次推送现有 `frontsandbox/agents-radix-refactor`，范围为 A 方案、三项组件修正、积分 Progress 及相邻测试/文档/标准生成副本。第二提交仅记录标准脚本生成的最新 sourceRevision。排除未知 fixture，不合并 master、不创建 MR、不归档、不持续监控 CI。
- 推送准备重验：CN/global各7文件71通过，项目check无新增类型错误，OpenCraft只读check157/adapter6通过，文档与79文件impact/diff检查通过。历史双站构建/OpenCraft完整gate记录保留，不声称本轮重新运行。推送成功与预览构建完成分别判断。

## sidebar_progress_20260917

- 用户要求头像菜单已使用积分采用progress展示。本S quick增量只增加纯展示 `ui/progress.tsx`，菜单改为标签/小号精确数值同排、下面8px浅灰轨道与深色填充；0%保留轨道。不新增依赖/动画，不改controller、账户页、额度算法、升级资格或未知状态。保留旧A与三项修正dirty、未知fixture及原工作区。
- context_receipt：已读根与frontend规范、已fetch origin/master前端规范、DESIGN、skills索引、FE-AI/global/flow-cost、baseline-ui/可访问性/TDD/验证规范；上下文路由 `frontend agents sidebar account credit progress` 无命中，限定查询菜单/controller/共享摘要及相邻测试并读取runtime-openspec-i18n邻接。无扩大产品范围。
- TDD先7失败/10通过，完成后CN/global各3文件48通过；check exit0/170现有诊断/0新增/47既有i18n警告。Chrome本地合成25%菜单确认轨道8×254px、填充63.5px、辅助数值及Esc关闭回头像；0%/满额/超额/非有限值由组件测试覆盖，不声称真实账务验收。
- 标准OpenCraft只读check157通过，无生成漂移。本批按S风险验证，不重跑全量前端/双站构建/OpenCraft完整gate；历史结果不替代本批。详见 `.workflow/runtime/sidebar-progress-report.md`。仅本地修改，无commit/push/MR/部署。

## component_review_fixes_20260917

- 用户批准修正三项 review：连接方式单选误用 Tabs、下拉浮层圆角/阴影散落覆盖、自动任务弹窗标题留白由内容承担。Card 等补充建议不在本批；不改已有 A 配色、侧栏和业务逻辑。
- context_receipt：根/frontend AGENTS、已 fetch 的 `origin/master@44a58071d` 中 frontend/AGENTS.md 与 DESIGN.md、FE-AI P0/flow-cost/team-state/角色门禁、计划当前段、frontend-runtime-openspec-i18n 邻接与通道交互测试、OpenCraft AGENTS/MONO2_MIGRATION/上游所有权/维护验证规范。路由 `frontend agents Radix component review fixes` 未命中，按已确认文件做有界定位。
- 验收：RadioGroup 无悬空 panel 引用、互斥/方向键/确认/取消回焦；Select/DropdownMenu 显式产品变体统一 Portal 样式且公共默认不变；固定标题滚动时保留自身间距。新增依赖按各宿主 Radix 闭包锁定；标准生成后验证 OpenCraft 消费。实际执行结果以 plan 当前段与本批 runtime 证据为准，旧通过不作本批证据。
- 保留未归属 `frontend/src/app/sidebar-account-fixture/`；不修改原 mono2 工作区，不提交/推送/部署。
- 本批完成：独立review Approved；区域聚焦CN362/global122与check0新增类型错误；Root双站build103/649、标准sync/check157和OpenCraft完整gate1273pass/0fail/0skip通过。实际桌面/390单选键盘、回焦与固定标题留白已验，本地mock预览恢复。首次node-pty依赖执行权限失败及global语言预期失败均在本批report保留；不声称完整frontend suite或真实实例验收。

## selection_a_20260917

- 用户已批准 Demo A 并要求灰底稍浅；本轮实现 `#f2f2ef` 导航/会话整行、白色选中分段、透明下划线页面 Tabs、边框勾选选择卡片，以及头像/名称状态/维护操作/切换箭头的信息行。旧 `#dedede` 全局 Tab 契约被显式变体替代，历史段仅作演进记录。
- context_receipt：读取根/frontend AGENTS、用户指定 FE-AI 规则、已有计划及 Demo 审查、frontend 服务和 runtime-i18n 邻接、Skills 专项规范、OpenCraft 所有权/验证规范。路由查询未命中后仅按已知组件/消费者/相邻测试调查；功能状态与业务命令仍由原 controller 所有。
- 依赖边界：新增纯展示 `AgentTabsList/Trigger`，不改通用 Tabs 默认值或依赖；OpenCraft 按 `data-agent-tabs-variant` 与主题 token 适配，并通过标准脚本同步155文件。原工作区不动，所有修改限于既有 frontsandbox 隔离工作树。浏览器、终端、Workbench、成就不扩修。
- Developer 聚焦结果：CN核心42、消费者274、模型71通过；global核心42通过；OpenCraft adapter6通过；`pnpm check` 通过。Root 已实测 Skills 标题与选中态、键盘切换、任务表单分段/主分类下划线、1024×600侧栏隐藏滚动条和上下边界状态、390×844手机Sheet及Esc回焦。模型mock返回读取失败，不声称真实实例视觉/命令通过。
- 标准生成检查通过；最终构建、独立审查与交付状态以 `frontend/openspec/plan.md` 当前任务段为准。未提交、推送或发布，不操作真实账务/云端数据。

## sidebar_feedback_20260917

- 完成：开发双站各69通过、check0new，独立审查各43通过无P1/P2；标准生成并sync/check154、OpenCraft完整gate1273全pass与类型/边界/各平台构建通过。实际桌面入口/外链新窗口/关闭回焦和390手机可见已核对，移动click组件覆盖，不称触屏实机。问卷测试tab已关且未提交内容；文档/impact/diff通过，等待用户验收。
- 用户明确要求移除侧栏独立反馈按钮，头像菜单统一“建议反馈”。沿用原问卷与新窗口安全属性；国内站默认可见，国际站保持不显示。手机使用 header 头像，因此同时窄改 header 的反馈项，不改其他 header 行为或隐藏工作台规则。
- context_receipt：重读隔离工作树根/frontend AGENTS、当前 plan/runtime、原仓库 feai/global/flow-cost/team-state 和角色门禁；路由 `frontend sidebar feedback link user menu` 无匹配，限定组件/site、agent-settings-page、styles 精确定位，读取 frontend-runtime-openspec-i18n 邻接、实际 useT/i18n 和相邻测试。本次为已批准导航设计的明确小调整，按 quick 增量执行，不重新开启产品规划或修改 Native 历史。
- 验收：侧栏无旧链接与残余 CSS；头像默认单一反馈入口、名称/URL/安全属性正确，点击关闭菜单；国际站无该入口，工作台 reveal 规则不变。双站相关测试、check 和本地 UI 验证后等待用户验收。

## sidebar_account_preview_20260917

- 完成证据：开发CN/global各56通过、check0new，Reviewer独立各27通过、无P1/P2。Root实测两页面250/1000、25%及升级href一致，向上菜单和回焦、去参数恢复原态通过；最终演示菜单保持展开。标准sync/check154，OpenCraft完整gate1273执行0fail/skip及类型/边界/Web/ExpoWeb/iOSJS通过，文档与impact检查通过。未提交、发布、操作真实账务；真实账号若仍缺失须另查实际环境。
- 用户反馈头像向上菜单看不到积分和升级。Root在当前本地5188实际核对：菜单加载结束为未订阅，account页也显示还没有订阅套餐；现有组件已接入共享摘要，fake仓库默认无Pass且所有升级目标为空。此前无套餐预览不足以展示已实现的正常套餐状态。
- 本批只补显式`passState=sidebar-demo`的本地合成有套餐验收数据，套餐名称标注演示；不持久化、去参数恢复原行为、未知Pass无升级目标、订单方法继续拒绝。不得将demo视为真实支付或真实账号资格验证。现有生产controller/共享摘要/真实HTTP/Context和权限不改。
- context_receipt：重新读取本工作树根与frontend AGENTS、skills索引，原仓库feai/global/flow-cost/team-state和角色门禁、debugging/review reception/TDD。路由`frontend sidebar account credit upgrade menu`无命中，已进行限定目录精确查询，检查frontend-runtime-openspec-i18n邻接及controller测试；补读frontend-service-detail/site-environment-routing。无graphify图；OpenCraft AGENTS、maintenance/verification和MONO2_MIGRATION已读，因fake仓库在生成闭包，必须标准同步与gate验证。

## sidebar_palette_increment_20260917

- 用户反馈选中态过浅、导航背景过灰；S5恢复白底与连续1px细边框，导航/会话和Agents局部Tabs选中统一为`#dedede`背景、`#171717`文字/图标、600字重，inactive hover为`#f5f5f5`。固定布局、隐藏滚动条与S4条件阴影保持。
- 本批源码写集仅`src/styles.css`及两项相邻测试文件；旧颜色契约先RED再更新，保留几何、键盘、真实Tailwind编译与级联检查。共享原语、JS、SDK、账户、依赖、生成闭包不改。context_receipt延续本任务规范，已重新读取frontend服务/site-environment-routing与runtime-i18n邻接，按实际源码及浏览器样式级联确认修复范围。
- 国内/国际各5文件67项通过，`pnpm check` exit0/170current/0new，47既有i18n警告；既有检查器自动重试fumadocs生成竞争后通过。Root实际桌面白底/边框/选中hover/键盘切换、上下滚动阴影与390px手机Sheet白底/选中/Esc回焦通过。独立审查及最终文档校验结果见计划和runtime证据，不把历史S3构建当成本批新构建；未提交或执行真实账务操作。

## sidebar_increment_20260916

- S4用户追加上下滚动边界阴影已完成：仅shell/CSS/相邻测试实施，无溢出无阴影、首端下/中段双/末端上。观察容器和内容尺寸，1px边界容差，保持滚动所有者、主内容挂载与手机Sheet。已读本轮路由must_read（frontend服务详情、site-environment-routing）、frontend-runtime-openspec-i18n邻接、console/session相邻源码与测试；当前无graphify图，按精确定位执行。实现双站各61项通过、check0新增；Root真实四态/1280×720、1280×1000、1024×400和390×844验证通过，独立审查无P1/P2、双站各18项通过，等待用户验收。S4未修改共享生成闭包，不复用旧S3构建结果声明新构建通过。
- 用户已批准：Agent保持顶部，头像常驻底部，完整左栏固定满屏，中间内容允许滚动但隐藏滚动条；参考Town导航和向上账户弹层。新增积分额度/升级入口来自account，保留account原内容及资格、区域和支付路径。
- 用户追加：探索/对话与定时任务选中样式缺陷。Root在现有mock页面复现了36px触发器超过外框26/30px内容高度而遮挡边线；近白色宿主surface-muted使active底色区分不足，aria-selected切换本身正常。
- 执行与当前状态：`frontend/openspec/plan.md`顶部S1–S3已完成本地验证并独立放行，等待用户验收。选中态h-auto、ABA旧清理、命令链卸载、legacy订阅名称/未知额度P2均关闭。最终CN22文件322/global21文件302，check0新增，双站build103/649页，标准sync154与OpenCraft完整gate1273/0skip及Web/Expo Web/iOS JS通过；Root验证固定布局、40条会话、菜单和Tabs，真实200%缩放尚未实测。原B1–B6数据只作历史，Native原change仍archive/revision8，不擅自归档；未提交/推送/发布。
- 追加受影响路径：Agents console/CSS、sidebar专用账户视图、account套餐摘要适配与相邻测试、确认根因后的共享Tabs展示契约。Context/Repository/core/SDK和暂缓模块实现不变；共享生成闭包需按实际漂移重新校验。
- 追加context_receipt：本任务frontend AGENTS、frontend服务详情/运行时i18n邻接和console相邻测试、frontend/DESIGN.md；原仓库用户指定feai-workflow/global/strict/flow-cost/team-state/planning门禁；本工作树Native commands/team-conventions。查询`frontend agents sidebar account credit upgrade menu`无route命中，回到上述已确认的前端路径进行有界调查。
- 验收：双站同套餐/同额度/同升级目的地，loading/error/无套餐/过期/隔离/升级中不伪装正常值；1440/1024/390、矮窗口及缩放下账户和导航可达、Portal不裁切、Esc回焦，两个Tabs全部active位置有完整形状。无真实账务、云端写入或发布。

## goal

在新分支将 `/agents/*` 的宿主页面统一为 Radix UI / shadcn 风格组件与交互，保留功能逻辑。

## non_goals

- 新能力、后端/运行时/SDK 内部重写、生产发布、远端配置写入。
- 将外层样式完成声明为全部页面重构完成。
- 成就已移除；浏览器、终端、Workbench（含session别名）按用户后续要求暂缓，不修改或恢复。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户本轮文字请求：拉分支、整体重构 `/agents/*`、功能逻辑不变、交互现代成熟。
- 完整草案：`.workflow/native/changes/agents-radix-refactor/brief.md`。

## interface_refs / data_structure_refs

- `frontend/src/lib/agent-routes.ts`：基线路由 section、别名和 query 契约；成就按用户实施中补充要求排除，不恢复其入口。
- `frontend/next-site/agents-page-client.tsx`：认证壳、lazy 页面与 workbench 分流。
- `frontend/src/pages/marketing/agent-settings-page.tsx`：Bot/Profile、面板 props、维护状态与 action callbacks。
- `frontend/src/pages/marketing/agent-config/`、`agent-model-config/`：保持命令和业务 hooks。
- `frontend/src/pages/marketing/agent-chat-panel.tsx`：保留 token、稳定 props 与会话桥接。
- `frontend/src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.tsx`：保留 transport 和专用 surface；浏览器验证不得误触真实自动安装。

## history_context

- current_design_refs：`frontend/DESIGN.md`、上述 brief。
- relevant_evolution：本次最新 `origin/master@08b9cf568`；相关测试已保护配置面板本地化及 SDK 稳定输入。
- superseded_refs：旧工作区含 `tea-sdk-lightclaw` 的技术栈回答；部分文档仍称 Vite 主框架，以当前 package scripts 与代码为准。

## acceptance

- brief 所列全路由及别名都有逐项迁移/保留边界记录。
- 行为测试、双站构建、键盘与多尺寸视觉验证均有实际证据。
- 未实施或未验证项必须显式记录。

## affected_paths

- `frontend/src/pages/marketing/agent-*`、`skills-demo/`，排除暂缓的浏览器、终端、`agents-workbench/`生产与测试文件。
- `frontend/src/components/domain/` 中本次Agents文件管理展示控件，不改浏览器面板。
- `frontend/src/components/ui/`、Agents 专属样式、相邻测试与必要依赖。
- `frontend/public/fonts/HYRuiYiSong-45J.subset.woff2`：标准构建根据更新后的生成字典重建；不手改字体或脚本。
- `opencraft`：只涉及共享消费同步脚本、生成闭包、host CSS、必要直接依赖、诊断现有stream转发与契约测试，不实施暂缓页面。

## required_context

- Pack `frontend-product-surface` → `docs/context/project/services/frontend.md`。
- 根/前端 AGENTS，Task/Checkpoint 模板，前端设计与当前路由、面板、测试。

## context_receipt

下表文件均在基线 `08b9cf568` 所建 worktree 阅读；技能来源另有注明。

| 文件 | 阅读原因 | 用途 |
| --- | --- | --- |
| `AGENTS.md` | 主仓边界 | Task Pack、门禁与变更权限 |
| `frontend/AGENTS.md` | 服务边界 | 前端验证要求 |
| `docs/context/project/services/frontend.md` | 路由 must_read | 双站、生成物与运行时边界 |
| `docs/context/tasks/TASK-TEMPLATE.md` | 状态契约 | 本记录结构 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md` | 交接要求 | 下方 checkpoint |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 相关邻接 | 关联现有边界测试与实际脚本 |
| `.workflow/project.yaml`、`frontend/openspec/config.yaml` | 既有上下文软引用 | 技术栈概览，用源码校准陈旧条目 |
| `frontend/openspec/plan.md` 的近期任务段、`current_state.md` | 检查历史任务 | 仅历史证据，不接管其他需求 |
| `frontend/DESIGN.md` | UI 规范 | 圆角、阴影、浮层与 Skills 列表约束 |
| `.agents/context/change-impact.json` | 影响映射 | 纯视图改动未命中；扩展路径时重新检查 |
| `.codebuddy/skills/feai-native/SKILL.md` 及 commands/artifacts/team-conventions references | 当前工作流 | 草案批准与引擎状态管理 |
| `frontend/package.json`、`frontend/vitest.config.ts` | 可执行命令 | 锁文件安装、基线测试、准确门禁 |
| `frontend/src/pages/marketing/__tests__/agent-settings-sdk-boundary.test.ts` | 相邻测试 | SDK 本地化与稳定 props 保护 |

## evidence

- `git fetch origin master --prune` 成功，ref 更新到 `08b9cf568`。
- `git worktree add -b frontsandbox/agents-radix-refactor ... origin/master` 成功；创建后工作区干净。
- 根工作区原有 `.agents/skills/README.md` 修改及 renewal skill、frontend/.codebuddy、tmp 未跟随到本分支。
- `validate_context.py --route 'frontend /agents/* Radix UI shadcn/ui interaction refactor'` 返回 frontend-product-surface。
- 当前主控制台文件 5,823 行，定时任务文件 6,737 行。
- FE-AI status 无本地 active，存在两个不相关的共享 brief：`fix-builtin-skills-source`、`upgrade-feai-tools-058`；new 被候选规则拒绝。保留这两份历史任务，先撰写当前任务 brief，再通过文档支持的具名 resume 选择本次任务；不手改引擎状态。
- 具名 `resume --name agents-radix-refactor` 成功，shape/revision 1；`next` 返回 `await-user / approval-required`，brief 尚未批准。未进入 build。
- `pnpm install --frozen-lockfile` exit 0，锁文件未修改。
- `pnpm exec vitest run src/lib/__tests__/agent-routes.test.ts src/pages/marketing/__tests__/agent-settings-sdk-boundary.test.ts src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts src/pages/marketing/__tests__/agent-settings-nav-order.test.ts next-site/__tests__/agents-page-loading-boundary.test.ts`：5 files / 60 tests passed，exit 0。
- `git diff --check` exit 0；两份新 Markdown 的显式尾随空白检查通过。当前新增文件只有本 brief 和 Task Pack；未修改生产 UI。

## risks

- 展示提取改变挂载时序：保留 key、受控 props、原回调及 request guards，增加风险行为测试。
- Radix Portal 丢失控制台样式：浮层显式绑定 Agents token，与全站默认分离。
- shared primitives 影响公开页：opt-in 变体并补公开页 smoke。
- 高风险远端动作：在 mock fixture 中校验调用契约，真实写入须额外授权。
- SDK 内容不属于纯 Radix 迁移：最终报告明确该边界。

## validation

方案阶段（历史）：依赖安装与60条聚焦基线测试通过，不将基线计为改造后验证。

最终：CN60文件992项、global59文件781项+定时任务新增/旧header15项均通过；`pnpm check` exit0、170 current/276 baseline/0 new，翻译0错误/47既有警告；双站build exit0、103/649静态页。OpenCraft真正clean install1298包、定向104项与sync154通过，完整gate exit0、测试组累计1273通过/0跳过，Web/Expo Web/iOS JS构建完成。独立审查B1至B6通过，无未关闭P1/P2；逐批桌面/窄屏/手机与键盘证据见最终报告。文档/实际变更影响及diff检查通过，正式设计仍需Owner确认。

## decisions

- B5-A追加必要依赖对齐：真实最小Dialog/Popover组合与独立对照确认scope/layer多版本导致嵌套焦点和Esc失效。只准Popover1.1.17→精确1.1.15对齐现有Dialog/Select，不升级其他包、不用永久alias/override；无alias嵌套交互、原时间选择和公开账户菜单必须回归。此项属于已批准UI依赖边界修复，不改业务调度或请求；旧brief保留批准历史。
- 已执行：独立兄弟 worktree 与 `frontsandbox/` 分支，依据用户新分支请求及既有偏好。
- 用户于 2026-09-16 明确“开始实施吧”，批准完整宿主界面重构方案 A 及模块依赖与边界补充；Native 经 `next --confirmed` 进入 build/revision 2。双站共享改造，专用渲染组件保持原接入。
- 用户新增明确约束：实施时参考项目规范完善各模块依赖与边界；已读取其指定的原工作区 `feai-workflow`、global/planning/implementation 规则，按该要求将执行任务接入 `frontend/openspec/plan.md`，完整模块矩阵位于 `frontend/openspec/changes/2026-09-16-agents-radix-boundaries.md`。Native 继续追踪整体批准；未改写引擎或导入旧工作流工具。
- 原工作区规则与本 worktree 的 Native 文件布局不同，差异及本任务的产物安排已记录在模块矩阵文档；本轮未把规则目录缺失当作授权跳过验证。

## boundary_addendum_20260916

- 追加读取：`frontend/docs/README.md`、`docs/engineering/architecture/authority-and-contracts.md`、`shared/lightvela-agent-core/{AGENTS.md,README.md}`、历史 `docs/context/tasks/2026-09-12-mono2-agent-core.md`、`opencraft/{AGENTS.md,MONO2_MIGRATION.md}`、标准同步脚本的种子与 Portal 适配段、core 边界测试、模型 hook/client 与 agent-config 公开出口。
- 新查询 `frontend agents module dependency boundaries refactor` 无 context 命中；按 root 约定回到 `frontend/docs`、shared core 与准确依赖文件进行有界搜索，沿用已读 frontend-product-surface。
- 内存中的 TS AST 解析覆盖 AgentsPageClient/AgentSettingsPage/Button 可达的 231 本地源码文件、752 依赖边，其中 129 type-only、15 dynamic import。限定范围内无运行时 SCC 循环、UI→pages/contexts/repositories 或 contexts/repositories→pages 反向依赖；node_modules、生成 locale、CSS 和非字面量动态路径不在该结论内。
- `pnpm exec vitest run src/features/agent-management/__tests__/agent-core-boundary.test.ts src/features/agent-management/__tests__/agent-core-contract.test.ts src/pages/marketing/agent-model-config/__tests__/use-model-config.test.tsx`：3 files / 15 tests passed，exit 0。
- `cd opencraft && node scripts/sync-mono2-agent-console.mjs --check`：exit 1，首次报 `domain/instance-bot-errors.ts` drift；只读检查确认 source 存在、生成目标不存在，两个路径无本轮 git diff。该失败属于未修改源码的基线，尚未修复。
- 实现时必须关注 OpenCraft 对 Dialog/Select/Popover class 字符串的生成适配、新 Radix 依赖解析、lazy CSS 与独立 lockfile；同步只能使用标准脚本。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：exit 0；errors、warnings、broken_first_party_links 均为空或 0。该结果只验证文档契约与链接，不代表 UI 验收。
- B4-P 窄修复例外：独立 HEAD/current/无 Tooltip 内存对照证实 copied-SOUL 摘要回归来自旧清理 effect 对中间 commit 的依赖。Leader 允许把本地徽章清理限定为同 Bot 原卡真实移除，以保持复制 SOUL 的原显示行为；不改注入/保存/请求命令、配额或取消。修复须先回归测试、再独立审查，不按历史基线豁免。

## scan_scope

`frontend/src/lib/agent-routes.ts`、`frontend/next-site/agents-page-client.tsx`、Agents 页面与 UI 控件、相邻测试。未扫描无关服务代码。

## scan_output

页面矩阵与事实摘要见 brief；无全仓图谱或新扫描产物。

## handoff

实现已冻结，B1至B6均已独立审查放行；双站最终定向测试/check/build与OpenCraft干净安装/定向测试/完整gate通过。浏览器、终端、Workbench暂缓。5188国内站mock预览已恢复，等待用户验收，不进行提交或归档。

## checkpoint

### stage

实现与本地验证完成，等待用户验收。完整gate先后遇本地node-pty helper执行位、独立DSH runtime未安装两项环境缺失；仅修复本任务安装产物后，各原失败用例和最终完整gate均通过。成就排除，浏览器/终端/Workbench暂缓；批准brief未改，范围收缩记录于计划和模块矩阵。

### verified

独立分支、基线 SHA、路由矩阵、配置本地化与专用内容边界均来自本轮源码。B2 Leader 定向回归 23 files / 167 tests passed；B3 Leader 独立回归 29 files passed / 1 skipped、380 tests passed / 13 skipped；`pnpm check` exit 0、172 current / 276 baseline / 0 new / 104 resolved，i18n 0 errors / 47 既有 warnings；reviewer 独立复核无阻断项。移动 Sheet、Tooltip 原生选文、QQ 方式/凭据焦点、诊断 Select 键盘和通道 6px 圆角有实际浏览器证据。

B5-A：Leader独立CN17文件559项、专用global4文件20项、真实global新增14交互+旧header1项通过；developer check/typecheck exit0（170 current / 276 baseline / 0 new）。独立review CN247、global14+9项通过，无本批阻断，原请求/回调断言保留。390/1440真实表单6px、可见初始焦点/操作区、嵌套技能/上游/时间取消与首尾Tab、真实控制台Esc回新建均有浏览器证据；全用合成数据或已有mock，不触发远端写入。有界图270文件916边、25个新增可达view无指定循环/反向导入，六类Radix实际共用同一focus-scope与dismissable-layer模块。旧主文件global的75同名失败由4份HEAD源码内存对照复现（其余共享模块/依赖仍当前），不称完整clean-HEAD或全global测试通过；Root CN有一条HEAD已有的标点翻译警告。

B5-R验证补充：Leader CN/global各7文件70项（39.46s/38.74s），check exit0、170 current/276 baseline/0 new/106 resolved；独立网站各24项、Files各44项与3个额外用例。273文件932边的有界图、28个task-added view无指定循环/反向依赖；六类Radix解析一致。390/1024/1440文件焦点/单选/隐藏开关/无横溢出，390/1440网站浮层/Tab/Esc与复制DOM兼容窄修均有实际证据。此处为已验证补充，远端写入和实际剪贴板未执行。

B5-H验证补充：Leader两站DSH4文件各56项（27.42s/30.22s）、Chat3文件各14项（7.42s/5.65s）；开发合计各70/check0new，独立DSH与Chat审查通过。DSH长名选中值曾将375px文档撑到572px，修正真实flex子项后375/375，保留完整ARIA。390/1024/1440运行卡及修复/删除焦点已验证；实际Chat1440/1024无外层滚动，SDK替身状态更新保持同mount/首API引用，手机长错误不溢出。当前有界图275文件952边、30个新展示文件无指定循环/反向依赖；真实SDK/远端操作未验证。

### unverified

各批P2均已关闭，约定本地验证已完成。国际站旧定时任务全主集75个HEAD同名失败不扩修；本地mock不能证明真实模型、SDK远端会话或有副作用操作可用，JS构建不等于原生实机验收。正式设计Owner批准与用户验收仍待确认。

### discard

不沿用其他分支的旧活动任务；不使用旧工作区 SDK 版本作为当前事实。

### restore

工作目录：`/Users/junweicao/LightVela/orcaterm/mono2-frontsandbox-agents-radix-refactor`；任务 brief 是本轮范围。

### next_action

由用户检查[本地mock预览](http://127.0.0.1:5188/agents/automations/)及[验证报告](../../../.workflow/native/changes/agents-radix-refactor/report.md)。等待验收；不自动提交、推送、MR或归档。
