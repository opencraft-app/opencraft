---
id: sandbox-multiregion-lifecycle
type: task
scope: Region-aware sandbox cloud lifecycle with immutable pool-region ownership.
triggers: ["sandbox multi-region", "pool region", "regional cloud lifecycle"]
status: active
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - sandbox/internal/provider/provider.go
  - sandbox/internal/provider/tencent.go
  - sandbox/internal/service/pool.go
reviewed_at: 2026-09-17
review_due: 2026-12-16
revision: 1.0.0
precedence: task
derived: false
---

# Sandbox Multi-Region Lifecycle

## goal

Route every sandbox CVM, CBS, and TAT lifecycle operation through the region derived from its owning pool, while preserving existing Singapore behavior.

## non_goals

- Creating Johor cloud network resources or pools.
- Changing CTL admission policy or moving user traffic.
- Adding an `instances.region` column.
- Releasing or mutating live workloads.

## requirement_ids / requirement_refs / requirement_excerpt

- User requirement, 2026-09-17: support multiple regions; maintain existing instances in region A while new capacity can live in another region.
- User decision, 2026-09-17: derive region from the owning pool for now; pool edits must not cross regions.

## interface_refs / data_structure_refs

- `sandbox/internal/core/types.go::Pool.Zone`, `Instance.PoolID`, `Sandbox.Region`.
- `sandbox/internal/provider/provider.go::CloudProvider` and snapshot/delivery extension interfaces.
- `sandbox/internal/provider/tencent.go::TencentCloudProvider`.
- `sandbox/internal/service/pool.go::UpdatePool`.
- Invariant: a pool may change zone/network only inside its original region.
- Invariant: no cloud lifecycle request may silently fall back to `TENCENT_REGION` when an owning pool is available.

## history_context

- `current_design_refs`: `sandbox/AGENTS.md`, `docs/context/project/services/ctl.md`, remote master TAT delivery implementation.
- `relevant_evolution`: commit `0855590be` moved delivery health checks to TAT but retained a single configured region for CVM/CBS/TAT lifecycle clients.
- `superseded_refs`: pre-TAT direct-IP health verification is not an implementation target.

## acceptance

- Cross-region pool updates are rejected; same-region zone updates remain valid.
- Create, describe, reinstall, terminate, stop, start, snapshot, and TAT delivery verification all receive an explicit pool-derived region.
- Existing Singapore tests pass without configuration changes.
- Missing/invalid region fails closed.

## affected_paths

- `sandbox/internal/service/`
- `sandbox/internal/provider/`
- `sandbox/cmd/worker/`
- `sandbox/api-gin/`
- `sandbox/internal/api/`
- `sandbox/internal/faultinject/`
- `.ci/hermes-image.yml`
- `images/build-manifest.json`
- `images/tests/test-build-image-sync.py`
- sandbox design/operations documentation selected by change-impact validation.

## required_context

- Pack `control-plane-ops`.
- `sandbox/AGENTS.md`.
- `docs/context/project/services/ctl.md`.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@c15e963260c9d29028954078e10b0451989b5b88` | Repository P0 rules and task-pack requirement | Isolation, validation, and release boundaries |
| `sandbox/AGENTS.md@c15e963260c9d29028954078e10b0451989b5b88` | Sandbox lifecycle and test invariants | Preserve state-machine and worker ownership |
| `docs/context/project/services/ctl.md@c15e963260c9d29028954078e10b0451989b5b88` | Routed control-plane context | Keep instance orchestration boundaries explicit |
| `docs/context/tasks/TASK-TEMPLATE.md@c15e963260c9d29028954078e10b0451989b5b88` | Required task state contract | Structure this task pack |

## evidence

- Remote master TAT delivery verification is present in commit `0855590be`.
- Master provider currently constructs CVM/CBS clients from one `cfg.Region` and lifecycle interfaces accept cloud IDs without region.
- Instances retain `pool_id`; pools retain zone.
- Added strict Tencent zone parsing and cross-region pool-update rejection while preserving same-region zone changes.
- Added `CloudInstanceRef` and region-keyed CVM/CBS client caches; compiler-driven updates cover refill, reset, cleanup, pause/resume, snapshots, TAT delivery, and same-SP resize.
- `GOWORK=off go test ./...`, `GOWORK=off go vet ./...`, and affected-package race tests passed.
- Documentation validation and change-impact validation passed; owner review is required for `agent-gateway-runtime`.
- Hermes image build, reuse, and default target-region lists include `ap-johorbahru`; image sync tests pass.

## risks

- Missed cloud-ID-only caller sends a Johor ID to Singapore; mitigate with an explicit region-bearing provider contract and compiler-driven call-site updates.
- Pool metadata crosses regions; mitigate with old/new region comparison in `UpdatePool`.
- Mock/test implementations mask region bugs; add recording fakes and negative tests.

## validation

- Red-green tests for pool update invariant and region routing.
- `cd sandbox && GOWORK=off go test ./...`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- Relevant documentation/context validation if mapped docs change.

## decisions

- Region is derived from the owning pool rather than stored on each instance in this slice.
- Provider lifecycle methods receive an explicit region-bearing reference.
- Allocation and infrastructure rollout remain separate later slices.

## scan_scope

- `sandbox/internal/provider`, `sandbox/internal/service`, `sandbox/cmd/worker`, `sandbox/api-gin`, `sandbox/internal/api`, `sandbox/internal/faultinject`.

## scan_output

- Exact search results recorded in this task discussion; no broad scan artifact.

## handoff

- Status: lifecycle region slice implemented and locally verified in isolated worktree `codex/sandbox-multiregion-lifecycle`.
- Remaining separate slices: Johor-first admission, TAT-only route behavior, Pulumi network-only fabric, and controlled release.
- No commit, push, MR, GitOps, deployment, or cloud-network mutation performed.
