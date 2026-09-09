---
id: task-credit-package-master
type: task
scope: 将北京 7 已验证的 Credit 积分包能力整理为基于最新 master 的可审查变更。
triggers: ["credit package master", "积分包合入", "credit master MR"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-08-credit-package-master.md
status: active
reviewed_at: 2026-09-08
review_due: 2026-10-08
revision: 1.1.0
precedence: task
derived: false
---

# Credit 积分包合入 master

## goal
将北京 7 已验证的 Credit 付费积分包能力整理为基于最新 `master` 的独立可审查变更。

## non_goals
- 本次不实现免费积分和套餐积分迁移。
- 本次接线北京 `beijing-sandbox`，但不接线上海生产环境，也不在 MR 阶段直接执行发布。
- 本次不包含北京 7 分支上的 OAuth、实名、证书、Dashboard 或其它无关环境改动。

## requirement_ids / requirement_refs / requirement_excerpt
- 来源：当前对话，外部需求标识 `unknown`。
- 积分包采用一次性资源包计费，无续费；Credit 自主管理自然到期并直接销毁。
- 计费支持询价、下单并支付、资源查询、用量查询/推送和退款隔离。

## interface_refs / data_structure_refs
- `credit/AGENTS.md`：Credit 服务边界、API、数据模型与生命周期。
- `credit/migrations/`：商品、live/history package、用量 outbox 和 ID 分配表。
- `trade/internal/logic/creditorder/`、`trade/internal/logic/creditresource/`：订单与计费回调。
- `argocd/services/credit/sandbox-bj-7/`：北京 7 API、worker 与 migration 接线。
- `argocd/services/credit/beijing-sandbox/`：北京 API 与 worker 发布真源；独立数据库和 SSM
  Secret 已在合入前预置。
- 不变量：积分使用定点小数；订阅按完整名称精确匹配/删除；回调和 flow 幂等；归档后不再推量。

## history_context
- `current_design_refs`：`credit/AGENTS.md`、`docs/engineering/domains/subscription-entitlements.md`、`docs/engineering/domains/release-gitops.md`。
- `relevant_evolution`：功能在 `playground/sandbox-bj-7` 联调后，从最新 `master` 重新整理干净变更，避免直接合入该分支的无关提交。
- `superseded_refs`：`.tmp` 中早期包年包月和续费方案仅供历史回退，不作为当前设计。

## acceptance
- Credit、Trade、Service Gateway 受影响测试和 vet 通过。
- CI runtime contract、GitOps render、YAML、secret scanner 和 docs-impact 门禁通过。
- MR 只包含 Credit 业务、Trade 集成、北京 7 验证接线、北京 `beijing-sandbox` 发布接线、
  Credit 专用现网计费回调和对应正式文档。

## affected_paths
- `credit/`
- `trade/`
- `service-gateway/` 与北京 7/北京 `service-gateway` 配置
- `.ci/`、`argocd/services/credit/`、北京 catalog/Secret、CloudLadderGateway 现网配置
- `docs/engineering/`、`docs/context/tasks/`、`go.work`

## required_context
- `subscription-entitlements`
- `release-gitops`
- `commerce-trade-ops`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/subscription-entitlements.md@78c77d5c6` | 权益领域边界 | 明确 Credit 与 Trade 的所有权 |
| `docs/context/domains/release-gitops.md@78c77d5c6` | 发布边界 | 按 master/GitOps 模型补齐北京发布真源，不在 MR 阶段直接发布 |
| `docs/context/project/services/trade.md@78c77d5c6` | Trade 服务约束 | 保持回调幂等和 provider 边界 |
| `credit/AGENTS.md@working-tree` | Credit 当前设计 | 核对资源包生命周期、用量和 API |
| `trade/AGENTS.md@working-tree` | Trade 本地规则 | 确定测试和计费集成边界 |
| `.ci/AGENTS.md@78c77d5c6` | CI 交付规则 | 确定 bundle 与 runtime 验证 |

## evidence
- `credit`: `go test ./... -count=1`、`go vet ./...` 通过；HTTP、生命周期、service、usage
  受影响包 `go test -race` 通过。
- `trade`: `go test ./... -count=1`、`go vet ./...` 通过；三个 Credit logic 包 `go test -race`
  通过。全量测试因 `httptest` 需要本地 socket 在获准环境重跑通过。
- `service-gateway`: `go test ./internal/gateway -count=1`、`go vet ./internal/gateway` 通过。
- CI contract 定向测试 84 项通过；`check_ci_runtime.sh` 495 项通过。
- Credit、Trade、Service Gateway 的 `sandbox-bj-7` Kustomize 均渲染通过；变更 YAML 的
  `check-yaml`、Credit SOPS secret scanner、`git diff --check` 通过。
- 北京 `credit` 库/用户和 SSM runtime Secret 已预置；Credit、Trade、Service Gateway 的
  `beijing-sandbox` 以及 `tkexgz`/`tkexsg` CloudLadderGateway Kustomize 渲染通过。
- Documentation contract 8 项、Credit route、docs-impact 和全仓文档 validator 通过；Service Catalog
  为 24/24。全量 context suite 的 3 个历史 Task Pack/凭据扫描失败在原始 `master@78c77d5c6`
  基线可复现，当前变更未增加失败数。
- 刷新 `origin/master` 后，分支基线与远端同为 `78c77d5c6`。

## risks
- 外部计费 contract 漂移：由 Trade 定义校验、回调测试和真实环境 E2E 缓解。
- 多次购买误删其它权益：按完整 subscription name/ID 精确匹配和删除。
- 多 Pod 重复推量：`next_retry_time` 加 CAS lease 抢占，并冻结重试 payload。
- migration 顺序错误：独立 Credit migration Job，发布前验证 schema 和 seed。

## validation
- `cd credit && go test ./... && go vet ./...`
- `cd trade && go test ./... && go vet ./...`
- `cd service-gateway && go test ./internal/gateway`
- `.ci/runtime` 定向测试与 `check_ci_runtime.py`
- Kustomize、YAML、secret scanner、change-impact 与文档门禁。

## decisions
- 从最新 `master` 构建干净分支，不直接以北京 7 历史分支创建 MR。
- 本次保留北京 7 验证接线并补齐北京 `beijing-sandbox` 发布闭环；上海和其它地域仍独立变更。

## scan_scope
- `credit/`、Trade Credit 集成、北京 7 与北京 Credit/Trade/Service Gateway 配置、
  CloudLadderGateway Credit 回调、CI bundle。

## scan_output
- 以最终 staged diff、测试输出和 MR 描述为准。

## handoff
- 合入前验证已完成；提交、push 和创建 MR 均等待用户确认。
