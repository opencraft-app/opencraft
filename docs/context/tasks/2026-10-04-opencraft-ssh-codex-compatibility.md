## goal
实现 OpenCraft 后端通过 SSH 连接现有 Codex Server 的通用链路，同时兼容普通 Linux 和 HyperNode exec 协议。

## non_goals
- 用户已授权实现及连接其 Linux 目标，并确认首次 ED25519 指纹。密码仅用于认证，不进入源码、记录或日志。
- 不重启当前预览、不发布、不提交已有工作区改动。
- 不把 HyperNode 当作可上传安装任意软件的普通 Linux 主机。
- 不默认安装、升级或终止远端 Codex，不转移远端模型账户凭据。

## requirement_ids / requirement_refs / requirement_excerpt
- 当前用户要求：参考 `ref/hypernode`，由我们的服务器连接 SSH 兼容的 Codex Server；“也要兼容普通 Linux 服务器”。外部需求编号 unknown。
- 默认 Steer 与可设置偏好已由独立任务实施；本任务不再改动该偏好。

## interface_refs / data_structure_refs
- `opencraft/packages/appserver-client/src/transport.ts`：DuplexTransport 与自动/手动恢复分类。
- `opencraft/packages/workbench-runtime/src/host-connections.ts`：HostConnectionProvider 只构造连接；调用方拥有连接生命周期。
- `opencraft/packages/app-host-server/src/index.ts`：物理 Host Slot、客户端 claim、generation 和内部逻辑客户端路由。
- `opencraft/scripts/headless-server.mjs`：按稳定 Server ID 构造本机或 SSH 远端 CodexEngineAdapter；SSH 配置只允许私有监听入口。
- `ref/hypernode/policy/src/host-policy.ts`、`scripts/e2e-policy-over-ssh.mjs`：Desktop 风格 exec 包装、探测哨兵、SSH 内 WebSocket 握手与 /rpc。
- 不变量：稳定 Server/Thread 身份不随连接 generation 改变；页面 attachment 不拥有远端进程；请求隔离不能依赖远端理解 OpenCraft 内部路由字段；远端路径不得解析到本机文件系统。

## history_context
- current_design_refs：`opencraft/docs/platform-architecture.md`、`opencraft/docs/execution-ownership.md`；Client/Hub/Server 与 attachment/执行所有权边界。
- relevant_evolution：HyperNode REFERENCE-SNAPSHOT 标注 2026-09-14、source HEAD 76ed63d16449f219c8d6bcda53e54c1d67d12841，包含源工作区改动，不是干净发布版本。
- 最新 Codex Desktop 本地解包参考：`/data/codex-new/codex-26.930.31428-12913/unpacked/.vite/build/main-Bqm7CLTV.js`；实际 createSshProxyStream 使用 SSH exec、CODEX_REMOTE_PAYLOAD 登录环境包装和 app-server proxy。普通 Linux 启动路径另有后台 app-server bootstrap。
- superseded_refs：无。

## acceptance
- 一套 Desktop/HyperNode 兼容 SSH exec + WebSocket 连接，普通 Linux 实机只读验证通过；不自动安装、升级、启动或终止远端服务。
- 共享初始化、Client 身份与请求编号隔离、Thread 读者与单一交互所有权；旧回包不可落入后继 attachment，未知 mutation 不重放。
- 凭据与主机信任留在后端；公开匿名入口不能使用这些绑定。浏览器只投影连接展示元数据，不建立第二份持久配置。
- 测试、类型检查与协议浏览器验证通过；当前预览、实际完整 Workbench UI、真实 HyperNode 和付费推理均不冒称已验证。

## affected_paths
- 已实现：Daemon SSH transport/connections、共享 CodexEngineAdapter 的 remote 入口、AppHost failure wire、headless 配置/目录、builtin-agents 远端 profile、Web 目录读取，以及测试/探测脚本。
- 后续另行授权：公开 Hub 鉴权与逐 Server ACL、交互式连接配置页面、ensure-managed、远端附件/队列/Goal/PTY 等能力。

## required_context
- 根 AGENTS、OpenCraft AGENTS 与 opencraft-maintenance Skill。
- 路由未命中，不补载无关 Domain Pack。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`、`opencraft/AGENTS.md` | 仓库与分析权限 | 有界只读调查、保留脏工作区、禁止发布 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` 与 `references/verification.md` | 跨远端执行边界 | 所有权、不变量和验证范围 |
| `docs/context/tasks/TASK-TEMPLATE.md`、`CHECKPOINT-TEMPLATE.md` | 任务记录 | 留下事实与未验证项 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 邻居校验 | 核对 frontend/vitest.config.ts 测试入口 |
| `opencraft/docs/platform-architecture.md`、`docs/execution-ownership.md` | 现有共享内核 | Client/Hub/Server、路由、reader 与 interaction owner |

## evidence
- 本轮继续：路由 `OpenCraft SSH Codex Server 接入 选择 连接 恢复` 未匹配；读取维护验证、构建矩阵 headless 段、design README/invariants 与现有目录选择 Application 真源。
- 完整 Workbench 夹具首次运行：远端 catalog/连接/菜单可用；刷新后未恢复 Draft 文本，源码确认 ConversationScopeRegistry 是当前 Application 内存 owner，不把不存在的跨刷新持久化写成测试承诺。
- 同时发现目录选择强依赖 `project/create`；新增只在明确 -32601 时允许同 Server cwd-only Draft 绑定，不吞权限/网络错误，不创建本机项目。完整桌面/触控界面验证正在进行。
- Context router queries `opencraft remote SSH Codex Server hypernode compatibility connection execution ownership` 与 `opencraft SSH Codex remote Linux HyperNode transport broker execution ownership` 未匹配。
- 有界搜索 apps/packages/plugins 的 app-server proxy、ssh2、direct-tcpip 未找到通用 SSH Codex 连接实现；remote-ssh 仅见类型/展示入口。
- AppHostServer createTransport 当前按 hostId 共享物理连接；logicalClientRouting=true 在连接内传 OpenCraft 字段和 runtime/client/disconnect。不能原样向外部 AppServer 转发，否则初始化、请求 ID、订阅与服务端提问隔离均未获得保障。
- HyperNode exec 路径在 SSH 通道中承载 WebSocket，不是纯行式 JSON stdio；go/vssh 栈能力不同，不可默认依赖 SSH 端口转发。
- THREAD_WRITE_LEASE 区分透明 Codex turn 的执行 epoch 与 mock/system 的资源写 lease；不能把远端断线承诺为统一的“任务继续/终止”。
- 文件定位失败记录：不存在的 apps/opencraft-server、app-host、appserver-websocket-transport 已用 rg --files 纠正；最新分析目录文件名搜索无匹配，改为已列出的原始 main bundle 有界摘录；node 不在 PATH，改用已知绝对路径。

## risks
- 普通 Linux Codex 版本不具备 proxy/Unix Socket 能力；明确诊断，不自动退成会丢执行宿主的 stdio 子进程模式。
- 私钥、主机密钥首次确认与变化不能下放浏览器或默认为跳过校验。
- 同 SSH 登录用户不代表相同客户端 attachment；缺隔离会引入响应串台、订阅误退和提问重复处理。
- native Desktop 启动脚本含 pkill；借鉴协议，不复制可能杀死其他客户端进程的策略。
- 本地附件、队列、Goal 和账号池能力不能通过复用 CodexEngineAdapter 冒充远端能力。

## validation
- 普通 Linux 9.134.163.40:36000：隐藏 TTY 登录，CLI 确认 Codex 0.147.0、proxy 与 `--sock`；新实现真实 initialize/thread/list/model/list 成功，无推理、文件或服务管理写入。
- `test:appserver` 本机回归 251 通过；新增 `test:ssh-codex` 最新 17 通过、1 跳过（本机没有 sshd privilege-separation runtime）。新测试已接入 appserver 常规门禁。
- AppHost/配置/Host profile 聚焦验证通过；`test:bot-management` 32 通过；六个受影响 workspace 类型检查及 `check:boundaries` 通过。
- `smoke:ssh-codex-browser`：真实 Chromium + 浏览器 AppHost/JsonRpcAppServerClient、实际服务器和 remote adapter，共享物理连接、页面退出与刷新通过；仅 SSH exec 上游为合成协议夹具。不是完整 Workbench Shell 视觉验收。
- 文档链接与正式设计影响校验通过。全仓 context 测试 23 通过、4 失败，失败含存量 Task Pack 字段缺失、既有 Context 约束和参考 instruction 链；context-audit 测试 33 通过。不能宣称全仓门禁全绿，不修改无关文档消除失败。

## decisions
- 提议：一套 SSH 认证/信任/通道/重连底座，上层为 Codex AppServer；Bootstrap 分 attach-existing 与明确授权的 ensure-managed。
- HyperNode 默认 attach-existing；普通 Linux 可 attach-existing 或 ensure-managed，但仅管理显式授权的私有 runtime，不杀其他 Codex。
- 内部逻辑客户端协议终止于我们 Hub 的路由适配边界，不要求外部 Server 实现 OpenCraft 字段。
- 细化后的建议：按 tenant + Server + 已授权远端身份/命名空间维护一个后端上游会话；在 Hub 内多路复用 logical Client，不按网页分配 SSH。不要跨授权作用域合并连接。抽离现有 CodexEngineAdapter 的初始化、ID 映射、订阅、交互路由内核；本机进程、账号池、附件和队列仍留给各自 owner。此决策是方案建议，尚未实现验证。
- 远端文件优先 AppServer 文件能力；普通 Linux SFTP 可是显式可选能力，不能是 HyperNode 的隐含前提。

## scan_scope
- ref/hypernode README/docs、host-policy、server、虚拟 WebSocket 测试、SSH e2e；OpenCraft transport/provider/daemon/headless/AppHost；最新 Codex 原始 Electron main bundle 的 SSH 相关片段。

## scan_output
- 关键协议事实见 evidence；无全仓扫描产物。

## proposed_design_details

以下保留实施前方案及候选能力，不能据此认定全部实现。当前边界以本文 implementation_receipt、正式 [SSH 连接文档](../../../opencraft/docs/ssh-codex-servers.md) 与源码/测试为准。

### 接入与最小充分结构
- 目标链路：Client -> 既有 AppHost/Hub 通道 -> 后端 Codex RPC broker -> SSH exec Duplex -> ws /rpc -> 远端 Codex AppServer。
- SSH adapter 为后端 Node 代码，不进入浏览器 bundle。Renderer 的 provider 只创建既有 Hub channel transport，不接触 SSH/key/remote shell。
- 第一实现建议使用系统 OpenSSH + 已有 ws：与最新 Desktop 一致，可使用 key、SSH agent、管理员批准的 SSH config/jump 配置；不新增手写 WebSocket 编解码。不能同时维护 OpenSSH/ssh2 两套默认实现。
- 首期认证范围为公钥/受控 agent。密码或交互挑战不通过 stdin 塞进协议通道，不因用户曾提供过密码而复制到新远端配置；确需支持再明确非交互凭据端口。
- 分三个实际边界：SSH transport（字节/认证/错误）、remote bootstrap（附着或明确授权启动）、Codex broker（协议路由/订阅/交互）。连接管理与现有 AppHost 生命周期接通，不建立第二套 Thread/历史数据库。
- transport 只消费配置化启动策略，不通过产品名 if/else 判断 HyperNode；两种目标都使用 Codex SSH WebSocket 契约。

### 配置、身份与权限
- 后端保存 endpoint/port/user、credentialRef、known-host trust reference、Codex executable/home 或既有服务寻址、startup policy、稳定 serverId 和配置 revision。客户端只看授权后的展示/能力/route 元数据。
- serverId 不从 IP、socket、主机密钥或 credentialRef 自动推导；配置 authority 绑定稳定远端命名空间，改 IP/换密钥是连接变化，改为另一远端资源必须显式重绑定或新建 Server。
- SSH credential rotation 与远端 principal/命名空间更换分开处理，不能拿 secretRef 作为资源持久身份。
- 远端身份无原生稳定证明时，serverId 是管理员绑定，不宣称 initialize 的 codexHome 或 userAgent 是可信远端 UUID。
- 首次主机密钥人工确认或预置 pin；变化为人工处理故障，不自动接受。私钥只由后端凭据 owner 读取，权限限制且不写日志/浏览器存储。
- HyperNode bootstrap none/root-key issuance 不作为普通自动连接流程；已有 key 最直接，首次注册是独立管理员流程，敏感通知不可扇出到所有网页。
- 当前 headless 公开模式明确无认证；启用远端连接管理前必须确保 Hub attachment 鉴权与 tenant ACL。未授权 Client 不得使用后端 SSH 凭据，任意 endpoint/ProxyCommand 不可由匿名输入提供。

### 连接准备与启动
- 先尝试附着：Desktop 风格 exec payload + 随机哨兵 -> 哨兵截取器 -> ws.createConnection(Duplex) -> /rpc upgrade -> AppServer initialize。
- 地址 ws://codex-app-server/rpc 是 SSH 内 HTTP 逻辑目标，不能真的向公网 DNS/TCP 发连接；HTTP 握手和尾部数据全部经 SSH Duplex。
- 哨兵扫描必须处理 login banner、分片和同包后续 WS 数据，有界缓冲，超时清理；stderr 独立收集并脱敏，不混入 JSON-RPC。
- attach-existing 失败不自动启动或安装。HyperNode 走此策略，不运行 Linux OS/process 探测、SFTP 或 nohup。
- ensure-managed 仅适用明确授权 Linux：检查已有安装和版本，按目标运行时 single-flight；可附着即复用，否则只启动所管理实例。不复制 pkill、自动升级或 kill 用户 Codex。
- Unix Socket/proxy 如何选择特定实例是实施前的原生 CLI 门禁：本机 checkout 和新解包未找到可运行的原生 Codex；不能虚构支持 socket 参数。若只能通过 CODEX_HOME 隔离，必须说明会改变历史/凭据命名空间，不能静默使用新 home 冒充原 Server。
- 本轮不把 stdio fallback 当作默认兼容方式；SSH stdio 子进程的连接寿命与后台服务不同，需要另一个显式执行契约。

### 共享上游 broker 的责任
- 每个物理 generation 只初始化一次；逻辑 Client 初始化读取经过验证的本 generation 回执，不把第二次 initialize 发给同一上游。
- upstream initialize 由后端定义固定客户端能力，不能由首个网页恰巧选择；通知 opt-out 在逻辑投影层处理，不替共享连接抑制其他读者所需事件。
- 请求映射键包含 client incarnation、上游 generation、类型保真的 request ID；上游使用独立唯一 ID，回执只返原 Client，不广播。
- Thread reader refcount 属于 Hub；最后一个页面离开但存在活动 Turn、审批/提问或待对账操作时，不关闭上游或 unsubscribe。
- Server request 保留原生 pending 身份，仅当前已授权 interaction owner 可答；断开先撤答复权，后继 Client 经明确恢复/认领后重投。不能广播同一可答请求给所有读者。
- Native process、watch、搜索 session 等连接资源单独记录 logical owner 和 generation；只知道 threadId 的路由器不够。后继连接不得向旧 processId/watchId 发控制。
- read-only Client 不能通过订阅隐式取得 turn/control/approval 权限；所有操作仍需 Hub tenant/Server ACL 和远端准入。
- OpenCraft __opencraftClient/runtime/client/disconnect 只在本地 broker 边界消费，不要求远端支持。不能关掉 logicalClientRouting 后直接全量广播。

### 故障与恢复
- Browser->Hub 与 Hub->SSH 是两条独立恢复链。网页重连只恢复 logical attachment/读者状态，不触发杀进程或新建 Turn。
- 只有后端连接 manager 调度 SSH 重连，按运行需求保持，single-flight + 有界退避/抖动；浏览器重试是 hint，不是第二个上游重连 owner。
- SSH keepalive 检测链路；WS ping/pong 检测 /rpc 通道（HyperNode virtual-websocket 源码支持 ping）；AppServer initialize 与 Thread baseline/status 对账单独证明协议/会话 readiness。
- 网络/临时远端故障可自动重试；认证、主机密钥、协议不支持要人工处理。AppHost wire 应明确携带 failure disposition，状态去重比较需包含 failure.code/recovery，不只 state/reason。
- 重连提升 generation、丢弃旧帧；重新初始化并恢复需要的 Thread 基线/订阅。读取基线失败只影响该 Thread，不清历史、不让整个连接变成不可用。
- 请求未写入可确定未发送；写入后响应丢失是未知结果。mutation 不自动重放 turn/start/steer/fork/file write；先按稳定操作/Turn/Item 身份对账，无充分证据保留原输入并允许人工处置。
- 后端重启不等于可自动恢复完整审批队列；无远端 pending 查询/replay 契约时不能宣称完整恢复。持久化本地投递意图只辅助对账，不升级为远端执行真源。
- 空闲回收只在无读者/执行/交互/待对账资源时进行；关闭连接仅关闭自己的 SSH/proxy，不代表调用远端 kill。

### 能力和远端文件
- 已读原生 InitializeResponse 和 HyperNode initialize 仅返回平台/home/userAgent，没有完整 server capability catalog。能力来源为明确的 remote 声明，或 adapter 的已验证协议/版本 profile 与安全只读探测，不用函数名/类型生成物假定支持。
- 只读探测方法不存在和权限拒绝是不同结果；不能把 transient timeout 标为永不支持，也不能创建 Thread/运行模型/写文件来偷偷探测能力。
- 基础列表/读历史/恢复/发送/停止/原生 steer 优先接通；本地 attachment/stage、queue v2、Goal、账号池不得无条件加到远端 initialize 回执。
- Explorer 使用 fs/readDirectory/getMetadata/readFile/writeFile，终端使用远端 command/exec 契约；SFTP 只是 Linux 可选后续能力，不是 HyperNode 的前提。
- 附件需要远端落盘路径（并由远端可读）与结构化引用持久化能力完整接通才开放；我们的 /var/lib 路径不得发给远端当文件可读位置。
- 数据大小/base64开销、帧上限、读写背压及每 Server 的 pending 请求/缓冲上限必须有界；不能用无限 Buffer.concat 或请求表累积掩盖弱网。

### 默认跟进方式：已单独完成
- 实施与预览切换证据见 [默认跟进 Task Pack](2026-10-04-opencraft-default-steer.md)。下列为当时分析，不再视为当前源码缺口。
- 默认运行中发送直接 Steer；设置可切换为排队；空闲时普通发送不受该偏好影响。发送时读取实际 active Turn，任务已完成的竞态沿用正常下一轮准入。
- 已有 CodexComposer.defaultFollowUpAction 接受 steer/queue，默认 queue；主 App 未传该 prop，临时 SideChat 显式 steer。沿用此窄 contract，不把选择下沉为 SSH 或远端全局设置。
- 默认值和持久化归 UiPreferencesRuntime；建议新增 installation-scoped chat.defaultFollowUpAction 枚举，缺失值默认为 steer，有效已保存 queue 不被升级覆盖。设置与 Composer 消费同一状态，React 不自建 localStorage 副本。
- 建议用户可见设置在“聊天”中用“回复时立即跟进”开关，开启表示 steer、关闭表示 queue；文案解释用户行为，不展示协议方法或投递内部状态。
- 主 Web/Electron 会话使用该偏好。临时侧聊无持久队列，不能盲目把 queue 传入制造不可发送状态；能力不支持时展示明确限制或保留其已声明的直接跟进策略。嵌入宿主不提供设置页时仍可消费共享默认，不单独建偏好。
- 默认直接 Steer 与已排队消息的 atomic queue-to-steer 是不同操作；前者不要求 queue v2，后者仍服从其真实 Host capability。不能因为设置开启就伪造远端原生 steer 支持。
- 不支持原生 steer、目标 Turn 已失效、投递失败或结果未知时保留输入/对账，不悄悄改为另一个用户意图或自动重发。
- 已有 Ctrl/Cmd+Enter 可反转 defaultFollowUpAction；保留显式单次覆盖，不让更改偏好重挂载编辑器、清空草稿或更改已入队消息。
- 实施验证：默认 steer、保存 queue 后刷新/重启仍记忆、两窗口同步、运行中点击/Enter/修饰键的实际提交 target、空闲发送、任务结束竞态、设置切换时草稿/附件/选区不变、临时侧聊能力约束。

### 分期与改动面
1. transport/handshake 夹具：真实本地 SSH 测试服务 + ws，覆盖分片哨兵、banner、帧、失败清理和心跳；不依赖真实账号/模型。
2. 抽出并验证 broker 内核，本机 stdio 与远端 transport 同测，覆盖 ID 冲突、两 Client 订阅/退订、旧 incarnation 迟到回执、单一审批答复权。
3. 接入后端配置/catalog/鉴权和 headless factory；Frontend 只接现有 channel/profile，不重写会话或滚动体系。
4. 普通 Linux 和 HyperNode 实机验收；安装/启动/模型测试按授权执行。高级附件/队列/Goal 按能力另接，不以菜单出现为完成。
- 候选代码边界：新 Node SSH package、抽离共享 Codex broker、opencraft-daemon/main 与 headless factory、app-host wire/client/server 的状态契约、workbench provider/profile 展示投影、相关协议/连接/测试文档。
- 成本是中等跨边界实现，不是几行 createTransport；最大工作量是把已存在的本机混合 adapter 拆成可测试的路由内核，而非 SSH 字节连接本身。

### 必须能证伪的验收序列
- 两个 Client 都发 id=1，回执逆序返回，彼此不串；同名 Client 重连后旧回执不得落入新 incarnation。
- A/B 读同一 Thread，A 关闭时 B 流式不中断；所有网页断开但 Turn 仍执行，后端保持连接，重连能取终态。
- A 持有审批后断开，B 恢复认领；A 迟到回复不能越权，B 只能响应一次。
- SSH TCP 存活但 /rpc 不回复 pong，判失败并清理；旧 channel 晚到帧不能更新后继 generation。
- 远端拒绝方法、权限不足、主机密钥变化、文件过大各自正确分类，不都变成 30 秒超时。
- turn/start 已接纳但回执丢失，恢复不得再创建一轮；无法确认时保留消息而不重复执行。
- Linux 普通路径与 HyperNode /localhost 文件访问皆在远端，无本地 FS 穿透；Client 不能控制其他 Client 的 PTY/watch。
- ensure-managed 两个并发连接意图只创建同一授权实例；连接关闭及 Hub 重启不得扫杀其他 Codex。

## handoff
- 后端基础 SSH 链路已实现并实机只读读通，复用而非复制逻辑路由内核。未提交/发布/重启当前预览。
- 当前 80 端口是匿名公开入口；SSH 绑定明确禁止接入此模式。正式开放前需要带认证与逐 Server 授权的入口，不能以反向代理或换端口代替权限建模。
- 原生 turn/start/steer/fork 等路径已接通与合成测试，未在用户服务器发起真实推理/创建会话。远端附件、终端、队列、Goal 尚未开放，真实 HyperNode 未实机验证。

## implementation_receipt
- Transport：系统 OpenSSH、严格 known_hosts、八字节哨兵、登录 shell payload、ws.createConnection；有界 banner/帧/缓冲、连接超时和 WS 心跳。key/agent/密码 resolver 认证；密码经私有 askpass IPC，不进入 argv/env/协议 stdin。
- Broker：本机和远端共享 CodexEngineAdapter；remote 不构造本机账号/附件/队列，固定后端初始化策略，不让首个页面决定共享 capabilities。允许的原生请求才转发；无 ID 的 mutation 通知不能绕过逻辑所有权。
- Client：稳定 `ssh:<name>` 绑定、单物理初始化、类型保真的请求 ID 和 incarnation fencing、reader 引用与单一审批答复者。请求写入回执须实际 await；丢失回执不重放。原生 fork 不添加固定 deadline，其他 pending 与初始化等待均有界。
- 配置：owner-only 后端文件加载、重复身份/任意 shell/明文密码字段拒绝；catalog 只返公开展示 DTO，通过已有 Headless provider 注册 activation-owned profile。目录失败不阻断本机 Server 扩展，旧后端 404 兼容。
- 失败保留：浏览器首次因缺 libgbm 无法启动，复用已有 `/data/lightvela-rpms/usr/lib64` 后通过；夹具分片哨兵与 HTTP 提前交错造成一次测试失败，已纠正夹具的实际字节时序。远端 `daemon status` 不存在，未据此执行 bootstrap。
