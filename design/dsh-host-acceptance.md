# DSH host and page lifecycle acceptance

## Ownership and behavior

The bootstrap that creates the application owns its React root and disposal.
WorkbenchRoot borrows services; it does not independently dispose them.
Non-persisted pagehide unmounts React before owner cleanup releases services.
BFCache preserves the graph. Panel, chat, browser and terminal consumers retire
before the Host supervisor. Disposed-registry reads still throw: this fixes
disposal order rather than suppressing errors.

Unexpected exit of a locally owned DSH fails active Turns and attempts at most
three process restarts. Recovery reapplies model configuration and waits for
a fresh event-stream generation. It never replays interrupted model requests.
Explicit restart has the same rule. External DSH is restarted by its owner.

Automatic restart budget is shared across repeated short-lived processes,
and replenishes only after 60 seconds of stable readiness or an explicit
manual restart intent. Startup announcement alone does not reset it.

Local deadlines: startup 30 seconds; RPC 30 seconds without a caller signal;
reconnect readiness 10 seconds; graceful shutdown 3 seconds before SIGKILL.
Startup/shutdown deadlines are configurable for isolated tests. Process identity
and intentional-stop tracking fence old exits and shutdown callbacks.

## Executed matrix

| Scenario | Evidence |
| --- | --- |
| Exit before ready and retry | dsh-supervisor.test.ts, real Node fixture |
| Startup timeout; child ignores SIGTERM | same fixture, SIGKILL fallback |
| Unexpected exit versus intentional stop | dsh-supervisor.test.ts |
| Hung RPC deadline | same test, local HTTP server |
| Two sequential tool calls | smoke-dsh-host-acceptance.ts, real DSH with harmless printf commands |
| Partial output, interrupt and continue | same real DSH smoke |
| Restart during an in-flight request, no replay | same smoke |
| SIGKILL of exact owned test process, automatic recovery and continue | same smoke |
| History and Item identity after process restart | same smoke |
| Image through real DSH into model request | same smoke, valid synthetic PNG |
| Event-stream recovery and missed delta reconstruction | dsh-migration.test.ts |
| Approval matches tool Item; one allowed-once answer under racing replies | dsh-migration.test.ts |
| Refresh, BFCache and non-persisted unload | page-lifecycle.test.ts and production Workbench smoke |
| Two UI sends and reload without runtime-error reports | OPENCRAFT_DSH_UI_SMOKE=1 smoke-reasoning-contract.ts |

All model endpoints and keys are synthetic/local. No paid model calls or user
configuration mutations are part of acceptance.

## Gate history and final result

An initial full gate encountered “browser portal commits one dual-coordinate viewport
transaction” in workbench-timeline-host.test.ts. It expects an old source pattern
involving intersectBrowserPresentationBounds followed by this.surfaces.commit.
Neither that test nor browser-presentation-coordinator.ts is changed by this
task.

The independent test and fresh complete gate subsequently passed on the current
working tree without this task editing those files. Final typecheck, Electron
build, arm64 package and codesign verification passed. Native preview startup
was checked separately from the production-renderer synthetic send/reload/
unload verification. No remaining blocker is claimed for this acceptance matrix.
