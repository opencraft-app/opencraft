# AppServer foundation

OpenCraft now has an executable AppServer boundary rather than a UI-owned mock. The
connection stack is renderer-neutral until the physical WebSocket adapter, so
Vite, Electron and Expo share protocol, request semantics, host identity,
recordings and Replica logic.

Target workbench composition:

```text
ApplicationSupervisor
          │
          ├── HostConnectionProfileStore (durable configuration)
          ├── HostConnectionProviderRegistry (Cordis contributions + leases)
          │         └── vela.websocket / future Electron or Expo providers
          │
          ▼
HostRuntimeRegistry
          │ one HostRuntime per hostId
          ├── HostRuntime(local) ── AppServerClient(local)
          ├── HostRuntime(remote-ssh:<host>) ── AppServerClient(remote)
          └── HostRuntime(durable) ── AppServerClient(durable)
                          │
                    DuplexTransport
                    ├── WebSocketTransport ── ws://host:9988/rpc
                    ├── MemoryTransport    ── deterministic in-process AppServer
                    └── ReplayTransport    ── deterministic recorded frames

Optional TransportBroker ── multiplexed IPC/WebSocket frames carrying hostId

Any transport ── RecordingTransport ── RecordedFrame[] ── ReplayTransport
```

The executable foundation currently still exposes
`AppServerClientRegistryService` for the Lab and compatibility callers. It is a
low-level construction/index utility, not the final workbench semantic owner.
The target workbench composition gives each `HostRuntime` direct ownership of
one logical client; an application-level `HostRuntimeRegistry` indexes complete
Host runtimes. This avoids nesting a one-entry client registry inside every
single-host workbench runtime.

Current executable compatibility path:

```text
createAppServerWorkbenchRuntime(hostId)
  └─ one-entry AppServerClientRegistryService
     └─ AppServerClient(hostId)
```

## Ownership rules

- `@opencraft/appserver-protocol` owns wire envelopes, method types, notifications,
  and the recovered tail-hydration extension. It imports no Cordis or renderer.
- `@opencraft/appserver-client` owns request IDs, pending promises, timeouts,
  cancellation, server-initiated requests, lifecycle events and a low-level
  registry utility. In the product workbench, the enclosing `HostRuntime` owns
  client disposal; Lab callers may continue to use the Cordis registry facade.
- A transport only opens, carries text frames, reports status, and closes. It
  does not know methods, threads, turns or Replica state.
- A connection provider validates one versioned JSON configuration and creates
  a transport. It does not own the returned transport. The Application holds a
  provider lease until the complete Host runtime is disposed.
- `HostConnectionProfileStore` owns configured Host identity on Web. Host
  profiles are persisted in IndexedDB; environment definitions seed an empty
  store once and never compete as a second runtime authority.
- `HostRuntimeRegistry` supports lazy dynamic registration and removal.
  Inspection through `peekRuntime()` cannot instantiate or connect a Host;
  removal fences in-flight connection completion before disposal.
- `@opencraft/appserver-session` owns complete Desktop-style Resume hydration through
  Cordis plugins. After reconnect, `connectionGeneration` changes, ownership is
  cleared, and every mounted View returns to `needs_resume`.
- `@opencraft/appserver-replica` owns the V4 epoch/sequence log, bounded replay,
  snapshot replacement, cached-paint distinction and Cordis registry.
- `@opencraft/appserver-replica-storage-node` persists Authority and Client state
  with atomic replace. Old cached state is never authoritative before sync.

This matches the recovered Desktop separation: Electron/host code owns the
physical link, while the renderer owns a `hostId`-scoped request client and
manager. OpenCraft permits direct WebSocket in browser/Expo as an additional
physical adapter; that does not change the semantic boundary.

## Recovered-source consultation ledger

The initial model was checked against r1116. The ownership review was rechecked
against the current fixed point at
`reference://codex/.runtime/source-tree-build-r2030-eager-immediate-compact`. The newer
source preserves the same ownership and adds a clearly recovered bounded
request recorder. Recovered code is a behavioral reference, not a runtime
dependency:

| Recovered evidence | OpenCraft decision |
| --- | --- |
| `service/app-server-request-client-module-03167.js` keeps pending requests and isolated lifecycle listeners | typed pending map, bounded load, lifecycle events, timeout/abort cleanup |
| same module queues by priority and abandons timed-out host work | priority is carried now; scheduling can be inserted without changing the public request contract |
| `shared/request-lifecycle-recorder-03188.js` retains 100 entries and params/result/error previews | Lab exposes a bounded request journal and never reads the client's private pending map |
| `conversations/interrupted-command-ids-subscription-selector-04990.js` creates one request client per `hostId` in application scope | each OpenCraft HostRuntime owns one logical client lane |
| `service/app-server-manager-registry-06127.js` registers complete managers by `hostId` | the application registry indexes HostRuntime/Manager objects, not a second copy of client ownership |
| `conversations/app-server-manager-class-04231.js` rejects manager/client host mismatch and invalidates threads after reconnect | host identity is fixed at creation; generation/status drives downstream Resume and compatibility read-model hydration |
| `service/app-server-request-client-module-03167.js` sends every request through the shared dispatcher with `hostId` | an optional TransportBroker may multiplex physical frames without merging logical clients |
| the manager handles server-initiated approval and input requests | method handlers return JSON-RPC success/error responses to AppServer |

Protocol truth is not inferred from r1116. The current HyperNode upstream
schema at `/data/hypernode/protocol/upstream/codex_app_server_protocol.schemas.json`
and the live server on port 9988 remain authoritative. The observed schema
projection hash is `ee3de81404505a36f900838926b1c72000345764dbe38ca3b070f2f4b72125a7`.
Desktop-only recovery fields (`excludeTurns`, `initialTurnsPage`,
`turnsBackwardsCursor`, `itemsBackwardsCursor`, `runtimeWorkspaceRoots`) are a
documented extension over that upstream schema.

## Current protocol surface

The executable protocol surface strongly types `initialize`, `thread/read`,
`thread/resume`, `thread/turns/list`, `thread/items/list`, and the complete
V4 `replica/sync` and `replica/mutate` envelopes. Other AppServer methods can already be called through
`requestRaw`; generating their declarations from the pinned schema does not
require a client, transport, or Resume rewrite.

`thread/resume` supports the recovered three-path history policy:

1. ordinary resume can include turns in the response;
2. tail hydration can request an `initialTurnsPage`;
3. paginated and Durable hosts can return cursor heads and load history through
   their dedicated orchestration.

## Minimal direct connection

```ts
import { createCordisAppServerRegistry } from "@opencraft/appserver-client";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";

const runtime = await createCordisAppServerRegistry();
const client = runtime.clients.create({
  hostId: "local",
  transport: new WebSocketTransport("ws://127.0.0.1:9988/rpc"),
});

await client.connect({
  clientInfo: { name: "opencraft", version: "0.1.0" },
  capabilities: { experimentalApi: true },
});
```

Electron-over-SSH supplies another `DuplexTransport` instance for a
`remote-ssh:<host>` entry; it does not fork the protocol client. Expo can use
its global WebSocket with the same WebSocket transport.

## Quality gates

- `npm run test:appserver` runs Memory, Cordis lifecycle, server request,
  timeout, queue bound, reconnect-generation and Recording→Replay tests.
- `npm run test:appserver:live` connects to `ws://127.0.0.1:9988/rpc` and checks
  a real `initialize` response.
- `npm run test:appserver:lab` deterministically proves visible content and an
  in-flight disconnect/reconnect using only public SDK APIs. Its Resume contract
  also proves same-ID repetition, same-ID reconnect and missing-ID rejection.
- The current HyperNode virtual WebSocket does not return a close frame to
  Node's built-in WebSocket. `WebSocketTransport.close()` is therefore bounded;
  the Node live gate injects `ws`, whose `terminate()` releases the socket after
  that bound. Browser and React Native callers keep the standard API.

## AppServer Lab

`apps/appserver-lab` is an executable SDK consumer, not a product terminal UI.
It emits NDJSON and meaningful exit codes. Its reconnect scenario delays a
server response, disconnects with one pending request, verifies typed rejection
and cleanup, reconnects, reinitializes under generation 2, and checks that the
visible Thread head is unchanged.

```bash
npm run lab -- scenario smoke
npm run lab -- scenario reconnect
npm run lab -- scenario resume --thread <id>
npm run lab -- scenario resume-contract --thread <id>
npm run lab -- scenario desktop-resume --thread <id>
npm run lab -- request thread/list '{"limit":2}'
```
