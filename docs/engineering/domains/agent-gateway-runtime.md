# Agent、网关与运行时领域

本领域覆盖 Agent 请求进入、实例/渠道编排、Sandbox 分配、CloudAgent 执行、模型网关/provider 路由、流式响应和后台 workflow。

## 服务与责任

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

## 稳定不变量

- OpenCraft 浮动聊天与会话/草稿资源分离：Shell 路由注册表拥有显隐意图，标签拥有收起原因；inline/overlay 移动同一编辑器挂载容器，不重建草稿或浏览器。原生唤回只消费 Main 已登记 guest 的代次化鼠标事件。验收与适配边界见 [浮动聊天不变量](../../../opencraft/design/invariants.md#floating-composer-ownership)。

- OpenCraft 权限菜单仅列宿主声明的实际档位，不展示 AppServer default 或提问标题。缺省/null 草稿选择仍继承实际生效权限，仅派生显示、不写回草稿；尚未解析时不虚构勾选。见 [Chat UI 契约](../../../opencraft/docs/chat-ui-architecture.md)。

- DSH 完整接入迁移仍包含执行准入、宿主能力、检查点恢复、历史协议、权限与辅助服务六项；执行表/lease/journal 的源码引入不能代表已接入生产 RPC。见 [完整迁移计划](../../../opencraft/design/dsh-complete-migration/task_plan.md)。

- OpenCraft 的页面创建入口唯一拥有卸载：先卸载 React 消费者，再释放 Host；BFCache 保留原图。受管 DSH 意外退出时失败收尾活动请求，不自动重发；按有界预算恢复进程、模型配置和事件流。短暂启动成功不重置连续崩溃预算。见 [宿主验收矩阵](../../../opencraft/design/dsh-host-acceptance.md)。

- 已保存连接检查只接受 provider/model/revision，由后端解析存储的端点和凭据，密钥不回传界面；未保存修改不自动提交，不把旧密钥用于调用方提供的新地址。

- 模型 Base URL 与操作路径分离；配置、发现、探测和执行前共享校验，禁止把完整操作 URL 再拼接一次。合法网关前缀保留，不静默重写地址。

- Reasoning 能力缺省不是 none；默认值须属于模型支持集合，展示/选择/编译共享同一规则。OpenCraft 目录协议允许 null 默认值，提交前核对目标模型能力，不通过模型名或无条件删 none 绕过引擎验证。见 [reasoning 契约](../../../opencraft/design/reasoning-capability.md)。

- OpenCraft 模型配置由产品自己的 models.json 仓库、校验与 revision/CAS 管理；引擎端口仅接收配置和凭据解析能力。DSH 私有设置是执行投影，不能反向覆盖产品文件；应用失败与保存成功分别报告。见 [模型配置所有权](../../../opencraft/design/model-configuration.md)。

- Composer 的 agents/modelIds 与 models 由同一 TanStack 能力查询成组发布，按 Host/会话范围隔离。配置写入与 Agent 变更事件统一失效，菜单打开校验新鲜度；取消后的旧响应不可发布，刷新失败保留旧快照并标错。联合读取不是后端事务快照。

- 提供商启停由列表行的共享滑动开关承载，名称点击只负责选择；右键保留自定义项重命名和删除。窄屏无列表时保留详情启用入口，所有入口复用同一 Host 命令。

- OpenCraft 自定义提供商的右键删除走 Host 协调命令与 DSH CAS：只移除该提供商及其模型选择配置，保留凭据与会话历史，阻止删除当前默认提供商。重命名不改变 provider ID；内置提供商不可通过此入口删除。

- 模型连接的 Responses API 开关归入默认折叠的高级设置；启用协议在摘要中可见，折叠不改变实际协议或保存草稿。

- OpenCraft Web/Electron 不因已登录账号没有云端 Bot 而替换工作区；账号级 applicationIntervention 不再控制聊天呈现，旧 bot-required 只供显式 LightVela 配置使用。零 Host 显示中立的无 Agent 状态并提供 Settings 入口，不建立 Environment 应用界面；真实选中 Host 的认证/连接错误仍由对应 provider 处理。

- OpenCraft 简化模型服务只改变呈现与编辑交互：已配置连接按需展开、首次配置展开，配置存在不等于探测成功；明确保存和取消共享原有 CAS/凭据接口。模型服务位于 Settings 的“本机”分组，继续由固定 `local` Host 客户端读写，不跟随当前聊天 Host。

- OpenCraft 模型服务的品牌目录仅供界面识别：提供商品牌与模型家族独立匹配，未知标识有中性兜底；不影响 Host、模型路由、凭据和默认模型。资源本地打包，继承现有主题。

- OpenCraft 当前只提供右侧工具与 Overlay 聊天；不提供下方面板、移动到下方或 Show bottom panel。旧 bottom 标签在视图接入时无损归回右侧，不能因撤销布局能力而关闭网页或终端。

- OpenCraft 的任务工作区呈现契约由 [design/](../../../opencraft/design/README.md) 维护：主 Composer 在普通聊天与展开工具之间共享同一草稿/提交目标，面板移交不关闭资源，临时 Side Chat 通过源 Host 的真实 ephemeral fork 创建。该目录显式区分实现与真实 Host/桌面验证，不能把不支持的协议模拟为成功。

- Pass 升配 checkout 每次明确确认支付都由 CTL 校验本人归属、当前状态和合法目标后新建订单，不以历史未付款订单复用或查询作为前置条件。支付票据重签及兼容的订单恢复接口仍须校验本人归属；匿名微信桥仅接受精确绑定的支付票据，不得开放建单或恢复查询。不同订单争用同一 Pass 仍由现有 flow/CAS 保护，已交付订单仅凭匹配的持久化回执幂等重放。具体契约见[订阅购买与续费](../journeys/subscription-purchase-renewal.md#pass-升配-web-checkout)。

- Sandbox 请求路径不创建/重装机器，只分配/释放；后台 worker 执行重置与补货。
- 已分配实例的同 SP 升配走持久化变配账本，状态只允许
  `ALLOCATED → MODIFYING → ALLOCATED`。后台 worker 按“停机、计算规格升级、系统盘扩容、
  开机、交付校验、目标 Pool 重绑”单向续跑；幂等键必须阻止不可逆扩盘重复执行，失败只
  前滚重试，不自动缩盘或回源 Pool。
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
- Agent Console 生成命令必须在 Git 工作树中记录真实源 revision；任何命中生成闭包的 `frontend` 源码变更都必须运行 `npm --prefix opencraft run sync:mono2-agent-console`，并在同一 MR 提交机械生成副本与 `UPSTREAM.json`。只读漂移检查可在不包含 `.git` 的 CI 隔离目录中复用已提交清单的 revision，但仍须逐文件校验源内容与 SHA，不能因此跳过 vendored 一致性检查。
- OpenCraft 不注册 mono2 MR 占位检查或专用 CI 流水线，避免共享 `frontend` 路径触发隔离 workspace 的重复安装；完整验证能力由 `opencraft/` 内的 `npm run gate` 保留，并按变更风险由开发者或发布流程显式执行。
- OpenCraft 的应用/个人双入口归属 Shell 的 Sidecar Footer，不是全窗底栏；Pin 切换保持局部锚点，全部侧栏收起时入口一起隐藏。Pin 偏好、临时展开和响应式可停靠能力分别建模；窄屏不得抹除偏好。左侧栏位共用聚合宽度信号，不重建 Host/会话运行时。Sidecar 的上下文插槽可选：聊天提供会话列表，设置提供索引，当前扩展页面不提供上下文，只显示单一应用导航栏；切换页面不改写 Pin 偏好。该插槽不是新的扩展注册协议。Web 通过 Radix 拥有临时容器交互，跨端 reducer 不依赖 DOM；Expo 视觉适配另行接入。
- OpenCraft 应用栏和上下文栏独立持久化宽度，共用分隔线原语的拖拽、键盘和双击复位交互；Shell 约束可用内容宽度，响应式投影消费应用栏宽度但不覆盖用户偏好。双入口复用紧凑侧栏条目：默认透明无描边投影，悬停、展开与 Pin 复用导航浅底色，保留语义按钮和键盘焦点。入口组按对称内边距铺满最左侧栏：左侧正方形，右侧个人入口占剩余空间，不再固定 1:3 或跨越两栏；调宽或 Pin 保持左下锚点，右边缘跟随栏宽。Footer 在停靠和临时侧栏中都占据独立布局行，列表视口限定在其上方，禁止用零高度绝对定位容器覆盖业务列表。
- OpenCraft 会话顶栏分隔线资格由布局所有者的窗口宽度减右侧面板宽度决定，不再混用 DOM 主区测量值与左栏动画值，防止临界宽度的跨帧测量误差导致横线闪烁。Vela 首页字标和顶栏隐藏测量副本共用相同文字几何；品牌字体资源尚待确认，不将临时 UI 字体回退视为定制字体交付。
- Sidecar 统一绘制导航栏、上下文栏及 Footer 后面的连续材质，子栏和 Footer 不再分别叠加背景或模糊；保留 Footer 真实布局占位，但不得出现白色底条或上下文栏下方露出的深灰窗口底色。
- OpenCraft 应用入口直接切换停靠栏，宽屏没有中间菜单或二次 Pin 操作；窄屏切换同一导航内容的抽屉，不覆盖宽屏偏好。账户仍独立使用菜单。设备设置在有 Host 和零 Host 宿主中均复用 AppShell 的上下文与主内容插槽，替换分类/详情而不替换 Shell；不允许设置自行禁用全局导航或引入私有宽度/折叠控制器。应用栏展开时为导航、设置分类、设置内容三栏，收起后自然变为两栏。Agent 管理仍由独立模态容器拥有。
- OpenCraft 将“账号已认证但没有可运行 Bot”建模为应用级 `bot-required` 状态，而不是登录失败或 Host 传输错误。Web 零 Host/连接干预与 Expo 账户门共享同一纯状态投影和区域创建地址，各端只拥有自己的呈现适配；实际创建、套餐、实名与资格校验继续由 `frontend` 的 `/dashboard/create` 统一流程拥有。
- OpenCraft 的 LightVela 匿名状态不是应用级 intervention：只要本地 Host 可用，默认路由必须保留本地新任务 Workbench，不能由登录页接管主内容。Sidecar 的匿名账户入口明确显示为 `Sign in`，点击后才打开国内/国际区域选择并继续到对应 LightVela Web OIDC；已登录账户恢复头像/名称，已登录但无 Bot 仍使用既有 `bot-required`。只有用户明确选择需要 LightVela 凭据的 Host 时，Host-specific `authentication-required` 才可接管该连接上下文。
- OpenCraft 内嵌 Hermes 控件以语义状态和 Host token 为契约：业务页面只拥有选项值与策略，Web Option/Select 原语拥有可访问性语义，Host 主题适配层拥有颜色、焦点、选中与禁用视觉。挂载到 `body` 的 Select/Popover/Dialog 必须显式选择命名呈现层级，不得在功能页面使用数值 `z-index` 与应用模态窗竞争。
- OpenCraft 公告窗口是既有应用模态 Host 的内容变种，不是第二套窗口管理器。可信 JavaScript 只能通过 `api.window.showAnnouncement()` 提交可序列化描述并等待动作/关闭结果；扩展卸载必须先收敛其未决窗口。ReactNode、DOM、Radix、焦点、Portal 与数值层级不得进入扩展 ABI，自动展示资格和已读持久化由独立公告编排层拥有。
- OpenCraft Web/Electron 把 Vite 静态资源放入公告描述前，必须在 renderer adapter 将相对地址解析为当前模块所属的绝对 HTTP(S) 地址；不得为了兼容 Electron 相对 `base` 而放宽 renderer-neutral 公告协议。账户区域切换的“需先退出登录”不变量继续由账户服务强制执行，交互层必须把该预期拒绝就地呈现，不能让它升级为未捕获的全局运行时错误。
- OpenCraft macOS 本地 preview 与发行包是两个交付契约：preview 使用独立 Bundle ID、产品名、profile、daemon socket 和输出目录，关闭证书自动发现，并在资源最终装配和目标架构 native prebuild 裁剪后执行一致的 ad-hoc hardened-runtime 签名；发行 ZIP/DMG 继续承担 Developer ID、notarization 与最终 Gatekeeper 验证，二者不得互相复用半签名目录。
- OpenCraft Workbench 侧栏的导航动作与账户入口共享同一个 leading-slot 几何契约；图标、头像、文字起点和行内间距由侧栏局部 token 统一拥有。hover、选中、按下和菜单展开状态只能改变绘制状态，不得切换盒模型或移动文字列。
- OpenCraft Web 发布器以 Vite manifest 判定构建所有权：manifest 引用的 `assets/**` 必须内容寻址并按 immutable 追加；Vite 从 `public/` 原样复制的非哈希资源即使位于 `assets/**`，仍按可重验证公共文件原子覆盖。发布入口只能在两类资源全部落盘后切换。
- OpenCraft 的客户端 Turn、queue、steer、工具活动和滚动投影遵循 Codex 生命周期；Hermes 事件游标、durable history 与投影状态遵循 Hermes Desktop 生命周期。断线恢复不得只保留 replay 游标却重建空投影状态。
- OpenCraft 的 Hermes 工具完成状态只能来自明确结果证据：终端退出、结构化结果或后端失败。Turn 完成本身不得制造工具成功；后台命令保留运行中进程句柄，缺失结果保持未确认。实时与历史恢复必须复用同一工具身份和终态归并规则。
- AppServer 传输失败必须保留结构化恢复策略。瞬态失败可由既有策略重连；远端资源已删除等不可恢复错误标记为手动恢复，Workbench 不得自动重建同一失效传输并形成重连循环。
- Web 与 Expo 的用户消息折叠共享同一领域判定：仅自然内容高度越界后才允许折叠，裁剪后的视觉高度不能撤销已确认判定；原生宽度变化必须使旧测量 generation 失效，避免跨布局复用过期高度。
- Workbench 的 Host Catalog readiness 由 Host runtime 状态转换驱动：失败/重连后的首次 `ready` 必须主动重载 Thread Catalog，不依赖用户再次发送消息；订阅时已经处于 `ready` 不得制造重复重载。浏览器 BFCache 的 persisted `pagehide` 必须保留应用所有权图，仅真正离开页面时才 dispose。
- VelaGW 执行 NewAPI 控制面写操作时，单次操作内复用一个临时管理员登录 session，并在成功或失败后主动注销；不得把短期登录 session 当作持久管理凭据，也不得让周期性配置收敛持续消耗 NewAPI 活跃 session 配额。
- DesiredConfig 导出读取渠道明文 Key 时同样必须创建一次临时管理员登录 session、完成 2FA，并在完整快照成功或失败后注销；不得使用 Set 中持久化的历史 access token 执行 `/api/verify`。
- VelaGW 读取固定版 NewAPI 的渠道明文 Key 时，必须用 `scope=channel.key.read` 签发短期 Security Proof，并在后续 Key 请求中携带 `X-Security-Proof`；登录 access token、2FA 登录状态或历史 session cookie 都不能替代该作用域凭据。
- VelaGW 更新 NewAPI 渠道内容时不得携带 `status` 字段；渠道启停由独立状态接口负责，避免内容 Upsert 越过 NewAPI 的状态管理边界。
- VelaGW 镜像 promote 默认只能改动目标环境的 `VELAGW_IMAGE` 与 `VELAGW_DEPLOYED_AT`。如果投影同时改变 NewAPI release pin、Kustomize 结构或其他 deploy-facing 配置，发布必须关闭自动合并与自动同步，先把目标配置回填到 `master` 真源并重新生成候选。
- 大体积救援导出由 VM 流式生成归档并使用 COS Multipart Upload，不能先把完整归档写入救援系统盘，也不能退回未知长度的单次 `PUT Object`。
- 腾讯云永久密钥只存在于 Worker runtime Secret。救援 VM 只接收短期、精确到目标对象且仅允许上传 Part 与 Complete 的 STS 凭据；STS 和含凭据的 TAT 脚本不得进入 Temporal Workflow History。
- Workflow 必须在提交 TAT 前持有 Multipart Upload ID。TAT 提交、上传或结果确认失败时，通过 disconnected cleanup context 执行 Abort 并删除可能已经 Complete 的残留对象。
- 修改救援 Workflow 的 Activity 序列时使用 Temporal version marker 保证旧 History 继续 replay，不能让存量执行产生 nondeterminism。
- `ctl.user_subscription_gateway` 是已分配用户的网关归属真源；Pass 续费只延长当前归属网关的权益，不隐式迁移网关。
- VelaGW 中套餐、免费积分与独立购买的积分包是可并存的订阅。Pass 到期清理只能按名称前缀删除 `package:`、`free-credit:` 及历史空名称套餐订阅，必须保留 `credit-package:`；单个积分包退款或隔离则按完整订阅名删除目标订阅，不得清理 Pass 周期元数据或其他积分包。旧 AI-Gateway 不具备定向删除能力，仍沿用用户级全量取消语义。
- 运行中实例从 `ai_gateway` 迁移到 VelaGW 必须同时完成权益补发、固定用途 Key 签发、Hermes Provider 切换、实例 Key ID 持久化和旧 Key 撤销。该操作只通过强鉴权内部接口按 `user_id + instance_id` 执行，默认先 dry-run；用户存在多个非终态 Bot 时拒绝迁移，避免用户级网关路由产生半迁移。
- 迁移采用可重入、最终一致语义：用户、订阅和固定用途 Key 均幂等复用，Hermes 配置可重复收敛，路由和实例 Key ID 可重复写入；任一步失败后允许从头重试，不引入跨服务伪事务。
- VelaGW 人工额度重置只能调用用户加 Plan 维度的接口，并固定保留自然重置时间；禁止用 Plan 全量重置接口代替单用户操作。CTL 对该能力提供用户级包装，隐藏 Set、上游用户和 new-api Plan ID。
- `gateway-dashboard` 只能通过服务端 BFF 调用迁移和额度重置，两个操作均先 dry-run 并要求完整用户 ID 二次确认；`CTL_INTERNAL_TOKEN` 不得进入浏览器。

- OpenCraft 两版旧模型设置界面已移除。新 LobeChat 风格模型服务页已按用户确认设计接入 DSH，提供商与模型目录来源于运行时；发现模型的保存与初始禁用属于同一次 CAS，不隐式切换默认模型。输入合并保存保留原始配置版本，文本检查只使用用户新输入的 Key。
- DSH 是执行引擎，不给予 DeepSeek 提供商特殊管理地位。原生 DeepSeek 与其他提供商共享真实启停与默认模型保护；停用释放路由、保留配置和凭据，并在重启后保持。补丁仅扩展固定版本适配器的生命周期，不改协议实现或自动迁移用户默认模型。
- Settings Shell 承载本机模型服务的分类入口与 master-detail 容器；模型服务内部目录按实际容器空间适配。该呈现不建立环境面包屑、概览或连接管理页，不改变 Chat location；原生启用生命周期或协议不支持的操作不伪装成可用控件。

## 定时任务执行模式

- 单次任务的执行时间输入按年、月、日、小时、分钟拆成独立数字段，点击或聚焦某一段只编辑该段，焦点离开整个控件时统一校验并规范化；也可在同一个受控 Popover 中编辑日期、小时和分钟。选择过程只更新草稿，取消或 Escape 不提交，最终仍输出 `YYYY-MM-DDTHH:mm`，不得改变 Hermes 的本地时间解析语义。
- 定时任务分为 Agent 任务与 0 Token 任务。Agent 任务沿用 Hermes 的 prompt、Skill 和模型推理链路；0 Token 任务必须映射到 Hermes `no_agent` 脚本执行链路，不得注入 prompt、Skill、模型或失败后模型兜底。
- 0 Token 任务包含固定通知与脚本任务。固定通知由控制台生成并托管脚本；脚本任务执行用户提供的 Bash 或 Python，标准输出按原文进入既有通知渠道，空标准输出保持静默，非零退出、超时等运行失败按现有告警能力处理。
- 控制台只允许编辑自身带版本标记和元数据的托管脚本。外部创建的 `no_agent` 任务可以展示和管理调度，但脚本内容默认只读，删除 Cron 时不得推断并删除不属于 LightVela 的文件。
- 脚本在 Agent/Hermes 主机上以运行时用户身份执行，不提供独立安全沙箱。产品界面必须在创建或测试脚本任务前明确提示该边界。
- 0 Token 创建入口由前端默认开启，不依赖 CTL 下发功能开关；远端运行时配置不可用或未包含对应字段时仍保持开启。显式的构建期关闭、本地紧急关闭或远端布尔 `false` 只阻止新建 0 Token 任务，不隐藏或阻断已存在任务的查看、编辑调度和删除。正式开放前还必须确认目标 Hermes 镜像包含与产品约定一致的 `no_agent` 能力。

## 实例内多 Bot 与 Hermes Profile

- `shared/lightvela-agent-core` 是 mono2 中立的 Agent 管理业务内核，mono Web 为
  首个消费者。当前统一 Bot/Instance/Profile 身份、生命周期归一化、确定性
  Catalog 投影，以及首台实例/额外 Bot 的创建目标与 blank/clone 意图；不改变
  CTL/Hermes endpoint、请求字段、创建/删除语义或服务端权威。额外 Bot 只能选择
  归一化为 Running 的实例，不能按实例计数或缓存首项推断 readiness。该 core 禁止 React、路由、i18n、
  网络、存储与埋点依赖，后续由 Web CTL adapter、OpenCraft AppServer adapter
  和 native adapter 分别注入。同一 Catalog 内以 instance/Bot/Profile 三元组
  作为长度编码身份键，跨实例同名 Profile 不得合并；环境/账户作用域由上层目录
  添加。旧 Context/Repository 保留兼容门面直至消费者迁完。

- 诊断中心日志查询和导出显式选择当前 Bot 的原生 Profile；切换 Bot 后不得复用旧日志。重置模型配置暂时只支持单一主 Bot 的实例，CTL 在签发或撤销密钥前重新读取完整 Profile 列表；列表失败或不满足单一根 Profile 条件时拒绝操作。
- 重装、备份与恢复属于整个 Agent 的维护操作，仅在主 Bot 展示入口，并明确影响所有 Bot。前端进度、控制台与操作锁按实例隔离，同一实例内切换 Bot 不丢失状态。恢复显式使用 `/home/agentuser/.hermes` 与原生 `default`，不依赖运行时当前选中的 Profile；完整多 Profile 恢复仍需在隔离实例做兼容性验收。

- 当前发布批次隐藏已有 Agent 的“新建 Bot”入口，保留已存在 Bot 的切换、配置和删除，以及无实例用户的首次 Agent 创建流程；后续开放须另行确认。
- LightVela 的 `instance_id` 负责资源与归属，产品 Bot 是 Hermes Profile 的控制台投影。命名 Bot 的 `bot_id` 与 `profile_id` 使用同一 Hermes Profile ID；默认 Bot 为兼容存量前端保留实例 ID 作为 `bot_id`，公开 `profile_id` 为 `main`。
- CTL 不持久化 Bot/Profile 映射，也不为多 Bot 新增数据库结构。Bot 列表、名称和描述通过 Hermes 官方 `GET /api/profiles` 管理接口读取；CTL 在 Hermes 进程内以 ASGI transport 调用该路由，不额外启动 `hermes serve`。接口内部扫描 Profile 目录及其 `profile.yaml`；模型、Skills、Memory、SOUL、会话、Cron 和渠道运行态同样以对应 Profile 为真源。
- 每个存量实例幂等拥有一个不能作为 Profile 单独删除的默认 Bot，公开 `profile_id` 为 `main`。`main` 始终解析到原 `$HERMES_HOME`，不得创建命名 `profiles/main` 或迁移根 Profile 数据。Hermes 内部根 Profile ID `default` 不得作为产品展示名；根 Profile 没有显式名称或存量实例名称时，由客户端使用本地化默认名称，命名 Profile 才可使用 Profile ID 作为名称兜底。实例内只剩默认 Bot 时，产品删除动作销毁整个 Agent 实例；存在其他命名 Bot 时必须先逐一删除，条件式实例删除接口会在销毁前重新校验 Profile 数量。
- Provider、模型、通道、Gateway、Skills、自动任务、Memory、User Profile 和 SOUL 等 Profile 级操作必须携带后端返回的 `profile_id`；bootstrap、升级、重装、实例健康、资源、账单和套餐仍按 `instance_id` 执行。产品/API 层默认 Bot 的公开标识保持 `main`，但直接调用原生 Hermes CLI 时必须转换为内建根 Profile `default`；命名 Profile ID 原样透传。
- Home channel 是 Profile 下按平台保存的映射，不是实例全局值。创建或克隆 Bot 默认不复制 Home channel；通道认证同样不得静默共享。
- 通道是否允许多个 Bot 同时连接由 capability 决定。国内站微信在一期按实例级唯一资源处理；占用信息写入实例 `$HERMES_HOME/.lightvela/channel-bindings/weixin.json` 并通过文件锁原子更新，非占用 Bot 不得覆盖或复用该通道凭据。
- 命名 Bot 创建前必须同时通过服务端功能开关和目标实例的 Hermes Profile 能力预检。克隆完成后要移除消息通道配置、消息通道环境变量和 Home channel；配置键本就不存在应视为已完成清理，除此之外的清理失败仍须终止并回滚创建，无法证明清理完成时不得把 Bot 标记为可用。
- Profile 创建、更新和删除为同步操作；失败直接返回稳定错误码且不得留下伪 Bot 记录。创建失败时应尽力删除未完成的命名 Profile，后续列表只展示 Hermes 当前真实存在的 Profile。
- “空白创建”使用 Hermes 的 no-skills Profile 语义，创建时不预装任何用户 Skills，并保留运行时的 bundled-skills opt-out 标记，后续 Hermes 更新也不得自动回填基础或 bundled Skills；对此类带 opt-out 标记的 Profile，Hermes 自身运行必需的 `hermes-agent` 内部 Skill 不属于用户可管理 Skills，前端不得展示或计入已安装数量，既有 Profile 的列表语义保持不变。用户仍可在创建完成后按需安装，克隆方式继续复制用户显式选择的来源 Profile Skills。
- Bot 显示名称去除首尾空白后必须包含 1 到 60 个 Unicode 码点；前端创建入口提供同等输入约束，CTL 在创建和重命名时执行最终校验。
- 公开 API 使用 `/v1/instances/{instance_id}/bots` 表达实例作用域；新增 method/path 必须同步 `service-gateway` allowlist，并分别验证 CTL 直连与公共入口路由。

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

OpenCraft 的维护方法和交互验收路由见项目内 [opencraft-maintenance Skill](../../../opencraft/.agents/skills/opencraft-maintenance/SKILL.md)；它消费现有正式设计与源码，不另建架构事实真源，也不授予发布权限。

OpenCraft 不再提供“环境”应用路由、父级导航、概览、连接管理或添加环境界面；旧 `/environments` URL 归一化到 Settings。环境目录和 Host profile 仍是 Chat/运行时内部能力，页面删除不得销毁 Host、草稿或 route scope。本机模型服务作为 Settings 页面注册，并由不可变 `local` Host ID 绑定读写，不能跟随远程聊天 Host；Web 没有本机贡献时不显示该项。连接 ID 与其下模型 ID 分离，凭据继续由 DSH 单独持有。模型编辑草稿由服务拥有，未应用的编辑禁止连接保存；声明名称、上下文/输出上限与输入类型，空项保留运行时默认。连接检测由 Host 显式声明能力，只测试用户输入的草稿与新 Key，不读取旧凭据、不创建会话、不自动保存或启用；一次短文本请求不能宣称工具/视觉/流式及整条运行时均已验证。

Sidecar 的固定与浮动模式共用应用导航、上下文、底部入口的单一内容所有者。稳定 portal 容器仅迁移挂载目标，不重建有状态列表；滚动和焦点按实际可见性恢复。浮层宽度独立容纳 primary + context，窄窗仅收为图标投影，不省略应用入口、不覆盖保存宽度。浮层底部 Applications 不再固定整个侧栏，固定仍由标题栏动作负责；Escape/外部点击同时清理显式和悬浮唤出状态。

Footer 按钮组是 Sidecar 中正常流的末行，不作为 absolute overlay。其完整容器宽度由 Sidecar 决定，Primary motion 不再拥有 Footer width；标准方形入口和弹性账号项用 CSS grid 分配剩余空间，共享 gap/padding token，背景与点击区域不得跨出 Sidecar。只有弹出的菜单使用浮层。底部切换复用标题栏的 SidebarToggleIcon，不叠加应用图标；纯图标窄栏沿用同一组间距。

Context Pane 的 frame/viewport 共用 useContextPaneGeometry 的同一个实时 MotionValue：普通拖动中 viewport=frame=实时布局宽度，缩窄、拉宽、反向都立即重排；提交宽度只用于持久化和取消恢复，松手不能再触发内容补排版。显隐动画独立裁切，不得将收起时固定内容的策略套用到普通调宽。Primary 在展开范围同样实时跟随，只在进入 compact/hidden 的区间保留展开下限视口；吸附只有一个 frame 动画，viewport 是派生值。新手势从正在显示的宽度接管动画，失去指针捕获须取消。AppShell 只派发几何操作，固定/浮动消费同一布局源。门禁检查按住拖动的逐帧宽度、真实环境按钮边界、反向、松手无跳变及取消，而不能只检查 Footer 或最终截图。

桌面会话由 Main 的 PrivateStorage 抽象持久化 region/session token，不调用 OS Keychain/safeStorage。用户选择的是应用私有文件（目录0700、文件0600、原子替换），明确为明文，不声称可防御同账户恶意进程。renderer 不提供任意文件接口、不持久化 token。旧 encrypted 文件不自动解密迁移，用户需重新登录；退出清理本地会话并保留服务端撤销流程，取消/generation 防护不变。

LightVela 的环境目录与实例创建服务继续保持独立 owner，既有 Host 绑定和进行中记录不得因页面删除而迁移或清空；但当前 Shell 不投影环境列表、虚线添加入口或创建窗口。任何未来重新引入的调用方仍须遵守资格校验、稳定 Host ID、未知 POST 结果不自动重发和不切换当前聊天等既有服务约束，不能把保留的服务代码解释为当前可见能力。

OpenCraft 账户界面复用 utility Modal 与 SettingsPanel/Row/Group、头像编辑、Radix 名称编辑、复制反馈和语义用量条。宿主拥有 Dialog 焦点、关闭、滚动和主题材质，账户扩展只提供业务值与动作；不使用账户专属固定大画布。主题引擎补齐警告、错误、用量轨道及工具弹窗材质。模型配置通过宿主设置导航，外部订阅管理返回后刷新详情。匿名 Footer 的登录入口使用同一套 Radix 菜单：提供方贡献国内／国际选项，选中直接提交 Cordis `menu` 流程并打开系统浏览器，不经过中间登录弹窗。通用层只传递 optionId，区域校验和切换在旧事务取消完成后由提供方执行；入口反映等待/错误，菜单提供重试/取消，关闭菜单本身不取消已启动的登录。固定与浮动 Sidecar 共用该入口与主题。

OpenCraft 桌面 LightVela 登录通过系统浏览器和既有 native OIDC client/callback 完成，Electron Main 拥有 PKCE、单次交换、取消和超时；只向可信顶层 renderer 提供窄 IPC。跨 profile 回调按随机 state 摘要路由到发起登录的本地进程，传输不含会话。会话按 profile 使用上述 Main PrivateStorage 保存，renderer 只在内存持有；重启恢复不依赖静态回环服务端口。网页继续使用 Web 登录流程，后端 allowlist 保持精确匹配。

认证与交互分属应用级 Cordis `authentication` / `authenticationFlows` 服务，不属于 Chat、Host 或 React 弹窗。前者按扩展 activation 注册无凭据的会话/操作端口，确认显式登录结果与当前 epoch；后者拥有 flow ID、发起方 lease、原因与展示状态。会话恢复不得打开任何窗口，同账号重登仍有独立完成结果。登录 View 与 Account View 分开；匹配登录完成只关闭其自身提示，显式账户页不受刷新影响。关闭取消事务，离开页面只放弃 UI 续接，迟到有效会话可以更新全局身份但不能拉回页面、关闭新弹窗或自动创建环境。LightVela `snapshot.session` 与 Bot 目录兼容 `phase`、资料 `details.phase` 独立；资源 5xx 不驱动登出，401 和资料写入均受账户代次/中止信号约束，旧请求不能覆盖新账户。

OpenCraft 的窗口空间由 `shell-space` 统一分配：Applications、上下文与右侧工具共享主区 480px 预算，普通右侧工具另需 320px。Applications 默认宽 137px、展开下限 126px；指针与键盘复用这个下限，不借用上下文栏的 240px 下限。已有自定义栏宽保留，应用栏分隔线双击恢复新默认且不影响上下文栏。按应用栏 compact、应用栏 transient、工具暂停呈现、上下文 floating 降级，恢复留 32px 余量。自动投影不修改保存的栏宽、Pin 和显式开关意图；顶栏消费真实呈现，窄态工具显式打开使用工作区全宽，浮动侧栏可通过 Escape 或外部点击关闭。响应式变化不得销毁 Host、Thread、Terminal 或 Browser 会话。

按 [Agent 请求与流式响应 Journey](../journeys/agent-request-streaming.md) 验证公共入口、实例编排、runtime 自检、provider 路由、流输出和失败回退。实例升配需验证零实例与有实例路径；仅当实际 Pass 配额和产品模型支持多实例时，再验证多实例。重复请求或 worker 重启后不得重复扩盘，实例最终规格、系统盘、Pool、运行状态、网络和身份均须符合实际目标 Bundle/SV/SKU/Pool 配置，且非目标属性保持不变。VelaGW 控制面认证变更还需验证多项配置复用单次登录、成功与失败路径均注销临时 session，且不会撤销持久管理凭据。订阅定向删除变更需验证 Pass 到期保留所有 `credit-package:` 订阅、积分包单独删除不影响 Pass 与其他积分包、重复清理幂等，以及本地投影只删除已匹配的上游订阅。救援导出变更还需验证 Part 重试、Complete、Abort 补偿、取消清理、旧 History replay，以及最终归档的字节数和 SHA-256。Agent 摘要：[agent-gateway-runtime Context](../../context/domains/agent-gateway-runtime.md)。
