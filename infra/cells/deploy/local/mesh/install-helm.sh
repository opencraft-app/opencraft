#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

if command -v helm >/dev/null 2>&1; then
	require_version helm "${HELM_VERSION}" "$(helm version --template '{{.Version}}')"
	exit 0
fi

require_command curl
require_command sha256sum
require_command tar
archive=$(mktemp)
directory=$(mktemp -d)
cleanup() { rm -f -- "${archive}"; rm -rf -- "${directory}"; }
trap cleanup EXIT

url="https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz"
log "installing Helm ${HELM_VERSION} from the official release archive"
curl -fsSL "${url}" -o "${archive}"
printf '%s  %s\n' "${HELM_LINUX_AMD64_SHA256}" "${archive}" | sha256sum --check --status
tar -xzf "${archive}" -C "${directory}" linux-amd64/helm
install -m 0755 "${directory}/linux-amd64/helm" /usr/local/bin/helm
