---
id: opencraft-desktop-authorized-session
type: task
scope: 实现有界授权观看 broker 与远端确认式控制交接，保持产品与媒体边界。
triggers: ["desktop authorized session implementation", "desktop viewer broker", "confirmed desktop control wire"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "ctl/docs/cloud-desktop-resource.md"]
status: retired
reviewed_at: 2026-10-05
review_due: 2027-01-03
revision: 1.0.0
precedence: task
derived: false
---

## goal
依用户“整改，实现”，将观察底座接为授权桌面会话：一次性短凭证、身份/物理绑定重验、独立 WSS、确认/撤权控制协议。

## non_goals
不重启、发布、操作真实 TAT/云资源或修改参考包；不以控制协议冒充原生输入执行器，不开放未接权威目录的默认入口。

## requirement_refs / requirement_excerpt
本会话“整改，实现”；编号 unknown。云桌面通用插件和 Vela 产品适配保持单向依赖。

## history_context
current_design_refs：opencraft/docs/cloud-desktop-plugin.md、ctl/docs/cloud-desktop-resource.md。
relevant_evolution：只读 x11vnc/TAT 底座已实现；Codex 客户端证明远端资源与连接分离、控制需远端确认，但不证明其后端 TTL/仲裁。
superseded_refs：旧 desktop/session 不作为新观看授权。

## interface_refs / data_structure_refs
DesktopTarget/Attachment/ControlLease、LightVelaDesktopViewerPort；新增后端 Broker Authority/VerifiedStream 边界及 version-1 WSS 控制消息。只读 stream 不提供控制能力；只有提供实际撤权执行器才可确认控制。

## context_receipt
根/OpenCraft/Sandbox/CTL AGENTS；identity-access、agent-gateway-runtime、ctl-service-detail must_read；维护技能及 verification；platform-architecture 相关段、cloud-desktop-plugin、CTL resource 文档、Task/Checkpoint 模板。adjacency README/frontend-runtime-openspec-i18n 并核对现有 desktop tests 与浏览器 fixture。前轮原始 Codex 客户端分析见 2026-10-05-codex-cloud-desktop-reference。

## acceptance / validation
拒绝错误身份/目标/代次和 ticket 重放；取消/过期/撤权关闭自身连接，不停止桌面/Chat。控制确认前不绑定输入，取消后的迟到确认释放；真实 noVNC 只接收二进制媒体、不接收控制 JSON。聚焦 Go race/TS tests、双方 typecheck、boundary、浏览器 smoke、文档/impact。

## affected_paths / scan_scope
sandbox/internal/desktop；opencraft/plugins/cloud-desktop、lightvela-platform/src/desktop、tests/scripts；对应正式设计。不改 Gateway/部署路由。

## risks / decisions
权威目录与可信 incarnation 校验必须由后端实际来源实现，不接受客户端声明。Broker 注入端口无默认可信 header/auth；观察 native 服务仍拒绝输入。生产目录、远端控制执行器和多副本一致性未接不得发布能力。所有权先于 WebRTC；初始传输 WSS，不借用 Chat socket。

## checkpoint / handoff
stage：本轮模型与协议实现完成，验证收尾；源码未发布。
verified：通用 session wire、产品 viewer port、后台 broker 已实现；保留前序 dirty work。67 项 TS 聚焦测试、两端 typecheck、boundary、Sandbox 全包 test、broker race 连续 10 次和 vet 通过。真实浏览器 panel/provider/viewer/session-wire/noVNC 解码、远端确认/撤权、回收已通过，HTTP/WS/RFB peer 是明确合成边界。
unverified：生产授权目录、真实 TAT、云端控制执行器、手机弱网。
discard：不存在的 sandbox/internal/httpapi、Vela conversation 目录，改为具体入口搜索；宽 x11vnc help 输出不用于实现，未改其只读策略。首轮 npm/Go 缺 PATH/GOPATH，已显式设置；Go race 测试在 WS EOF 后立刻断言 stream Close，引入关闭顺序竞态，改为有界等待实际回收，保留先关 socket 的生产行为。
next_action：完成文档/context 门禁后交接；后续仍须实现真实权威目录、物理核验与控制执行器并单独接通公共路由，默认入口继续隐藏。

## evidence
首轮 65 项 TS 桌面测试、两端插件 typecheck、boundary passed；Go broker race 连续 10 次 passed。浏览器环境的 Playwright 在 Python driver package 内，非猜测的 node_modules；已定位原始模块。首次 Chromium 启动缺 libgbm，定位机器既有运行库后再验收，不把未启动的浏览器记为通过。gofmt 初次路径相对 sandbox cwd 重复 sandbox 前缀，已以实际包路径重跑。
后续使用既有 Playwright driver 与浏览器/运行库的隔离进程完成验收，未安装依赖、替换预览或使用真实登录。补齐账户 request 的 OK/data envelope 和 DELETE JSON 响应，并以真实 LightVelaAccountService 测试验证。WS 支持 capability 首帧认证，非要求浏览器无法发送的 bearer header；可选额外身份严格匹配。正式 documentation errors/warnings 空，docs-impact passed；root context 历史错误与本 TaskPack 检查分别记录，不冒充全仓无历史问题。
本轮 WSS（可信测试证书）与额外身份不匹配拒绝测试通过，最终 broker race 连续 10 次及 vet passed。context 初次指出两份新 Pack triggers 不足三项、参考文件完整摘要触发长十六进制 credential 误报，已补齐 triggers 并只保留摘要前 12 位；不修改历史文档。context-audit 的 33 项单测通过；root context 的 26 项单测存在全仓历史 contract 失败，单独报告，不包装成全仓通过。现有 port 80 仍为 opencraft-ssh-flex-20261005-preview.service / PID 576109；本轮无重启或切换。
最终 context 验证恢复既有 5025 项历史错误，两份新 TaskPack 的 task_errors 均为空；根 Context 单测复跑仍为历史 4 项失败（governance/chinese-first/service-budget/repository-context），其余 22 项通过。audit_context 默认输出 Markdown，初次接 JSON 解析器失败；改用隔离目录保存完整 JSON，仅报告摘要。正式 documentation 与 diff-check 最终通过。staged impact 没有 staged 文件，不作为本轮覆盖依据；显式 source/doc 文件集合的 impact 已通过。
audit discovery 已完成，assessment_status=needs_agent_review、gate_status=not_assessed、assessment_errors=0；没有 Owner assessment，不能称审计门禁已通过。完整报告只存隔离机器目录，不进入提交。
