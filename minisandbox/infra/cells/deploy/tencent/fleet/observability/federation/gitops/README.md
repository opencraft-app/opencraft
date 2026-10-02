# Hub observability GitOps handoff

`install-hub.sh` performs the one-time pinned Helm bootstrap.  The GitOps
handoff then exports that exact release plus the checked-in storage, rules and
dashboard manifests, removes every Secret and Helm hook from the steady desired
tree, CAS-publishes `management/observability`, and adopts the existing objects
without replacing their UIDs or PVCs.

The Argo project deliberately has no wildcard resource permission and cannot
write Secrets. Grafana credentials, TCR pull credentials, webhook certificates,
Prometheus-generated TLS/config Secrets and the noncredential federation scrape
Secret remain bootstrap/operator owned. `install-application.sh` marks the
formerly Argo-owned scrape Secret `Prune=false` before the first restricted
revision, verifies identity preservation, and performs a real self-heal fault
injection against a dashboard.

Later updates start with the previously rendered `hub.yaml`, pass its immutable
render receipt through `--prior-render-receipt`, and append only the reviewed
new manifests. The renderer requires the base manifest digest to match both
`hubManifestSha256` and `files["hub.yaml"]` in that receipt before inheriting
the external-Secret inventory. This keeps the update path credential-free
without weakening the proof that required bootstrap-owned Secrets still exist
outside Git.
