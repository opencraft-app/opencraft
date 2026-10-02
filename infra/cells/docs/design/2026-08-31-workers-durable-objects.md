# Workers and Durable Objects execution model

Status: accepted and implemented for deployment-bound Durable Object code
selection. The target stateless Worker ingress and Worker-to-Object routing
path are specified in `2026-09-22-stateless-workers-durable-object-routing.md`.

## Public resources

- A `Worker Version` is an immutable code, binding, compatibility-date, and
  resource-limit bundle stored by content hash.
- A `Deployment` selects the Version or rollout pair currently serving a
  Worker service.
- A stateless `Worker` executes requests from the current Deployment on a
  shared workerd pool. Isolate reuse is not part of its public identity.
- A `Durable Object` has stable `(namespace, class, object_id)` storage and one
  active execution owner. Pegboard Actor IDs and generations are internal
  placement and fencing mechanisms.

## Version selection

The default actor API reference is deployment-bound:

```json
{ "worker": { "worker": "counter" } }
```

Each activation resolves the active Deployment to one exact immutable Version.
The Host periodically rechecks the Deployment while serving requests. A changed
Version evicts and reloads the isolate without changing the Actor's Depot
database. A sleeping Object therefore wakes on the latest Deployment.

Code upload and traffic publication are separate operations. `POST .../versions`
stores immutable code without changing traffic. `POST .../deployments` publishes
one or two previously uploaded Versions using percentage weights with 0.01%
precision. The legacy Worker `PUT` remains the upload-and-100%-deploy convenience
operation.

For a gradual Deployment, the Host selects exactly one Version from
`hash(namespace, worker, actor_id)` and the Deployment's ordered cumulative
version ranges. Every request and wake for that Object keeps the same
assignment while its bucket remains in the same range. Deployment identity is
deliberately excluded: creating a semantically equivalent Deployment does not
randomly remap all Objects. Changing versions, ordering, or range boundaries
may move the Objects whose bucket changes ownership; request-level random
selection is forbidden.

An explicit pin is opt-in:

```json
{
  "worker": {
    "worker": "counter",
    "version_id": "v_<sha256>"
  }
}
```

Pins are intended for previews, debugging, and reproducible jobs. They never
follow Deployment changes.

The published Envoy v7 wire schema is not changed: an empty wire `version_id`
encodes an omitted public field. Hosts must resolve it before preparing code.
The pre-launch Registry format is `rivet-worker-registry/v5`. Its immutable
Version content and hash include modules, compatibility settings, bindings, and
exports; Deployment contains only Version selection. It also keeps immutable
Deployment history, ordered Version indexes, and an append-only Durable Object
namespace inventory in isolated FDB/COS/filesystem prefixes. There is deliberately
no v1/v2/v3 data migration. Registry and supporting
Hosts must both be released before opening Actor admission.

## Cell placement accounting

The Registry owns the authoritative number of persistent Objects assigned to
each exact `(Cell name, Cell UID)`. A first successful Object claim increments
one of 64 deterministic FDB counter shards in the same transaction that creates
the Object record. The first `active -> deleted` transition decrements that same
shard in the tombstone transaction. Idempotent claims, repeated deletes, and a
delete-before-create tombstone never change the count. A missing, malformed,
negative, overflowing, or underflowing counter fails closed.

Cell Reporter reads this count from the private Registry and publishes it as
`RivetCellReport.spec.capacity.placementCount`. Registry errors stop report
refresh rather than publishing zero; the report therefore becomes stale and
placement admission closes. This count is safe for future retirement gates,
while workerd process caches and running Pod counts are explicitly not placement
truth.

## Storage identity

Code versions, deployments, Host Pods, and fencing generations are not storage
identity. Depot remains keyed by stable Actor/Object identity. Generation is
validated on every storage operation only to reject writes from a stale owner.
There are no shutdown hooks; code must persist progress incrementally.

## Deployment availability

The first resolution on a Host fails closed when Registry is unavailable.
After a Deployment has been verified, the Host refreshes it through a bounded,
single-flight cache and continues serving the last verified Version during a
temporary Hub outage. Immutable code remains protected by its SHA-256 identity.

## GC roots

The initial rollback/deployment window contains the five newest uploaded Versions
(`--version-retention=5`). Older Versions remain addressable by immutable ID but
cannot be placed in a new Deployment. Deployment history remains visible and marks
each record with `rollback_available`; history metadata outside the window is not
itself a permanent code-object root.

Normal Durable Objects do not lifetime-pin code, while an explicit `version_id`
does. Version list responses expose `deployable`, `active`, `retention_reasons`,
and `gc_status`. Physical COS deletion is deliberately `report_only` until Engine
maintains a complete durable reverse-reference index for explicit Actor pins. An
inactive Version outside the five-Version window is therefore only a
`candidate_report_only`, never immediately deleted. A code update may require
application-level forward/backward-compatible SQLite schema handling because
storage state is not versioned with code.

Worker deletion fails with `409 worker_has_durable_objects` whenever the durable
namespace inventory is non-empty, including when only a historical Version
exported the class. The initial API has no `force` deletion. Adding it requires a
complete Worker/class-to-Actor reverse index, fenced Actor shutdown, confirmed
Depot deletion, and a recoverable tombstone state machine; clearing only the
active Deployment pointer is forbidden.

Rollback is not a distinct storage mutation. The UI or CLI creates a new 100%
Deployment that references an older still-deployable Version. The new Deployment
ID preserves history but does not itself enter the Object assignment hash; the
new version range determines which Objects reload. Deployment history records
`source`, `workers/triggered_by`, and an optional human message so this
client-side convenience remains auditable.

## Follow-up surface

The CF-compatible public surface should expose stateless Worker `fetch` and
Durable Object class bindings separately. The current `env.RIVET_STORAGE` API is
a bounded first-stage Durable Object capability, not the final stateless Worker
storage API. The accepted execution, routing, network, and rollout plan is
`2026-09-22-stateless-workers-durable-object-routing.md`.

## Miniflare v3-shaped client subset

`runtimes/workerd/miniflare` provides the first user-facing compatibility layer.
It intentionally follows the Miniflare v3 object model instead of exposing the
internal Actor CRUD API:

- construction uploads one immutable Version and publishes a 100% Deployment;
- `dispatchFetch()` addresses a stable default Actor for the Worker;
- `getDurableObjectNamespace(binding)` returns a namespace with `idFromName()`,
  `idFromString()`, `newUniqueId()`, `get()`, and `getByName()`;
- the first `stub.fetch()` performs an idempotent Actor get-or-create and all
  subsequent requests use the Actor gateway;
- `setOptions()` is serialized in call order and poisons existing stubs, matching
  Miniflare's proxy-lifetime rule;
- `dispose()` releases the client only. It does not delete durable remote state.

The configured class is not wrapped in a JavaScript storage shim. The trusted Host
loads the named Worker export with `WorkerLoader.getDurableObjectClass()` and passes
that class through a Rivet-internal `DurableObjectNamespace.get()` option. The
configured root namespace therefore constructs the user's class directly with the
native `DurableObjectState`; Depot remains the storage implementation. The class
selector is derived from the authenticated Actor configuration, validated as a
bounded JavaScript identifier, and overwrites any request-supplied internal header.

This is a deliberately small hosted-runtime client, not a local workerd emulator.
The first subset does not yet inject Durable Object namespace bindings into a
user's default Worker environment, and it excludes alarms, WebSockets, queues, and
scheduled events. `dispatchFetch()` is persistent Actor fetch rather than the final
stateless Worker ingress. These omissions must stay explicit until the routing
capability can be added without exposing the internal root namespace or bypassing
Actor admission and placement.
