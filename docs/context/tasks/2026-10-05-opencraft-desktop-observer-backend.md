---
id: opencraft-desktop-observer-backend
type: task
scope: 为授权观看代理补齐服务端只读入口和后端专用 TAT 字节通道。
triggers: ["desktop observer backend", "云桌面只读入口", "restricted TAT desktop transport"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["ctl/docs/cloud-desktop-resource.md", "opencraft/docs/cloud-desktop-plugin.md"]
status: retired
reviewed_at: 2026-10-05
review_due: 2027-01-03
revision: 1.0.0
precedence: task
derived: false
---

## goal
继续桌面后端实现：只读由成熟 VNC 服务执行，TAT 凭据留在后端，专用物理连接只能到固定观看端口。

## non_goals
不开放未授权 HTTP 路径，不以客户端 viewOnly 冒充服务端授权；不启动系统桌面、操作云/TAT、重启预览、发布或提交。

## requirement_ids / requirement_refs / requirement_excerpt
编号 unknown；本会话“继续”，沿用“注意云桌面插件和 vela 插件的边界”。

## history_context
current_design_refs：ctl/docs/cloud-desktop-resource.md、opencraft/docs/cloud-desktop-plugin.md。
relevant_evolution：2026-10-04 资源准备和传输评估；2026-10-05 noVNC/provider 单向边界完成，生产 viewer broker/input gate 未接通。
superseded_refs：旧 desktop/session 密码与任意 TAT 客户端凭据不能替代新授权观看。

## interface_refs
`sandbox/internal/provider/desktop_observer.go` 的 backend-only OpenDesktopObserver；不是新增 HTTP route 或授权 endpoint。`ctl/pkg/instance/desktop_observer.go` 的原生只读 unit 生成器，原四 unit provision 保持不变。

## data_structure_refs
desktopProxyFrame（Session/Channel/Proxy 校验与 BSON binary），desktopObserverStream（独立 socket、io.Pipe 背压、取消/close fence）。只接受固定 127.0.0.1:5901，物理 incarnation 与权威 attachment 仍由后续 broker 提供。

## context_receipt
已完整读根 AGENTS、OpenCraft AGENTS、CTL AGENTS、Sandbox AGENTS、维护技能及 verification；路由命中 agent-gateway-runtime 与 control-plane-ops 并完整读 must_read。已读 CTL/Sandbox docs README、桌面正式设计与前序 TaskPack。
有界搜索 desktop/session、StartTerminalSession、PtyProxy；读取 adjacency README/frontend-runtime-openspec-i18n 卡与旧 frontend 桌面实现邻居。错误猜测 adjacency/terminal.go/sandbox main/pkg 路径后改用 rg --files/精确符号；不继续猜测扩大扫描。
技能用于取消、迟到结果、独立物理连接及诚实的分层验收。

## acceptance / validation
独立观看服务只监听回环且原生 viewonly、关闭剪贴板与远程控制；旧 Ubuntu/TencentOS 安装与四 unit 行为保留。后端通道不接受用户 IP/端口、保持二进制字节、限制内存/握手、取消关闭仅自己的 socket，不影响 Chat。源码/模拟传输与真实服务证据分别报告。

## affected_paths / scan_scope
ctl/pkg/instance 桌面安装与测试；sandbox/internal/provider TAT 专用观看传输；正式桌面文档。不触及公开 HTTP 路由或 GitOps。

## decisions / risks
独立只读回环入口作为授权 broker 的底座，非公开 capability。控制模式仍需实际执行器仲裁；本轮不提供空壳控制租约。TAT 是专用后端物理连接，不复用 Chat mux。启用真实观看仍需绑定授权、物理 incarnation 核验和消费端 broker。

## checkpoint
stage：本轮观看底座及最终验证完成，未接入公开 capability。
verified：CTL 与 Sandbox 全包 go test 通过；两端受影响包 go vet 通过；provider 整包 race 通过。隔离 Xvfb/x11vnc 原生 key/pointer/clipboard 正负对照连续 3 次通过，默认测试显式跳过此 opt-in 原生验收。没有启动 systemd unit、执行真实 TAT 或重启预览。文档 validator errors/warnings 空，docs-impact passed，gofmt/diff check 通过。
unverified：生产绑定授权、incarnation 证明、broker/control、真实 TAT/云上设备与弱网恢复。
restore：mono2-cloud-desktop-tencentos-20261004，保留前序全部 dirty 修改。
discard：web 工具 Account Pool route 404，使用官方 GitHub raw help.c 只读检索。本机 x11vnc help 过长，后续有界过滤；测试初次 pipe reader 主动关闭使远端 EOF 变为 ErrClosedPipe，改为只关闭 writer；原生负对照出现 X MappingNotify，测试 probe 明确跳过事件再读 reply，未改生产协议。一次 gofmt cwd 错误，重跑根路径后通过。
next_action：后续实现 canonical Conversation/Server 授权绑定、物理 incarnation 核验和有界 attachment broker，然后接入产品 viewer port。控制模式需另外实现真实输入执行器仲裁，不在只读通道上绕过。默认入口仍隐藏。

## evidence / validation / handoff
- CTL `go test -p 2 ./...` passed；Sandbox `GOWORK=off go test -p 2 ./...` passed。provider 整包 race 和两端 go vet passed；最终 CTL Desktop 聚焦 race passed，provider observer race 连续 10 次 passed。
- 原生测试 OPENCRAFT_DESKTOP_NATIVE_TEST=1，`TestDesktopObserverNativeReadOnly -race -count=3` passed。测试只用新分配的 display 与临时端口；所有测试子进程自行释放，不使用安装的 vela units 或真实工作桌面。
- docs-impact 显式本轮文件 passed；正式文档 validator errors/warnings 空。context 首次发现新 TaskPack 缺 interface_refs/data_structure_refs，补齐后 task_errors 为空；历史 5025 项独立保留。
- 运行态核对发现前序记录的 neutral-focus 预览已 inactive；当前真正端口 80 属于 `opencraft-ssh-flex-20261005-preview.service`，MainPID=576109，active。本轮没有服务切换操作，不沿用旧 PID 声称预览一致；五个 desktop units 均 inactive，observer 未安装/启动。
- 本轮维护技能促使使用真实服务负对照，避免只靠 flags/string tests 声称后端只读。TAT 字节测试仍使用合成 WS/BSON，不能冒充生产授权或真实 TAT。
