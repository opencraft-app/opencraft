## goal
Route Beijing pre-release Dianshi renewal quotes and orders through separate tkexgz production proxy routes backed by opc-dianshi-activity.production.polaris:80.

## non_goals
- No change to new-purchase routes, Beijing 7 testing, Shanghai, or Singapore.
- No production rollout or live provider call in this change.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-10-10: add tkexgz Dianshi renewal quote/order routes and switch Beijing pre-release calls to the production backend.

## interface_refs / data_structure_refs
- `trade/internal/dianshiclient.Client.GetRenewPrice` calls `get_price_renew`.
- `trade/internal/dianshiclient.Client.DoGoodsRenew` calls `do_goods_renew`.
- Optional dedicated URLs take precedence over the existing `DIANSHI_RENEW_BASE_URL`, which remains the fallback.
- `cloudladdergateway/config.example.yaml` owns backend aliases, caller allowlist, and route IDs.

## history_context
- `current_design_refs`: `docs/engineering/journeys/subscription-purchase-renewal.md`, `cloudladdergateway/config.example.yaml`.
- `relevant_evolution`: master commit `45d7b271e` already introduced the dedicated renewal protocol and a single staging renewal base URL.
- `superseded_refs`: none.

## acceptance
- Beijing pre-release renders separate quote/order URLs through tkexgz production and the specified backend.
- Other region Trade configs and shared gateway defaults do not connect to this production backend.
- Existing new-purchase and legacy renewal behavior stays intact.
- Trade and Gateway tests, vet, Kustomize rendering, and design impact checks pass.

## affected_paths
- `trade/`, `cloudladdergateway/`, `argocd/services/trade/beijing-sandbox/`, `argocd/services/cloudladdergateway/tkexgz/`, `docs/engineering/`.

## required_context
- `commerce-trade-ops`, `subscription-entitlements`, `release-gitops`, `service-cloudladdergateway`.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `docs/context/project/services/trade.md` | Trade boundary | Scope provider routing |
| `docs/context/domains/subscription-entitlements.md` | Renewal behavior | Preserve pass semantics |
| `docs/context/domains/release-gitops.md` | Deployment boundary | Distinguish source edit from rollout |
| `docs/context/project/services/cloudladdergateway.md` | Gateway auth | Keep authenticated proxy |
| `trade/AGENTS.md` | Local service contract | Run service checks |
| `cloudladdergateway/AGENTS.md` | Local gateway contract | Check route tests |
| `docs/context/project/adjacency/cloudladdergateway.md` | Neighbor checklist | Check config and tests |

## evidence
- `trade/internal/dianshiclient/client.go` already has dedicated renewal methods; this change only splits their outbound URLs.
- The old Beijing pre-release `DIANSHI_RENEW_BASE_URL` pointed to a different gateway and is replaced only in that overlay.
- Beijing pre-release Kustomize renders both dedicated URLs through `81.71.196.13` and leaves the old base URL empty.
- tkexgz production Kustomize renders both backend overrides to `opc-dianshi-activity.production.polaris:80`.
- Beijing 7 does not render the new dedicated URLs.

## risks
- The production backend must accept `get_price_renew` and `do_goods_renew`; live verification follows rollout.
- Deploy the gateway before Trade so the new route IDs exist when Trade starts sending requests.
- Shared route definitions remain unreachable outside tkexgz production because backend defaults are loopback port 1.

## validation
- Trade and Gateway full `go test ./...` and `go vet ./...`.
- Kustomize renders for Beijing pre-release and unaffected regions.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`.
- Completed: both service test suites and vet pass on `origin/master@8949f90ef`.
- Completed: Beijing pre-release, Beijing 7 and tkexgz production Kustomize rendering checked.

## decisions
- Preserve master renewal protocol and old single-base fallback; use new separate URLs only in Beijing pre-release.
- Keep production backend override in tkexgz production manifest, not in the shared default.

## scan_scope
- Trade renewal client/config, gateway config, Beijing pre-release overlay, tkexgz manifest, adjacent tests.

## scan_output
- Bounded search results in this session.

## handoff
- Local implementation validated on current master; no deployment performed.
- Gateway route must be released before Beijing pre-release Trade; then check Argo, Pod environment and an authorized renewal call.

## checkpoint
### stage
- Local validation complete; preparing MR.
### verified
- Master renewal protocol remains `get_price_renew` / `do_goods_renew`.
- Dedicated route selection and old-base fallback pass tests; rendered environment paths match the target.
### unverified
- Live tkexgz route rollout and upstream acceptance of the renewal requests.
### discard
- Earlier old-branch patch using purchase `get_price` / `do_goods` for renewals; master already replaced that protocol.
### restore
- Continue from this clean master-based branch and the files listed above; the original worktree's unrelated changes remain untouched.
### next_action
- Stage only this branch's changes, run impact checks, commit, push, and create MR.
