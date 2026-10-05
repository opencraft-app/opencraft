---
id: opencraft-desktop-transport-assessment
type: task
scope: 核对 OpenCraft 云桌面的现有隧道与媒体传输约束，不部署。
triggers: ["云桌面传输评估", "desktop transport assessment", "UDP WSS"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "sandbox/internal/ingressproxy/router.go", "opencraft/plugins/lightvela-hermes/src/lib/tencent-tat-session-multiplexer.ts"]
status: retired
reviewed_at: 2026-10-04
review_due: 2027-01-02
revision: 1.0.0
precedence: task
derived: false
---

## goal
用户指出 UDP 大概率不可用，核对真实 HTTP/WSS、TAT TCP proxy 与 TURN/WebRTC 条件，明确可落地的传输建模。

## non_goals
不改生产/GitOps/安全组，不启用真实 TAT 或桌面，不读取/打印凭据，不把源码网络能力当线上已验证可达性，不更换预览。

## requirement_ids / requirement_refs / requirement_excerpt
外部编号 unknown；当前会话“继续”，承接先核验网络再选择媒体方案，不等待 WebRTC 超时后临时回退。

## history_context
current_design_refs：opencraft/docs/cloud-desktop-plugin.md、ctl/docs/cloud-desktop-resource.md。
relevant_evolution：前两轮已实现协议无关插件框架与 CTL 准备接口；无实际媒体/输入适配器。
superseded_refs：需重新核对“TAT 只负责安装启动”的说法；TAT command 和既有 TAT proxy session 不是同一能力。

## acceptance
给出源码+相邻测试/配置证据；区分 UDP 入站、出站、TURN TLS、HTTP/WSS 隧道；明确资源/观看连接/输入租约 owner 与未验证点。

## required_context / context_receipt
- AGENTS.md、opencraft/AGENTS.md、sandbox/AGENTS.md。
- OpenCraft maintenance SKILL.md 与完整 verification.md：真实能力、所有权、证据与授权边界。
- 初始路由 query `OpenCraft 云桌面 ingressproxy TAT WSS tunnel transport UDP TURN` 无匹配；有界定位错误使用不存在的 ingressproxy/pkg/main 路径，随后通过 rg --files 找到 sandbox/internal/ingressproxy 和 proxycore，不进行全仓参考扫描。
- 路由 `agent-gateway-runtime` 与 `site-environment-routing` 的 must_read 两份 Domain Pack；环境配置仅只读。
- docs/context/project/adjacency/README.md：没有桌面/TAT 专用卡，以实际源码的 WebSocket 测试和 ingress 配置核对相邻能力。
- 后续发现 legacy 桌面 Viewer 邻接 frontend，补读 frontend/AGENTS.md 与完整 frontend-runtime-openspec-i18n.md 邻接卡；只读旧桌面组件及其 installing 测试，不修改 frontend。
- 阅读官方 noVNC v1.5.0 API 与 W3C WebRTC 配置（网络工具账户路由失败时使用 curl 读取官方原文），核验公开 WebSocket channel 注入与 ICE 边界；不以新版本文档替代本仓锁定版本。

## decisions / risks
首选 WSS 是当前源码能力下的实现方向，不是 WebRTC 超时降级。现有 ingressproxy 为 HTTP/WS，TAT session 另有 TCP 二进制代理；需纠正“TAT 只负责安装启动”这一不完整表述。没有 Cloud TURN 配置不等于证明所有外部 UDP 被封；TURN/TLS 不等于 HTTP/WSS。浏览器不能把自定义 JavaScript WebSocket 直接替换成 ICE 的网络 socket。

资源、attachment、物理观看连接与独占输入租约继续分离。桌面媒体建议独立物理 TAT 会话，以免共享 Chat socket 的无公平调度/背压队列阻塞聊天；逻辑关闭隔离不证明带宽隔离。不能直发无限制 TAT session/VNC 密码并靠客户端 viewOnly 充当安全门禁。后续必须接授权 WSS broker/远端协议输入门禁，不写半套 RFB parser。

## evidence / scan_scope / scan_output
有界 sandbox ingressproxy/proxycore、OpenCraft TAT libs/tests、CTL desktop、legacy frontend 桌面与 GitOps 相关公开端口配置；未访问真实 TAT 或生产网络。

- 新增 cloud-desktop-tat-transport.test.ts：真实 RFC6455 adapter + 合成外部 TCP 流验证分片二进制、客户端 masking、1 MiB 大帧和仅关闭自己的 logical connection；不是实际 TAT/BSON 服务或 noVNC 解码验证。
- ingressproxy 既有真实本地 router/shard/upstream 集成测试增加非 UTF-8 与 1 MiB binary；保留 WSS/lifecycle 邻居测试。
- `npm run test:cloud-desktop`：19/19 通过；新增测试 strict tsc 通过。
- Sandbox 首次 Go 命令因模块不在根 go.work 失败；改用 `GOWORK=off`，不更改 workspace。`go test -race -p 2 ./internal/ingressproxy -run 'TestEndToEnd(WebSocketViaRouterAndShard|WSSViaRouterAndShard|LifecycleSwitchResetsOldWebSocketAndRoutesNewRequests)' -count=1 -timeout=120s` 通过。
- `git diff --check`、本轮显式变更集合的文档影响检查通过；文档验证 errors/warnings 均为空。Context 验证仍有 5025 项历史错误，本 TaskPack 错误为空，已重建目录索引。
- `opencraft-neutral-focus-20261004-preview.service` 仍 active，MainPID=2785955 未变；未重启或替换。此前全 npm gate 的 extension-artifacts 失败属于前序已记录范围，本轮 focused 19 例不代替全仓通过。

## checkpoint
stage：源码与本地传输评估完成；没有启动/部署。
verified：插件媒体层尚未实现；CTL 资源准备不返回媒体凭据；现有两条隧道源码可传二进制 WebSocket，本地测试通过。
unverified：实际云网络/TURN 可达性、桌面媒体吞吐、输入仲裁。
discard：不能从 HTTP transport 内部 DialContext 推断公网通用 TCP 中继。
restore：mono2-cloud-desktop-tencentos-20261004，保留此前全部 dirty 修改。
next_action：实现后端授权 attachment/WSS broker 与服务端输入门禁，再接公开 noVNC channel 与真实网络验收；本轮评估完成，不将其视为媒体已交付。
