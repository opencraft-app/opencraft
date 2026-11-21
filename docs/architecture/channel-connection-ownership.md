# Channel connection ownership

## Scope

A trusted installation can run independent `ChannelSync` transports over the same
native channel owner. A stable `transport.connectionId` selects an installation
connection; a random `incarnation` fences each running instance of that connection.
Neither is an Actor, tenant ID, authentication credential or client-selected RPC field.
Existing Actor, membership, source epoch and delivery-attempt checks remain authoritative.

The native timeline remains the only message writer. Connection ownership and recovery
run transactionally in the existing communication storage Worker, not the network loop.

## Durable ownership and lifecycle

- `actor_channel_connections` persists the current incarnation/active state per connection.
- `actor_channel_source_owners` associates existing source rows with connections. Existing
  source/epoch/message rows are not renamed or rewritten by the migration.
- Omitted connection IDs retain the `legacy` singleton scope. Source rows written by an
  older trusted adapter, without an ownership row, also belong to `legacy`.
  An old trusted `addSource` caller may bootstrap an absent legacy connection;
  it cannot replace any registered incarnation, revive a stopped connection or
  implicitly register an explicit connection.
- Configure reconciles only its owned sources: its in-flight effects become unknown,
  its removed queued deliveries are rejected, and other connections remain untouched.
- Source/channel binding remains one-to-one. There is no implicit transfer of a source
  to another connection, even if the old connection is stopped. Transfer requires an
  explicit trusted retirement/reconfiguration, not a callback or reconnect.
- Claims, image work and settlement require the current incarnation and connection.
  A stale instance cannot add a source or deactivate its replacement. A reconnect
  never replays an unknown external effect. Outbound image attribution is scoped by
  its durable outbox source even when the image row has no inbound source field.
- Explicit IDs require `connectionCapabilities` version 1 before configuration. An old
  owner that does not acknowledge this capability must fail, not silently fall back
  to deployment-wide configuration.

Use stable configuration IDs, not a new random ID at every boot. Renaming an ID is an
explicit ownership migration; it does not automatically adopt the old connection.

```ts
const transport = {
  connectionId: 'installation.channel-a',
  bindings: approvedBindings,
  subscribe: receiveFromProvider,
  send: sendThroughProvider,
};
const sync = await ChannelSync.open(transport, existingCollaboration);
// During shutdown: await sync.close();
```

## Headless installation composition

Headless accepts one of `channelSync`, `createChannelSync(context)`,
`channelSyncs`, or `createChannelSyncs(context)`. Existing single-transport
composition remains supported; plural factories return an array (including an
explicit empty array). Factories receive the existing `collaboration` owner.
Never install competing factories/values; they are rejected before invoking a factory.

```ts
const composition = {
  async createChannelSyncs({ collaboration }) {
    return [firstApprovedTransport, secondApprovedTransport];
  },
};
```

Each connection needs a distinct stable ID, exact callback path, source and native
channel binding. Preflight rejects collisions before constructing the IM service
or configuring durable work. Invalid installation configuration remains the
caller's resource responsibility; after preflight succeeds, the service owns all
supplied transports. A later startup failure releases started, failed and
unstarted transports, preserving the original startup error. This is not an
atomic transaction across all connections or providers: already attempted
external effects are not rolled back or replayed.

Callback paths are captured at registration and dispatched exactly, for POST only.
Callbacks never choose a connection from untrusted payload fields. Shutdown retires
all callbacks, closes every transport even if another close fails, and fences its
native incarnation. Concurrent close calls await the same cleanup. An unsupported
native owner receives only capability negotiation, not configure/deactivate.

Personal notifications collect verified targets from all connections. The existing
notification contract addresses `(channelId, senderId)`; duplicate claims (including
ordinary adapters) are omitted and refused, rather than routed to the first
provider. Operators should use distinct channel namespaces. A prepared send pins
the exact connection and notification port and rechecks Actor admission, target
binding and ambiguity at delivery. Adapters must call the supplied `assertCurrent`
after asynchronous preparation and immediately before external handoff. There is
no broadcast fallback, cross-provider identity inference or new notification store.

## Limits

This is trusted installation composition, not a user-selectable enterprise
connector manager or a hot-reload API. Communication and assistant-host extensions
remain single installation-selected extensions. It does not make arbitrary business
extensions independently composable, add tenant isolation, merge people by
name/email, or introduce provider credentials/selection UI. Connection-scoped
account-link selection is not provided: legacy singleton actions must not choose
an arbitrary connection from a plural installation.

## Verification

`tests/extensions/channel-connection-isolation.test.ts` covers two synthetic transports,
independent sends/intake, restart, close, dynamic sources, ownership collisions,
unknown outcomes, image attribution, legacy coexistence and capability rejection.
`tests/storage/channel-connection-upgrade.test.ts` seeds the frozen v19 schema and
checks exact preservation of its migration ledger/source epoch without creating Actors.
Existing native-channel and file-delivery tests retain their authorization checks.

`tests/extensions/headless-channel-connections.test.ts` covers real IM service/native
storage composition, two-way messages, exact callback routing, notification
collisions/revocation, startup failure, failed shutdown and the actual Headless HTTP
application with a two-transport factory. It uses synthetic providers, not live
enterprise credentials or external provider service acceptance.
