## goal
将新加坡和上海正式站好友邀请活动的总积分预算提高到 `BIGINT` 最大值，使总预算在实际运营规模内不再封顶。

## non_goals
- 不调整每位邀请人最多 50 笔、2026-12-31 截止、首次付费资格、每笔 500 积分或既有欠发奖励。

## requirement_ids / requirement_refs / requirement_excerpt
- 本轮用户要求：先只调上限预算；结束时间后续再议。

## interface_refs / data_structure_refs
- `referral_campaign.budget_credit` 为有符号 `BIGINT`；`referral-campaign` 读取 `REFERRAL_BUDGET_CREDIT` 并 upsert。
- `referral/internal/store/mysql.go`：超预算时不创建奖励；已处理事件的 inbox 保证幂等，提升预算本身不重放历史事件。

## history_context
- `current_design_refs`: `docs/context/domains/release-gitops.md`、`docs/engineering/domains/release-gitops.md`。
- `relevant_evolution`: 原两地总预算各 100000，生产 DB 只读核对已全部占用。

## acceptance
- 两地渲染后的 ConfigMap 总预算为 `9223372036854775807`，原有上限和时间保持不变。
- 分别通过生产 GitOps、Argo sync、campaign hook 和数据库只读验证；不得把源码配置视为线上已生效。

## affected_paths
- `referral/k8s/overlays/{sgprod,shprod}/kustomization.yaml`
- `.ci/runtime/tests/gitops_tests/test_referral_config_rollout.py`
- `docs/engineering/domains/release-gitops.md`

## required_context
- `site-environment-routing`, `release-gitops`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@78111d485` | 双站隔离 | 两地独立配置、验证 |
| `docs/context/domains/release-gitops.md@78111d485` | 发布边界 | 验证 live Argo 和 DB |
| `referral/AGENTS.md@78111d485` | 服务边界 | Campaign Job 更新 DB |
| `.ci/AGENTS.md@78111d485` | 生产准入 | 独立生产同步 |

## evidence
- 2026-09-29 20:35 CST 只读查询：两地活动 `budget_credit=100000`，各有 100 个邀请关系生成奖励、总承诺 100000。

## risks
- 极大预算是业务成本放宽；本次只改活动总预算，仍保留单人上限和结束时间。
- 既有欠发奖励不自动补发；回滚恢复原数字可能阻止新奖励，但不撤销已发奖励。

## validation
- Referral 渲染测试、`git diff --check`、变更影响校验、生产 live 对账。

## decisions
- 以 `9223372036854775807` 表示实践上不受总预算约束，而非引入新 sentinel/修改服务代码。

## scan_scope
- `referral/k8s/overlays/{sgprod,shprod}`, `argocd/services/referral`, `.ci/runtime/tests/gitops_tests`。

## scan_output
- 仅摘要；无全仓扫描。

## handoff
- 源码变更须在生产独立批准的 GitOps 路径合入并同步。欠发补发另案。
