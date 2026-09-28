## goal
Restore Shanghai realname SMS delivery and set the send-IP ceiling to 600 per minute without weakening per-recipient protections.

## non_goals
- No change to realname provider, identity proof, or Singapore environment.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-28: urgently hotfix production, then persist; set ceiling to 600/minute.

## interface_refs / data_structure_refs
- `user/auth/internal/service/verification.go`: `VerificationPolicy.SendIPLimit` and `sms:send:ip` fixed-window key.
- `LIGHTCLAW_TRUSTED_PROXY_CIDRS` controls Gin's trust of gateway-normalized `X-Forwarded-For`.

## history_context
- `current_design_refs`: `docs/engineering/domains/identity-access.md`, `docs/engineering/domains/release-gitops.md`.
- `relevant_evolution`: Shanghai gateway Pod IPs were outside Auth's trusted-proxy CIDR on 2026-09-28.

## acceptance
- Auth deployment ready, source IP in new logs is public client IP, realname SMS send 429 spike stops.
- New image reads Shanghai 600/min configuration; Argo application reaches expected revision/image and Synced/Healthy.

## affected_paths
- `user/auth/cmd/lightclaw-auth/main.go`
- `user/auth/k8s/base/manifests.yaml`
- `user/auth/k8s/overlays/shprod/patch-phone-auth.yaml`
- `argocd/services/lightclaw-auth/shprod/`

## required_context
- `identity-access`, `release-gitops`.

## context_receipt
| File | Why | Use |
|---|---|---|
| `docs/context/domains/identity-access.md@2.0.0` | Identity owner and checks | Keep identity proof unchanged |
| `docs/context/domains/release-gitops.md@2.0.0` | Release contract | Verify image and Argo state |
| `user/auth/AGENTS.md` | Auth release rules | Argo-only formal release |
| `.ci/AGENTS.md` | Build contract | Use release image script |
| `docs/context/project/adjacency/argocd-ci-secrets.md@1.0.0` | Deployment neighbor | Do not expose secrets |

## evidence
- Before hotfix, 8h Auth logs: 1136 FaceID SMS send 429, 19 send 200; 429 client IPs were gateway Pods `10.2.8.51` and `10.2.8.176`.
- After exact `/32` trusted-proxy hotfix and Auth rollout: 5m logs had 26 send 200, zero send 429.

## risks
- Gateway Pod IP rotation invalidates temporary `/32` trust; persist and later replace with an explicitly managed gateway address policy.
- Raising limit retains provider and per-recipient checks; observe provider 429 separately.

## validation
- `cd user/auth && go test ./...` using Go container: passed 2026-09-28.
- Build, publish, rollout, and Argo verification pending.

## decisions
- Temporary exact gateway Pod `/32` trust for immediate recovery; no whole Pod subnet trust.
- Add configurable send-IP limit with unchanged default 100; Shanghai override 600.

## scan_scope
- `user/auth`, `service-gateway/internal/gateway`, `argocd/services/lightclaw-auth/shprod`, `.ci/runtime`.

## handoff
- Emergency production hotfix active; complete image publication and GitOps reconciliation.
