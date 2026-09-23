## Beijing Argo Runtime

This path manages the runtime patching required for the Beijing Argo CD control plane itself.

Current live application:

- `argocd-runtime-beijing-sandbox`

Current access:

- HTTP:
  - `http://9.135.92.56:32059`
- HTTPS:
  - `https://9.135.92.56:30547`

Login note:

- initial username: `admin`
- if login is needed, contact `skipzhang`

This app is created by `root-beijing-sandbox` from:

- `argocd/apps/beijing-sandbox/argocd-runtime.yaml`

Managed here:

- `argocd-cm` kustomize build options for exec plugins
- `argocd-cmd-params-cm` cross-region Kubernetes client timeouts
- `argocd-repo-server` custom tools and plugin wiring for `ksops`
- `argocd-server` NodePort exposure on `32059` / `30547`

Out of scope:

- `sops-age` private key material

Bootstrap prerequisite:

```bash
CONTROL_PLANE_IP=9.135.92.56 \
  bash scripts/bootstrap_argocd_control_plane.sh

KUBECONFIG_PATH=/path/to/argocd-control-plane.kubeconfig \
  bash scripts/bootstrap_argocd_sops_age.sh
```

Why this exists:

- Beijing deploy-facing services use `ksops`
- `ksops` requires `sops-age` and an exec-plugin-capable `repo-server`
- these runtime requirements are now managed declaratively instead of being hand-patched on the cluster

Once `sops-age` exists, `argocd-runtime-beijing-sandbox` can fully reconcile:

- `argocd-cm`
- `argocd-repo-server`

It should not manage:

- the `sops-age` private key material itself
- repo credentials
- target cluster credentials

Target cluster registration is still Git-tracked by non-sensitive definitions in
`argocd/clusters/`. Apply those definitions with
`.ci/runtime/commands/onboard_argocd_target_cluster.py`, which reads the
credential material from local/CI secret storage instead of committing it.
