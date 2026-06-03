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

Constraints:

- Keep this directory empty until a service deploy-facing path is Argo-ready.
- Do not commit kubeconfig credentials here. Register the cluster with the
  local/CI kubeconfig referenced by `argocd/clusters/devcloud-dep.yaml`.
- New leaf apps should use `spec.destination.name: devcloud-dep` and the
  `devcloud-dep` project unless a narrower per-service project is introduced.
