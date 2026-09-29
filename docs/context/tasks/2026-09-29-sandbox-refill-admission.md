## goal
Separate Sandbox Pool refill failure isolation from admission, and admit auto-derived Pools only after verified CLEAN inventory.

## non_goals
- No production data repair, deployment, or GitOps promotion.
- No change to explicit operator Pool pause semantics or cloud error classification.

## requirement_ids / requirement_refs / requirement_excerpt
- User request in this conversation, 2026-09-29: fix debts 1 and 2 and open an MR.
- Debt 1: refill failure must not strand verified CLEAN inventory.
- Debt 2: newly derived Pool must not admit before its first verified CLEAN instance.

## interface_refs / data_structure_refs
- `sandbox/internal/core/types.go`: Pool `status`, `capacity_state`, `refill_paused`.
- `sandbox/internal/service/pool.go`: admission resolution and binding reconciliation.
- `sandbox/cmd/worker/main.go`: refill loop and verified creation.
- `sandbox/migrations/000012_add_pool_refill_paused.up.sql`: persistent breaker state.
- Invariant: only verified CLEAN unlocks warming admission through an atomic guarded update; terminal refill failure never discards existing admission; activation only reconciles the target Pool binding.

## history_context
- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md` Sandbox section.
- `relevant_evolution`: origin/master at `c20fa70034dfc36973c76c3e5e50b49c217ebf9c` used as MR base; existing terminal errors pause entire Pool.
- `superseded_refs`: none.

## acceptance
- Terminal/threshold refill failures persistently stop new cloud creates but preserve active Pool admission.
- Derived Pool starts warming with paused binding, counts toward growth target, and activates only after CLEAN verification.
- Sandbox tests and change-impact validation pass.

## affected_paths
- `sandbox/internal/core`, `sandbox/internal/service`, `sandbox/internal/store`, `sandbox/cmd/worker`, `sandbox/api-gin`, `sandbox/migrations`, `docs/engineering/domains/agent-gateway-runtime.md`.

## required_context
- `control-plane-ops`: `docs/context/project/services/ctl.md`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@c20fa700` | Repository constraints | Test, docs, and MR scope |
| `sandbox/AGENTS.md@c20fa700` | Service constraints | Sandbox tests and contracts |
| `ctl/AGENTS.md@c20fa700` | Candidate consumer constraints | Keep CTL eligibility gated by capacity state |
| `docs/context/project/services/ctl.md@c20fa700` | Routed context | Validate candidate selection boundary |
| `docs/engineering/domains/agent-gateway-runtime.md@c20fa700` | Domain truth | Record durable state contract |

## evidence
- Code inspection: `doRefill` formerly called `PausePool` and `EnsurePoolForCapacityBundle` formerly created active Pool/binding.
- `cd sandbox && GOWORK=off /data/go/bin/go test ./...`: all packages pass, including worker, service, faultinject and API. Release hardening adds a guarded MySQL update and targeted binding reconciliation.
- `cd sandbox && GOWORK=off /data/go/bin/go test -race ./internal/service ./internal/store ./cmd/worker ./internal/faultinject`: passed.
- `bash .ci/runtime/check_ci_runtime.sh`: passed, 601 tests (4 skipped).

## risks
- Migration must run before new binaries; existing `refill_paused` defaults false. Roll back by reverting binary then migration, preserving operator intent separately.
- Warming Pool is counted for growth to avoid duplicate derivation; a permanently failing warm Pool requires operator remediation.

## validation
- `cd sandbox && go test ./...`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- Persist `refill_paused` independently from `status`; keep manual full pause semantics. Owner: this MR.
- Use a distinct `warming` admission state; activation requires CLEAN inventory. Owner: this MR.
- Release hardening: activate with one conditional DB update and reconcile only the activated Pool binding. Owner: this MR.

## scan_scope
- `sandbox/internal`, `sandbox/cmd/worker`, `sandbox/api-gin`, `sandbox/migrations`, targeted domain document.

## scan_output
- Bounded `rg` and `sed` inspection in task session; no separate artifact.

## handoff
- MR requested; no release authorized.
