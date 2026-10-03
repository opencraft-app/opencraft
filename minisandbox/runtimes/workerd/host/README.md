# Rivet workerd Envoy host

This host terminates Rivet's Envoy protocol and forwards Actor requests to one shared workerd
process. The generation carried by the exact Actor task is used at both boundaries:

```text
Rivet (actor_id, generation)
  -> workerd Durable Object isolate
  -> SQLite external VFS capability
  -> loopback workerd-host bridge
  -> Depot transaction
  -> UniversalDB / FoundationDB commit ACK
```

Each `(actor_id, generation)` maps to a distinct workerd Durable Object isolate. Each Actor ID maps
to its own Depot database; replacing an Actor generation fences and evicts the old isolate. The
workerd configuration uses in-memory Durable Object bookkeeping, so stopping workerd removes all
local runtime state. SQLite pages survive because the external VFS restores them from Depot.

## Build workerd with the Depot VFS

Materialize the independently versioned checkout from the complete bundle tracked by the main repository;
this step does not clone or fetch from GitHub. Then build from its canonical in-tree location. The setup command also creates the disposable
`third-party/rivet-history` compatibility link required by the fork's Cargo path dependencies:

```sh
./runtimes/workerd/verify-source-bundle.sh
./runtimes/workerd/setup-fork.sh
cd third-party/workerd-fdb
ulimit -n 65536
WORKERD_ZIG=/absolute/path/to/zig \
WORKERD_BAZEL=/absolute/path/to/bazel \
  ./tools/build-rivet-workerd-musl.sh --jobs=10
```

Use the release builder's verified Zig 0.14.1 binary and the Bazel version from the fork's
`.bazelversion`. The production script
builds the Depot Rust archive and a fully static musl workerd, then rejects an artifact containing
an ELF interpreter, GLIBC version dependency, or shared-library dependency. The Depot feature is
opt-in; a normal workerd build retains the upstream local SQLite path. Do not enable Depot on a
normal dynamic build: both workerd and the Rust static archive carry the Rust standard library,
and only the production script applies the fork's deliberately narrow duplicate-symbol handling.
Size `--jobs` to builder memory; each concurrent V8 C++ compilation can consume roughly 1 GiB.

## Run

Start the host first so the loopback SQLite bridge is listening, then start workerd:

```sh
RIVET_WORKERD_ENDPOINT=http://127.0.0.1:18080 \
RIVET_WORKERD_MAX_IN_FLIGHT=16 \
RIVET_WORKERD_MAX_ACTIVE_ACTORS=32 \
RIVET_WORKERD_IDLE_SLEEP_MS=30000 \
RIVET_WORKERD_SQLITE_BIND=127.0.0.1:18081 \
RIVET_WORKERD_TOKEN=dev-only-change-me \
RIVET_ENDPOINT=http://127.0.0.1:6420 \
RIVET_POOL_NAME=workerd \
cargo run -p rivet-workerd-host

RIVET_DEPOT_BRIDGE_ADDRESS=127.0.0.1:18081 \
RIVET_WORKERD_TOKEN=dev-only-change-me \
RIVET_DEPOT_MAX_BINDINGS=4096 \
RIVET_DEPOT_MAX_VFS_CACHE_BYTES=4294967296 \
RIVET_WORKERD_SQLITE_MAX_MEMORY_BYTES=16777216 \
workerd serve workerd/config-depot.capnp --experimental \
  --socket-addr http=127.0.0.1:18080
```

The workerd endpoint and SQLite bridge must be numeric loopback addresses. Use a per-cell secret
for `RIVET_WORKERD_TOKEN`; the example value is development-only.

The loopback bridge exposes authenticated aggregate runtime counts at `GET /v1/sqlite/stats`.
Send `x-rivet-workerd-token` with the same secret. The response contains only
`host_active_actors`, `bridge_active_actors`, and `quiescent`; it never lists Actor IDs. Scale
qualification uses this endpoint to prove that a sleep or delete wave returns both registries to
their pre-run baseline without waking Actors by polling their routes.

When `RIVET_WORKERD_MANAGEMENT_BIND` is configured on a Pod address, a second narrow router exposes
only health, aggregate stats, and authenticated `POST /v1/sqlite/drain`. The drain body is exactly
`{"draining":true|false}` and is limited to 1 KiB. SQLite page and commit routes remain on the
loopback-only bridge. Entering drain closes local Actor admission first, then advertises zero
placement capacity; Pegboard reuses its generation-safe `GoingAway` path to settle Actors. Leaving
drain advertises the original capacity before reopening local admission.

## Density limits

- `RIVET_WORKERD_MAX_IN_FLIGHT` bounds host-to-workerd HTTP requests. Excess work waits in the
  host instead of overflowing workerd's loopback listener during activation or eviction waves.
- `RIVET_WORKERD_MAX_ACTIVE_ACTORS` is the hard host admission ceiling. When configured, the
  Envoy publishes it to Pegboard, whose hash allocator uses best-fit bin packing and refuses full
  hosts. Size this from a measured high-percentile Actor working set plus process headroom; leaving
  it unset preserves legacy spread placement.
- `RIVET_DEPOT_MAX_BINDINGS` caps concurrently bound Actor databases in the process.
- `RIVET_DEPOT_MAX_VFS_CACHE_BYTES` is the process-wide hard reservation cap for VFS page caches.
- `RIVET_DEPOT_CACHE_CAPACITY_PAGES` caps cached pages per database.
- `RIVET_WORKERD_SQLITE_MAX_MEMORY_BYTES` is the SQLite heap hard limit per Actor database.
- Dynamically loaded Workers receive a 30 second CPU budget per invocation, matching the current
  paid Workers and Durable Objects default, and a 128 MiB V8 heap limit. The CPU watchdog samples
  the executing thread's CPU clock, so time spent awaiting I/O does not consume the budget, while
  synchronous JavaScript, SQLite, hashing, and VFS processing on that thread does. The Pod cgroup
  remains the final process-wide RSS fence for native and external allocations outside V8's heap.
- HTTP responses are buffered with Rivet's 20 MiB response limit because the current
  `pegboard-gateway2` implementation consumes response bodies from the response-start frame.

## Dynamic Worker lifecycle

### 无状态 Worker 的命名缓存

`workerd/stateless-worker.js` 的原生 WorkerLoader 命名表按 Worker/Version 做有界
TTL/LRU。默认最多 16 个命名引用，空闲 TTL 为 60 秒；只在有效请求或 prepare 时懒清理。
`RIVET_STATELESS_ISOLATE_CACHE_CAPACITY`（1..256）和
`RIVET_STATELESS_ISOLATE_CACHE_IDLE_MS`（1..3,600,000）是受信 root binding，生产由
`stateless-executor.yaml` 的 initContainer 校验并渲染。用户 headers/env 不能修改它们。

淘汰必须调用原生 `WorkerLoader.unload(name)`，不能只删 JS bookkeeping。JS 不缓存
跨请求 WorkerStub/IoOwn，也不包装响应流；原生请求 channel 自行保留在途引用。被淘汰的
stateless 全局变量可重置，同名旧在途实例和新实例可暂时并存，不能用这套策略管理 DO。
命名引用上限不等于 live isolate 数或 RSS 上限；在途/后台工作仍占内存，最终受 Pod cgroup
约束。没有新请求时 TTL 不主动清空，但总表始终有界。

从 minisandbox 项目根运行回归，无须重编译 workerd：

```sh
node --test runtimes/workerd/host/workerd/stateless-isolate-cache.test.mjs
workerd test --experimental runtimes/workerd/host/workerd/stateless-isolate-cache-native.wd-test cache-test
workerd test --experimental --gc-stress runtimes/workerd/host/workerd/stateless-isolate-cache-native.wd-test cache-test
TMPDIR=/data/tmp python3 -m unittest discover -s infra/cells/deploy/tencent/fleet/runtime -p test_stateless_executor_contract.py
```

native gate 加载实际 production root JS，验证热复用、LRU/TTL 重载、原始 URL/POST body、
淘汰与同名重载后旧 1 MiB 响应流仍完整，以及旧流取消不破坏新缓存。Node gate 覆盖
10,000 个历史名字、时钟回退、卸载异常与无效输入。它们是本地开发证据，不代替镜像发布、
云上容量或生命周期指标门禁。

### 持久 Actor 的动态加载

Actor startup downloads and verifies the immutable Worker version, installs actor metadata and
input under `env.RIVET_ACTOR`, then waits for workerd to compile and link the default entrypoint.
Pegboard does not observe the Actor as running until that handshake succeeds. A compile failure
rolls back host admission. Stop and generation replacement unload the named WorkerLoader isolate,
so source, globals, and V8 heap are released instead of accumulating for the process lifetime.

The host caches verified registry responses in a 64 MiB memory cache and a disposable disk cache
with 384 MiB/320 MiB high/low watermarks. Registry fetches are single-flight per version and capped
at eight concurrent downloads. A missing, full, or read-only disk cache never blocks an otherwise
valid Worker; cold recovery falls back to the registry.

Actor Worker references are deployment-bound by default. `{ "worker": "api" }` resolves the
Registry's active Deployment on activation and is rechecked on requests with a short bounded cache.
When the Deployment changes, the Host verifies the new immutable version, evicts the old isolate,
and reloads the same actor identity without changing its Depot database. Supplying
`{ "worker": "api", "version_id": "v_<sha256>" }` is an explicit pin intended for previews and
reproducible jobs; it never follows Deployment changes.

### Ownership and automatic sleep invariants

Pegboard is the only owner of an Actor placement lease. Its authoritative identity is
`(actor_id, generation, envoy_key)`. The Host registry, WorkerLoader isolate, Durable Object and
SQLite bridge are subordinate capabilities for that exact generation; none may release a slot or
create the next owner independently.

`RIVET_WORKERD_IDLE_SLEEP_MS` arms one cancellable timer per admitted Actor after a request
completes (30 seconds by default; `0` disables automatic sleep). The timer carries both the
Pegboard generation and a host-local activity epoch. A new request invalidates the old epoch. On
expiry the Host only sends a generation-scoped sleep intent through the existing Envoy protocol.
It does not unload workerd or alter placement locally.

Pegboard accepting that intent and atomically removing `ConnectableKey` is the sleep linearization
point. It then commands the owning Envoy generation to stop. A request arriving during this window
sets `rewake_after_stop`; the old generation finishes teardown before Pegboard allocates the next
generation. Host fetches take the read side of the per-Actor lock, while stop, replacement and
eviction take the write side, so acknowledged in-flight requests finish before isolate eviction.
The SQLite bridge remains registered during that drain and is removed only after eviction. If
eviction fails, both Host admission and the bridge fail closed before Pegboard can advance.

Depot commits serializably compare their expected writer generation with Pegboard's
`GenerationKey`. The key remains on the draining generation until Stop completes, then advances in
the same allocation transaction that creates the next owner. Therefore a stale isolate cannot
commit after takeover. A lost or duplicate idle intent can at worst keep an Actor resident longer;
it cannot create two writers or release somebody else's slot.

A Deployment may contain one or two Versions with percentage weights. Selection hashes
`(namespace, worker, actor_id)` into 10,000 basis-point buckets and applies the Deployment's ordered
cumulative ranges. Consequently one Durable Object runs exactly one Version while its bucket stays
in the same range, including after Host replacement. Deployment identity alone cannot remap it;
changing versions, ordering, or range boundaries may move the affected buckets. The request path
never performs random percentage selection.

Facets, WebSockets/hibernation, and durable alarm-index recovery are not enabled by the bundled
configuration yet.

## Actor-scoped persistent storage

Every dynamically loaded Worker receives an `env.RIVET_STORAGE` RPC capability bound to the exact
`(actor_id, generation)` admitted by the Host. It is not a Durable Object namespace: user code
cannot choose another Actor ID or mint another stub. The loader also withholds the workerd token and
the internal `ACTOR` namespace.

```js
export default {
  async fetch(request, env) {
    await env.RIVET_STORAGE.sql.exec(
      "CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)",
    );
    const result = await env.RIVET_STORAGE.sql.exec(
      "INSERT INTO counters (name, value) VALUES (?, 1) " +
        "ON CONFLICT (name) DO UPDATE SET value = value + 1 RETURNING value",
      ["main"],
    );
    return Response.json({ count: result.rows[0].value });
  },
};
```

`sql.exec(query, bindings)` resolves only after the Durable Object SQLite output gate and Depot
commit ACK. It returns `{ rows, columnNames, rowsRead, rowsWritten }`. Bindings may contain only
`null`, finite numbers, strings, `ArrayBuffer`, and typed-array bytes. The capability rejects more
than 256 bindings, 1 MiB of binding data, a 64 KiB query, or a result above 1,000 rows / 1 MiB.
`sql.databaseSize()` reports the current logical SQLite size in bytes. Each RPC call is one Durable
Object event; callers must not assume a transaction spans multiple `exec()` calls.

The capability survives WorkerLoader unload, Durable Object eviction, Host replacement, and
generation-safe recovery because its database pages remain in Depot. A new generation receives a
new stub, while Depot generation fencing prevents the previous owner from committing.
