# Agent、网关与运行时领域

## 渠道聊天记录只读接口（待启用）

CTL 的 `/v1/instances/{id}/bots/{bot_id}/channel-sessions` 与消息子资源按登录账号限定实例。每次请求在一条地域 TAT 命令中读取 Hermes Profile 列表、确认 Bot 仍存在，再只读打开对应 Profile 的 `state.db`；不缓存 Bot/Profile 映射。数据库文件路径隔离 Bot；当前非 multiplex 部署下每个 Profile 的渠道会话键都使用 `agent:main:` 命名空间，缺少这一渠道会话键的记录不返回。列表和消息均分页，消息投影只包含用户与助手文本，排除工具调用和原始推理。

`CHANNEL_HISTORY_ENABLED` 默认关闭。目标 Hermes 镜像的 schema、渠道覆盖及群聊参与者可见范围须在启用前核验；接口不得退化为浏览器直接执行命令或访问数据库。公共入口还需网关单独放行两条只读路径，CTL 源码上线本身不代表记录已可访问。

国际站界面语言由站点宿主传入内嵌 OpenCraft 工作台的 `ideLocale`，
WorkbenchLocaleController 装载对应目录并随宿主语言更新。马来语 `ms-MY`
目录覆盖工作台应用自有消息，保留 ICU 参数；界面译文不改写用户会话标题或消息。
没有生产调用方的兼容 AgentChat SDK 入口不注册马来语运行时；国际站产品语言由上述内嵌工作台消费。

内嵌 OpenCraft 语音输入使用独立的应用级转写 transport，不经过 Hermes/DSH 的聊天模型配置。
浏览器登录态经 Service Gateway 转为用户 default-purpose VelaGW Key；录音与标准 multipart
均不落盘，混元转换仍由 NewAPI 拥有。通用语音插件复用录音、取消和 final-only 草稿写入，
产品适配器持有账号/区域代次，取消或换账号后的迟到结果不能写入新草稿。
此入口不回落到本地预览服务或浏览器系统识别，不影响独立工作台原有语音配置。
详见 [Service Gateway 语音输入](../../../service-gateway/docs/README.md#内嵌-opencraft-语音输入)。

OpenCraft 的聊天跟进偏好由客户端 `UiPreferencesRuntime` 持有：运行中的
独立工作台普通会话默认立即跟进，设置中可改为下一轮排队；主站嵌入式 Chat 在运行中默认排队，空闲发送不受影响。
该偏好不改变 Server 能力或投递确认；临时侧聊仍受其无持久队列的能力边界约束。

OpenCraft Web 的未发送输入与执行投递分开持有：任务 View 保留原有账号隔离的
ConversationDraftContinuity；Bot Room 通过共享 Composer 的客户端存储 port
保存结构化正文、上下文及附件描述，不同步到 Server/其他设备，也不恢复提交锁
或自动重发请求。Bot 存储只由实际内容编辑更新，旧 View 的状态变更/销毁不能
覆写它；账号作用域变化撤销并清除旧适配器，新应用实例绑定新账号。原始浏览器
File 字节及临时 Side Chat 尚不承诺跨刷新恢复，失效附件不能假装可发送。详见
[Chat UI 草稿边界](../../../opencraft/docs/chat-ui-architecture.md#browser-local-input-drafts)。

本领域覆盖 Agent 请求进入、实例/渠道编排、Sandbox 分配、CloudAgent 执行、模型网关/provider 路由、流式响应和后台 workflow。

LightVela 的隐藏协作实验室位于 `/agents/labs/collaboration`，仅在当前账户 API 为北京测试环境时可由
`show()` 显式开启。入口、路由和请求适配器都保持此环境约束；上海和国际站不接入。
客户端复用 `shared/vela-collaboration-web` 的 Human 协作状态与腾讯 IM adapter，由既有登录账户借出请求端口，
不持久化第二份 token，不依赖 Bot 或付费 Agent 权益。关闭入口、退出或切换账户时注销原 IM scope，
新 scope 等待旧连接销毁后再登录。该入口的可见性不是后端鉴权或发布完成的证据。

LightVela `/agents` 多 Bot 桌面页由 OpenCraft 内嵌工作台独立呈现已有会话标题、重命名及预览面板开关；
站点宿主不再向会话顶栏插入 Bot 名称。Bot 管理菜单由宿主在工作台 Shadow DOM 外、最左 Bot 竖栏底部渲染，
避免弹层事件跨边界后立即关闭。账户入口保留在左下角。内嵌工作台仅在已有会话显示右侧预览开关，
新建会话页不呈现标题、该开关或右侧预览面板。这一呈现调整不改变会话身份、运行时操作或独立
OpenCraft 工作台的标题所有权。

`/agents` 入口只有在选出可用 Bot 后才替换到该 Bot 的新建会话；无 Bot 的过期历史用户留在入口，
与权益门禁的允许落点一致。桌面多 Bot 模式隐藏旧资料卡时，临期续费提示由账户入口承接，
原续费资格、实名检查与弹窗流程不变；当前 Bot 重启失败由竖栏管理入口标记并在菜单内展示错误。

OpenCraft 的活动分段结束原因与折叠资格分别建模。插话/异步问题等只关闭
连续时序段，不隐藏先前文字；普通任务过程必须到达自身有效非异步最终回答
才获得折叠资格，不能继承旧响应的 final phase 或以 Turn 完成冒充回答。
共享 chat-core 唯一计算资格/默认显隐，View 只写显式展开选择；临时展开及
无折叠按钮时完整保留正文，不反写选择。执行、稳定消息身份和滚动 owner
不变；独立 Bot 聊天不强行复用任务折叠。详见
[Activity disclosure authority](../../../opencraft/docs/chat-ui-architecture.md#activity-closure-and-disclosure-authority)。

OpenCraft 对 Codex、Hermes 与 DSH 实际返回的思考摘要/文本统一提供独立、
默认折叠的呈现；不是工具记录组的正文，也不还原未返回或不透明的内部内容。
共享模型选择非空内容、稳定 Item 身份与唯一实时 Thinking owner，View 只记录
显式展开选择，流式及完成不反写该选择。空或不透明的思考记录仅是工作观察，
不切开界面工作区；有正文的思考可以按原序独立展示，但同一响应只由最近有实际
内容的工作段领取最终回答的外层折叠资格，不能逐段制造历史消息标题。唯一 Turn
用时优先附着同一响应的实际工作，不越过插话/回答边界回派到旧工作。详见
[Returned thinking content](../../../opencraft/docs/chat-ui-architecture.md#returned-thinking-content)。

摘要请求与折叠呈现是不同责任：OpenCraft 的 Codex Host 在唯一原生请求边界，
仅对未指定摘要字段的 `turn/start` 补入自动摘要请求，覆盖普通发送、继续与后台
排队起轮；显式模式及 `null` 的原生继承语义保留，Steer 和其他引擎不注入该字段。
模型支持和实际返回仍归引擎/provider，不能把已接展示当作已启用请求。
Hermes 默认接收真实思考事件及历史字段；其供应方和会话配置仍可能不返回文字。
以上不改已有轮次或历史记录，也不自动替换正在运行的预览。

OpenCraft 的轮次文件变更汇总由 Turn 的 diff 字段持有，属于附属资源，不是
消息顺序中的 Item。共享 chat-core 在 transcript 分段之外派生 changeSummary，
Web 与 Native 消费同一呈现计划；运行中 diff 更新不得关闭活动段、清空工作时钟
或取得最终回答/Thinking 所有权。旧 turnDiff Item 只在共享入口降为资源，显式
空值清除优先于旧记录。Review 沿同一轮次资源读取流式更新，完成卡仍按执行状态
展示。详见 [Chat UI Changed-file review](../../../opencraft/docs/chat-ui-architecture.md#changed-file-review)；
源码验证不等于当前预览已经替换。

## 服务与责任

OpenCraft 会话置顶属于原生 Server 的目录元数据，不属于执行轮次或客户端偏好。
Codex adapter 使用原生置顶 section；Hermes adapter 复用既有 TAT HTTP 通道和
会话凭据调用 Dashboard 的 Profile-scoped metadata API，不修改 Hermes。
协议扩展可发现不等于原生能力已支持：当前连接读取成功后才提供置顶操作，
DSH 或旧 Server 不伪造支持。桥接器和浏览器均不另存置顶集合；刷新从原生数据
回补近期窗口以外的置顶摘要，跨页按会话身份去重。写入按会话串行，迟到读取
与断线代次隔离，未知结果刷新核对而非盲重放，不触发 resume 或执行。
详见 [Thread lifecycle ownership](../../../opencraft/docs/platform-architecture.md#thread-lifecycle-ownership)。

LightVela 站点的 Agent 会话侧栏由 `frontend` 持有，不使用 OpenCraft 完整工作台的
Sidebar。嵌入式 Workbench 仅投影会话的置顶状态、当前 Host 的置顶能力与置顶动作；
站点按该能力显示菜单，置顶会话独立于近期分页配额展示。侧栏的会话缓存不作为
置顶写入权威，操作后由原生目录刷新确认。
内嵌 Workbench 的首次会话目录查询在 Host 尚未就绪时属于待加载状态，不能把
尚未发起查询的空数组投影为已确认的空列表；Host 进入错误态后停止报告加载，由聊天主区呈现失败和重试。切换 Bot 后，站点侧栏保留既有栏位，
等待目标 Bot 的目录结果；只有首次读取结束且仍为空时才显示默认会话入口。

OpenCraft 的可选 `tencentoa.identity` 插件按每个 HTTP 请求核验太湖签名、
解密 TOF 员工身份并检查有效期。安装级私有密钥仅属于后端，员工身份仅投影到
当前客户端的独立 Authentication provider，不取代 LightVela 账户，不写入全局
“当前员工”缓存，也不自动授权共享 SSH、桌面或会话。未配置时不贡献界面入口。
详见 [Tencent OA 身份边界](../../../opencraft/docs/tencentoa-authentication.md)。

OpenCraft Headless 的云听写复用安装级模型配置与凭据仓库，Model Services 管连接/密钥，语音设置只选择独立转写模型。转写模型及其密钥不进入聊天目录或 DSH 执行投影，也不跟随当前 SSH/Thread/Bot。录音开始固定配置票据，停止和重试保持同一绑定，配置变化在计费前拒绝旧录音。旧语音环境配置仅显式导入，不作为运行时第二真源；源码实现、实际迁移和预览替换分别验证。详见 [模型所有权](../../../opencraft/design/model-configuration.md#语音模型与应用服务)。

听写启动阶段包含麦克风获取与平台就绪，不等于正在弹出系统授权。
Composer 在原 Footer 槽位使用共享进度图标和中性读屏提示，只有平台确认录音
就绪后才显示波形并计时；启动中取消仍使迟到结果失效。该反馈不增加等待时间，
不预热或常驻麦克风。详见 [Client voice input ownership](../../../opencraft/docs/platform-architecture.md#client-voice-input-ownership)。

OpenCraft 本机只读桌面由部署入口显式选择信任边界：默认 `--local-desktop`
仍仅回环可用；`--trusted-internal-desktop` 只适用于网络准入已可信的安装，
信任所有能访问该页面的用户查看同一台机器。Host 声明不同传输范围，Web 只消费
真实能力；HTTP(S) 同源观看可经过保留外部 Host 的 TLS 代理，不能信任任意转发头。
原生观察服务仍回环且不可输入，native Thread / logical Client 绑定、一次性短票据
和观看回收保持不变；关闭面板不停止桌面或 Agent。不接 TAT，也不冒充 Vela
多租户认证。详见 [桌面授权边界](../../../opencraft/docs/cloud-desktop-plugin.md#local-execution-server-authority)。

本机输入单独以 `--desktop-control` 接入：Host 校验已安装的 root 私有 Unix
执行器与观察器属于同一物理代次，控制意图在异步准备前独占，Thread/Client 复核后
才确认。原生执行器拥有跨 Host 的物理独占、三秒续租、断线松键和崩溃恢复日志；
RFB 分片保留起始字节时的授权，不把旧缓存晋升为新输入。观看恢复不自动接管，
本机剪贴板未接通，不显示可用粘贴动作。详见
[原生输入所有权](../../../opencraft/docs/cloud-desktop-plugin.md#local-native-control-authority)。

桌面加载动效与控制授权分离：纯 Design System 持有矢量数据，Web adapter
投影 SVG、同相旋转和减少动态效果时的动画回收；紧凑按钮即时消费主题状态。
动画不确认控制权、不延迟停止，也不重建媒体或 Host。参考来源与真实组件验收范围见
[桌面面板呈现](../../../opencraft/docs/cloud-desktop-plugin.md#panel-presentation)。

本机观看的五分钟期限由后端重新核验后续接，而非删除超时：discovery 与
独立观看 socket 都声明能力后，才可申请续期；Host 前后复核 native Thread、
逻辑 Client 和物理代次，匹配确认才更新两端期限。它不创建桌面、不重开媒体、
不获取输入权限；旧端保持原协议，Vela/TAT 不被隐式接入。
桌面 renderer 单独声明标签存续期间保留观看：隐藏或切换工具立即撤销输入，
重新打开保留画面但不接管，关闭标签/更换 owner 才回收观看。
按钮立即投影“停止控制”的意图，确认授权前仍禁止输入。详见
[观看续期](../../../opencraft/docs/cloud-desktop-plugin.md#confirmed-viewing-renewal)。

桌面手势和坐标归通用Web适配层：观察时捏合/平移只改变观看，确认控制后单指
操作与双指滚动才发送远端输入，滚轮消费同一有界规则。原decoder指针写入者
显式关闭，不与插件重复发送。手机文字入口拥有一次授权下的独立DOM，候选词
不发送，停止后销毁，不把迟到输入带入后继授权。浏览器验证与手机系统键盘
验收分开，详见[输入策略](../../../opencraft/docs/cloud-desktop-plugin.md#pointer-viewing-gestures-and-mobile-text-input)。
接管激活时同步取得Panel内焦点，确认授权不再抢焦点；平台焦点/页面可见性
不是后端授权。文字事务短于控制授权，远端点击/拖动/粘贴前先结束原组词，
同步确认发到原目标，迟到候选随原事务退休，不进入同授权下的后继输入。
桌面DOM交互范围独立于后端授权：内部媒体/工具栏/软键盘交接及未知焦点去向
不单独撤销既有控制；明确外部点击或焦点、页面隐藏、窗口失焦仍立即撤销。
物理手势独立于控制授权：视口/画面几何变化取消旧手势与待发送样本，不把旧
起点映射到新画面；旧触点抬起后才接受新手势，不因此重新申请或恢复控制。
桌面控制底座的几何与遮罩仍归设计系统：圆弧只延伸内侧覆盖，不移动外轮廓。
像素回归分别检查普通渲染与独立遮罩边缘裁切容错，不以模拟裁切替代手机Safari验收。

OpenCraft 后端 SSH Codex 接入复用既有 logical Client 路由、Thread 读者与交互
owner，物理通道由 AppHost 持有；普通 Linux 与 HyperNode 共用 SSH exec 内的
WebSocket 契约。远端模式不构造本机账号池、附件或队列，不自动安装/杀远端服务，
断线不重放执行。配置和凭据只在后端，匿名公开监听禁止启用 SSH 绑定；首版仅
私有本机监听入口，尚不提供多租户 ACL 或远端附件/PTY/Goal 编排。
详见 [SSH Codex Servers](../../../opencraft/docs/ssh-codex-servers.md)。

| 服务 | 责任 |
|---|---|
| `service-gateway` | 公共入口与后端代理 |
| `ctl` | 实例、渠道和运行时任务编排 |
| `sandbox` | 运行机器池与状态机 |
| `cloudagent` | Agent gateway、渠道与 Wisp runtime |
| `ai-gateway` / `velagw` / `new-api` | 模型路由、provider 与控制面 |
| `workers` | Temporal workflow、运行时救援导出与恢复作业 |
| `velalink` | 桌面/Chat UI、daemon 与本地观测 |
| `opencraft` | Codex-faithful Chat Runtime、多端 Workbench、AppServer/Hermes 转译与扩展运行时 |
| `collaboration` | Server、Member、Channel、Task、Reminder 与腾讯 IM 资源映射控制面 |
| `vela-computer` | 托管 Computer 内的 Agent Chat Client、IM 入站恢复与受控回复能力 |

CTL 为国内站存量免费 Pass 创建计费迁移单前，可仅将已过期但仍为 `active` 的 Pass 到期时间延至下一天；这不触发 Sandbox/CVM 开机或实例状态迁移。曾在隔离中关机的实例保持关机，直到用户续费链路明确恢复。

OpenCraft 独立 Web 入口在创建应用级 `LightVelaAccountService` 前解析显式的
`VITE_LIGHTVELA_API_BASE_URL` 与 `VITE_LIGHTVELA_REGION`，并将结果传入应用启动边界。
Collaboration 与 Hermes 复用该账户 authority；北京本地预览的 Collaboration 请求因此走配置的
北京 Gateway，而非国内 Auth 默认域名。未提供覆盖值时沿用既有区域默认值；OAuth 回调仍由
同一账户服务接收，不建立第二份登录状态。国内 Auth 域名对协作路径返回的 404 不能替代
北京 Gateway 的路由验收。
独立 Web 即使显式设置 Region，也不能因此把账户资料刷新变成应用启动门禁；
该同步预检只属于绑定了配置式 Host 的嵌入式 Chat。登录态过期时，独立 Web
仍应启动并由账户入口和 Collaboration View 给出可恢复的登录提示。

Collaboration 在同一次扩展 activation 内按共享账户的 `authGeneration` 持有独立
service scope。身份变化立即废弃旧聊天/目录并将 View 回到协作首页；旧 IM owner
注销完成后才允许新用户登录，旧 Server/邀请/私聊请求迟到不能导航或覆盖新 scope。
该消费侧只解除账户订阅，不销毁或退出应用级账户。正在发送的消息按 conversation
持有锁，导航离开再返回不能释放该锁并产生第二次提交。

OpenCraft Web 输入框在当前 Host 的 provider 为 `lightvela.hermes` 时展示 Hermes 指令库；选择指令只写入可编辑草稿。用户发送时，普通指令沿既有 Composer → AppServer → Hermes `prompt.submit` 链路处理。单独发送 `/stop` 走 Hermes Host 的 `hermes/stop` 请求：已有运行中 Turn 先经 `session.interrupt` 中断，再调用 `process.stop` 清理后台进程；空闲或新会话直接调用 `process.stop`。输入框停止按钮仍只走 `turn/interrupt`，其他 Host 不展示 Hermes 指令库。

国际站面向用户的 Chat 新建入口、列表操作、删除确认及 Hermes `/new` 命令说明统一使用 “chat”（如 “New chat”）；协议、登录与运行时对象仍使用各自的 session 语义。这是界面文案约定，不改变会话操作的执行归属。

国内站嵌入式 Chat 的手机输入区由 OpenCraft Shadow DOM 内的 Composer 样式负责：窄屏下编辑区最小高度为 48px，宽屏保持 74px，底部操作按钮尺寸不随之缩小。宿主页面负责根据 iOS 可视视口底部和自身相对视口的实际位置调整聊天容器高度；输入法聚焦导致整页滚动时，输入区仍需贴近键盘上沿。

国内站嵌入式聊天删除执行中的 Hermes 会话时，先请求 `session.interrupt`，再通过 `session.activate` 确认会话已停止，然后才执行 `session.close` 与 `session.delete`；停止失败或未获确认时保留会话。此删除流程只停止目标会话，不调用全局 `process.stop`。

OpenCraft 的 Codex Host 持有排队 steer 的持久投递权，同一 Thread 的物理准入串行化。匹配目标 Turn 的 `turn/steer` 获确认后先持久化为 `steering`，后续消息即可继续准入；历史物化和 client-message ID 对账在后台完成。只有正在投递或结果未知的前序投递阻止后续准入，未知结果不得自动重发或交给普通 Resume 猜测恢复。具体状态与回归边界见 [OpenCraft ChatUI 架构](../../../opencraft/docs/chat-ui-architecture.md)。

OpenCraft Composer 的排队消息预览保留正文提示；其排序、插入、编辑、取消编辑和删除按钮的悬浮提示由各自操作定义，不继承消息正文。无确认投递的丢弃入口单独显示其操作提示。
确定被拒绝的排队跟进仅属于客户端 Conversation Runtime，尚无 Server 队列 ID；其删除操作只移除本地失败记录，不请求 Host 删除。超时或断线导致投递结果未知时，Host 可能已经入队：客户端保留未确认记录，禁止本地删除与再次提交，直到同一 client message ID 出现在 Host 队列或权威历史中。已确认入队的消息仍按 Server 队列 ID 删除，提交中的消息不得提前删除。

OpenCraft Web 文件更改入口消费同一 Turn-owned changeSummary：实际 Composer 唯一呈现 active Turn 的运行中入口（含浮动位置），主/mini transcript 按该 Turn 身份抑制重复，完成后恢复为消息区资源卡。卡片对齐 Codex 26.930 原始 Renderer 的图标、主题几何、正负计数、前三文件和查看交互；悬浮状态与展开状态只属于 View，不能改变执行、排序、折叠或资源身份。点击悬浮子项先关闭列表，再交给已有 Review；没有真实回退能力不显示撤销。见 [Changed-file review](../../../opencraft/docs/chat-ui-architecture.md#changed-file-review)。

OpenCraft 右侧预览面板的图标按钮（包括关闭标签、浮动输入框切换及浏览器视口调整）使用操作名称作悬浮提示；文件列表保留路径提示，便于查看被截断的路径。

OpenCraft Composer 的语音输入按钮在平台不支持或 Composer 禁用时保持不可操作：可用性提示与禁用态一致，指针按下和点击都不得启动听写，禁用态不显示可操作的 hover 高亮。

OpenCraft 的弱网恢复分开拥有共享 AppHost 连接、各 Host 的协议就绪、Thread/资源恢复和查询缓存重新验证。页面重新可见或网络恢复时的主动探测只验证通路，不激活或重启执行引擎；Host 的 lease 与 initialize 就绪后，其它慢资源不应阻塞会话。旧连接的迟到响应不得覆盖新连接结果，已接纳的 Turn 仍由服务端持有，不因浏览器重连重新投递。详见 [OpenCraft 平台架构](../../../opencraft/docs/platform-architecture.md)。

OpenCraft Hermes Host 的 `initialize` 同时读取 CTL Bot 绑定、Hermes Profile 和群聊能力，待各自完成后才发布该连接的能力声明；其中任一读取失败仍按原有可用性/错误语义处理。首屏会话列表继续在 Host 就绪后新鲜读取 `session.list`，不跨越初始化缓存旧列表。桥接器分别记录连接、初始化与 `thread/list` 的无内容耗时，用于区分云端隧道和会话目录延迟。

国内站嵌入式 Chat 的会话启动记忆按当前物理实例和原生 Profile 组成的 Host ID 隔离；若当前 Host 没有记录过会话，从新草稿开始，不使用旧版全局 Thread ID。独立 Workbench 保留旧版全局 ID 的兼容回退；显式选择的会话仍按当前 Host 执行恢复。

OpenCraft 的 Expo Android 内测 APK 只交付 React Native/Metro Client，不包含本机 Agent Host 或 DSH。Hermes Bot 连接与原生登录仍依赖远端服务；APK 打包、签名校验和服务端链路验收必须分别记录。内测目标使用开发签名，不代表商店或生产发布。构建产物与边界见 [OpenCraft 构建矩阵](../../../opencraft/docs/build-matrix.md)。

OpenCraft iOS 套壳在 Expo Go 和独立安装版中使用同一原生登录与网站流程，把所选站点会话交给同源 WebView；两者均只承担 Client 呈现，不创建 Agent Host。站点 Service Worker 仅缓存版本化静态资源，不缓存聊天或鉴权 API，也不改变 Hermes 运行时所有权。详见 [OpenCraft 平台架构](../../../opencraft/docs/platform-architecture.md)。

主站嵌入 OpenCraft 的资源准备与 Bot 发现并行，但确认实例/Profile 后才创建单一 Application。
聊天就绪不等待可选 Host Proxy；远端回环预览由自己的窄作用域 Service Worker 注册激活决定就绪，
而非主站页面 controller/ready。停止、关闭、切地址或销毁会拒绝迟到导航，失败不回退到客户端 localhost。
Pages 制品对嵌入内容哈希资源声明 immutable，稳定 loader/version/SW 仍重验证；具体边界见上述平台架构。

嵌入聊天的语音、协作、Bot Chat/管理呈现与 Terminal 面板模块由同一 Application 在首个可用可见帧后按依赖顺序启动，不再阻塞 Host/Thread 就绪。账户身份、实例/Profile 校验与协议声明所需服务仍为必需依赖。未完成模块加载在超时或销毁时撤销工厂 scope；已开始的扩展激活排空后才销毁借用的 registry/Host。Full Workbench 默认保持原 eager 策略；这不等于 Host 启动超时已修复。详见 [Embedded Shell](../../../opencraft/docs/platform-architecture.md#embedded-workbench-shell)。

嵌入式 Chat 的绘制与可发送分属两个就绪点。启动草稿是本地身份，不依赖 Host 连接，因此 Embedded 元素在 Application 创建并渲染出草稿后即兑现 `prepare()`/`show()`（painted）；启动恢复已记忆的会话时没有启动草稿，以会话视图就绪作为首次绘制；Host 连接进度只经 `opencraft-connection` 事件发布，`opencraft-ready` 仍表示会话视图激活完成，模板 prompt 的自动提交继续以连接就绪为前提。连接未就绪时 Composer 自身以 `submissionDisabled` 拒绝准入，已输入内容时在输入框下方提示等待连接；宿主不再以「已接管」推断「已连接」，仅对从不上报连接阶段的旧制品保留该兜底。宿主遮罩只覆盖画布尚未绘制（超过 1 秒才显示加载状态）与真实异常；首次连接超过 10 秒提示慢网并提供重连，「正在重新连接」仅用于曾连接成功之后。国际站与国内站同样在 Bot 发现期间并行准备嵌入资源与物理连接，地域按站点传递。`/agents/*` 的控制台由路由 layout 常驻，切换分区不重建 Application 与 Host 连接。

嵌入式工作台与 Next 站点共用 vendored 的 `frontend/src`，但构建期环境不同：Vite 把 vendored 源码读取的 `process.env.NEXT_PUBLIC_*` 逐个静态替换（`vendoredEnvKeys`），其中 `NEXT_PUBLIC_REGION` 固定为 `cn`。因此**按区域裁剪产物的开关不得直接读 `NEXT_PUBLIC_REGION`**：嵌入式产物两站共用，必须保留国际站控制台要用的各语种资源。此类开关一律另立变量、由 Next 侧按区域派生，并在 `vendoredEnvKeys` 中登记成「空值＝保持全量」的语义，使嵌入式构建取到空值即维持既有行为。首屏同步 i18n 字典的 `NEXT_PUBLIC_I18N_LAZY_LOCALES` 即按此约定实现。

OpenCraft 弱网恢复按共享 AppHost 连接、每 Host 的协议就绪、各 Thread/资源恢复和查询缓存重新验证分别持有状态。
前台/网络恢复提示由共享连接 owner 合并；协商后的探测仅证明接入通路可达，不激活或重启引擎。
Host 在 lease 与 initialize 完成后即可就绪，慢终端、文件监听或失败 Thread 不阻塞其他会话；查询在新连接就绪后按 Host 重新验证并拒绝旧结果覆盖。
超时 claim 的迟到授权只释放原 lease；连接恢复不重放执行请求，已接纳 turn 继续由服务端拥有。具体协议与不变量见 [OpenCraft 平台架构](../../../opencraft/docs/platform-architecture.md)。

嵌入式 Chat 向国内站侧栏回传每条会话是否正在执行，来源是同一 AppServer Thread 目录的活动状态；Hermes 对已恢复会话的目录投影沿用其缓存的运行态，`turn/started` 与 `turn/completed` 触发目录刷新。侧栏仅据此显示旋转提示，不用当前选中项、Bot 运行状态或加载历史的状态推断会话执行。

OpenCraft 会话权限目录由 Host 根据 Codex 内置 profile 或 DSH preset 的实际沙箱/审批组合投影为标准语义（只读、接受编辑、完全访问）；无法验证的原生/自定义 profile 仍以引擎档案呈现，不由 Renderer 猜测。`opencraft/permission-modes` v1 的标准档位使用稳定的 `opencraft:permission-mode:*` 提交 ID，由 Host 在提交时映射为当前引擎原生 profile；恢复后的原生生效 ID 经目录映射回产品档位。DSH 选定 preset 在 Thread 创建时应用并回读校验，Turn 与 Fork 入口也校验，避免首轮执行前权限状态不一致。完整 bb 式 Host ceiling、请求值与生效值的持久对账仍属后续设计边界，不得据此宣称已经生效。

OpenCraft 的 Hermes Agent Console 暂时消费 `frontend/src` 的有界生成副本。诊断中心等共享页面修改后，运行 `opencraft` 的 `sync:mono2-agent-console` 更新副本与 `UPSTREAM.json`，并以 `check:mono2-agent-console` 验证整个依赖闭包；新引入的 UI primitive 还须在 OpenCraft 插件声明运行时依赖。生成副本不得手工修改，前端测试与 OpenCraft 插件类型检查、Web 构建分别验证真源与消费端。文件漂移报错同时给出来源标识和源文件、副本的 SHA-256，便于定位 CI 工作目录差异；哈希信息不替代逐字节校验。`sourceRevision` 仅取实际同步的源码闭包及公共资源的最近提交，文档等无关 `frontend/src` 改动不推进清单版本。清单漂移报错列出发生差异的字段、已记录与当前推导的 sourceRevision，区分源码内容漂移和 Git 历史差异；仍保持完整清单严格比较。同步脚本的 Workbench 适配锚点必须匹配当前前端结构，锚点失效时应终止同步；更新锚点后完整重生成，不保留部分写入的副本。同步闭包可能包含其他时间点尚未同步的前端修改，应在合并前核对其行为差异。此约束不改变 Hermes 命令的执行归属或网关路由。

OpenCraft 账户管理订阅与套餐额度阻塞恢复入口按当前账号区域打开官网 `/account/billing`（国内 `lightvela.com`、国际 `lightvela.ai`），不再使用旧的 `/account?tab=billing`；外部套餐页返回后仍刷新账户资料。此兼容不新增桌面总览、不改变实例创建权限或执行归属。

OpenCraft iOS 入口由原生登录和 `react-native-gesture-handler` 的 ReanimatedDrawerLayout 智能体滑动侧栏承载；没有底部 Tab。侧栏的功能列表独立滚动，个人与设置入口固定在左下角，符合桌面 Sidecar Footer 的归属；侧栏内的操作控件使用 HeroUI Native。抽屉与上浮 Bot 内容铺满 iPhone 窗口，状态栏及 Home Indicator 的安全区域作为各自面板内部留白，避免在动画外留下独立横条。当前安装的 HeroUI Native 1.0.10 没有左侧抽屉容器，不能把该侧栏称为 HeroUI Native 抽屉。智能体业务页由 `frontend/src/mobile-dom/entry.tsx` 从现有 `AgentSettingsPage`、`AgentsWorkbenchPage`、Repository/Session/OpenClaw providers 与 CSS 生成 App 内的 DOM runtime；功能执行仍归 frontend，原生只拥有 Bot/section 选择、创建和删除意图、容器生命周期和外部导航。删除意图由 frontend 的原有命名确认弹窗执行，原生不直接调用删除 API；删除后目录更新也驱动原生选中项回退。人设等业务页继续复用主站组件和响应式 CSS，嵌入容器不另造页面。生成资源随 App 打包，不将远端 `/agents` 作为主页面；所有既有 section 共用这一个容器。App 验证并保存所选区域会话，并在 DOM 脚本运行前提供区域、API base、语言和 token。生成物包含 frontend 代码，保持 Git 忽略且仅从 mono2 的两个 workspace 显式构建；公开的独立 OpenCraft 镜像不能独自重建该资源。移动端 WKWebView 的本地 HTML origin、跨域 API 和全部 Bot 操作仍需真机登录验证。

`@opencraft/mobile-account-sdk` 共享资料、实名状态、邀请数据解析，以及昵称、安全手机、头像和退出操作的接口约定；iOS 用 HeroUI Native 独立呈现账号、邀请与编辑控件，主站继续使用完整的原有账号页和邀请返利组件。iOS 头像先在本地压缩，再通过现有账号 API 上传；账号 ID 使用系统剪贴板复制；退出先尝试注销服务端会话，再清除原生会话。两个页面各自持有认证、数据加载和导航；iOS 国内站未实名时由主站实名流程绑定手机，已实名可在原生页短信改绑；实名认证及支付仍由主站现有流程负责。原生个人页合并语言、开源授权和开发者设置，并提供“订阅管理”按钮，点击后在第一方 WebView 打开所选区域的主站账单页；“管理账号”同样进入主站完整账号页。外部站点交给系统浏览器，切换区域前须退出当前会话。仅把固定事件名及数值状态写入本机最近 100 行诊断日志，该日志只在开发者模式可见。预热仅限同源版本化 `/_next/static/` 资源；不缓存私有 API、对话或其他站点内容。Android 内测 APK 仍承载独立原生工作台。运行与真机预览步骤见 [Expo README](../../../opencraft/apps/workbench-expo/README.md)。

iOS 原生账号页与设置详情页共用 `NativeNavigationSurface`：进入和退出使用同一导航动效，左边缘右滑跟手，松手后按距离或速度完成退出，否则弹回；返回按钮调用同一退出路径。位移和阈值以当前页面容器宽度计算，布局变化后重新测量，可用于手机、iPad 和折叠屏的不同承载方式。从 Bot 侧栏进入个人与设置时保留侧栏打开状态，使拖动与返回露出原侧栏；底层 Bot 或账号页面始终保持挂载，系统减少动态效果设置由动画库遵从。页面的画布、卡片、分隔线和文字使用 OpenCraft Native 语义 token，操作控件保持 HeroUI Native。HeroUI Native 1.0.10 没有对应导航页面容器，这一交互容器由 Expo Go 支持的 Gesture Handler 与 Reanimated 实现。面向手机用户保留清晰的信息分组与适合触摸的尺寸，不直接复制桌面 Sidecar 或参考截图的视觉。

## 稳定不变量

CTL `/v1/instances/:id/bots` 通过一次地域 TAT 调用、一个 Python 进程，依次获取官方 Hermes
`GET /api/profiles` 和微信、WhatsApp 绑定；仍复用通道操作的同一实现和各通道独占文件锁。
Profile API 可能加载本地环境配置，绑定读取之前恢复本次执行的原始环境，避免归属路径被 Profile 配置改变。
保留遗留 WhatsApp 归属迁移、过期预约/实际凭据/正在扫码的对账；它不是无副作用缓存读取或跨 Profile/通道的原子快照。
只有三个阶段全部完成才输出带内部版本标识的完整 payload；命令失败、输出截断或缺失阶段均失败，
不返回部分成功或自动重跑三条旧命令。公共响应、默认 Profile 的 `default→main` 映射、通道 owner/name
以及 gateway_running 的 unknown/false/true 三态保持不变，实例归属/权益和 TAT 地域仍走既有权威路径。
单次执行沿用原始调试命令的120秒预算与请求取消，不将三次预算相加。

主站嵌入 OpenCraft 的资源准备与 Bot 发现并行，但确认实例/Profile 后才创建单一 Application。
认证后的国内 Chat 入口还可从同一次实例列表读取的阶段结果准备 TAT 会话与握手：仅唯一物理实例或明确匹配的 Running 根实例，多个实例中的命名 Bot 不猜归属、不预连全部机器。
TAT 服务端仍校验归属、Running 和 active Pass；预备不启动 PTY/Dashboard，不发送 Profile/AppServer RPC。
预备 capability 不持久化，未认领15秒到期，账号/地域/实例/API 和发现代次失效即撤销；正式 Host 完成既有预检与新鲜实例确认后只能接管一次同一 multiplexer，接管后连接由 Host 释放。
失败、过期或旧嵌入制品缺少能力时使用原连接路径，不另建 Application；Dashboard ensure 仍在接管后执行。
聊天就绪不等待可选 Host Proxy；远端回环预览由自己的窄作用域 Service Worker 注册激活决定就绪，
而非主站页面 controller/ready。停止、关闭、切地址或销毁会拒绝迟到导航，失败不回退到客户端 localhost。
Pages 制品对嵌入内容哈希资源声明 immutable，稳定 loader/version/SW 仍重验证；具体边界见上述平台架构。

嵌入聊天的语音、协作、Bot Chat/管理呈现与 Terminal 面板模块由同一 Application 在首个可用可见帧后按依赖顺序启动，不再阻塞 Host/Thread 就绪。账户身份、实例/Profile 校验与协议声明所需服务仍为必需依赖。未完成模块加载在超时或销毁时撤销工厂 scope；已开始的扩展激活排空后才销毁借用的 registry/Host。Full Workbench 默认保持原 eager 策略；这不等于 Host 启动超时已修复。详见 [Embedded Shell](../../../opencraft/docs/platform-architecture.md#embedded-workbench-shell)。

- 本机桌面观看的自动恢复只有在 adapter 声明可安全重复获取短期观看授权、且 wire/media 将已建立流的异常中断分类为可恢复时启用。观看 controller 先撤销旧输入/流/attachment，再按有限退避重新授权；不复用一次性票据、不自动接管控制权、不重建执行引擎。Vela 资源准备的未知 POST 结果不能由恢复流程重放。详见 [有限观看恢复](../../../opencraft/docs/cloud-desktop-plugin.md#bounded-viewing-recovery)。
- 云桌面面板的连接/失败反馈只是观看 controller 的投影，不重建媒体宿主、不创建第二个输入 owner。通用插件拥有短用户文案和领域操作，设计系统拥有空态尺度/主题，Shell 拥有标签与最大化；控制请求可取消，只有有效后端 grant 才确认控制。视觉验收必须消费实际生成的主题属性与当前构建 CSS，不能把透明空态或零面积角色当通过。见 [面板呈现](../../../opencraft/docs/cloud-desktop-plugin.md#panel-presentation)。
- 云桌面的卡片几何来自当前连接解码后的画面比例，不来自窗口比例，也不请求改变共享远端分辨率。设计系统拥有圆角、阴影、底部控制条与接管动效；彩色边框/连体底座只投影当前可交互视图已确认的控制授权，不能由点击意图、按钮按下态或缓存画面代替。媒体缩放与输入坐标仍由 adapter 单独拥有，观看状态不推断助手正在控制。
- 桌面控制条在当前画面与输入就绪之前保留布局空间但不可见、不可聚焦或操作，不用重复禁用按钮代替连接反馈。已确认授权只改变按钮底层的 240ms 淡出/淡入；减少动态效果时立即切换，不延迟取消或输入撤权。具体呈现仍归设计系统，领域就绪与授权仍归桌面 controller。
- 桌面控制材质不借用应用全局强调色：设计系统提供独立紫色背景与白色前景的默认配对，描边、底座与交还按钮共用同一局部配色。当前本机路径没有助手外观 authority，不虚构身份偏好；全局主题及远端操作系统主题不随接管变化。
- 桌面按钮的一次原生激活拥有固定动作；View 在按下时捕获接管或停止/取消，controller 按连接/控制意图代次消费一次。中途失焦仍立即撤销，不能把同一停止 click 翻成新接管或释放后继授权；取消物理手势和页面失焦也撤销旧激活。媒体的剪贴板能力与当前是否授权粘贴分开，不支持时隐藏入口，操作标签共享本征槽位防止 pending 推动邻项。见 [桌面所有权](../../../opencraft/docs/cloud-desktop-plugin.md#ownership)。

- OpenCraft 的本机桌面路径不依赖 Vela/TAT：执行 Host 从 native Codex Thread 元数据和后端机器/主体注册构造观看授权，客户端 Scope/Host 别名只用于定位请求，不能提交任意实例/端点。一次性 attachment 按逻辑 Client 代次撤权，物理桌面只读策略由原生进程执行；观看关闭不停止 Agent。显式 `--local-desktop` 只允许 exact-Origin 回环入口，公开/DevCloud 多租户组合仍需独立可信鉴权和目录，不能据此声称 TAT 已验收。详见 [本机 Host 授权](../../../opencraft/docs/cloud-desktop-plugin.md#local-execution-server-authority)。

- 云桌面后端观看底座使用独立回环、原生只读 x11vnc 入口及后端专用 TAT 物理 socket；原四 unit 的启动保持不变。固定观看端口/本地原生测试不等于用户授权、可信桌面 incarnation 或云上验收。CTL 安装文件与 Sandbox provider 字节通道尚未接入公开 broker；生产 attachment 必须核验绑定、到期与撤权，页面不得获得任意 TCP TAT 凭据。详见 [桌面资源契约](../../../ctl/docs/cloud-desktop-resource.md)。
- 云桌面插件与 Vela 插件单向依赖：cloud-desktop 拥有通用 contract、面板和 noVNC 媒体；lightvela-platform/desktop 拥有账户/目录绑定校验、一次 POST 准备及 GET 观察、后端观看 attachment 交接，不读取 activeBotId 猜测会话目标，也不消费 Chat 物理隧道。换机/权限代次变更直接回收旧观看连接，即使稳定 target ID 不变。默认缺少真实 viewer port 与目录组合，生产后端观看授权/输入门禁未实现，能力入口仍隐藏；本地浏览器 framebuffer/input 回归不替代云上安全验收。

- 云桌面传输不从“未开放 UDP”直接推导不可用，也不把 TURN/TLS 当 HTTP/WSS 隧道。当前 ingressproxy 是 HTTP/WebSocket 代理；TAT session 另有 TCP 字节流代理，可复用为 WSS 适配边界，不能直接注入浏览器 ICE。初期采用 WSS 候选，但真实媒体、授权 attachment 和服务端输入门禁尚未接通。桌面应独立拥有物理连接，避免共享 Chat 隧道的媒体排队；逻辑通道隔离关闭不等于隔离吞吐。客户端 `viewOnly` 不代替后端输入仲裁。见 [传输评估](../../../opencraft/docs/cloud-desktop-plugin.md#transport-assessment-2026-10-04)。

- OpenCraft 云桌面框架以 Conversation 为标签作用域，后端按 Server、账户主体、环境和实例代次解析资源并授权；legacy Host 路由不拥有资源身份。可信插件自行注册入口，未接通真实适配器时不宣称可用；视图关闭仅释放观看/控制租约，不停止桌面或 Agent。独占输入由后端仲裁，客户端等待授权后才绑定输入；迟到结果和权限变更按连接代次失效。CTL 源码已增加显式桌面资源准备与只读查询：后台任务不依赖 HTTP 请求和 GET 推进，缓存核验用户/Sandbox 绑定，换机和重试替换状态对象；响应不包含 VNC 密码。编排 generation 不等于媒体 incarnation，当前进程内锁不保证跨副本唯一执行。媒体、Conversation 授权适配与真实输入仲裁仍未接通，入口继续隐藏。新路径尚未加入五个环境的精确 Gateway path_allow；JP/KR 测试环境仍是实例前缀路由，部署新版 CTL 前需另核对。见 [云桌面插件契约](../../../opencraft/docs/cloud-desktop-plugin.md)和 [CTL 准备契约](../../../ctl/docs/cloud-desktop-resource.md)。

- NewAPI 在选渠道失败时区分配置缺失与运行时不可用：当前授权分组（`auto` 为其可用分组集合）没有该模型的任何 `ability`，返回 HTTP 404 与 `model_not_found`；已配置但禁用的渠道、路径筛选后无候选、选渠道出错或配置查询失败继续返回 HTTP 503 与 `get_channel_failed`。正常选渠道路径不增加数据库查询。404 文案同时保留 `model_not_found` 标识，以兼容只保留异常 message 的 Hermes provider wrapper。

- OpenCraft 活动项、活动分组与用时标题的展开/收起，由各自 View 报告实际动画完成；同一会话视口只持有一个位置保持 lease，覆盖末帧布局稳定后释放。数值高度由共享 Web 动画适配器在写入布局前投影到滚动使用的 CSS 像素网格，不能让分数高度与滚动取整产生往返抖动；自然布局仍自行增长，不加第二个 DOM 高度写入者。新交互、主动滚动、视口替换或卸载撤销旧保持，不得由短于动画的固定计时器提前释放。验收包含真实多 Turn 测量和可见标题全程/往返振幅，不只断言最终归零。详见 [Chat UI 折叠生命周期](../../../opencraft/docs/chat-ui-architecture.md#disclosure-scroll-anchor-lifetime) 与 WSP-37。

- OpenCraft 会话的已建立位置与流式内容分离：局部历史索引只定位待回填的 Turn，不重排索引外的已加载消息；后台/导航历史请求保留请求开始后的 Item 与生命周期观察，迟到快照不能删除新回复或缩短已观察文本。规则由 Session 的 V3 兼容读取层拥有，Web/Native 不各自排序。Resume 仍先提交历史再释放缓冲通知；本地观察基线不冒充服务端序列。虚拟列表的中间窗口同时保护锚定的原槽位和存续行身份：历史插入不卸载原末行，临时 Turn 换正式 ID 不丢失替换边缘的消息 DOM。布局或身份变化即重算已提交窗口，不能仅监听数量或等滚动事件恢复；其所有权独立于会话排序和响应跟随。见 [ChatUI 历史位置](../../../opencraft/docs/chat-ui-architecture.md#history-positions-and-concurrent-observations)。

- OpenCraft 的持续目标属于 Thread，状态与执行仍归 AppServer/Host；Web 创建入口由 Composer 的“＋”菜单承载，目标编辑草稿、弹窗和已有目标进度由 Goal surface 持有。只读或没有有效 Thread 时不提供创建操作，菜单迁移不改变后台继续执行的所有权。会话行菜单只提供会话操作，不复制新建任务或 Host 设置导航；应用原有能力与入口保持。见 [Thread goals](../../../opencraft/docs/chat-ui-architecture.md#thread-goals)。
- OpenCraft 网页标题由应用 Shell 唯一写入，复用当前页任务/扩展标题；后台会话不争夺标题，草稿和设置页回退为 OpenCraft。详见 [平台架构](../../../opencraft/docs/platform-architecture.md)。
- OpenCraft 窄屏临时侧栏的外部轻点由 Shell 覆盖层接收，只收起本次浮层，不改变宽屏常驻偏好，也不把同一次激活透传给会话内容。详见 [平台架构](../../../opencraft/docs/platform-architecture.md)。

- Codex 的异步提问由 `agentMessage` Item 的 `delivery: "async"` 与 `questions` 表达，属于可回放会话内容，不是 `item/tool/requestUserInput` 阻塞式 server request；手机、桌面和普通 Web 不得依据设备类型改变协议语义。OpenCraft 以消息 ID 加问题序号生成稳定问题身份，并用普通用户提交的 `send_user_message_question_reply` 封包回答；Timeline/队列决定已答、待送和不确定状态，Composer 不被提问卡片替换。见 [ChatUI integration architecture](../../../opencraft/docs/chat-ui-architecture.md)。
- OpenCraft 用户消息的 `sending` 是投递内部状态，不在气泡下方增加短暂状态行；失败、未确认与阻止发送仍须保留可见反馈。隐藏临时文案不改变投递所有权，也不能替代本地消息到服务端消息身份交接的连续性验证。

- OpenCraft 消息取得正式 Turn ID 时，虚拟列表按稳定消息身份交接已测高度；已有正式 ID 的测量仍优先。不能因定位 ID 变化回退到估算高度，产生虚假的内容增长或改变用户的历史阅读位置。

- OpenCraft 的 Codex Host 持有 queued steer 的持久投递权。同一 Thread 的物理准入串行化；匹配目标 Turn 的 `turn/steer` 确认先持久化为 `steering`，此时后续消息可继续准入，历史物化与 client-message ID 对账仍在后台进行。仅 `dispatching` 或未获明确确认的 `unknown` 阻止后续投递；未知结果不得自动重发，Composer 在未知投递后禁用后续发送/排序，也不得把它展示为可由普通 Resume 解决。见 [ChatUI integration architecture](../../../opencraft/docs/chat-ui-architecture.md)。

- OpenCraft Web 的 `Worked for` 首触排查确认：手指按下/抬起可落在稳定按钮上，但浏览器不一定派发 `click`；放大按钮及覆盖按钮本身均非充分修复。失败样本的助手消息操作栏在触摸期间由隐藏转为可见，成功样本按下前已可见。当前触控规则让该操作栏首帧常显且无透明度过渡，手机预览连续 10 次静止轻触均收到 click；一次明显移动触发 pointercancel，不计作漏点。此为有界实测而非所有浏览器保证。`Worked for`、普通 Activity、Activity Group 各自仍持有展开状态与动画；诊断事件上报已从源码移除。详见 [ChatUI integration architecture](../../../opencraft/docs/chat-ui-architecture.md)。

- OpenCraft macOS 分发由下游 GitHub 镜像的 `macos-release` Environment 承载，但不取得源码权威。arm64 与 x64 必须在对应原生 Runner 组装，最终 job 才可读取 Developer ID 与 Apple 公证凭据；Universal 合并后依次完成签名、公证、staple、DMG/ZIP 封包和完整性验证。手工主分支运行只生成 Actions artifact，只有 `v*` tag 创建 GitHub Release；源码进入 mono2、镜像导出和公开制品发布仍是三个独立状态。镜像依赖的 mono2-parent shared package 使用带哈希清单的机械 workspace 快照，`shared/` 保持唯一真源，禁止用 Vite external 掩盖缺包。详细运行契约见 [OpenCraft Build Matrix](../../../opencraft/docs/build-matrix.md)。

- OpenCraft 独立 headless Linux Server 以一个端口托管静态 WebUI、`/appserver` 和 `/apphost` WebSocket。默认回环模式要求有效的回环 Host，检查显式 HTTP Origin 且要求 WebSocket Origin 同源；显式 `--allow-unauthenticated-public` 公开模式不检查 HTTP 或 WebSocket Origin，以允许 HTTPS 终止代理转发到直连 HTTP listener。这是单用户调试部署，不提供认证或跨站隔离；任何可访问该地址的浏览器都可尝试建立 AppHost 连接。浏览器断线重连必须在同一个 Workbench transport 对象内换新 AppHost lease，不能复用已关闭的 WebSocket 代次。Web Host 以 Ping/Pong 主动终止半开连接，浏览器限制初次 AppHost 握手时间；两者只能产生可重试 transport failure，不得销毁 Daemon 持有的物理 Host。Web 会话呈现保留已绘制的历史与 View/草稿身份，以局部状态提示重连；只有无可见历史时才在时间线空槽显示骨架，恢复权威前继续禁止执行命令。Codex Host 的 logical initialize / Thread resume 诊断只记录标识与结果，不记录消息、凭据或响应 payload。见 [OpenCraft 平台架构](../../../opencraft/docs/platform-architecture.md)。

- Headless Linux 的 Web 目录选择器浏览的是远端 Server 文件系统，而非访问它的 Mac。服务器 DSH 与 Codex 节点消费同一打包 Host 定义中的 `/` browse root，选中的目录经该节点的 `fs/readDirectory` 与 `project/create` 链路处理；系统服务用户的文件权限仍是实际边界。已持久化的旧 Host profile 若仍是打包 WebSocket 端点且 browse root 为空，只补齐该字段并递增 revision，不覆盖自定义非空 root 或其它配置。

- 目录选择器的路径导航/加载/错误是短暂 View 状态，目录读取失败清除旧列表并禁用确认；Project 创建与 Draft 绑定仍由 Application 负责，远端目录来自所选 Server 而不是浏览器客户端。弹窗、确认/取消按钮分别复用平台 Modal 和共享 Button 的主题语义色与状态，不把正文色和页面背景色反推为主按钮反色。浅深及扩展主题必须检查已启用按钮的真实计算前景/背景和对比度，再声明视觉验收完成。见 [Workbench design language](../../../opencraft/docs/workbench-design-language.md#folder-picker-ownership-and-themes)。

- OpenCraft 的 iPhone 内置浏览器 Web 界面按伪 App 定位限制页面手势缩放，同时在粗指针手机视口将可编辑文字字号保持至少 16px，以避免聚焦时的 WebKit 自动放大；桌面 Composer 字号不随之改变。该策略不禁用输入焦点或键盘交互，微信、企业微信的实际 WKWebView 行为仍须分别在设备上验收。

- OpenCraft Terminal 的剪贴板粘贴由 Panel 输入界面发起，并经 xterm 的 `paste()` 进入既有 PTY 输入链路；浏览器无法读取剪贴板时提供可调用系统粘贴菜单的原生文字输入位。剪贴板内容只属于当前 View，不持久化；会话停止或切换后，迟到的读取结果不得写入另一个终端。手机内置浏览器的系统粘贴菜单仍需实机验收。

- OpenCraft 显式 Skill 引用在 Local DSH 提交边界按当前 Agent registry 校验名称、路径、userInvocable 和原生加载器，再转换为 DSH 原生 `/name` 手势；不再静默丢弃。远程 Profile Host 从 Hermes 内容接口读取真实路径并在执行前复核，不猜目录。打开的候选列表订阅变更，按 Host/roots/revision 隔离旧结果，完整浏览不固定截断到 50 项。见 [Skill 输入与执行契约](../../../opencraft/docs/chat-ui-architecture.md#non-negotiable-boundaries)。

- OpenCraft 国际化由 Application-scoped `LocaleRuntime` 持有，沿用 Codex 的 override/source policy、FormatJS、按语言加载与迟到结果隔离。持久化只走 `UiPreferencesRuntime`；Agent Host/模型/provider 不拥有 UI 语言。Embedded 只更新自身 lang/dir，原生菜单通过受限端口消费解析结果。当前中英迁移范围和验证见 [国际化权威](../../../opencraft/docs/platform-architecture.md#internationalization-authority)。

- OpenCraft 输入 `$` 即浏览当前 Host/项目的已启用 Skills，空查询不再拦截；`@` 文件搜索仍需查询词。候选请求按目录、目标、查询与草稿 owner 隔离，失败不得缓存为成功空目录；Enter/Tab 插入保留 canonical name/path，不发送消息。无技能元数据的 Host 不由前端伪造补齐。见 [Composer 契约](../../../opencraft/docs/chat-ui-architecture.md#non-negotiable-boundaries)。

- OpenCraft 模型回复中的 URL 按资源语义渲染：Markdown compiler 保留 heading/list/table 和原始 label，`chat-render-react` 负责安全分类与 tracking 清洗，Web renderer 负责 favicon/地球兜底、tooltip、流式 500ms 稳定期以及 Radix 右键菜单。打开动作只提交 `ChatResourceOpenIntent`，由 Workbench Browser owner 决定 in-app/external surface 和 tab disposition；Renderer 不持有 Browser Session，restricted/unsafe URL 不加载 favicon 或获得 href。见 [ChatUI integration architecture](../../../opencraft/docs/chat-ui-architecture.md#non-negotiable-boundaries)与 [Browser URL policy](../../../opencraft/docs/browser-workbench-architecture.md#72-url-必须通过构造器)。
- OpenCraft Host 的 `fs/readDirectory`、`fs/getMetadata` 等文件系统 RPC 必须在 Host 边界投影为生成的 AppServer v2 contract；Workbench 资源面板不得兼容或猜测旧版 `{name,path,type}` 私有结构。
- OpenCraft 新 Thread 未选择 Project 时不阻断 Composer；Local Host 在自身用户 Home 的 `OpenCraft/` 下创建 Thread 独享的 Projectless Workspace，并把解析后的 cwd/roots 交给引擎。显式 Project 路径由 Host 规范化和验证，失效时返回稳定 Workspace fault，禁止 Renderer 拼接 macOS/Windows 用户路径或静默切换目录。
- OpenCraft 的 AppServer server-request 仍由 Server 持有 pending/resolved 真相；Renderer 点击 Skip/审批只提交响应意图。AppServer Client 提供物理 response delivery receipt，Host-scoped Workbench runtime 用有界内存 ledger 跨 transport generation 保留 exact response 与短期 tombstone：送达前不移除 pending，结果未知时同一请求自动回放而不重新弹窗，请求 payload 或 response 漂移则拒绝。该 ledger 不是跨应用重启的 Server 持久化，也不证明 Provider 已执行。

- OpenCraft 的 ZenCode 是可选内置 Web/Electron 主题，使用同一语义色和材质契约，不修改默认主题、字体或控件密度。设置卡片按当前明暗模式投影真实色板，不维护按主题 ID 写死的第二份预览配色。见 [主题表面与原生外观](../../../opencraft/docs/platform-architecture.md#theme-surfaces-and-native-appearance)。

- OpenCraft 扩展主题可提交受限的语义表面色与材质枚举，注册时校验并冻结；卸载回退会重算全部 token。Electron 接收校验后的不透明意图和背景色，失焦始终恢复不透明保护，不重建窗口或改变布局。此能力不代表 Expo 动态主题已接通。见 [主题表面与原生外观](../../../opencraft/docs/platform-architecture.md#theme-surfaces-and-native-appearance)。

- OpenCraft 通用按钮与 Settings 表单控件的字体由 Typography registry 投影，控件尺寸保持独立；焦点、禁用和错误反馈由共享状态样式消费主题 token。处理中保留按钮原标签占位，不改变控件宽度。见 [Typography ownership](../../../opencraft/docs/platform-architecture.md#typography-ownership)。

- OpenCraft 平台级 Connector 是应用级服务，不是 Hermes 设置页原型。第一方扩展通过事务注册，借用 Authentication epoch 与 Host 客户端；稳定发现/调用入口绑定 Host/Thread/代次，撤销后旧 handle 不可复用。Composer 入口、Host 原生 MCP OAuth 适配、逐次写审批和独立 CAS 配置存储已接通；OAuth 完成不自动连接或授予会话访问，重启只恢复意图并要求明确确认。凭据仍归 Host；验证使用隔离授权服务，不代表真实第三方账号或 DSH/Hermes 新增原生方法。见 [平台 Connector](../../../opencraft/docs/platform-connectors.md)。
- 后续托管 Connector 接入在 Skills 的独立 Tab，采用 OpenCraft 控件/token，目录和引导参考 Octop。`connector-core` 负责目录/contract，`connector-host` 在执行 Host 的 SQLite 分表保存配置、凭据与临时 OAuth 事务，Renderer 只拿脱敏投影；与借用的原生 MCP 适配并存，不改 Hermes 引擎。目录 23 项中 19 项有 MCP/API adapter，其余仅接入说明，不能视为已完成真实服务验收。

- OpenCraft Account Pool 是执行 Host 内的 provider credential routing policy，不是 Host、Engine、Thread、模型或客户端登录。`account-pool-host` 分离账号元数据与 0600 凭据，按 `(provider, hostId, providerThreadId)` 持久化亲和与额度状态；Codex AppServer 只接收 loopback 虚拟 Provider 地址和 Host-scoped token，真实 OAuth 仅在最终上游 HTTP 边界注入。虚拟 Provider 的 `/v1/responses`、`/v1/models` 在上游分别映射到 ChatGPT Codex 的 `/responses`、`/models`，保留请求参数与 Codex 元数据；不同 Host 各自生成安装身份，不随账号凭据复制。已绑定 Thread 在账号可用时保持亲和，短 hold 返回 `Retry-After`；只有明确的成功前额度/认证拒绝才按持久游标切换后继账号，成功、网络失败与不确定流结果不得自动重放。Thread pin 空闲 30 分钟失效且仅保留最近 4096 条。Host 主动同步 ChatGPT 套餐、主次额度窗口、重置时间及账户状态，Renderer 只消费脱敏投影。Electron 已贡献 `local-codex` Host，Daemon `CodexEngineAdapter` 通过 stdio 持有单物理 AppServer 并恢复 logical-client/Thread 路由；内置 Settings 提供脱敏账户管理、官方 Device Login、显式只读导入本机 Codex 登录、订阅额度刷新与隔离的真实 OAuth refresh。Codex Host 额外声明 `opencraft/thread-start-durability`：`thread/start` 在首轮前可能没有可恢复 rollout，Workbench 必须先取得首个 `turn/start` 接纳回执再把 Draft 导航升级为 Thread；确定性失败保留原 Draft，且该策略不扩散到 DSH/Hermes。账户页面以一个添加入口承接登录与导入，以紧凑资源行投影身份、状态和额度；Device Login 使用独立受焦点约束的 Dialog，启停、排序、刷新和移除通过渐进披露操作，不能把凭据或 Host 内部状态提升为 Renderer 可写字段。真实 Codex + 本地合成 Responses smoke 验证执行链，真实账号授权和付费推理仍单独验收。见 [Host-side provider account pooling](../../../opencraft/docs/platform-architecture.md#host-side-provider-account-pooling)。

- OpenCraft Account Pool 的 loopback HTTP 入口必须持有流式响应直到结束：Web/Codex 客户端断开时撤销上游请求、接收流错误，不让异步 `Readable` 错误逃逸杀死整个 Host；断线和结果不确定时均不得自动重放模型请求。

- OpenCraft Skills 目录刷新必须区分“不支持”和“暂时失败”：外部引擎没有刷新桥时，文件操作只报告安装事实与能力限制，不创建阻断聊天的 pending；已接入桥的暂时失败才在下次执行前重试。Skills 通知订阅由 Workbench Runtime 持有，可先于连接建立；初始化失败/重连不丢订阅，销毁后解绑。已取消的正文版本与 Hermes 自动热刷新不作为后续交付项。

- OpenCraft 的会话能力更新保持引擎中立：公共 Skills 查询/失效事件与安装作用域不携带 DSH scope。首个 DSH 适配将 OpenCraft 根注册在 native standing preset 同层，保留项目覆盖用户的 rank；安装提交与运行时刷新分别确认，步骤前对账，冷历史查询不激活 Agent。Hermes Profile action 是独立适配，不能从 DSH 结果推定其热更新能力。阶段与证据见 [存量会话能力刷新](../../../opencraft/docs/session-capability-refresh.md#72-当前落地证据2026-09-17)。

- OpenCraft 的 mono2 Agent Console 路由常量与翻译字典仍由 `frontend/` 真源机械生成，副本记录在 `UPSTREAM.json`；其中 `/account` 与 `/account/billing` 是 LightVela Web 账号/套餐页面地址，不代表 OpenCraft 宿主新增同名应用路由。宿主导航继续由自己的 Router 拥有；有界同步的文件验证不能替代整个共享闭包的漂移检查。生成边界见 [mono2 migration](../../../opencraft/MONO2_MIGRATION.md#shared-frontend-boundary)。

- OpenCraft 标签栏在 + 后提供统一下拉：上方新建类型、下方当前任务该 region 的全部标签；右侧 Browser/Terminal 图标保持一键新建。切换复用 activate-tab，新建复用 creation action，不按类型拆菜单或新增列表真源。见 [工作区所有权](../../../opencraft/docs/platform-architecture.md)。

- OpenCraft Embedded Workbench 以无内层 Sidebar 的 Web Component 接入 LightVela Agent 页：LightVela 持有外层 Sidebar、Explore/Chat 路由和会话列表呈现，OpenCraft 提供会话 snapshot、是否仍有下一页及显式加载下一页的 action，并拥有右侧 Chat 与 Composer 画布。外层列表按最近更新顺序初始展示 20 条，每次展开最多增加 20 条，可逐批收起；需要更多数据时才通过嵌入 action 翻页。每个逻辑 Host 由 LightVela `instance_id + profile_id` 唯一确定，普通 Thread 的列表、创建、恢复、历史、模型和生命周期写入均固定在该 Hermes Profile；物理 Dashboard token 可按实例复用，但 Composer queue 等逻辑状态必须按 Profile 隔离。国内 Chat 默认进入 OpenCraft；准备期间只呈现中性加载态，embedded `show()` 成功后由 OpenCraft 拥有唯一写权限。控制台 `show()` 只控制其他隐藏功能，不切换 Chat owner。国际站继续由 AgentChat 持有 Chat。嵌入 Host profile 与 Conversation binding 仅当前 Application 有效，不写入普通 Workbench Host 目录。见 [Embedded Workbench Shell](../../../opencraft/docs/platform-architecture.md#embedded-workbench-shell)。
- OpenCraft Workbench 嵌入 LightVela 页面时，浏览器文档标题由 LightVela 宿主路由拥有；内嵌应用不得在挂载、会话切换或卸载时写入 `document.title`。独立运行的 OpenCraft Web/Electron 继续由自身 Shell 管理标题。
- Embedded Workbench 的新对话空状态标题与装饰线按标题自身的底边定位；插画的丝带须随标题字号和换行移动，避免窄屏时与装饰线错位。该规则仅影响嵌入聊天的呈现，不改变 Draft 或 Composer 的所有权。
- Embedded Workbench 的生产交付保持独立 Vite target：frontend release matrix 将无 sourcemap、内容寻址的静态树同源投影到 Pages artifact 的 `/__opencraft/`，但 Next 主 bundle 不导入该树；国内用户进入 Chat 时才请求 loader。缺少 loader、manifest 或 version 输入必须令 artifact 构建失败；不得用 Legacy AgentChat 的正常 fallback 掩盖不完整发布。该同源命名空间是静态交付边界，不改变 Hermes Host/Profile、Thread 或唯一写 lease 的运行时所有权。
- 已发送消息的图片缩略图由 ChatUI 打开预览弹窗；弹窗默认挂载到当前 Workbench Presentation Root，确保国内站内嵌 Shadow DOM 的样式、层级和焦点仍有效。显式传入的 portal 目标优先于默认根。
- 国内默认接入的范围还包含非主 Bot Chat，以及默认收起的网页标签和会话文件只读预览面板。当前回滚须恢复前端门禁与旧 Chat token 请求并重新发布；CTL 运行时配置在页面加载后异步到达，不能直接作为启动前的 Chat owner 开关。

- OpenCraft Terminal 是独立字符网格：测量和绘制不得受到应用正文 tracking/word-spacing/text-transform 的不同影响；xterm 拥有行补偿，不能只验证 screen≤host 而漏掉满行文字与光标。见 [字符度量边界](../../../opencraft/docs/platform-architecture.md#terminal-character-metrics-boundary)。

- OpenCraft 应用导航由同一 Router 管理，桌面 memory、Web browser；hostless 不另建历史。Chat/Home/Settings/POP 分开，View 与 Conversation 身份分开。异步准备受意图代次约束，失败不先改历史、晚到 lease 释放，窗口分隔条不得拦截顶栏导航。见 [导航权威](../../../opencraft/docs/platform-architecture.md#application-router-authority)。

- OpenCraft 云存储暂为开发者模式专属展示：View 与导航声明共用 internal audience，关闭模式退出已打开页面。仅隐藏产品入口，不删除存储服务/数据，也不把展示开关作为访问授权。

- DSH 会话当前模型由 Thread 配置绑定，不由引擎名称或最后一次请求代替；未执行的 fork 也必须返回并持久化真实选择。动态工具协议声明与引擎调用投影分开：创建前预检、父子分开回调所有权、冷恢复只接受声明及明确 deferred 回执，不因 Agent 尚未激活而阻断历史；`turn/start` 在 prompt 前激活并严格要求 N/N 挂载，部分注册或执行时 deferred 必须失败。见 [会话绑定契约](../../../opencraft/design/dsh-jit-history.md#会话绑定与工具声明)。

- OpenCraft 的 DSH 展示恢复与 Agent 激活分开：历史通过原生消息页即时投影到所请求的 Turn/Item 窗口，不再打开或维护历史事件 SQLite 副本。模型、权限的只读描述不激活 Agent；执行边界共享同 session 的激活 flight。原生消息数不得重解释为事件数后反复刷新尾页。DSH 原生日志、routing、产品 catalog 与执行回执各自保留原 owner；旧索引不自动删除。见 [JIT 历史行为契约](../../../opencraft/design/dsh-jit-history.md)。

- OpenCraft Host 通过 `opencraft/resume-history` initialize capability 声明 `legacy/paginated/message-window` 恢复模式，冷启动深链可直接 Resume；旧 Host 未声明时才补读 metadata。会话目录已经返回的零 Turn metadata 也由 Session View 复用为策略提示，从目录打开不得再重复 `thread/read`。两种提示都不能发布历史或覆盖已恢复 View，`thread/resume` 仍是 authoritative 展示基线。见 [JIT 历史行为契约](../../../opencraft/design/dsh-jit-history.md)。
- OpenCraft Conversation 的可见恢复与执行 capability readiness 是独立状态：`thread/resume` 加首屏历史完成即可提交 authoritative Replica 并退出全页 Restoring；动态工具/Connector 注册由 Thread binding 按物理 Client generation 单 flight 预热，不能继续占住历史显示。任何可能启动 Agent 执行的 mutation 仍须等待同一 capability lease；预热失败不清空历史，下一次执行重新注册并就近返回错误。见 [ChatUI 集成架构](../../../opencraft/docs/chat-ui-architecture.md#non-negotiable-boundaries)与 [WSP-29](../../../opencraft/design/invariants.md)。
- DSH capability plugin 的 scope 工具与派生 Skill 是同一个 session mutation：register/unregister/release 在相同 native session 上串行，不同 session 继续并发；相同并发注册由后一个请求观察首个提交并幂等返回，不能各自创建 scope 后产生重复工具 400。Host bridge 对非 2xx 保留插件生成的有界单行错误摘要，但不回显 token、请求 payload 或第三方凭据。见 [WSP-30](../../../opencraft/design/invariants.md)。

  所有权整改：Host 的 capability 替换与执行准入复用 ThreadLifecycle 队列；断线先撤销 owner，迟到操作不得重新提交。新 Agent 的首次工具挂载进入 native setup，产品目录在准备后发布；持久历史不作为附件失败的清理对象。停止/审批回复不等待工具准备。上述“错误摘要”收紧为允许列表错误码，禁止任意异常正文透传。详见 [ChatUI 所有权](../../../opencraft/docs/chat-ui-architecture.md#non-negotiable-boundaries)。

- OpenCraft 的 DSH HTTP deadline 由 `DshClient` 按请求拥有；调用方 lifecycle signal 只能进一步取消，不能替换 deadline。History routed client 只合并有界窗口请求且必须在任意结束路径释放 flight，Thread lifecycle 只串行化，不再叠加超时。Workbench 仅投影 AppServer 状态：`notLoaded/idle` 中立、`active` 运行、`systemError` 错误；只有真实 attention source 才能显示待审阅。运行中文字的扫光频率由 Web/Native renderer 的共享设计 token 控制，高光色由主题完整 ink 拥有，底层文字保持原语义颜色；这些呈现属性不参与 AppServer 状态、执行租约或恢复判定。见 [DSH / AppServer 边界](../../../opencraft/docs/dsh-appserver-boundaries.md)与 [ChatUI 视觉账本](../../../opencraft/docs/codex-chatui-fidelity.md)。

- OpenCraft 的 AppServer 历史恢复以有序 Turn/Item 页面为快照权威：完整 Item 快照决定成员与顺序，分页窗口只决定其覆盖区间的顺序；恢复期间的新通知在历史提交后重放。稳定 ID 仅用于对账，不能让先到的 final 永久占据较早进度之前的位置；旧的 in-progress 历史也不能回退已经确认的完成状态。此规则由共享 `appserver-session` 负责，Renderer 不另行按时间戳排序。
- OpenCraft 的消息虚拟窗口在补历史与 Turn ID 认领时同时保留原槽位和存续行；主用户消息的 client ID 拥有稳定 DOM 身份，canonical Turn ID 仍只定位协议对象，实测高度随身份交接而非回退估算。相同条数的布局变化也必须更新窗口，不依赖下一次滚动事件，更不能抢走历史阅读者的锚点或强制滚到底。见 [Turn identity handoff](../../../opencraft/docs/chat-ui-architecture.md#turn-identity-handoff-and-mounted-window)。

- OpenCraft 的 DSH steer 按 `queued → steering → user/message` 交接所有权：unary RPC accepted 即完成命令回执，`session/queue` 的用户 `steering` placement 负责刷新/重连恢复，匹配的 durable message 最终接管 transcript。Workbench 不等待后续 queue snapshot 才返回，也不把 next-step steer 宣称为对当前 provider 请求或工具 step 的硬中断。见 [ChatUI 集成架构](../../../opencraft/docs/chat-ui-architecture.md#non-negotiable-boundaries)。

- OpenCraft 附件暂存由目标 Host 所有：`opencraft/attachment-staging` 明确 source/location/大小能力，Composer 只消费统一 lifecycle 与 `AttachmentRef`。首个 Local adapter 在产品 data root 下原子落盘 `client-bytes` 并返回 `host-file`；Renderer 不再拼接 `codexHome` 或借通用 `fs/writeFile` 冒充附件服务。Remote/Cloud 只有实际 adapter 声明 capability 后才可用。见 [ChatUI 集成架构](../../../opencraft/docs/chat-ui-architecture.md#non-negotiable-boundaries)。

- OpenCraft 本机会话生命周期由持久目录、原生上下文、逻辑订阅和视图分别拥有；Fork 新身份而重启 generation 保留身份，临时历史及缓存不落盘。共享物理 Host 不合并逻辑客户端，unsubscribe 不影响其他订阅者，迟到回复不清新视图。命名/归档通知统一失效查询，归档不删除用户目录。DSH 的名称与归档状态由 OpenCraft 持久目录拥有；Codex Host 复用原生 AppServer 的 `thread/name/set`、归档、恢复及列表，并通过 `opencraft/thread-lifecycle` 声明能力，不另建 Renderer 状态。主 Sidebar 只投影活跃会话；归档列表与恢复按 Host 能力归 Settings 所有，不在主界面保留入口或临时撤销状态。见 [会话所有权](../../../opencraft/docs/platform-architecture.md#thread-lifecycle-ownership)。

- Codex Daemon 的单条 stdio 物理 Thread 订阅不等于某个浏览器的逻辑订阅：`thread/unsubscribe` 和 lease 断开只撤销对应 Client 的读者身份；恢复回执未到的 Client 是可接收通知的临时读者，退出后迟到回执不得重新认领。审批/工具交互回复权单独归属。后台 Turn、未结队列和未答 server request 均是 Host 继续持有物理订阅的需求；只有原生 Thread 空闲且无上述需求时才能按持久/临时 Thread 的 grace 回收，并与新原生操作按 Thread 串行化。此机制不提供持久事件日志或多租户鉴权。见 [会话所有权](../../../opencraft/docs/platform-architecture.md#thread-lifecycle-ownership)。

- OpenCraft Desktop 目录身份与显示品牌、Bundle ID、进程 cwd、Thread workspace 分离：macOS 平台状态归 `Application Support/OpenCraft`，便携产品配置归 `OPENCRAFT_HOME`/`~/.opencraft`，Main/Daemon/DSH 统一显式使用平台状态下的 runtime cwd，Agent 执行只接受 Project/Thread cwd。旧 `@vela/workbench-electron` 仅作为锁感知、可回滚的原子迁移输入；显式测试 profile 不触发迁移。见 [目录身份章程](../../../opencraft/docs/architecture/product-identity.md#directory-identity-charter)。

- OpenCraft 浮动聊天与会话/草稿资源分离：Shell 路由注册表拥有显隐意图，标签拥有收起原因；inline/overlay 移动同一编辑器挂载容器，不重建草稿或浏览器。原生唤回只消费 Main 已登记 guest 的代次化鼠标事件。验收与适配边界见 [浮动聊天不变量](../../../opencraft/design/invariants.md#floating-composer-ownership)。

- OpenCraft Bot 动画是客户端 Presence 投影，不属于 AppServer 协议或持久会话。一个 Conversation Stage 拥有参与者 source/mirror、可见性与共享帧调度；工作、注意、环境与隐藏分别按 60/30/8/0Hz 投影，减少动态效果时只绘制稳定帧。身份形状、材质和语义状态分离；统一采样轮廓、眼睛边界及 `reset → enter → hold → exit → done` 效果事务均由 renderer 拥有，动画帧禁止读取布局。见 [Bot Chat motion ownership](../../../opencraft/docs/bot-chat-motion-ownership.md)。

- OpenCraft 权限菜单仅列宿主声明的实际档位，不展示 AppServer default 或提问标题。缺省/null 草稿选择仍继承实际生效权限，仅派生显示、不写回草稿；尚未解析时不虚构勾选。见 [Chat UI 契约](../../../opencraft/docs/chat-ui-architecture.md)。

- DSH 完整接入迁移仍包含执行准入、宿主能力、检查点恢复、历史协议、权限与辅助服务六项；执行表/lease/journal 的源码引入不能代表已接入生产 RPC。见 [完整迁移计划](../../../opencraft/design/dsh-complete-migration/task_plan.md)。

- OpenCraft Skills 将公开目录与安装权威分离：匿名界面可读取 SkillHub，安装和已安装状态必须明确选择本机 DSH 或一个 Hermes Profile。本机 scope 不是 Profile/Bot，AppServer 只接受有界、逐文件校验的 artifact，原子写入 `~/.opencraft/skills`；卸载移动到该根下的可恢复 trash。DSH 同时发现每次请求 cwd 下的 `.opencraft/skills`、原生 `.agents/skills` 和对应用户级根，项目间不得共享 cwd 派生目录。Hermes 继续以原生 Profile ID 作为 Skills mutation scope，不能从展示名推断。

- OpenCraft 的 AppShell 持有跨路由常驻的物理窗口 chrome：原生拖拽区、导航控制和侧栏 resize owner 不属于 Skills、Cloud Storage 或 Conversation 页面。独立管理路由只替换内容区，不得通过卸载 Header 改变窗口结构；需要无边框内容时只能调整内容布局与 inset。

- OpenCraft Sidebar 的 Start、Skills/Storage、扩展入口与 Footer action 是同一种 `SidebarNavigationItem`，差异仅为 action、icon 和 active 状态。Design System 统一拥有 leading slot、inline padding、content gap、row gap 与 section gap；分组容器只保留 landmark/分隔语义，不显示额外的 “Work” 标题或复制 Item 几何。见 [Workbench design language](../../../opencraft/docs/workbench-design-language.md)。

- OpenCraft Sidebar 的活跃会话目录采用 Activity 投影：Thread 规范 `recencyAt/updatedAt` 决定倒序与本地日期分组，Host 只作为任务 provenance，不再拥有视觉分组。共享两行任务项固定呈现标题、Project/可选远端 Host metadata 与尾部状态轨；pending、unread、运行状态和菜单不得推动正文。主行独占选中/悬停底色，独立“…”入口保持透明并消费同一行的视觉状态，触屏不通过伪 hover 制造额外色块。当前输入方式由 Web 文档统一记录，Activity、共享 Settings/菜单与 Codex 账户行消费同一触控抑制条件和主题语义 token；这不代表其他尚未迁移的功能局部控件已完成触控验收。原 Host 标题上的目标新建/设置能力迁入既有 Radix 任务上下文菜单，Thread/Host 运行时 owner 不变。菜单 Fork 的 Host 请求期间显示进行中状态，成功回执后立即打开 child，目录刷新在后台进行；route scope 已变化时不抢回导航。见 [Workbench design language](../../../opencraft/docs/workbench-design-language.md) 与 [WSP-12/24/33](../../../opencraft/design/invariants.md)。

- OpenCraft Desktop 的 titlebar Write 是 Sidebar Start 的收起态投影，不是第二个 Thread 创建器。仅 persistent Header 在 Sidebar hidden 时将 Write 注册到 Sidebar toggle 后，并复用 Router 的 `navigateToHome`；浮动 Sidebar 的 transient Header 不复制。动态 rail 宽度与 macOS safe area 由 Window Chrome / Header 测量共同拥有。见 [Workbench design language](../../../opencraft/docs/workbench-design-language.md) 与 [WSP-25](../../../opencraft/design/invariants.md)。

- OpenCraft Right Panel 的显隐与宽度模式分离：全局 Header toggle 唯一负责开关，Panel toolbar 只投影用户显式 maximize/restore；空间不足形成 auto-full-width 时不显示重复 `Back to chat`。Frost 作为独立核心 Theme ID 提供固定 35% 冷蓝 Sidebar material，不与 Codex material 的透明度建立计算依赖，Light/Dark/System 仍是正交外观轴。见 [Workbench design language](../../../opencraft/docs/workbench-design-language.md)、[WSP-26/WSP-27](../../../opencraft/design/invariants.md)。
- OpenCraft Lavender 是独立核心 Theme ID：从 LightVela frontend 的低饱和紫色语汇提炼完整浅深色 surface hierarchy，并继续由共享 semantic token 驱动 Shell 与控件。它只改变颜色和材质，不改变字体、密度、圆角或布局，也不允许业务页面按主题 ID 增加专用 CSS。见 [Workbench design language](../../../opencraft/docs/workbench-design-language.md)、[WSP-28](../../../opencraft/design/invariants.md)。

- OpenCraft Web/Electron 提供 Codex 同语义的 route-scoped Header region：扩展 View 只注册 toolbar React 子树，AppShell 继续拥有固定高度、拖拽面、左右安全区和物理 host。注册以 route scope 与 owner 双重隔离，旧 cleanup 不得清掉新 route；Web 适配使用 React portal 保留 Radix/主题等原组件 Context。Skills 将市场 tabs 与安装目标投影到 Header，搜索和 catalog 保持在 Content，切到 Storage/Home 后必须同步撤销 Header region。Header 中的互斥导航统一消费共享、token 化的 segmented primitive；安装目标由 AppShell 提供的 `ToolbarSelect` 使用统一 toolbar Button、DropdownMenu、menu width 和 item token 呈现，扩展只提交选项、当前值与 action。业务面板不得把正文 Tabs/Select 的硬编码颜色、边框或尺寸直接搬入 Shell chrome。
- Skills Content 中的已安装分类/来源筛选继续由业务层拥有选项和选中值，但触发器与浮层必须组合共享 Radix Select 的焦点、键盘、主题 surface 和 elevation。业务只能覆写 compact 尺寸；浮层宽度以 `--radix-select-trigger-width` 跟随触发器并受视口限制，不得通过局部白色 surface、额外 padding/shadow 或更大默认最小宽度覆盖相邻筛选控件。

- OpenCraft Terminal 的视觉 inset 与字符网格 measurement host 分离：padding、背景和裁切属于 panel 外壳，xterm、FitAddon 与 ResizeObserver 只消费无 padding 的可见 content box。首次挂载同步 fit，后续 resize 以 rAF 合并；字体/主题/zoom/隐藏后重显使旧测量失效。只有最终 cols/rows 变化才发布 PTY resize，不能用 CSS 换行、额外裁切或默认 `80×24` 掩盖网格与 Host 几何分裂。见 [工作区不变量 WSP-21](../../../opencraft/design/invariants.md)。
- OpenCraft 会话级终端目录由 Renderer Application 按 Conversation Scope 拥有有序 session 集合和最近激活项，Host 继续唯一拥有 PTY/process 与回放窗口，Panel/xterm 只是投影。`read_thread_terminal` 是无参数只读动态工具：调用 Host + Thread 必须先通过 Conversation Binding 解析到 Scope，只返回该 Scope 当前终端的有界输出，不接受 session ID、不枚举或跨会话读取。动态工具目录把 Browser 与 Terminal 声明作为同一 Host capability lease 注册，部分注册必须失败关闭。见 [会话终端语义](../../../opencraft/docs/platform-architecture.md#conversation-terminal-semantics)和 [WSP-22](../../../opencraft/design/invariants.md)。
- OpenCraft Typography 由 Design System 的单一 registry 驱动：`typography.tokens.json` 定义统一 family fallback 与 Web/Native 语义 metrics，TypeScript/Native 直接投影，Web 变量由脚本生成并经 `--check` 门禁。TypographyRole、TextTone 与平台 smoothing 分离；Shell/Sidebar/Settings Chrome 通过语义 primitive 组合，不再在 Feature CSS 复制字号、行高、权重或把主要导航整体降为 secondary。Web/Electron 使用 system-first fallback，Native 使用平台 system face；这统一语义和 fallback owner，不要求跨平台物理字形一致。

- OpenCraft `New chat` 采用 Codex 的 Home 语义：统一 `navigateToHome` 事务同步创建并呈现本地 Draft、提交 conversation application route 与 URL，首次发送才创建远端 Thread。物理 Host/Workspace 准备在 Home 可见后异步进行；慢连接或失败只能更新聊天页内的 readiness/error，不得阻塞离开 Skills/Settings，也不得让标题、Draft 与主内容路由分裂。所有标题栏、浮动标题栏、Sidebar 和 hostless 入口消费同一语义命令。

- OpenCraft 的页面创建入口唯一拥有卸载：先卸载 React 消费者，再释放 Host；BFCache 保留原图。受管 DSH 意外退出时失败收尾活动请求，不自动重发；按有界预算恢复进程、模型配置和事件流。短暂启动成功不重置连续崩溃预算。见 [宿主验收矩阵](../../../opencraft/design/dsh-host-acceptance.md)。

- OpenCraft AppServer Host Runtime 持有逻辑 Host、Thread 与恢复投影，物理 Client/Transport 属于可替换的连接代次。Provider Host 必须向 Runtime 提供 transport factory；Client 初始化失败的清理可以永久关闭该代 transport，但后续重连必须创建新 transport，不能把已 `close()` 的对象交给新 Client。已完成初始化后的普通物理断线仍由当前 Client generation 的 transport 重连并恢复 Session；只有 Client generation 结束才整体替换。永久关闭和暂时断线不得共用同一可重试状态。
- OpenCraft `AgentRuntimeDirectory` 是应用级 readiness 与协议请求边界，组合已有 `HostRuntimeRegistry`，但不接管 Host 注册、Transport、Thread、Skills 或模型领域状态。页面与领域服务先等待目标 Runtime 完成 AppServer initialize，再通过 Runtime 的 `ProtocolPort` 使用既有 AppServer method/params/result；不得直接读取 raw client registry。Local DSH、远端 Host 与 Hermes 只改变 Runtime/Transport provider，不派生产品私有协议。开发与打包时 Electron 必须把 capability plugin 的绝对装配路径显式传给 Daemon，Daemon 不得依赖继承的 `cwd` 猜测插件位置。

- 已保存连接检查只接受 provider/model/revision，由后端解析存储的端点和凭据，密钥不回传界面；未保存修改不自动提交，不把旧密钥用于调用方提供的新地址。

- 模型 Base URL 与操作路径分离；配置、发现、探测和执行前共享校验，禁止把完整操作 URL 再拼接一次。合法网关前缀保留，不静默重写地址。

- Reasoning 能力缺省不是 none；默认值须属于模型支持集合，展示/选择/编译共享同一规则。OpenCraft 目录协议允许 null 默认值，提交前核对目标模型能力，不通过模型名或无条件删 none 绕过引擎验证。见 [reasoning 契约](../../../opencraft/design/reasoning-capability.md)。

- OpenCraft 模型配置由产品自己的 models.json 仓库、校验与 revision/CAS 管理；引擎端口仅接收配置和凭据解析能力。DSH 私有设置是执行投影，不能反向覆盖产品文件；应用失败与保存成功分别报告。见 [模型配置所有权](../../../opencraft/design/model-configuration.md)。
- OpenCraft 语音输入归属于客户端，不属于 DSH/聊天模型：Mac Electron Main 拥有 Speech helper 与物理录音，插件转换事件，Composer 复用瞬时文本事务。设备/语言偏好按 profile 私有 JSON 保存，取消/换草稿/卸载隔离迟到结果。仅显式开始申请系统权限，probe 不录音；按语言检查端侧支持，不承诺全部离线。见 [客户端语音所有权](../../../opencraft/docs/platform-architecture.md#client-voice-input-ownership)。
- 听写Footer与瞬时输入共用事务所有权，不另建全局显隐开关；普通动作保持挂载但inert，模式切换不重建编辑器。停止只写入，Enter/转写发送等待最终结果并核对原草稿/View；取消/失败/失去归属不能迟到发送。数值音量走独立采样，不刷新草稿状态、不二次录音。见 [听写交互验收](../../../opencraft/design/dictation-interaction/task_plan.md)。
- 听写session拥有按真实识别task ID排序的final账本，片段确认不等于录音结束；同一AudioEngine轮换当前request，用户stop才完整收尾。录音只读保留原草稿/选区，不把临时猜测写入；最后组装一次提交，失败/取消不自动插入部分结果。Browser使用真实result index同样final-only。见 [会话与片段重构](../../../opencraft/design/dictation-session/task_plan.md)。
- 听写最终写入采用Codex具体controller的追加文末/同步读回策略，不覆盖任意旧选区。本产品Store/View分离补显式ack：原Draft/View/内容代次在写入前后都须有效，内容替换同步取消旧输入；拒绝或丢失插入reservation必须返回false，不能仅凭识别文字非空发送。泛用瞬时selection提交保留。见 [写入所有权闭环](../../../opencraft/design/dictation-ownership/task_plan.md)。
- OpenCraft 模型目录的默认标识只来自明确产品默认，不从目录首项推导；无选择/默认时不创建本机新任务。模型输入能力由实际引擎 resolved metadata 投影，Compiler 与 Host 共同校验；未知能力不授予图片输入，文本模型图片请求在文件读取/推理前拒绝。默认变化不改变已绑定会话或删除附件。

- Composer 的模型目录由 TanStack Query 按 Host/会话范围发布完整分页快照；配置写入统一失效，菜单打开校验新鲜度，取消后的旧响应不可发布，刷新失败保留旧快照并标错。产品 Bot 身份只由 `bot/*` 目录拥有；已删除无实际消费者的 OpenCraft `agent/list` 目录，`turn/start.agentId` 仍是独立的执行参数。

- Hermes reasoning 适配复用既有 AppServer 模型与 Turn 字段，不扩协议：`model/list` 的 effort 集合同时决定界面、默认值和请求编译；`none` 只在 Hermes 声明允许关闭时出现。强制思考的 GLM 5.3 系列只暴露 `low/high/max`，默认 `high`；创建、活动 Turn 切换与恢复都由 Hermes Session 的 `reasoning_effort` 拥有，Bridge 通过 `config.set key=reasoning` 更新，最终 provider wire clamp 仍归 Hermes Runtime。

- 提供商启停由列表行的共享滑动开关承载，名称点击只负责选择；右键保留自定义项重命名和删除。窄屏无列表时保留详情启用入口，所有入口复用同一 Host 命令。

- 提供商右键“设为默认”仍写入唯一的 `provider + model` 默认模型定义：单一可用模型直接设置，多模型必须通过子菜单明确选择；不得新增 provider-only 默认状态或静默选择列表首项。禁用/未激活、无可用模型、脏草稿、只读和忙碌状态不发起写入。

- OpenCraft 自定义提供商的右键删除走 Host 协调命令与 DSH CAS：只移除该提供商及其模型选择配置，保留凭据与会话历史，阻止删除当前默认提供商。重命名不改变 provider ID；内置提供商不可通过此入口删除。

- 模型连接的 Responses API 开关归入默认折叠的高级设置；启用协议在摘要中可见，折叠不改变实际协议或保存草稿。

- OpenCraft Web/Electron 不因已登录账号没有云端 Bot 而替换工作区；账号级 applicationIntervention 不再控制聊天呈现，旧 bot-required 只供显式 LightVela 配置使用。零 Host 显示中立的无 Agent 状态并提供 Settings 入口，不建立 Environment 应用界面；真实选中 Host 的认证/连接错误仍由对应 provider 处理。
- OpenCraft 将机器资源生命周期、Host 连接、Runtime readiness 与任务/View 激活分为独立状态。Local/手动 Host 没有云资源对象；Provider Environment 保留原始云状态并投影规范化 `creating/active/suspending/suspended/resuming/removing/destroyed/failed/unknown`。资源动作必须由 source 同时声明 capability 与 handler，并携带稳定 operation ID；`provisionHost()` 仅保存连接配置。新建任务区的连接圆点只读 Host runtime，任务激活失败不得把 Local 持续染红。

- OpenCraft 简化模型服务只改变呈现与编辑交互：已配置连接按需展开、首次配置展开，配置存在不等于探测成功；明确保存和取消共享原有 CAS/凭据接口。模型服务位于 Settings 的“本机”分组，继续通过 `AgentRuntimeDirectory` 绑定固定 `local` Runtime，不跟随当前聊天 Host；启动等待只使用原位 pending 图标，不增加连接文案或改变页面几何。

- OpenCraft 模型服务的品牌目录仅供界面识别：提供商品牌与模型家族独立匹配，未知标识有中性兜底；不影响 Host、模型路由、凭据和默认模型。资源本地打包，继承现有主题。

- OpenCraft 当前只提供右侧工具与 Overlay 聊天；不提供下方面板、移动到下方或 Show bottom panel。旧 bottom 标签在视图接入时无损归回右侧，不能因撤销布局能力而关闭网页或终端。

- OpenCraft 的任务工作区呈现契约由 [design/](../../../opencraft/design/README.md) 维护：主 Composer 在普通聊天与展开工具之间共享同一草稿/提交目标，面板移交不关闭资源，临时 Side Chat 通过源 Host 的真实 ephemeral fork 创建。该目录显式区分实现与真实 Host/桌面验证，不能把不支持的协议模拟为成功。

- Pass 升配 checkout 每次明确确认支付都由 CTL 校验本人归属、当前状态和合法目标后新建订单，不以历史未付款订单复用或查询作为前置条件。支付票据重签及兼容的订单恢复接口仍须校验本人归属；匿名微信桥仅接受精确绑定的支付票据，不得开放建单或恢复查询。不同订单争用同一 Pass 仍由现有 flow/CAS 保护，已交付订单仅凭匹配的持久化回执幂等重放。具体契约见[订阅购买与续费](../journeys/subscription-purchase-renewal.md#pass-升配-web-checkout)。
- Pass 升配目标由服务端策略表确定；CTL 对同一请求中的独立目标并行向 Trade 询价，再按策略顺序组装响应，不能让外部计费延迟按目标数量线性叠加，也不能把单个目标的临时询价失败降级成“无可升级套餐”。单目标询价预算为 20 秒，公共 `ctl-passes` 上游预算为 30 秒；任一目标失败时整条列表请求失败并保留可诊断错误。
- Pass 新购和续费的微信桥请求携带 `auth_code` 时，CTL 必须以票据绑定的原下单用户为准，即使扫码 OAuth 或既有 Cookie 同时注入了另一用户会话；只有请求未携带票据时才允许回退到会话身份。票据仍须一次性消费，并校验绑定的订单和续费 Pass。
- 点石自动续费的 `do_goods_and_pay` 只能由 Trade 的受信内部接口承载；CTL 不暴露用户端、管理端或
  internal 转发入口。CTL 的 Pass 生命周期接口不得成为绕过 Trade 活动配置、站点限制和订单幂等校验的
  点石调用通道；控制台普通续费仍调用 Trade 的普通续费建单流程。
- CTL 对外兼容腾讯云 Cloud API 的 `DescribePass` 以影子账号 `Uin` 为必填查询作用域，请求和成功响应的 `Uin` 均按字符串传输，请求值校验为正整数；`AppId` 与 `PassId` 均可选，显式传入非正 `AppId` 必须拒绝。调用方提供的每个条件都须与同一 Pass 匹配，归属不匹配统一返回资源不存在；省略 `PassId` 时按匹配条件取 `created_time DESC, pass_id ASC` 的首条记录，省略 `AppId` 时不得附加 AppId 过滤。成功响应使用 `ExternalUserId` 返回 Pass 归属的 LightVela 用户 ID，不再返回语义含混的 `UserId`。

- Sandbox 请求路径不创建/重装机器，只分配/释放；后台 worker 执行重置与补货。
- Sandbox worker 在 shard 0 启动后及此后每五分钟同步一次资源池供给观测。按 Pool 的 region、zone 和机型族调用 CVM `DescribeZoneInstanceConfigInfos`，`zone` 与 `instance-family` 的每组 Filter Values 最多五项，并固定按量计费与 `realStatus` 过滤。`pool_supply_overview` 按 region、zone、完整机型聚合：`resource_count` 保存接口返回的库存值，`sales_state` 仅由同组 Pool 是否有 `status=active` 决定，与库存值无关。地域内任一查询批次失败时不刷新该地域库存与 `updated_time`，但仍同步 Pool 售卖状态；该表仅供观测，不作为下单或补货门禁。实现见 `sandbox/internal/service/pool_supply.go` 与 `sandbox/migrations/000013_pool_supply_overview.up.sql`。
- Sandbox Pool 是云地域归属的生命周期 owner：Pool 创建后不得跨 region 修改；同 region 内可调整 zone、VPC 与 subnet。实例仍通过 `pool_id` 归属 Pool，CVM、CBS、TAT 交付校验、停启、销毁与同 SP 升配必须携带由 Pool zone 严格推导的 region，禁止以进程级 `TENCENT_REGION` 覆盖存量实例归属或在 region 缺失时静默回退。
- Sandbox 因安全组配额触顶裂变 Pool 时，新 Pool 的 `instance_type` 继承源 Pool，并持久化在 capacity bundle 的 lineage 中以支持中断后重试；普通 SKU 容量扩张仍使用 SKU 默认机型。
- Sandbox Pool 的补货熔断与接流量是两个独立状态：终局云创建错误或连续失败仅设置持久化 `refill_paused`，worker 不再补货，但 `status=active` 且 `capacity_state=active` 的已验收 CLEAN 库存仍可分配；显式 Pool 暂停仍挡住两者。运营可通过 Pool PATCH 清除 `refill_paused` 恢复补货。由容量 bundle 自动派生的 Pool 初始为 `capacity_state=warming`、绑定 admission paused；worker 通过数据库条件更新仅在 Pool 仍 active 且存在已验证 CLEAN 实例时切为 active，并只同步目标 Pool 的绑定。warming Pool 计入扩容目标，避免补货期间重复派生；没有 CLEAN 或手工暂停时不得自动开放。
- 同一 2C8G SKU 可由不同机型和可用区的 Pool 共同供给，但每个 Pool 必须保持 2C8G/50G 规格、独立安全组分片和有效模板绑定；CTL 只从同 class/SKU 的活动 Pool 中选取候选，容量冲突可继续尝试下一个 Pool。安全组触顶后派生的新 Pool 必须保留源 Pool 的机型与可用区，不能把 SA5 变体改回 SKU 默认的 SA9；普通 SKU 容量增长仍使用 SKU 默认机型。
- Sandbox 实例隔离必须先通过 `DescribeInstancesStatus` 读取 CVM 状态：`STOPPED` 按幂等成功处理，`STOPPING` 不重复调用 `StopInstances` 而进入状态轮询，仅 `RUNNING` 调用 `StopInstances(STOP_CHARGING)`；其他状态必须明确失败。停机请求后的状态竞态仍须回到状态轮询，只有确认 `STOPPED` 后才能推进 `PAUSING → PAUSED`。CTL 提交暂停后必须在有界时间内轮询 Sandbox，确认其真实进入 `PAUSED` 才完成隔离任务；Sandbox 不存在、状态未知或轮询超时均须保留失败并允许任务重试。异步停机提交失败时，仅在云端明确回到 `RUNNING` 后回滚为 `ALLOCATED`，`STOPPING`、`STOPPED` 或无法确认的状态继续保留 `PAUSING` 以便后续对账。
- 本轮活动保留既有 `spec-2c4g50g` / `spec-4c8g80g` 作为套餐兼容路由键，不由名称推断内存。CTL 规格字典对外返回的实际展示为 2 核 8G 50G 盘 / 4 核 16G 80G 盘，定价页与之保持一致；实际新建和升配落池仍以生产 `spec_pools` 对应的 class + SKU 及 Sandbox 有效池为准，不从规格展示字典推断 Pool ID。
- 同 SP 升配只允许在同一 region 的 Pool 之间重绑；CTL 必须按每台实例当前 Sandbox 所属 Pool 的 region 筛选目标规格 Pool，不能从全局候选中直接取首项；同 region 可跨 zone。该流程不迁移 CVM、IP、系统盘或网络。跨 region 交付必须新建目标地域实例并走独立迁移/切流方案，不能直接改 Pool 元数据伪装迁移。
- 同一 SKU 跨多个 Pool region 时，具体腾讯云镜像由 `pool.zone + pool.base_image` 表达并归 Pool 所有；CI 使用构建结果中的 `HERMES_IMAGE_ID_<REGION>` 只刷新目标 region 的 Pool。SKU 的单值 `desired_image_id` 仅兼容单 region 自动 rollout，worker 发现同一 SKU 跨 region 后必须停止该全局覆盖路径，不得改写其他 region 的 Pool 镜像或把其 CLEAN 实例标成 DRY。
- Sandbox Worker 运行在 Kubernetes 默认 Pod 网络命名空间，使用集群 DNS 访问腾讯云内网
  CloudAPI；不得共享宿主机网络，也不得把 CloudAPI 域名固定到节点链路本地地址。临时镜像
  更新 Pod 必须遵循同一网络隔离边界，不能从存量 Pod 继承 `hostNetwork`、宿主 DNS 策略或
  CloudAPI `hostAliases`。
- 已分配实例的同 SP 升配走持久化变配账本，状态只允许
  `ALLOCATED → MODIFYING → ALLOCATED`。后台 worker 按“停机、计算规格升级、系统盘扩容、
  开机、交付校验、目标 Pool 重绑”单向续跑；幂等键必须阻止不可逆扩盘重复执行，失败只
  前滚重试，不自动缩盘或回源 Pool。
- 计算规格升级不消费目标 Pool 的预创建库存，也不得把 `Pool.instance_type` 当成存量 CVM
  的唯一可用机型。Worker 通过腾讯云 `DescribeInstancesModification` 读取该实例的可变配
  列表，以目标 Pool 配置机型的 CPU/内存定义逻辑目标，只冻结完全同规格且状态为 `SELL`
  的候选，再按实例实际 region 的机型族策略排序。地域策略由
  `TENCENT_MODIFY_INSTANCE_FAMILIES_BY_REGION` 管理；当前北京、新山、首尔、上海和新加坡均只允许
  `SA5 → S5 → SA2 → SA3 → S6`，未列入策略的机型族不得用于升配，未配置地域必须失败关闭。
  `LimitExceeded.InstanceQuota`、明确的机型售罄或不支持错误才推进并持久化候选游标，限频、
  网络、实例忙和云服务暂态错误继续重试当前候选。每次重试先回读真实实例规格，以收敛“云
  调用成功、账本落库前中断”的窗口；最终实际机型可与 Pool 的创建默认机型不同，但 CPU/
  内存、系统盘和逻辑 Pool/SKU 归属必须符合目标套餐及所在地域的机型族策略。
- 同 SP 升配依赖 CTL `pass` 表持久化在飞 flow 与目标 Bundle；发布 CTL 常驻 workload 前
  必须确认目标环境 schema 已具备对应字段。测试环境发生过紧急补列时，后续正式 migration
  必须可重入并推进迁移版本，不能把 workload Ready 或一次业务成功当作 schema 已由发布链路收敛。
  已被任一环境写入 `schema_migrations` 的历史版本还必须永久保留配对的 up/down 文件；即使原结构
  变更已折叠到更早版本，也应以 no-op tombstone 保持 golang-migrate 的连续升级链。
- 流式/非流式、provider fallback、错误映射和渠道行为由运行时代码与 contract 拥有。
- CloudAgent gateway 镜像与 Wisp/runtime artifact 是两个发布面，跨越时分别验证。
- 运行问题先定位入口接收、编排、实例、生成、渠道/出口的失败边界，不从最终“无回复”猜根因。
- 上游 subtree 与 vendored 内容保留 pin 和本地差异，不无边界复制。
- OpenCraft 迁入后由 mono2 单一所有；旧仓库仅保留历史。它与 `frontend` 通过显式生成闭包过渡共享 Agent Console，生成层不得成为第二真源，后续稳定边界应收敛为 workspace package。
- Agent Console 生成命令必须在 Git 工作树中记录真实源 revision；任何命中生成闭包的 `frontend` 源码变更（包括生成的 i18n 字典）都必须在最终源码提交后运行 `npm --prefix opencraft run sync:mono2-agent-console`，并在同一 MR 提交机械生成副本与 `UPSTREAM.json`，再运行 `check:mono2-agent-console`。并行 MR 先后命中闭包时，后合分支须先纳入最新目标分支，再按合并后的源码重新生成。只读漂移检查可在不包含 `.git` 的 CI 隔离目录中复用已提交清单的 revision，但仍须逐文件校验源内容与 SHA，不能因此跳过 vendored 一致性检查。
- 共享范围包含 Dialog 原语、i18n 字典 / 映射和 HTTP Repository，不能只按被修改的业务页面判断同步范围。Dialog 的关闭文案、遮罩样式等可选 prop 与键盘焦点样式随来源同步，同时保留 OpenCraft 的 portal / import 适配。Repository 在升配期间遇到嵌套 Bot 查询 `403 PASS_MODIFYING` 时保留实例根 Bot 数据；其他鉴权错误仍抛出，该数据降级不放宽服务端权限，也不表示升配已交付。
- 前端升级错误文案按当前页面 locale 解析，生成字典通过同一闭包同步到 OpenCraft；字典可用不代表宿主已经接入升级 checkout。后端未知错误使用本地化兜底，错误文案翻译不改变支付、Pass 权限或交付判定；实现与测试入口见[升级套餐交互](../../../frontend/openspec/specs/pass-upgrade.md)。
- 前端 Agents 首次套餐读取未确认时隐藏 Bot；请求卡住后允许显式重试，失败不能被解释为已完成套餐确认。升级订单已确认本地失败终态后停止自动读取，保留同单手动刷新与支持；正常可查询的 `modifying` 不设前端交付期限。支付准备失效后，旧状态 / URL / 授权响应不得重新触发旧单支付。这些界面恢复规则不改变后端扣款和交付判定。
- OpenCraft 不注册 mono2 MR 占位检查或专用 CI 流水线，避免共享 `frontend` 路径触发隔离 workspace 的重复安装；完整验证能力由 `opencraft/` 内的 `npm run gate` 保留，并按变更风险由开发者或发布流程显式执行。
- LightVela Web的发布入口只消费经产品边界检查的`dist-lightvela-web`，不以通用Web产物替代；
  它不包含HyperNode插件，也不随发布创建Human账户、Host或Collaboration后台。静态包已发布
  与账号登录、IM群/私聊、AppServer可用分别验收，不能用一种结果代替其他责任面。
- `vela-computer`候选制品属于托管Computer内的Agent Chat Client交付准备，不是新的常驻后台。
  候选仅原生构建、版本/完整SHA/dirty标记及内容校验，未内置更新通道或旧TAT桥；
  `deploymentQualified=false`不能授权Computer Enrollment、实例更新或真实Runtime会话。
  正式下发仍须独立验证短期Runtime Session/UserSig、IM恢复与受控回复、驱动和目标实例，
  Human、Computer和Runtime身份不互相替代。详细阶段见[发布与GitOps](release-gitops.md)。
- OpenCraft 的应用/个人双入口归属 Shell 的 Sidecar Footer，不是全窗底栏；Pin 切换保持局部锚点，全部侧栏收起时入口一起隐藏。Pin 偏好、临时展开和响应式可停靠能力分别建模；窄屏不得抹除偏好。左侧栏位共用聚合宽度信号，不重建 Host/会话运行时。Sidecar 的上下文插槽可选：聊天提供会话列表，设置提供索引，当前扩展页面不提供上下文，只显示单一应用导航栏；切换页面不改写 Pin 偏好。该插槽不是新的扩展注册协议。Web 通过 Radix 拥有临时容器交互，跨端 reducer 不依赖 DOM；Expo 视觉适配另行接入。
- OpenCraft 应用栏和上下文栏独立持久化宽度，共用分隔线原语的拖拽、键盘和双击复位交互；Shell 约束可用内容宽度，响应式投影消费应用栏宽度但不覆盖用户偏好。双入口复用紧凑侧栏条目：默认透明无描边投影，悬停、展开与 Pin 复用导航浅底色，保留语义按钮和键盘焦点。入口组按对称内边距铺满最左侧栏：左侧正方形，右侧个人入口占剩余空间，不再固定 1:3 或跨越两栏；调宽或 Pin 保持左下锚点，右边缘跟随栏宽。Footer 在停靠和临时侧栏中都占据独立布局行，列表视口限定在其上方，禁止用零高度绝对定位容器覆盖业务列表。
- OpenCraft 会话顶栏分隔线资格由布局所有者的窗口宽度减右侧面板宽度决定，不再混用 DOM 主区测量值与左栏动画值，防止临界宽度的跨帧测量误差导致横线闪烁。Vela 首页字标和顶栏隐藏测量副本共用相同文字几何；品牌字体资源尚待确认，不将临时 UI 字体回退视为定制字体交付。
- 应用导航的 contribution 只声明语义图标/目的地；平台 glyph 投影普通与选中图形，Design System 独占尺度和状态色，不继承菜单的图标密度。紧凑/展开共享内容，触控命中区可自适应但不修改导航偏好或引入参考产品未接通入口。详见 [导航图标不变量](../../../opencraft/design/invariants.md#application-navigation-glyphscodex-2693031428-参考)。
- Sidecar 统一绘制导航栏、上下文栏及 Footer 后面的连续材质，子栏和 Footer 不再分别叠加背景或模糊；保留 Footer 真实布局占位，但不得出现白色底条或上下文栏下方露出的深灰窗口底色。
- Sidecar 不绘制边缘渐变；Header 的主表面上沿随既有实时帧/显隐进度向左延伸，不能等 context 卸载才突变底色。上沿的外露下边缘复用主表面的主题 elevation，flat/none 不画阴影，裁掉白色连接边以避免重复接缝，不新增独立阴影参数或主题名单。横向细线与标题栏下方竖分界共用绘制进度；窗口预留、pane 内容生命周期、主题 elevation 和浮动阴影各有独立所有权，布局/拖拽命中区不变。见 [Workbench design language](../../../opencraft/docs/workbench-design-language.md) 与 SHL-05。
- OpenCraft 应用入口直接切换停靠栏，宽屏没有中间菜单或二次 Pin 操作；窄屏切换同一导航内容的抽屉，不覆盖宽屏偏好。账户仍独立使用菜单。设备设置在有 Host 和零 Host 宿主中均复用 AppShell 的上下文与主内容插槽，替换分类/详情而不替换 Shell；不允许设置自行禁用全局导航或引入私有宽度/折叠控制器。应用栏展开时为导航、设置分类、设置内容三栏，收起后自然变为两栏。Agent 管理仍由独立模态容器拥有。
- OpenCraft 应用历史只保存聊天引用；启动时当前 entry 的有效目标优先于共享的最后使用偏好，Router 与资源激活必须采用同一解析结果。Host 配置验证可用身份，草稿存储验证存活，绑定存储将已提交草稿映射到 Thread；失效草稿不按旧 ID 重建。Router 独占纠正 entry 并保留设置/扩展页面，规范化为 REPLACE 的后退也要被激活事务消费。当前保留 View 的返回不等待远端连接，后台续接受新导航/释放约束，不能跨会话复用 View 或丢弃当前输入；提交中的导航保护不变。嵌入式 memory 导航不读取或改写外层页面历史。详见 [Application Router authority](../../../opencraft/docs/platform-architecture.md#application-router-authority)。
- 会话选择由导航事务唯一解释；侧栏只发语义意图，不自行用活动/pending 投影早退或拼接设置页返回逻辑。重复恢复目标合并、已呈现 View 的复用和显式新页面打开分别建模，同 Thread 多个历史页面保留独立输入。所有异步提交共用导航代次、释放及 Router revision 资格；过期草稿转换不能抢新页面，接受失败/抛错释放准备资源，最后使用偏好只记录仍有效的命令结果。
- OpenCraft 将“账号已认证但没有可运行 Bot”建模为应用级 `bot-required` 状态，而不是登录失败或 Host 传输错误。Web 零 Host/连接干预与 Expo 账户门共享同一纯状态投影和区域创建地址，各端只拥有自己的呈现适配；实际创建、套餐、实名与资格校验继续由 `frontend` 的 `/dashboard/create` 统一流程拥有。
- OpenCraft 的 LightVela 匿名状态不是应用级 intervention：只要本地 Host 可用，默认路由必须保留本地新任务 Workbench，不能由登录页接管主内容。Sidecar 的匿名账户入口明确显示为 `Sign in`，点击后才打开国内/国际区域选择并继续到对应 LightVela Web OIDC；已登录账户恢复头像/名称，已登录但无 Bot 仍使用既有 `bot-required`。只有用户明确选择需要 LightVela 凭据的 Host 时，Host-specific `authentication-required` 才可接管该连接上下文。
- OpenCraft 内嵌 Hermes 控件以语义状态和 Host token 为契约：业务页面只拥有选项值与策略，Web Option/Select 原语拥有可访问性语义，Host 主题适配层拥有颜色、焦点、选中与禁用视觉。挂载到 `body` 的 Select/Popover/Dialog 必须显式选择命名呈现层级，不得在功能页面使用数值 `z-index` 与应用模态窗竞争。
- OpenCraft 公告窗口是既有应用模态 Host 的内容变种，不是第二套窗口管理器。可信 JavaScript 只能通过 `api.window.showAnnouncement()` 提交可序列化描述并等待动作/关闭结果；扩展卸载必须先收敛其未决窗口。ReactNode、DOM、Radix、焦点、Portal 与数值层级不得进入扩展 ABI，自动展示资格和已读持久化由独立公告编排层拥有。
- OpenCraft Web/Electron 把 Vite 静态资源放入公告描述前，必须在 renderer adapter 将相对地址解析为当前模块所属的绝对 HTTP(S) 地址；不得为了兼容 Electron 相对 `base` 而放宽 renderer-neutral 公告协议。账户区域切换的“需先退出登录”不变量继续由账户服务强制执行，交互层必须把该预期拒绝就地呈现，不能让它升级为未捕获的全局运行时错误。
- OpenCraft macOS 本地 preview 与发行包是两个交付契约：preview 使用独立 Bundle ID、产品名、profile、daemon socket 和输出目录，关闭证书自动发现，并在资源最终装配和目标架构 native prebuild 裁剪后执行一致的 ad-hoc hardened-runtime 签名；发行 ZIP/DMG 继续承担 Developer ID、notarization 与最终 Gatekeeper 验证，二者不得互相复用半签名目录。
- OpenCraft Workbench 侧栏的导航动作与账户入口共享同一个 leading-slot 几何契约；图标、头像、文字起点和行内间距由侧栏局部 token 统一拥有。hover、选中、按下和菜单展开状态只能改变绘制状态，不得切换盒模型或移动文字列。
- OpenCraft 扩展目录在 Skills“扩展”Tab 由 Application 提供，Skills 仅选择内容槽；安装/运行/贡献投影沿用原 owner，操作走 Manager。内建与用户扩展统一可见，安装目标选择器不影响扩展目录，开发者 URL 安装与普通用户列表管理分开。
- OpenCraft 扩展由现有 Supervisor 持有 Activation：合法 manifest 与执行兼容分别校验，不兼容保留安装意图；加载/激活/内部贡献/清理有界，退休撤销公开 API 并通知 AbortSignal。Manager 不得认领内建实例。可信 module-url 安装固定自包含 ESM 与 SHA-256，产物独立持久化，恢复不联网替换版本；显式更新成功后切换安装指针，失败保留旧版本。公开契约、作用域及未建设的生态能力见 [Extension Platform](../../../opencraft/docs/plugin-architecture.md)。
- OpenCraft Electron 原生窗口与 Renderer Shell 共享同一份窗口几何：当前最小宽度为 480px，由 `workbench-runtime` 统一投影到 BrowserWindow 限制与 Shell 降级阈值。宽度压力下先收敛侧栏、上下文与详情面板，保留用户偏好；路由顶栏内容须在窄态滚动或折叠，不得用业务页私有最小宽度重新撑宽窗口。
- OpenCraft Sidebar Activity 把 `executionOwner` 与 Thread 状态分开：Thread/Conversation binding 持有 hostId，Host Directory 提供 kind/label，Sidebar 为远程 Host 投影按 hostId 稳定着色的地球。本机默认省略来源图标；改名、断线、重连、引擎或运行状态不得改变该身份颜色。运行/待审/错误/未读使用相邻独立状态槽，颜色不作为唯一身份信号。
- OpenCraft Web 发布器以 Vite manifest 判定构建所有权：manifest 引用的 `assets/**` 必须内容寻址并按 immutable 追加；Vite 从 `public/` 原样复制的非哈希资源即使位于 `assets/**`，仍按可重验证公共文件原子覆盖。发布入口只能在两类资源全部落盘后切换。
- OpenCraft 的 `headless-linux-amd64-tar` 是独立单用户服务器制品：Node 启动器在私有数据根下持有唯一 Local Agent Host，托管同源 WebUI 并把 `/appserver` 转发给本机 DSH；同源 `/apphost` 通过租约和代次连接 Server 拥有的 Codex stdio adapter，不让浏览器持有 Codex 凭据。Web 模型服务与 Codex 账户页复用 Host 配置能力，不另建浏览器配置真源。默认仅监听 loopback，远端浏览器须通过受控隧道。显式危险模式允许主体直接绑定 `0.0.0.0:80`，静态 WebUI、`/appserver`、`/apphost` 共用端口，公开模式不检查 HTTP 或 WebSocket Origin；仓库 Linux 安装脚本只负责校验 tar 和安装常驻 systemd unit，不套 Nginx；特权端口仅授予 `CAP_NET_BIND_SERVICE`，也不提供 TLS 或访问控制。任何可达客户端都会共享该 Host 的账户和执行权，绝非多租户或安全公网模式。脚本不得自动停掉现有预览、覆盖持久状态或把旧 tar 当作新构建。此包不包含 Electron Main/Preload，不提供多租户 Hub 或公开服务鉴权；不能把静态网页可访问或 tar 生成等同于 Linux 原生执行验收。详见 [OpenCraft Build Matrix](../../../opencraft/docs/build-matrix.md#headless-linux-server-archive)。
- OpenCraft Codex 排队消息由 Daemon Host 的私有 SQLite 唯一持有，Codex AppServer 只执行标准 `turn/start`/`turn/steer`。Host 先持久认领再投递；明确拒绝才放回队列，超时/断线一律保留未确认认领并阻止后续自动派发。Host 以 Codex 历史 user-message client ID 对账，确认丢弃前要求空闲 Thread、匹配目标和成功的历史核查；丢弃不等于证明模型未见消息。旧原生队列在物理 AppServer 启动前迁移，冲突或坏数据失败关闭。`atomicSteer`/`unconfirmedSteerDiscard` 来自 Host 实现，不依赖 Codex 二进制补丁；Headless 只打包官方 Codex。DSH 的 Host/原生队列路径独立，不继承 Codex 的恢复能力。单数据目录仍只允许一个物理 AppServer/Host owner。详见 [OpenCraft 平台架构](../../../opencraft/docs/platform-architecture.md)。
- OpenCraft Headless Web 的 `/apphost` 连接诊断按物理连接生成随机 attempt ID；浏览器失败报告与服务端升级、hello、Host 认领、心跳和关闭事件以该 ID 对账，只记录阶段、数值关闭码、耗时与并发连接数，不记录会话内容、URL、凭据、Origin、IP 或原始异常。浏览器 WebSocket `error` 不提供握手 HTTP 状态，因此诊断用于定位失败层，不把通用“connection failed”当作多客户端被拒绝的证据；它不改变 Client/Host/Thread 所有权或重试策略。详见 [OpenCraft 平台架构](../../../opencraft/docs/platform-architecture.md)。
- OpenCraft 的客户端 Turn、queue、steer、工具活动和滚动投影遵循 Codex 生命周期；Hermes 事件游标、durable history 与投影状态遵循 Hermes Desktop 生命周期。断线恢复不得只保留 replay 游标却重建空投影状态。
- OpenCraft 的 Hermes 工具完成状态只能来自明确结果证据：终端退出、结构化结果或后端失败。Turn 完成本身不得制造工具成功；后台命令保留运行中进程句柄，缺失结果保持未确认。实时与历史恢复必须复用同一工具身份和终态归并规则。
- AppServer 传输失败必须保留结构化恢复策略。瞬态失败可由既有策略重连；远端资源已删除等不可恢复错误标记为手动恢复，Workbench 不得自动重建同一失效传输并形成重连循环。
- Web 与 Expo 的用户消息折叠共享同一领域判定：仅自然内容高度越界后才允许折叠，裁剪后的视觉高度不能撤销已确认判定；原生测量按内容、宽度代次、节点及生命周期隔离。Turn 定位保留语义目标，先确认当前投影与实测布局，远处目标以额外有界窗口测量；原生动画期间的布局变化重新计算目标。几何事实由唯一 viewport owner 发布，不能另建客户端滚动状态或把位置校正当作执行请求重投。详见 [ChatUI 滚动与定位契约](../../../opencraft/docs/chat-ui-architecture.md#跨桌面手机和平板的会话连续性)。
- Workbench 的 Host Catalog readiness 由 Host runtime 状态转换驱动：失败/重连后的首次 `ready` 必须主动重载 Thread Catalog，不依赖用户再次发送消息；订阅时已经处于 `ready` 不得制造重复重载。浏览器 BFCache 的 persisted `pagehide` 必须保留应用所有权图，仅真正离开页面时才 dispose。
- VelaGW 执行 NewAPI 控制面写操作时，单次操作内复用一个临时管理员登录 session，并在成功或失败后主动注销；不得把短期登录 session 当作持久管理凭据，也不得让周期性配置收敛持续消耗 NewAPI 活跃 session 配额。
- DesiredConfig 导出读取渠道明文 Key 时同样必须创建一次临时管理员登录 session、完成 2FA，并在完整快照成功或失败后注销；不得使用 Set 中持久化的历史 access token 执行 `/api/verify`。
- VelaGW 读取固定版 NewAPI 的渠道明文 Key 时，必须用 `scope=channel.key.read` 签发短期 Security Proof，并在后续 Key 请求中携带 `X-Security-Proof`；登录 access token、2FA 登录状态或历史 session cookie 都不能替代该作用域凭据。
- VelaGW 更新 NewAPI 渠道内容时不得携带 `status` 字段；渠道启停由独立状态接口负责，避免内容 Upsert 越过 NewAPI 的状态管理边界。
- VelaGW 生产 control、traffic 与 worker 只能访问与具体 Set ID 匹配的受管 Kubernetes
  `newapi-admin` / `newapi-traffic` Service（以及同 Set ID 的历史 `newapi` Admin Service），协议固定为
  `http`、端口固定为 `3000`。手工注册、Fleet
  facts、资源修改、Redis 路由快照、数据库旧值和 HTTP 重定向必须经过同一 URL policy；IP 字面量、
  外部域名、其他集群 Service、userinfo、任意路径、query、fragment 和跨源重定向全部 fail-closed。
- VelaGW 公网 control、traffic 与 all-in-one HTTP listener 必须对 `/metrics` 稳定返回 404，不能暴露
  Set、Shard、租户 Key 标识、升级状态或流量错误标签。指标可以继续在进程内聚合；如需 Prometheus
  抓取，必须新增独立的内部监听端口和 ClusterIP Service，不得复用公网 CLB listener。
- VelaGW `upstream_roundtrip_error` 的 502 是代理尝试写出的状态，不证明客户端实际收到 502，也不证明 NewAPI 或模型渠道返回 5xx。失败访问日志只记录固定分类的代理错误、请求上下文取消状态、入站 body 已读字节、声明长度和累计读取等待耗时；不得记录原始错误文本、请求体或凭据。上游分段耗时从代理调用 RoundTrip 起算：`upstream_roundtrip_ms` 记录返回或失败，收到最终响应头才有 `upstream_response_header_ms`，实际读到首个响应体字节才有 `upstream_first_byte_ms`；发生平台凭据 fallback 时这些耗时覆盖两次尝试。首个响应体字节不等于首个模型 token，进入 RoundTrip 也不证明请求已经送达上游。结合这些字段区分下游先断开与上游传输失败，不能仅凭 `unexpected EOF` 给某一跳定责。
- VelaGW 镜像 promote 默认只能改动目标环境的 `VELAGW_IMAGE` 与 `VELAGW_DEPLOYED_AT`。如果投影同时改变 NewAPI release pin、Kustomize 结构或其他 deploy-facing 配置，发布必须关闭自动合并与自动同步，先把目标配置回填到 `master` 真源并重新生成候选。
- 大体积救援导出由 VM 流式生成归档并使用 COS Multipart Upload，不能先把完整归档写入救援系统盘，也不能退回未知长度的单次 `PUT Object`。
- 腾讯云永久密钥只存在于 Worker runtime Secret。救援 VM 只接收短期、精确到目标对象且仅允许上传 Part 与 Complete 的 STS 凭据；STS 和含凭据的 TAT 脚本不得进入 Temporal Workflow History。
- Workflow 必须在提交 TAT 前持有 Multipart Upload ID。TAT 提交、上传或结果确认失败时，通过 disconnected cleanup context 执行 Abort 并删除可能已经 Complete 的残留对象。
- 修改救援 Workflow 的 Activity 序列时使用 Temporal version marker 保证旧 History 继续 replay，不能让存量执行产生 nondeterminism。
- `ctl.user_subscription_gateway` 是已分配用户的网关归属真源；Pass 续费只延长当前归属网关的权益，不隐式迁移网关。active Pass 续费完成前必须确保套餐权益存在：VelaGW 使用稳定幂等键和唯一订阅语义直接补齐，旧 AI-Gateway 则先探测 active subscription，仅在明确缺失时补建；探测失败必须保持任务可重试，不能用补建覆盖未知状态的旧订阅。
- CTL 的 `IsolatePass` 父任务按当前 `instance_id` 收敛隔离子任务。同一实例重派产生多条历史记录时，任一 `SUCCESS` 覆盖该实例的历史 `FAILED`；`CREATED/RUNNING` 阻止重复派发，仅有失败记录时才重派。父任务不得按历史失败行数阻塞，且只有当前非终态实例全部成功后，才能继续撤销模型权益、隔离站点并将 Pass 推进为 `isolated`。
- VelaGW 中套餐、免费积分与独立购买的积分包是可并存的订阅。Pass 到期清理只能按名称前缀删除 `package:`、`free-credit:` 及历史空名称套餐订阅，必须保留 `credit-package:`；单个积分包退款或隔离则按完整订阅名删除目标订阅，不得清理 Pass 周期元数据或其他积分包。旧 AI-Gateway 不具备定向删除能力，仍沿用用户级全量取消语义。
- 邀请返利复用 `free-credit:referral:*` named subscription，但发放权在 Referral 状态机，CTL 提供强鉴权
  的幂等送积分包装。调用方只传积分额度和资格标识，不传 Plan ID；CTL 将积分换算成 token，
  VelaGW 自动确保 `never` reset 的内部权益模板，并在其同步到全部 active Set 后发放。包装在调用 VelaGW 前
  同时校验受益人有 active Pass，以及返利资格 Pass 仍归属被邀请人、active 且未过期；资格参数必须成对提供。
- 北京和上海 Referral 分别使用独立 campaign、Pulsar topic token、预算和运行开关；启用上海 worker
  只消费上海 Auth/CTL outbox 事件，并通过上述 CTL 包装发放 named subscription。该链路不修改用户的
  `ctl.user_subscription_gateway` 归属，不切换 Bot provider、模型或 Agent 请求路径，也不为旧 AI-Gateway
  增加等价的定向积分能力；失败由 Referral 状态机保持可重试，不得绕过 CTL 直接写 VelaGW。
- CTL Referral relay 的环境变量必须合并到 `ctl-api` Deployment 中既有的 `api` 容器；不得按 Deployment
  名称新增第二个容器，也不得丢失原容器的镜像、挂载、探针或资源限制。
- 运行中实例从 `ai_gateway` 迁移到 VelaGW 必须同时完成权益补发、固定用途 Key 签发、Hermes Provider 切换、实例 Key ID 持久化和旧 Key 撤销。该操作只通过强鉴权内部接口按 `user_id + instance_id` 执行，默认先 dry-run；用户存在多个非终态 Bot 时拒绝迁移，避免用户级网关路由产生半迁移。
- 迁移采用可重入、最终一致语义：用户、订阅和固定用途 Key 均幂等复用，Hermes 配置可重复收敛，路由和实例 Key ID 可重复写入；任一步失败后允许从头重试，不引入跨服务伪事务。
- VelaGW 人工额度重置只能调用用户加 Plan 维度的接口，并固定保留自然重置时间；禁止用 Plan 全量重置接口代替单用户操作。CTL 对该能力提供用户级包装，隐藏 Set、上游用户和 new-api Plan ID。目标必须来自唯一有效、可周期重置的 Pass 基础订阅（`package:` 或满足周期与 Plan 映射校验的无名称旧订阅），不能用会被积分包购买覆盖的 `last_plan_id` 推断；`credit-package:` 和 `free-credit:` 叠加订阅不参与重置。由于现有 new-api 接口会清零该用户同 Plan 的所有有效订阅，CTL 在调用前还必须确认目标 Plan 下恰好只有目标一条有效订阅；同 Plan 叠加订阅、多个基础订阅或未知订阅类型均拒绝，不能靠响应的重置数量事后补救。此预检不能消除跨服务并发窗口，要求严格单订阅原子重置时需扩展 new-api 契约。
- CTL 的批量人工额度脚本只编排上述单用户接口：目标来自显式用户清单或 Running Bot owner 去重列表，默认 dry-run，实际重置须额外确认；`limit=all` 只解除单轮人数上限，不循环重复清零。生产批次须冻结用户清单，不能仅凭动态列表中的下一个 UID 续跑。每个环境使用独立的 0600 checkpoint，逐用户预检，发出写请求前持久化 `inflight`，结果不明时停止并人工对账而不自动重投。要求暂缓积分包用户的批次还须读取 LLMGateway 活跃订阅，跳过 `credit-package:` 与 `free-credit:` 并把 UID 单独记录在 0600 文件，无法确认订阅状态时停止。若预检被已知的 Pass 状态守卫（如 `PASS_ISOLATING`）拒绝，可把 UID 作为未重置项另行记录并继续；未知 403 或写入结果不明仍须停机，不能把跳过计作清零成功。脚本经 kubeconfig 建立本机 port-forward，不用会影响 CTL Bearer 转发的 `kubectl proxy`；详见 [`ctl/scripts/README-gateway-quota-reset.md`](../../../ctl/scripts/README-gateway-quota-reset.md)。
- `gateway-dashboard` 只能通过服务端 BFF 调用迁移和额度重置，两个操作均先 dry-run 并要求完整用户 ID 二次确认；`CTL_INTERNAL_TOKEN` 不得进入浏览器。

- OpenCraft 两版旧模型设置界面已移除。新 LobeChat 风格模型服务页已按用户确认设计接入 DSH，提供商与模型目录来源于运行时；发现模型的保存与初始禁用属于同一次 CAS，不隐式切换默认模型。输入合并保存保留原始配置版本，文本检查只使用用户新输入的 Key。
- DSH 是执行引擎，不给予 DeepSeek 提供商特殊管理地位。原生 DeepSeek 与其他提供商共享真实启停与默认模型保护；停用释放路由、保留配置和凭据，并在重启后保持。补丁仅扩展固定版本适配器的生命周期，不改协议实现或自动迁移用户默认模型。
- Settings Shell 承载本机模型服务的分类入口与 master-detail 容器；模型服务内部目录按实际容器空间适配。该呈现不建立环境面包屑、概览或连接管理页，不改变 Chat location；原生启用生命周期或协议不支持的操作不伪装成可用控件。

## 云桌面（CTL Desktop）provision 语义

- 桌面恢复预览只保存客户端内存中的一张受限 JPEG；新观看 attachment 完成授权并匹配原会话/主体/资源/实例后才可呈现。图片没有输入能力，不替代实时首帧或后端控制授权；身份替换、授权拒绝及销毁清除复用资格，缓存不写磁盘、不跨 View 共享。归属与淡入行为见 [桌面呈现](../../../opencraft/docs/cloud-desktop-plugin.md#panel-presentation)。

- OpenCraft 富桌面的状态/接管意图仍由通用插件 controller 持有，媒体尺寸来自当前连接；共享设计系统只投影局部语言文案的自然宽度、分档衔接曲线和阴影层过渡。等待期间保留取消动作与稳定几何，已确认接管才应用底部连接形态；视觉过渡不延迟撤销输入，不建立第二份授权状态。详见 [面板呈现](../../../opencraft/docs/cloud-desktop-plugin.md#panel-presentation)。

- 桌面观看就绪必须来自实际媒体绘制，不是握手、资源 prepared 或 socket open。通用插件持有分阶段有界等待与安全原因分类，用户界面只呈现简短任务文案；输入焦点与剪贴板传输受同一有效控制授权约束，取消/撤销/重连隔离迟到读取。解码器固定版本公共事件补丁须在安装时核验摘要与完整替换，不能用任意延时或读取私有字段掩盖首帧问题。详情与真实/合成验收边界见 [桌面契约](../../../opencraft/docs/cloud-desktop-plugin.md#focus-clipboard-and-diagnostics)；当前本机仍为后端不可变只读，未增加原生控制执行器或公网授权。

- OpenCraft 桌面观看与远端资源分开：Sandbox 的授权 [viewer broker](../../../sandbox/docs/desktop-viewer-broker.md) 使用一次性、主体与物理绑定固定的短凭证和独立 WSS；通用桌面插件拥有媒体/确认式控制协议，Vela 插件拥有账号与产品绑定。Provider 的 verified observer 经独立回环代理校验实际 Xvfb/x11vnc、socket 归属与每连接 root-key 挑战，不提供控制；新 resource 准备才启动它，旧四 unit provision 不变。Handler 尚未挂载公共路由，生产会话权威目录与原生控制执行器仍未接入；CTL 只有用户/实例/Sandbox DAO，不能把客户端 Server 投影、模拟 grant、CTL prepared 或前端 viewOnly 当成会话/输入授权。

- 桌面 provision/probe/install 脚本与上层判定之间以 stdout marker 传递状态（`DESKTOP_LAYER_MISSING`、`DESKTOP_PROBE_OK`/`DESKTOP_PROBE_PENDING`、`DESKTOP_PROVISION_FAILED`、install STARTED/进度/DONE/FAIL）。provision 脚本不得使用 errexit 选项：PTY 流式执行下检测行里 `systemctl` 等非零返回会污染会话最终退出码，导致上层误判命令失败、永远走不到按需安装分支（现网 bj-7 复现）。上层判定顺序必须是 marker 优先于 `sandboxCommandSucceeded`：stdout 含 `DESKTOP_LAYER_MISSING` 时无论退出码一律触发按需安装；只有图形层缺失（Missing）和探测未就绪（Pending）是正常业务信号可返回成功——密码写入、服务启动等关键步骤失败必须输出 `DESKTOP_PROVISION_FAILED <reason>` 并 exit 非零，不得用 `|| true` 吞掉，否则会被当成 Pending 反复轮询、永久卡 Provisioning 且无可见原因（旧 noVNC 甚至可能误报 Ready）。
- 桌面 systemd units（`vela-xvfb`/`vela-desktop-wm`/`vela-x11vnc`/`vela-novnc`）以 agent 运行用户（`agentuser`）运行：镜像预装（`images/build.sh --with-desktop`）与按需安装（`renderDesktopInstallCommand` 生成的脚本）两套 unit 必须保持一致——`User=agentuser`、显式注入 `HOME` 与 `DISPLAY=:1`、WM 用 `dbus-run-session` 包裹 `startxfce4`、`Requires/After` 补齐依赖链、`Restart=on-failure`。`images/build.sh --with-desktop` 在 `install_desktop_layer` 入口强制校验 `RUNTIME_USER` 必须与 CTL 契约（`desktopRuntimeUser=agentuser`）一致，不一致直接失败；这防止 openclaw 默认 `lightclaw` 用户跑 `--with-desktop` 生成错配镜像（unit 属 lightclaw 而 CTL 往 agentuser home 写密码，导致 x11vnc 读不到密码、桌面起不来且无报错）。不允许回退为 root 会话：root 会话会造成"桌面里创建的文件属主 root、agent 读不了"的错配，并放大公网 noVNC 暴露 root 的风险。
- 按需安装只将包选择交给发行版分支：Ubuntu/Debian 保留 apt；`ID=tencentos` 且 `VERSION_ID=4.4` 使用 dnf 和目标配置的 BaseOS/AppStream/EPOL 原生包，不从 `ID_LIKE` 推断兼容性、不安装第三方仓库、不关闭 SELinux/防火墙。安装前验证非交互 sudo、运行中的 systemd、既有非 root agentuser 与 `/home/agentuser`；安装后核验 unit 使用的二进制和 noVNC 静态资源。包安装、unit 写入、daemon-reload 任一步失败均写 FAIL、不得写 DONE。镜像构建仍为 Ubuntu 专用；包查询和模拟测试不替代真机安装/连接验收。依赖和验收见 [云桌面验证文档](../../../ctl/docs/cloud-desktop-vnc-verification.md#腾讯-os-44-按需安装前提)。
- 品牌壁纸采用"随镜像打包"方式预置：壁纸文件由 `images/build.sh` 打进镜像，不在 provision/install 脚本中网络下发；脚本只负责激活桌面环境。

## 定时任务执行模式

- 单次任务的执行时间输入按年、月、日、小时、分钟拆成独立数字段，点击或聚焦某一段只编辑该段，焦点离开整个控件时统一校验并规范化；也可在同一个受控 Popover 中编辑日期、小时和分钟。选择过程只更新草稿，取消或 Escape 不提交，最终仍输出 `YYYY-MM-DDTHH:mm`，不得改变 Hermes 的本地时间解析语义。
- 定时任务分为 Agent 任务与 0 Token 任务。Agent 任务沿用 Hermes 的 prompt、Skill 和模型推理链路；0 Token 任务必须映射到 Hermes `no_agent` 脚本执行链路，不得注入 prompt、Skill、模型或失败后模型兜底。
- 0 Token 任务包含固定通知与脚本任务。固定通知由控制台生成并托管脚本；脚本任务执行用户提供的 Bash 或 Python，标准输出按原文进入既有通知渠道，空标准输出保持静默，非零退出、超时等运行失败按现有告警能力处理。
- 控制台只允许编辑自身带版本标记和元数据的托管脚本。外部创建的 `no_agent` 任务可以展示和管理调度，但脚本内容默认只读，删除 Cron 时不得推断并删除不属于 LightVela 的文件。
- 脚本在 Agent/Hermes 主机上以运行时用户身份执行，不提供独立安全沙箱。产品界面必须在创建或测试脚本任务前明确提示该边界。
- 0 Token 创建入口由前端默认开启，不依赖 CTL 下发功能开关；远端运行时配置不可用或未包含对应字段时仍保持开启。显式的构建期关闭、本地紧急关闭或远端布尔 `false` 只阻止新建 0 Token 任务，不隐藏或阻断已存在任务的查看、编辑调度和删除。正式开放前还必须确认目标 Hermes 镜像包含与产品约定一致的 `no_agent` 能力。

## 实例内多 Bot 与 Hermes Profile

- OpenCraft 建立统一异步 `UiPreferencesRuntime`：每个 key 声明 schema、默认值和 `installation/account/workspace` scope，React 不得直接选择 localStorage、IndexedDB、SQLite 或 HTTP/AppServer。第一期 Web installation adapter 使用 IndexedDB；Electron 随机 loopback 端口导致 Renderer IndexedDB 无法跨启动复用，因此由 Main profile SQLite 通过受限 preload bridge 持有。Applications Pin 默认 false；Applications/Account Pin、detent、导航 rail width 与左侧上下文侧栏 width 均由该 Runtime 持久化，历史自动写入的 `applications: true` 不作为用户意图迁移。account/workspace 只保留 revision/CAS adapter 边界，真实 authority 未建设前不得伪实现。
- OpenCraft Cloud Storage 使用 `codex/chat-demo-v2` 的独立管理页结构：匿名状态在稳定的页面标题和内容区内呈现完整站点选择、登录、等待/取消与错误反馈，不再用一行 notice 接管空白页面；认证且存在 active Bot 后原位挂载既有 TAT 文件管理器。本页面不伪造本机存储能力。Skills 不是已安装项管理页，而是同分支的完整技能工作台：公开发现保持匿名，安装目标选择器在 Electron 的本机 DSH 与已连接的 Hermes Profiles 之间切换 installed state 和 mutation owner；Experts/学习所需的云端运行操作仍和安装目标分开建模。OpenCraft 独立 Skills 路由从市场标签直接开始内容，不叠加外层 `Skills` 页头，也关闭共享面板可选的 `技能` 标题/说明块；目标选择器作为标签行紧凑操作，不展示本机文件系统路径。共享 mono2 面板在其他消费者中默认保留标题。Skills contribution 声明 `edge-to-edge`，由 Settings Shell 统一移除 document wrapper；页面自身只保留一个 panel inset，不能叠加 Shell toolbar、Settings padding 和业务页 padding。
- OpenCraft release 使用标准 Oxc minify 和内容哈希，不再启用 ultra 顶层改名、多轮 aggressive compress 或 Electron Main/Preload/Daemon 的 high-obfuscation 二次处理。该选择保持发布体积优化，但以 Renderer/App Host 语义正确性和可诊断性为先；公开发布树仍排除 source map。
- Bot 产品表面暂时归入 OpenCraft 设备本地内部开发者模式：普通模式不投影 Bots 应用、Bot 侧栏实体、创建入口或 Bot 会话 View；开启开发者模式后统一恢复，关闭时活跃 Bot 深链回退到普通 Chat。该门禁只负责呈现，不卸载扩展、不删除目录/会话数据，也不替代 AppServer 与控制面的权限校验。
- 最新Hermes Hosted Room通过`groups.*` RPC桥接OpenCraft group Bot conversation。Room ID、authority gateway/epoch和事件seq分别拥有会话身份、唯一写权和增量游标；OpenCraft仅投影消息、执行、presence与interaction。能力探测失败降级direct-only，不得清空Bot或模型目录。协议v1 roster冻结，只在创建时选择2–6 Bot，不声明成员修改；跨Gateway复制/接管留在Adapter内部。
- Direct Bot 与 Hosted Room 共用 Bridge 拥有的受控执行错误分类，投影到既有 AppServer `execution.error`。Hosted Room 的 `turn.failed` 属于成员执行的持久终态，不伪造 Bot 聊天消息；客户端历史恢复与增量事件使用同一执行行。已确认的余额/额度失败（包括 provider `402`/`401008`、billing reason 以及 `HTTP 403: 用户额度不足`）统一投影为 quota 类别，并优先于通用 `403` 凭据分类。原始 provider stderr 不进入可见消息或客户端持久投影；其他成员尚未产生终态时不能因一个成员失败而冒充全房间结束。
- OpenCraft Electron 内部开发者模式可查看当前应用 profile 下由 local-agent-host 拥有的四个 SQLite：会话路由、历史索引、线程目录和执行租约。该能力只用于本机 Debug：Main 固定目录和文件名，以 SQLite `readOnly` 与 `query_only` 打开，仅返回数据库元数据、表结构和有上限的分页行；Renderer 不能传路径或 SQL，也没有修改、导入、导出、删除操作。开发者模式只控制入口可见性，不替代 Main 的数据边界。
- Workbench 的 5 次 Escape 手势切换当前浏览器 session 的内部开发者模式；Plugins、Laboratory 与 Electron SQLite inspector 仅在该模式显示。再次触发会关闭模式、移除这些入口，并把正在显示的内部专用路由收敛回 Appearance。
- Hermes Composer目录必须同时实现`agent/list`与`model/list`。Agent条目的modelIds消费Hermes model.options目录；旧Gateway或协商失败时agent/list返回空页，不能抛错导致联合查询丢弃已成功模型页。
- Composer模型选择属于Host能力作用域。Hermes Adapter在`config.set`前用当前Thread的`model.options`校验选择；外部/旧provider ID仅当同名模型在当前目录有唯一owner时动态重绑定，否则按未显式选择处理。`config.set(model)`是RPC文本协议，其parser按空白切词而非shell解析；模型和provider token不得添加shell引号，只接受无空白且非flag形态的目录ID。

- OpenCraft 的 Hermes 多 Profile Bot 接入复用 `vela/bot-conversations` AppServer 扩展。
  一个 Host 仍绑定一个物理实例；提供方读取该实例 `/bots` 并和原生 `profiles.list`
  求交集，显式绑定产品 Bot ID 与原生 Profile（`main → default`），不从显示名猜路由。
  目录、选择、恢复、发送和取消共用这份身份；会话和执行归属不得跨 Bot 转移。
  只在两侧能力检查成功后声明扩展，明确的缺失接口降级不影响普通 Host；认证、网络或
  非法目录失败不能伪造默认 Bot。Bots应用提供创建、克隆、重命名与删除，Host声明管理能力，
  单Bot声明rename/clone/delete资格；默认Bot不能单独删除。管理走实例控制面API，
  bot/create的templateId表示精确来源Bot，缺省走blank；沿用控制面的clone配置清理规则。
  Host持有创建意图回执，未知POST结果不自动重发；断开、账号更换、目录刷新均不能复活旧结果。
  删除通知撤销目录资格及打开会话的发送能力。CTL目前无跨客户端CAS，适配层仅承诺新鲜检查和Host内串行写入。
  客户端只消费 typed Bot 目录，原生 profile 路由不进入 React。
  Mac账号IPC精确允许实例Bot集合GET/POST及单Bot PUT/DELETE，并校验blank/clone/name载荷、区域和来源身份；
  主进程保留安全的校验/网络/超时解释，不把所有拒绝压成同一错误，也不泄露URL、凭据或响应体。
  验证范围见 [Hermes Bot 接入计划](../../../opencraft/design/hermes-profile-bots/task_plan.md)。
- OpenCraft Bots应用不提供实例选择器。管理目标只来自启用的`lightvela.hermes` Host：唯一云端实例直接使用；多个云端实例仅在其中恰好一个已声明管理能力时解析，否则显示歧义状态。Local、DSH及其他Host不能成为Bot创建目标。
- Bot 的默认模型归属 Hermes Profile，不归属 CTL Bot 管理接口或当前会话 Composer。最新 Hermes Host 的 Bot `configuration` 能力映射 `profiles.describe`、Profile 作用域的 `model.options` 与 `profiles.configure`；当前配置由 `bot/configuration/read` 快速读取，可选目录由 `bot/configuration/options` 独立加载，目录发现不得阻塞表单编辑或保存。`model.options` 超过有界等待时降级手动输入，不能把慢目录误呈现为权限禁用。客户端通过 `bot/configuration/update` 写入明确的 `provider + model`，不得回传凭据。更新必须以 Bot revision 防并发覆盖，并将产品 Bot ID 精确解析为原生 Profile；`confirm_required` 表示尚未写入，只有用户再次确认后才能携带 `confirm_expensive_model` 重发模型段。名称、克隆和删除继续由实例控制面拥有，模型配置不得混入其 PUT 载荷。
- Bots页面将云端Host连接与Bot目录刷新合成15秒交互事务。Transport投影确认Agent、TAT会话、Hermes Dashboard和AppServer阶段，目录阶段提供独立原因；任一阶段超时后释放加载态并展示最后已知阶段及后台任务提示。物理连接Promise和目录请求继续由原owner持有，稍后成功时通过订阅更新，页面不得另起连接或永久保持busy。
- Bots View首次解析出唯一云端Hermes Host时自动触发一次连接与目录刷新；页面没有“连接”按钮。用户看到列表、加载状态或带原因的失败状态，重试复用通用刷新动作。
- Bot控制面请求的`route_not_allowed`是部署缺口，应立即结束加载并向用户投影通用内部错误；具体代码留在诊断对象。HTTP 404/405不得被解释为Hermes运行时不支持，只有原生Profile RPC明确返回method-not-found时才省略Bot能力。
- Hermes canonical `Bot Chat`的Gateway身份可早于Dashboard历史物化。Gateway Resume成功后，历史接口的Session/Conversation-not-found语义表示当前没有可读持久历史；Dashboard可能以HTTP 404或HTTP 200错误信封承载该语义，不得用传输状态推导所有权。Gateway `message_count`不是Dashboard持久行数，不能作为此回退门槛；live/inflight继续由Resume投影。普通会话及其他错误不得被吞掉。

- Electron工作台由私有loopback静态origin承载，构建资源URL从origin根解析；
  `/views/:id`、`/settings/:id`深层页面刷新仍请求根`/assets/`。
  包的文件系统位置可迁移，不意味着资源应按当前页面目录相对解析。

- `shared/lightvela-agent-core` 是 mono2 中立的 Agent 管理业务内核，mono Web 为
  首个消费者。当前统一 Bot/Instance/Profile 身份、生命周期归一化、确定性
  Catalog 投影，以及首台实例/额外 Bot 的创建目标与 blank/clone 意图；不改变
  CTL/Hermes endpoint、请求字段、创建/删除语义或服务端权威。额外 Bot 只能选择
  归一化为 Running 的实例，不能按实例计数或缓存首项推断 readiness。该 core 禁止 React、路由、i18n、
  网络、存储与埋点依赖，后续由 Web CTL adapter、OpenCraft AppServer adapter
  和 native adapter 分别注入。同一 Catalog 内以 instance/Bot/Profile 三元组
  作为长度编码身份键，跨实例同名 Profile 不得合并；环境/账户作用域由上层目录
  添加。旧 Context/Repository 保留兼容门面直至消费者迁完。

- 诊断中心日志查询、导出和模型配置重置显式选择当前 Bot 的原生 Profile；切换 Bot 后不得复用旧日志或配置状态。命名 Bot 缺少后端返回的 `profile_id` 时，日志查询和导出同样必须禁用，不得回退主 Profile 读取。会话修复属于 Profile 级写操作：主 Bot 缺少公开 Profile 时可映射原生 `default`，命名 Bot 缺少 `profile_id` 时必须禁用且不得回退主 Profile。会话修复与实例级备份、恢复、模型配置重置和运行环境重置采用双向互斥；任一操作运行时，其他入口必须禁用，禁止并发写入 `state.db` 或同时重置运行环境。每次修复使用独立 pending key，父级按实例累计未完成请求；Bot/Profile 切换只重置当前卡片状态，真实请求完成前不得释放实例维护锁。每次执行使用独立请求代次，Bot/Profile 切换须使旧代次失效，迟到结果不得结束或提示后续修复。OpenCraft 消费该诊断页面的生成副本时，必须由同步脚本复制前端真源并记录对应 `sourceRevision`，不得在生成副本中独立修改维护互斥语义。LLMGateway 重置按用户级 `purpose=default` 幂等读取平台权威 Key 和最新默认模型，只重建目标 Profile，不修改同实例其他 Profile；Key 通过一次性加密 envelope 下发，配置、凭据清理和 read-back 校验失败时回滚。旧 ai-gateway 仍只允许单一根 Profile，CTL 在签发或撤销实例 Key 前重新读取完整 Profile 列表并 fail closed。
- CTL 的 envd 同步与流式 `debug/exec` 共用用户切换包装：先选择直接运行或 `sudo` 启动器，再只附加一次完整脚本，保留运行用户、环境和退出码。不得在两个分支中重复嵌入模型配置等长脚本，避免包装本身放大 `bash -c` 单参数长度；原脚本及其 shell 引号转义后仍须满足运行系统的参数限制。TAT 路径不使用该包装。
- 重装、备份与恢复属于整个 Agent 的维护操作，仅在主 Bot 展示入口，并明确影响所有 Bot。前端进度、控制台与操作锁按实例隔离，同一实例内切换 Bot 不丢失状态。恢复显式使用 `/home/agentuser/.hermes` 与原生 `default`，不依赖运行时当前选中的 Profile；完整多 Profile 恢复仍需在隔离实例做兼容性验收。

- 当前发布批次隐藏已有 Agent 的“新建 Bot”入口，保留已存在 Bot 的切换、配置和删除，以及无实例用户的首次 Agent 创建流程；后续开放须另行确认。
- LightVela 的 `instance_id` 负责资源与归属，产品 Bot 是 Hermes Profile 的控制台投影。命名 Bot 的 `bot_id` 与 `profile_id` 使用同一 Hermes Profile ID；默认 Bot 为兼容存量前端保留实例 ID 作为 `bot_id`，公开 `profile_id` 为 `main`。
- CTL 不持久化 Bot/Profile 映射，也不为多 Bot 新增数据库结构。Bot 列表、名称和描述通过 Hermes 官方 `GET /api/profiles` 管理接口读取；CTL 在 Hermes 进程内以 ASGI transport 调用该路由，不额外启动 `hermes serve`。接口内部扫描 Profile 目录及其 `profile.yaml`；模型、Skills、Memory、SOUL、会话、Cron 和渠道运行态同样以对应 Profile 为真源。
- 每个存量实例幂等拥有一个不能作为 Profile 单独删除的默认 Bot，公开 `profile_id` 为 `main`。`main` 始终解析到原 `$HERMES_HOME`，不得创建命名 `profiles/main` 或迁移根 Profile 数据。Hermes 内部根 Profile ID `default` 不得作为产品展示名；根 Profile 没有显式名称或存量实例名称时，由客户端使用本地化默认名称，命名 Profile 才可使用 Profile ID 作为名称兜底。实例内只剩默认 Bot 时，产品删除动作销毁整个 Agent 实例；存在其他命名 Bot 时必须先逐一删除。
- Provider、模型、通道、Gateway、Skills、自动任务、Memory、User Profile 和 SOUL 等 Profile 级操作必须携带后端返回的 `profile_id`；bootstrap、升级、重装、实例健康、资源、账单和套餐仍按 `instance_id` 执行。产品/API 层默认 Bot 的公开标识保持 `main`，但直接调用原生 Hermes CLI 时必须转换为内建根 Profile `default`；命名 Profile ID 原样透传。
- Home channel 是 Profile 下按平台保存的映射，不是实例全局值。创建或克隆 Bot 默认不复制 Home channel；通道认证同样不得静默共享。
- 通道是否允许多个 Bot 同时连接由 capability 决定。双站微信与国际站 WhatsApp 按实例级唯一资源处理；占用信息分别写入实例 `$HERMES_HOME/.lightvela/channel-bindings/weixin.json` 和 `whatsapp.json`，并通过对应文件锁原子更新。扫码前认领，成功后确认，断开后释放；非占用 Bot 不得覆盖或复用该通道凭据。此约束不判断同一 WhatsApp 号码在其他实例或用户下的连接。
- WhatsApp 的认领返回有时限的 `reservation_id`，新版页面确认或失败回滚必须使用同一租约；回滚只能释放匹配的 `reserved`，不能删除已确认的 `connected`。CTL 按 Hermes Profile 实际运行目录的 `whatsapp/session/creds.json` 校验确认与断开，不能沿用旧的 `platforms/whatsapp` 路径。旧浏览器无 token 确认仅能确认本 Bot 当前认领且凭据已落盘；旧版无请求体 release 仅在已连接凭据确实消失且没有在途扫码/删除时清理，不能凭一次旧请求删除成功连接。旧/新页面经 CTL `debug/exec` 执行的标准 WhatsApp 扫码和删除命令由实例内 `whatsapp-qr.lock` 覆盖实际命令执行期，以阻止同 Bot 旧页面跳过前端认领而并发改写占用。该锁不声称约束任意手工 shell 命令；生产发布须先完成 CTL 滚动与旧请求排空，再发布前端，且新前端仍可能被缓存时不能单独回滚 CTL。
- 命名 Bot 创建前必须同时通过服务端功能开关和目标实例的 Hermes Profile 能力预检。克隆完成后要移除消息通道配置、消息通道环境变量和 Home channel；配置键本就不存在应视为已完成清理，除此之外的清理失败仍须终止并回滚创建，无法证明清理完成时不得把 Bot 标记为可用。
- Profile 创建、更新和删除为同步操作；失败直接返回稳定错误码且不得留下伪 Bot 记录。创建失败时应尽力删除未完成的命名 Profile，后续列表只展示 Hermes 当前真实存在的 Profile。
- 桌面 Bot 管理在 POST/PUT/DELETE 的响应不确定时不得自动重发；如已收到 HTTP 错误响应，可展示状态码与符合稳定错误码格式的上游 code 用于诊断，但不能回显原始服务端错误文本或将 5xx 错认成可安全重试。刷新实例 Bot 列表仍是判断实际结果的必要步骤。
- “空白创建”使用 Hermes 新 Profile 的 bundled Skills 播种能力，再按镜像在根 Profile 中实际保留的 LightVela 精选集收敛；镜像在裁剪后记录基线清单，旧镜像从根 Profile 的 bundled manifest 与实际安装目录推导，不得复制主 Bot 后续安装的 Skills，也不得把完整上游 bundled catalog 暴露为已创建成功的空白 Bot。基线缺失或损坏时创建失败并按现有路径回滚；新 Profile 保留 Hermes bundled manifest，使未入选的技能在后续更新中仍视为有意移除。存量使用 no-skills 创建的 Bot 不自动改变；克隆方式继续复制用户选择的来源 Profile Skills。
- 空白 Profile 创建后，CTL 以根 Profile 的当前主模型为一次性运行快照，只写入该模型、匹配的单个 Provider 配置，以及该 Provider 明确引用且实际存在的凭据或配置环境变量。不得复制 fallback、其他模型/Provider 或完整 `.env`；主 Profile 缺少引用值时不得从其他 Provider 猜测凭据。快照完成后各 Profile 独立演进，修改任一侧不得联动覆盖另一侧。
- Bot 显示名称去除首尾空白后必须包含 1 到 60 个 Unicode 码点；前端创建入口提供同等输入约束，CTL 在创建和重命名时执行最终校验。
- 实例销毁接口默认执行 Bot 数量守卫，不由调用方开关决定，也不接受公开的强制删除参数：销毁前重新读取 Profile 列表，多于一个 Bot 时拒绝。只有在确认实例本身处于非运行状态后，才允许因该列表读取失败而跳过守卫——停止的实例无法提供 Profile 列表，必须保持可删除。实例处于运行状态或状态无法确认时，读取失败一律 fail-closed，不得让一次瞬时故障连带销毁其余 Bot。该守卫是误操作防护，归属校验仍由数据访问层承担。
- 控制台无法证明实例上只有一个 Bot 时，不得据此禁用主 Bot 的删除入口。后端已为非运行实例保留删除通道，前端堵死会让暂停或修复失败的实例失去清理路径，而控制台并不提供启动实例的操作。此时必须在删除确认中区分原因：实例非运行归因为实例未运行，实例运行但 Profile 列表暂时不可用归因为列表不可用，不得把后者提示为需要先启动实例；并沿用输入名称的二次确认，明确告知将一并销毁实例上的全部 Bot 及其数据。
- Bot 的网关运行状态是三态：运行、未运行、未知。Hermes `GET /api/profiles` 未返回该字段，或实例非运行导致只能退回实例投影时，必须端到端保持“未知”，不得在提取、DTO 或客户端任何一层压成“未运行”。只有明确的“未运行”才允许触发面向用户的告警。
- Hermes 的 cron ticker 由 Profile 自身的 gateway 进程承载，未连接消息通道的 Bot 不会常驻该进程。此时定时任务定义写入成功但不会执行，产品必须就地告知该边界，不得让它表现为静默失败；网关恢复后界面状态需随之收敛，不依赖整页刷新。
- 公开 API 使用 `/v1/instances/{instance_id}/bots` 表达实例作用域；新增 method/path 必须同步 `service-gateway` allowlist，并分别验证 CTL 直连与公共入口路由。云桌面会话 `POST/GET /v1/instances/{instance_id}/desktop/session` 已纳入该放行集合：会话复用实例主 sandbox，CTL 经 TAT 拉起桌面服务（脚本内显式 sudo，不走 envd/debug-exec 的用户切换包装），空闲回收只停桌面服务不停主机，`ws_url` 由 CTL 基于 `DESKTOP_INGRESS_DOMAIN` 组装，前端入口由 `CLOUD_DESKTOP_ENABLED` 随 runtime-config 下发的 `cloudDesktopEnabled` 控制，未开启环境不渲染入口。
- 国内站和国际站 Bot 管理精确放行集合 GET/POST、单 Bot PUT/DELETE、失败 Bot retry，以及唯一通道绑定 PUT/POST/DELETE；实例 method 集合同步包含 PUT。
  克隆继续使用 POST 创建载荷的 `create_mode` / `source_bot_id`，不新增路径；鉴权、实名策略和 CTL 归属保护保持生效。源码配置不等于生产已发布。
- CTL 的多 Bot 服务端开关由 `ctl-api` 从环境级 `ctl-platform-values.MULTI_BOT_ENABLED` 可选注入；缺省继续使用服务自身默认值，各环境需要显式开放或回滚时必须在对应 deploy-facing platform env 中设置。该开关同时约束前端运行时配置与新增 Bot，不替代 Gateway 精确路由、身份归属或 Hermes Profile 能力检查。

OpenCraft 统一环境目录由 Cordis `environmentDirectory` 服务拥有，位于
`workbench-runtime/src/environment-directory/`；本机/手动配置与提供方发现源汇合，
不是已连接 Host 的别名。LightVela 来源位于插件独立 `environment-directory/`，
按站点、账户、实例稳定识别，保留非运行状态并处理分页、刷新失败和权限代际。
显式旧绑定保留 Host ID，未绑定旧配置不自动指向任意实例。目录只投影连接配方，
环境页与 Chat 共用；发现不连接、不选择、不重建会话，创建回流刷新同一来源。
退出撤销选择资格与连接权限，不能从过期保存配置恢复云实例。

Applications 的内容宽度上限为 137px，独立于上下文栏的最大宽度；拖拽预览、
键盘、复位、保存值读取与投影共用此上限。有效窄宽度保留，旧的过宽值读为上限，
不批量删除偏好；到达上限时不继续扩大，也不新增回弹动画。

应用栏显隐进度与拖拽基础几何由不同所有者维护：隐藏语义产生的零宽不得写入
仍在退出动画中的基础 Frame，否则显隐进度乘零会造成瞬间消失。退出期间保留
最后内容快照并禁用交互，终点才卸载；快速反向点击重定向当前进度，不重置动画。

## 验证

OpenCraft Renderer 的 DOM 回归测试由 `opencraft/tests` 持有，并使用 OpenCraft 自身声明的测试依赖；中文输入的 Shadow DOM 事件回归纳入 `test:workbench:unit`。前端 CI 隔离目录仅包含 `frontend`、`velalink` 和共享 Agent core，前端测试不能跨目录导入 OpenCraft 源码。

OpenCraft 的维护方法和交互验收路由见项目内 [opencraft-maintenance Skill](../../../opencraft/.agents/skills/opencraft-maintenance/SKILL.md)；它消费现有正式设计与源码，不另建架构事实真源，也不授予发布权限。

OpenCraft 第一阶段插件持久化提供 client-local JSON 文档 API：宿主绑定插件 namespace，
`open → read / compareAndSet / subscribe`，持久 CAS 与内容版本分开；Electron 使用 Main
私有 `opencraft-extensions.sqlite`，Web 使用 IndexedDB。设置/安装记录复用该平台适配，
当前 origin 的已知旧库一次性导入且保留原库，过去其他随机 origin 不自动扫描恢复。
Cordis 激活代次负责旧句柄撤销与在途提交收敛，插件自建 Worker 可登记 disposer。
Host 仍只提供 API，不新增 Host 插件运行时或任意 SQL 执行。首个 Local Agent Host
已提供 `storage/documents/*` 能力查询、读取、CAS 与提交通知，绑定已解析 dataDirectory，
沿用单用户 Host token 会话授权；没有新增多租户或按插件行级 ACL。SDK `storage.forHost(id)`
只借用已初始化连接并固定连接代次，断线/替换后失效，不自动落本地或重放写入。
Node SQLite 与校验代码由 document-storage 共用，未引入外部 ORM；其他 Host 必须实际
支持 [Host 文档协议](../../../opencraft/docs/host-document-storage.md)，不能从已连接推断可用。
细节及验证边界见 [插件持久化](../../../opencraft/docs/plugin-persistence.md) 与
[SQLite/IndexedDB 生命周期](../../../opencraft/docs/sqlite-lifecycle.md)。

OpenCraft 不再提供“环境”应用路由、父级导航、概览、连接管理或添加环境界面；旧 `/environments` URL 归一化到 Settings。环境目录和 Host profile 仍是 Chat/运行时内部能力，页面删除不得销毁 Host、草稿或 route scope。本机模型服务作为 Settings 页面注册，并由不可变 `local` Host ID 绑定读写，不能跟随远程聊天 Host；Web 没有本机贡献时不显示该项。连接 ID 与其下模型 ID 分离，凭据继续由 DSH 单独持有。模型编辑草稿由服务拥有，未应用的编辑禁止连接保存；声明名称、上下文/输出上限与输入类型，空项保留运行时默认。连接检测由 Host 显式声明能力，只测试用户输入的草稿与新 Key，不读取旧凭据、不创建会话、不自动保存或启用；一次短文本请求不能宣称工具/视觉/流式及整条运行时均已验证。

Sidecar 的固定与浮动模式共用应用导航、上下文、底部入口的单一内容所有者。稳定 portal 容器仅迁移挂载目标，不重建有状态列表；滚动和焦点按实际可见性恢复。浮层宽度独立容纳 primary + context，窄窗仅收为图标投影，不省略应用入口、不覆盖保存宽度。浮层底部 Applications 不再固定整个侧栏，固定仍由标题栏动作负责；Escape/外部点击同时清理显式和悬浮唤出状态。

Footer 按钮组是 Sidecar 中正常流的末行，不作为 absolute overlay。其完整容器宽度由 Sidecar 决定，Primary motion 不再拥有 Footer width；标准方形入口和弹性账号项用 CSS grid 分配剩余空间，共享 gap/padding token，背景与点击区域不得跨出 Sidecar。只有弹出的菜单使用浮层。底部切换复用标题栏的 SidebarToggleIcon，不叠加应用图标；纯图标窄栏沿用同一组间距。

Context Pane 的 frame/viewport 共用 useContextPaneGeometry 的同一个实时 MotionValue：普通拖动中 viewport=frame=实时布局宽度，缩窄、拉宽、反向都立即重排；提交宽度只用于持久化和取消恢复，松手不能再触发内容补排版。显隐动画独立裁切，不得将收起时固定内容的策略套用到普通调宽。Primary 在展开范围同样实时跟随，只在进入 compact/hidden 的区间保留展开下限视口；吸附只有一个 frame 动画，viewport 是派生值。新手势从正在显示的宽度接管动画，失去指针捕获须取消。AppShell 只派发几何操作，固定/浮动消费同一布局源。门禁检查按住拖动的逐帧宽度、真实环境按钮边界、反向、松手无跳变及取消，而不能只检查 Footer 或最终截图。

桌面会话由 Main 的 PrivateStorage 抽象持久化 region/session token，不调用 OS Keychain/safeStorage。用户选择的是应用私有文件（目录0700、文件0600、原子替换），明确为明文，不声称可防御同账户恶意进程。renderer 不提供任意文件接口、不持久化 token。旧 encrypted 文件不自动解密迁移，用户需重新登录；退出清理本地会话并保留服务端撤销流程，取消/generation 防护不变。

LightVela 的环境目录与实例创建服务继续保持独立 owner，既有 Host 绑定和进行中记录不得因页面删除而迁移或清空；但当前 Shell 不投影环境列表、虚线添加入口或创建窗口。任何未来重新引入的调用方仍须遵守资格校验、稳定 Host ID、未知 POST 结果不自动重发和不切换当前聊天等既有服务约束，不能把保留的服务代码解释为当前可见能力。

OpenCraft 账户界面复用 utility Modal 与 SettingsPanel/Row/Group、头像编辑、Radix 名称编辑、复制反馈和语义用量条。宿主拥有 Dialog 焦点、关闭、滚动和主题材质，账户扩展只提供业务值与动作；不使用账户专属固定大画布。主题引擎补齐警告、错误、用量轨道及工具弹窗材质。模型配置通过宿主设置导航，外部订阅管理返回后刷新详情。匿名 Footer 的登录入口使用同一套 Radix 菜单：提供方贡献国内／国际选项，选中直接提交 Cordis `menu` 流程并打开系统浏览器，不经过中间登录弹窗。通用层只传递 optionId，区域校验和切换在旧事务取消完成后由提供方执行；入口反映等待/错误，菜单提供重试/取消，关闭菜单本身不取消已启动的登录。匿名登录是 action，使用无头像表面的共享 `LogIn` glyph；认证后账户才是 identity，使用真实头像、首字母或中性 User fallback。固定与浮动 Sidecar 共用同一 leading-visual helper、入口和主题。

Codex 账户池的用量与额度重置时间由 Host 观察并持久化，管理页只读取去敏投影。每个额度窗口有报告的重置时刻时，桌面与触屏均直接显示本地时间，展开账户可看完整时刻；上游未报告时明确显示未知，不从窗口长度或账户状态推算，也不将额度重置误称为付费充值。

OpenCraft 桌面 LightVela 登录通过系统浏览器和既有 native OIDC client/callback 完成，Electron Main 拥有 PKCE、单次交换、取消和超时；只向可信顶层 renderer 提供窄 IPC。跨 profile 回调按随机 state 摘要路由到发起登录的本地进程，传输不含会话。会话按 profile 使用上述 Main PrivateStorage 保存，renderer 只在内存持有；重启恢复不依赖静态回环服务端口。网页继续使用 Web 登录流程，后端 allowlist 保持精确匹配。

认证与交互分属应用级 Cordis `authentication` / `authenticationFlows` 服务，不属于 Chat、Host 或 React 弹窗。前者按扩展 activation 注册无凭据的会话/操作端口，确认显式登录结果与当前 epoch；后者拥有 flow ID、发起方 lease、原因与展示状态。会话恢复不得打开任何窗口，同账号重登仍有独立完成结果。登录 View 与 Account View 分开；匹配登录完成只关闭其自身提示，显式账户页不受刷新影响。关闭取消事务，离开页面只放弃 UI 续接，迟到有效会话可以更新全局身份但不能拉回页面、关闭新弹窗或自动创建环境。LightVela `snapshot.session` 与 Bot 目录兼容 `phase`、资料 `details.phase` 独立；资源 5xx 不驱动登出，401 和资料写入均受账户代次/中止信号约束，旧请求不能覆盖新账户。

OpenCraft 的窗口空间由 `shell-space` 统一分配：Applications、上下文与右侧工具共享主区 480px 预算，普通右侧工具另需 320px。Applications 默认宽 137px、展开下限 126px；指针与键盘复用这个下限，不借用上下文栏的 240px 下限。已有自定义栏宽保留，应用栏分隔线双击恢复新默认且不影响上下文栏。按应用栏 compact、应用栏 transient、工具暂停呈现、上下文 floating 降级，恢复留 32px 余量。自动投影不修改保存的栏宽、Pin 和显式开关意图；顶栏消费真实呈现，窄态工具显式打开使用工作区全宽，浮动侧栏可通过 Escape 或外部点击关闭。响应式变化不得销毁 Host、Thread、Terminal 或 Browser 会话。

按 [Agent 请求与流式响应 Journey](../journeys/agent-request-streaming.md) 验证公共入口、实例编排、runtime 自检、provider 路由、流输出和失败回退。实例升配需验证零实例与有实例路径；仅当实际 Pass 配额和产品模型支持多实例时，再验证多实例。重复请求或 worker 重启后不得重复扩盘，实例最终规格、系统盘、Pool、运行状态、网络和身份均须符合实际目标 Bundle/SV/SKU/Pool 配置，且非目标属性保持不变。VelaGW 控制面认证变更还需验证多项配置复用单次登录、成功与失败路径均注销临时 session，且不会撤销持久管理凭据。订阅定向删除变更需验证 Pass 到期保留所有 `credit-package:` 订阅、积分包单独删除不影响 Pass 与其他积分包、重复清理幂等，以及本地投影只删除已匹配的上游订阅。救援导出变更还需验证 Part 重试、Complete、Abort 补偿、取消清理、旧 History replay，以及最终归档的字节数和 SHA-256。Agent 摘要：[agent-gateway-runtime Context](../../context/domains/agent-gateway-runtime.md)。

## OpenCraft 本机项目所有权

本机项目身份和根目录由 OpenCraft 持久化在 `~/.opencraft/projects.json`，不依赖 DSH 工作区身份。
本机 Host 实现产品的 `project/list` 和 `project/create`；Electron Main 只提供可信的系统目录选择端口。
共享 UI 仅在本机 Electron 使用系统选择器；远端/Web 保留 Host 隔离的文件系统浏览。
草稿、Host 或导航变化会使迟到选择失效，连接未就绪时添加入口不可用并说明原因。
见 [平台所有权](../../../opencraft/docs/platform-architecture.md)。

## Hermes 建站凭据的跨地域 TAT 下发

CTL 在实例进入 `Running` 后，从 Sandbox detail 读取实例实际 `region`，按 `WEBSITE_CREDENTIAL_TAT_COMMAND_IDS_BY_REGION` 精确选择对应地域创建的凭据安装 CommandId；地域缺失、未配置或映射无效时 fail-closed，不签发新 Key。Sandbox 内部 TAT 端点以自身持久化的 Sandbox region 再次验证该地域 CommandId，拒绝跨地域 ID。sgprod 同时容纳 `ap-singapore` 和 `ap-johorbahru` 时，两端必须配置一致的映射；旧单值仅供未配置地域映射的环境兼容。TAT 终态成功且退出码为 0 后 CTL 才激活临时 Key；失败时撤销。存量补发须先按 CTL↔Sandbox↔CVM 对账，分别验证 Skill 安装、每实例独立 Key、TAT 终态和建站能力请求，不以实例 `Running` 代替验收。

### 国内控制台 OpenCraft 隐藏发布

- 国内站 `!isGlobal && showHiddenAgentTools` 决定新 Chat 启用；默认仍为 AgentChat，F12 执行 `show()` 切换，再次执行关闭。国际站不启用该候选。
- 复用 `AgentChatMigrationSurface` 的 ready/show adoption；启用新 Chat 后，失败保持原位提示与重试，不自动回退 AgentChat。控制台通过内存函数借出当前 session；OpenCraft 的 account metadata 仅内存保存，不复制 token 到另一 localStorage key，不消费宿主 OAuth fragment，也不拥有登录/退出权限。
- 控制台 token 替换/清除发出无凭据 `lightclaw:auth-session-changed` 事件；跨标签通过 storage 事件识别。旧 accessor 立即失效，组件释放连接后新 owner 初始化。显式 Instance/Profile/account/region 绑定继续由 provider 校验。
- Hermes 首次 Dashboard 启动脚本通过 TAT `PtyStart.Program/Args` 执行并以交互 shell 保活；长单行 `PtyInput` 会受 canonical PTY 长度限制。此路径需要真实部署中的 TAT 兼容验收，本地帧测试不代表线上联通。

- 内嵌 Chat 仅允许已识别的主 Bot 在 Profile 缺失时使用 `main`；非主 Bot 缺少 Profile 必须由 embedded host 校验拒绝，不得回退主 Bot 会话。

- 内嵌 OpenCraft 全局 type-to-compose 从键盘事件 composedPath 判断编辑器/控件所有权；Shadow DOM 重定向后的宿主元素不能作为“空白处打字”依据。组合输入和 keyCode 229 均不额外插字，防止拼音首字母混入草稿。

- 内嵌 Chat 的 Composer 扩展白名单仅开放现有 `vela.voice-input.toggle`，麦克风由用户点击后启动；复用平台 Speech Provider、完成插入与取消事务，不为嵌入场景复制识别链路。

- OpenCraft 会话消息的展开/收起、送达状态、复制操作与附件预览文案由现有 LocaleRuntime 和消息资源统一呈现；中文目录与英文 defaultMessage 同步维护，保留消息原文及状态语义。

- 内嵌 Chat 标题重命名入口与侧栏共享 ThreadTitleWriter/threadManagement 持久化及缓存更新；标题原位输入用 Enter/失焦保存、Escape 取消，组合输入确认不提交。编辑 session 按 Host/Thread 身份隔离，不能在会话切换后写入新目标。

- Web 语音输入由浏览器 onstart 确认采集状态；启动与停止分别限制 15 秒和 8 秒等待。超时/错误释放听写交互并保留原草稿，取消不依赖浏览器 abort 成功，迟到结果不得重新提交文字或触发发送。

### Markdown 文件预览补充
内嵌右侧栏的只读文件预览支持 `.md` / `.markdown` 排版与源码切换，复用既有 Markdown renderer 和 Host 文件读取/Blob lease。该呈现能力不增加编辑、目录浏览或跨 Bot 资源权限；源码仍为唯一文件内容。

国内控制台内嵌 Chat 的 Composer 编辑区域最小高度为 74px，新会话与已有会话一致；独立工作台保留原有尺寸。

国内控制台内嵌 Chat 的新会话提示为“聊聊你的想法，或交给我一件事”，已有会话提示为“告诉我接下来想做什么”；两个消息ID分别覆盖七语言，不以修改任务限定后续输入。

## LightVela 积分扣减优先级

NewAPI 在锁定有效订阅后优先选择名称为 `free-credit:*` 的赠送积分，其次选择套餐/付费积分；各组内部保持到期时间、订阅 ID 升序。仅改变候选优先级，不改变单请求原子资金来源、预扣/退款幂等、套餐 pacing 或 tail-grace：赠送余额不足以覆盖本次预扣时，仍优先使用可完整覆盖请求的其他订阅；赠送已耗尽或过期则回退。Pass 有效期与网关准入仍由服务端验证，底层赠送订阅的长期到期日不是独立于 Pass 的使用授权。

国内内嵌 Chat 在宿主侧拒绝空 Profile，显示配置检查提示且不创建连接；底层 embedded host 保留身份校验。prepare/show 迟到结果不得显示或采纳已退休、启动失败的实例，启动失败后的重试创建新实例。只读文件预览的保存入口也拒绝写入，独立工作台保存沿用操作发起时的 Host/path/text 快照。

文件保存统一通过 writeWorkspaceResource 执行只读检查及目标快照写入；组件与 helper 均有拒绝写入测试。OpenCraft CI guard 在闭包校验后执行锁定依赖安装和串行 test:embedded-ci，包含真实预览面板的写入保护测试。

国内嵌入聊天的 Markdown 文件入口同时支持标准文件链接与回复中行内代码形式的明确文件路径（`.md` / `.markdown`）。点击后由既有资源策略交给当前 Bot 的只读右栏；展示文字不提前触发远端读取，不把路径当命令执行。
Hermes 回复中独立成项的 `MEDIA:<明确 Markdown 路径>`（普通文本或行内代码）也走同一入口，只在回复完成后可点；非 Markdown、夹在正文中的文本及无效路径保持原样。`MEDIA:` 前缀仅用于识别，不进入文件路径或绕过 Host 文件权限。

国内嵌入聊天采用 compact 右栏初始宽度：既有默认宽度的 2/3，并继续遵守面板最小宽度和聊天内容保留宽度；拖拽调整由原 Shell owner 负责，独立工作台保持 standard 默认。

国内桌面嵌入聊天由控制台占满侧栏右侧的内容列，去除设置页外围 gutter 和宽度上限；宿主通过 `--lightvela-console-header-height` 对齐 68px 导航表头。嵌入根将其投影到 toolbar token（缺省 46px），消息正文保留内部间距；移动端与旧聊天入口沿用原布局。

只读 Markdown 文件预览的“源码”直接呈现转义后的原文，可选择复制和键盘滚动，不依赖按需加载的编辑器模块；可编辑工作台继续由 CodeMirror 持有草稿。

- Embedded Chat 的工作台模板通过 element `submitPrompt(requestId, text)` 交给同一 Host/Composer/Conversation owner：冷启动等待 ready，切入空的新 Draft，不覆盖用户文字，接纳后才条件清除站点暂存。运行时初始化 cleanup 保留 manual failure code，直到新连接尝试才清除；页面不能把终态误报为自动恢复。国内控制台默认使用 OpenCraft Chat，生产静态制品仍复用既有同源发布链路。见 [Chat UI invariants](../../../opencraft/docs/chat-ui-architecture.md#invariants)。


## 建站动态接入：能力与发布边界

2026-10-10 源码启用契约（合入不等于生产开放）。`GET /v1/websites/capability` 增量返回
`backend.enabled/contract` 和 `data.enabled`。backend 仅在 runtime URL、部署凭据
配置有效、用户身份非空且区域 `WEBSITE_BACKEND_ENABLED=1` 时为 true，契约 `fetch-v1`；
data 还要求 `WEBSITE_BACKEND_DATA_ENABLED=1`，契约 `rivet-sql-v1`。不按账号筛选。
前端建站导航默认隐藏，控制台 `show()` 可切换显示；此状态不是 API 权限，
登录用户直接请求 API 仍须通过 ownership、quota、Origin 与分享会话校验。缺失/null/非布尔 true 均 fail-closed。源码开关不是生产开放证据。

release `kind` 缺省/static 保持静态，fullstack 需要能力门禁与 SHA-256；静态包不得
携带私有 `__backend` 内容。worker 单独上传 `__backend/app.mjs` 到内部 runtime，
静态进入 immutable COS prefix；CTL 在同一事务内验证 runtime readiness 并更新
active release、静态路径和后端 digest。回滚也是经过 worker 验证的带代次 operation。

fullstack `/api`、`/api/*` 只允许 owner session，即使国际静态页公开也不会公开后端。
动态写请求必须同源 Origin；所有动态请求携带 `X-Website-Release`，与当前活动版本
不匹配返回 409。实时校验站点状态/流量门禁；分享会话无动态调用权限。静态站仍然
只支持 GET/HEAD，不改变 public 静态行为。浏览器 Cookie/Authorization 不转发用户 JS。

`site-runtime` 使用每次调用独立 Docker/runsc 容器、固定引擎 digest、无网络、只读
rootfs、资源限额和超时强制回收；无宿主执行降级。当前验证包括独立 Linux VM 中的
隔离用例和跨模块发布/回滚集成；不等同生产隔离评审或容量验收。没有数据库能力。

Skill 同步提供动态流程与离线打包器；新镜像/存量机器共用完整包版本，存量更新不
触碰网站凭据。两条交付路径和上线前剩余门禁分别见
[Fullstack Beta 实施](../../proposals/2026-09-29-website-fullstack-beta.md) 与
[Skill 双通路交付](../../proposals/2026-09-29-website-skill-delivery.md)。

### Website persistent backend adapter (candidate, 2026-10-02)

The persistent driver consumes Skip's imported `minisandbox` Workers API;
`WEBSITE_RUNTIME_DRIVER=minisandbox` selects it explicitly. There is no host-JS,
local-SQLite or browser-storage fallback. The existing runsc driver remains a
separate stateless compatibility path, not the persistent implementation.

- The immutable backend contract remains `fetch-v1`. CTL exposes `data.enabled`
  and `rivet-sql-v1` only when `WEBSITE_BACKEND_DATA_ENABLED=1`, a configured backend
  runtime and `WEBSITE_BACKEND_ENABLED=1` all pass. Static sites are unchanged;
  frontend visibility still follows its existing hidden `show()` boundary.
- Static publication is independent of runtime availability for sites CTL certifies as backend-free.
  Claimed/internal operation responses carry optional `HasBackendHistory` and `PreviousStorageBytes`
  facts derived from current site kind, all release history (including failed/pruned history), and
  the site's last reported storage total. These are transient response fields, not new DB columns.
  A current static kind alone never establishes that no backend exists; omitted history is unknown.
  Certified static sites use legacy COS retention and COS-only accounting without runtime calls.
  A static transition with backend/unknown history keeps old release resources for joint rollback.
  Optional runtime accounting reads for static publication have a five-second deadline. If unavailable, a new CTL snapshot allows
  conservative accounting of current COS bytes plus the previous reported total; this may overcount,
  is still subject to CTL quota checks, and is replaced by exact accounting on the next successful
  runtime read. It is not a live database-size measurement. Missing/invalid fallback facts do not
  become zero backend usage. Legacy responses without a runtime keep the old static publishing
  contract while preserving history. Fullstack publication still requires runtime accounting.
  Site deletion bypasses runtime only for certified backend-free sites. Backend/unknown history
  requires successful runtime deletion before COS cleanup and completion; unavailable runtime does
  not release quota or report success. Delete completion recounts COS without another runtime call.
  Rollout order is CTL first, then workers; older responses keep conservative cleanup behavior.
- Offline release bindings use schema3 to declare the regional runtime driver and a boolean
  `data_enabled` input. Persistent data is rejected for `runsc`. The explicit `enable` phase
  sets the regional `WEBSITE_BACKEND_ENABLED=1` gate and renders CTL `WEBSITE_BACKEND_DATA_ENABLED=1` with
  gateway `SITE_GATEWAY_BACKEND_SHARED_READ=true` together. `prepare`, legacy schema1 and a
  false data input explicitly override inherited gates to closed values; they never establish
  live runtime/storage readiness. See [regional release bindings](../../../site-runtime/deploy/RELEASE-BINDINGS.md).
- Regional infrastructure can consume expiring, bucket-scoped storage sessions without
  placing the issuer's root credentials in runtime Pods. Worker Registry opts in through
  `ACTOR_CODE_STORAGE_SESSION_FILE` and rereads the bounded projected file for each COS
  request; the third session token is signed with the request. Depot opts in through
  `ACTOR_COLD_STORAGE_SESSION_FILE` and supplies expiry-aware credentials to its S3 client.
  Missing, malformed or expiring session files fail closed rather than falling back to
  static environment credentials. Without these options, the existing credential path
  is unchanged. Projected Secret volumes must not use `subPath`; issuer renewal and
  consumer refresh must be qualified on the actual regional runtime. FoundationDB backup
  uses its native token-bearing credential file, not a two-part key substituted for STS.
  Role creation, Secret delivery and a successful source build are separate preparation
  evidence, not proof of runtime renewal or regional business readiness.
- A trusted `(environment scope, site ID)` deterministically identifies one
  Worker and one `VelaSite` Durable Object. Releases select a verified backend
  digest within the retained Worker package; they do not create a new database.
  Storage is native Durable Object SQL through Depot/FoundationDB and inherits
  the platform commit/output gate. Each bounded SQL call rolls back on quota or
  result overflow. Database limit is 256 MiB; SQL/query and response limits are
  enforced in the platform wrapper, not delegated to generated application code.
- Preparation activates via `expected_deployment_id` CAS and fences the exact
  deployment ID/targets before and after stateless and durable compiled-package
  probes, without invoking application fetch or SQL. The versioned canonical
  package fingerprint covers main-module identity, all module contents,
  compatibility date and Durable Object bindings, excluding only its own exact
  injected marker. An old warm durable isolate cannot satisfy new readiness.
  After observing a valid stale marker, the private durable probe may use native
  `DurableObjectState.abort` to break a retained old class container, without
  changing Actor/Depot identity or deleting storage. It never replays an
  application handler. Deployment/recovery and managed readiness hold the
  exclusive site lock, waiting for in-flight invocations before such a reset.
  Failed linking
  compensates the previous deployment with CAS against only its own activation;
  cancellation cannot cancel the bounded compensation. A conflicting or failed
  compensation is an error, never reported as a successful preparation. Initial
  failed candidates have no website active pointer or local readiness receipt.
- A fsynced write-ahead deployment journal and atomic receipts bind retained
  digests to the actual upstream deployment, version and endpoint/scope identity.
  Unknown/borrowed ownership cannot authorize compensation. Incomplete journals,
  corrupt receipts, unbound legacy receipts and legacy source-only fingerprints
  fail invocation/readiness/publication closed; they are not silently adopted,
  rebound or removed. Interrupted native publication and disk receipt publication
  reconcile to an explicit commit or exact owned-pointer CAS restoration before
  readiness. External deployment and filesystem writes are not one transaction.
  Each DataDir has one manager; the service executable holds a nonblocking
  exclusive OS file lock for its lifetime.
- Explicit site deletion is terminal rather than transaction recovery. Only the
  reviewed native adapter may supersede a pending publication: it first validates
  the journal/receipt's original endpoint/scope identity, then acknowledges the
  permanent Object tombstone and Actor deletion. Local journal/artifact removal
  is fsynced before releasing the in-memory fence. Failure or foreign identity
  stays closed; no activation replay, inferred ownership, hand-erased lock or
  Worker deletion is used. A late activation cannot recreate the Object identity.
- Gateway freshly verifies share policy, generation and expiration before a
  GET/HEAD backend read. `SITE_GATEWAY_BACKEND_SHARED_READ=true` is separately
  required. Browser-supplied internal headers are discarded; the gateway creates
  `read_only` and the runtime creates private dispatch headers. Share SQL permits
  one SELECT only and cannot initialize schema or perform writes. SQL capabilities
  are request-scoped and revoked when the handler completes. Handlers in one DO
  run serially so cached owner capabilities cannot be borrowed by a concurrent
  share request; private class rotation returns busy while a handler is active.
  A wrapper wall-clock deadline revokes suspended handlers and releases the queue
  before the outer invocation deadline; late continuations keep revoked SQL objects.
  All writes still require an authenticated site owner and exact same-origin checks.
- Site deletion uses the logical Object terminal fence. Individual release
  retention removes code artifacts only, not the site database. Worker hard delete
  is not used to bypass the upstream historical Object inventory requirement.
- New-image and single-instance Skill delivery use the same content-addressed
  business-agnostic bundle containing only the Skill and fullstack packager.
  The Skill describes only generic execution, data and same-origin request contracts;
  it carries no predetermined application routes, entities or request fields.
  Application fixtures remain in runtime tests and are never installed on user
  machines. Previous bundle manifests remain verifiable for exact rollback;
  existing credentials are not part of that bundle. Data capability is queried independently; absent/unknown fields are off.

Native dispatch retains only plain generation/Worker/class bindings and code recipes
in module state. Worker and Durable Object handles are recreated per request;
reusing them violates workerd I/O ownership. Eviction uses the validated same-class
recipe without a registry lookup, fences pending readiness by epoch, and retains
the immutable generation binding after unloading. Different Worker versions require
a new admitted generation; native containers retain their first class. Deployment-bound
Host execution fences user dispatch while requesting normal Engine-owned sleep.
Only StopActor performs eviction and SQLite capability cleanup; StartActor resolves
the active Deployment for its newly admitted generation, preserving the stable
Actor/database identity. Generation-scoped sleep intents have bounded recovery;
private preparation may poll an observed transition, never replay application work.
Local native
dispatch qualification is not a regional Workers/Depot/FDB rollout receipt.

This is a source design, not a launch receipt. Release gates require a real healthy
regional Workers/Depot/FDB path, persistence across deployment and host replacement,
site isolation, share read/owner write checks, static regression and the public Agent
flow. `/readyz=200` on Workers API alone does not prove admission or executor
availability. Beijing has passed native SQL write/read, retained-version reads,
  warm version propagation and isolated adapter restart in scoped fixtures; this
  does not prove native Host replacement, public Agent/browser flow or production
  acceptance. Korea and both production configurations remain unqualified. Do not
route international persistent data to Beijing simply to obtain a passing test.

### Website backend test findings (2026-09-30 Beijing time)

Dedicated runtime reconciliation runs under the manager store lock before accepting
requests: reap only owned containers, then reserved interrupted startup/prepare
folders. Immutable active/rollback revisions must not be deleted without control-plane
retention knowledge. Explicit file chmod is required with the private systemd umask.
The website instance credential route allowlist also needs the exact POST rollback
endpoint; session-only tests cannot prove that an Agent's instance credential can
complete the same workflow. These source changes are not evidence of live routing.

### Website fullstack revision retention (candidate implementation)

Fullstack publication retains historical static and backend artifacts together.
Legacy static publication keeps its two-prefix layout; unconfigured runtime storage
cannot authorize prefix pruning, so publication preserves history in that case. Cleanup
requires a CTL transaction to mark a non-active historical release `pruning`, removing
rollback eligibility before remote deletion. The worker deletes only that revision,
checks current lease/generation between stages, and finalizes `pruned`; partial COS
object errors are failures even when HTTP status is 200. Failed cleanup stays fenced.

The internal authenticated `POST /internal/ctl/websites/sites/{siteId}/retention`
reserves at most one candidate using deployment policy, never request-supplied ages.
It is disabled unless `WEBSITE_RETENTION_ENABLED=true`, `WEBSITE_RETENTION_KEEP`
is explicitly 1–16, and `WEBSITE_RETENTION_GRACE` is explicitly 1h–720h. It additionally
requires a fullstack site owned by a backend-enabled authenticated user. A successful
response with `scheduled=false` means no eligible candidate, not a completed cleanup;
when scheduled, follow the operation to terminal success. Worker polling is durable.
No recurring scheduler or production policy is enabled by this source change.
Grace and failed/orphan revisions can still exhaust the runtime revision bound;
reconciliation and capacity acceptance remain release gates, not implicitly solved.

If Pass lifecycle changes supersede a reserved cleanup, the internal trigger may
recover that same operation after the site is active again and its old lease has
expired (or it is terminal), provided no competing work exists. Recovery preserves
`pruning`, increments the generation and clears the old lease; it never reactivates
partially deleted artifacts. Dead-letter failures remain manual recovery, not an
unbounded automatic retry loop.

An opt-in worker scheduler now calls authenticated
`POST /internal/ctl/websites/retention/sweep?cursor=...`. Set worker
`WEBSITE_RETENTION_SWEEP_INTERVAL` explicitly (1m–24h); an absent value disables it.
Each tick scans at most 20 active fullstack sites in site-ID order, filtering owners
through the regional backend gate; each eligible site still uses the fenced reservation.
A complete scan resets the cursor, HTTP/response failures preserve it for retry,
and shutdown cancels the scheduler before draining workers. CTL policy must also
be explicitly enabled. No deployment environment is enabled by the source defaults.

Failed-publication artifact reconciliation uses the same fenced cleanup operation,
not filesystem age alone: only a failed release with an explicit terminal failed
`deploy` record and elapsed grace is eligible, after validating the entire site
snapshot has no unsettled work. Successful history is considered first. Failed
releases do not count toward the rollback window. Cleanup includes the exact
private upload ZIP key as well as the exact static/backend revision; unknown runtime
directories without authoritative release records are not automatically removed.

Website native response stamping captures brand-checked getters across the pristine Response/Body prototype chain. workerd inherits body from Body.prototype; Node-only own-property assumptions must not prevent native Worker preparation. User response properties/proxies are never used to obtain execution identity.

User backend Request boundary is distinct from the browser request: the gateway checks owner/share authorization, Origin and release identity before invocation. The Native wrapper forwards only Content-Type and Accept headers into generated application code, preserving the URL, method and body; it does not expose Cookie, Authorization, browser release headers or private control headers. Application handlers must not reject an otherwise accepted request merely because those platform headers are absent. The shipped website-builder Skill documents this boundary while continuing to require the browser release header and retaining platform write restrictions.


Native deployment readiness must be qualified at both the management registry
read path and the private stateless/durable execution path. Ready runtime Hosts
and matching binaries do not establish a readable active-deployment pointer.
A management GET503 before preparation is not evidence of a package mismatch
or permission to replay activation, application writes, Sleep or rollback.
The manager's bounded startup reconciliation preserves unresolved per-site
journals as invocation fences; actual normal journal recovery and private package
validation remain separate acceptance requirements from Pod health.

### Website share generation cache consistency

Site share form policy and authenticated share cookies must use fresh CTL metadata, not the ordinary site metadata TTL. A newly rotated valid share session otherwise conflicts with the cached generation and redirects back to the share form; revocation must not wait for the positive cache TTL either. Owner sessions retain their existing fresh-owner check, backend API reads retain their existing fresh generation gate, and share writes remain denied. This correction is not deployment evidence.

### Final regional test candidate consistency (2026-10-06)

The final manager r12, website worker r13 and gateway share-cache candidate are
source-bound test overlays, not formal production CI images. Beijing final manager
and gateway observation accepted both exact deployments and actual executable
bindings; the final real website passed independent owner/share browser refresh,
original record preservation and visitor write denial with ordinary DNS/strict TLS.
Korean real code upgrade, joint rollback, static publication and static-to-fullstack
rollback preserved the same original complete record. Generic Skill delivery is
qualified in fresh test images in both regions; no production image/pool adoption
is implied. Exact final Native lifecycle/isolation and regional release bindings
remain separate gates. A local international TLS handshake failure does not prove
a production service outage. The current task authorization is preparation only,
without production, GitOps promotion or stock Skill rollout.

## 建站 Skill-only 新实例补丁（2026-10-02）

CTL 新实例成功持久化 Running 后，以独立精确地域 `WEBSITE_SKILL_TAT_COMMAND_IDS_BY_REGION`
执行一次有界 best-effort auth-only TAT 命令；不挂 resume/自动追补，不签发或 rotate Key。
Sandbox 分开授权 parameterless Skill 与参数化 credential，任意类型 ID 重叠或未知地域拒绝。
Skill POST 不盲重试，metadata 成功不等于 Skill 已 UPDATED；其它 credential 生命周期不变。
默认关闭，仅 shprod/sgprod 两端 source maps 配对配置，线上启用仍需授权发布与真实新实例验收。
实现、认可的生产 v1 hash、异常留档边界及回归见
[建站 Skill auth fallback 运维说明](../operations/website-skill-auth-fallback.md)。

远端/Web 的工作区文件浏览仍通过当前 Host 的 AppServer 文件系统端口读取、监听和写入；浏览器不成为文件真相来源。OpenCraft Web 文件面板把读取结果视为可刷新的服务端快照，未保存草稿按 Host 与路径隔离。切换文件和迟到响应不能覆盖草稿，异步写入必须锁定提交时的 Host、路径与文本；检测到磁盘内容与草稿基线不同则阻止覆盖保存，交由用户处理。文件类型图标和 CSS/JS 语言渲染属于 Web 展示层，不改变 Host 文件协议。

## CTL 云桌面后台安装的会话鉴权传播（2026-10-08）

CTL 云桌面准备把实际安装编排放在 POST 返回后的独立后台任务里执行，但该任务经 Sandbox
adapter 的 TAT 命令通道（`/tat/*`）下发命令，而该通道的鉴权只认请求 `ctx` 透传的用户
session（`applySandboxSessionAuth` 注入 Authorization/Cookie），不存在服务级凭据回退。
因此后台编排的派生 `ctx` 必须显式继承发起请求的 `SessionAuth`，否则安装命令鉴权失败
（`authentication failed`），安装无法真正落到实例机器。provision 探测阶段走的是 PTY
流式 endpoint（`/internal/.../exec-stream`，`X-API-Key` 服务级鉴权），不依赖 session，
故探测可成功而安装失败——两条通道鉴权来源不同是该责任面的既定语义，安装路径不得假定
存在服务级凭据。后台编排对进度轮询的瞬时失败可有界重试，但连续失败须带原因快速判失败，
不得把持续的鉴权/不可达故障静默停留在“安装中”直至整体超时。TAT 命令按进程内绑定锁串行化、
换用户/换 Sandbox/失败重试隔离旧状态等既有约束不变。实现见 `ctl/pkg/instance/desktop.go`，
通道鉴权见 `ctl/pkg/adapter/sandbox/adapter.go`。

## Parallel Expo Agent Console (2026-10-08)

`/agents-next` is an Expo Web presentation entry, without replacing `/agents`.
The native Expo console and this Web entry share a vertical Bot icon rail beside
the selected Bot feature/session pane, plus a fixed account/settings footer;
creation is the rail plus button and Bot switching keeps navigation open. They share navigation and session controls;
frontend retains Bot/session business ownership. Existing OpenCraft Web chat is
bundled locally into the DOM runtime. Actual container dimensions determine
foldable/phone/tablet/desktop layout and never reset conversation or draft state.
See [embedded Bot bridge](../../../opencraft/docs/mobile-bot-bridge.md) for the
validated mount/command ports and [mobile shell](../../../opencraft/docs/mobile-shell.md)
for geometry and platform responsibilities. Electron entry integration and
hardware keyboard/folding evidence remain separate acceptance work; Android
standalone and Electron entry wiring are explicitly excluded from this iteration.
The embedded Chat height chain targets its actual main/section/grid/content
elements, rather than website-only chrome classes. Runtime registration and
visible layout are separate acceptance boundaries: packaged HTML parsing plus
measured nonzero Chat bounds across container sizes precede device/transport
acceptance.

The Expo Chat right pane now opts into external host presentation: the original
conversation panel service owns tab identity, selection, ordering, close/MRU,
preview replacement and browser/resource lifetimes. Host-measured bounds and a
native shell open/close button contain the complete original DOM toolbar, menus and content; no new tab
manager replaces them. The original pane renders in a sibling outlet of the same
local custom element/runtime;
there is no per-tab Application or hosted-page fallback. Runtime generation,
Bot instance/Profile and conversation owner scope every command/state update.
Narrow content capacity overlays Chat; wider capacity places it alongside the
pane without rebuilding the runtime. Default website/Electron chrome remains
unchanged. Contract and acceptance limits are in
[Chat panel host presentation](../../../opencraft/docs/mobile-bot-bridge.md#chat-panel-host-presentation).

The external panel layout parent now allocates genuine sibling grid viewports;
Chat’s embedded AppShell consumes its own column instead of a document-wide fixed
viewport. Native controls/gesture input feed one transient presentation driver in
the same local DOM runtime. Service intent, tabs and resource lifetimes stay with
the original conversation panel owner. Only narrow/full-width capacity uses replacement
presentation; held movement, interruption, cancellation and geometry changes share
the same driver, without a second visibility authority or duplicated application.

泰语国际站的嵌入式工作台使用 `th-TH` 目录，由原有 WorkbenchLocaleController 装载并随宿主语言切换；独立 OpenCraft 语言菜单不扩大。泰语目录保持全部消息 ID、ICU 参数及复数结构，必须通过应用消息提取与 ICU 校验。前端真源提交后通过同步脚本生成 Agent Console 副本，生成层独立提交且通过只读漂移检查。

### Bot IM 客户端首次安装

`vela-computer` 的首次安装产物使用北京 COS 的版本化目录，安装入口复用现有
Bot 归属校验与 `agentuser` 命令执行权限，不新增地域白名单。长下载通过后台任务
和状态轮询完成，安装器与二进制在执行前核验固定摘要，重复安装复用已验证程序。
二进制安装与 Agent Runtime Session/UserSig 的签发、Hermes 启动接线分别验收；
安装完成不能作为 Bot 已连接腾讯 IM 的证据。详细步骤见
[Bot IM 客户端首次安装](../../../vela-computer/docs/bot-im-client-install.md)。
