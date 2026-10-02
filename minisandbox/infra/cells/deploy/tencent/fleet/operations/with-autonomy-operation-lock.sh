#!/usr/bin/env bash
# Run one risky Cell operation while holding the fleet-wide operation lock.
#
# This is deliberately a wrapper rather than an assertion helper: a flock
# acquired by a short-lived assertion process is released before the actual
# rollout/qualification starts.  The file descriptor below survives exec and
# therefore protects the complete child workflow.
set -euo pipefail

usage() {
	cat <<'USAGE'
Usage: with-autonomy-operation-lock.sh -- COMMAND [ARG ...]

Acquire the shared Cell-operation lock and exec COMMAND. The lock remains held
until COMMAND exits.  It is an operational serialization guard, not an access
control boundary.
USAGE
}

[[ $# -ge 2 && $1 == -- ]] || { usage >&2; exit 2; }
shift

lock_path=${AUTONOMY_CONTROL_LOCK_PATH:-/data/tmp/actor-autonomy-operations.lock}
lock_wait_seconds=${AUTONOMY_OPERATION_LOCK_WAIT_SECONDS:-0}
lock_parent=$(dirname -- "$lock_path")
mkdir -p "$lock_parent"

[[ $lock_wait_seconds =~ ^[0-9]+$ ]] && ((10#$lock_wait_seconds <= 900)) || {
	echo "autonomy-operation-lock: AUTONOMY_OPERATION_LOCK_WAIT_SECONDS must be an integer from 0 through 900" >&2
	exit 2
}

command -v flock >/dev/null 2>&1 || {
	echo "autonomy-operation-lock: flock is required" >&2
	exit 2
}

export AUTONOMY_OPERATION_LOCK_HELD=1
export AUTONOMY_CONTROL_REQUIRE_LOCK=0
# Keep the lock in flock's supervisor process and close its descriptor in the
# workflow.  Long-lived kubectl/timeout grandchildren must never retain the
# fleet-wide lock after TAT terminates the owning workflow.
conflict_status=200
set +e
if ((10#$lock_wait_seconds == 0)); then
	flock --close --exclusive --nonblock --conflict-exit-code "$conflict_status" \
		"$lock_path" "$@"
else
	flock --close --exclusive --wait "$lock_wait_seconds" \
		--conflict-exit-code "$conflict_status" "$lock_path" "$@"
fi
status=$?
set -e
if ((status == conflict_status)); then
	if ((10#$lock_wait_seconds == 0)); then
		echo "autonomy-operation-lock: another risky Cell operation is running; refusing: $1" >&2
		exit 1
	fi
	echo "autonomy-operation-lock: timed out after ${lock_wait_seconds}s waiting for another Cell operation: $1" >&2
	exit 75
fi
exit "$status"
