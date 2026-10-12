## goal
Make failed Trade delivery visible as a terminal `trade_order` state, including callback-before-order races.

## non_goals
- Backfill historical production orders or deploy this change.
- Change CTL delivery or billing refund behavior.

## requirement_ids / requirement_refs / requirement_excerpt
- User request: continue fixing failed orders whose `trade_order` status was not updated.

## interface_refs / data_structure_refs
- `trade_order.status`: `paid_pending_provision`, `provisioned`, `provision_failed`.
- `trade_flow.status`: `in_progress`, `completed`, `failed`; only create/renew/modify delivery flows project failure to the order.
- `GenerateDealsAndPayResponse.DealDeliverResults[dealName].state`: `0` success, `3` permanent failure; other states are not terminal failure.

## history_context
- `current_design_refs`: `docs/engineering/domains/subscription-entitlements.md`, `trade/internal/store/order_write.go`.
- `relevant_evolution`: callback-before-insert was previously solved for delivery by removing the callback's dependency on `trade_order`; it did not solve order-status projection.
- `superseded_refs`: historical successful-orders-only comment in `trade/internal/logic/placeorder/service.go`.

## acceptance
- Existing and later-inserted orders reflect terminal delivery failure without overwriting a successful order.
- Transient callback errors and in-progress delivery stay nonterminal.
- Trade lint, vet, and tests pass.

## affected_paths
- `trade/internal/store/`, `trade/internal/logic/placeorder/`, `trade/internal/logic/creditorder/`.
- `docs/engineering/domains/subscription-entitlements.md`.

## required_context
- Route `commerce-trade-ops`; `docs/context/project/services/trade.md`, `trade/AGENTS.md`.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `docs/context/project/services/trade.md` | Trade ownership | Scope of state changes |
| `trade/AGENTS.md` | Service gates | Tests and vet |
| `docs/context/domains/subscription-entitlements.md` | Domain invariants | Payment/provisioning separation |
| `trade/docs/README.md` | Service entry | Test contract |
| `docs/context/project/adjacency/README.md` | Adjacency index | No trade-specific card; inspected store tests instead |

## evidence
- Source inspection: `MarkFailed` and `MarkFailedByID` updated only `trade_flow`; one-step Pass orders persisted only on synchronous success.
- `GOCACHE=/tmp/mono2-trade-order-go-cache go test ./...` passed (2026-10-12; local httptest listener permission required).
- `GOCACHE=/tmp/mono2-trade-order-go-cache go vet ./...` passed.
- Store tests cover atomic failure projection, rollback on projection error, callback-before-insert reconciliation, and terminal-status guard.

## risks
- Callback and order insertion may race; projection runs from both directions and uses conditional nonterminal updates.
- Existing historical rows require a separate, reviewed backfill.
- SQL statement/transaction shape is covered by a recording driver; no live MySQL integration test or production validation was performed.

## validation
- `GOCACHE=/tmp/mono2-trade-order-go-cache go test ./...`
- `GOCACHE=/tmp/mono2-trade-order-go-cache go vet ./...`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- Preserve order identity for asynchronous and failed one-step orders while keeping delivery callbacks independent from the order row.

## scan_scope
- `trade/internal/store`, `trade/internal/logic/placeorder`, `trade/internal/logic/creditorder`.

## scan_output
- Bounded `rg` and file reads in the task session.

## handoff
- Implemented and verified on local `codex/trade-order-provision-failure`; user authorized commit, push, and creation of an MR targeting master. No production change.
- Historical failed orders are not backfilled. Trade code deployment and any data repair require separate approval.
