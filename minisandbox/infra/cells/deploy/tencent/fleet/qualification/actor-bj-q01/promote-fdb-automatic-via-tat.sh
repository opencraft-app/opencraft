#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}
local_receipt_dir=${QUALIFICATION_RECEIPT_DIR:-/data/actor-qualification/receipts}

[[ $# -eq 0 ]] || { echo "Usage: promote-fdb-automatic-via-tat.sh" >&2; exit 2; }
for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || {
		echo "$variable must be supplied through the protected environment" >&2
		exit 2
	}
done
install -d -m 0700 "$state_dir" "$local_receipt_dir"

"$fleet_dir/tat/tat-run.sh" --name q01-promote-fdb-automatic --timeout 1800 <<'REMOTE'
set -euo pipefail
source_root=$(readlink -e /var/lib/actor-build/deploy/actor-bj-q01-current)
receipt=$(python3 - <<'PY'
import glob, os
paths = glob.glob('/data/actor-qualification/receipts/actor-bj-q01-fdb-autoscaling-*.json')
print(max(paths, key=os.path.getmtime) if paths else '')
PY
)
test -n "$receipt"
CELL=actor-bj-q01 \
CELL_NAMESPACE=actor-fdb-cell-system \
KUBECONFIG=/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig \
RUNTIME_RECEIPTS_DIR=/data/actor-qualification/receipts \
  "$source_root/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/promote-fdb-automatic.sh" "$receipt"
REMOTE

remote_receipt=$("$fleet_dir/tat/tat-run.sh" --name q01-read-fdb-promotion-receipt --timeout 120 <<'REMOTE'
set -euo pipefail
python3 - <<'PY'
import glob, os
paths = glob.glob('/data/actor-qualification/receipts/actor-bj-q01-fdb-automatic-promotion-*.json')
print(max(paths, key=os.path.getmtime) if paths else '')
PY
REMOTE
)
[[ $remote_receipt == /data/actor-qualification/receipts/actor-bj-q01-fdb-automatic-promotion-*.json ]]
local_receipt="$local_receipt_dir/$(basename -- "$remote_receipt")"
"$script_dir/relay-download-from-builder.sh" "$remote_receipt" "$local_receipt"
jq -e '.schemaVersion=="actor-fdb-automatic-promotion-v1" and .verdict=="passed" and .cell=="actor-bj-q01" and .toMode=="Automatic"' "$local_receipt" >/dev/null
printf 'fdb_automatic_promotion_local_receipt=%s\n' "$local_receipt"
