# 国内站隐藏 OpenCraft Chat

## goal
国内站控制台默认使用 AgentChat，F12 执行 show() 后使用内嵌 OpenCraft，并复用控制台当前身份。

## non_goals
- 不开放国际站，不迁移旧聊天记录，不合并、发布或操作生产。用户已授权本轮 commit、push 和创建 MR。

## requirement_refs / requirement_excerpt
- 本会话用户：先搞国内站，浏览器 F12 输入 show() 切换，相当于隐藏发布。

## interface_refs / data_structure_refs
- AgentChatMigrationSurface / EmbeddedWorkbenchConfig：DOM property 传 credential accessor，不序列化 token。
- LightVelaAccountService：借用当前宿主 session，认证生命周期仍由控制台所有。
- embeddedHostProfile：物理 Instance + native Profile 隔离。

## history_context
- current_design_refs: opencraft/docs/platform-architecture.md 的 Embedded Workbench Shell；docs/engineering/domains/agent-gateway-runtime.md；frontend/openspec/spec.md 12.5。
- relevant_evolution: 基于 origin/master 4a3b49a46；已有 show() migration 与同源静态制品打包。带入本会话已验证的 Hermes PTY argv 启动修复。
- superseded_refs: 无。

## acceptance
- 默认不请求内嵌模块；国内 show() 切换；关闭释放 owner；国际站不启用新 Chat。
- 当前控制台凭据能认证 API；不写 OpenCraft 本地 token；会话改变/退出后旧 accessor 拒绝，新 owner 重新初始化。
- Profile 作用域、旧 Chat fallback、迟到准备结果受生命周期保护。
- 前端聚焦测试/check/build；OpenCraft 两端类型/聚焦测试/boundaries/内嵌 build；浏览器验证；文档影响检查。

## affected_paths
- frontend/src/pages/marketing, frontend/src/repositories/http-repositories.ts
- opencraft/apps/workbench-web/src/embedded-chat, runtime, plugins/lightvela-platform, plugins/lightvela-hermes

## required_context / context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md | 根边界 | 授权、路由、交付 |
| frontend/AGENTS.md | 前端约束 | 验证与现有组件 |
| docs/context/project/services/frontend.md | 文案路由 | 服务边界与语言邻接 |
| opencraft/AGENTS.md | 运行时约束 | Owner 与真实客户端验收 |
| docs/context/domains/site-environment-routing.md | 国内灰度 | 双站独立 |
| docs/context/domains/identity-access.md | 登录态 | 身份权威 |
| docs/context/domains/agent-gateway-runtime.md | Hermes 连接 | 源码与运行时区分 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 邻接 | 检查 vitest 与现有规格 |
| docs/context/project/upstream-subtrees.md | 生成闭包 | 脚本同步 |
| opencraft/MONO2_MIGRATION.md | mono2 权威 | 不手改生成副本 |
| opencraft/docs/platform-architecture.md | 内嵌设计 | 外壳与凭据生命周期 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 维护规范 | 模型与证据分层 |
| opencraft/.agents/skills/opencraft-maintenance/references/verification.md | 验收 | 聚焦测试及浏览器 |

## evidence
- 现有 embedded release matrix 同源路径 /__opencraft/；本次无线上部署。

## risks
- 真实账号、TAT 和远端 Hermes 联通仍需上线/授权环境验收；模拟浏览器证据不能替代。
- show() 是用户本地持久化 UI 开关，不是后端访问权限控制。

## validation
- frontend 聚焦 129/129、OpenCraft 聚焦 118/118、三 workspace typecheck、boundaries、frontend check（0 new）与 CN/embedded builds 通过。真实构建 browser smoke（synthetic API）通过；文档验证通过。全量 gate 在未修改的 extension-artifacts.test.ts:38 断言失败（artifactRef），详细证据见 checkpoint；未宣称全仓通过。

## decisions
- 复用既有 Web Component，准备期间仅显示中性加载态，初版失败时保留旧 Chat fallback（已由下文 embedded_connection_recovery 取代为原位重试）。
- 宿主同步发布无凭据会话变更通知，旧实例先 revoke/dispose，再构建新实例；OpenCraft 元数据仅内存。

## scan_scope
- frontend 控制台 wrapper/session/release matrix；opencraft embedded/account/supervisor/Hermes bootstrap。

## scan_output
- 精确 openspec/specs/agent-settings/spec.md 不存在，改查 frontend/openspec/spec.md 12.5。

## handoff
- 本地实现与聚焦验证完成；用户已授权提交 MR；真实双 Bot 并发收发未验证，不合并或发布。

## 内嵌模型默认值修正
- 当前问题：嵌入的 Composer 暴露模型选择，旧草稿值可能覆盖 LightVela 已配置模型，导致发送前匹配失败。
- 用户要求：当前 Bot/Profile 的 Hermes 配置拥有默认模型，用户直接发消息；内嵌隐藏模型/思考选择，独立 OpenCraft 保留选择能力。
- 实施：内嵌 Host 使用 host-default 策略；命令编译前忽略草稿模型与 effort，按 Profile 的实时默认目录检查能力并选择模型，保留 Hermes 自身思考设置。跟进/排队消息仍属于当前执行。
- 验证：旧 auto/其他模型残留、配置变更、无默认/不可用目录拒绝且不发送、独立界面选择不变；本地重建与 DOM 验证。

## IME follow-up 2026-09-30
- 目标：内嵌输入框不重复插入拼音首字母；保持原生组合输入和页面空白处 type-to-compose。
- 路由 `opencraft composer 中文输入 IME 首字母重复` 无 Pack；有界检索命中 app.tsx 全局 keydown 与 codex-composer dispatchTransaction。根因候选为 Shadow DOM retargeting，使用真实 DOM 事件回归验证。
- context_receipt 补充：opencraft/docs/chat-ui-architecture.md（嵌入呈现与输入）；frontend/vitest.config.ts（jsdom 集成测试邻居）。既有维护 skill、verification 与 adjacency 已复核。
- 验证：先证明 shadow editor 的初始 keydown 被误判，再修正事件路径与 IME 229 保护；聚焦 DOM 测试、workbench 类型检查、嵌入构建、浏览器预览。

## Thinking label follow-up 2026-09-30
- 用户反馈工具间隙仍显示 Thinking：补齐 AgentActivityGroup header 路径，与 Turn、Reasoning 共用 ThinkingLabel；保留真实 reasoning summary，中文显示既定“思考中...”。
- context_receipt：docs/context/project/services/frontend.md；此前读取的 OpenCraft 维护规范与 chat-ui-architecture 继续适用。有界检索 Thinking 命中 chat-core activity header 和 Renderer；检查既有 i18n-runtime.test.ts 的 SSR 邻居。
- 验证：真实本地化组件 SSR + activity header 来源回归、类型检查、i18n 检查、嵌入构建。

## Voice input follow-up 2026-09-30
- 用户要求恢复语音入口并参考 ref。现有 startup 已加载 vela.voice-input，内嵌 presentation.composerActions 空白名单隐藏按钮；仅放行 vela.voice-input.toggle，复用现有 Provider 和听写事务。
- 路由无 Pack；有界搜索命中 policy、ComposerExtensionActions、voice extension 与 BrowserSpeechInputProvider。ref/codex 不存在，ref/bb 为未检出的 submodule，固定 commit 62fe3bc46bd1d935b71482b62a1e0887ffb83487；不声称读取该源码。
- context_receipt：opencraft/design/dictation-interaction/findings.md（既有参考与所有权记录）；speech provider 与 native-speech/dictation-ledger tests（实现及测试邻居）。
- 验证入口允许列表、现有听写生命周期测试、类型检查、构建、浏览器麦克风按钮；不自动开启麦克风或发送语音。

## message_copy_localization
- 范围：长消息展开/收起、消息状态、复制及附件图片提示；使用现有 en-US / zh-CN 目录，不改消息内容、发送行为和国际站启用开关。
- 邻接核验：frontend i18n 脚本与 OpenCraft catalogs/check-i18n，后者是这些组件的翻译 authority。

## header_rename
- 内嵌既有会话标题后提供编辑图标，hover/aria 文案“重命名”。使用现有 ThreadTitleWriter 与 threadManagement.rename，同一 Host/Thread 缓存刷新更新标题和宿主侧栏；草稿及无 rename capability 时不显示。
- 弹窗复用 ModalSurface/Settings 输入控件，保存中防重复提交，失败保留草稿，取消无写入，Host/Thread 切换卸载编辑 session。验证 writer/cache 聚焦测试、语言/类型/构建与真实组件异步成功/失败路径。

## browser_dictation_timeout
- 用户截图为语音 Footer transcribing/0:00；实查 profile 页面已回到普通输入并有草稿，未捕获当时错误，不将截图直接归因于网关。路由查询 opencraft voice-input dictation stuck starting cancel 无 Pack，精确检索 provider/VoiceInputAction/DictationFooter 后确认 Web Speech stop 缺少 deadline，异常 abort 可打断 UI 清理。
- 修复 BrowserSpeechInputProvider：onstart 确认 listening，启动 15s / 收尾 8s 超时；取消安全 abort，终态清理定时器并拒绝晚到事件。不主动开启真实麦克风、不发送推理、不刷新含草稿用户页。

## header_inline_rename
- 用户明确替换上一版弹窗：标题槽位显示原位输入框，Enter/失焦保存、Escape 取消；空白/未改动不写入，IME 确认不触发保存。保留 Host/Thread 身份 key、writer、pending 与错误处理。

## sidebar_title_spacing
- 用户要求长标题省略号与更多按钮分开；仅 openCraftChatEnabled 会话行增加 44px 右侧内边距，覆盖按钮 32px + 右偏移 4px + 间距 8px。
- 路由 frontend agents chat sidebar title truncation styles 无 Pack；有界检索命中 agent-settings-page.tsx 和 styles.css。context_receipt：frontend/AGENTS.md、frontend/DESIGN.md、frontend-runtime-openspec-i18n adjacency、site-environment-routing 正式文档；检查既有 agent-settings-nav-spacing.test.ts 测试邻居。

## embedded_host_selector
- 用户要求隐藏新会话环境选择器和连接点。由 App shell embedded 呈现策略传 showHostSelector=false，NewThreadDraftPage/ExecutionUtilityBar 不挂载该菜单。默认 true 保留独立版入口，不改 Host 连接与提交 ready 门禁。
- 路由 opencraft new-thread-draft-page host selector embedded 无 Pack；精确搜索定位 ExecutionUtilityBar；复用已读维护规范、平台架构、chat-ui 架构及 frontend adjacency，检查现有 embedded-workbench-presentation-root 测试邻居。

## companion_placeholder
- 内嵌新会话占位文案改为“和你的 AI 伙伴聊聊，或交给它一个任务”；Shell 传本地化 placeholder，独立版保留既有默认。英文源文案与中文目录同步。路由 frontend-product-surface，context_receipt 复用 frontend service 文档与前述 OpenCraft 规范。

## companion_heading
- 延续上一轮新会话产品文案范围与 context_receipt，将内嵌主标题改为“今天想聊点什么？”，提供英文翻译；Shell 通过 heading 槽位传入，独立工作台保持默认。

## companion_all_locales
- 两处文案覆盖控制台七套字典，zh-SG 复用 zh-CN。新增内嵌专用部分 catalog，由嵌入入口注入 LocaleController，保持独立版语言列表原样；未翻译消息继续遵循英文 defaultMessage fallback。
- context_receipt：site-environment-routing domain、frontend service、frontend locales.config.ts/locales.json、OpenCraft catalogs/LocaleController；此前 frontend adjacency 与 i18n-controller 测试邻居用于确认宿主 locale authority。
- 验证全部控制台 locale 的两处格式化结果及动态切换、i18n、类型和嵌入构建。

## embedded_project_selector
- 用户确认隐藏项目选择。将此前仅控制 Host 选择器的开关收敛为 showExecutionControls，内嵌时不挂载整个 ExecutionUtilityBar；独立版保留默认 true。无目录选择写入，保留 draft 默认执行目录与连接 ready 门禁。复用当前同一组件的 context_receipt 和验证范围。

## embedded_initial_frameless
- 新会话初始页移除宿主边框/圆角与内嵌空白标题栏；通过 sessions 事件显式 isDraft 同步，已有会话恢复原框和标题。保留输入框外观。
- context_receipt 复用 frontend service、frontend AGENTS、OpenCraft 维护与 chat-ui 文档；有界搜索命中宿主容器、AppShell header 和 sessions bridge，验证现有迁移组件测试邻居。

## embedded_connection_recovery
- 用户批准自动重连、草稿保留、超时反馈和手动重试。仅国内隐藏入口启用；不处理已解释的可选 RPC Issue，不增加旧 Chat 自动回退，不重发消息或重启运行中的 Bot。
- Router query `frontend opencraft embedded Hermes connection reconnect draft recovery` 无匹配；有界搜索发现 embedded create 在首次 ensureConnected 失败后 dispose，宿主 opencraft-error 自动降回 legacy；共享 runtime 已拥有指数退避与 thread hydration。
- 沿用 Application/Host/Thread/Composer owner：首次失败继续观察同一 runtime，连接状态经 Web Component 发布；宿主只投影提示和调用 reconnect。连接中断不得重建已展示的组件。断网草稿及附件仅保证当前页面实例内保留，不扩展成跨刷新持久化。
- context_receipt：frontend/AGENTS.md、opencraft/AGENTS.md、opencraft-maintenance skill 与 verification、platform-architecture Embedded 部分、chat-ui-architecture 恢复部分、frontend adjacency 与迁移组件测试邻居均已复核。
- 验证：首次失败后恢复、断线保留 DOM/草稿、手动重试去重、超时、卸载与身份切换拒绝迟到回调；复用 runtime 退避/恢复测试，类型检查、i18n、构建与浏览器。

## conversation_frame_removal
- 用户授权将无外框布局扩展到已有会话，保留标题、重命名和 Composer。只作用于国内控制台启用嵌入模式的表面及嵌入主内容阴影。
- 路由 frontend opencraft embedded chat conversation frame 无匹配；有界搜索定位迁移表面与内嵌 shadow stylesheet。沿用已读 frontend/AGENTS.md、opencraft/AGENTS.md、frontend-runtime-openspec-i18n 邻接卡、维护及验证 Skill，补读 frontend/DESIGN.md、chat-ui 架构相关段。

## embedded_right_panel
- 目标：国内 show() 门禁内复用现有 RightPanel，默认收起、可 resize，网页标签与聊天文件链接只读预览。non-goals：终端、整机目录浏览、文件编辑、远端浏览器画面、国际发布。
- 路由 opencraft embedded right panel browser file preview 无匹配，bounded exact search 定位 presentation-policy、App、RightPanel、resource renderer、web application 与 browser coordinator。context_receipt：此前 root/frontend/opencraft AGENTS、维护 Skill/verification，补读 browser-workbench-architecture.md、design/README.md、design/invariants.md；frontend-runtime-openspec-i18n 邻接卡与 embedded presentation 测试。
- 面板资源维持 Conversation owner；嵌入 Browser metadata 与 bindings 使用独立 Application 内存存储，Bot/账号切换 dispose，不读取共用 localStorage browser 元数据。

## mr_submission
- 用户明确授权提交 MR，范围为本会话国内隐藏 Chat 接入、连接恢复、交互和右侧预览改动。
- context_receipt：docs/context/flows/tapd-gongfeng-delivery.md、.agents/skills/gongfeng/SKILL.md，以及已复核的 frontend/AGENTS.md 与 opencraft/AGENTS.md；执行个人 gongfeng-fast-mr 与 karpathy-guidelines Skill。
- 提交前补验 frontend check（0 new diagnostics）、前端45 tests、runtime123 tests、Bot管理32 tests、130文件生成闭包全部通过；沿用同代码的Web类型、边界、i18n、嵌入构建及浏览器证据。
- 全量门禁的既有失败与真实环境验收边界见checkpoint，不能宣称全仓通过。

## markdown_file_preview
- 用户要求补充 Markdown 排版预览和预览/源码切换，沿用只读文件读取；不添加编辑或新文件系统协议。
- Router `opencraft markdown file preview workspace-resource-panel` 无匹配；有界检索 resource panel/model 与 chat-render-web 公共入口。复用 WebChatDocument 与既有 Blob media loader，文件身份决定呈现状态。
- context_receipt：opencraft/AGENTS.md、opencraft-maintenance Skill/verification、design/README.md、design/invariants.md、platform-architecture Embedded 段、frontend-runtime-openspec-i18n 邻接卡；检查 embedded-companion-locales 测试及 locale catalogs 邻居。
- 验证计划：聚焦文件/Markdown/i18n 测试、Web 类型和边界、embedded build、真实浏览器组件预览/源码/文件切换验收。

## ci_isolated_frontend_test_fix
- CI 日志源码 c96a61d5f：frontend typecheck TS2307，opencraft-type-to-compose.test.ts 跨服务引用在隔离 guard 只复制 frontend/velalink/shared 后失效；i18n WARN 不是失败原因。
- Router `CI change impact directory guard opencraft` 无匹配；精确检索命中测试及 .ci/checks/frontend_guard.sh，检查 frontend-runtime-openspec-i18n 邻接卡和 frontend/vitest.config.ts。
- context_receipt：frontend/AGENTS.md、现有 opencraft/AGENTS.md /维护Skill、karpathy-guidelines、devops-pipeline Skill（只读日志，无启动/取消流水线）；复用交付路由上下文。
- 将真实 Shadow DOM 回归迁入 OpenCraft，使用自身 jsdom devDependency 与 node:test，不修改生产代码、类型检查基线或 CI 复制边界。计划运行迁移后测试与真实隔离 frontend guard。

## embedded_composer_height_followup
- 用户要求输入框稍增高：内嵌编辑区域50→74px，复用统一Composer；无协议、草稿及提交行为变化。
- Router无匹配；初始路径查询未命中后rg --files定位embedded-chat/embedded-workbench-element.tsx。context_receipt沿用karpathy、OpenCraft AGENTS，复读维护Skill/verification、chat-ui-architecture、design/invariants和frontend adjacency，检查build-release-artifacts测试邻居。
- 计划Web类型、嵌入构建和实际预览尺寸检查；5174当前无监听，按local-preview Skill恢复国内预览。

## companion_followup_placeholder
- 已有会话占位提示复用chat.companionPlaceholder及控制台七语言翻译，消除“修改要求”的场景限制；独立版保留原默认。
- context_receipt补读site-environment-routing domain；沿用OpenCraft维护/karpathy规则与chat-ui架构。精确检索定位App主Composer的suppliedPlaceholder槽位，检查embedded-companion-messages翻译邻居。Web类型、i18n、嵌入构建及浏览器占位提示验收。

- 用户随后要求区分开聊前后：已有会话使用独立chat.companionFollowupPlaceholder“继续聊聊，或告诉我接下来想做什么”，新会话保持原文案；全部七语言覆盖。沿用同一locale路由和context_receipt。

- 文案精简：用户要求去掉“继续聊聊”，已有会话最终采用“告诉我接下来想做什么”；其他语言同步去掉开头继续聊天的短语。

## CR !4851 repair (2026-09-30)
- 合并 origin/master 948c3a897 的九处冲突，保留主干代码编辑器、保存快照、测试清单与内嵌 Markdown/只读功能的并集；锁文件从已合并 manifest 重新生成。
- 迁移测试明确固定国内 locale，CN/global 各 10 项通过。补充 prepare/show 迟到、启动 error 后重试重建、旧 Bot 事件及空 Profile 的行为覆盖；异步延续引用该次 candidate，退休/失败闸门显式阻止 show/adoption。
- 真实文件面板在 Query mutation 边界测试：预览即使直接调用保存也拒绝，零 write/invalidate；可编辑面板按捕获目标写入。测试注册到 workbench 聚合。
- 临时移除 prepare 闸门、adoption 闸门、只读保存保护分别触发回归测试失败，恢复后通过。
- Web typecheck、boundaries、embedded release build、frontend check（0 new）、workbench 297/297、embedded/resource 17/17通过。修正两条因右栏多语言化失效的英文源码断言；本机 node-pty spawn-helper 缺执行位，恢复依赖文件执行位后终端测试通过，不提交 node_modules。
- npm test 在 shared-control-standards 的 focus-indicator 断言停止（14/15），对应样式块和测试与 master 一致，不宣称全量绿。当时 CI OpenCraft guard 仅做闭包校验；后续远端并发提交新增 test:embedded-ci，见下方合并记录。
- 本轮文案“告诉我接下来想做什么”及高度 74px 已在 4aed435a6；随修复更新原 MR，不合并或发布。

- 最终隔离 frontend guard 全部通过：frozen install、check/i18n、发布脚本测试、CN/global 静态构建；仅本机 Vitest API host 显式改为 127.0.0.1，源码与构建配置未改。文档和 staged impact 通过，catalog.jsonl 原有变动排除。

## mr_4851_cr_followup_2026_09_30
- 目标：解决 !4851 与最新 master 的 9 处冲突，保留两侧行为，并补齐只读写入、迟到启动结果、缺失 Profile 与 OpenCraft CI 验证。
- 非目标：合并 MR、发布生产、真实 Bot 发消息或写实例文件。
- 权威与上下文：用户提供 CR 结论；根/前端/OpenCraft AGENTS、交付 flow、OpenCraft 维护 Skill、现有 Task Pack、平台/Chat/UI 设计与 frontend 邻接卡。先在隔离 worktree 从 `7813b44e2` 合入 `origin/master`，逐处解决冲突；生成副本只由官方同步脚本重建。
- 决策：文件面板的保存参数使用 master 的 Host/path/key/text 快照，同时在执行写入前检查 `previewOnly`；Markdown 排版预览与 CodeMirror 源码/编辑器共存。测试注册取两侧并集。嵌入启动要求非空 Profile；迟到 `prepare` 和 `show` 分别断言不会调用新 owner。
- CI：OpenCraft guard 在生成闭包检查后执行锁定依赖安装及 `test:embedded-ci`，覆盖本 MR 的 12 个 OpenCraft 测试文件；测试文件串行执行，避免并发下偶发失败。frontend 区域测试固定 CN region，使国内文案断言稳定。
- 验证：OpenCraft guard 冷安装与 12 文件 142/142、frontend 嵌入组件 8/8、Web typecheck、OpenCraft i18n、frontend check（166 current /171 baseline /0 new）、嵌入 release build、7 个 CI guard 单测、documentation 与 docs-impact 通过。合并提交 `2a65b0388` 后官方重建的 130 文件生成闭包通过；远端 CI 仍需复核。

- 推送时远端出现并发 CR 修复 6d60a595c，普通 push 拒绝后合入该提交。保留远端 CI 冷安装与串行 embedded suite、writeWorkspaceResource 边界与测试，同时保留本轮真实面板 mutation 回归、候选实例生命周期闸门、七语言 followup 和 74px 高度。

- 并发提交合入后，frontend CN/global 各12/12、frontend check 0 new、embedded-ci 143/143、Web types和embedded build通过；保留两侧验证记录。
