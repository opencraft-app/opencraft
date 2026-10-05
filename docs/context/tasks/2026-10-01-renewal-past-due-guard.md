## goal
Prevent paid Pass renewals whose purchased duration still ends in the past.

## non_goals
- Do not change the provider's `curDeadline` pricing baseline or automatically adjust historical orders.
- Do not refund or otherwise mutate the already-paid production order in this code change.

## requirement_ids / requirement_refs / requirement_excerpt
- Incident: `usr_aa4465b228f7ab84be2c1e03`, Shanghai renewal deal `20261001469180560301971` (2026-10-01). One month from 2026-08-28 ended 2026-09-28; payment/delivery completed after that date.
- User request: quickly fix the bug and assess whether recent fixes covered it.

## interface_refs / data_structure_refs
- `ctl` Pass renewal price, order, and `RenewPass` callback paths; `CalcExpiredTime` is the calendar arithmetic authority.
- `trade` `lightvela.pass.checkRenew` is the provider pre-purchase callback.
- Invariant: reject when `CalcExpiredTime(pass.expired_time, span, unit) <= now` before collecting payment; keep the original expiry as the pricing and grant baseline.

## history_context
- `current_design_refs`: `docs/engineering/journeys/subscription-purchase-renewal.md`, `ctl/pkg/logic/pass/logic.go`, `trade/internal/logic/checkrenew/handler.go`.
- `relevant_evolution`: commit `e072e3692` repaired active Pass AI entitlement recreation, not unusable renewal-period admission; `93707cad0` added Dianshi renewal but retained existing period semantics.
- `superseded_refs`: none.

## acceptance
- A 1-month renewal from 2026-08-28 is rejected on 2026-10-01 before quote/order/payment.
- A longer period ending in the future remains purchasable; provider callback rejects a stale paid order before Pass mutation so billing can refund.
- Focused tests and service checks pass.

## affected_paths
- `ctl/pkg/logic/pass`, `ctl/pkg/errcode`, `trade/internal/logic/checkrenew`, `frontend/src/lib`, `frontend/src/pages/marketing/renew-pass-modal.tsx`, `frontend/src/i18n/generated`, `docs/engineering/journeys/subscription-purchase-renewal.md`.

## required_context
- `subscription-entitlements`.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md` | Repository boundaries | No production write without separate authorization; test gates |
| `trade/AGENTS.md` | Billing callback boundary | Preserve provider contract and callback test |
| `ctl/AGENTS.md` | Pass owner boundary | Keep Pass authority in CTL |
| `frontend/AGENTS.md` | UI/i18n checks | Map explicit user-facing error |
| `docs/context/domains/subscription-entitlements.md` | Required domain pack | Provider rules remain external authority |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Adjacent UI generation | Check generated locale and test neighbor |
| `docs/engineering/journeys/subscription-purchase-renewal.md` | Current journey | Record admission invariant |

## evidence
- Live read-only evidence: Pass expiry 2026-08-28 -> 2026-09-28, task SUCCESS, provider deal status 4 after 2026-10-01 purchase.
- Code: `CalcExpiredTime` uses original expiry; current order/quote/checkRenew lack a candidate-expiry-vs-now check.
- Focused regression: one month from 2026-08-28 is denied on 2026-10-01; two months and a normal future-dated renewal are accepted; quote/order reject before a billing adapter is available.

## risks
- Calendar arithmetic must match CTL and provider months; use natural-month rollover tests.
- A stale order may pass preflight but expire before payment; callback gate must reject without mutating Pass.
- Existing static-date tests may need future-dated fixtures.
- Provider-side `checkRenew` remains an additional pre-purchase gate; CTL owns both public quote and order admission. A stale order paid after its useful deadline is rejected at delivery before Pass mutation so the provider can refund.

## validation
- `cd ctl && go test ./...`
- `cd trade && go test ./... && go vet ./...`
- `cd frontend && pnpm check && pnpm test && pnpm build`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` when staged for delivery.

## decisions
- Preserve old-expiry billing semantics; reject non-useful periods instead of silently changing the baseline.

## scan_scope
- `ctl/pkg/logic/pass`, `trade/internal/logic/checkrenew`, `frontend/src/lib`.

## scan_output
- Bounded `rg` and cited source locations in this task pack.

## handoff
- Source patch complete, no commit or deployment. `ctl go test ./...`, `trade go test ./...`, `trade go vet ./...`, frontend `npm run check`, frontend build, focused renewal/error tests (50 passing), and typecheck baseline (0 new diagnostics) passed. Frontend full-suite run under concurrent build load failed widely with worker timeouts (54 files failed, 260 passed); a separate bounded-worker rerun still failed in other test files and was stopped. The full-suite release gate remains unresolved. `validate_change_impact` flags the broad `ctl/**` agent-gateway rule although this patch changes subscription admission, not gateway architecture; the relevant subscription journey is updated, and the unrelated gateway design document was not modified merely to satisfy the matcher. Production order refund and deployment remain separate operations.
