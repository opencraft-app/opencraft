# External identity and conversation provenance

OpenCraft accepts an authenticated person through a trusted server-side identity
provider. The provider verifies its own credentials and supplies a stable subject,
display handle and expiry to the core. The core owns Actor binding, installation
membership, resource authorization and Hub routing. Recognition alone grants no
access to conversations, Hosts or model credentials.

Product-specific gateway headers, verification algorithms, deployment flags,
employee directory, photos, account routes and UI belong to the downstream
provider. They are not built into the default server or public Workbench. A
product may contribute an account entrance, settings page, read receipts and
Thread metadata through the existing trusted composition ports. An absent
provider must not turn an expected authenticated deployment into anonymous
access. The generic admission probe is `GET /__opencraft_access/admission`;
older product-specific probes are compatibility inputs supplied by the trusted
product assembly.

## Submission identity

The gateway verifies identity before accepting an HTTP request or WebSocket
upgrade and binds its result to a server-owned connection context. Renderer IDs,
frame fields and client-supplied `sender` cannot establish that identity.
AppHost passes the context through its in-process submission port. The Codex,
SSH and DSH paths share `ThreadIdentity`: authenticated submissions for
`turn/start`, `turn/steer` and `thread/queue/add` persist immutable sender
provenance under the stable Host, Thread and client message ID. A missing client
message ID cannot be used to attribute a legacy submission. Expired context
cannot authorize a later submission, including one buffered while connecting.

Queue admission and provenance use the Host's transaction owner. Editing or
dispatching a queued message does not change its original sender. Native history
or a pending queue row is required before stored provenance is projected as a
message; storing a sender does not prove native delivery. History, live events
and forks preserve attribution separately from visible message text. Forked
messages retain their authors but are marked as inherited, so a product's
participant list can exclude them. Unknown older messages remain unknown.
Provenance is never forwarded to a native engine as model input.

The Headless DSH path uses the Hub-owned `AppServerIdentityOverlay` and its
managed `thread-identities/opencraft-server/thread-identity.sqlite`. The
overlay does not open the independent native Host database or mirror message
bodies. It uses a bounded read-only AppServer client for history reconciliation;
closing the Hub releases this reader and its SQLite owner without stopping the
independent Host. Other transports advertise identity metadata only when a
provider is actually wired.

## Published storage compatibility

The Host-state database (`opencraft-host-state.sqlite` for new stores, with
existing `codex-host-queue.sqlite` retained in place) and `thread-identity.sqlite` contain published
`ioa_*` tables and migration names from the original downstream integration.
Their SQL, version numbers and checksums remain part of the upgrade contract
even when the provider is absent. The core does not use those tables to verify
an employee or grant access. A downstream participant provider currently uses
them through the Host or Hub's existing SQLite transaction owner. Moving that
derived data to plugin-owned storage requires an additive, data-preserving
migration and coordinated product verification; renaming or deleting the old
migrations would reject deployed databases. See [SQLite lifecycle](sqlite-lifecycle.md).

Product-specific behavior and operational configuration are documented in the
downstream product workspace. Public extension ports and their stability are
described in [extension development](extension-development.md); trusted product
assembly is not an installable Extension ABI.
