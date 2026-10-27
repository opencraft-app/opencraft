# OpenCraft App Host and Daemon boundary

OpenCraft Desktop has three process domains. They are deliberately not collapsed:

```text
Renderer
  HostRuntimeRegistry
    HostRuntime(hostId)
      AppServerClient
        AppHostChannelTransport(leaseId)
                 │ transferred MessagePort
                 ▼
Electron Main
  trusted WebContents gate
  MessagePort ⇄ local-IPC byte relay
                 │ authenticated Unix socket / named pipe
                 ▼
OpenCraft Daemon
  AppHostServer (process singleton)
    Physical Host(hostId, generation, cross-window leases)
      local Agent AppServer
        DSH supervisor + filesystem/PTY/runtime services
```

The Renderer owns conversation meaning. Electron Main owns windows, tray and
presentation integration. OpenCraft Daemon owns desktop native Agent
processes and physical AppServer connections. Servers can explicitly delegate
Codex execution and account ownership to the independent [Codex core](../codex-core.md);
their daemon owns only its client connection. There is no direct
Renderer-to-Agent or Electron-Main-to-Agent compatibility path.

## Ownership invariants

1. AppServer JSON-RPC frames cross the process boundary unchanged. `hostId`,
   `leaseId` and `generation` exist only in the outer App Host envelope.
2. `HostRuntime` owns Thread, Resume, Replica, request and projection semantics.
   Neither Electron Main nor OpenCraft Daemon interprets those domains.
3. Electron Main is a transport broker only. It may authenticate a Renderer and
   relay bytes, but it may not create an Agent, WebSocket transport or physical
   Host.
4. OpenCraft Daemon owns every physical Host and native capability. Exactly one
   process-scoped `AppHostServer` serves all Renderer/window connections.
5. Every logical consumer has a unique Host lease. The physical Host closes
   only after the final lease across every connection has been released. In
   server Codex core mode this closes a client connection, not the execution owner.
6. Host generations are allocated by the daemon, not by a window. A stale
   generation and a lease belonging to another connection cannot send frames.
7. Closing a Renderer connection releases only its leases. Closing a window
   cannot destroy another window's Host. Explicit application Quit asks the
   daemon to shut down through its control channel.
8. The loopback HTTP server owns static Renderer assets only. It never exposes
   `/appserver`, proxies AppServer traffic or starts an Agent.
9. Preload exposes one narrow `connect-app-host` capability. It does not expose
   socket paths, authentication tokens, arbitrary IPC or AppServer URLs.
10. Each `hostId` has one daemon-owned lifecycle slot. A logical claim is
    registered before physical startup begins; startup, open, close and restart
    transitions for that Host never overlap.
11. Renderer cancellation releases its claim after the shared startup is
    acknowledged. It cannot cancel startup on behalf of another Renderer.
12. A fatal App Host channel is terminal. All pending requests fail, every
    channel transport observes failure, and the same client object is never
    revived.

## Renderer ⇄ App Host protocol

The trusted Renderer asks preload for a transferred port with
`opencraft:connect-app-host`, protocol version `2`. Messages on that port are:

- `hello` / `ready` / `fatal`
- `host/connect { requestId, hostId, leaseId }`
- `host/send { requestId, hostId, leaseId, generation, frame }`
- `host/disconnect { requestId, hostId, leaseId, generation }`
- `response`
- `host/status { hostId, generation, status }`
- `host/frame { hostId, generation, frame }`

Electron Main does not terminate this protocol. It relays each message to the
daemon's matching App Host connection.

## Electron Main ⇄ OpenCraft Daemon IPC

The local IPC transport uses newline-delimited JSON with a 64 MiB frame limit.
The first message must be:

```text
daemon/hello {
  protocolVersion,
  buildId,
  authToken,
  connectionId,
  role: "app-host" | "control"
}
```

The daemon answers `daemon/ready` before accepting payloads. App Host payloads
use `app-host/message`; explicit application shutdown uses `daemon/shutdown`.
Protocol/build mismatch and authentication failure are fatal rather than
falling back to a legacy route.

On Unix the endpoint is a mode-`0600` socket under Electron `userData`. Windows
uses a userData-derived named pipe. The 384-bit token is generated once in
`userData/opencraft-daemon.token`, stored with mode `0600`, and passed to a newly
spawned daemon through its environment rather than process arguments.

## Lifecycle

- First App Host connection probes the endpoint and starts OpenCraft Daemon if it is
  absent.
- Concurrent probes are coalesced by `OpenCraftDaemonClientManager`.
- Only `ENOENT`, `ECONNREFUSED` and `EPIPE` mean the daemon is absent. An
  authentication, protocol, build or handshake failure means another process
  owns the endpoint and fails closed; Electron never starts a competing daemon.
- A stale Unix socket is removed only after a real connection probe fails.
- Renderer startup reserves a claim before awaiting the physical Host. Closing
  one waiting window removes only that claim. Closing the final claim drains an
  in-flight startup or close operation before a new generation may open.
- The daemon is detached from the window process and can survive window
  destruction or an Electron Main crash. A later application launch reconnects
  using the persisted endpoint token.
- Explicit **Quit OpenCraft** closes Renderer bridges, sends `daemon/shutdown`, then
  exits Electron. Merely closing the last window leaves the tray and daemon
  alive.

This is the only desktop native execution path. Adding another engine means
adding a daemon-owned physical Host implementation, not a Renderer or Electron
Main shortcut.

`@opencraft/local-agent-host` is now a non-executable daemon implementation library.
Its former standalone CLI and generated executable were removed; it cannot be
used as a second product path around OpenCraft Daemon.
