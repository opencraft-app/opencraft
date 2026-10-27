# Optional OpenCraft observation plane

This Linux reference profile runs four pinned containers and one host Node service:
Collector → Loki; Observe → Prometheus; Grafana reads Prometheus/Loki. Observe owns
bounded, derived evidence and activity data. Business services remain independently
managed. Nothing starts until the deployment explicitly enables the profile.

Use Node 26 and Docker Compose 2. The installed server archive includes
`runtime/observe-service.mjs`, `runtime/observe-cli.mjs`, the runtime Skill and this
provisioning directory. No source checkout or enterprise service is required.

1. Copy this directory to an operator-owned configuration directory. Create a private
   `/var/lib/opencraft-observe` (0700), including `grafana` owned by the container's
   UID 472. Configure separate persistent filesystems with capacity limits of 10 GiB
   for `prometheus`, 5 GiB for `loki`, and 1 GiB for Observe by default. Use
   filesystem/project quotas or the optional image-backed preparation helper;
   retention alone is not a disk quota. Deployments that need a larger Observe
   database may pass a bounded GiB value as the helper's second argument, while the
   service's `databaseBytes` config sets the SQLite logical cap below that volume
   with WAL/headroom. The default remains 1 GiB; deployments may choose a
   bounded value and must keep backups outside the data volume. Do not place
   business data in these filesystems.
2. Set `OPENCRAFT_OBSERVE_DIRECTORY` and `OPENCRAFT_OBSERVE_PUBLIC_ORIGIN` in a private
   `.env`. The latter is the existing authenticated workbench origin, with no trailing
   slash. Ports 23302–23306 and 23308 bind loopback only. Grafana has **no TCP listener**; its
   socket is protected by the private parent directory. Live is explicitly disabled.
3. Create an owned 0600 JSON configuration for Observe:

   ```json
   {"directory":"/var/lib/opencraft-observe/data","deploymentId":"my-deployment"}
   ```

   Run `node /installed/release/runtime/observe-service.mjs` with
   `OPENCRAFT_OBSERVE_CONFIG` referencing that file. The systemd template uses
   `/etc/opencraft/observe.env`; set `OPENCRAFT_OBSERVE_SERVICE` to the installed
   release entry. Adapt `ReadWritePaths` if using another private directory.
4. Run `docker compose up -d`. Native Prometheus retention is 30d/10GB and Loki
   retention is 7d. Separate filesystem quotas bound WAL, indexes and compaction too.
   `docker compose down` preserves all volumes; never use `down -v` for an upgrade.
5. In the existing Headless service, set `OPENCRAFT_OBSERVE_SOCKET` to the private
   `observe.sock`, and `OPENCRAFT_OBSERVE_INGRESS_CONFIG` to an owned 0600 JSON file:

   ```json
   {"socketPath":"/var/lib/opencraft-observe/data/observe.sock","grafanaSocket":"/var/lib/opencraft-observe/grafana/grafana.sock","pseudonymKey":"REPLACE_WITH_64_RANDOM_HEX_CHARACTERS"}
   ```

   Generate the key into the private file; never put it in a URL or a shell argument.
   Set the same socket on the execution owners to enable their optional emitters.
   The host authenticates each request with its existing identity/membership authority.
   Instance administrators have deployment observation access. Members may submit
   sanitized client diagnostics but cannot read the deployment's data. No configured
   authority means no dashboard access. Do not expose Grafana, Observe, Loki or
   Prometheus through a separate public listener.
6. The generic workbench includes the optional `createObservabilityExtension`. Custom
   product assemblies register it with their existing server-extension assembly. It discovers the fixed origin's capabilities
   after startup. The navigation command opens the authenticated dashboard in a new
   tab with `noopener`; it does not select a conversation Host.
7. Install/symlink `runtime/observe-cli.mjs` as `opencraft-observe`. Authorized
   maintenance processes receive `OPENCRAFT_OBSERVE_TARGET=unix:///var/lib/opencraft-observe/data/observe.sock`.
   The private socket's OS identity grants deployment read access; do not make it
   world/group writable or pass it to untrusted agents. No storage/admin credentials
   are used by the CLI. Use the existing OS/process boundary for restricted agents.
8. Set `OPENCRAFT_OFFICIAL_SKILLS_ROOT` to the installed `runtime/skills` for DSH/Pi.
   For Codex, link the official skill into the deployment's configured Codex skills
   directory only if that name is absent. Preserve existing user directories and
   configuration. Verify native discovery and actual CLI execution outside a checkout.

Generate dashboards in a source checkout with `node ops/observability/generate.mjs`.
Latency histograms include successful visible interactive operations only, separated by cache and engine; unknown dimensions stay explicit. Probe/background samples remain in evidence and source-separated outcome counters. Component identity responses contain the latest observed producer per component, not an inventory of every tab or process.

The generated expressions come exclusively from `packages/observability-query`.
Grafana and CLI queries use the same absolute evaluation timestamp. Domain gauges
declare rolling 24h/7d scope; the 24h and 7d human totals are independent unions, not additive. Active execution stages and oldest effective progress age use domain identities; queue owner snapshots expire to unknown after 90s and never create execution rounds. Latest state in evidence is explicitly separate from historical-window events; missing internal capacity/model information remains unknown. histogram/counter rates are estimates over their stated
5m interval. Evidence contains exact event samples separately, with a fixed received
watermark and explicit truncation; these are not interchangeable measurement kinds.

For upgrades, retain private configuration, quota-backed volumes and pseudonym key.
Install the ordinary fixed server release, update/restart the observation service and
containers independently, then verify actual component identities. An observation
failure must not roll back or restart business execution. To disable, remove the
Headless observation configuration and emitter socket from its normal deployment
configuration, then stop Observe and `docker compose down`. Existing observation
data stays available for a later re-enable. Roll back code/configuration only; never
restore business backups as part of an observation rollback.

Runtime acceptance remains tracked by [the V1 matrix](../../docs/observability-acceptance.md).
Container health and the focused tests are not completion of that matrix.

### Named-server dashboard paths

Browser telemetry, capability discovery and dashboard navigation use the selected
server's existing URL scope. They must never fall back to the default server.
For an installation reached under `/servers/example`, set `grafanaBasePath` in
both its Observe JSON and private ingress JSON to
`/servers/example/__opencraft_observe/grafana`. Set Grafana's
`GF_SERVER_ROOT_URL` to the public HTTPS origin followed by that same path and a
trailing slash (using an operator-owned Compose override). Keep the default path
for root installations. The ingress maps its internal route to the configured
Grafana path; readiness uses that path too. This affects URL routing only, never
the identity/membership authority. Relay HTML scoping preserves already-scoped
base and resource paths. Validate HTML, static chunks and datasource requests
through the actual server route, including rejection outside existing grants.
