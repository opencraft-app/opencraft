## goal
让 `mingyuxiao` 成为本次 support-feedback 上海/新加坡正式发布中仓库托管的 CI 与 GitOps 审核人，提交源码 MR 供独立评审。

## non_goals
- 不直接审批、重跑或同步生产流水线/Argo，也不修改凭据与云平台角色。
- 不放宽自动合并、数据库迁移和生产部署的现有审核门禁。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮请求：补齐本次发布缺失的流水线、GitOps 等权限，提交 MR 请有权限者审批。

## interface_refs / data_structure_refs
- `.ci/ticket.yml`、`.ci/gateway-dashboard.yml` 的 `PROD_REVIEWERS` 覆盖服务模板两道生产审核。
- `.ci/templates/gitops-promotion-prod.yml` 的 `check-in.reviews.flows[].reviewers` 用于两区 GitOps promote 审核。
- 其他本次发布相关审核名单、`.ci/OWNERS`、`argocd/OWNERS` 已包含 `mingyuxiao`，保持不变。

## history_context
- `current_design_refs`: `docs/engineering/domains/release-gitops.md`, `.ci/AGENTS.md`。
- `relevant_evolution`: 本次不依赖旧聊天结论，以当前 `master` 和仓库定义为准。
- `superseded_refs`: 无。

## acceptance
- 两个服务的生产审核名单和上海/新加坡 GitOps promote 审核均包含 `mingyuxiao`，旧审核人不变。
- CI 契约测试及 CI runtime 静态校验通过；MR 仅针对 `master`。
- MR 说明明确：已暂停/运行的 Stream 构建使用旧版本快照；Argo/Stream 平台角色不是这份 YAML 的授予范围。

## affected_paths
- `.ci/ticket.yml`, `.ci/gateway-dashboard.yml`, `.ci/templates/gitops-promotion-prod.yml`, `.ci/gitops-promotion-{shprod,sgprod}.yml`, `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`。

## required_context
- `release-gitops`, `tapd-gongfeng-delivery`, `identity-access`, `agent-gateway-runtime`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/release-gitops.md@master` | GitOps 边界 | 不把源码 MR 当发布 |
| `docs/context/flows/tapd-gongfeng-delivery.md@master` | MR 门禁 | 提交后独立评审 |
| `docs/context/domains/identity-access.md@master` | 授权边界 | 不改业务身份系统 |
| `docs/context/domains/agent-gateway-runtime.md@master` | 路由范围 | 不扩散到网关运行时 |
| `.ci/AGENTS.md@master` | CI 安全边界 | 不改凭据或执行生产 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@master` | 配置邻接 | 核验模板与消费方 |

## evidence
- 当前 `master` YAML 与 Gongfeng 项目成员查询；具体测试和 MR 结果见本轮交付。

## risks
- 已启动的流水线审核人不会随 `master` 修改追溯更新；需在变更合入后从新构建重新进入审核链。
- GitOps 模板供其他服务共用，此处追加发布负责人，不移除任何原有审核人。
- 平台侧独立 RBAC 若仍拒绝操作，需要平台管理员在对应系统授权，不能伪称源码 MR 已解决。

## validation
- `.ci` 合约测试；`check_ci_runtime.sh`；`git diff --check`；MR 检查。

## decisions
- 使用三处精确审核名单追加而不是调整共享 `service-release` 默认值；保留所有审核阶段。

## scan_scope
- `.ci` 中 `PROD_REVIEWERS` 和 `check-in.reviews`；`argocd/OWNERS`。

## scan_output
- 本 Task Pack `interface_refs` 所列。

## handoff
- 待独立审批 MR；合入后需要新构建，无法补授已有暂停构建。
