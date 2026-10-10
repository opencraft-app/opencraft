# OpenCraft 云桌面能力评估

## goal
以 mono2 当前云桌面源码为依据，说明实现链路、所有权与 OpenCraft 接入边界。

## non_goals
- 不修改业务实现、重启预览、部署或操作云资源。
- 不将设计记录或本地旧 checkout 当作已部署事实。

## requirement_refs / requirement_excerpt
- 用户：评估加上云桌面能力，查看 mono2 现有实现。

## interface_refs / data_structure_refs
- origin/master:ctl/pkg/instance/desktop.go：按 instanceID 缓存进程内 desktopSession；provision 使用 entity.SandboxId，Ready 分支直接返回缓存。
- origin/master:ctl/pkg/transport/instance.go:651：Installing / Provisioning / Ready / Paused / Failed；Ready 返回 ws_url、password、width、height。
- origin/master:frontend/src/pages/marketing/agent-cloud-desktop-panel.tsx：RFB/noVNC viewer，3 秒准备轮询、30 秒 HTTP 活跃心跳、20 秒 RFB WS 保活；disconnect → failed，手动 retry。
- origin/master:ctl/main/api/server.go:721：POST/GET /v1/instances/{id}/desktop/session；logic.loadDesktopInstance 校验用户归属。
- origin/master:sandbox/internal/ingressproxy/target.go、router.go：从域名解析 port/sandboxID，经 route store 获得 address，router→shard→内网端口。
- opencraft/packages/workbench-panels/src/service.ts：PanelTypeDefinition、PanelToolbarActionDefinition；Renderer 不拥有逻辑资源，close/dispose 必须由明确 owner 实现。

## history_context
- 当前 checkout 为 5b3a3ccaf，2026-09-29；本地 origin/master 为 bbd7ffb83，2026-10-04。
- 当前 checkout 精确搜索未找到实现；本地 origin/master 已有 ctl 云桌面文档和前端组件。
- wiki 进展只作历史定位：9 月 23 日提到自研 VNC 反向代理，不作实施证据。

## acceptance
- 根据实际源码追到前端、控制面、图形服务、代理和资源回收。
- 明确可复用部分与未验证部署、安全及恢复风险。

## affected_paths
- 只新增本任务记录；调查 frontend/、ctl/、sandbox/、images/、opencraft/。

## required_context / context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md | 根规则 | 只读边界与状态记录 |
| opencraft/AGENTS.md | 接入评估 | 平台所有权与真实能力声明 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 架构任务 | 按层建模与验证边界 |
| docs/context/project/repository-map.md | 跨服务定位 | 区分实例控制、客户端与工作台 |
| vela-computer/AGENTS.md | 排除同名组件 | AgentChat 客户端不等于图形桌面 |
| frontend/AGENTS.md | 桌面 UI | 只读源码边界 |
| ctl/AGENTS.md | 实例控制 | 归属校验、公共网关与上游分离 |
| docs/context/project/services/ctl.md | 路由 must_read | 控制面与公开入口不等价 |
| docs/context/domains/agent-gateway-runtime.md | 路由 must_read | 运行时与网关职责 |
| sandbox/AGENTS.md | 转发层 | 沙箱状态与代理生命周期 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 邻接 | 检查前端 Installing 测试与 runtime-config |
| opencraft/docs/platform-architecture.md（拓扑、reuse、Next feature rule） | 接入边界 | 独立资源与 renderer-free owner |
| opencraft/docs/plugin-architecture.md（贡献面与 ownership） | 插件模型 | 面板注册不等于业务 authority |
| opencraft/docs/browser-workbench-architecture.md（Remote 与安全） | 参考已定义语义 | 区分数据面、控制权与持久化；不冒称已有桌面协议 |
| docs/context/tasks/TASK-TEMPLATE.md | 任务记录 | 必需字段 |
| docs/context/tasks/CHECKPOINT-TEMPLATE.md | 检索失败恢复 | 保留分支定位证据 |

## evidence
- 路由器无匹配；先在 frontend/ctl 等路径精确搜索云桌面、noVNC，再有界扩展文件名与根关键词。
- 当前工作树无图形桌面实现；git ls-tree origin/master 找到 agent-cloud-desktop-panel.tsx、ctl/docs/cloud-desktop-vnc-plan.md。
- 本地存在 origin/feat/cloud-desktop-vnc-plan（14ac88756）；无需切换或覆盖 dirty worktree。
- 默认 git ls-remote 鉴权失败；未输出凭据。
- 图形栈：Xvfb :1 + XFCE + x11vnc :5900 + websockify/noVNC :6080，运行用户 agentuser，默认画面 1440×900。
- 安装：未装图形层时 TAT 启动 nohup 脚本，后台进度文件；CTL 每 8 秒读取进度，600 秒截止。镜像可 build.sh --with-desktop 预热；源码允许两条路径。
- provision 启动/探测采用 sandbox TAT PTY exec-stream；安装/回收采用 TAT ExecCommand；不经过 Codex AppServer。
- 默认 idle 阈值 30 分钟，扫描间隔 5 分钟；只停止四个桌面 unit，不 PauseSandbox。源码测试 TestReapIdleDesktopsStopsServicesNotHost 明确覆盖该约束；本轮只阅读，未重新运行。
- 进程内会话状态与编排锁：sync.Map + sync.Mutex；没有跨 CTL 副本的唯一编排/密码权威。
- 测试邻居：agent-cloud-desktop-panel-installing.test.tsx、http-repositories.test.ts、desktop_test.go 已读取相关片段。
- runtime-config 实际读取 CLOUD_DESKTOP_ENABLED（默认 false），不是自动由域名配置决定；sandbox-bj-7 的 GitOps 输入声明开启。没有查线上 Argo 或实际桌面，不能宣称已部署。
- 最近合入：c0eb7e211（!4527）闭环；78111d485（!4799）agentuser、壁纸与 WS 保活。
- /data/mono2-embed-latest-B8J3rW 有可点击源码副本；git diff origin/master 173f293b6 比较 desktop.go、前端 panel、router.go 无差异。

## risks
- 缓存的远端 ref 不代表实时部署；说明源码版本和未知项。
- 文档存在不同阶段的旧描述，运行时源码优先。
- 重启/多副本：内存状态丢失后重新 provision；可能换密码，且已运行桌面不在新 reaper 的表中。多副本的锁和密码互不协调。
- Ready 只由 6080 HTTP 探测或缓存得出；没有完整 RFB 画面就绪校验。Ready 分支不比较新 entity.SandboxId，实例迁移后可能返回旧地址。
- GET 有启动/恢复及 touch 副作用；不宜直接当普通无副作用查询来重试和缓存。
- 当前 viewer 无自动重连/可见性恢复；AbortController 未传 repository 请求，取消主要依靠 cancelled，首次响应后的 setSession 缺少失效检查。
- HTTP API 归属校验与 WSS 数据面鉴权分离；当前桌面用 8 位 VNC 密码，未在已查代理中发现桌面短期票据校验。仍需实际边缘配置验证，不认定全链无其他鉴权。
- x11vnc -shared 可多客户端同时输入，无控制权独占/代次。systemd unit 未设 MemoryMax/CPUQuota。
- 安装脚本与镜像脚本重复；单进程安装锁与单次文件写入 flock 不等于跨副本安装任务互斥。

## validation
- 只读 git show/git grep；最终检查任务文档格式。
- validate_documentation.py --repo . --format json：exit 0，errors=[]、warnings=[]、broken=[]。
- git diff --check -- docs/context/tasks/2026-10-04-opencraft-cloud-desktop-assessment.md：exit 0。
- 没有运行云 API、安装脚本、实际桌面连接或部署测试；没有重新执行源码单测。

## decisions
- 从本地 origin/master 读取新源码，不 pull、不切分支。
- 推荐复用 CTL 和 sandbox 图形/转发链路，不要求改 Codex/DSH 二进制。
- 桌面资源按 account/region/instance/sandbox-generation 绑定；Thread 只是关联入口，不能一会话装一套桌面。
- provider 拥有 CTL 交互、短期连接材料与资源状态；client runtime 拥有连接重试、代次与 viewer lease；Shell/Renderer 只负责槽位、布局及 noVNC 呈现。关闭/隐藏面板不终止 Agent，不自动销毁桌面进程。
- 桌面是独立面板资源，不强塞 BrowserSession（无浏览器 URL/history 语义）。先实现 LightVela provider 纵切，能力真实可用才显示入口。
- 人工查看操作桌面和 Agent computer-use 两个能力分开；当前 noVNC 实现不证明 Agent 已能操控桌面。

## scan_scope
- 图形桌面相关入口、API、状态机、安装脚本、代理、OpenCraft 面板扩展。

## scan_output
- 初轮检索失败已记录；不保留无关大范围输出。

## handoff
- 调查完成，待用户决定是否进入设计/实施。本轮未改业务代码、重启或部署。
- 可以接入现有图形及控制 API；正式接入应补连接恢复、稳定身份和多副本权威/安全。线上部署、实际键鼠与手机输入尚未验证。

## checkpoint
### stage
完成源码链路与 OpenCraft 接入边界评估。
### verified
- 云桌面源码在 origin/master，而非当前旧 checkout。
- 主沙箱复用、按需安装、noVNC 数据面、内存状态与只停图形服务回收均有源码证据。
### unverified
- 公共入口实机连通、部署 revision、边缘鉴权、资源预算和触控输入。
### discard
- 旧 checkout 未命中不能推导 mono2 没有云桌面。
### restore
- /data/mono2，保留 dirty worktree；只读 origin/master。
### next_action
- 用户授权实施后，先确定 LightVela 桌面 provider contract 与会话资源 owner，再做首个平台纵切。

## Codex 本地包对照（后续请求）

用户要求检查 /data/codex-new，并追问 WebRTC。只读调查，不执行该包。

- 样本：codex-26.930.31428-12913；unpacked/package.json 明示 version 26.930.31428、build 12913。是用户指定本地样本，不宣称互联网最新版本或账户已开放功能。
- 读取 intake README.md：原始 unpacked 是已提取 bundle；analysis/wakaru-standard 仅为启发式拆分且有未解析 import，不能当可运行完整源码。没有 source map。
- 路由 /data/codex-new 云桌面无 pack；在该包内精确搜索 cloudDesktop/noVNC，定位两个不同入口。默认 node 不在 PATH，改用 /data/node-v22.20.0-linux-x64/bin/node 只读截取 bundle；修正 rg -E 为实际正则查询。未扩大到无关参考工程。
- 直接真源：unpacked/webview/assets/panel-da547d640131.js，导出 CloudDesktopPanel。src-51803043763e.js 直接导出 WebRTC client。
- 注册：app-initial-970035cbb6b0.js byte offset 8591036 附近。feature gate 1327697786 + local-thread + app-server target host durable，投影 conversationId/hostId/environmentId。cloud-desktop 注册只允许 right destination，稳定 getId cloud-desktop。
- 辅助阅读 chunk_qfs.js、chunk_tgs.js；关键注册事实已逐项核对原始 app-initial，不只引用分析副本。
- 启动：command/exec，environmentId，默认 Python 调用 /usr/local/bin/cloud-agent-desktop status/serve；UID 1000；ORBIT_OS=true、BROWSER_HEADLESS=false；95 秒启动等待，外层 timeoutMs=105000、outputBytesCap=4096。
- 启动响应 schema 校验 status=ready、session_id 非空、bearer_token 匹配 32–128 位安全字符。session_id 注入 CODEX_CAAS_SESSION_ID。缺运行时/执行用户错误/启动超时以 10/11/12 退出码分类，不直接暴露进程输出。
- 信令：realtime.chatgpt.com/v1/cua（有受限 staging 变体），POST application/sdp，source=cloud、environment_id、session_id；X-Codex-Desktop-Token 另于 header，fetch expectedIdentity(accountId, authenticatedUserId)。不能据此推断 token TTL 或服务端完整授权/撤销策略。
- 数据面：RTCPeerConnection，audio/video transceiver，video 播放 stream；RTCDataChannel 传键鼠（二进制消息）与 control/request、control/release、control/clipboard。
- 控制权：默认 observe；Take control 发送 request，收到 control/locked 才转 control 并挂键鼠监听；Stop control、窗口 blur、焦点离开 viewer 都撤销输入并发送 release。服务端实际多客户端仲裁实现未随客户端源码验证。
- 就绪：video playing 与 DATA_OPENED 同时成立才可接管。分 startup/signaling/transport/video/input/connected，连接截止 20 秒，错误按阶段记录 diagnosticId 与耗时；敏感身份字段单独分类。
- 取消：viewer 清理 abort 信令、摘输入监听、关闭 peer/data、清 srcObject；未看到卸载时关闭远端桌面服务命令。
- 恢复：retry=false，Try again 手动 retry generation；startup query gcTime=0、staleTime=Infinity，按 account/user/environment/host/API base/retry key 绑定。不能宣称该云桌面已提供完善的手机弱网自动恢复。
- 另一路 cloud-browser-local-live-view-c43baff43213.js 使用 /flora/browser/handoff → novnc_url → iframe，属于 Cloud Browser，不是 CloudDesktopPanel，不能混为一条技术链路。
- 建议借鉴语义：环境资源/连接/View 分层；观看与输入权分离；视频和输入分别就绪；凭据绑定身份；分阶段错误和取消。复用 mono2 VNC 可先落实这些语义，但服务端控制权不能只靠前端开关冒充。
- 本轮无业务实现变更、部署或实际远端连接验证；WebRTC 服务端、桌面 launcher 内部、运行时资源回收与手机输入尚未知。

## DevCloud 接入实施前评估（用户要求先评估）

### scope
- 目标：在 DevCloud OpenCraft 增加与 Codex 相似的云桌面能力，TAT/机器执行放后端；这轮不实施、不安装、不重启。
- 已异步询问目标机器是当前工作区还是所选 Bot 沙箱。暂以当前 DevCloud 为首期纵切，最终部署范围待回答；两者共享领域模型但使用不同 backend provider。
- maintenance Skill 已重读并告知：按资源、连接、控制权和呈现拆分，不把网络/重试/业务权威塞进 React。

### verified
- 当前环境只读检测：x86_64、TencentOS Server 4.4；command -v 仅找到 systemctl，未找到 Xvfb/Xorg/ffmpeg/gst-launch-1.0/x11vnc/websockify。只是 PATH 检测，不宣称整盘没有工具。
- headless-server.mjs 管同源 Web gateway、Local Agent Host、Codex AppHost；没有已接通的云桌面服务。
- 当前打包服务是单用户信任边界，并非多租户鉴权；公网模式显式说明无 TLS/access control。DevCloud 外部入口的鉴权、TLS 和机器映射还需独立核验。
- 现有 LightVela Hermes transport 建立 /v1/instances/{id}/tat/session，按 account credentialScope + instance/profile 隔离；不应复制成新的前端桌面脚本执行器。
- Hermes command/exec 走专有 TAT Terminal service；它要求 processId，而当前 Codex cloud panel 默认参数没有 processId 且含 environmentId。不能假设复制 Codex 的 request 参数即可贯通我们所有 backend。
- CommandExecParams 的 environmentId 并非当前通用上游 generated contract 字段；将环境绑定留在我方 provider/服务边界，不能修改 Codex 二进制或把 UI 名称当参数。
- WorkbenchPanelService 已有 panel kind、creation action、isAvailable、resource 与 durableRoute；可复用槽位，无需重造 Shell。
- EnvironmentDirectory 区分 machine lifecycle 与 connection recipe；桌面资源应关联机器/provider，Thread/View 只关联，不成为机器 owner。
- 文档 appserver-process-service.md 的 Hermes/TAT 迁移描述与当前源码可能有演进差异；本评估以已读取真实 command/exec 和 TAT service 为边界，不推断所有 process RPC 支持情况。

### proposed ownership
| 对象 | Owner | 不变量 |
|---|---|---|
| DesktopResource | 后端桌面 supervisor | machine/environment + incarnation/generation；一台目标环境只有一个被认领的桌面 runtime，不按 Thread 重复启动 |
| DesktopViewerConnection | 应用桌面 runtime + 后端 session authority | 连接代次、信令、视频/输入就绪分离；客户端解绑不销毁远端 runtime |
| DesktopControlLease | 后端唯一控制权 authority | 一个 holder、epoch、到期/续租；服务端校验代次与输入序列；收到 grant 才转发 |
| Presentation | 插件/Shell | DOM/video、焦点、fit/letterbox、布局、工具栏；移动/隐藏不重建资源 |
| Machine execution | backend provider | DevCloud supervisor 或 CTL/TAT；不经 Agent turn、不让 React 拼任意 shell |

### work packages
1. 服务端版本化 desktop capability 与 narrow API：discover/ensure/get/connect/acquireControl/releaseControl；名称为拟定我方 contract，不宣称是 Codex 原生 RPC。
2. Linux desktop runtime：专用非 root 用户、虚拟 display、WM/DBus、需要的应用；采集编码和远端输入。TencentOS 专用安装/打包或经验证的隔离镜像，不直接跑 Ubuntu apt 脚本。
3. Backend supervisor：幂等 ensure、机器变化 generation、并发认领、启动超时失败对账、崩溃/重启恢复与 cgroup 预算。桌面进程不能挂在浏览器请求/聊天 turn 生命周期上。
4. WebRTC data plane：SDP signaling + video + DataChannel；后端票据绑定已认证主体、目标环境、session generation。TAT 只启动/status/stop，不传实时视频。
5. 部署网络：核验 DevCloud gateway、同源 HTTPS 信令、UDP ICE 与 TURN/TLS fallback；当前通用 HTTP reverse proxy 不能凭有 WS 就宣称能转发 WebRTC 媒体。
6. 控制权：服务端 grant/revoke/heartbeat/expiry，失焦和断线释放；重连默认 observe，旧 epoch 输入被拒绝，防 stuck keys。移动鼠标事件与关键键事件按语义保证正确性。
7. Client runtime：account/environment/desktop generation fencing；startup/signaling/video/input/connected 与 observing/control-requested/controlling/reconnecting 分离。视频 playing 与 DataChannel open 同时成立才允许接管。
8. Panel plugin：右侧新增桌面，按 capability 显示；watch/take control/stop/retry/fullscreen/fit，消费设计系统；手机输入支持必须实测，不能只证明桌面 MouseEvent。
9. Recovery/observability：可见性恢复主动检测与有界退避；网络恢复重新协商不是重复安装；operationId、diagnosticId、分阶段耗时，不输出敏感 ticket。

### acceptance
- 真浏览器收到真实画面，接管后键鼠作用于明确目标环境；两客户端抢占/过期控制权有确定结果。
- 锁屏/断网/切会话/隐藏与重开面板不终止桌面或 Agent；恢复后默认观看，旧连接/输入不复活。
- 资源重启或机器替换后旧票据/generation 失效；启动超时可对账而不是重复安装。
- DevCloud 实际外网链路检查 ICE selected candidate、UDP/TURN fallback、视频首帧及输入时延；移动设备、中文输入和剪贴板按首期 scope 验收。
- 启动失败、编码失败、权限错误、资源不足等反馈尺寸稳定且人类可读，详情留日志。

### non_goals
- 首期不做 Agent computer-use、录屏历史、文件拖拽、音频、跨主机迁移或生产全量开关。
- 不替换 Codex/DSH 二进制；不把此前 mono2 VNC 接口仅改名 WebRTC。

### risks / next_action
- 最大未知是后端媒体引擎和 DevCloud 网络/身份入口，不是前端 JSX；Codex 客户端包没有提供其 launcher/媒体服务器的完整实现。
- 先核定目标机器，然后做隔离的后端画面→WebRTC 首帧与键鼠验证，再接控制权和面板。媒体实现候选需官方资料、许可及维护状态检查；当前未选型或安装。
- 当前版本 dirty worktree 保留；不 pull、checkout、提交或发布。缺失 README/猜测路径检索已失败，随后转向已知 main.ts/headless-server.mjs/准确类型定位；不再重复广搜。
