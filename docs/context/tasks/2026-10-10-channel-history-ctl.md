## goal
为国内站渠道聊天记录提供按账号、实例和 Bot/Profile 隔离的 CTL 只读查询接口，作为前端功能的独立前置 MR。

## non_goals
- 不修改前端、公共网关 GitOps、生产开关、Hermes 持久化或部署状态。

## requirement_refs
- 原需求：在当前 Bot 的通道页只读查看各 Channel 的私聊与群聊历史；本 MR 仅提供服务端数据接口。
- 前端工作见 MR !5139；完成拆分后该 MR 应仅含前端与产品文档差异。

## interface_refs / data_structure_refs
- `GET /v1/instances/{instance_id}/bots/{bot_id}/channel-sessions`
- `GET /v1/instances/{instance_id}/bots/{bot_id}/channel-sessions/{session_id}/messages`
- Hermes Profile 独立的 `state.db` 与 `sessions.session_key`、`messages`；当前非 multiplex 部署在所有 Profile 使用 `agent:main:` 会话键，缺少渠道会话键的记录不返回。

## history_context
- current_design_refs：`docs/engineering/domains/agent-gateway-runtime.md`、`docs/context/project/services/ctl.md`。
- relevant_evolution：原 MR !5139 同时包含 CTL 与前端；本次按用户要求拆出 CTL 前置依赖。

## acceptance
- 查询按账号、实例、Bot/Profile、会话归属隔离；仅返回用户和助手可显示文本，列表与消息均可分页。
- 开关默认关闭；无权限、跨 Bot 与无法验证归属的请求不泄露记录。
- CTL 聚焦测试、静态检查和仓库变更门禁通过。

## affected_paths
- `ctl/main/api/`、`ctl/pkg/instance/`、`ctl/pkg/transport/instance.go`、`ctl/pkg/errcode/instance.go`。
- `docs/engineering/domains/agent-gateway-runtime.md`。

## required_context
- `agent-gateway-runtime`、`tapd-gongfeng-delivery`、`control-plane-ops`；`ctl/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@2.1.0` | 运行时和网关边界 | 区分 CTL 直连接口与公共路径 |
| `docs/context/flows/tapd-gongfeng-delivery.md@2.0.0` | MR 交付边界 | 分开报告源码、MR 和发布状态 |
| `docs/context/project/services/ctl.md@2.1.0` | CTL 服务责任 | 按实例和 Profile 授权 |
| `ctl/AGENTS.md` | CTL 门禁 | 聚焦测试与公共路径测试边界 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@1.0.0` | 部署邻接 | 确认源码不等于部署；本 MR 不修改 GitOps |

## evidence
- 从最新 `origin/master` 拆分原 MR !5139 的 CTL 代码；前端原工作树保持独立。
- `CGO_ENABLED=0 go test ./pkg/instance ./main/api -run 'TestReadChannelHistory|TestChannelHistory' -count=1`：两个包通过。
- `CGO_ENABLED=0 go vet ./pkg/instance ./main/api`：通过；文档检查 0 条 broken first-party links；暂存变更影响检查通过。
- `CGO_ENABLED=0 go test ./...`：失败，现有 sqlite 集成测试需要 CGO，另有测试需 rootless Docker；与本次聚焦用例失败无关。
- 2026-10-10 对照用户提供的 `CR-MR5147.md` 核对本机 Hermes `gateway/session.py`：非 multiplex 默认会为所有独立 Profile 生成 `agent:main:` 会话键。将测试 fixture 改成实际键后旧实现先失败；改用独立 Profile 数据库作为 Bot 隔离边界后聚焦测试通过。此证据未代替目标生产镜像验收。

## risks
- 目标 Hermes 镜像 schema、非 multiplex 会话键和群聊第三方消息可见性尚未现场核验；开关默认关闭，数据库路径及渠道会话键不符合预期的记录拒绝返回。
- 公共网关尚未放行新路径；直连 CTL 测试不能证明浏览器可用。

## validation
- CTL 聚焦测试覆盖命名 Bot 的实际会话键、跨 Bot 数据隔离、无效列表游标、消息上限 20 和空开关默认关闭；go vet、文档和变更影响检查通过；`git diff --cached --check` 通过。
- 全量 CTL 集成测试本轮尝试失败：宿主缺 rootless Docker，`CGO_ENABLED=0` 的 go-sqlite3 为 stub；不能据聚焦测试宣称全量通过。

## decisions
- 先交付 CTL 源码独立 MR；网关放行和开关启用保留独立门禁。

## scan_scope
- `ctl/main/api`、`ctl/pkg/instance`；搜索 `channel-sessions`、`readChannelHistory`。

## scan_output
- 命中 `ctl/main/api/server.go`、`ctl/main/api/channel_history_test.go`、`ctl/pkg/instance/channel_history.go` 及相邻测试。

## handoff
- MR !5147 已更新并核验远端分支；CI 即时 pending，未合并、未部署、未启用。前端 MR !5139 以本分支为目标。
