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
