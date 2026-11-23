# Server information and external notification links

Web Settings → Server information is a server-scoped, administrator-written
configuration. Admitted human members may view it. Session/tool credentials do
not manage it. Writes require the current administrator, JSON same-origin browser
submission, expected human Actor and the previously read revision. Concurrent
administrators get a conflict rather than silently overwriting each other.

`publicUrl` is a complete HTTP(S) entry including any Hub/server path prefix,
for example `https://entry.example/servers/hub-id`. It is not just a hostname.
Credentials, query parameters, fragments, ambiguous/dot path segments and non-HTTP
schemes are rejected. HTTPS is recommended; HTTP remains available for explicitly
configured local/intranet deployments. No deployment hostname is preselected.

The Gateway keeps `server-information.json` in its existing data directory,
through the `StateDocumentStore` port (`fileStateDocumentStore`). A
process-independent document lock, private temporary file, atomic replacement,
file/directory sync and the owner's revision fence protect updates. Replace the container
while retaining that data volume to retain the setting. Restart is not required
after saving. Damaged/unsupported configuration is reported as unavailable; it is
never silently overwritten or treated as a missing setting.

External destinations (including already registered WeCom, Bark and webhook
recipients) read the configured entry when preparing each delivery. The original
thread/Host route and recipient authorization remain intact. Existing personal
destination records do not need rebinding. Empty/unconfigured `publicUrl` retains
the address saved at registration; this may be an obsolete deployment address,
so administrators should set the correct complete entry explicitly. Browser/PWA
Web Push retains its subscribed origin/scope, not the external entry.

This setting only generates notification links. It does not publish DNS, issue
certificates, change Hub registration, configure a reverse proxy, trust an Origin,
fetch an administrator-supplied URL, or grant server/thread access. Request security
continues to use the existing verified identity and same-origin authority. The
settings page uses server-scoped fetch and shared Settings controls/layout tokens.
Its cache retains only non-secret server-wide configuration, never human identity
or administrator authority. Expiry clears the cache; conflicts/unknown save
acknowledgements require an explicit reload before another mutation.
