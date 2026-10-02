# Local fleet ingress

This layer runs Caddy inside the Hub cluster (cluster C). The two independent runtime Cells expose
only Docker-private Guard and api-peer NodePorts. A minimal HAProxy container publishes only Caddy's
TCP port on one explicit host address; it does not route HTTP or know Actor identity.

```text
LAN or localhost
  -> host TCP publisher
  -> cluster C Caddy
  -> /grafana/ -> cluster C Grafana
  -> /v1/ -> cluster C Workers API public façade
  -> all other runtime routes -> cluster A or B Guard
  -> Guard uses the Actor ID's Cell label for an exact cross-Cell hop when needed
```

The safe default binds `127.0.0.1:18080`. To serve a trusted LAN, choose one exact host address;
`0.0.0.0` is rejected:

```sh
RIVET_LOCAL_INGRESS_BIND_ADDRESS=10.0.0.10 \
RIVET_LOCAL_INGRESS_HTTP_PORT=18080 \
  infra/cells/deploy/local/ingress/up.sh
```

After a successful deployment, the selected address and port are saved under the mesh state
directory (outside the repository). Later `up.sh` and `verify.sh` runs reuse that binding unless an
environment variable overrides it. `down.sh` intentionally preserves the binding.

Verify both runtime paths or remove only this optional layer with:

```sh
infra/cells/deploy/local/ingress/verify.sh
infra/cells/deploy/local/ingress/cross-cell-e2e.sh
infra/cells/deploy/local/ingress/down.sh
```

The cross-Cell gate creates a temporary Actor in B, forces its request through A Guard, requires a
successful response from B, and deletes the test Actor on exit.

Ordinary requests use the single global origin and are balanced across both healthy Guards.
`/grafana/` exposes the Hub Grafana UI and read-only HTTP API directly to the trusted LAN as an
anonymous Viewer. For example, the current binding `9.134.163.40:6688` serves Grafana at
`http://9.134.163.40:6688/grafana/`. Prometheus remains ClusterIP-only and is not exposed.
`/v1/` is the stable Workers API. Clients receive Worker, Version, Deployment, and Object resources
without seeing the private namespace, runner selector, datacenter, Cell, Registry, Engine, or Actor
ID. Caddy rejects the legacy `/api/worker-registry/` path entirely; runtime Cells fetch immutable
Version content from Registry over the private mesh instead.
`Host: runtime-a.local` / `Host: runtime-b.local` and the `/runtime-a/` / `/runtime-b/` prefixes are
retained only as deterministic diagnostic routes. The exact root path returns a small ingress health
document. Caddy supports HTTP streaming and WebSocket upgrades through its normal reverse proxy.
The runtime topology assigns Cell labels 1 and 2, so a Guard that receives an Actor belonging to the
other Cell performs the exact second hop over the private Docker network.

Cluster C contains no Rivet Engine, NATS, or FDB. Only the publisher binds a host port. Kubernetes
APIs, both independent FDB clusters, both Cell-local NATS clusters, Engine ClusterIPs, and
Prometheus remain unexposed. The runtime NodePorts are reachable only on the shared private Docker
network in this local profile. Caddy access logs are disabled because Actor gateway URLs may contain
credentials. The local profile is plain HTTP and is suitable only for loopback or an explicitly
trusted LAN; the CCN target uses private CLBs plus gateway mTLS on port 443.
