# Durable SQLite storage ABI

Hypernode exposes its durable SQLite connection to the trusted QuickJS policy using a deliberately
small API modeled after SQLite-backed Cloudflare Durable Objects.

The native global is `durableStorage`. Cordis policy code should normally depend on
`DurableStorageService` and use `ctx.storage` instead:

```js
ctx.storage.sql.exec(`
  CREATE TABLE IF NOT EXISTS do_threads (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  )
`);

ctx.storage.sql.exec(
  "INSERT INTO do_threads(id, payload) VALUES (?, ?)",
  thread.id,
  JSON.stringify(thread),
);

const thread = ctx.storage.sql
  .exec("SELECT payload FROM do_threads WHERE id = ?", threadId)
  .one();
```

## SQL cursor

`sql.exec(query, ...bindings)` completes synchronously and returns a cursor with:

- `next()` and `[Symbol.iterator]()` for object rows;
- `toArray()` for all unconsumed object rows;
- `one()` which requires exactly one unconsumed row;
- `raw()` for a shared iterator of array rows;
- `columnNames`, `rowsRead`, and `rowsWritten` metadata.

Hypernode eagerly materializes query rows at the Go/QuickJS boundary. This is intentionally stricter
than retaining a live SQLite cursor: a JS cursor cannot hold a database connection or snapshot
across a later policy event.

Bindings support `null`, strings, booleans, finite JS numbers, and byte arrays. A query is limited
to 1 MiB and 256 bindings. Policy authors should always bind remote input rather than interpolate
it into SQL.

## Transactions

Use `ctx.storage.transactionSync(callback)` for an atomic group of synchronous statements:

```js
ctx.storage.transactionSync(() => {
  ctx.storage.sql.exec("UPDATE do_threads SET payload = ? WHERE id = ?", payload, id);
  ctx.storage.sql.exec("INSERT INTO do_events(thread_id, type) VALUES (?, ?)", id, "updated");
});
```

The callback commits when it returns and rolls back when it throws. Nested transactions are
rejected. `BEGIN`, `COMMIT`, `ROLLBACK`, and savepoint statements are rejected by `sql.exec`; this
prevents policy code from leaking a half-open transaction into another SSH event.

The Go policy engine serializes calls into one QuickJS runtime, and SQLite uses one pooled connection,
so storage calls are strongly ordered with policy execution. The legacy string-only `policyStore`
remains available for migration and bootstrap identity data.
