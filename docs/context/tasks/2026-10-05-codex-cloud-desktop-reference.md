---
id: codex-cloud-desktop-reference
type: task
scope: 只读核对本地 Codex 云桌面客户端的授权、连接与控制所有权。
triggers: ["Codex cloud desktop reference", "desktop reference ownership", "cloud desktop control confirmation"]
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
回答“你先看一下 codex 咋搞的 /data/codex-new”，区分客户端事实与后端推测。

## non_goals
不继续实现、不重启、不执行参考包、不操作云资源。此记录不是新的正式设计决策。

## requirement_refs / requirement_excerpt
本会话最新请求；需求编号 unknown。

## history_context
current_design_refs：opencraft/docs/cloud-desktop-plugin.md、ctl/docs/cloud-desktop-resource.md。
relevant_evolution：只读 VNC 服务与后端 TAT 通道已形成底座，公开授权观看及控制执行器尚未接通。
superseded_refs：无。只读媒体入口不能代替完整授权桌面会话。

## interface_refs / data_structure_refs
参考客户端 command/exec、X-Codex-Desktop-Token、control/request、control/locked、control/release、MODE_CHANGE；我方 cloud-desktop contract 与 LightVela desktop provider。保持会话绑定环境、身份固定、迟到控制不得重新启用输入、连接销毁不等于资源销毁。

## context_receipt
完整读取根 AGENTS、OpenCraft 入口、agent-gateway-runtime must_read、维护技能及 verification、OpenAI Docs 技能；参考包 README。读取 adjacency README/frontend-runtime-openspec-i18n 并核对 cloud-desktop-plugin 测试邻居；读取 platform-architecture 桌面段、contract 与 provider。

## evidence
参考包 /data/codex-new/codex-26.930.31428-12913，版本 26.930.31428 / build 12913，是客户端解包，不是云端源码。
- 原始 panel-da547d640131.js 全文读取；SHA256 前 12 位 655f4b954cd3。
- 原始 src-51803043763e.js 全文读取；SHA256 前 12 位 42c6b4ec9356。
- app-initial 的 scoped target/tab 片段与 analysis/chunk_qfs 相互核对；Main 的 performDesktopFetch 身份固定及允许目标 URL 片段核对。heuristic split 不视为原始模块边界。
- 远端命令启动 detached cloud-agent-desktop serve，status 返回 session_id 与专用 bearer_token；经过固定 account/user 身份的信令换取 WebRTC answer。
- 视频 playing 与 data channel opened 独立双就绪；默认观察。控制请求本身不更改客户端 mode，收到 control/locked 后才切换；panel 还检查当前控制意图，确认后才绑定输入。按钮显示存在乐观意图状态，不宣称 UI 完全等于远端确认。
- 离开面板焦点或 window blur 立即解绑输入并释放控制；清理先 retired，再 abort、解绑、disconnect、清空视频，不发远端 stop。失败提供显式重试；未见自动 ICE 重连、TURN 配置或 WebSocket 媒体兜底。

## acceptance / validation
只读事实均定位到原始客户端文件；无产品源码变更，不运行产品测试。git status 核对保留已有 dirty work；仅新增本记录。上下文与文档验证另记交接结果。

## affected_paths / scan_scope
本 TaskPack；参考范围限定上述 unpacked/webview/assets 与 Main 精确函数。未改变参考文件。

## scan_output / risks
初始文件名搜索过宽，改用精确模块；voice webrtc-session、desktop auth 页面、语法 grammar 均排除。官方搜索工具 Account Pool 404，官方页面 curl 403，无可用官方文档补充证据。服务端令牌有效期、权限核验、独占控制与 Agent 仲裁无法从此包确认；无客户端 TURN 配置不等于证明所有 WebRTC 路径只能用 UDP。

## decisions / handoff
可以借鉴授权桌面会话、远端资源独立生命周期、确认式输入控制与迟到结果隔离；网络适配保持可替换，我方受限网络仍需自己的 WSS/TAT 路径。专用有界桌面令牌可以下发客户端，但不下发通用 TAT/VM 凭据。未授权继续实施或重启。

## checkpoint
stage：分析完成，等待用户选择下一步。
verified：上述客户端事实。
unverified：云端仲裁、令牌有效期、受限网络真实可达性。
discard：误匹配语音 WebRTC 模块，不作为桌面依据；官方网络检索失败不作为事实。
restore：保留本工作树此前全部改动，参考包只读。
next_action：交付证据和所有权对比，不自动实施。
