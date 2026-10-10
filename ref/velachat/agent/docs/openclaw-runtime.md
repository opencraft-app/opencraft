# Managed OpenClaw Runtime

`openclaw` is a Computer-managed Runtime that supervises an installed
OpenClaw Gateway and drives it through the native Gateway WebSocket protocol.
It does not scrape a terminal and does not use `openclaw acp` as its primary
control path.

## Why Gateway, not ACP

OpenClaw documents the Gateway WebSocket as its embedding control plane.
`openclaw acp` is an IDE-facing bridge that translates ACP requests back into
Gateway `chat.send` and `chat.abort`. Vela Computer already owns process,
session, retry, and completion lifecycle, so adding the bridge would create a
second lifecycle authority without adding capability.

This follows the same rule as the managed Codex Runtime: supervise the native
programmatic server and normalize its events at the Runtime boundary.

References:

- <https://docs.openclaw.ai/gateway/embedding>
- <https://docs.openclaw.ai/gateway/protocol>
- <https://docs.openclaw.ai/gateway/clients>

## Launch ownership and isolation

Each Vela Agent receives a deterministic named OpenClaw Profile:

```text
vela-<first-32-hex-of-sha256-agent-id>
```

The Driver starts:

```text
openclaw --profile <managed-name> gateway --allow-unconfigured --port <loopback-port>
```

Computer owns the child PID, loopback port, launch-scoped Gateway token, and
shutdown. It disables Bonjour, OpenClaw self-respawn, login-shell snapshotting,
and OpenClaw channel startup. The Vela workspace and launch-scoped `vela`
capability environment are inherited by the Gateway process.

The token remains process-local and is never written to the Agent Profile,
prompt, diagnostics, or platform DTOs. The client connects as the trusted
loopback `gateway-client` backend with only `operator.read` and
`operator.write` scopes.

## Session semantics

The current adapter uses Gateway protocol v4 and the Profile-local
`agent:main:main` session. `chat.send` returning `status: started` is only an
acceptance acknowledgement. A matching `chat` event with `state: final` is the
authoritative completion boundary.

Assistant text is reconstructed from cumulative `message.content` snapshots;
`deltaText` remains a compatibility fallback. Exactly one normalized
assistant event and one turn-completion event are emitted per accepted run.

## Current delivery boundary

- The Runtime is a compile-time Computer builtin and requires a host-installed
  `openclaw` executable with the documented embedding flags.
- The Driver reports an isolated `openclaw_managed` Profile and
  `openclaw_gateway` source internally. Dynamic model and Skill discovery are
  deliberately reported as unsupported until the native catalog projection is
  implemented.
- Human management uses the additive Agent v2 surface with an extensible
  Runtime selector. Computer session negotiation selects assignment v3 before
  OpenClaw can be assigned; old assignment v1 and Human Agent v1 projections
  remain closed and never translate OpenClaw into another Runtime identity.
- Hermes ACP and Hermes Gateway use their canonical Runtime identities. The
  retired `opencode` and `pi` aliases are not reused by OpenClaw.
- Managed installation and upgrade are a separate Runtime-package concern;
  this Driver currently detects and supervises an existing installation.
