## goal
Make user-initiated instance resume asynchronous and converge CTL/Sandbox states after the cloud start completes.

## non_goals
- Change billing renewal, pass expiration, or instance resize semantics.
- Deploy to production in this task.

## requirement_ids / requirement_refs / requirement_excerpt
- User request (2026-10-10): resume must not block the request on CVM startup; follow the pause flow.

## interface_refs / data_structure_refs
- `POST /v1/instances/{id}/resume`: accept with `Resuming`, then finish through a durable task.
- `POST /sandboxes/{id}/resume`, `GET /sandboxes/{id}`: submit start and reconcile `RESUMING` to `ALLOCATED` only after CVM is `RUNNING`.
- `instances.status`, `tasks.task_state`, and Sandbox instance state are separate authorities.

## history_context
- `current_design_refs`: `ctl/pkg/instance/logic.go`, `sandbox/api-gin/handler.go`, `sandbox/internal/provider/tencent.go`.
- `relevant_evolution`: pause already submits StopInstances and reconciles via GET; resume still polls synchronously.
- `superseded_refs`: none.

## acceptance
- Resume HTTP request returns while instance is `Resuming`; worker eventually records `Running` after Sandbox reports running.
- Repeated start submissions and canceled HTTP requests do not leave an unowned transition.
- Focused CTL and Sandbox tests pass.

## affected_paths
- `ctl/pkg/instance/`, `ctl/pkg/taskruntime/`, `ctl/pkg/adapter/sandbox/`, `sandbox/api-gin/`, `sandbox/internal/provider/`, `sandbox/openapi.yaml`.

## required_context
- `control-plane-ops`, `docs/context/project/services/ctl.md`, `ctl/AGENTS.md`.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `docs/context/project/services/ctl.md@2.1.0` | CTL ownership | Keep public API and task boundaries separate |
| `ctl/AGENTS.md` | Local constraints | Cover source and API behavior |
| `docs/context/tasks/TASK-TEMPLATE.md@2.1.0` | Task format | Record task state |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md@2.0.0` | Handoff format | Preserve verified state |
| `docs/engineering/domains/agent-gateway-runtime.md` | Formal design | Record async resume ownership |

## evidence
- 2026-10-10: client canceled after 45 seconds; Sandbox completed CVM start in 47.1 seconds; CTL rollback reused canceled context and left `Resuming`.

## risks
- Duplicate start requests: CVM start submission and Sandbox state transitions must be idempotent.
- Old Sandbox images return only after startup: CTL task must tolerate both versions.
- Concurrent isolate/delete: CTL must use status-precondition updates.

## validation
- `ctl`: `go test ./pkg/instance/... ./pkg/adapter/sandbox/... ./pkg/taskruntime/...` passed.
- `sandbox` with `GOWORK=off`: `go test ./api-gin ./internal/provider` passed.
- `go vet` passed for those package sets; change-impact check passed.

## decisions
- Durable CTL task owns user-initiated resume; no detached goroutine.
- Keep synchronous provider `StartInstance` for resize, add a submit-only variant for resume.

## scan_scope
- `ctl/pkg/instance`, `ctl/pkg/taskruntime`, `ctl/pkg/adapter/sandbox`, `sandbox/api-gin`, `sandbox/internal/provider`.

## scan_output
- Bounded `rg` results in this task turn.

## handoff
- Commit, push, and master-targeted MR were explicitly authorized on 2026-10-10; production deployment was not authorized.
- Live cluster behavior is unverified until CTL and Sandbox images are built and deployed through the normal release flow.

## checkpoint
### stage
Implementation and focused verification complete; master MR review and release remain.

### verified
- Sandbox submits CVM start and reconciles `RESUMING` on GET; CTL accepts user resume with a durable task.
- CTL adapter waits for the reconciled running state in the task context; ambiguous errors remain retryable.
- Focused tests, vet, and mapped design-doc check passed.

### unverified
- End-to-end behavior through public gateway and production Argo revisions, not deployed here.

### discard
- Earlier synchronous-start assumption and request-context rollback path.

### restore
- Resume changes span `ctl/pkg/instance`, CTL Sandbox adapter, Sandbox handler/provider, and the Sandbox OpenAPI enum.

### next_action
- Obtain owner review of the master MR; deploy CTL before Sandbox so old CTL does not treat asynchronous submission as completed startup.
