# Argo Target Clusters

This directory records non-sensitive target cluster onboarding intent for the
shared Argo CD control plane.

It intentionally does not store kubeconfig credentials. Cluster credentials stay
in local/CI secret storage, while the cluster name, expected API server, and
AppProject path remain reviewable in Git.

Apply a target cluster definition with:

```bash
python3 .ci/runtime/commands/onboard_argocd_target_cluster.py \
  --cluster-manifest argocd/clusters/beijing-sandbox-2.yaml \
  --kubeconfig .secret/cls-ftjhqdjt-config \
  --argocd-base-url https://9.208.245.238:30547 \
  --argocd-username admin \
  --argocd-password "$ARGOCD_PASSWORD" \
  --argocd-insecure-skip-verify
```

For the empty DevCloud dep cluster:

```bash
mkdir -p .secret
cp /path/to/dep.conf .secret/devcloud-dep.conf
python3 .ci/runtime/commands/onboard_argocd_target_cluster.py \
  --cluster-manifest argocd/clusters/devcloud-dep.yaml \
  --kubeconfig .secret/devcloud-dep.conf \
  --argocd-base-url "$ARGOCD_BASE_URL" \
  --argocd-username "$ARGOCD_USERNAME" \
  --argocd-password "$ARGOCD_PASSWORD" \
  --argocd-insecure-skip-verify
```
