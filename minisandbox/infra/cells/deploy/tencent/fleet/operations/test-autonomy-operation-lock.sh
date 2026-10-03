#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
wrapper=$script_dir/with-autonomy-operation-lock.sh
temporary=$(mktemp -d /data/tmp/autonomy-operation-lock-test.XXXXXX)
holders=()
detached=()
cleanup() {
	for pid in "${holders[@]}"; do
		kill "$pid" >/dev/null 2>&1 || true
		wait "$pid" >/dev/null 2>&1 || true
	done
	for pid in "${detached[@]}"; do
		kill "$pid" >/dev/null 2>&1 || true
		wait "$pid" >/dev/null 2>&1 || true
	done
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

start_holder() {
	local seconds=$1 marker=$2
	flock "$temporary/lock" bash -c 'touch "$1"; sleep "$2"' _ "$marker" "$seconds" &
	holders+=("$!")
	for _ in {1..100}; do
		[[ -e $marker ]] && return 0
		sleep 0.01
	done
	echo "test lock holder did not start" >&2
	return 1
}

# Existing callers remain fail-closed and non-blocking unless they explicitly
# opt into bounded queueing.
start_holder 2 "$temporary/nonblocking-ready"
set +e
AUTONOMY_CONTROL_LOCK_PATH=$temporary/lock \
	"$wrapper" -- true >"$temporary/nonblocking.out" 2>"$temporary/nonblocking.err"
status=$?
set -e
[[ $status == 1 ]]
grep -Fq 'another risky Cell operation is running; refusing' "$temporary/nonblocking.err"
wait "${holders[-1]}"

# A reviewed release may wait for a short read-only audit. It must acquire the
# real lock before the child runs and must propagate the ownership contract.
start_holder 1 "$temporary/wait-ready"
AUTONOMY_CONTROL_LOCK_PATH=$temporary/lock AUTONOMY_OPERATION_LOCK_WAIT_SECONDS=3 \
	"$wrapper" -- bash -c \
	'test "$AUTONOMY_OPERATION_LOCK_HELD" = 1; test "$AUTONOMY_CONTROL_REQUIRE_LOCK" = 0; printf passed >"$1"' \
	_ "$temporary/result"
[[ $(<"$temporary/result") == passed ]]
wait "${holders[-1]}"

# Queueing remains bounded: a genuinely long mutation is never bypassed.
start_holder 3 "$temporary/timeout-ready"
set +e
AUTONOMY_CONTROL_LOCK_PATH=$temporary/lock AUTONOMY_OPERATION_LOCK_WAIT_SECONDS=1 \
	"$wrapper" -- true >"$temporary/timeout.out" 2>"$temporary/timeout.err"
status=$?
set -e
[[ $status == 75 ]]
grep -Fq 'timed out after 1s' "$temporary/timeout.err"
wait "${holders[-1]}"

set +e
AUTONOMY_CONTROL_LOCK_PATH=$temporary/lock AUTONOMY_OPERATION_LOCK_WAIT_SECONDS=forever \
	"$wrapper" -- true >"$temporary/invalid.out" 2>"$temporary/invalid.err"
status=$?
set -e
[[ $status == 2 ]]
grep -Fq 'must be an integer from 0 through 900' "$temporary/invalid.err"

# A detached grandchild may outlive a hard-killed workflow, but it must not
# inherit the operation-lock descriptor and block the next reconciliation.
AUTONOMY_CONTROL_LOCK_PATH=$temporary/lock "$wrapper" -- bash -c \
	'setsid sleep 30 </dev/null >/dev/null 2>&1 & echo "$!" >"$1"' _ "$temporary/detached.pid"
detached+=("$(<"$temporary/detached.pid")")
kill -0 "${detached[-1]}"
flock -n "$temporary/lock" true

# The ops cycle owns its lock from pre-audit through post-audit. An outer
# supervisor must not also acquire that lock before calling the cycle.
set +e
AUTONOMY_CONTROL_LOCK_PATH=$temporary/lock "$wrapper" -- \
	"$script_dir/run-autonomy-ops-cycle.sh" --state-dir "$temporary/nested-cycle" \
	>"$temporary/nested-cycle.out" 2>"$temporary/nested-cycle.err"
status=$?
set -e
[[ $status == 1 ]]
grep -Fq 'autonomy-ops-cycle: another risky Cell operation is running' "$temporary/nested-cycle.err"
[[ -z $(find "$temporary/nested-cycle" -type f -print -quit) ]]
flock -n "$temporary/lock" true

echo "autonomy operation lock tests passed"
