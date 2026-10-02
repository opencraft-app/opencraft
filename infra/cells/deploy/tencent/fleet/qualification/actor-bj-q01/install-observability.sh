#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
observability_dir=$fleet_dir/observability

temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT

# The shared collector manifest is a concrete k01 instance. Render a q01 copy
# while preserving every command, Secret mount and metric contract. The backup
# prefix is deliberately qualification-only even though the bucket naming
# convention still contains "prod".
sed \
	-e 's/actor-bj-k01/actor-bj-q01/g' \
	-e 's/bj-k01/bj-q01/g' \
	-e 's|/actor/production/ap-beijing/bj-q01/|/actor/qualification/ap-beijing/bj-q01/|g' \
	"$observability_dir/infrastructure-metrics.yaml" \
	>"$temporary/infrastructure-metrics.yaml"

if grep -q 'bj-k01\|/actor/production/ap-beijing/bj-q01/' "$temporary/infrastructure-metrics.yaml"; then
	echo "q01 observability render retained a production Cell identity" >&2
	exit 1
fi

export ACTOR_REGION=ap-beijing
export ACTOR_CLUSTER_NAME=actor-bj-q01
export ACTOR_FLEET_CONTROLLER_NAMESPACE=actor-fdb-cell-system
export ACTOR_OBSERVABILITY_IMAGE_REGISTRY=lightclaw-bj82.tencentcloudcr.com
export ACTOR_OBSERVABILITY_IMAGE_NAMESPACE=actor-fleet
export ACTOR_INFRASTRUCTURE_METRICS_FILE=$temporary/infrastructure-metrics.yaml
# q01's fixed control nodes expose about 6 GiB allocatable memory each. The
# low-cardinality qualification target uses 1 GiB so Prometheus retains enough
# failure headroom alongside Engine/NATS/API; production Cells may keep 2 GiB.
export ACTOR_PROMETHEUS_MEMORY_REQUEST=1Gi
exec "$observability_dir/install.sh"
