# Read-only current server connection

The Server information page shows the browser origin and the server-context path
as the current browser entry. Never infer notification defaults from that address:
only the separately saved public URL changes external notifications. No domain
is hardcoded or persisted by reading this page.

The relay rows reuse the existing administrator-only Hub settings GET and retain
only peer ID/name/endpoint/observed connected state. They do not infer that every
connected peer is the current request hop. Snapshot invitations, authority keys,
audit and origins are not retained. Failed/denied reads discard old peer details;
actor changes abort and fence late responses. Periodic refresh is bounded and
runs only while visible. A relay detail failure does not block the settings form.
No new endpoint, permission, runtime owner, routing policy or dependency is added.
