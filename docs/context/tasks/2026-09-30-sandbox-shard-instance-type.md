---
id: sandbox-shard-instance-type
type: task
scope: Preserve source Pool instance type when recovering from security-group limits.
triggers: ["sandbox pool split", "SG shard recovery", "instance type"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - sandbox/internal/service/sg_shard.go
  - sandbox/internal/service/pool.go
status: complete
reviewed_at: 2026-09-30
review_due: 2026-10-30
revision: 1.0.0
precedence: task
derived: false
---

## goal

When a Pool splits after a security-group limit, create the new Pool with the source Pool's instance type.

## non_goals

- Do not alter normal SKU-driven capacity growth or existing Pools.
- Do not change production operational data or deploy in this task.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-09-30: resource Pool splitting must use the Pool's machine type, not the SKU default.

## interface_refs / data_structure_refs

- `Service.ReconcileSGShardRecovery` provisions a capacity bundle from a source Pool.
- `Service.EnsurePoolForCapacityBundle` creates a Pool from a persisted bundle and SKU.
- Bundle lineage tags survive a retry between provisioning and Pool creation.

## history_context

- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: SG shard recovery shares SKU-derived Pool creation with ordinary capacity growth.
- `superseded_refs`: none.

## acceptance

- Split Pool inherits the source Pool's `instance_type` when it differs from the SKU default.
- Retried creation from a persisted split bundle preserves that type.
- Ordinary capacity growth continues to use the SKU default.
- Focused Sandbox tests pass.

## affected_paths

- `sandbox/internal/service/sg_shard.go`
- `sandbox/internal/service/pool.go`
- `sandbox/internal/service/pool_test.go`
- `sandbox/cmd/worker/main_test.go`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- `control-plane-ops`
- `sandbox/AGENTS.md`

## context_receipt

| File | Reason | Use |
|---|---|---|
| `docs/context/project/services/ctl.md` | Control-plane ownership | Locate Sandbox integration boundary |
| `sandbox/AGENTS.md` | Pool lifecycle rules | Preserve Pool-owned machine type |
| `docs/engineering/domains/agent-gateway-runtime.md` | Formal design | Record the split invariant |

## evidence

- Exact search found `ReconcileSGShardRecovery` calling `EnsurePoolForCapacityBundle`, whose new Pool takes `sku.InstanceType`.
- Normal capacity growth also calls `EnsurePoolForCapacityBundle`, so the split override must be stored on the bundle.
- SG shard recovery now saves `source_pool_instance_type` in the bundle lineage; derived Pool creation prefers it over the SKU default.
- The worker regression test uses an SA4 source Pool and an SA9 SKU default and verifies the derived Pool and bundle lineage.

## risks

- A split bundle that is retried later must not silently fall back to the SKU default.
- Existing Pools created with a wrong type require separate operational repair.

## validation

- Focused service and worker tests passed.
- `GOWORK=off GOCACHE=/tmp/codex-sandbox-go-cache go test ./...` passed when local loopback listeners were available.
- `GOWORK=off GOCACHE=/tmp/codex-sandbox-go-cache go vet ./...`, `git diff --check`, documentation validation, and change-impact validation passed.

## decisions

- Persist the source Pool instance type in bundle lineage; retain SKU default for untagged bundles.

## scan_scope

- SG shard recovery, derived Pool creation, and adjacent tests.

## scan_output

- No broad scan required.

## handoff

- Current: implementation and validation complete on a branch based on the latest `master`.
- Next: owner review and normal source delivery.
- Blockers: none.

## checkpoint

- Stage: source change validated; deployment has not been requested.
- Verified: split Pool takes the source instance type, while ordinary growth retains the SKU default; tests and static checks pass.
- Unverified: production rollout and any repair of Pools created before this fix.
- Discard: initial Sandbox test failure caused only by local socket sandboxing; the same suite passed outside that restriction.
- Restore: inspect `sandbox/internal/service/sg_shard.go`, `sandbox/internal/service/pool.go`, and this Task Pack.
- Next action: hand off the verified diff for review.
