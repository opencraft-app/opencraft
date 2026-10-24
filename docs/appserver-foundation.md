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
          │         └── opencraft.websocket / future Electron or Expo providers
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
  and the tail-hydration extension. It imports no Cordis or renderer.
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

This retains the Host/client separation: Electron/host code owns the
physical link, while the renderer owns a `hostId`-scoped request client and
manager. OpenCraft permits direct WebSocket in browser/Expo as an additional
physical adapter; that does not change the semantic boundary.

## Hook execution notification projection

The session notification projector owns explicit/latest Turn selection and run
validation. Its pure execution-list upsert prioritizes the latest active run of
the same protocol ID, then a matching non-null completion timestamp, otherwise
appending a count-suffixed presentation ID. It replaces the matched wrapper with
the complete incoming run while retaining unrelated entry identities. This does
not own hook execution, retry, notification order or transport authority.

## Client ownership and protocol boundaries

- Typed pending map, bounded load, lifecycle events, timeout/abort cleanup
- Priority is carried now; scheduling can be inserted without changing the public request contract
- Lab exposes a bounded request journal and never reads the client's private pending map
- Each OpenCraft HostRuntime owns one logical client lane
- The application registry indexes HostRuntime/Manager objects, not a second copy of client ownership
- Host identity is fixed at creation; generation/status drives downstream Resume and compatibility read-model hydration
- An optional TransportBroker may multiplex physical frames without merging logical clients
- Method handlers return JSON-RPC success/error responses to AppServer

Desktop-only fields (`excludeTurns`, `initialTurnsPage`, `turnsBackwardsCursor`,
`itemsBackwardsCursor`, `runtimeWorkspaceRoots`) are documented protocol
extensions. The generated protocol and the connected server remain authoritative.

## Current protocol surface

The executable protocol surface strongly types `initialize`, `thread/read`,
`thread/resume`, `thread/turns/list`, `thread/items/list`, and the complete
V4 `replica/sync` and `replica/mutate` envelopes. Other AppServer methods can already be called through
`requestRaw`; generating their declarations from the pinned schema does not
require a client, transport, or Resume rewrite.

`thread/resume` supports the three-path history policy:

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
