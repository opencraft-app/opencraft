#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}
state=$state_dir/bootstrap-node.json
[[ -s $state ]] || { echo "q01 bootstrap-node state is missing" >&2; exit 2; }
instance=$(jq -er '.InstanceIdSet | select(length == 1) | .[0] | select(test("^ins-[a-z0-9]+$"))' "$state")
[[ ${TAT_INSTANCE_ID:-} == "$instance" ]] || {
	echo "TAT_INSTANCE_ID is not the exact converged q01 operator instance" >&2
	exit 2
}

"$fleet_dir/tat/tat-run.sh" --name q01-bootstrap-operator-node --timeout 1200 <<'REMOTE'
set -euo pipefail
dnf install -y jq git tar gzip util-linux >/dev/null
install -d -m 0755 /data /data/tmp /data/build-cache /data/actor-qualification
install -d -m 0700 /var/lib/actor-build /var/lib/actor-build/deploy \
  /var/lib/actor-build/incoming /var/lib/actor-build/credentials
available=$(df -B1 --output=avail / | tail -1 | tr -d ' ')
test "$available" -ge 53687091200
for command in jq python3 sha256sum kubectl curl git tar gzip flock; do
  command -v "$command" >/dev/null
done
printf 'operator_node_bootstrap=passed root_available_bytes=%s\n' "$available"
REMOTE
