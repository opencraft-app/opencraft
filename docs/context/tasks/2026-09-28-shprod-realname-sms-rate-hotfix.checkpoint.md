## stage
Production hotfix and GitOps reconciliation complete; source MR awaits mandatory review.

## verified
- Shanghai Auth and both workers rolled out image digest `sha256:415146adee7e4ebc701eab8950cfaaa2a5025fc0026680069203bb2acd5f6300`.
- Auth Pod environment has send-IP ceiling 600 and exact current gateway Pod `/32` trusted proxies.
- GitOps MR !4694 merged; Argo `lightclaw-auth-shprod` is `Synced/Healthy` at `f3eb55b`.
- Last observed FaceID SMS send sample after sync: 2 HTTP 200, zero HTTP 429 in five minutes.

## unverified
- Source MR !4695 has passing CI but requires protected-branch review; API merge returned `Review check not passed`.
- Exact gateway Pod `/32` addresses need a durable rotation-aware trust model before those Pods are replaced.

## discard
- Pre-hotfix 429 counts should not be treated as current state.

## restore
- Task Pack: `docs/context/tasks/2026-09-28-shprod-realname-sms-rate-hotfix.md`.
- GitOps MR: `https://git.woa.com/wisp/mono2/-/merge_requests/4694`.
- Source MR: `https://git.woa.com/wisp/mono2/-/merge_requests/4695`.

## next_action
- Obtain required owner review for source MR !4695; then monitor gateway Pod IP rotation and plan stable trust registration.
