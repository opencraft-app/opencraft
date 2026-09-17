# 国际站升配支付窗口闪退修复

## goal

修复国际站升配新订单因计费查询短暂空结果被误写为 `cancelled`，导致前端关闭支付窗口的问题，并通过正常发布链路完成新加坡生产验收。

## non_goals

- 不修改计费订单、支付流水或生产数据库状态。
- 不把 hosted payment 的通用失败页文案解释为银行卡真实拒付。
- 不调整 `ContractOrder`、`PayType`、`PayScene`、`PayOption` 或销售点参数，除非新的支付交易证据证明存在独立问题。

## requirement_ids / requirement_refs / requirement_excerpt

- 产品现场 Deal：`20260916034013593505231`，Big Order：`20260916034013593505221`。
- 需求：计费查询短暂未命中不能让有效升配单永久取消或让支付窗口闪退。

## interface_refs / data_structure_refs

- `trade/internal/logic/orderstatus.Service.QueryStatus`
- `qcloud.Deal.getDealsByKeyIndex`
- `trade_order.status`
- 明确终态：`canceled` / `overdue` / `delete`

## history_context

- `current_design_refs`：`docs/engineering/journeys/subscription-purchase-renewal.md`
- `relevant_evolution`：国际站新购、续费和升配共用 Billing CloudAPI `CreatePayUrl`；本次只修订单状态反查语义。
- `superseded_refs`：旧实现把 `totalNum=0` 或空 `deals` 直接解释为取消。

## acceptance

- 空查询结果返回本地 `pending`，不调用 `MarkOrderCancelled`。
- 计费明确取消、超时或删除时，既有取消同步仍保持。
- Trade 专项测试、`go vet ./...`、change-impact 门禁通过。
- 发布后核对新加坡 Trade 的 GitOps revision、镜像、Pod Ready 与 Argo `Synced/Healthy`。
- 使用新升配订单验证支付窗口不再因假 `cancelled` 闪退；若 hosted payment 仍失败，记录新的 Billing Request ID/支付交易标识另行排查。

## affected_paths

- `trade/internal/logic/orderstatus/service.go`
- `trade/internal/logic/orderstatus/service_test.go`
- `trade/internal/jifeiclient/getdealsbykeyindex.go`
- `docs/engineering/journeys/subscription-purchase-renewal.md`

## required_context

- `subscription-entitlements`
- `release-gitops`
- `commerce-trade-ops`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@dd2fbbc20` | 仓库安全、测试和发布边界 | 约束生产发布与验收证据 |
| `trade/AGENTS.md@dd2fbbc20` | Trade 服务硬规则 | 保持订单和回调语义 |
| `docs/context/domains/subscription-entitlements.md@dd2fbbc20` | Pass、支付和权益边界 | 区分支付、订单和交付状态 |
| `docs/context/domains/release-gitops.md@dd2fbbc20` | 生产发布证据链 | 要求 GitOps、镜像与 Argo 联合验证 |
| `docs/context/project/services/trade.md@dd2fbbc20` | Trade 服务责任 | 不复制或猜测外部计费规则 |
| `.ci/AGENTS.md@dd2fbbc20` | CI 发布约束 | 使用正常流水线而非手工改 Pod |

## evidence

- 现场订单本地由 `pending_pay` 在创建后约一秒被写成 `cancelled`，计费 Deal 仍为初始化态且没有支付开始字段。
- 生产用户当前支付方式上下文查询为已存在支付方式；这不能证明故障时刻的历史状态，也不足以支持修改 `ContractOrder`。
- 干净 `origin/master` 与修复分支均存在相同的两个 `cloudbillingclient` Header 断言失败，确认不是本次修改引入。

## risks

- 真正已取消但上游仅返回空结果时，本地状态会短暂保持 pending；后续明确终态查询或业务超时负责收敛。
- hosted payment 可能仍有独立支付侧问题；没有 Request ID 或支付交易号时不得宣称银行卡拒付。
- 回滚方式：恢复旧的空结果映射；但会重新引入支付窗口闪退，因此仅在发现新的一致性问题时采用。

## validation

- `cd trade && go test ./internal/logic/orderstatus ./internal/httpapi/internalapi ./internal/jifeiclient ./internal/logic/placeorder -count=1`
- `cd trade && go vet ./...`
- `git diff --check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions

- 空结果按上游暂不可见处理，回退本地状态；只有明确终态才能写取消。
- 不在本修复中加入未经该用户现场证据支持的国际支付参数调整。

## scan_scope

- `trade/internal/logic/orderstatus`
- `trade/internal/logic/placeorder`
- 国际站新购/续费 `ContractOrder` 与 `PayType` 历史提交

## scan_output

- 有界 Git 历史和现场只读查询摘要记录于本 Task Pack，不保存凭据或完整支付 URL。

## handoff

- 源码修复和本地验证完成；下一步提交 MR、合并、正常流水线发布并执行新订单生产验收。
