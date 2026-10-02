#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tat_dir=$(CDPATH= cd -- "$script_dir/../tat" && pwd)

usage() {
	cat <<'EOF'
Usage: monitor-bottomless-qualification.sh INVOCATION_ID REMOTE_RECEIPT LOCAL_RECEIPT [PROFILE]

Slowly follows one immutable Tencent TAT qualification invocation, downloads its
receipt after the invocation becomes terminal, and verifies a successful receipt.
q01 receipts are persisted through COS and the cluster evidence cache; other
Cells retain the bounded TAT transport.

Environment:
  TAT_INSTANCE_ID                     Required Tencent builder instance.
  TENCENT_PROFILE                     Optional protected tccli profile.
  TENCENT_REGION                      Defaults to ap-beijing.
  BOTTOMLESS_MONITOR_POLL_SECONDS     Defaults to 300 (five minutes).
EOF
}

if [[ $# -eq 1 && ($1 == -h || $1 == --help) ]]; then
	usage
	exit 0
fi
if (($# < 3 || $# > 4)); then
	usage >&2
	exit 2
fi

invocation_id=$1
remote_receipt=$2
local_receipt=$3
profile=${4:-production}
poll_seconds=${BOTTOMLESS_MONITOR_POLL_SECONDS:-300}

[[ $invocation_id =~ ^inv-[A-Za-z0-9-]+$ ]] || {
	echo "invalid TAT invocation id: $invocation_id" >&2
	exit 2
}
[[ $remote_receipt == /* && -n $local_receipt ]] || {
	echo "receipt paths must include an absolute remote path and a non-empty local path" >&2
	exit 2
}
[[ $profile == production || $profile == production-cell || $profile == e2e-fast ]] || {
	echo "profile must be production, production-cell, or e2e-fast" >&2
	exit 2
}
[[ $poll_seconds =~ ^[0-9]+$ ]] && ((poll_seconds >= 30)) || {
	echo "BOTTOMLESS_MONITOR_POLL_SECONDS must be an integer of at least 30 seconds" >&2
	exit 2
}

export TAT_POLL_SECONDS=$poll_seconds
echo "bottomless-monitor: invocation=$invocation_id poll_seconds=$poll_seconds" >&2

set +e
"$tat_dir/tat-wait.sh" "$invocation_id"
invocation_status=$?
set -e

# A failed waiter may mean an observation/credential error, not a terminal job.
# Confirm the same invocation before attempting to fetch a terminal receipt.
source "$tat_dir/lib-tat.sh"
tat_initialize
filters=$(jq -cn --arg id "$invocation_id" '[{Name:"invocation-id",Values:[$id]}]')
observation=$(tat_tccli tat DescribeInvocationTasks --region "$TENCENT_REGION" --Filters "$filters" --HideOutput True)
task_status=$(printf '%s' "$observation" | jq -er --arg instance "$TAT_INSTANCE_ID" '
  .InvocationTaskSet | select(length == 1) | .[0]
  | select(.InstanceId == $instance) | .TaskStatus')
case "$task_status" in
SUCCESS | FAILED | TIMEOUT | CANCELLED | TERMINATED) ;;
*)
	echo "bottomless-monitor: invocation is not confirmed terminal ($task_status); resume $invocation_id" >&2
	exit 1
	;;
esac
if [[ $task_status != SUCCESS ]]; then
	invocation_status=1
fi

# The qualification harness writes a terminal receipt on both pass and failure. Preserve it before
# returning the invocation failure so the exact failed evidence remains auditable.
download_status=0
if [[ $remote_receipt =~ ^/data/actor-qualification/receipts/actor-bj-q01-[A-Za-z0-9._-]+\.json$ ]]; then
	"$script_dir/../qualification/actor-bj-q01/persist-receipt-from-builder.sh" \
		"$remote_receipt" "$local_receipt" || download_status=$?
else
	"$tat_dir/tat-download.sh" "$remote_receipt" "$local_receipt" || download_status=$?
fi
if ((download_status != 0)); then
	echo "bottomless-monitor: terminal receipt download failed" >&2
	if ((invocation_status != 0)); then
		exit "$invocation_status"
	fi
	exit "$download_status"
fi

sha256sum "$local_receipt"
if ((invocation_status != 0)); then
	echo "bottomless-monitor: qualification failed; receipt preserved at $local_receipt" >&2
	exit "$invocation_status"
fi

python3 "$script_dir/verify_bottomless_receipt.py" --profile "$profile" "$local_receipt"
echo "bottomless-monitor: qualification receipt verified" >&2
