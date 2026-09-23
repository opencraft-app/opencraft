#!/usr/bin/env bash

set -euo pipefail

K0S_VERSION="${K0S_VERSION:-v1.36.3+k0s.0}"
K0S_IMAGE="${K0S_IMAGE:-docker.io/k0sproject/k0s:v1.36.3-k0s.0}"
K0S_IMAGE_DIGEST="${K0S_IMAGE_DIGEST:-sha256:1346532286d1f8b98ede601a159b2c4381d6ea00dfd790323585a69a36ea30ab}"
ARGOCD_VERSION="${ARGOCD_VERSION:-v3.5.3}"
ARGOCD_MANIFEST_SHA256="${ARGOCD_MANIFEST_SHA256:-7efe2d6bbc03f63623640f1e4198f16c84009d510fb810ef71e56df1b7614ba9}"

CONTROL_PLANE_IP="${CONTROL_PLANE_IP:?set CONTROL_PLANE_IP to the control-plane host address}"
K0S_DATA_DIR="${K0S_DATA_DIR:-/data/k0s-argocd-native}"
LEGACY_K0S_CONTAINER="${LEGACY_K0S_CONTAINER:-argocd-k0s}"
BOOTSTRAP_DIR="${BOOTSTRAP_DIR:-/data/argocd-bootstrap}"
CI_SECRET_DIR="${CI_SECRET_DIR:-/etc/lightclaw-ci}"
ARGOCD_HTTP_NODE_PORT="${ARGOCD_HTTP_NODE_PORT:-32059}"
ARGOCD_HTTPS_NODE_PORT="${ARGOCD_HTTPS_NODE_PORT:-30547}"

for command in curl docker install sha256sum systemctl; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "missing required command: ${command}" >&2
    exit 1
  }
done

mkdir -p "${K0S_DATA_DIR}" "${BOOTSTRAP_DIR}" "${CI_SECRET_DIR}"

image_ref="${K0S_IMAGE}@${K0S_IMAGE_DIGEST}"
docker pull "${image_ref}"

if docker container inspect "${LEGACY_K0S_CONTAINER}" >/dev/null 2>&1; then
  echo "legacy k0s-in-Docker container exists: ${LEGACY_K0S_CONTAINER}" >&2
  echo "stop and remove it after preserving its data directory before running native bootstrap" >&2
  exit 1
fi

extract_container="k0s-binary-extract-$$"
docker create --name "${extract_container}" "${image_ref}" >/dev/null
trap 'docker rm -f "${extract_container}" >/dev/null 2>&1 || true' EXIT
docker cp "${extract_container}:/usr/local/bin/k0s" "${BOOTSTRAP_DIR}/k0s-${K0S_VERSION}"
install -m 0755 "${BOOTSTRAP_DIR}/k0s-${K0S_VERSION}" /usr/local/bin/k0s
docker rm "${extract_container}" >/dev/null
trap - EXIT

if ! /usr/local/bin/k0s version | grep -Fq "${K0S_VERSION}"; then
  echo "installed k0s binary does not match ${K0S_VERSION}" >&2
  exit 1
fi

if ! systemctl list-unit-files k0scontroller.service --no-legend 2>/dev/null | grep -q '^k0scontroller.service'; then
  /usr/local/bin/k0s install controller --single --no-taints --data-dir "${K0S_DATA_DIR}"
fi
/usr/local/bin/k0s start

for _ in $(seq 1 90); do
  if /usr/local/bin/k0s kubectl get nodes >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

node_name="$(/usr/local/bin/k0s kubectl get nodes -o jsonpath='{.items[0].metadata.name}')"
/usr/local/bin/k0s kubectl taint node "${node_name}" \
  node-role.kubernetes.io/control-plane:NoSchedule- >/dev/null 2>&1 || true

for _ in $(seq 1 90); do
  ready="$(/usr/local/bin/k0s kubectl get node "${node_name}" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
  [[ "${ready}" == "True" ]] && break
  sleep 2
done

if [[ "${ready:-}" != "True" ]]; then
  echo "k0s node did not become Ready" >&2
  exit 1
fi

manifest="${BOOTSTRAP_DIR}/install-${ARGOCD_VERSION}.yaml"
curl -fsSL --retry 3 \
  "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml" \
  -o "${manifest}"
echo "${ARGOCD_MANIFEST_SHA256}  ${manifest}" | sha256sum --check --status

/usr/local/bin/k0s kubectl create namespace argocd \
  --dry-run=client -o yaml | /usr/local/bin/k0s kubectl apply -f -
/usr/local/bin/k0s kubectl apply \
  --server-side --force-conflicts -n argocd -f - < "${manifest}"

/usr/local/bin/k0s kubectl -n argocd patch service argocd-server \
  --type merge \
  -p "{\"spec\":{\"type\":\"NodePort\",\"ports\":[{\"name\":\"http\",\"port\":80,\"protocol\":\"TCP\",\"targetPort\":8080,\"nodePort\":${ARGOCD_HTTP_NODE_PORT}},{\"name\":\"https\",\"port\":443,\"protocol\":\"TCP\",\"targetPort\":8080,\"nodePort\":${ARGOCD_HTTPS_NODE_PORT}}]}}"
/usr/local/bin/k0s kubectl -n argocd rollout status \
  deployment/argocd-server --timeout=300s

/usr/local/bin/k0s kubeconfig admin > "${CI_SECRET_DIR}/kubeconfig_argocd_control_plane"
chmod 0600 "${CI_SECRET_DIR}/kubeconfig_argocd_control_plane"
printf 'https://%s:%s\n' "${CONTROL_PLANE_IP}" "${ARGOCD_HTTPS_NODE_PORT}" \
  > "${CI_SECRET_DIR}/argocd_base_url"
chmod 0600 "${CI_SECRET_DIR}/argocd_base_url"

cat <<EOF
Native Argo CD control-plane installation is ready.

HTTP:  http://${CONTROL_PLANE_IP}:${ARGOCD_HTTP_NODE_PORT}
HTTPS: https://${CONTROL_PLANE_IP}:${ARGOCD_HTTPS_NODE_PORT}

Next steps remain intentionally credential-aware and separate:
  1. restore the admin password from protected storage;
  2. add the mono2 repository credential;
  3. inject sops-age with scripts/bootstrap_argocd_sops_age.sh;
  4. register target clusters from protected kubeconfigs;
  5. apply AppProjects, runtime, and root Applications from gitops.
EOF
