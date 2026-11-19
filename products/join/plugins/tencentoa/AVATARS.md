# Channel employee photos
The Join identity adapter records only authenticated Tencent OA staffId/loginName
pairs in join-avatar-profiles.json next to the Server database. The WeCom directory
adapter can record an exact source + opaque sender mapping only after an explicit
successful directory response. Callback display labels and non-directory identity
shortcuts are never photo evidence.

This is a bounded presentation cache (8192 entries, 2 MiB, 60-day retention), not
an identity, membership or authorization database. It contains no session tokens,
credentials or arbitrary URLs. Gateway is the only writer; atomic 0600 snapshots
are read by communication workers. Missing/corrupt/unreadable data fails to letter
fallback, without blocking login, message ingestion or history. Verified mappings
are refreshed on later authentication/directory responses; cache loss is safe.

Channel reads validate current enabled/admitted Human bindings before borrowing
an Actor photo. External association uses the full provider source and the exact
stored sender digest, never a display name. Directory-only photos remain provider
presentation independent of OpenCraft binding. The generic core callback returns
only one kind/name photo key; the existing product avatar provider owns its URL.

These are OA employee photos, not WeCom-native user portraits. Older messages with
no current verified mapping keep letter fallback until such evidence is obtained.
Already-open client projections update on the next channel snapshot; no new
instant cross-client profile revocation mechanism is claimed here.
