# `@opencraft/appserver-replica`

Renderer-neutral V4 Replica authority and client. The authority persists its
`epoch`, `nextSeq`, materialized entities, retained journal boundary, journal
entries and idempotency receipts as one commit. The client may paint a stored
snapshot immediately, but it becomes authoritative only after `replica/sync`.
Receipts survive Journal compaction, so an old `commandId` cannot execute twice.

The package has no React, Vite, Expo or Electron dependency. Cordis owns
host-scoped client instances. Codex Desktop's existing Resume protocol enters
through the separate V3 adapter in `@opencraft/appserver-session`; it is never
misreported as a server-sequenced V4 stream.
