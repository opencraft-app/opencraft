#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
registry=${ACTOR_OBSERVABILITY_IMAGE_REGISTRY:?set the destination TCR registry hostname}
[[ ${ACTOR_OBSERVABILITY_IMAGE_NAMESPACE:-actor-fleet} == actor-fleet ]]
[[ ${ACTOR_KUBERNETES_VERSION:-1.30.0} == 1.30.0 ]] || {
	echo "the reviewed image lock is bound to Kubernetes 1.30.0" >&2
	exit 2
}
: "${IMAGE_SEED_RECEIPT:?IMAGE_SEED_RECEIPT must name a new immutable receipt path}"

echo "component mirror entry points now execute the complete regional TCR seed" >&2
IMAGE_SEED_REGISTRY="$registry" IMAGE_SEED_NAMESPACE=actor-fleet \
	exec "$script_dir/../gitops/image-seed/seed-tcr.sh"
