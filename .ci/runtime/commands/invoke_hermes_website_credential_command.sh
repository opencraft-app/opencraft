#!/usr/bin/env bash
# invoke_hermes_website_credential_command.sh
#
# Invokes a parameterized TAT command to deliver a per-instance website
# credential to each Hermes CVM. Each instance gets its own InvokeCommand
# call because TAT applies a single Parameters object to all instances
# in one invocation — and each instance has a unique key.
#
# Input: JSONL file with one object per line:
#   {"cloud_id":"ins-xxx","website_key":"vwk_xxx_yyy"}
#
# Usage:
#   HERMES_TAT_COMMAND_ID=cmd-xxx \
#   HERMES_TAT_REGION=ap-shanghai \
#   HERMES_TAT_API_BASE=https://api.lightvela.com \
#   HERMES_TAT_INPUT_FILE=/tmp/instances.jsonl \
#     bash .ci/runtime/commands/invoke_hermes_website_credential_command.sh
#
# Environment:
#   HERMES_TAT_COMMAND_ID   Required. TAT CommandId.
#   HERMES_TAT_REGION        Default: ap-shanghai.
#   HERMES_TAT_API_BASE      Required. API base URL for the environment.
#   HERMES_TAT_INPUT_FILE    JSONL file. If unset, reads stdin.
#   HERMES_TAT_OUTPUT_DIR    Default: /tmp/hermes-website-credential-results.
#   HERMES_TAT_DRY_RUN       true | false. Default: false.
#   HERMES_TAT_POLL_INTERVAL_SECONDS  Default: 2.
#   HERMES_TAT_POLL_TIMEOUT_SECONDS   Default: 300.

set -euo pipefail

REGION="${HERMES_TAT_REGION:-ap-shanghai}"
COMMAND_ID="${HERMES_TAT_COMMAND_ID:-}"
API_BASE="${HERMES_TAT_API_BASE:-}"
INPUT_FILE="${HERMES_TAT_INPUT_FILE:-}"
OUTPUT_DIR="${HERMES_TAT_OUTPUT_DIR:-${TMPDIR:-/tmp}/hermes-website-credential-results}"
DRY_RUN="${HERMES_TAT_DRY_RUN:-false}"
POLL_INTERVAL="${HERMES_TAT_POLL_INTERVAL_SECONDS:-2}"
POLL_TIMEOUT="${HERMES_TAT_POLL_TIMEOUT_SECONDS:-300}"

umask 077

usage() {
  cat <<'EOF'
Usage:
  HERMES_TAT_COMMAND_ID=cmd-xxx \
  HERMES_TAT_API_BASE=https://api.lightvela.com \
  HERMES_TAT_INPUT_FILE=/tmp/instances.jsonl \
    bash .ci/runtime/commands/invoke_hermes_website_credential_command.sh

Invoke a parameterized TAT command once per instance, each with its own
website_key. Input is JSONL with {"cloud_id","website_key"} per line.

Environment:
  HERMES_TAT_COMMAND_ID
      Required. Tencent Cloud TAT CommandId.
  HERMES_TAT_API_BASE
      Required. API base URL for the target environment.
  HERMES_TAT_REGION
      Default: ap-shanghai.
  HERMES_TAT_INPUT_FILE
      JSONL file. If unset, reads stdin.
  HERMES_TAT_OUTPUT_DIR
      Default: /tmp/hermes-website-credential-results.
  HERMES_TAT_DRY_RUN
      true | false. Default: false.
  HERMES_TAT_POLL_INTERVAL_SECONDS
      Seconds between task-status polls. Default: 2.
  HERMES_TAT_POLL_TIMEOUT_SECONDS
      Maximum seconds to wait for each task. Default: 300.

Credentials:
  tccli reads credentials from its normal environment/config.
  This script does not accept or write any secret keys.
EOF
}

log() {
  printf '[invoke-website-credential] %s\n' "$*" >&2
}

fail() {
  printf '[invoke-website-credential] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || {
  usage
  exit 0
}

[[ -n "$COMMAND_ID" ]] || fail "HERMES_TAT_COMMAND_ID is required"
[[ -n "$API_BASE" ]] || fail "HERMES_TAT_API_BASE is required"
[[ "$POLL_INTERVAL" =~ ^[0-9]+$ ]] || fail "HERMES_TAT_POLL_INTERVAL_SECONDS must be a non-negative integer"
[[ "$POLL_TIMEOUT" =~ ^[0-9]+$ && "$POLL_TIMEOUT" -gt 0 ]] || fail "HERMES_TAT_POLL_TIMEOUT_SECONDS must be a positive integer"

command -v python3 >/dev/null 2>&1 || fail "missing required command: python3"
command -v tccli >/dev/null 2>&1 || fail "missing required command: tccli"

[[ "$OUTPUT_DIR" != "/" && "$OUTPUT_DIR" != "/tmp" ]] || \
  fail "HERMES_TAT_OUTPUT_DIR must be a dedicated directory"
mkdir -p "$OUTPUT_DIR"
chmod 0700 "$OUTPUT_DIR"

STAMP="$(date +%Y%m%d%H%M%S)"
RESULT_JSONL="${OUTPUT_DIR}/website-credential-invoke-${REGION}-${STAMP}.jsonl"
RESULT_JSON="${OUTPUT_DIR}/website-credential-invoke-${REGION}-${STAMP}.json"
SUMMARY_JSON="${OUTPUT_DIR}/website-credential-invoke-${REGION}-${STAMP}.summary.json"

# Read input
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/website-cred-invoke.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

INPUT_JSONL="${WORK_DIR}/input.jsonl"
if [[ -n "$INPUT_FILE" ]]; then
  [[ -r "$INPUT_FILE" ]] || fail "input file is not readable: $INPUT_FILE"
  cp "$INPUT_FILE" "$INPUT_JSONL"
else
  cat >"$INPUT_JSONL"
fi

# Validate JSONL and extract fields
TOTAL="$(python3 - "$INPUT_JSONL" <<'PY'
import json
import re
import sys

count = 0
errors = []
with open(sys.argv[1]) as f:
    for i, line in enumerate(f, 1):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            errors.append(f"line {i}: invalid JSON")
            continue
        if "cloud_id" not in row or "website_key" not in row:
            errors.append(f"line {i}: missing cloud_id or website_key")
            continue
        cloud_id = row["cloud_id"]
        if not isinstance(cloud_id, str) or not re.fullmatch(r"ins-[A-Za-z0-9]+", cloud_id):
            errors.append(f"line {i}: invalid cloud_id")
            continue
        count += 1

if errors:
    for e in errors:
        print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)

print(count)
PY
)" || fail "input JSONL validation failed"

log "region=${REGION} command_id=${COMMAND_ID} instances=${TOTAL} api_base=${API_BASE}"

# Invoke once per instance
PROCESSED=0
FAILED=0
: >"$RESULT_JSONL"

append_result() {
  local cloud_id="$1"
  local invocation_id="$2"
  local task_status="$3"
  local exit_code="$4"
  local error_code="$5"

  python3 - "$cloud_id" "$invocation_id" "$task_status" "$exit_code" "$error_code" >>"$RESULT_JSONL" <<'PY'
import json
import sys

cloud_id, invocation_id, task_status, exit_code, error_code = sys.argv[1:]
row = {
    "cloud_id": cloud_id,
    "instance_id": cloud_id,
    "invocation_id": invocation_id,
    "task_status": task_status,
    "exit_code": int(exit_code) if exit_code.lstrip("-").isdigit() else None,
}
if error_code:
    row["error"] = error_code
print(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
PY
}

while IFS= read -r line; do
  line="$(echo "$line" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -n "$line" ]] || continue

  cloud_id="$(printf '%s' "$line" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cloud_id"])')"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "DRY_RUN: would invoke command=$COMMAND_ID instance=$cloud_id"
    append_result "$cloud_id" "" "DRY_RUN" "" ""
    PROCESSED=$((PROCESSED + 1))
    continue
  fi

  log "invoking instance=${cloud_id} (${PROCESSED}/${TOTAL})"

  invocation_id=""
  invoke_stdout="${WORK_DIR}/invoke-${cloud_id}.stdout"
  invoke_stderr="${WORK_DIR}/invoke-${cloud_id}.stderr"
  invoke_request="${WORK_DIR}/invoke-request-${cloud_id}.json"

  printf '%s' "$line" | python3 -c '
import json
import sys

row = json.load(sys.stdin)
request = {
    "CommandId": sys.argv[2],
    "InstanceIds": [row["cloud_id"]],
    "Parameters": json.dumps(
        {"website_key": row["website_key"], "api_base": sys.argv[3]},
        separators=(",", ":"),
    ),
}
with open(sys.argv[1], "w") as f:
    json.dump(request, f, separators=(",", ":"))
' "$invoke_request" "$COMMAND_ID" "$API_BASE"
  chmod 0600 "$invoke_request"

  invoke_succeeded=false
  if tccli tat InvokeCommand \
    --region "$REGION" \
    --cli-input-json "file://${invoke_request}" \
    >"$invoke_stdout" 2>"$invoke_stderr"; then
    invoke_succeeded=true
  fi
  rm -f "$invoke_request"

  if [[ "$invoke_succeeded" == "true" ]]; then
    invocation_id="$(python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get("Response", {}).get("InvocationId", ""))
except Exception:
    print("")
' <"$invoke_stdout" 2>/dev/null || true)"
  fi

  if [[ -n "$invocation_id" ]]; then
    filters_json="$(python3 -c '
import json, sys
print(json.dumps([{"Name": "invocation-id", "Values": [sys.argv[1]]}], separators=(",", ":")))
' "$invocation_id")"
    deadline=$((SECONDS + POLL_TIMEOUT))
    task_status=""
    exit_code=""
    result_error=""

    while :; do
      describe_stdout="${WORK_DIR}/describe-${cloud_id}.stdout"
      describe_stderr="${WORK_DIR}/describe-${cloud_id}.stderr"
      if tccli tat DescribeInvocationTasks \
        --region "$REGION" \
        --Filters "$filters_json" \
        >"$describe_stdout" 2>"$describe_stderr"; then
        task_record="$(python3 - "$describe_stdout" "$cloud_id" "$invocation_id" <<'PY'
import json
import sys

try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except Exception:
    print("INVALID_RESPONSE")
    raise SystemExit

tasks = data.get("Response", {}).get("InvocationTaskSet", [])
matches = [
    task for task in tasks
    if task.get("InstanceId") == sys.argv[2]
    and task.get("InvocationId") == sys.argv[3]
]
if not matches:
    print("NOT_FOUND")
elif len(matches) != 1:
    print("MULTIPLE")
else:
    task = matches[0]
    status = task.get("TaskStatus", "")
    exit_code = task.get("TaskResult", {}).get("ExitCode", "")
    print(json.dumps({"status": status, "exit_code": exit_code}, separators=(",", ":")))
PY
)"

        case "$task_record" in
          NOT_FOUND)
            ;;
          MULTIPLE)
            task_status="INVALID_TASK_SET"
            result_error="multiple_matching_tasks"
            break
            ;;
          INVALID_RESPONSE)
            task_status="INVALID_RESPONSE"
            result_error="invalid_describe_response"
            break
            ;;
          *)
            task_status="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("status", ""))' "$task_record" 2>/dev/null || true)"
            exit_code="$(python3 -c 'import json,sys; value=json.loads(sys.argv[1]).get("exit_code", ""); print("" if value is None else value)' "$task_record" 2>/dev/null || true)"
            case "$task_status" in
              PENDING|DELIVERING|DELIVER_DELAYED|RUNNING|CANCELLING)
                ;;
              SUCCESS)
                if [[ "$exit_code" == "0" ]]; then
                  result_error=""
                else
                  result_error="task_exit_nonzero"
                fi
                break
                ;;
              DELIVER_FAILED|START_FAILED|FAILED|TIMEOUT|TASK_TIMEOUT|CANCELLED|TERMINATED)
                result_error="task_failed"
                break
                ;;
              *)
                result_error="unknown_task_status"
                break
                ;;
            esac
            ;;
        esac
      fi

      if (( SECONDS >= deadline )); then
        task_status="POLL_TIMEOUT"
        result_error="poll_timeout"
        break
      fi
      (( POLL_INTERVAL > 0 )) && sleep "$POLL_INTERVAL"
    done

    append_result "$cloud_id" "$invocation_id" "$task_status" "$exit_code" "$result_error"
    if [[ "$task_status" == "SUCCESS" && "$exit_code" == "0" ]]; then
      log "SUCCESS: instance=${cloud_id} invocation=${invocation_id}"
    else
      FAILED=$((FAILED + 1))
      log "FAILED: instance=${cloud_id} invocation=${invocation_id} status=${task_status:-UNKNOWN} error=${result_error:-task_status_unavailable}"
    fi
  else
    append_result "$cloud_id" "" "INVOKE_FAILED" "" "invoke_command_failed"
    FAILED=$((FAILED + 1))
    log "FAILED: instance=${cloud_id} error=invoke_command_failed"
  fi

  PROCESSED=$((PROCESSED + 1))
  log "progress=${PROCESSED}/${TOTAL}"

done <"$INPUT_JSONL"

# Generate summary
python3 - "$RESULT_JSONL" "$RESULT_JSON" "$SUMMARY_JSON" <<'PY'
import collections
import json
import sys

result_jsonl, result_json, summary_json = sys.argv[1:4]
results = []
with open(result_jsonl) as f:
    for line in f:
        if line.strip():
            results.append(json.loads(line))

counts = collections.Counter(row.get("task_status") for row in results)
by_error = collections.Counter()
for row in results:
    if row.get("task_status") not in {"SUCCESS", "DRY_RUN"}:
        error = row.get("error") or ""
        key = error.splitlines()[0][:240] if error else "empty error"
        by_error[key] += 1

summary = {
    "total": len(results),
    "counts": dict(counts),
    "failed_error_counts": dict(by_error),
}

with open(result_json, "w") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
with open(summary_json, "w") as f:
    json.dump(summary, f, ensure_ascii=False, indent=2)
print(json.dumps(summary, ensure_ascii=False))
PY

log "result_json=${RESULT_JSON}"
log "summary_json=${SUMMARY_JSON}"
log "done: ${PROCESSED} instances processed, ${FAILED} failed"

(( FAILED == 0 ))
