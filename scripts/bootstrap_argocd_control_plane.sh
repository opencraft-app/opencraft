#!/usr/bin/env bash

set -euo pipefail

K0S_VERSION="${K0S_VERSION:-v1.36.3+k0s.0}"
K0S_IMAGE="${K0S_IMAGE:-docker.io/k0sproject/k0s:v1.36.3-k0s.0}"
K0S_IMAGE_DIGEST="${K0S_IMAGE_DIGEST:-sha256:1346532286d1f8b98ede601a159b2c4381d6ea00dfd790323585a69a36ea30ab}"
ARGOCD_VERSION="${ARGOCD_VERSION:-v3.5.3}"
ARGOCD_MANIFEST_SHA256="${ARGOCD_MANIFEST_SHA256:-7efe2d6bbc03f63623640f1e4198f16c84009d510fb810ef71e56df1b7614ba9}"

CONTROL_PLANE_IP="${CONTROL_PLANE_IP:?set CONTROL_PLANE_IP to the control-plane host address}"
K0S_CONTAINER="${K0S_CONTAINER:-argocd-k0s}"
K0S_DATA_DIR="${K0S_DATA_DIR:-/data/k0s-argocd}"
K0S_POD_LOG_DIR="${K0S_POD_LOG_DIR:-/data/k0s-pod-logs}"
BOOTSTRAP_DIR="${BOOTSTRAP_DIR:-/data/argocd-bootstrap}"
CI_SECRET_DIR="${CI_SECRET_DIR:-/etc/lightclaw-ci}"
ARGOCD_HTTP_NODE_PORT="${ARGOCD_HTTP_NODE_PORT:-32059}"
ARGOCD_HTTPS_NODE_PORT="${ARGOCD_HTTPS_NODE_PORT:-30547}"

for command in curl docker sha256sum; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "missing required command: ${command}" >&2
    exit 1
  }
done

mkdir -p "${K0S_DATA_DIR}" "${K0S_POD_LOG_DIR}" "${BOOTSTRAP_DIR}" "${CI_SECRET_DIR}"

image_ref="${K0S_IMAGE}@${K0S_IMAGE_DIGEST}"
docker pull "${image_ref}"

if ! docker container inspect "${K0S_CONTAINER}" >/dev/null 2>&1; then
  docker run -d \
    --name "${K0S_CONTAINER}" \
    --hostname "${K0S_CONTAINER}" \
    --restart unless-stopped \
    --privileged \
    --cgroupns host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    -v "${K0S_DATA_DIR}:/var/lib/k0s:Z" \
    -v "${K0S_POD_LOG_DIR}:/var/log/pods:Z" \
    --tmpfs /run \
    --tmpfs /tmp \
    -p 6443:6443 \
    -p "${ARGOCD_HTTP_NODE_PORT}:${ARGOCD_HTTP_NODE_PORT}" \
    -p "${ARGOCD_HTTPS_NODE_PORT}:${ARGOCD_HTTPS_NODE_PORT}" \
    "${image_ref}"
else
  current_image="$(docker container inspect "${K0S_CONTAINER}" --format '{{.Config.Image}}')"
  if [[ "${current_image}" != "${image_ref}" && "${current_image}" != "${K0S_IMAGE}" ]]; then
    echo "existing ${K0S_CONTAINER} uses unexpected image: ${current_image}" >&2
    exit 1
  fi
  docker start "${K0S_CONTAINER}" >/dev/null
fi

for _ in $(seq 1 90); do
  if docker exec "${K0S_CONTAINER}" k0s kubectl get node "${K0S_CONTAINER}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

docker exec "${K0S_CONTAINER}" k0s kubectl taint node "${K0S_CONTAINER}" \
  node-role.kubernetes.io/control-plane:NoSchedule- >/dev/null 2>&1 || true

for _ in $(seq 1 90); do
  ready="$(docker exec "${K0S_CONTAINER}" k0s kubectl get node "${K0S_CONTAINER}" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
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

docker exec "${K0S_CONTAINER}" k0s kubectl create namespace argocd \
  --dry-run=client -o yaml | docker exec -i "${K0S_CONTAINER}" k0s kubectl apply -f -
docker exec -i "${K0S_CONTAINER}" k0s kubectl apply \
  --server-side --force-conflicts -n argocd -f - < "${manifest}"

docker exec "${K0S_CONTAINER}" k0s kubectl -n argocd patch service argocd-server \
  --type merge \
  -p "{\"spec\":{\"type\":\"NodePort\",\"ports\":[{\"name\":\"http\",\"port\":80,\"protocol\":\"TCP\",\"targetPort\":8080,\"nodePort\":${ARGOCD_HTTP_NODE_PORT}},{\"name\":\"https\",\"port\":443,\"protocol\":\"TCP\",\"targetPort\":8080,\"nodePort\":${ARGOCD_HTTPS_NODE_PORT}}]}}"
docker exec "${K0S_CONTAINER}" k0s kubectl -n argocd rollout status \
  deployment/argocd-server --timeout=300s

docker exec "${K0S_CONTAINER}" k0s kubeconfig admin > "${CI_SECRET_DIR}/kubeconfig_argocd_control_plane"
chmod 0600 "${CI_SECRET_DIR}/kubeconfig_argocd_control_plane"
printf 'https://%s:%s\n' "${CONTROL_PLANE_IP}" "${ARGOCD_HTTPS_NODE_PORT}" \
  > "${CI_SECRET_DIR}/argocd_base_url"
chmod 0600 "${CI_SECRET_DIR}/argocd_base_url"

cat <<EOF
Argo CD base installation is ready.

HTTP:  http://${CONTROL_PLANE_IP}:${ARGOCD_HTTP_NODE_PORT}
HTTPS: https://${CONTROL_PLANE_IP}:${ARGOCD_HTTPS_NODE_PORT}

Next steps remain intentionally credential-aware and separate:
  1. restore the admin password from protected storage;
  2. add the mono2 repository credential;
  3. inject sops-age with scripts/bootstrap_argocd_sops_age.sh;
  4. register target clusters from protected kubeconfigs;
  5. apply AppProjects, runtime, and root Applications from gitops.
EOF
