## stage
Implementation verified on current master; preparing an isolated MR at the user's request.

## verified
- Unpaid Dianshi renewal now persists only `trade_order`; successful `renewResource` delivery records console participation.
- Internal `do_goods_and_pay` callbacks with no pending console order skip participation.
- Trade `go test ./...` and `go vet ./...` passed on current `origin/master`; mapped design-document impact check is pending final staging.

## unverified
- No live rollout or end-to-end billing callback was performed.
- Beijing pre-release's existing unpaid participation row remains unchanged.

## discard
- Early plan to infer participation from callback activity fields alone: it would consume internal renewal eligibility.

## restore
- Task Pack: `docs/context/tasks/2026-10-12-dianshi-renew-participation-on-delivery.md`.
- Relevant code: `trade/internal/logic/placeorder/service.go`, `trade/internal/logic/renewresource/handler.go`.

## next_action
- Finish staged impact check, commit, push, and create the MR; repair the existing unpaid row only with separate authorization.
