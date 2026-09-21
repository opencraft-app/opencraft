# Environment Directory

Stable renderer-free discovery boundary, owned by the Cordis
`environmentDirectory` service. No provider HTTP, machine allocation, transport
creation, route selection, or credential persistence belongs here.

- `contract.ts`: source, entry and refresh snapshots; scoped identity.
- `directory.ts`: configured local/manual profiles, source ownership, verified
  saved-profile aliases, deduplication and immutable observable snapshots.
- `profile-store.ts`: compatibility projection into the existing Host catalog;
  discovered recipes are ephemeral, configured profiles retain their storage.
- `runtime-bridge.ts`: lazy factory registration, never a connection or selection.
- `cordis.ts`: application service lifetime.

Source freshness, cloud lifecycle and runtime connection phase are distinct.
Each provider owns authority changes, pagination, errors and cancellation.
Sources claim provider IDs so stale saved profiles cannot resurrect after
sign-out/unload. Refresh failures may retain same-authority last-known entries;
authority changes must immediately clear them.

Explicit saved bindings may alias a discovered entry, preserving Host/session
IDs. Unbound legacy profiles are not silently redirected to arbitrary instances;
their stored data is not deleted. Provider-specific migration stays in the source.

Revocation removes selection eligibility and connection guards reject new use;
catalog refresh does not destroy conversation scopes. Provider transports own
account session invalidation. Add providers via the trusted `environmentSource`
channel, not provider-specific branches in directory or UI.
