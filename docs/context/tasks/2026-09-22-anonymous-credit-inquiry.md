## goal
Allow logged-out users on domestic and international sites to quote Credit packages with the environment-owned inquiry fallback identity while preserving authenticated ordering and ownership checks.

## non_goals
- Do not make order, payment, refund, or package-query APIs anonymous.
- Do not change product prices, billing definitions, or fallback account values outside environments that currently lack one.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-22: Credit package inquiry fails while logged out; configure the default inquiry account for domestic and international sites by following Pass behavior.

## interface_refs / data_structure_refs
- `POST /v1/credit/inquiry` is the only user API made optional-auth.
- `TRADE_INQUIRY_FALLBACK_UIN` and `TRADE_INQUIRY_FALLBACK_APP_ID` remain the environment-owned quote identity.
- Credit orders continue to require a non-empty `external_user_id`.

## history_context
- `current_design_refs`: `docs/engineering/domains/subscription-entitlements.md`, `credit/AGENTS.md`.
- `relevant_evolution`: Trade already supports a quote-only fallback identity for Pass/general inquiry, but Credit uses a separate `creditorder` service and did not consume it.
- `superseded_refs`: none.

## acceptance
- Anonymous Credit inquiry reaches Credit through Service Gateway and returns the Trade quote using fallback UIN/AppID.
- Authenticated inquiry retains the caller user ID and resolves its binding first.
- Orders with no user ID remain rejected.
- Domestic and international deploy configs expose only inquiry and order-url as optional-auth Credit routes.

## affected_paths
- `credit/internal/httpapi/`
- `trade/internal/logic/creditorder/`
- `trade/cmd/trade/`
- `argocd/services/service-gateway/`
- `argocd/services/trade/sandbox-bj-7/`
- service documentation and tests.

## required_context
- `subscription-entitlements`, `commerce-trade-ops`, `service-credit`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/subscription-entitlements.md@7595dcaeb` | Purchase and entitlement boundary | Keep anonymous access quote-only. |
| `docs/context/project/services/trade.md@7595dcaeb` | Trade ownership | Reuse the existing billing quote fallback. |
| `docs/context/project/services/credit.md@7595dcaeb` | Credit ownership | Change only the user-facing inquiry handler. |
| `trade/AGENTS.md@7595dcaeb` | Trade local rules | Preserve strict order and callback behavior. |
| `credit/AGENTS.md@7595dcaeb` | Credit API contract | Document optional-auth inquiry. |
| `service-gateway/AGENTS.md@7595dcaeb` | Gateway release boundary | Change deploy-facing environment configs through master and CI. |
| `docs/context/project/adjacency/cloudladdergateway.md@7595dcaeb` | Billing transport neighbor | Confirm no billing proxy protocol change is needed. |

## evidence
- Trade environment configs already define fallback identities for Beijing sandbox, Shanghai, Singapore, and Tokyo.
- Service Gateway currently allows anonymous Credit order-url only.
- Credit currently rejects inquiry without `X-User-Id`.
- Trade `creditorder` currently requires `external_user_id` for both quote and order and does not consume generic inquiry fallback config.
- Credit full tests and vet passed; Service Gateway full tests and vet passed; Trade affected-package tests and vet passed.
- Five Service Gateway environments and Beijing 7 Trade rendered successfully with the expected optional-auth and fallback contracts.
- The focused delivery contract and 94 existing release-bundle contract tests passed.
- Trade full tests have two unrelated pre-existing failures in `internal/cloudbillingclient` caused by direct non-canonical header map assertions; all packages touched by this change pass with cache disabled.

## risks
- Accidentally weakening order identity checks would allow unowned orders; quote and order preparation remain explicitly separated.
- Publishing Gateway before backend images only preserves the current failure behavior temporarily; it does not expose order APIs.

## validation
- Credit and Trade focused tests plus full package tests.
- Service Gateway route policy tests.
- Kustomize/config contract checks for domestic and international environments.
- Documentation and staged change-impact validation.

## decisions
- Reuse the existing Trade fallback UIN/AppID rather than introducing a second Credit-specific account setting.
- Prefer an authenticated user's binding; fallback is quote-only and used for anonymous or unbound users.
- Add Beijing 7's documented mock billing identity as its fallback so the same flow can be tested there.

## scan_scope
- `credit/internal/httpapi`, `trade/internal/logic/creditorder`, Trade env config, Service Gateway Credit route configs/tests.

## scan_output
- Bounded exact searches recorded in the task execution log.

## handoff
- Implementation and local validation are complete. Commit, push, MR, CI publication, and live regression remain pending explicit user confirmation and the normal release process.
