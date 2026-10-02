#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
source_operation=${1:-}
[[ $source_operation =~ ^actor-bj-q01-fdb-9-12-[0-9a-f]{8}$ ]] || {
	echo "usage: $0 EXACT_Q01_9_TO_12_OPERATION" >&2
	exit 2
}
for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || { echo "$variable is required" >&2; exit 2; }
done

run_id=$(python3 -c 'import uuid; print(uuid.uuid4().hex[:16])')
receipt="/data/actor-qualification/receipts/actor-bj-q01-fdb-expanded-recovery-${run_id}.json"

invocation=$("$fleet_dir/tat/tat-run.sh" --detach --name "q01-fdb-recovery-${run_id:0:8}" --timeout 14400 <<REMOTE
set -euo pipefail
source_root=\$(readlink -f /var/lib/actor-build/deploy/actor-bj-q01-current)
[[ \$source_root == /var/lib/actor-build/deploy/q01-src-* && -d \$source_root ]]
export KUBECONFIG=/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig
export ACTOR_SOURCE_DIR=\$source_root
export ACTOR_FDB_RECOVERY_SOURCE_OPERATION=$source_operation
export ACTOR_FDB_RECOVERY_RUN_ID=$run_id
export ACTOR_FDB_RECOVERY_RECEIPT=$receipt
export ALLOW_FDB_EXPANDED_RECOVERY=1
exec "\$source_root/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/run-recover-expanded-fdb.sh"
REMOTE
)

printf 'tat_invocation=%s\n' "$invocation"
printf 'remote_receipt=%s\n' "$receipt"
