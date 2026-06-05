# DevCloud Dep Apps

This directory is the root-scanned app entry for the empty `devcloud-dep`
cluster.

Current live entry:

- root app:
  - `root-devcloud-dep`
- Git repo:
  - `git@git.woa.com:wisp/mono2.git`
- revision:
  - `gitops`
- target cluster:
  - `devcloud-dep`

Leaf apps:

- `cloudagent-gateway-devcloud-dep`: CloudAgent ACP gateway inside the `dep`
  namespace. Runtime credentials are expected as namespace secrets and are not
  stored in this directory.
- `channelgateway-devcloud-dep`: WeCom channel bridge that connects to the
  in-cluster CloudAgent ACP service. Conversation bindings and channel lease
  state use the shared MySQL database named `wisp`, exposed through
  `channelgateway-runtime-secrets`.

Constraints:

- Do not commit kubeconfig credentials here. Register the cluster with the
  local/CI kubeconfig referenced by `argocd/clusters/devcloud-dep.yaml`.
- New leaf apps should use `spec.destination.name: devcloud-dep` and the
  `devcloud-dep` project unless a narrower per-service project is introduced.
- The current target service account can create PVCs, but this cluster has no
  default StorageClass or available PV. `cloudagent-gateway` still uses
  process-local storage in this first live deployment. `channelgateway` uses the
  external MySQL store so enterprise WeCom `session_key -> acp_session_id`
  bindings survive pod restarts and multi-pod failover.
