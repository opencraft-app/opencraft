## Beijing Argo Runtime

This path manages the runtime patching required for the local Beijing Argo CD control plane.

Managed here:

- `argocd-cm` kustomize build options for exec plugins
- `argocd-repo-server` custom tools and plugin wiring for `ksops`

Out of scope:

- `sops-age` private key material

Bootstrap prerequisite:

```bash
kubectl -n argocd create secret generic sops-age \
  --from-file=keys.txt=.secret/argocd-beijing-sandbox.agekey
```

Once the secret exists, `argocd-runtime-beijing-sandbox` can fully reconcile the repo-server runtime.
