#!/usr/bin/env bash
# Execute a single evidence-bound autonomous operations cycle.
#
# Default behaviour is read-only: collect an audit and emit a machine-readable
# control decision. A mutation is possible only when an explicitly reviewed
# fleet-local action script is supplied and the pre-action decision is allow.
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)

usage() {
	cat <<'USAGE'
Usage:
  run-autonomy-ops-cycle.sh --state-dir DIR [--policy FILE]
      [--action FLEET_LOCAL_SCRIPT [--action-arg VALUE]...]

Run exactly one serialized cycle:
  pre-audit -> policy decision -> optional guarded action -> post-audit -> receipt

Without --action the command is read-only. An action must resolve inside the
fleet directory, is allowed only for control=allow, and runs under the shared
operation lock with the same validated control receipt.
USAGE
}

state_dir=""
policy_file="$script_dir/autonomy-policy.json"
action=""
action_args=()

while (($# > 0)); do
	case "$1" in
	--state-dir)
		[[ $# -ge 2 ]] || { echo "--state-dir requires a value" >&2; exit 2; }
		state_dir=$2; shift 2 ;;
	--policy)
		[[ $# -ge 2 ]] || { echo "--policy requires a value" >&2; exit 2; }
		policy_file=$2; shift 2 ;;
	--action)
		[[ $# -ge 2 ]] || { echo "--action requires a script path" >&2; exit 2; }
		action=$2; shift 2 ;;
	--action-arg)
		[[ $# -ge 2 ]] || { echo "--action-arg requires a value" >&2; exit 2; }
		action_args+=("$2"); shift 2 ;;
	--help|-h)
		usage; exit 0 ;;
	*)
		echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
	esac
done

[[ -n "$state_dir" ]] || { echo "--state-dir is required" >&2; exit 2; }
[[ -f "$policy_file" ]] || { echo "policy file not found: $policy_file" >&2; exit 2; }

if [[ -n "$action" ]]; then
	action=$(python3 - "$fleet_dir" "$action" <<'PY'
import os
import sys

fleet = os.path.realpath(sys.argv[1])
candidate = os.path.realpath(sys.argv[2])
if os.path.commonpath([fleet, candidate]) != fleet:
    raise SystemExit("action must resolve inside the fleet directory")
if not os.path.isfile(candidate) or not os.access(candidate, os.X_OK):
    raise SystemExit("action must be an executable regular file")
print(candidate)
PY
	)
fi

command -v flock >/dev/null 2>&1 || { echo "flock is required" >&2; exit 2; }
mkdir -p "$state_dir"
cycle_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
cycle_dir="$state_dir/cycles/$cycle_id"
mkdir -p "$cycle_dir/audit" "$cycle_dir/decisions"

lock_path=${AUTONOMY_CONTROL_LOCK_PATH:-/data/tmp/actor-autonomy-operations.lock}
mkdir -p "$(dirname -- "$lock_path")"
exec 9>"$lock_path"
if ! flock -n 9; then
	echo "autonomy-ops-cycle: another risky Cell operation is running" >&2
	exit 1
fi

pre_rc=0
set +e
AUTONOMY_AUDIT_RECEIPT_DIR="$cycle_dir/audit" \
"$script_dir/run-autonomy-governance.sh" \
	--receipt-dir "$cycle_dir/audit" \
	--policy "$policy_file" \
	--output-dir "$cycle_dir/decisions" >"$cycle_dir/pre-governance.log" 2>&1
pre_rc=$?
set -e

pre_control=$(find "$cycle_dir/decisions" -maxdepth 1 -type f -name 'autonomy-control-*.json' -print -quit)
[[ -n "$pre_control" && -s "$pre_control" ]] || {
	echo "autonomy-ops-cycle: governance did not create a control receipt" >&2
	exit 2
}
pre_state=$(python3 - "$pre_control" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1])).get("control", "unknown"))
PY
)

action_rc="not_requested"
post_rc="not_run"
post_control=""
post_state="not_run"
if [[ -n "$action" && "$pre_state" == allow ]]; then
	set +e
	AUTONOMY_OPERATION_LOCK_HELD=1 \
	AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
	AUTONOMY_CONTROL_FILE="$pre_control" \
	AUTONOMY_WORKFLOW="autonomy.ops-cycle" \
	"$action" "${action_args[@]}" >"$cycle_dir/action.log" 2>&1
	action_rc=$?
	set -e

	set +e
	AUTONOMY_AUDIT_RECEIPT_DIR="$cycle_dir/audit" \
	"$script_dir/run-autonomy-audit.sh" --once --strict \
		--receipt "$cycle_dir/audit/post-action.json" >"$cycle_dir/post-audit.log" 2>&1
	post_rc=$?
	set -e
	python3 "$script_dir/evaluate-autonomy-receipt.py" \
		"$cycle_dir/audit/post-action.json" --policy "$policy_file" \
		--output "$cycle_dir/decisions/post-action-control.json" --pretty \
		>"$cycle_dir/post-governance.log" 2>&1 || true
	post_control="$cycle_dir/decisions/post-action-control.json"
	if [[ -s "$post_control" ]]; then
		post_state=$(python3 - "$post_control" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1])).get("control", "unknown"))
PY
		)
	else
		post_state="block"
	fi
elif [[ -n "$action" ]]; then
	action_rc="skipped_by_${pre_state}"
fi

cycle_receipt="$cycle_dir/autonomy-ops-cycle.json"
python3 - "$cycle_receipt" "$cycle_id" "$pre_control" "$pre_state" "$pre_rc" \
	"$action" "$action_rc" "$post_control" "$post_state" "$post_rc" "$cycle_dir" <<'PY'
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

(output, cycle_id, pre_control, pre_state, pre_rc, action, action_rc,
 post_control, post_state, post_rc, cycle_dir) = sys.argv[1:]

def digest(path):
    if not path or not os.path.isfile(path):
        return None
    with open(path, "rb") as stream:
        return hashlib.sha256(stream.read()).hexdigest()

payload = {
    "schemaVersion": "actor-fdb-autonomy-ops-cycle-v1",
    "cycleID": cycle_id,
    "timestamp": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "preControl": {"path": pre_control, "sha256": digest(pre_control), "control": pre_state, "exitCode": int(pre_rc)},
    "action": {
        "requested": bool(action),
        "path": action or None,
        "sha256": digest(action) if action else None,
        "exitCode": action_rc,
        "logSha256": digest(os.path.join(cycle_dir, "action.log")),
    },
    "postControl": {"path": post_control or None, "sha256": digest(post_control), "control": post_state, "exitCode": post_rc},
}
with open(output, "w", encoding="utf-8") as stream:
    json.dump(payload, stream, indent=2, sort_keys=True)
    stream.write("\n")
print("autonomy_ops_cycle_receipt=" + output)
print("autonomy_ops_cycle_receipt_sha256=" + digest(output))
PY

echo "autonomy-ops-cycle: receipt=$cycle_receipt"
if [[ -z "$action" ]]; then
	[[ "$pre_state" == allow ]] && exit 0
	[[ "$pre_state" == degrade ]] && exit 1
	exit 2
fi
if [[ "$action_rc" == 0 && "$post_rc" == 0 && "$post_state" == allow ]]; then
	exit 0
fi
exit 2
