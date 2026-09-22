## goal
Ensure Gateway Dashboard can call Credit in Beijing sandbox, Shanghai, Singapore, and Tokyo through environment-owned configuration delivered by the normal master-to-GitOps release flow.

## non_goals
- Do not roll workloads directly or edit the `gitops` branch by hand.
- Do not change Credit authentication semantics or expose any secret value.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-21: inspect the other environments and complete Shanghai, Singapore, Beijing sandbox, and Tokyo.

## interface_refs / data_structure_refs
- `gateway-dashboard/k8s/base/manifests.yaml`: `CREDIT_INTERNAL_TOKEN` process environment contract.
- `argocd/services/gateway-dashboard/<env>/gateway-dashboard-platform.env`: `CREDIT_API_URL` environment routing.
- `scripts/ssm_manifest.runtime.sandbox-jp-1.yaml`: Tokyo SSM-to-SOPS required-key contract.

## history_context
- `current_design_refs`: `docs/engineering/domains/release-gitops.md`, especially the SSM -> master SOPS -> GitOps rule.
- `relevant_evolution`: master contains the Credit token mapping, while the current GitOps base does not; Tokyo also lacks the Credit URL and Dashboard-side token key.
- `superseded_refs`: none.

## acceptance
- All four environment renders provide `CREDIT_API_URL` and `CREDIT_INTERNAL_TOKEN`.
- Tokyo uses its regional Credit service and an environment-local token copied into the Dashboard SSM.
- Contract tests and change-impact validation pass.

## affected_paths
- `gateway-dashboard/k8s/base/`
- `argocd/services/gateway-dashboard/sandbox-jp-1/`
- `argocd/secrets/sandbox-jp-1/`
- `scripts/ssm_manifest.runtime.sandbox-jp-1.yaml`
- `.ci/runtime/tests/contract_tests/`
- `docs/engineering/domains/release-gitops.md`

## required_context
- `service-gateway-dashboard`, `site-environment-routing`, `agent-gateway-runtime`, `release-gitops`, `control-plane-ops`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/gateway-dashboard.md@f09b62866` | Dashboard service boundary | Keep the public path behind Admin Gateway and verify the service release contract. |
| `docs/context/domains/site-environment-routing.md@f09b62866` | Region isolation | Treat each environment as an independent delivery surface. |
| `docs/context/domains/agent-gateway-runtime.md@f09b62866` | Gateway boundary | Keep the change in Dashboard/runtime configuration. |
| `docs/context/domains/release-gitops.md@f09b62866` | Promotion model | Change master and let CI project to GitOps. |
| `docs/context/project/services/ctl.md@f09b62866` | Shared internal-token origin | Preserve the existing internal token contract. |
| `gateway-dashboard/AGENTS.md@f09b62866` | Local release rules | Use source-facing base and deploy-facing Argo paths. |
| `docs/context/project/adjacency/argocd-ci-secrets.md@f09b62866` | Secret neighbor | Validate SSM/SOPS and promotion together. |

## evidence
- Live read-only checks found no explicit `CREDIT_INTERNAL_TOKEN` mapping in any of the four Dashboard Deployments.
- Beijing sandbox, Shanghai, and Singapore Dashboard Secrets already contain `CTL_INTERNAL_TOKEN`.
- Tokyo Dashboard configuration lacks `CREDIT_API_URL` and its Dashboard SSM lacks `CTL_INTERNAL_TOKEN`; the regional Credit SSM contains the internal-service token source.
- Tokyo Dashboard SSM was updated from the regional Credit source and an immediate idempotency check returned `unchanged`.
- Kustomize renders for all four environments produced the expected Credit URL and required Secret reference.
- The existing 93 release-contract tests and 4 focused delivery tests passed.

## risks
- Publishing the base mapping before Tokyo SOPS contains the required key would prevent the Tokyo Pod from starting; deliver the Tokyo SSM/SOPS update in the same change.
- Production rollout remains controlled by the existing manual promotion and Argo process.

## validation
- Run the focused Gateway Dashboard Credit delivery contract tests.
- Render source and deploy overlays where encrypted-secret tooling permits.
- Run documentation and staged change-impact validation.

## decisions
- Make the secret reference explicitly required in the shared base so the base file is republished to GitOps.
- Keep regional URL values in environment overlays; do not introduce a global default.
- Copy the Tokyo Credit token within the same region into the Dashboard-owned SSM, then export SOPS.

## scan_scope
- `gateway-dashboard/k8s`, `argocd/services/gateway-dashboard`, `scripts/ssm_manifest*`, Gateway Dashboard release bundle and tests.

## scan_output
- Bounded exact searches recorded in the task execution log; no standalone artifact.

## handoff
- Implementation and local validation are complete. Commit, push, MR, CI promotion, and live rollout remain pending explicit user confirmation and the normal release process.
