# CloudAgent Runtime Warm Pool

## Goal

The warm pool is an optional latency optimization for CloudAgent runtime start and
resume. It pre-creates disposable runtime hosts so a session can claim them with
a database compare-and-swap instead of waiting for both sandboxes to be created
from scratch.

Correctness does not depend on the pool. If the pool is disabled or empty, the
gateway uses the existing cold path.

## Boundary

The pool warms only session-agnostic host work:

- outer AGS sandbox creation
- inner AGS sandbox creation
- Wisp package download or EROFS mount
- Wisp host preflight

The pool does not pre-create or pre-mount a user session Wisp runtime. Wisp
daemon bootstrap, Wisp create, and Wisp start still happen after the gateway has
the session run ownership and the session SMH space/token.

This keeps the single-writer contract intact: a pooled item has no user
workspace state and no live mount of a session disk.

Warm host prepare is intentionally two-stage. The host-only stage may install or
mount the Wisp package and run host preflight, but it must not write a
session-bound daemon config, SMH space ID, or SMH access token. Session config is
created only during the attach/start stage.

Current Wisp admin APIs still load session backend identity from config during
`create`/`start`. Removing session identity from daemon config entirely requires
a Wisp API change that accepts backend identity as explicit create/start input.

## Claim Path

1. Gateway computes a pool key from backend, templates, agent/workspace versions,
   sidecar artifact, and Wisp package/root settings.
2. Gateway attempts a store-backed CAS claim of one `ready` item.
3. Claim miss falls back to cold start.
4. Claim hit consumes the item for one session only.
5. If a claimed item fails during session attach, it is marked discarding and is
   never returned to ready.

## Temporal Role

Temporal runs the asynchronous reconciler:

- workflow: desired ready count loop, sleeps, ContinueAsNew
- activity: creates sandbox pairs and performs Wisp host-only prepare

Temporal is not in the user request hot path. Gateway request handling only uses
the local/shared runtime pool store.

Multiple Temporal workers may run against the same task queue. They must share
the same runtime pool store. Capacity is guarded by a store-level
`ReserveWarmRuntimeItem` operation, so two workers racing to fill the same
`pool_key` cannot both reserve beyond `desired_ready`.

## Configuration

- `GATEWAY_RUNTIME_WARM_POOL_ENABLED=true` enables gateway claim attempts when
  the configured workspace service also implements the runtime pool store.
- `GATEWAY_RUNTIME_WARM_POOL_SHARED_STORE_CONFIRMED=true` is required when the
  gateway claim path is enabled. It is an explicit deployment assertion that the
  gateway process and the Temporal runtime-pool worker use the same durable
  store. Without it, `/readyz` and `/v1/selfcheck` fail.
- `cmd/runtime-pool-worker` runs the Temporal worker.
- `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TLS`, and
  `TEMPORAL_AUTH_TOKEN` configure the Temporal client.
- `GATEWAY_RUNTIME_WARM_POOL_DESIRED_READY` controls target ready items.
- `GATEWAY_RUNTIME_WARM_POOL_RECHECK_SECONDS` controls reconciliation cadence.

`TEMPORAL_AUTH_TOKEN` must be provided by secret management and must not be
logged or committed.
