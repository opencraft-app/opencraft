# Runtime backends

Pegboard is the only placement and generation authority. Runtime hosts implement the same
generation-aware Envoy lifecycle while keeping runtime-specific isolation and capacity policy below
the host boundary.

- `workerd/host` supervises generation-bound workerd isolates. The independently versioned
  workerd-fdb fork is pinned by `workerd/workerd-fdb.lock`, offline-recoverable from the complete tracked bundle,
  and materialized at `third-party/workerd-fdb` by `workerd/setup-fork.sh`.
- `minisandbox/host` implements Rivet admission and lifecycle fencing for PVM sandboxes.
- `minisandbox/core` contains the independently buildable PVM, guest, broker, block, socket, and
  verification workspace imported with its complete Git history.
- `minisandbox/storage` is the independently buildable ActorVolume reference workspace: typed
  block transactions, SQLite/FDB adapters, Tencent COS emulator, lifecycle models, and the isolated
  NBD validation frontend.

Writable PVM volumes use the
[ActorVolume writer-fencing protocol](../docs-internal/engine/minisandbox-actor-volume-fencing.md).
Pegboard generation, ActorVolume writer epoch, and the local sbxlet capability are separate
authorities; the latter never substitutes for a transactional durable-writer fence.

The nested minisandbox workspace remains independently buildable during integration. Do not add
PVM, guest ABI, ring parser, or broker dependencies directly to Engine or Pegboard packages.

## Selecting an engine

Engine selection uses Rivet's existing runner pool boundary. The client-facing `poolName` becomes
`runner_name_selector` at the Actor create API, and Pegboard persists that pool on the Actor before
it selects an Envoy host. Runtime callbacks therefore never inspect Actor input to guess an engine.

For example, one namespace can register both pools at the same time:

| `runner_name_selector` | Envoy host | Execution engine |
| --- | --- | --- |
| `workerd` | `rivet-workerd-host` | workerd isolate |
| `minisandbox-hermes-v1` | `sbxlet` | PVM Linux clone from the trusted `hermes-v1` profile |

The selector is immutable for one Actor incarnation. Requests use the already-persisted placement;
they cannot switch an existing Actor between workerd and PVM. A new template or application
version should receive a new pool/profile name rather than changing the meaning of an existing
name.

This does not require a new `engine` field in an Envoy `ActorConfig` or a modification to any
published BARE schema. It also keeps kernel paths, EROFS paths, guest ports, and storage paths out
of user-controlled Actor configuration.
