---
id: native-login-sgprod-config-2026-09-09
type: task
scope: Native OIDC production configuration preparation, without rollout.
triggers: ["native OIDC sgprod", "native client registration", "sgprod native token"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - argocd/services/lightclaw-auth/sgprod/auth-platform.env
  - argocd/services/service-gateway/sgprod/config.yaml
status: active
reviewed_at: 2026-09-09
review_due: 2026-12-08
revision: 1.0.0
precedence: task
derived: false
---

# Native OIDC sgprod configuration

## goal
Prepare reviewed source and GitOps changes registering the native public client and exact token route.

## non_goals
- No live changes, auto-merge, production build/sync, secrets, or domestic configuration changes.

## requirement_ids / requirement_refs / requirement_excerpt
- User: “好 搞起来”, approving configuration/MR preparation after native login explanation.
- Source implementation: mono2 MR !3762.

## interface_refs / data_structure_refs
- user/auth/cmd/lightclaw-auth/oidc_config.go
- user/auth/internal/oidc/registry.go
- service-gateway/internal/gateway/config.go
- Invariants: preserve Sites registry; one exact native callback; only POST token exchange public.

## history_context
- current_design_refs: docs/engineering/domains/release-gitops.md
- relevant_evolution: master 9de5a0e95 includes native flow; gitops 123ccc4e9 only promotes new Auth to Tokyo sandbox.
- sgprod Auth pin source bf1c36960ed4 rejects more than one OIDC client.
- superseded_refs: none.

## acceptance
- Actual sgprod registry passes current Auth validation.
- Actual gateway configuration forwards POST token, rejects GET and adjacent native routes anonymously.
- Existing Sites callbacks remain unchanged.
- GitOps remains blocked until verified new sgprod Auth image and release gates.

## affected_paths
- argocd/services/lightclaw-auth/sgprod/
- argocd/services/service-gateway/sgprod/config.yaml
- user/auth/cmd/lightclaw-auth/native_sgprod_config_test.go
- service-gateway/internal/gateway/native_sgprod_config_test.go

## required_context
- release-gitops, identity-access, site-environment-routing

## context_receipt
| File (master 9de5a0e95) | Reason | Use |
|---|---|---|
| AGENTS.md | Repository boundaries | No live mutations |
| docs/context/domains/release-gitops.md | Deployment | Image plus Argo proof |
| docs/context/domains/site-environment-routing.md | Environment | sgprod only |
| docs/context/domains/identity-access.md | Ownership | Auth and gateway validation |
| docs/context/project/adjacency/argocd-ci-secrets.md | Neighbor | Bundle and Kustomize inspection |
| docs/engineering/domains/release-gitops.md | Design | Source/config synchronization |
| argocd/apps/sgprod/README.md | Admission | Manual release and environment gates |
| argocd/services/lightclaw-auth/sgprod/README.md | Config | Rollout prerequisite |
| user/auth/AGENTS.md | Auth | Runtime tests |
| service-gateway/AGENTS.md | Gateway | No generated platform changes |
| .ci/AGENTS.md | CI | No pipeline mutations |
| .agents/skills/gongfeng/SKILL.md | MR | MCP authentication requirement |
| .agents/skills/devops-pipeline/SKILL.md | Release | No build without parameter approval |

## evidence
- GitOps auth pin history ec495de50 identifies source bf1c36960ed4.
- That revision validates len(clients)==1, disabling OIDC on a second entry.
- New source merged in !3762; only Tokyo promotion !3765 observed.

## risks
- BLOCKER: do not merge/sync configuration-only GitOps candidate with old sgprod Auth image.
- No current Argo credentials or CI token; cannot claim running image or Healthy/Synced.

## validation
- Auth and Gateway full go test ./... and go vet ./... passed using installed Go 1.25.4 with GOWORK=off.
- Documentation validation and staged change-impact passed.
- Context catalog regenerated; 314 baseline context errors remain, zero introduced errors after normalizing worktree paths.
- Source/GitOps registry and gateway auth route parity passed.

## decisions
- Prepare source and blocked GitOps branches separately, do not invent production image digest.
- Do not alter keys, generic return-to hosts, CORS origins, or global OIDC TTL.

## scan_scope
- sgprod Auth/Gateway manifests; OIDC registry source/tests; release bundle.

## scan_output
- No additional behavior changes required.

## handoff
- Implementation and service verification complete; branches prepared for push and review.
- Source branch: codex/native-login-sgprod-config-source, target master.
- Blocked deployment candidate: codex/sgprod-native-login-config, target gitops. Do not merge until a verified supported sgprod Auth image is included.
- MCP CLI unavailable and BK_CI_ACCESS_TOKEN absent; no authenticated MR/CI API operations.

## checkpoint
- Configurations and rollout prerequisite written to isolated source and GitOps worktrees.
- Initial Go invocations hit workspace Go 1.26 requirement/toolchain download environment; resolved by using installed Go 1.25.4 with module-local mode (both go.mod require 1.25).
- No production image pin changed, no live calls made, no new credential requested for local work.
