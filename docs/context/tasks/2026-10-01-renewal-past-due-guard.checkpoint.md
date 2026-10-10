## stage
Source fix and focused verification complete; no commit or deployment.

## verified
- CTL quote and order reject a renewal period whose new expiry is not in the future, before billing adapters run.
- Trade `checkRenew` rejects the same case before provider order creation; CTL callback rejects it before Pass status mutation.
- Normal future-dated renewal and overdue renewal with sufficiently long duration are accepted in focused tests.
- CTL and Trade full Go tests, Trade vet, frontend check/build, and focused frontend renewal/error tests passed. Frontend typecheck baseline has 0 new diagnostics.

## unverified
- Frontend full test suite failed under simultaneous heavy build with worker timeouts. A separate bounded-worker rerun also failed in unrelated test files and was stopped; this remains an unresolved release gate.
- Production refund for the affected order and production deployment were not performed.

## discard
- Do not treat the unrelated full-suite timeouts as proof of a renewal regression, or the prior entitlement-recovery commit as a fix for this admission bug.

## restore
- Task pack: `docs/context/tasks/2026-10-01-renewal-past-due-guard.md`.
- Source: `ctl/pkg/logic/pass/{logic.go,renew.go}`, `trade/internal/logic/checkrenew/handler.go`, `frontend/src/lib/billing-error.ts`.
- Working tree contains extensive unrelated user changes; preserve them.

## next_action
- Diagnose the existing full frontend-suite failures in a quiet environment; then request explicit approval for commit/MR/release if desired.
