---
id: task-2026-09-29-agentchat-token-ttl
type: task
scope: CTL AgentChat 启动令牌有效期对齐 SDK 续期窗口。
triggers: ["agentchat token ttl", "启动令牌有效期", "agentchat refresh"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - ctl/pkg/agentchat/agentchat.go
  - ctl/pkg/config/config.go
status: active
reviewed_at: 2026-09-29
review_due: 2026-10-29
revision: 1.0.0
precedence: task
derived: false
---

## goal
将 CTL AgentChat 启动令牌默认及源码配置有效期从 5 分钟统一为 10 分钟，并通过 MR 交付 master。

## non_goals
- 不改变聊天消息/Agent Turn 的执行超时。
- 不在本任务中直接修改或发布生产 GitOps 配置。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户在本会话要求“把5min改成10min”“提交mr 合入master”。

## interface_refs / data_structure_refs
- `ctl/pkg/agentchat/agentchat.go`: 令牌 `iat`、`exp` 及验签。
- `ctl/pkg/config/config.go`: AgentChat TTL 默认值，`timestamp_skew_seconds` 独立保持 300 秒。
- `frontend/src/pages/marketing/agent-chat-panel.tsx`: 续期回调读取 CTL `expiresAt`。

## history_context
- current_design_refs: `docs/engineering/journeys/agent-request-streaming.md`。
- relevant_evolution: 当前 CTL 源码配置为 300 秒，而 AgentChat SDK 按 600 秒假设并约在第 6 分钟预刷新。
- superseded_refs: none。

## acceptance
- 无配置时签发的令牌在第 9 分钟有效、第 10 分钟过期。
- 显式 TTL 仍可覆盖默认值；回调时间戳容差不变。
- CTL 测试通过，MR 仅包含本任务文件。

## affected_paths
- `ctl/pkg/agentchat/`, `ctl/pkg/config/`, `ctl/conf/{local,test,server}/common/server_conf.toml`。
- `docs/engineering/journeys/agent-request-streaming.md`。

## required_context
- `tapd-gongfeng-delivery`, `control-plane-ops`, `agent-gateway-runtime`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库交付边界 | 限定生产 GitOps 与验证 |
| `ctl/AGENTS.md` | 服务边界 | 确认 CTL 测试 |
| `docs/context/flows/tapd-gongfeng-delivery.md` | MR 流程 | 授权与完成条件 |
| `docs/context/project/services/ctl.md` | 服务 Context | 确认源码入口 |
| `.agents/skills/gongfeng/SKILL.md` | Gongfeng 工具 | 鉴权与 MR 路径 |
| `docs/context/flows/change-delivery.md` | 交付流程 | Task Pack 与文档同步 |
| `docs/context/domains/agent-gateway-runtime.md` | Agent 领域边界 | 区分接入令牌与执行时长 |
| `docs/context/project/adjacency/argocd-ci-secrets.md` | 运行配置邻接 | 不读取解密值 |

## evidence
- 源码检索确认 CTL 默认值及三个 common TOML 均为 300 秒；SDK 假设 600 秒并约第 6 分钟预刷新。
- CTL `go test ./...` 通过。
- CTL `go vet ./...`、文档完整性校验、docs-impact 与 context-audit 单测通过。
- Context Catalog 全量校验失败于仓库既有 Task Pack schema 错误；过滤检查未见本任务 Task Pack 错误。
- 本机 Git 凭据无法用于 Gongfeng API；用户重新提供的 API 令牌只在当前会话临时用于鉴权，`get_current_user` 返回 `skipzhang`。

## risks
- 已部署生产环境的加密 common 配置可能仍覆盖为 300 秒；源码合并不等于生产生效。后续发布必须单独检查实际运行配置，并经授权修改 GitOps。
- 延长令牌寿命扩大泄露后的有效窗口；继续依赖签名、实例/用户绑定和到期验签。

## validation
- `cd ctl && go test ./...`
- `git diff --check`
- 变更影响与文档门禁。

## decisions
- 保持 300 秒回调时间戳容差与前端预刷新逻辑不变；只延长启动令牌 TTL。

## scan_scope
- `ctl/pkg/agentchat`, `ctl/pkg/config`, `ctl/conf`, `argocd/services/ctl`。

## scan_output
- 有界 `rg` 结果见本任务证据；未输出任何密钥值。

## handoff
- 代码与测试完成后创建并合并 MR；生产发布另行确认。

## checkpoint
- stage: 本地提交准备完成，下一步创建 MR 并核验合并结果。
- verified: CTL 测试、vet、文档完整性与 docs-impact 通过；Gongfeng 当前会话鉴权有效。
- unverified: 生产运行配置是否仍覆盖为 300 秒；未发布。
- discard: 本机 Git 凭据不能用于 Gongfeng API 鉴权。
- restore: 仅提交本任务 staged 文件；仓库已有其他未提交修改需保留。
- next_action: 提交、推送本任务分支、创建并合并 MR。
