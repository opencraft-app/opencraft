# Blob resources

Independent Cordis service for renderer-neutral file acquisition. No Hermes,
enterprise service, AppServer, React or IndexedDB dependency in the scheduler itself.

```ts
const fiber = ctx.plugin(BlobResourceService, { concurrency: 3, storage });
await fiber;
const lease = ctx.blobResources.acquire(
  { scope: authenticatedAuthority, path, version },
  (resource, signal, progress) => loader(resource, signal, progress),
  { signal: consumerSignal, priority: 1, persistent: true, maxAgeMs: 10_000 },
);
try { const blob = await lease.promise; /* consume Blob */ }
finally { lease.release(); }
```

The caller must release every lease and loaders must honor cancellation. One
consumer leaving does not abort other consumers. Only the last waiter aborts
shared IO. Identical scope/path/version uses one loader: loaders for the same
identity must represent the same authority. Failures are not cached or retried.
Priority orders waiting work (FIFO within priority); running IO is not preempted.

Memory LRU is bounded by bytes and entries. Explicit persistent opt-in uses a
storage port; browser IndexedDB stores Blobs separately from bounded LRU metadata.
Transactions atomically write/evict both. Storage failure falls back to loading;
cache never owns file truth. Unknown versions require a finite expiry. Call
invalidate after a successful write or an authoritative file-change event.

Browser BlobUrlManager issues reference-counted URL leases. Cache eviction does
not revoke a displayed URL; the final URL consumer revokes it. The service owns
downloads/cache, the renderer owns its URL lease. Fiber disposal aborts work and
closes storage. It cannot revoke a URL still owned by a renderer.

## Web integration

Chat images (including historical attachments) and WorkspaceResourcePanel use
the same application Cordis service via `runtime/blob-files.ts`. File query
cancellation reaches AppServer; metadata cancellation also reaches Hermes HTTP.
The preview has no silent retry and distinguishes queued/cache/loading stages.
AppServer currently supplies no byte-progress events; no percentage is invented.

Current filesystem identity lacks reliable provider-independent account/file
version fields. Its cache therefore uses runtime/Host/connection-generation
isolation and a 10-second TTL, including disk entries. It deliberately does not
reuse private files across page reloads or account/runtime replacement. The
storage adapter supports cross-reload reuse once a caller supplies a trustworthy
stable authenticated scope and version; a path alone is insufficient.

Defaults: 3 active jobs, 64 MiB/256 memory entries; browser storage 256 MiB/512
entries. Idle expired entries are rejected on access and swept on writes. This
module does not add PTYs, physical sockets, or claim independent enterprise service bandwidth.
