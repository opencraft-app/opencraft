# Runtime plugins, hot upgrade, and controlled self-evolution

## Two protocol planes

HyperNode deliberately separates two similarly named systems:

1. **Desktop Plugin Catalog** is the host-scoped Codex app-server surface
   (`plugin/list`, `plugin/read`, `plugin/install`, `marketplace/*`). Codex
   Desktop already owns this UI. On HyperNode these requests arrive through the
   SSH app-server channel and every returned path belongs to the remote host.
2. **Runtime Plugins** are trusted server-side Cordis extensions running inside
   HyperNode's QuickJS policy runtime. They extend the node and are promoted
   only through the operator release gate.

No Renderer modification is required or allowed. Runtime Plugin endpoints are a
node control plane; the unmodified Renderer only consumes official app-server
methods it already understands.

## Stable kernel and reloadable Fibers

HyperNode keeps one stable QuickJS runtime and root Cordis `Context`. SSH
transport, app-server connections, workspace/process ownership, durable
storage, account pools and the Runtime Plugin registry are kernel services.
They are not replaced by a plugin transition.

Every Runtime Plugin has its own Cordis Fiber and independent state machine:

```text
staged -> activating -> active -> superseded
                    \-> failed -> previous Fiber restored
```

Activation disposes only the target plugin's previous Fiber. Other plugins and
all active SSH/app-server connections remain attached. The legacy `evolution`
slot is represented as a normal plugin ID and retains compatibility with
`globalThis.hypernodeHotCandidate`, `$evolution`, and
`hypernode/policy/status`.

## Source contract

Runtime Plugin source lives under `policy/plugins/<id>/` and consists of a
`plugin.json` plus its JavaScript entry. The manifest uses
`hypernode.runtime-plugin/v1` and declares a stable ID, metadata, semantic
version, entry and capabilities. The entry exports a default Cordis plugin
function or named `apply` function. Every listener, handler and resource must
be registered through `ctx.effect()` so Cordis can unwind it deterministically.

Supported v1 capability declarations are `app-server`, `dashboard`, `events`,
`storage`, `thread-projection`, and `workspace-projection`. These declarations
are admission and audit metadata, not a security sandbox.

## Promotion and boot reconciliation

Promote an independently versioned plugin with:

```sh
npm run promote:plugin -- policy/plugins/example r1
```

The promotion tool validates and bundles the plugin, runs policy/schema tests
and all Go tests, writes a content-addressed immutable bundle, then atomically
upserts `policy/releases/catalog.json`. The watcher validates catalog version,
IDs, paths, regular-file status, size and SHA-256 before evaluating the bundle.
Activation is failure-atomic per plugin: a candidate that throws is unwound and
that plugin's previous Fiber is recreated.

The same catalog is reconciled at process boot, so a host restart does not
forget selected revisions. `active.json` remains a backward-compatible input
for the old single `evolution` bundle until a v1 catalog is promoted.

## Control and self-evolution

The stable registry exposes `hypernode/runtimePlugins/list`,
`hypernode/runtimePlugins/read`, and compatibility endpoint
`hypernode/policy/status`. These are not new Renderer UI contracts.

A management Thread may author source, tests and a candidate revision. It is a
proposer, not the deployment authority: chat text is never evaluated and no
ordinary app-server request promotes server code. Deterministic gates and the
immutable release catalog remain authoritative. Kernel changes still require a
process release.
