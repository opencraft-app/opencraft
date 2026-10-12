## goal
Move domestic Dianshi renewal participation recording from order creation to successful renewResource delivery.

## non_goals
- No production data repair or deployment.
- No change to purchase participation or international renewals.

## requirement_ids / requirement_refs / requirement_excerpt
- User request (2026-10-12): "新购就是在发货阶段才插入参与记录. 参考发货去改一下吧."

## interface_refs / data_structure_refs
- `trade_order` remains the pending-payment order ledger.
- `trade_user_activity_participation` is written only after CTL accepts renewal delivery.
- `renewResource` callback may precede the local order insert for internal do_goods_and_pay; it must still deliver without consuming console participation.

## history_context
- `current_design_refs`: `docs/engineering/journeys/subscription-purchase-renewal.md`, `trade/internal/logic/createresource/handler.go`.
- `relevant_evolution`: Dianshi renewal currently inserts order and participation in one transaction before payment.
- `superseded_refs`: none.

## acceptance
- Unpaid Dianshi renewal does not consume participation; its order can be reused.
- Successful delivery records participation once; duplicate callbacks are idempotent.
- Focused Trade tests, Go vet, and change-impact validation pass.

## affected_paths
- `trade/internal/logic/placeorder/`, `trade/internal/logic/renewresource/`, `trade/internal/store/`, `trade/internal/httpapi/server.go`, `trade/cmd/trade/main.go`.
- `docs/engineering/journeys/subscription-purchase-renewal.md`.

## required_context
- `commerce-trade-ops`, `subscription-entitlements`.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `docs/context/project/services/trade.md@working-tree` | Trade ownership | Callback and order boundaries |
| `docs/context/domains/subscription-entitlements.md@working-tree` | Entitlement lifecycle | No unpaid entitlement consumption |
| `docs/context/flows/tapd-gongfeng-delivery.md@working-tree` | Delivery rules | Isolated MR against master |
| `trade/AGENTS.md@working-tree` | Service rules | Idempotent callback verification |
| `.agents/skills/gongfeng/SKILL.md@working-tree` | MR workflow | Auth and create MR path |
| `docs/context/project/adjacency/cloudladdergateway.md@working-tree` | Billing route neighbor | No route change needed |

## evidence
- Beijing pre-release order `20261012004183299190071` was `pending_pay` while a renew participation row already existed.
- `go test ./...` passed for Trade with local loopback allowed on current `origin/master`; `go vet ./...` passed.
- `validate_change_impact.py` passed for the changed Trade paths and the mapped journey design document.

## risks
- Internal do_goods_and_pay callback can arrive before its order insert; skip participation for that path.
- Participation persistence after CTL success follows purchase's best-effort behavior and needs an error log.

## validation
- `cd trade && go test ./... && go vet ./...`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- Keep existing order reuse window and move only participation timing.
- Only a locally persisted console Dianshi renewal order in a payment-pending state consumes participation after CTL delivery. Internal `do_goods_and_pay` callbacks do not consume console eligibility, even when they arrive before their order is persisted.

## scan_scope
- `trade/internal/logic/{placeorder,renewresource,createresource}`, `trade/internal/store`.

## scan_output
- Exact symbol searches in task conversation; no bulk artifact.

## handoff
- Code and tests complete locally; user requested an MR. No deployment or live data repair requested.
- The pre-existing Beijing pre-release unpaid participation row requires separately authorized repair if the user needs renewed eligibility.
