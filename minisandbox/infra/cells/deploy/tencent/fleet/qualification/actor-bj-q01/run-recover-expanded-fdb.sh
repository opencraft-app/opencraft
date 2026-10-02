#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
source_root=${ACTOR_SOURCE_DIR:-$(CDPATH= cd -- "$fleet_dir/../../../../.." && pwd)}
source_operation=${ACTOR_FDB_RECOVERY_SOURCE_OPERATION:?bind recovery to the exact successful 9-to-12 FdbScaleOperation}
[[ ${ALLOW_FDB_EXPANDED_RECOVERY:-0} == 1 ]] || { echo "set ALLOW_FDB_EXPANDED_RECOVERY=1 after reviewing the exact source operation" >&2; exit 2; }

if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
	exec "$fleet_dir/operations/with-autonomy-operation-lock.sh" -- "$0" "$@"
fi

source_revision=$(tr -d '[:space:]' <"$source_root/.actor-source/SOURCE_REVISION")
source_manifest="$source_root/.actor-source/RELEASE_SHA256SUMS"
(
	cd "$source_root"
	sha256sum --check "$source_manifest" >/dev/null
)
source_manifest_sha=$(sha256sum "$source_manifest" | cut -d' ' -f1)
run_id=${ACTOR_FDB_RECOVERY_RUN_ID:-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:16])')}
receipt=${ACTOR_FDB_RECOVERY_RECEIPT:-/data/actor-qualification/receipts/actor-bj-q01-fdb-expanded-recovery-${run_id}.json}

python3 "$script_dir/recover-expanded-fdb.py" \
	--kubeconfig "${KUBECONFIG:?KUBECONFIG must name the protected q01 kubeconfig}" \
	--source-operation "$source_operation" \
	--source-revision "$source_revision" \
	--source-manifest-sha256 "$source_manifest_sha" \
	--receipt "$receipt"
python3 "$script_dir/verify-expanded-fdb-recovery.py" "$receipt"
