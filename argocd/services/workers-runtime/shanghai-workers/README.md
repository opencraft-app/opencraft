# workers-runtime / shanghai-workers

Shared GitOps runtime resources for worker apps on the dedicated Shanghai
Temporal worker cluster.

- Owns the `temporal-workers` namespace.
- Owns the `lightclaw-temporal` Temporal `Connection`.
- Generates the shared `workers-runtime-secrets` secret from sops.

Concrete worker apps, such as `workers-rescue-exporter`, own their own
`WorkerDeployment`, `ServiceAccount`, resources, and image pin.
