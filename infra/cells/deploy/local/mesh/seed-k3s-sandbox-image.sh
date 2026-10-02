#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

for command in docker k3d; do require_command "$command"; done
(( $# > 0 )) || die "usage: $0 K3D_CLUSTER [K3D_CLUSTER ...]"

# A running k3s node may not retain its sandbox image forever.  Import the
# immutable Tencent-mirror object under the exact name requested by k3s before
# a bootstrap or fault E2E creates any new Pod.  This removes Docker Hub from
# the local control path without changing k3s' sandbox-image configuration.
docker image inspect "$K3S_SANDBOX_IMAGE_SOURCE" >/dev/null 2>&1 || \
	docker pull "$K3S_SANDBOX_IMAGE_SOURCE" >/dev/null
docker tag "$K3S_SANDBOX_IMAGE_SOURCE" "$K3S_SANDBOX_IMAGE"

for cluster in "$@"; do
	cluster_exists "$cluster" || die "k3d cluster does not exist: $cluster"
	k3d image import "$K3S_SANDBOX_IMAGE" --cluster "$cluster" >/dev/null
	log "seeded immutable k3s sandbox image in $cluster"
done
