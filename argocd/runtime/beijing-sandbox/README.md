## Beijing Argo Runtime

This path manages the runtime patching required for the Beijing Argo CD control plane itself.

Current live application:

- `argocd-runtime-beijing-sandbox`

Current access:

- HTTP:
  - `http://9.208.245.238:32059`
- HTTPS:
  - `https://9.208.245.238:30547`

Login note:

- initial username: `admin`
- if login is needed, contact `skipzhang`

This app is created by `root-beijing-sandbox` from:

- `argocd/apps/beijing-sandbox/argocd-runtime.yaml`

Managed here:

- `argocd-cm` kustomize build options for exec plugins
- `argocd-repo-server` custom tools and plugin wiring for `ksops`

Out of scope:

- `sops-age` private key material

Bootstrap prerequisite:

```bash
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
- target cluster registration
