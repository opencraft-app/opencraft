---
id: collaboration-privilege-readiness-20260916
type: task
scope: 让 Collaboration bootstrap 在 CynosDB 账号异步创建后安全授予目标库权限。
triggers: ["Collaboration bootstrap", "CynosDB account readiness", "database privilege grant"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - infra_pulumi/pkg/collaborationbootstrap/tencent.go
  - docs/engineering/domains/release-gitops.md
status: active
reviewed_at: 2026-09-16
review_due: 2026-12-15
revision: 1.0.0
precedence: task
derived: false
---

## goal
对 CynosDB 新账号尚未就绪的已知瞬态错误做有界等待，让同次 bootstrap 能完成 DB 级授权。

## non_goals
- 不直接修改云账号权限、不重跑流水线、不创建或合并 MR。
- 不放宽其他云 API 错误、不扩大授权范围或修改 Secret。

## requirement_ids / requirement_refs / requirement_excerpt
- Stream Collaboration foundation #6：审批后 `ModifyAccountPrivileges` 返回 `InvalidParameterValue.AccountNotExistError`。

## interface_refs / data_structure_refs
- `TencentDatabaseAdmin.SetDatabasePrivileges`；目标必须是 `collaboration_rw@%` 在 `lightvela_collaboration` 的既定 DB 权限。
- `Run` 顺序仍为 SSM → 账号 → 逻辑库 → DB 级权限；未知错误立即失败，瞬态等待必须有时限并尊重 context 取消。

## history_context
- `current_design_refs`：`docs/engineering/domains/release-gitops.md` 的 Collaboration 北京两阶段 bootstrap。
- `relevant_evolution`：#5 账号密码失败后，!4078 修复中断恢复；#6 账号与库创建请求成功，但即时授予权限报账号未存在。只读 API 随后确认账号和逻辑库均存在、权限为空。
- `superseded_refs`：不能把创建 API 返回当作资源就绪证明。

## acceptance
- 测试先证明瞬态账号未就绪会失败，再证明仅该错误被有界重试并最终成功。
- 非瞬态错误仍立即返回；超时/取消不无限等待或自动扩大权限。
- Go 包测试、vet、race 和 docs-impact 通过；不声称北京运行态已收敛。

## affected_paths
- `infra_pulumi/pkg/collaborationbootstrap/tencent.go` 与测试。
- `docs/engineering/domains/release-gitops.md`、`infra_pulumi/README.md`。

## required_context
- `service-infra-pulumi`、`release-gitops` 和最近的 `infra_pulumi/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/infra-pulumi.md@1.0.0` | 路由必读 | infra 控制面边界 |
| `docs/context/domains/release-gitops.md@2.0.0` | 路由必读 | 发布与 GitOps 责任划分 |
| `infra_pulumi/AGENTS.md`、`infra_pulumi/README.md` | 服务入口 | 验证、Secret 与故障重入约束 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@1.0.0` | 邻接卡 | 核验 CI 与 Secret 边界 |

## evidence
- #6 Stream apply 日志报 `AccountNotExistError`；同一集群只读查询显示目标账号和库各 1、目标库授权 0。
- 腾讯云 `CreateAccounts` 文档返回任务 ID；`ModifyAccountPrivileges` 将账号不存在列为正式错误码。
- 聚焦回归先 RED：新账号授权首次报账号未就绪时，旧适配器立即返回错误；实现有界重试后 GREEN。
- Go 全量 test、vet、build 与受影响包 race 通过；docs-impact、文档校验与 diff 检查通过。

## risks
- 重试只允许已知瞬态账号未就绪错误，不能遮蔽权限、参数或网络错误。
- 不打印或读取密码、DSN、IM Secret 值。

## validation
- `GOWORK=off go test ./pkg/collaborationbootstrap ./cmd/infractl`、`go vet`、受影响包 `go test -race`、docs-impact 与 diff 检查。
- `infractl preview --stack beijing-sandbox` 已尝试，但当前本地 Pulumi 凭据缺失，报 `tencent cloud credentials are required to query cluster endpoints`；不能称 preview 通过。

## decisions
- 在腾讯云适配器的授权调用边界做有界等待，保持通用 bootstrap 状态机与 Secret 顺序不变。

## scan_scope
- `infra_pulumi/pkg/collaborationbootstrap/`、正式发布设计和相关 API 文档。

## scan_output
- 有界精确搜索；不持久化云 API payload。

## handoff
- 本地实现与验证后等待提交/推送授权；不代为重跑或合并。#6 apply 已失败，云端账号和库存在但目标 DB 权限为空。
