## stage
本地实现与聚焦验证完成；全量 gate 未通过，等待代码评审/真实环境验收。

## verified
- 追加核对多 Bot 隔离：Instance/Profile 绑定、Profile scoped thread/list/start 已有覆盖；修复非主 Bot 缺少 Profile 时被宿主默认成 main 的边界，改为传空值由 embeddedHostProfile 拒绝。追加前端 38/38、host profile 2/2 测试通过，frontend typecheck 0 new；真实双 Bot 收发仍待验收。
- 基于 origin/master 4a3b49a46 的隔离 checkout；此前 Hermes argv 修复已带入。
- frontend 聚焦（含 repository/持久化开关）129/129；OpenCraft account/embedded/Hermes 118/118；三 workspace typecheck 与 boundaries 通过。
- frontend pnpm check 0 new diagnostics；CN build、embedded release build 通过。
- 浏览器真实模块 + 合成 API：默认 0 module 请求；7 次 API 请求使用宿主 credential；未写 OpenCraft persistent token，未消费 host OAuth，关闭释放 component，失败回退，0 pageerror。
- 浏览器发现并修复 generated repository context eager OAuth 副作用、准备完成前释放产生的未处理 readyPromise 拒绝。

- 最终 CN build、129 前端用例、118 OpenCraft 用例和可复用 browser smoke 再验证通过。
- 全量 npm run gate 已通过 i18n/boundaries/全部 workspace typecheck/Electron launch；在 extension-artifacts.test.ts:38 失败：reload 后实际记录多出 artifactRef，deepEqual 不通过。失败用例未关闭持久化资源导致进程不退出，已终止该测试子进程。本次未修改该用例及其直接依赖；不宣称全仓 gate 通过。
- staged change-impact 与 diff whitespace 检查通过。

## unverified
- 真实账号 TAT / 云端 Hermes / 模型收发；没有上线验证或发布。

## discard
- 不将测试 fixture 截图称为真实账号 Chat 截图；不修改旧 fix worktree。

## restore
- 当前 checkout cn-opencraft-chat；脚本 smoke-console-embedded.mjs 使用真实构建及 synthetic API。
- 生成副本含当前 master 原有未同步 locale/route，均由 sync:mono2-agent-console 机械再生。
- 单独旧 worktree opencraft-hermes-bootstrap 的 staged 修复保持原样。

## next_action
如获提交授权，按当前分支提交 MR；真实账号 TAT 与收发需部署后验收。未获得 commit/push/MR/发布授权。

## local_preview
- 用户指定国内站 5174；已从本 checkout 启动 pnpm dev:cn，内嵌产物通过本地忽略的 public/__opencraft symlink 同源提供。
- 国内 API 通过仅监听 127.0.0.1:5175 的开发代理转发至 https://api.lightvela.com；解决 localhost 浏览器 CORS，未更改生产配置。脚本 /tmp/cn-chat-api-preview-proxy.mjs，不保存凭据。
- 本地页面与 loader HTTP 200；匿名 API HTTP 401 为正常未登录。用户需正常登录，登录态 Chat 视觉/收发尚未验收。

## local_preview_oauth_fix
- 用户反馈微信授权后回首页未登录；Chrome 实际 URL 确认 wechat_state_mismatch。先前本地 API 代理使 OAuth Cookie 落在 127.0.0.1，而 provider callback 为 api.lightvela.com；线上 return_to 也不接受 localhost:5174。
- 沿用用户现有已启用 Whistle lv 规则 lightvela.com -> 127.0.0.1:5174，未修改代理规则；重启国内 Next 预览，NEXT_PUBLIC_AUTH_API_BASE_URL=https://api.lightvela.com，停止临时 5175 API 代理。
- Chrome 打开 https://lightvela.com/agents/chat/，DOM 确认现有登录态恢复、OpenCraft 编辑器加载、Hermes Connected；next-devtools 开发资源和 /__opencraft/embedded-workbench.js 确认本地版本。
- 无凭据输出的 OAuth start 检查返回 307，callback host api.lightvela.com，接受 https://lightvela.com/agents/chat/ 回跳。未代用户重新扫码；首次微信完整授权仍需用户操作。
- localhost URL 仅供匿名预览；登录态验收请使用上述 Chrome 域名映射入口。后端仍为上海 shprod，未发布。

## chat_loading_flicker_fix
- 用户反馈切到对话时先闪 AgentChat。宿主新增 loading owner；开关开启后的首次进入/重新准备只显示中性加载态，不挂载 AgentChat，show 成功后展示 OpenCraft；关闭开关或加载失败仍回退旧 Chat。
- 聚焦测试 3/3，包含已开启开关的首次进入不挂载 legacy、延迟 show、探索/对话切换、失败与关闭开关回退。pnpm check 166 existing / 171 baseline / 0 new；国内 pnpm build:cn exit 0；文档与 staged change-impact 通过。
- Chrome 实际重载及探索/对话切换确认仅出现“正在加载聊天…”状态；未发送消息。预览重启，继续国内 5174 + 上海 API 与现有域名映射。

## model_preflight_diagnosis
- 用户截图发送前报 CAPABILITY_UNAVAILABLE / 所选模型已不可用，选择器显示回退格式 Auto。源码定位 composer-appserver command-port 与 workbench-runtime resolveCompilerOptions：catalog 无相同 id/model 时在发送前拒绝。
- 当前真实会话只读模型目录核对：session rawSelection 与 canonicalSelection 均为 hermes-model:custom:auto，当前 model.options 为 model=auto/provider=custom，目录含对应完整 ID。截图 Auto 与当前正常 auto + Medium 有差异，符合旧裸 auto 选择没有匹配编码目录的情况；未读取故障标签页内部 draft，未宣称已捕获其提交参数。
- 新预览标签恢复同一会话，模型选择器正常显示 auto 与能力。用户原报错标签无法通过浏览器工具读取；未刷新该标签、未代发或重发消息。建议原页面重新选择 auto 以更新选择值。
- 临时诊断仅输出模型标识，已移除并重建 embedded release 产物；本轮未修改模型匹配/权限规则，未绕过发送校验。真实推理成功仍未验证。

## host_default_model_fix
- 用户纠正：内嵌 Chat 应直接使用 LightVela 当前 Bot/Profile 配置的 Hermes 模型，不要求重选。取代上一节临时“手动重选”的处理。
- 为内嵌 Host 配置 host-default 模型策略；命令编译前忽略草稿 model/effort，每次新 Turn 重读 profile-scoped Host 默认模型并校验输入能力，传 canonical model；不写入思考覆盖。缺少默认项在任何发送前拒绝；follow-up 保留当前运行 Turn 的模型语义。
- 内嵌新草稿与已有会话移除模型/思考选择器，读取同一 Host 配置目录。独立 OpenCraft 继续 user 策略。
- 相关 143 项测试通过，新增覆盖新会话/已有会话旧裸 auto 残留、连接后配置变化、保留思考设置、无默认模型时不创建或发送。5 个受影响 workspace 类型检查通过；边界检查与嵌入构建通过。
- Chrome 实际预览确认已有会话与新草稿均无模型选择器，Hermes Connected；未代用户发送真实推理请求，真实收发仍未验证。5174 使用更新的同源嵌入产物，原已打开页面需刷新。

## embedded_composer_height
- 用户要求输入框稍微加高：仅嵌入工作台 editor 最小高度设为 50px，已有会话从 26px 增加 24px，新草稿从 42px 增加 8px。
- workbench-web 类型检查、embedded release 构建与 diff whitespace 检查通过。Chrome 本地映射预览刷新后，DOM computed min-height 与实际 editor 高度均为 50px；未发送消息、未发布。

## ime_shadow_input_fix
- 2026-09-30 用户反馈每段中文前泄露拼音首字母。定位 app.tsx 全局 type-to-compose 使用 event.target；Shadow DOM 把目标重定向为自定义元素，首键 isComposing 未置位时错误插字。
- 提取 type-to-compose.ts，沿 composedPath 识别编辑器/控件所有权，保护 isComposing 与 keyCode 229。没有按字符串删首字母，不改用户已有草稿或历史。
- jsdom 使用真实 Shadow DOM 冒泡键盘事件，旧逻辑三项回归失败，修复后与内嵌宿主测试合计 6/6 通过。workbench-web 类型检查、embedded release build、文档与 staged/实际路径影响检查通过。
- Chrome 已刷新新版，确认现有登录态会话与可编辑输入框正常挂载；自动浏览器文字输入未产生内容，未据此声称系统 IME 实测通过。实际中文候选词上屏需用户复验，未发送消息、未发布。

## thinking_label_followup
- 用户截图指出工具执行间隙仍显示 Thinking。此前只改 Turn placeholder 与 Reasoning 空摘要，遗漏 AgentActivityGroup 的 core header，以及显式摘要 Thinking。
- 三条 Renderer 路径共用 ThinkingLabel，中文“思考中...”，真实 reasoning 摘要保持原文，English 保持 Thinking。新增 SSR 测试包含真实 activity header 派生来源；9/9 本地化回归通过，i18n 100 messages 检查通过。
- workbench-web 类型检查与 embedded release 构建通过，更新 5174 同源产物。未触发真实推理，未刷新用户正在执行的会话；页面刷新后才使用新版。未发布。

## stop_icon_style
- 内嵌 Composer 停止按钮去掉默认灰底、保留圆形交互区域，现有 CircleStop 图标由 17px 调至 24px、描边 2.25，使用主题主图标色（浅色黑环）。hover/active 仍沿用原主题反馈；停止逻辑不变。
- workbench-web 类型检查、嵌入构建、diff whitespace 检查通过。已更新 5174 产物；未触发真实回复来验收停止态，待当前回复结束后刷新查看。

## voice_entry_restored
- 语音扩展已在 runtime startup 加载，缺失原因是 embedded composerActions 为空；单独允许 vela.voice-input.toggle，复用已有 BrowserSpeechInputProvider/听写事务。
- ref/codex 缺失，ref/bb 仅 62fe3bc46bd1d935b71482b62a1e0887ffb83487 子模块占位，未伪称读到参考源码。
- 19/19 presentation、native speech 与 dictation ledger 聚焦测试通过；workbench-web 类型检查、embedded build、文档与 staged impact 通过。Chrome 本地映射页面重载后出现未禁用的 Start voice input 麦克风入口，位于附件前。
- 未开启麦克风、未发语音/真实推理；真实浏览器识别服务和麦克风权限需用户点击后验收。未发布。

## dictation_status_copy_hidden
- 用户要求隐藏波形下方所有听写阶段文案。修复 DictationFooter 的 sr-only 缺失样式，保留屏幕阅读器状态播报；内嵌单独隐藏 starting/transcribing 可见 status-label，保留加载图标、波形、时长和控制按钮。
- Composer 与 workbench-web 类型检查、embedded build 通过。隔离本地预览使用真实 DictationFooter 和嵌入构建样式，三个合成阶段确认状态标签 display:none，播报元素为 1px/absolute/clip 隐藏；浏览器截图确认无可见阶段文案。未开麦克风、未发消息；5174 产物已更新。

## queued_steer_icon
- 国内嵌入排队行的 Steer 改为仅图标，title 与 aria-label 中文为“立即插入”；能力不支持/待协调的禁用原因继续保留，未改入队与插入逻辑。
- Queue SSR 聚焦 7/7，i18n 101 messages 检查、Composer/Web 类型检查、嵌入构建通过；隔离真实 QueueTray + 嵌入样式浏览器核对 title=立即插入、span display:none、单 SVG、按钮宽 22px。未代发真实消息；5174 已更新。

## message_copy_localization
- 将长消息 Show more/Show less、消息状态、图片附件提示、复制消息/回复/命令/输出/计划及重试 tooltip 接入现有 i18n；31 个新增 ID，zh-CN 目录与英文 defaultMessage 保持 ICU 参数一致。消息原文及发送/折叠语义不变。
- check:i18n 132 messages 通过；Web typecheck、10 项 i18n + 11 项折叠/布局测试通过，embedded release build 通过，5174 页面 HTTP 200。
- 隔离浏览器使用真实 UserMessageBlock、LocaleRuntime 与嵌入样式，验证中文展开更多→收起、英文 Show less、切回中文再收起；消息未发送/评论/复制 tooltip 跟随语言。截图 /tmp/cn-chat-i18n-preview.png。未发送真实消息，未发布。

## header_rename
- 国内嵌入会话标题后新增 Pencil 图标，title/aria-label 按当前语言显示“重命名”；只对既有会话及 rename capability 开放。AppShellHeader 只提供 titleAction 槽位；ThreadRenameButton 复用 ModalSurface/Settings 输入组件，保存调用既有 ThreadTitleWriter→threadManagement.rename，缓存刷新驱动标题与宿主会话列表。
- 表单 60 字上限、trim、空白禁用、pending 防重复保存、失败保留草稿并显示本地化错误、取消无写入；按 Host/Thread key 隔离编辑 session。新 UI 状态不复制持久化 authority。
- i18n 139 messages、Web typecheck、writer/cache/presentation root 3 项测试、embedded release build、文档/staged impact/diff 检查通过。
- Chrome 真实本地映射会话验证标题图标/title=重命名、弹窗/原名/取消/焦点恢复；截图 /tmp/cn-chat-rename-dialog.png。隔离真实组件用替身保存回执验证空白禁用、pending、失败保留输入、重试成功及 trim。未改真实会话名，未提交/发布；5174 产物已更新。

## browser_dictation_timeout
- 截图显示 0:00 加载；实查用户 profile 页已恢复普通 Footer、附件/发送启用，保留当前草稿。语音过滤日志未捕获错误，未断言当时底层故障原因；发现 BrowserSpeechInputProvider 停止无 deadline、abort 异常可中断取消。
- Browser provider 以 onstart 确认 listening；启动 15s/停止 8s deadline；超时/失败终结一次、安全 abort、清定时器、拒绝迟到结果。取消接口异常不阻断恢复。无真实麦克风/推理调用。
- 新增模拟时钟回归 + ledger 共 8/8；voice-input/Web typecheck、embedded build、文档/staged impact/diff 通过。浏览器真实 CodexComposer+VoiceAction+BrowserProvider，仅替换 SpeechRecognition，重现 stop 无 onend 的禁用 Footer，8s 后自动恢复原草稿/普通按钮；再次启动后 cancel 在 abort 抛错时仍恢复，未发送。截图 /tmp/cn-voice-recovery.png。
- 5174 制品已更新。未刷新用户有草稿的旧页，用户保留草稿后刷新使用新版；未提交/发布。

## header_inline_rename
- 按用户要求替换 header_rename 弹窗：EditableThreadTitle 占用标题内容槽位，点击 Pencil 将标题直接换成输入框并聚焦全选；Enter/失焦保存、Esc 取消，空白/未改动不写入，isComposing/keyCode229 避免中文选词回车误保存。
- 沿用 Host/Thread key、ThreadTitleWriter 与失败保留草稿，保存期间只读并防重复；新增样式消费已有 thread-title/metadata token，无弹窗或遮罩。
- i18n 136 messages、Web typecheck、3 项 writer/cache/presentation 测试、embedded build、文档/staged impact/diff 检查通过。Chrome 真实预览验证标题替换/自动聚焦全选/Esc 还原，截图 /tmp/cn-chat-inline-rename.png；真实组件替身回执验证 Esc 零写入、Enter 保存 trim 一次、失焦保存一次。未改用户真实会话名；5174 已更新，未发布。

## sidebar_title_spacing
- 完成国内隐藏 OpenCraft 会话行右 padding 44px；浏览器真实列表测得 8px 标题/按钮间距，长标题 fixture 在 240px/208px 宽度均截断且保留 8px，无真实会话写入。
- pnpm check 通过（0 new TypeScript diagnostics）；侧栏 spacing/tabs 43 tests 通过；git diff --check 与 staged change-impact 通过；5174 HTTP 200。本次仅 CSS/条件 class，未运行会破坏当前 Next dev 输出的生产构建。临时验证页已删除；未提交、推送或发布。

## embedded_host_selector
- 完成：内嵌 Shell 传 showHostSelector=false；只移除环境选择菜单和连接点，项目入口与 ready 提交门禁保留。独立版默认 true。
- Web typecheck、embedded presentation 聚焦测试、release embed build、git diff --check 均通过。真实 Chrome 空草稿预览重新加载后点击新会话，AX 确认保留 Choose project folder、不再有 Choose execution node/LightVela Hermes/Connected。未刷新含 / 草稿的用户 Bot 标签，未发送消息。

## companion_placeholder
- 内嵌 Shell 指定本地化占位文案“和你的 AI 伙伴聊聊，或交给它一个任务”；不暴露组件品牌。独立工作台默认保持原文。
- i18n 137 条、Web typecheck、embedded presentation 测试、嵌入 release build、git diff --check 通过；真实本地预览新会话 textbox 与可见 placeholder 均确认新文案。未发送消息、未发布。

## companion_heading
- 控制台新会话标题改为“今天想聊点什么？”，复用本地化与 Shell 文案槽位，独立版默认不变。
- i18n 138 条、Web typecheck、embedded presentation 测试、release build、diff check 通过；真实 Chrome 新会话 h1 确认为新文案。未发送消息、未发布。

## companion_heading_refinement
- 用户强调不限于 chatbot，标题调整为“今天想一起做点什么？”，英文同步 What would you like to do together today?。仅文案变更。
- i18n 138 条校验、release embed build、diff check 通过；真实 Chrome 新会话标题已确认。

## companion_all_locales
- 标题与 placeholder 完成全部控制台字典语言覆盖；内嵌入口注入专用部分 catalog，独立版不新增不完整语言选项。未覆盖其他文案仍以英文 defaultMessage 回退。
- 从 frontend locales.json 驱动动态切换验证，每个语言验证翻译不回退英文、zh-SG 与 zh-CN 一致；i18n controller/runtime 与新覆盖测试 11/11 通过，i18n 138 条校验、Web typecheck、embedded release build 通过。

## companion_first_person_copy
- 用户要求更拟人化，placeholder 改为“聊聊你的想法，或交给我一件事”，七种语言同步改为伙伴第一人称邀请，不使用 it/它。仅改文案，沿用既有 locale 与连接行为。
- i18n 校验、多语言/controller/runtime 测试 11/11、嵌入 release build、diff check 通过；真实 Chrome textbox 名称确认新文案。

## embedded_project_selector
- 已隐藏内嵌新会话的整个项目/Host 工具栏，showExecutionControls 取代先前仅隐藏 Host 的 prop；未写入或改变默认工作目录。
- Web 类型检查、embedded presentation 测试、release embed build、diff check 通过；真实 Chrome 新会话 AX 确认项目/环境按钮均不存在，标题、输入框、语音、附件按钮保留。未发送消息、未发布。

## embedded_initial_frameless
- 初始页外框透明且无圆角；内嵌 header 不挂载，草稿页移除 frame 顶部分隔线、surface 阴影和标题占位。sessions 显式 isDraft 驱动宿主边框，不依赖会话数量推断。
- 真实 Chrome：新会话 outer rgba(0,0,0,0)、divider 0px、shadow none、headers 0；切入已有会话恢复 0.08 黑边框、21.6px 圆角、headers 1；返回新会话通过。无消息发送。
- frontend check（0 new diagnostics）、迁移组件 3 tests（含双向边框切换）、OpenCraft Web typecheck、presentation-root test、release embed build、documentation、staged impact、diff check 通过。当前 5174 预览可用，未提交或发布。

## preview_issue_diagnosis
- 本轮只读排查用户截图中的 Next 开发 Issue：真实 Chrome DevTools 展开原始 console.error 对象，确认 config/read 与 connectors/managed/list 均返回 Method not supported by Hermes bridge；protocol.ts default 返回 -32601，index.ts handle 将其记为 error。
- 同次初始化日志确认 backend-ready、websocket-open、connect:open、initialize:response 均成功，因此本次 badge 原因是未支持的初始化查询被作为错误上报，不能据此认定 Gateway 启动失败。未发送对话，未修改运行时代码、日志级别或开发提示开关。

## embedded_connection_recovery_in_progress
- 修复首次连接失败即 dispose/legacy fallback；保留同一 Host 的既有重连 owner，通过连接事件显示失败、30s 慢连接与手动重试。Profile transport 90s deadline，晚到 bootstrap fence，close 取消挂起连接。
- 已通过迁移组件 6 tests、恢复/退避/authority 9 tests、Web/Hermes types、boundaries、frontend check（0 new）、全部 7 语言翻译与生成闭包校验、embedded build。
- 浏览器发现 module load 与 Web Component 注册存在异步间隔，保留 whenDefined 等待并增加 30s 总 deadline，避免过早判失败。实际预览点击重新连接已恢复到正常新会话；继续 fresh-load 与隔离无实例故障验收。
- 调用命令的 cwd 出现路径前缀错误，失败命令未写文件，已按根工作目录重跑；不将失败命令算通过。无消息发送，无发布。

## embedded_connection_recovery_complete
- 最终新增：同一运行时跨首次失败继续等待；连接状态桥接与原位 retry；慢连接 30s 提示、资源加载 30s deadline、固定 Profile transport 90s deadline（晚到结果隔离与 close 取消）。沿用原有 Host 自动退避/Thread hydration，无第二个重连 owner、不重发消息、不自动降级旧 Chat。
- 本页断线保留已挂载 Composer/附件 owner；Bot/账号切换依然销毁旧身份。刷新/退出登录后的草稿持久化不在本次保证中。
- 验证：runtime/draft/Hermes/authority 122 tests 与迁移组件 6 tests 通过；frontend check 166 current /171 baseline /0 new；Web/Hermes types、boundaries、release embed build、7 语言校验、130-file sync/check、文档与 diff check 通过。检查日志 /tmp/cn-recovery-final-*。
- 真实 Chrome 国内 preview 首次进入正常，加载失败时点击重新连接恢复为新会话；隔离 synthetic API +真实构建 Web Component 连接失败原位显示重试且不挂载 legacy。未发送消息，未切断真实 Bot 服务；断线草稿/迟到回调由组件和运行时测试覆盖。5174 HTTP 200。未提交、推送或发布。

## multi_bot_isolation_recheck
- 用户要求再次确认多 Bot 会话隔离，本轮只读核查运行时代码；无业务代码修改、消息发送或发布。路由查询 frontend opencraft Hermes multi bot isolation reconnect 无 Pack 命中，随后在嵌入入口与 Hermes transport/bridge 范围精确检索，检查 frontend-runtime-openspec-i18n 邻接卡及组件测试。
- 确认实例与 Profile 配置进入独立 Host；列表、新建及历史窗口使用 Profile scope；队列缓存包含凭据域、实例及 Profile；切换销毁旧 Element 并屏蔽迟到结果，连接 generation 屏蔽退休尝试。
- 本轮命令证据：embedded Host/account/recovery 与 Hermes plugin 93 tests、frontend 迁移组件 6 tests 全通过，日志 /tmp/cn-bot-isolation-tests.log 和 /tmp/cn-bot-isolation-ui.log。范围为当前源码与模拟回归，未执行两个真实 Bot 的并发发消息验收，不将会话隔离等同于机器或文件权限隔离。

## conversation_frame_removal_complete
- 国内内嵌 Chat 从仅草稿无外框扩展为加载、新会话、已有会话全程无圆角外框，移除内嵌主内容阴影；保留标题、重命名及输入框。删除不再用于宿主外框的 draft 派生 state。
- 6 个迁移组件测试、frontend check（0 new diagnostics）、Web typecheck、嵌入 release build、documentation、staged impact 与 diff check 通过。日志 /tmp/cn-frame-*。
- Chrome 真实国内5174代理预览已有会话确认 border rgba(0,0,0,0)、radius 0px、main surface shadow none，标题与重命名及 Composer 正常。截图 /tmp/lightvela-chat-frameless.png。未发送消息、未提交或发布。

## right_panel_feasibility_readonly
- 用户询问右侧工作台能否加入 LightVela，本轮只读定位；未打开产品入口或修改运行时代码。路由 opencraft browser workspace right panel embedded LightVela 无 Pack 命中，限定 presentation-policy、嵌入 root、web application、browser panel 与 Hermes transport 检索。
- 当前 EMBEDDED_CORE_CHAT_PRESENTATION.rightPanel=false；完整工作台已有 RightPanel、浏览器标签与地址栏、terminal 插件、Host 文件系统和 loopback proxy。Web 使用 iframe，Electron 使用独立 surface adapter；不是 Hermes browser_exec 的远端画面共享。
- Chat Profile 隔离不等同于文件/PTY OS 隔离：Hermes 文件与 terminal port 面向实例，暴露给多 Bot 产品前需单独限定目录/资源归属；不可仅翻转 rightPanel 并宣称全部能力及隔离已验证。建议国内隐藏开关内先接可收起面板和受支持预览，远端浏览器及终端权限另验收。无真实站点面板实测、无发布。

## embedded_preview_panel_in_progress
- 已接右侧网页及会话文件只读预览，默认收起；browser metadata 使用每个 embedded Application 独立内存 storage，避免 Bot/账号生命周期之间恢复标签。工具栏仅网页入口，文件不露出目录搜索/监听/编辑。
- 真实国内预览已经成功打开 example.com iframe；继续检查会话切换与只读文件。未发送消息、未写云端文件。
- 首轮 Web types 和嵌入 build 通过；23 个面板/资源/拖拽测试通过。panel-conversation-ownership 直接运行受 scss loader 限制；临时 esbuild bundle 加载后 3/4 通过，终端相关用例失败待归因，不作为新增网页能力已通过的证据。新增语言提示后须重跑 types/build。

## embedded_preview_panel_complete
- 国内 show() 内嵌投影开启默认收起的右侧面板，工具栏仅网页标签；会话文件链接复用 resource renderer 的 previewOnly 模式，关闭目录树、fuzzy session、watch 与写入/编辑入口。新会话也保留面板开关，不恢复大外框。新增文案覆盖控制台七种语言。
- 每次 embedded Application 使用独立内存 browser metadata storage，标签属于会话 scope；Bot/账号切换由既有 Application dispose 回收。该保证不等同于实例文件系统、浏览器 Cookie 或 OS 级隔离；没有两台真实 Bot 并发验收。
- 真实 Chrome 国内代理预览：网页 example.com 成功加载；关闭/重开保留页；切其他会话为空，返回原会话恢复页；新会话入口可用；拖动将宽度从788调到530并重新对齐。修复 contain:layout 的宿主中 iframe 使用窗口坐标造成的偏移：physical surface 改为相对固定 presentation root 的 absolute 布局，commit 减去 root rect。截图 /tmp/lightvela-right-panel-preview.png。
- 实际 WorkspaceResourcePreviewPanel + Query/Blob service 的浏览器 fixture（只 mock Host API）确认文字、图片、目录提示；同一路径慢请求切 Bot 后只显示新 Bot 内容；目录读取/搜索/监听/写入调用均为0。未读写真实实例文件、未发送消息。
- 最终 Web typecheck、boundaries、i18n（153 IDs）、release embedded build 通过；面板/资源/i18n/Blob 38 tests、面板归属定向2 tests、新增嵌入坐标回归1 test通过。documentation、staged change-impact、diff check通过。相关日志 /tmp/cn-panel-*。
- 限制：原有终端 ownership 测试 mock 缺 session.subscribe，完整该文件3/4通过；本次不开放终端，不修改无关用例。仓库 context catalog 和 context tests 受已有 task pack 必填字段缺失/中文与预算规则失败影响（22/26通过）；context-audit tests 33/33通过，audit执行完成。不是全仓门禁全绿。
- 本地5174继续运行，未提交、推送或发布。下一步可由用户体验后决定是否提交。

## preview_panel_locale_followup
- 用户确认中文版右侧栏，本轮补齐遗漏的已打开标签列表、空列表、调整宽度无障碍标签与预览不可用提示；新增7条稳定ID，同时补齐其他控制台语言。网页自身内容仍由目标网站决定。
- 路由 opencraft right panel Chinese labels 无Pack命中，精确检索 right-panel 与 resize-handle，检查 frontend-runtime-openspec-i18n 邻接卡及 embedded-companion-locales 测试。
- i18n 校验、Web typecheck、boundaries、11个i18n/locale测试及嵌入release构建通过。仅更新5174本地预览，未提交或发布。

## mr_submission_2026_09_30
- 用户授权提交、推送并创建MR，不合并或发布；交付分支codex/cn-opencraft-chat。
- 提交前最新frontend check通过（166 current /171 baseline /0 new），前端45/45、runtime123/123、Bot管理32/32通过，130文件官方sync/check通过。
- fetch后的目标master为9cb7ff6a5；工蜂鉴权成功，当前源分支没有打开的MR，创建新MR。
- 排除context catalog校验生成的无关catalog.jsonl变化；保留5174预览。

## markdown_file_preview_complete
- 右侧文件面板对 .md/.markdown 默认复用 WebChatDocument 排版，提供预览/源码切换；控制台七语言覆盖切换标签。文件目录用于相对资源解析，Host Blob读取与只读限制保持原有所有权。
- Web typecheck、162条i18n校验、boundaries、嵌入release构建通过；文件模型/Markdown/compiler/locale聚焦24/24通过。初次类型命令在repo根执行无workspace失败，已在opencraft目录成功重跑。
- 真实Chrome运行实际文件面板、Query/Blob、Markdown组件与embedded构建样式，仅Host文件API为替身：标题/列表/表格/代码块排版、源码切换、普通txt、相对md链接正确，HTML显示文本，目录/搜索/监听/写入调用0。截图/tmp/lightvela-markdown-preview.png；无真实云文件或推理调用。
- 本地5174 HTTP200，嵌入产物已更新；这轮新增源码未提交、未推送或发布，MR !4851尚不包含本轮Markdown补充。

## markdown_mr_delivery
- 用户随后明确授权提交，本轮补充提交并推送到已有 MR !4851；复用上述同代码的24项测试、Web类型、i18n、边界、构建及浏览器证据。不合并或发布；目标分支冲突单独处理。

## ci_isolated_frontend_test_fix
- c96a61d5f 的 CI 失败原因是前端测试跨目录导入 OpenCraft；已迁移真实 Shadow DOM/IME 回归到 opencraft/tests，加入自身 jsdom devDependency 和 test:workbench:unit。无生产行为改变。
- 隔离 frontend guard 的 frozen install、pnpm check（166 current /171 baseline /0 new）与 i18n 通过；后续 Vitest 因本机 ENOTFOUND localhost 中止，因此未到 CN/global build。显式 --api.host 127.0.0.1 在原工作区重跑同七文件，130/130通过；不宣称完整隔离 guard 通过。
- 迁移后3/3 tests、Web typecheck、平台边界通过。既有构建与UI验证沿用前轮，无新生产代码；生成闭包检查另发现 sourceRevision 落后，需先提交前端测试迁移，再官方 sync 并独立提交。
- context_receipt 补充 docs/engineering/domains/agent-gateway-runtime.md 验证边界。用户“继续吧”后继续修复和原MR提交；不处理原有master冲突，不合并或发布。
- 源码迁移提交20dbd5595后，官方sync仅更新UPSTREAM.json的sourceRevision；130文件闭包检查通过，documentation和staged change-impact通过。生成清单独立后续提交，排除无关catalog.jsonl。

## embedded_composer_height_followup
- 编辑区域最小高度50→74px；Web typecheck、embedded release build、documentation、diff check通过。真实Chrome现有国内域名映射预览刷新后，DOM测量height/minHeight均为74px（修改前50px）；截图/tmp/lightvela-composer-height.png。未发消息。
- 5174预览已恢复HTTP200，实际cwd为cn-opencraft-chat工作树，国内API api.lightvela.com。首次探测遗漏既有监听，启动脚本清理构建后端口冲突；已核对原Next进程所属本工作树，定向重启恢复。使用lightvela-local-preview Skill，未修改代理。
- 本轮变更未提交/推送/发布；无关catalog.jsonl保持原状。

## companion_followup_placeholder
- 国内内嵌已有会话复用chat.companionPlaceholder，统一为“聊聊你的想法，或交给我一件事”；七语言复用同一catalog，独立版默认不变。
- Web类型、i18n、embedded-companion-locales测试、嵌入构建通过；Chrome国内映射预览打开已有“友好打个招呼”会话，textbox名称确认新文案。未发送消息，未提交或发布。

- 后续用户要求差异化：已有会话改为“继续聊聊，或告诉我接下来想做什么”，独立消息ID覆盖全部七语言。Web类型、163条i18n校验、嵌入构建和文档检查通过；Chrome已有会话textbox名称验证新文案，截图/tmp/lightvela-followup-copy.png。初始提示保持原文；本地预览已更新，未提交/发布。

- 用户再精简后，已有会话最终文案为“告诉我接下来想做什么”，六套翻译和英文default同步；i18n、嵌入构建与diff检查通过，5174产物已更新。未提交或发布。

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
- 隔离工作树 `/data/mono2-mr4851-cr` 从 MR tip `7813b44e2` 创建，原 `/data/mono2` 的大量未提交改动保持原样。`origin/master` 合并复现 9 个冲突；源码、文档、测试与 package 两侧内容已逐处合并，生成清单由官方同步重建。
- 保存入口已绑定目标 Host/path/text 并先检查只读；新增测试证明 previewOnly 抛错且 Host 写入/Blob 失效均未调用。生命周期补充迟到 prepare/show 与空 Profile 用例；前端测试固定国内 region。OpenCraft guard 新增本 MR 12 文件测试套件。
- 本地证据：OpenCraft 142/142、frontend 8/8、Web typecheck、i18n、嵌入 release build、frontend check 0 new、CI guard 单测 7/7、documentation 与 docs-impact 通过。合并提交 `2a65b0388` 后官方重建 `UPSTREAM.json`，`sourceRevision` 与最后一个 frontend 源码提交一致，130 文件闭包通过。
- 真实 guard 冷安装第一次并发运行 141/142，随后同代码单独运行及 5 次复跑均 142/142；将 `test:embedded-ci` 改为串行后，完整 guard 冷安装 142/142 且 `all checks passed`。未从第一次截断日志定位具体失败用例，因此不把并发失败归因于某个源码缺陷。远端 CI 尚待观察；未合并或发布。

- 推送时远端出现并发 CR 修复 6d60a595c，普通 push 拒绝后合入该提交。保留远端 CI 冷安装与串行 embedded suite、writeWorkspaceResource 边界与测试，同时保留本轮真实面板 mutation 回归、候选实例生命周期闸门、七语言 followup 和 74px 高度。

- 并发提交合入后，frontend CN/global 各12/12、frontend check 0 new、embedded-ci 143/143、Web types和embedded build通过；保留两侧验证记录。

## markdown_preview_entry_investigation_2026_09_30
- 用户反馈点击 .md 后右栏不打开；继续只读排查，尚未复现该具体链接，已请求消息截图或链接地址。
- 当前 Chrome 国内映射预览显示 Hermes 连接失败，点击重新连接未恢复，无法验证真实远端文件读取。
- 当前源码链路：chat resource-link → app.openChatResource → panels.open(resource) → open-tab 展开 right region；内嵌选择 WorkspaceResourcePreviewPanel。普通文件链接入口存在，尚无证据证明本次失效来自该路径。
- 当前源码隔离浏览器验证真实 WorkspaceResourcePreviewPanel（仅 Host API 为模拟）：Markdown 标题、列表、表格、代码正常渲染；6/6 workspace-resource 与 readonly 聚焦回归通过。模拟组件验证不替代真实 Hermes 点击链路。
- Context router query `opencraft markdown 文件预览 LightVela 嵌入聊天资源链接` 无匹配；有界搜索定位上述组件。读取 opencraft/AGENTS.md、opencraft-maintenance skill、frontend-runtime-openspec-i18n 邻接卡，并检查 frontend 的 embedded CN 回归及 OpenCraft workspace-resource 测试邻居。
- 未修改产品源码、未提交、未推送；catalog.jsonl 保持原有变更。

- 用户截图定位到 inline-code 文件路径无点击事件；新增明确 Markdown 路径 renderer，复用资源策略，避免命令/URL误识别及显式链接内嵌套。真实 renderer + Panel service 交互回归与只读/资源回归共7/7通过；renderer/Web typecheck、embedded release build通过。
- 2026-09-30 本地预览重新启动：5174 国内站，API api.lightvela.com；页面与嵌入 bundle HTTP200，IAB 已打开但为未登录状态，因此未核验真实 Hermes 文件读取。源码/构建已更新，尚未 commit/push。

## compact_right_panel_2026_09_30
- 国内嵌入聊天通过 presentation policy 使用 compact 默认右栏宽度（原算法结果的 2/3），保留最小宽度、主内容保留空间与原拖拽 owner；独立工作台保持 standard。
- Web 类型检查、嵌入 release 构建、面板与嵌入 presentation 聚焦测试17/17通过，diff检查通过。
- 5174本地构建已更新；Chrome国内映射页刷新后聊天加载正常，点击预览开关实测 splitter宽577px，聊天区域扩大。截图 /tmp/lightvela-compact-right-panel.png。未提交/推送/发布。

## continuous_dividers_2026_09_30
- 国内桌面 embedded 宿主填满左栏右侧区域，移除外围 top/gutter/max-width；toolbar 通过宿主变量与左栏表头对齐68px。取消透明1px外边框占位，内部正文间距保持。
- DOM实测：内容左边264px等于侧栏右边、top0；左右表头均68px。点击真实聊天Markdown路径已展开并渲染文件预览；截图 /tmp/lightvela-continuous-dividers.png。390px视口 documentWidth390、toolbar46px；恢复桌面。
- frontend check 0 new TS，16/16聚焦测试通过；更新原有透明边框断言以匹配无边框。OpenCraft Web types、presentation测试和嵌入release构建通过；官方同步检查、文档及impact/diff检查通过。国内完整构建通过（pnpm build:cn，105页生成及静态SEO检查完成）。
- 排障发现第三方重复gap-6规则覆盖gap-x-0，最终在宿主class选择中只给嵌入聊天gap-y-6，避免互相覆盖。源码未提交/推送，既有catalog变更保留。

## markdown_source_switch_2026_09_30
- 用户截图显示切换源码导致嵌入聊天根错误页；本轮新开独立浏览器页未复现原异常，原始异常堆栈不可恢复，不将资源缓存或编辑器故障认定为已证实根因。
- 只读 Markdown Source 改为转义原文 pre/code，移除该分支对 lazy 编辑器的依赖；可编辑工作台与其他格式不变。复用既有源码多语言标签。
- 真实组件回归2/2通过，包括编辑器抛错时仍能来回切换；Web类型检查、嵌入release构建、文档/impact及diff检查通过。
- Chrome独立验证页使用5174映射的新本地构建，真实远端国庆抒怀.md经过预览→源码→预览→源码均正常，聊天输入框与消息保留。截图 /tmp/lightvela-markdown-source-fixed.png。
- 本轮未提交、推送或发布；保留既有未提交工作。

## chrome_stale_source_chunk_2026_09_30
- 用户反馈同一Chrome标签页仍报错，本轮直接读取原标签页1353670490日志，捕获 TypeError: Failed to fetch dynamically imported module，路径为 /__opencraft/assets/a-DCf_TcJE.js；本地5174该路径实测404。
- 前次新标签页验证没有更新用户原标签页；原标签页仍引用已被重新构建移除的旧hash资源。本轮不新增产品代码，刷新原报错标签页后打开同一国庆抒怀.md并点击源码，显示新只读原文，聊天与输入框保留。截图 /tmp/lightvela-chrome-source-recovered.png。
- 修正前次根因未确认记录：本次已有具体旧动态模块加载失败证据。未提交/推送/发布。

## mr_update_2026_09_30
- 用户明确授权提交MR；复用现有 !4868 / codex/cn-opencraft-chat → master。已通过提交前 embedded-ci 145/145、平台边界、staged change-impact 与diff检查，复用此前类型/构建/浏览器证据。
- fetch后发现现有主干冲突仅UPSTREAM.json的sourceRevision；本轮先交付已完成变更，未进行目标分支合并或生产操作。既有catalog.jsonl不纳入。

## mr4868_conflict_repair_2026_09_30
- 用户报告MR合并冲突，当前source 892919a99，target da1f500cb；有界merge-tree与实际合并均确认仅UPSTREAM.json sourceRevision冲突。
- context_receipt: docs/context/project/upstream-subtrees.md、opencraft/AGENTS.md、frontend/AGENTS.md、opencraft/MONO2_MIGRATION.md、docs/context/project/adjacency/frontend-runtime-openspec-i18n.md；检查同步脚本和opencraft_guard生成物邻居。
- 将最新master合入功能分支，以target清单作临时基线，官方sync/check重新生成并校验；保留双方源码，既有catalog改动独立暂存保护。MR本身不合入、不发布。
- 合入后Web typecheck、embedded-ci 145/145、平台边界、文档与staged impact检查通过。保留master同步脚本仅追踪实际复制sourcePaths的新规则；合并提交后再次sync/check清单。
