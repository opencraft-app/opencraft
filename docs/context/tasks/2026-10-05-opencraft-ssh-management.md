---
id: task-opencraft-ssh-management-20261005
type: task
scope: Backend SSH connection management persistence, authorization and Settings UI.
triggers: ["SSH management", "远程连接管理", "connection settings"]
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/docs/ssh-codex-servers.md
  - opencraft/apps/opencraft-daemon/src/ssh-management.ts
status: active
reviewed_at: 2026-10-05
review_due: 2026-11-30
revision: 1.0.0
precedence: task
derived: false
---

## goal
把已实现的后端 SSH Codex 接入扩展为数据库持久化、受保护的设置管理页；支持添加、编辑、启停、重新连接与删除。

## non_goals
- 不修改生产、提交或推送；现有匿名本机入口不变，不把远端 root 绑定暴露给匿名访问者。
- 不安装、升级、停止远端服务；删除连接不删除远端数据。真实凭据不进源码、日志或浏览器持久存储。
- 首期是部署管理员拥有的连接，不冒称完整多租户成员授权或 LightVela 登录已接通 SSH 权限。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户允许接上，要求默认数据库存储与设置管理页，给出 Codex SSH 列表截图。
- 后续报告一直待连接及菜单图标/文字错位，要求复用成熟菜单控件；此次仅修复与隔离验收，不自动替换当前预览。

## interface_refs / data_structure_refs
- `opencraft/apps/opencraft-daemon/src/ssh-codex-connections.ts`、`ssh-codex-transport.ts`：后端私有绑定与物理通道。
- `opencraft/scripts/headless-server.mjs`、`serve-workbench-web.mjs`：HTTP/WebSocket 准入和部署入口。
- `opencraft/plugins/builtin-agents/src/index.ts`：设置页、授权 profile 与既有 provider 注册。
- `opencraft/packages/app-host-server/src/index.ts`：共享连接、generation 与撤销。

## history_context
- current_design_refs：`opencraft/docs/platform-architecture.md`、`execution-ownership.md`、`ssh-codex-servers.md`、`design/invariants.md`。
- relevant_evolution：基础 SSH Task Pack `2026-10-04-opencraft-ssh-codex-compatibility.md`；Linux 只读协议已验证，完整 Workbench 桌面/触控合成上游验收通过。
- superseded_refs：旧“只允许 loopback 私有 JSON”是兼容入口，不再是完整配置 authority。

## acceptance
- 配置重启后保留；数据库不含明文密码，密钥不进入数据库，DTO 不返回凭据。
- HTTP 和 WebSocket 同时授权；猜 Server ID、伪造 rendererId、过期会话不能取得远端能力或消息。
- 修改受 revision/CAS 约束；取消和迟到结果不覆盖编辑；行级操作不改变其他表单。
- 实际设置页桌面/触控验收；隔离构建、相关测试与类型检查；源码和当前运行版本分开报告。

## affected_paths
Daemon SSH 管理 store/controller、headless web HTTP/WS、builtin agents 管理页/profile、协议与测试/正式设计。

## risks
- 安装管理员共享授权不是逐成员 ACL；默认固定 HTTPS Origin，用户可显式启用不固定地址的 public-access 模式。两种模式都保留私有访问密钥；HTTP 模式不提供传输加密。
- 丢回执不能证明未提交，刷新核对再操作；不自动重放远端 mutation。
- 未知/冲突 schema 拒绝写入，保留原库；备份密文数据库不等于保留凭据解密密钥。

## scan_scope
OpenCraft Daemon/AppHost/协议/Workbench runtime、builtin Settings 与固定上下文任务目录。

## scan_output
命中入口与验证摘要在 evidence/validation；无完整源码、历史、凭据或全仓扫描内联输出。

## required_context
根/OpenCraft AGENTS、维护 Skill 和完整验证清单；Context Router 本次查询未匹配。

## context_receipt
- 实际读取根/OpenCraft AGENTS、维护 Skill/verification、platform-architecture 与 execution-ownership（基础任务）、document-storage SQLite/contract、SSH config/catalog、Settings 与 AppHost/HTTP 实现。
- 邻接卡 frontend-runtime-openspec-i18n 已读；本任务不修改 frontend 生成层。

## evidence
- Router query `OpenCraft SSH connection management settings database backend authentication Server ACL` 未匹配。
- 当前 AppHost accept 只使用逻辑 rendererId，没有可信登录主体；同源校验不能替代 SSH 授权。
- 旧配置只读私有 JSON，catalog 启动时注册；没有数据库 CRUD 或动态管理页。
- 路径猜测 lightvela-account、settings menu、package-headless-server/test.ts 失败；已用限定目录 rg --files 修正为 lightvela-platform/account、Radix/Modal、package-headless-linux、headless-server.test.mjs。

## decisions
- 部署级后端数据库拥有配置，连接 owner 管 revision/物理通道；页面只拥有编辑草稿、互斥菜单与行级操作。
- 凭据加密与配置同事务提交，密钥是 owner-only 后端文件；主机密钥必须显式核对，不接受无校验连接。
- 安装管理员授权区使用后端验证的短期 HttpOnly 会话；不把 Renderer 登录投影当权限证明。

## validation
- 四个受影响 workspace 类型检查和平台边界/字体门禁通过；共享控件测试 18 项通过。
- AppHost + 管理 + controller 聚焦测试通过；Headless/浏览器传输与管理联合 27 项通过。最终 SSH suite 33 pass、1 skip（runner 无 isolated sshd），不是实机 HyperNode 验收。
- 隔离 headless Web 构建成功；真实完整 Workbench 桌面/触屏解锁、核对指纹、添加、刷新保留、菜单转弹窗、修改、启停、选择动态目标、重连、删除和锁定通过，远端 exec 为替身；无真实推理或远端写入。
- 截图验收发现共享列表按钮 reset 误改 Switch track，修正共享控件选择器并增加控件/浏览器回归；最新构建、最终桌面/触屏截图与管理烟测均通过。旧静态配置 Workbench 烟测也通过，验证目录选择、历史恢复、刷新与共享物理连接。
- 密钥丢失拒绝恢复且不生成替换密钥；旧 revision 的 credential resolver 不可读取轮换后的密码，两条最终回归通过。
- 管理 Task/Checkpoint 元数据错误为零；全仓 context validator 存量 4358 错误、route smoke 0 失败，未把全仓失败归为本任务绿灯。
- npm lock 本来包含大量跨功能未提交改动，本次 package-lock-only 随当前 workspace package.json 机械规范化；未将整份 diff 认领为 SSH 功能改动。
- 上述为此前源码验收。最新候选/数据接入情况见 preview_delivery_20261005；未提交/推送/生产发布。完整 gate 未运行，不声称全仓门禁绿灯。

## handoff
当前执行阶段见同名 checkpoint；保存失败/未知结果保留草稿，不自动重发远端业务操作。

## remote_restore_diagnosis_20261005

### 2026-10-05 source-and-preview-delivery authorization

- 源码提交 `468da9350` 已推送修复分支；原基线完整 `npm run gate` 退出0，包含Web/Expo Web/iOS构建。最新master为 `7698f334f`，在独立checkout合并避免碰无关dirty。冲突只涉及嵌入账号preflight import及资源面板preview enabled；同时保留master行为与SSH能力准入。集成后验证、远端master合并和实际临时预览切换尚未完成。
- 检索失败：全仓diff name-only经Node默认buffer读取出现ENOBUFS；不重试巨大输出，改限定任务路径与独立worktree。无秘密输出；原工作区其他改动保持原状。

- 最新用户“提交推送合入master 然后替换”授权本次 SSH 链路变更提交、推送、合入 master 以及当前临时预览前后端替换；不包含其他服务、GitOps、永久部署指针或公开镜像。提交范围含本任务此前已实现/验证的目录恢复与当前 native surface 一致性，不带入其他 dirty 文件、凭据、.kube 或 ref。
- Router query `OpenCraft SSH native surface submit push merge master replace self hosted preview` 无匹配；读取维护、自托管 Skill、验证清单、构建矩阵、正式 agent-request-streaming 设计与 SSH 构建/smoke 邻居。按规范使用独立切换监督者和旧包回退，不同步重启当前进程。
- 初始 Git fetch 缺默认 helper；显式 helper 配合 useHttpPath=true 无法匹配已有 host-only credential。只对已授权 mono2 请求使用现有私有 helper 的 host lookup 后 fetch 成功，未修改全局配置、未输出或复制秘密。最新 origin/master 为7698f334f，包含当前基线，需合并其后续更改并重新验证集成源。
- 暂存37个本任务文件；真实 staged change-impact、diff check 与凭据字面量/私钥扫描通过（泄漏0）。前次空 staged 检查不能替代本次实际范围。完整 OpenCraft gate 已启动，尚无通过结论；集成/构建/切换证据继续追加。

- 最新用户截图确认SSH目录已显示，选择“文档”却无法恢复；此轮仅定位，未修改产品源码、替换或重启服务。
- 已批准目标的隔离SSH只读探测：thread/read及thread/resume成功，恢复响应必需字段及runtimeWorkspaceRoots有效，historyMode为字符串且有历史分页cursor。无推理、远端文件写入或凭据输出。
- 修复前使用真实CodexEngineAdapter与WorkbenchRuntime复现同一会话：逻辑方法initialize/list/queue-list/resume/turns-list；物理通道仅initialize/initialized/list/resume。恢复原生请求成功后，Runtime收到AppServerRpcError -32601、固定错误This operation is unavailable on the remote connection，phase=error且authoritative=false。原失败事实记录于本段；同一路径 `/data/opencraft-ssh-resume-diagnose-ZXNFfV/runtime.json` 后续已由新源码复验更新为成功回执，schema.json保留类型/计数记录，不含历史内容。
- 根因：`apps/opencraft-daemon/src/codex-engine-adapter.ts`的REMOTE_CODEX_METHODS漏掉thread/turns/list，而共享session的paginated history策略必须调用此方法；当前运行的server.mjs相同规则亦缺该项。这是本地桥接准入遗漏，不是远端密码、数据丢失或thread/resume失败，重试不能跨过该规则。
- 旧合成SSH Workbench夹具未声明historyMode=paginated、恢复cursor为空，仅验证thread/read路径，遗漏真实服务器分页恢复。实施时需补远端adapter与共享Runtime整条历史恢复回归，而非仅断言方法名称。
- 前端管理请求12秒、SSH握手15秒的时间差会提前显示未确认，但不是此次已确认的恢复失败根因。不要通过放宽该deadline或刷新Web冒称解决恢复问题。
- Router本轮查询`OpenCraft SSH connecting unknown outcome screenshot CodexEngineAdapter backend connect diagnosis`未匹配；定位沿已知adapter/session/真实部署包有界检索。一次误猜ssh-codex-adapter测试路径已改为实际codex-engine-adapter.test.ts；首次诊断逻辑通道漏stamp client identity，修正诊断器后才记录上述真实Runtime失败，未修改产品规避。
- 后续修复属于后端桥接规则与分页兼容验收；不取消remote allowlist、不新增连接或历史owner。当前仍为20261005-ssh-discovery-recovery Web及原后端，不宣称已修复或发布。

### remote_surface_audit

- 最新用户“搞起来”授权实施上述模型边界与相关验证，不含预览替换/重启、Git或远端写入。Router query `opencraft SSH native AppServer surface capabilities history queue composer consistency repair`无匹配，按既有相关路径有界检索；保存dirty worktree与既有SSH发现变更。
- 实施计划：明确native connection-independent RPC路由surface，不依据SSH删掉恢复必要接口；initialize保留上游无冲突字段并投影已路由lifecycle与method access（后者仅表示bridge准入，不冒称native方法一定支持）。Runtime统一消费准入声明，阻止不支持队列的本地adoption/background hydration；Composer按当前Host可用follow-up动作呈现，偏好不创造能力，快捷键不绕过。Skills/config默认写入补原生路由；连接级搜索/watch/PTY和本机扩展维持拒绝，消费者停止发起/误报空/永久loading。测试须覆盖真实paginated恢复、第二页、能力投影、排队草稿不丢和不支持动作的前后端一致性。

### native_surface_implementation_result

- 已实现单一共享 native surface 与 `opencraft/method-access` v1 bridge admission contract；桥接过滤和 initialize 投影消费同一清单，保留上游 metadata/无冲突扩展。补齐 turns/items 分页、Skills、默认配置写入和已路由 Thread lifecycle 声明；连接句柄/本机 store 仍拒绝，不把桥接准入冒称上游实现保证。
- Runtime 的 Host resource 暴露当前 initialize 声明，只派生、不复制可写能力状态；Protocol resource、提交收养前、command port 编译前检查准入。未准入 Queue 不发后台 hydration 或提交，不创建失败占位；输入内容仍可提交。配置写入能力与读取成功分开，workspace 不发不支持 watch/search 请求，搜索输入禁用但目录仍可浏览。
- Composer 在 core 统一选择可用 follow-up action。SSH 只有 Steer 时，Queue 偏好不被改写，按钮及 Ctrl+Enter 只执行 Steer，不显示不可用的反向 Queue 提示；没有可用 action 则保留草稿。没有 manifest 的旧 Server 保持兼容，畸形声明 fail closed；UI 不输出方法名或技术状态。
- 已批准真实 SSH 目标上的“文档”使用新源码只读复验：phase=live、authoritative=true、error=null；物理方法含 turns/list 与 items/list，不再发送 queue/list。没有发送消息、写配置或远端文件；Skills/config write 仅合成边界验证，实际推理/配置写入未验证。
- 聚焦新增跨层测试通过：真实 SshCodexTransport framing + CodexEngineAdapter + WorkbenchRuntime，仅 SSH exec 替身；paginated resume、items 读取、旧页在新页前、刷新回答不重复、拒绝 Queue 时无本地收养/草稿不丢。SSH suite65pass/1skip（无本机sshd运行环境），AppServer全套通过，Chat全套471pass；新增 command-port 编译前拒绝与 core follow-up 断言合并复验41/41。六个修改 workspace 及 protocol 类型检查、边界/字体、i18n、diff check 通过。
- 实际新构建 Workbench 桌面/触屏、浅色/深色，idle 与 active 两组烟测均通过：选择/目录/草稿保留、真实分页历史/刷新、单一物理连接；active 场景在真实设置关闭默认 Steer 保存 Queue 偏好后，按钮及 Control+Enter 共8次仅调用合成 native Steer，零 Queue RPC。替身止于 SSH exec，无真实模型推理/远端写入，未冒称手机/公网验收。
- 隔离 Web 产物 `/data/opencraft-ssh-native-surface-eWGxoW/web` / buildId `20261005-ssh-native-surface`。本轮未替换/重启/Git，当前80端口仍 `20261005-ssh-discovery-recovery`，原后端 SHA256 `96b6fc0042b4d348fe42e298253185d5703e4021e84c94c25923d75dc1f00347`。只读复核发现同一unit PID已从1048792变为2120682，但包路径/hash未变、health正常；不是本轮操作，原因未调查，不能声称进程一直未变。
- 正式设计同步 SSH 专题、platform-architecture 与 SSH-09 不变量；根 documentation检查0 errors，change-impact --staged通过但变更未暂存，因此不把空暂存集作为本轮 diff 覆盖证据。完整 gate、物理 iPhone、真实远端推理/配置写入未验证。
- 失败记录：constructor缺services/每Turn一个Frame错误测试断言已改真实contract；嵌套npm吞outDir已改直接workspace；隔离headless静态Host漏kind已用packager真实配置重建。active smoke 误把含placeholder widget的DOM textContent当空文档，改为真实空文档的placeholder呈现及编辑区不含已提交正文，同时校验实际Steer wire次数；未修改产品或放宽RPC断言。菜单/布局并非本轮新UI。
- 下一步如用户授权替换，必须同时构建/验收新后端与新Web；仅更换 Web 不会解决桥接分页拒绝。沿既有自托管独立切换/回退流程，重新核对实际owner，旧包与共享数据保留。不自动发布或重启。

### 修复前审计记录（历史）

- 用户询问是否还有同类问题，并指出SSH理论上只增加连接握手/安装，要求解释差异。此轮保持诊断，不修改产品或服务。
- Router query `OpenCraft SSH remote Codex adapter missing RPC methods restore history queue capability audit`因通用adapter触发误路由CTL；已完整读取must_read服务卡，任务不触及CTL实现，随后回到已知OpenCraft目录有界搜索。重读维护Skill/完整verification、SSH专题与frontend-runtime-openspec-i18n邻接卡，检查实际ssh-codex-routing.test.ts测试邻居。
- 隔离合成physical边界审计 `/data/opencraft-ssh-resume-diagnose-ZXNFfV/audit.json`：turns/list、skills/list、config/batchWrite、queue/list/add、文件搜索、process、watch、附件与Goal均本地拒绝-32601；name/set、archive、fork则转发。无网络/推理/远端写入。原生capabilities.extensions在remote initialize投影中整块替换，只剩first-turn durability；合成声明的resume-history因此丢失。这台实机initialize原本未返回capabilities，不能把合成丢失冒称当前实机直接根因。
- 实机只读直连skills/list成功（cwd条目1），桥接器同方法拒绝，明确属于原生读取遗漏。回执native-audit.json仅类型/计数/扩展名，不输出技能内容、用户历史或凭据。
- 其他共享消费缺口：CodexComposer/App.sendMessage按用户偏好允许queue/逆向快捷键，不检查SSH是否支持queue；command-port提交thread/queue/add必被拒绝，binding后台queue/list又吞错。config/read成功被useComposerCatalog当成读写均支持，rememberModelDefaults暴露，config/batchWrite在桥接处必被拒绝后仅invalidate旧默认；不做远端配置写入验证。
- Workspace文件watch和搜索是已有暂未支持边界，但View仍调用并吞错；当前搜索session获取失败后query Effect仍可能设searching=true且因sessionRef为空不结束，需要能力准入/明确不支持反馈，而不是无条件开放连接级资源。未执行用户真实界面操作，不冒称当前用户已遇到这些问题。
- 附件/Goal/PTY/connection watch/search/account/queue v2按正式SSH首期契约未暴露，其中Goal/附件等已有capability gating，不把所有拒绝都归为bug。线程rename/archive/fork原生转发已列入allowlist，但远端没有lifecycle capability投影，UI按capability可能不可操作；这是产品能力声明不完整，不是接口转发失败。
- 架构原因：SSH transport本身保持相同native JSONRPC；CodexEngineAdapter kind=remote同时改变可调用surface、initialize投影与本地扩展构建策略，共享Runtime/Composer仍假定本地完整能力。应分开Transport、原生Engine协议、按执行位置拥有的OpenCraft扩展、共享Hub逻辑路由；基于已核实能力及资源身份开放操作，不以SSH标签剪裁原生读取，也不将本机文件/PTY/队列owner假借远端。
- 现有远端路由测试7/7通过，证明它们覆盖ID/epoch/授权owner/timeout/不重放，却未涵盖真实分页恢复、技能目录及UI能力一致性；通过不代表用户功能完整。被中断测试session无法续读，重跑取得明确退出0；文件猜测command-port/workbench-resources/chat-ui/controller不存在，已限定rg --files到composer-appserver/codex-composer/composer-core真实路径。未提交/发布/重启。

## remote_catalog_followup_20261005
- 用户确认 SSH 服务器上的会话不显示，授权继续修复并参考 Codex；不包含重启/替换、Git 或远端 mutation。
- Router query `OpenCraft SSH connect remote conversation sidebar catalog codex reference` 未匹配；已做 Web runtime/builtin controller/既有 smoke 有界搜索，读根/OpenCraft AGENTS、维护 Skill 与完整 verification、SSH 专题、平台架构的应用/SSH/会话所有权部分。检查 frontend-runtime-openspec-i18n 邻接卡及 SSH 管理烟测邻居。
- 参考版本 `/data/codex-new/codex-26.930.31428-12913`；Wakaru 拆分 `chunk_HZo_2` 的按 host 分离查询/连接就绪 gating、`chunk_uhn` 的配置与 autoConnect 投影、`chunk_Oxr` 的稳定 host 索引。参考借鉴的是身份/读取准入模型，不推断完整线上或远端能力。
- 根因：服务级 Connect 已建立后端物理 slot，但前端 `autoConnect:false` 且逻辑 Runtime 未 ready，侧栏查询被永久禁用。配置启用、物理连接、逻辑读取、会话交互是四种事实。
- 修复边界：Application 持有现有管理 source，侧栏读取准入消费已认证、同 revision 的 open 事实，通过既有 registry 获取逻辑 reader；不更改 autoConnect 偏好、不选择 Host、不 resume/执行 Thread、不创建第二 transport。已有逻辑 ready 路径及静态配置兼容保留；锁定、删除、停用、revision/认证代次变化隔离迟到结果。
- 验证计划：准入/持有 promise 的锁定与配置变更、两服务器同 Thread ID 隔离；真实 Workbench Connect 后无需选目标即看到历史、原草稿/目标不变、刷新恢复与锁定撤销；SSH 合成 exec，不做真实推理/远端写入。
- 失败检索记录：`smoke-ssh-management-ui.ts`、`host-catalog-readiness.test.ts`、`app-host-protocol/src/ssh-codex.ts` 不存在，已限定 rg --files 找到真实 smoke/test/index。
- 当前源码修改和验证进行中；运行包仍为 `20261005-ssh-connect-menu`，不声称已更新预览。
- 参考补充：最新 Codex `chunk_KSs_2` 分别计算已 connected 的 Host 与 catalogHostIds/autoConnect 候选，不把配置集合或 Thread pin 当物理状态。采用的是这一分层，不宣称复制桌面 Main 全套连接策略。
- 最终模型验证：SSH suite 48 pass、1 skip（本地 isolated sshd 不可用）；包括新的读准入/迟到回复/认证 incarnation 与其他 Host 隔离。Host registry 的19项、sidebar provenance/routing聚焦测试也通过；Web/builtin类型检查、平台边界/字体/i18n及diff检查通过。新增测试已进入现有 test:ssh-codex 门禁。
- 旧已部署 Web 的真实合成后端负例：管理已 open，但30秒内无该 Server 的 thread/list；新版本在设置页即可产生目录读取，回聊天页无需选目标即可显示远端历史，当前 Codex目标不变；刷新与锁定/删除撤销均已验证。桌面/触屏与浅深色/public-access实际 Workbench烟测通过，旧静态配置目录/选择/历史恢复烟测通过；远端 SSH exec 为替身，没有真实推理或远端 mutation。
- 验收脚本纠错：设置路由显示设置导航而非任务列表，先观察实际 Server RPC 再通过应用导航回聊天查看DOM；初次 dock/Nav选择器在默认折叠/触屏状态不存在，按真实Show sidebar→Applications→Chat操作，不为测试修改产品。初次构建Host kind手填错误，已按正式headlessWebHostDefinitions重建并验收。一次文档patch上下文不匹配被整体拒绝，按实际行重做。
- 本轮仅客户端目录发现/发布准入和读代次 fencing，未修改后端/远端或重启。独立 Web候选 `/data/opencraft-ssh-catalog-JiRUrn/web`，buildId `20261005-ssh-catalog`；当前80端口unit/PID仍为 `opencraft-ssh-connect-menu-20261005-preview.service` /1048792，NRestarts0。真实手机、公网与批准远端的本轮新目录UI未实测；完整gate未运行，不冒称部署成功。
- 最终构建后浅深色完整桌面/触屏管理烟测均复验通过，截图已查看；documentation全仓0错误，context全仓现有4439错误（任务路径6条为已记录产物SHA256误报，人工核对非凭据），未将全仓检查包装为通过。staged impact空集合通过；正式设计已同步，不将该命令冒称覆盖未暂存变更。

### remote_catalog_preview_delivery
- 用户授权“替换吧”。复核实际运行Web发现已叠加消息排序修复，旧版本实际为 `20261005-timeline-overlay-VOAeGc`，不是前述历史记录的SSH/menu版本。候选构建时间晚于该overlay；共享 ordered-turn planner chunk 与当前部署摘要一致，保留已有能力。
- 按维护/自托管预览Skill执行Web-only发布，不停止或重启当前后端。实际Web完整备份到 `/data/opencraft-ssh-catalog-JiRUrn/previous-web`；既有原子publisher保留旧hash资源并在资源写入后更新入口，失败可恢复旧入口。
- 发布 `20261005-ssh-catalog` 成功；实际 localhost HTTP 校验456个manifest资源与候选SHA256完全一致，index/version no-store、hash资源immutable，旧入口资源仍可读取；health ok、appServerConfigured true。
- 实际服务仍为 `opencraft-ssh-connect-menu-20261005-preview.service`，PID1048792、active、NRestarts0，cwd和后端runtime摘要不变。证据 `/data/opencraft-ssh-catalog-JiRUrn/publication.json`；这是Web覆盖发布，不声称原始整包归档摘要覆盖更新后的Web。未复制账号/密钥/数据库、未调用推理、未Git提交/推送或更改永久安装指针。
- 公网HTTPS及物理手机的真实远端目录展示仍待用户刷新确认；隔离Workbench目录链路验证和实际服务静态发布验收分开记录，不冒称真实用户端验收。
- 发布后的实际80端口页面通过桌面/触屏模拟浏览器验收：设置刷新→Chat→Back/Forward，build meta正确、page errors为0。阻断所有WebSocket和写请求，没有获取真实Host/Thread或调用推理。验证脚本初次data-URL加载绝对文件import失败属验收启动问题，改为独立本地模块执行后通过；不修改产品规避。

### remote_catalog_live_incident_diagnosis
- 用户反馈替换后实际仍看不到，随后明确“先定位”。本轮只读调查，不修改产品源码、不再次发布或重启。Router `OpenCraft SSH connected remote threads not visible live preview catalog` 无匹配；读取维护Skill/完整verification、SSH专题、平台架构SSH段与frontend运行时邻接卡，检查既有真实管理smoke邻居。
- 当前80端口确实提供 `20261005-ssh-catalog`，unit仍active/NRestarts0/PID1048792；只读SQLite投影确认批准目标enabled、revision3。浏览器工具无可检查的用户标签页，因此不能冒称已取得用户手机的当前状态；已询问设置中连接状态/截图。
- 批准目标的SSH原生只读探测：initialize成功、loaded/list有9个加载中的Thread。与工作台完全相同的默认列表参数两次20秒无回执；同参数增加 `useStateDbOnly:true` 约16–20ms返回41个交互来源会话。去掉提供方过滤得到42个；扩大来源得到首批50个并仍有下一页，但不把扩大来源作为修复，避免混入exec/subagent。后续默认请求使用35秒观察窗在约19.8秒返回40个，而索引读取17ms返回41个；尚无证据证明这次用户请求具体触发30秒超时。
- 最新Codex恢复参考 `chunk_HZo_2` 与 `chunk_d2i` 的归档列表/存在性检查明确传 `useStateDbOnly:true`。生成ThreadListParams确认省略该项会扫描JSONL并修复元数据；这是原生查询行为，不是SSH密码或目录配置问题。不能将这两条参考路径泛称为整个上游所有查询策略。
- 实际已发布Web、当前80端口、单独诊断浏览器通过现有解锁流程接入真实后端；未复用用户Cookie，没有输出或保存访问密钥/会话内容。会话作用域鉴权建立和退出是唯一管理请求；没有连接重置、配置写入、Thread resume/start/steer或推理，WS中非只读RPC被阻断。
- 真实运行观察：管理目标open；逻辑host/connect与initialize约13ms正常；随后两条thread/list分别18.99/19.34秒返回40条。6/11/16秒侧栏0条远端，21秒默认10条中5条来自该SSH Server，展开更多后远端40条、合计87条。零page errors，说明在这一隔离浏览器中并非未发送或投影丢失，而是目录等待过长。
- 代码另确认两处可见性缺口：useMultiHostThreadCatalog仅返回threads/isFetching且调用方不展示目录等待/错误，缺data统一投影为空；Sidebar合并所有Server按updatedAt排序默认只展示10条，可掩盖非最近远端历史。fixture直接返回列表，先前模拟验收没有覆盖实际JSONL扫描成本；静态发布正确不等于用户当前客户端链路已成功。
- 尚未闭环：用户当前页面是否解锁、收到列表、超时或被默认折叠隐藏，以及真实手机/HTTPS路径。同一服务器真实页面读取成功证据不能覆盖另一个Client的事实。已记录慢扫描+错误空投影的确定缺口，但不声称已确定用户唯一根因；后续仍须对齐其当前页面状态。不实施修复或发布。

## connection_menu_followup_20261005
- 实际旧产物菜单 DOM 计算布局为 `block`，因内部 Radix 属性选择器未命中；新版本复用既有 `design-system/menu.web` surface/item，显式功能类仅接契约，不新增菜单布局体系。Radix 管交互，列表保持单一互斥菜单 owner。
- enabled 是配置准入，不是已建立通道；原重连只 reset，未建立 successor。现在提供显式“连接”，通过 AppHost 同一物理 slot 的服务级准入建立连接，无需选择聊天目标，无 Client lease/Thread/执行权限。服务与客户端并发启动去重，重连关闭屏障后才准入新通道；失败清理后保留失败状态。
- 管理鉴权和配置 revision 在实际物理准入前重查，包括等待旧通道关闭后的迟到请求；连接失败/未知回执均刷新后端状态，不重放写操作。idle 显示“未连接”，真实连接中由后端状态投影，不再把配置启用冒充无限待连接。
- AppHost、管理 API、controller 最终 39/39 聚焦测试通过，覆盖并发共享启动、无 Client 权限、页面离开保留、reset 迟到成功、失败状态、logout/CAS 在 reset 和物理准入屏障前后的拒绝；Headless suite 28/28，SSH suite 34 pass/1 skip（isolated sshd 不可用）。
- 受影响 Web/AppHost/Daemon/builtin-agents 类型检查、平台边界/字体检查、i18n 和 diff check 通过。`--staged` impact 检查通过但集合为空，不把该命令当本轮未暂存变更的设计映射证明；已同步正式 SSH/平台架构与不变量设计。
- 独立生产格式 headless Web 构建 `/data/opencraft-ssh-connect-menu-FESsEj/web`，buildId `20261005-ssh-connect-menu`。真实完整 Workbench 桌面/触屏、浅色/深色、键盘 Escape/ArrowDown、图标中心对齐/14px/共享间距/触屏44px点击区、菜单转弹窗、无需目标选择的连接/重连及动态选择目标等验收通过；深色同时覆盖 public-access 认证模式。SSH exec 仍为合成外部边界，无真实推理或远端写入。
- 当前运行的仍是先前 `20261005-ssh-flex-thread-ring` 预览；本轮改动未替换、未重启、未提交/推送。截图已人工查看，物理 iPhone 与当前公网真实目标使用仍需后续验收。

### connection_menu_preview_delivery
- 用户随后明确授权“替换”。实际旧runtime仍为原SSH包，但Web已独立overlay成导航版本；已核对导航记录并保留能力。独立候选复用旧Node/Codex/DSH依赖，重新构建入口，新旧runtime差异仅本次AppHost/SSH管理/入口三块；Web为已验收SSH/menu版本，保留旧hash资源以支持旧tab延迟加载。
- 正式候选归档 `/data/opencraft-ssh-connect-menu-FESsEj/OpenCraft-server-preview.tar.gz`，SHA256 `a6cc8665084f668a5fd85510dcd9e29568304718328d81551752c77aafed15c3`。最终manifest全量、DSH/Codex初始化、目录/项目包级smoke和最终包Web桌面/触屏管理流程通过；隔离数据与合成远端，不调用推理。
- 自托管预览Skill要求的独立switch/失败回退已执行成功，cutover退出0、未回退。重连后核验80端口PID1048792、unit `opencraft-ssh-connect-menu-20261005-preview.service`、cwd候选root、runtime SHA `96b6fc0042b4d348fe42e298253185d5703e4021e84c94c25923d75dc1f00347`、buildId `20261005-ssh-connect-menu`、health ok与NRestarts0。
- 实际运行包管理API已对保存的批准目标 `9.134.163.40:36000` 执行显式Connect，HTTP200且物理状态open；匿名401、凭据不返回浏览器。没有真实推理或远端文件写入。旧包/旧unit及原数据保留，不改 `/opt/current`，无Git提交/推送。
- 当前临时预览已完成替换和重启，用户刷新验收。公网HTTPS与物理iPhone本轮未单独验证，不冒称手机端到端成功。

## sidebar_visibility_followup_20261005

- 最新用户在替换后仍报告看不到，实际用户交付再次未闭环；不继续修改或盲目重启。Router `OpenCraft SSH sidebar still missing after discovery recovery published user client connection authorization catalog` 无匹配；有界精读 source/profile/query/sidebar、管理授权与DB实现，猜测 packages/app-host 的管理/store 路径不存在，改为 apps/opencraft-daemon 真源。当前实际80端口已是 `20261005-ssh-discovery-recovery`、health正常、PID1048792/NRestarts0；只读SQLite配置仍enabled/revision3，现有到批准目标36000端口的TCP连接仍ESTAB（不能等价证明用户Client目录已读取）。浏览器工具没有用户可检查标签页；公共日志无该用户的私有目录请求/授权证据。代码明确：SSH未解锁不建远端profile、空列表不显示授权提示；已获取目录默认仅混排10条，其余在“更多”入口。此为两个待鉴别路径，不是已定位根因。已请求当前侧栏和SSH设置状态截图，不能把独立浏览器成功重新当作用户修复完成证据。

- 本次授权替换已完成：`20261005-ssh-discovery-recovery` 已由真实80端口提供；458个manifest资源 HTTP摘要匹配候选、入口/version no-store、hash资源immutable、旧入口依赖可读，health ok/appServerConfigured true。PID1048792、原unit/runtime摘要/NRestarts0不变，无后端重启。回退旧Web和发布回执在 `/data/opencraft-ssh-discovery-recovery-PPFPWK/previous-web`、`publication.json`。发布后实际资源的桌面/触屏浏览器均通过聊天页首次读取故障→自动重试→错误消失，读取2次、page errors0；仅注入管理GET故障且限制Host为初始化/只读，无用户鉴权或历史检查，不等于用户手机端到端验收。`live-verification.json` 同目录；没有Git提交/推送或永久指针修改。

- 后续用户“替换预览”授权当前临时 Web 发布，不含 Git/永久安装/生产；已重读维护、自托管预览 Skill、验证清单、构建矩阵及静态发布实现/测试邻居。Router `OpenCraft SSH discovery recovery replace temporary headless preview Web publication` 无匹配，执行有界检索；猜测 `.ts` 发布测试/烟测不存在，改为实际 `tests/workbench-web-release.test.mjs`，10/10 通过。健康路径 `/health`、`/healthz` 不存在，按真实测试改为 `/__opencraft_health` 返回 ok。当前 PID1048792/unit/工作目录/runtime 摘要与此前一致，Web 为 `20261005-ssh-indexed-catalog`。本次仅原子发布 Web：完整旧 Web 备份、全部 manifest HTTP 摘要与缓存校验、失败自动回退，不终止当前承载代理的进程。

- 最终实施结果：Application 启动唯一 Controller discovery owner，移除 Settings 轮询；读取单飞、完成后调度、10/20/30 秒失败退避、隐页/离线暂停和在线/可见唤醒。授权变更期间不发后台读取，销毁/旧授权/旧请求不发布迟到结果，命令完成后重新读取新快照。侧栏来源失败与成功空列表分离，来源重试只读、不拨号、不切目标；健康后台轮询不显示加载提示。
- 验证：最终 SSH suite 62 pass/1 skip（缺少隔离 sshd 权限的实机测试跳过）；Web/builtin 类型、边界/字体、i18n（111 messages）、diff 和 documentation 检查通过。Sidebar 四种桌面/触屏浅深色配置通过；最终完整 Workbench 四种配置均通过自动恢复、Retry、online 三条故障恢复路径，以及既有 CRUD/连接/锁定撤销，合成 SSH 边界，无推理或真实远端写入。旧发布候选用同一烟测按预期失败，启动读取失败后仍停在无任务列表、无来源重试。
- 独立候选 `/data/opencraft-ssh-discovery-recovery-PPFPWK/web`，buildId `20261005-ssh-discovery-recovery`；故障截图与烟测产物同目录。未替换当前预览、未重启、未提交/推送。当前公开用户入口原故障根因与物理手机端到端验收仍未闭环，不把独立页面通过冒称用户已恢复。staged impact 空集合不是本轮未暂存代码的覆盖证据；正式平台架构、SSH 专题与 SSH-08 不变量已同步。

- 最新用户“至少这个需要修复”授权实施已复现的启动目录恢复缺口，不包括发布/重启/Git操作。Router query `OpenCraft SSH connection catalog startup failure recovery Application lifecycle sidebar retry` 未匹配；有界读取controller/启动/视图/侧栏和测试邻居，重读维护Skill、verification与frontend-runtime-openspec-i18n邻接卡。计划：Application启动唯一controller discovery生命周期，状态读取完成后调度、暂时失败有上限退避、在线/可见恢复探测、隐页不轮询；View移除定时器。单飞合并状态读，锁定/解锁取消旧读并阻止授权变更期间后台GET；取消/销毁阻止晚到投影。无Host来源时也展示管理读取失败/重试，重试只读不拨号、不切目标。
- 用户明确“我就很确定 没实现”：交付状态仍未闭环，不以独立浏览器42条作为用户完成证据。本轮继续只读诊断；Router query `OpenCraft SSH conversation sidebar user route catalog log origin not implemented` 未匹配，限定当前 controller、启动 owner、sidebar 和管理鉴权边界读取，无产品修改或重启。
- 确认恢复 owner 缺口：Application 只在启动 await `sshManagement.refresh()` 一次；周期刷新定时器实际在 Settings View，离开页面即清理。Controller 启动读取失败会保留 available=null/items=[]，恢复网络本身不会触发重读；Profile 投影无SSH来源，Sidebar 又只呈现 loading/error 查询，未准入来源没有反馈。合成 fetch 故障验证：首次 session/connections/legacy 各1次，网络恢复后等待6.5秒次数仍各1次且错误保留；显式refresh后各2次、available=true/error=false。无真实网络、凭据或用户数据参与。此为已复现缺口，不冒称就是用户当前实机根因。
- 日志仅按结构化事件聚合：08:00起限定最近3000行中public AppHost upgrade/hello各16次，client-failure7次、heartbeat-timeout3次；private SSH通道未记录对应诊断，不能从公共连接计数推出用户SSH目录是否请求/拒绝。未输出原始日志、会话内容或身份。一次 node 不在默认PATH，改用既有明确Node路径重跑。
- 用户再次报告“侧边栏好像也没展示”，并询问是否后端未重启；本轮只定位，不修改产品源码/配置，不重启/发布。Router query `OpenCraft SSH sidebar thread catalog returned not displayed visible collapsed host selection` 无匹配，已做 bounded exact search、读 maintenance Skill 与邻接/SSH controller 测试邻居。诊断脚本在 `/data/opencraft-ssh-sidebar-diagnose-qcHwCk`。
- 当前HTTP仍为 `20261005-ssh-indexed-catalog`，PID1048792/NRestarts0/active。真实部署页面继续收到原生 indexed 参数的远端响应，桌面与触屏独立浏览器都可以展开显示42个SSH行；刷新且自有授权有效后也可显示。因此这次参数变更不依赖后端重启，但不能据此断言用户实际Client的未显示原因已闭环。
- 进一步检查实际视口而非只数DOM：初始默认全Host混排10行，其中6个SSH行都在视口；展开后42个SSH行、全目录81行，视口实际可见6–7个，剩余须滚动；刷新重新收起为10行（抓取瞬间SSH10行）。授权缺失页面不发远端目录请求，授权有效刷新保留读取；服务open与浏览器授权是独立事实。没有读取/复制用户Cookie或注销用户会话。
- 原生只读过滤对照：默认42，去provider筛选43，全provider+全source82（42 vscode、1 cli、39 exec），均为索引读；loaded9个，其中8个在默认/全source目录，另1个未列出不据此猜测已持久化。存在默认筛选差异，但不足以证明用户当前缺的是哪些会话。只输出统计，不输出会话正文、名字、ID或秘密。
- `https://join.devcloud.woa.com/version.json` 从本机直连失败，按权限要求重试仍连接失败；不能替代用户实际HTTPS入口/浏览器版本验收。已向用户请求侧栏（含更多入口）截图与设置中已连接/需解锁的状态，暂不把原因归为缓存、鉴权或折叠中的任一种。
- 一次可见性脚本在触屏刷新后未等待新页面挂载就检查“Show sidebar”，导致侧栏仍折叠而等待可见行超时；加上实际页面ready等待后复验成功。仅修隔离诊断夹具，不把测试时序错误当作产品缺陷。已发现的空路径猜测为 `runtime/headless-appserver.ts`、旧 `ssh-connections-controller.ts` 与单文件 `ssh-connections.tsx`，后用限定发现定位真实 runtime context 和 controller/view 目录。

## indexed_catalog_preview_delivery_20261005

- 用户随后明确授权“替换”。按 maintenance/self-hosted-preview Skill 做 Web-only 原子发布，不停止承载当前会话的后端；没有提交推送或更改永久部署。Router query `OpenCraft SSH indexed catalog temporary Web preview replace publish rollback` 命中 release-gitops，已读 `docs/context/domains/release-gitops.md`，本次只是临时 Web 发布，不触及 GitOps/Argo。已读 frontend-runtime-openspec-i18n 邻接、实际 publisher 和 Web release 测试邻居。
- 当前候选 `/data/opencraft-ssh-indexed-catalog-m0KlGA/web` 发布到实际 PID1048792 所属包的 Web 根，buildId `20261005-ssh-indexed-catalog`；前版 `20261005-ssh-catalog` 可从 `previous-web` 回退。该备份保留当前静态资源；因运行根 `.vite/manifest.json` 早于历史 overlay，回退输入使用真正前版的 release manifest，旧根 manifest 另存 `previous-root-manifest.json`。
- Web发布门禁10/10；实际HTTP456资源逐字节/hash一致，hashed immutable、入口/version no-store、旧tab入口依赖可用。发布新增103/reuse434/公共文件7，没有回退。发布回执 `/data/opencraft-ssh-indexed-catalog-m0KlGA/publication.json`。
- 发布后独立桌面/触屏模拟浏览器以自己的临时管理会话解锁并读目录，Native两次读取各返回42个：桌面44/48ms、触屏40/44ms，全部确认索引参数，无page errors；实际sidebar分别可见10/6远端行。只允许HTTP读取与本诊断session登录/退出、WS读取；没有远端业务/文件/配置写入、推理、用户Cookie/账户数据复制或用户session注销。证据 `live-verification.json`；不冒称真实手机或外网HTTPS已验收。
- 核验实际80端口仍为原unit `opencraft-ssh-connect-menu-20261005-preview.service`、MainPID1048792、active、NRestarts0，cwd及runtime SHA不变，health ok；当前Web已更新，不能用原整包归档摘要冒称包含此overlay。用户需刷新网页获取新入口，不必重启后端。

## indexed_catalog_implementation_20261005

- 用户授权实施；不包含当前预览替换、重启或 Git 交付。开发基线为 `fix/remaining-worktree-20261005` / `1a53b96c36571a1094c45ef2cd84266468172370`，保留原任务文档与无关未跟踪内容。
- Router query `OpenCraft SSH thread catalog indexed read loading failure sidebar more remote history` 无匹配。主 Agent 已读 OpenCraft maintenance Skill/verification、SSH 专题/平台架构、frontend-runtime-openspec-i18n 邻接和真实管理 UI smoke 邻居。最新 Codex renderer 仅确认两处 archive 查询使用 `useStateDbOnly:true`，不声称其所有主列表都如此。
- Runtime 是目录读取策略唯一入口：remote-ssh Native Codex 热读用已有索引，覆盖 Sidebar/当前 Host/分页/归档调用；显式参数可覆盖进行修复。没有新后端 API、不拉长超时、不拓宽 provider/source、不在空/失败时退回 JSONL 扫描。
- Application 的每 Host Query 保留准入/认证代次检查，暴露 loading/error/ready/unavailable 与精确读重试；不建第二份目录缓存或连接 owner。撤销准入停止绘制旧缓存；一台失败不消除其他成功目录，同 Host 刷新失败仍保留旧有效行。Sidebar 只呈现共享圆环、短失败文案/重试和已获取目录中隐藏的远端条数（仍是每 Host 前50条边界，不冒称所有磁盘历史）。
- 已通过聚焦11/11；SSH门禁51 pass/1 skip（无 isolated sshd）、Runtime/Web类型、i18n、字体/平台边界。真实 Sidebar 四组桌面/触屏浅深色 reduced-motion 验证加载不冒充空、失败隔离、Host scoped retry、更多远端入口与成功空列表；其数据边界是合成输入，不冒称真实手机/查询端到端。独立候选 `/data/opencraft-ssh-indexed-catalog-m0KlGA/web` / `20261005-ssh-indexed-catalog` 构建完成，后续执行完整管理 UI 与批准机器原生只读 Runtime 验证。
- 失败检索记录：猜测 `appserver-runtime.test.ts`、`chat-host.test.ts`、`thread-management.test.ts`、根 `app.scss`、设计系统 `theme*` 不存在，已收敛实际文件路径。新 gap 变量检查发现无定义，修为既有 `--gap-control-group`。这些没有产生远端或运行服务修改。
- 补充缓存边界：读取前/后检查不能隔离已存在的 cache，目录 query key 另纳入 profile revision 与 SSH authorization epoch（非 SSH 的 epoch 为 null）；真实 QueryClient 测试确认重授权/换版本不会复用旧数据，不影响本机缓存。最终 SSH suite 52 pass/1 skip，目录/Draft/Fork相邻回归34/34；Web类型与i18n/字体/边界再通过。
- 实机只读验证使用新 Runtime + 已批准 SSH 目标，仅 initialize/thread/list；42个目录条目约29ms返回，wire确认为索引读取，没有 native scan、推理、resume、文件/配置写入。完整候选 Workbench 管理桌面/触屏在浅/深色 public-access 下通过，涵盖 Connect后不选目标读目录、刷新恢复和锁定撤销；读取请求已断言原生索引参数。Sidebar错误/更多截图已人工查看；发现隔离fixture缺移动viewport，已补齐（不修改产品）。文档validator全仓0错误/0失效链接；不声称完整 gate、真实iPhone或当前用户Client验收。
- 最终可访问性修正把加载名称放到 status owner 而非 generic span；最终源码重新构建候选并完整深色 Workbench 管理/UI再通过，含正确移动viewport的Sidebar四组也复验通过。运行80端口仍为原PID1048792/NRestarts0/`20261005-ssh-catalog`、health正常；未替换、未重启、未Git交付。

## preview_delivery_20261005
- 最新用户决策：确认访问地址为 `https://join.devcloud.woa.com`，随后明确不要求固定地址并接受其风险。本次增加显式 `--ssh-public-access`，不同地址可各自解锁；仍保留访问密钥、短期 origin-bound 管理员会话、逐帧撤销和主机指纹，HTTP 不冒称传输加密。不设置匿名远端 root 权限。
- 本轮继续纳入已验证的 Thread 首次加载圆环；旧 SSH 候选包不包含该改动，须重新整体构建。延续用户允许的完整工作区临时预览，不包含生产/Git/远端安装或停服务。
- 用户已授权整体 dirty source 临时预览，后续确认无需固定地址并接受风险。最新包来自当前工作区 HEAD `5b3a3ccaf873692cc5d1649019a6a432c02f8769`，保留其他未提交改动；不把整份 dirty source 认领为 SSH 改动。不涉及生产、GitOps、提交或推送。
- 最终正式 headless 候选包 `/data/opencraft-ssh-flex-preview-0EUz5Y/OpenCraft-server-preview.tar.gz`，buildId `20261005-ssh-flex-thread-ring`，Codex CLI 0.160.0；已包含 Thread 加载圆环与动态地址模式。旧 SSH 候选已过时，不用于部署。
- 最新管理/Headless 联合测试 26/26；SSH suite 34 pass、1 skip（isolated sshd 不可用）；Daemon 类型检查和 diff check 通过。正式包 manifest/DSH/Codex 初始化与目录能力 smoke、最终包 Web 桌面/触屏管理全流程通过；该 UI smoke 的 SSH exec 为合成边界。
- archive SHA256 `56485292d3cd75307ab4eeff35923434e1b16b08ec6a6bde600e579713785813`；runtime SHA256 `2338489dae0cf063e20dd910ee7bbf59443a66661fd0a82b288bd338fc843329`；来源/旧包信息见候选目录 `provenance.json`。
- 已在共享数据根的私有 `ssh` 子目录保存用户明确批准的目标 `9.134.163.40:36000`（root），Server ID `ssh:d725ce3f-0046-44c0-ab5c-477d25a19486`。数据库只保存加密密码，credential/access key 各自后端 0600；主机指纹与用户先前确认值一致。真实 initialize/thread/list/model/list 只读探测通过；未安装、停止或修改远端服务，未调用真实推理。
- 切换前 80 端口所有者仍为 `opencraft-neutral-focus-20261004-preview.service` / PID 2785955；buildId `20261004-titlebar-shadow-2214b6bccf6e`，runtime SHA256 `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a`。原包、unit 与共享数据保留；独立切换脚本检查实际端口/旧 owner，失败恢复旧 unit。不能仅凭提交切换任务声称升级完成。
- 独立 `opencraft-ssh-flex-cutover-20261005.service` 已执行成功（exit 0），未触发回退。重新连接后确认 80 端口 PID 576109 / `opencraft-ssh-flex-20261005-preview.service`，cwd 为最终候选 root，runtime SHA 与候选一致，Web buildId `20261005-ssh-flex-thread-ring`，health ok，NRestarts=0。以两个 HTTPS Origin 分别解锁、读取真实已保存目标与 catalog、拒绝跨 Origin 复用、退出会话和匿名 SSH 拒绝的本机 HTTP 验收通过；未输出任何密钥。
- 当前是临时 unit/候选包，不修改 `/opt/current` 或永久部署；旧包和 unit 保留可回退。服务器回访 `https://join.devcloud.woa.com/version.json` 连接失败（默认与提升权限重试一致）；该外部入口及物理手机显示需用户侧刷新确认，不冒称端到端公网验收。
