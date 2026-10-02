#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
usage:
  init-backend.sh foundation STATE_BUCKET
  init-backend.sh management STATE_BUCKET
  init-backend.sh operations-network STATE_BUCKET
  init-backend.sh cell STATE_BUCKET CELL_ID

TENCENT_REGION defaults to ap-beijing. TF_DATA_DIR is isolated below
/data/actor-terraform unless explicitly supplied by the caller. Disposable
tool/plugin caches are not rebuild inputs.
EOF
	exit 2
}

[[ $# -ge 2 ]] || usage
scope=$1
state_bucket=$2
cell_id=${3:-}
region=${TENCENT_REGION:-ap-beijing}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

case "$scope" in
foundation)
	[[ $# -eq 2 ]] || usage
	root=$script_dir/foundation
	prefix=actor-fleet/foundation
	state_identity=foundation
	;;
management)
	[[ $# -eq 2 ]] || usage
	root=$script_dir/management
	prefix=actor-fleet/management
	state_identity=management
	;;
operations-network)
	[[ $# -eq 2 ]] || usage
	root=$script_dir/operations-network
	prefix=actor-fleet/operations-network
	state_identity=operations-network
	;;
cell)
	[[ $# -eq 3 ]] || usage
	[[ $cell_id =~ ^actor-[a-z]{2}-[a-z][0-9]{2}$ ]] || {
		echo "invalid Cell identity: $cell_id" >&2
		exit 2
	}
	root=$script_dir/cell
	prefix=actor-fleet/cells/$cell_id
	state_identity=cell-$cell_id
	;;
*) usage ;;
esac

[[ $state_bucket =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || {
	echo "invalid COS state bucket name" >&2
	exit 2
}
[[ $region =~ ^[a-z]+-[a-z]+$ ]] || {
	echo "invalid Tencent region" >&2
	exit 2
}

terraform=$($script_dir/tools/resolve-terraform.sh)

export TF_DATA_DIR=${TF_DATA_DIR:-/data/actor-terraform/create-first/$state_identity}
mkdir -p "$TF_DATA_DIR"

"$terraform" -chdir="$root" init -reconfigure \
	-backend-config="region=$region" \
	-backend-config="bucket=$state_bucket" \
	-backend-config="prefix=$prefix" \
	-backend-config="key=terraform.tfstate" \
	-backend-config="encrypt=true"

printf 'initialized scope=%s region=%s bucket=%s prefix=%s data_dir=%s\n' \
	"$scope" "$region" "$state_bucket" "$prefix" "$TF_DATA_DIR"
