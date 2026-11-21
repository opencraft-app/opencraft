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

## Limits

This is a lifecycle/storage primitive, not a complete enterprise connector manager.
The current Headless composition still takes one `channelSync` dependency; multiple
transports require explicit trusted composition. Communication and assistant-host
extensions remain single installation-selected extensions. This change does not
make arbitrary business extensions independently composable, add tenant isolation,
merge people by name/email, or introduce new provider credentials/selection UI.

## Verification

`tests/extensions/channel-connection-isolation.test.ts` covers two synthetic transports,
independent sends/intake, restart, close, dynamic sources, ownership collisions,
unknown outcomes, image attribution, legacy coexistence and capability rejection.
`tests/storage/channel-connection-upgrade.test.ts` seeds the frozen v19 schema and
checks exact preservation of its migration ledger/source epoch without creating Actors.
Existing native-channel and file-delivery tests retain their authorization checks.
