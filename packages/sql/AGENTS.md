# SQL port owner

Read the [storage ports design](../../docs/architecture/platform/storage-ports.md) before changing this package or adding an adapter.

- Own the runtime-neutral relational contract only. Do not import `node:*`, `cloudflare:*`, vendor SDKs or file-system concepts. Connection opening, locks, backup, PRAGMA policy and close belong to the owner that opens the database.
- `./migrations` is the single implementation of the migration ledger rules (contiguous versions, checksums supplied by the owner's hash, refusal of mismatched or newer histories, one `transaction()` per migration). Owners call it; it never opens, locks, backs up or adopts a database, and it must not change published SQL, names or checksums.
- `transaction()` is the only transaction entry. Domain code never executes `BEGIN`, `COMMIT`, `ROLLBACK` or `SAVEPOINT` text. Nested calls are savepoints; callbacks are synchronous.
- `changes` is the direct row count of the statement and backs CAS decisions. An adapter that cannot provide it exactly must not claim support.
- One underlying connection maps to one `SqlDatabase` object; owners rely on that identity for change grouping and projections.
- Every adapter runs `runSqlConformance()` from `./conformance`. Do not add an adapter, or widen the contract, without extending and passing that suite.
