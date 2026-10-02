#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for cluster in runtime-a runtime-b; do
	log "publishing OCM smoke ManifestWork to ${cluster}"
	kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null <<YAML
apiVersion: work.open-cluster-management.io/v1
kind: ManifestWork
metadata:
  name: local-mesh-smoke
  namespace: ${cluster}
  labels:
    app.kubernetes.io/part-of: rivet-local-mesh
spec:
  workload:
    manifests:
      - apiVersion: v1
        kind: ConfigMap
        metadata:
          name: local-mesh-smoke
          namespace: default
        data:
          managedCluster: ${cluster}
          source: mesh-hub
YAML
done
