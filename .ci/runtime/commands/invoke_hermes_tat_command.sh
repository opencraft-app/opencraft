#!/usr/bin/env bash

set -euo pipefail

REGION="${HERMES_TAT_REGION:-ap-shanghai}"
COMMAND_ID="${HERMES_TAT_COMMAND_ID:-}"
INPUT_FILE="${HERMES_TAT_INPUT_FILE:-}"
OUTPUT_DIR="${HERMES_TAT_OUTPUT_DIR:-/tmp}"
BATCH_SIZE="${HERMES_TAT_BATCH_SIZE:-5}"
SINGLE_ATTEMPTS="${HERMES_TAT_SINGLE_ATTEMPTS:-3}"
LIMIT="${HERMES_TAT_LIMIT:-0}"
DRY_RUN="${HERMES_TAT_DRY_RUN:-false}"
SKIP_INVOKED_FILE="${HERMES_TAT_SKIP_INVOKED_FILE:-}"

usage() {
  cat <<'EOF'
Usage:
  HERMES_TAT_COMMAND_ID=cmd-xxx HERMES_TAT_INPUT_FILE=/tmp/vms.jsonl \
    bash .ci/runtime/commands/invoke_hermes_tat_command.sh

Invoke a Tencent Cloud TAT command for Hermes pool CVMs.

The script is intentionally conservative:
  - it invokes at most 5 instances per batch by default;
  - batches run strictly serially, with no parallelism;
  - when a batch fails, each instance in that batch is retried individually;
  - only a failed individual retry is written as INVOKE_FAILED.

Environment:
  HERMES_TAT_COMMAND_ID
      Required. Tencent Cloud TAT CommandId, for example cmd-rwkzyiw0.
  HERMES_TAT_INPUT_FILE
      JSONL file from list_hermes_pool_vms.sh. If unset, reads stdin.
  HERMES_TAT_REGION
      Default: ap-shanghai.
  HERMES_TAT_BATCH_SIZE
      Default: 5.
  HERMES_TAT_SINGLE_ATTEMPTS
      Default: 3.
  HERMES_TAT_OUTPUT_DIR
      Default: /tmp.
  HERMES_TAT_SKIP_INVOKED_FILE
      Optional previous JSONL output path, or comma-separated paths.
      INVOKED cloud_id rows are skipped.
  HERMES_TAT_LIMIT
      Optional positive integer limit for sampling.
  HERMES_TAT_DRY_RUN
      true | false. Default: false.

Credentials:
  tccli reads credentials from its normal environment/config. This script does
  not accept SecretId or SecretKey flags and does not write credentials.
EOF
}

log() {
  printf '[invoke-hermes-tat] %s\n' "$*" >&2
}

fail() {
  printf '[invoke-hermes-tat] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

[[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || {
  usage
  exit 0
}

[[ -n "$COMMAND_ID" ]] || fail "HERMES_TAT_COMMAND_ID is required"
[[ "$BATCH_SIZE" =~ ^[0-9]+$ && "$BATCH_SIZE" -gt 0 ]] || fail "HERMES_TAT_BATCH_SIZE must be a positive integer"
[[ "$SINGLE_ATTEMPTS" =~ ^[0-9]+$ && "$SINGLE_ATTEMPTS" -gt 0 ]] || fail "HERMES_TAT_SINGLE_ATTEMPTS must be a positive integer"
[[ "$LIMIT" =~ ^[0-9]+$ ]] || fail "HERMES_TAT_LIMIT must be a non-negative integer"

require_cmd python3
require_cmd tccli
mkdir -p "$OUTPUT_DIR"

STAMP="$(date +%Y%m%d%H%M%S)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hermes-tat.XXXXXX")"
INPUT_JSONL="$WORK_DIR/input.jsonl"
TARGET_JSONL="$WORK_DIR/targets.jsonl"
SKIP_FILE="$WORK_DIR/skip.json"
RESULT_JSONL="$OUTPUT_DIR/hermes-tat-invoke-${REGION}-${STAMP}.jsonl"
RESULT_JSON="$OUTPUT_DIR/hermes-tat-invoke-${REGION}-${STAMP}.json"
SUMMARY_JSON="$OUTPUT_DIR/hermes-tat-invoke-${REGION}-${STAMP}.summary.json"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

if [[ -n "$INPUT_FILE" ]]; then
  [[ -r "$INPUT_FILE" ]] || fail "input file is not readable: $INPUT_FILE"
  cp "$INPUT_FILE" "$INPUT_JSONL"
else
  cat >"$INPUT_JSONL"
fi

if [[ -n "$SKIP_INVOKED_FILE" ]]; then
  IFS=',' read -r -a SKIP_INVOKED_FILES <<<"$SKIP_INVOKED_FILE"
  for skip_invoked_file in "${SKIP_INVOKED_FILES[@]}"; do
    skip_invoked_file="${skip_invoked_file#"${skip_invoked_file%%[![:space:]]*}"}"
    skip_invoked_file="${skip_invoked_file%"${skip_invoked_file##*[![:space:]]}"}"
    [[ -z "$skip_invoked_file" || -r "$skip_invoked_file" ]] || fail "skip file is not readable: $skip_invoked_file"
  done
fi

TARGET_META="$(python3 - "$INPUT_JSONL" "${SKIP_INVOKED_FILE:-}" "$TARGET_JSONL" "$SKIP_FILE" "$LIMIT" <<'PY'
import json
import sys

input_path, skip_path, target_path, skip_out_path, limit_raw = sys.argv[1:6]
limit = int(limit_raw)
skip = set()

if skip_path:
    for path in [part.strip() for part in skip_path.split(",") if part.strip()]:
        with open(path) as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                if row.get("invoke_status") == "INVOKED" and row.get("cloud_id"):
                    skip.add(row["cloud_id"])

seen = set()
targets = []
with open(input_path) as f:
    for line in f:
        if not line.strip():
            continue
        row = json.loads(line)
        cloud_id = row.get("cloud_id")
        if not cloud_id or cloud_id in seen or cloud_id in skip:
            continue
        seen.add(cloud_id)
        targets.append(row)
        if limit and len(targets) >= limit:
            break

with open(target_path, "w") as f:
    for row in targets:
        f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")

with open(skip_out_path, "w") as f:
    json.dump(sorted(skip), f, ensure_ascii=False)

print(json.dumps({"targets": len(targets), "skipped": len(skip)}, ensure_ascii=False))
PY
)"
log "region=${REGION} command_id=${COMMAND_ID} batch_size=${BATCH_SIZE} single_attempts=${SINGLE_ATTEMPTS} ${TARGET_META}"
log "result_jsonl=${RESULT_JSONL}"

if [[ "$DRY_RUN" == "true" ]]; then
  python3 - "$TARGET_JSONL" "$RESULT_JSONL" "$RESULT_JSON" "$SUMMARY_JSON" <<'PY'
import collections
import json
import sys

target_path, result_jsonl, result_json, summary_json = sys.argv[1:5]
results = []
with open(target_path) as f:
    for line in f:
        if not line.strip():
            continue
        row = json.loads(line)
        row.update({"invoke_status": "DRY_RUN"})
        results.append(row)
with open(result_jsonl, "w") as f:
    for row in results:
        f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
with open(result_json, "w") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
summary = {"total": len(results), "counts": dict(collections.Counter(row["invoke_status"] for row in results))}
with open(summary_json, "w") as f:
    json.dump(summary, f, ensure_ascii=False, indent=2)
print(json.dumps(summary, ensure_ascii=False))
PY
  exit 0
fi

invoke_ids_json() {
  python3 - "$@" <<'PY'
import json
import sys

print(json.dumps(sys.argv[1:], separators=(",", ":")))
PY
}

append_result() {
  local row_json="$1"
  printf '%s\n' "$row_json" >>"$RESULT_JSONL"
}

invoke_batch() {
  local ids_json="$1"
  tccli tat InvokeCommand \
    --region "$REGION" \
    --CommandId "$COMMAND_ID" \
    --InstanceIds "$ids_json"
}

emit_invoked_rows() {
  local invocation_id="$1"
  local mode="$2"
  shift 2
  python3 - "$invocation_id" "$mode" "$@" <<'PY'
import json
import sys

invocation_id, mode = sys.argv[1:3]
for raw in sys.argv[3:]:
    row = json.loads(raw)
    row.update({
        "invoke_status": "INVOKED",
        "invocation_id": invocation_id,
        "invoke_mode": mode,
    })
    print(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
PY
}

emit_failed_row() {
  local row_json="$1"
  local error="$2"
  local attempts="$3"
  python3 - "$row_json" "$error" "$attempts" <<'PY'
import json
import sys

row = json.loads(sys.argv[1])
row.update({
    "invoke_status": "INVOKE_FAILED",
    "error": sys.argv[2],
    "invoke_attempts": int(sys.argv[3]),
    "invoke_mode": "single",
})
print(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
PY
}

parse_invocation_id() {
  python3 -c '
import json
import sys

try:
    data = json.load(sys.stdin)
except Exception as exc:
    raise SystemExit(f"parse failed: {exc}")

invocation_id = data.get("InvocationId")
if not invocation_id:
    raise SystemExit("missing InvocationId")
print(invocation_id)
  '
}

retry_single() {
  local row_json="$1"
  local cloud_id
  cloud_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["cloud_id"])' "$row_json")"

  local attempt stdout stderr status invocation_id ids_json error
  ids_json="$(invoke_ids_json "$cloud_id")"
  for attempt in $(seq 1 "$SINGLE_ATTEMPTS"); do
    stdout="$WORK_DIR/single-${cloud_id}-${attempt}.stdout"
    stderr="$WORK_DIR/single-${cloud_id}-${attempt}.stderr"
    if invoke_batch "$ids_json" >"$stdout" 2>"$stderr"; then
      if invocation_id="$(parse_invocation_id <"$stdout" 2>"$stderr.parse")"; then
        emit_invoked_rows "$invocation_id" "single" "$row_json" | while IFS= read -r line; do
          append_result "$line"
        done
        return 0
      fi
    fi
    error="$(cat "$stderr" "$stderr.parse" 2>/dev/null || true)"
    [[ -n "$error" ]] || error="$(cat "$stdout" 2>/dev/null || true)"
    [[ -n "$error" ]] || error="empty tccli output"
    if [[ "$error" == *"AgentNotInstalled"* || "$error" == *"InvalidInstance"* ]]; then
      break
    fi
    sleep "$attempt"
  done

  append_result "$(emit_failed_row "$row_json" "$error" "$attempt")"
  return 1
}

flush_batch() {
  local -a rows=("$@")
  local -a ids=()
  local row cloud_id ids_json stdout stderr invocation_id error

  [[ "${#rows[@]}" -gt 0 ]] || return 0
  for row in "${rows[@]}"; do
    cloud_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["cloud_id"])' "$row")"
    ids+=("$cloud_id")
  done
  ids_json="$(invoke_ids_json "${ids[@]}")"
  stdout="$WORK_DIR/batch-${ids[0]}.stdout"
  stderr="$WORK_DIR/batch-${ids[0]}.stderr"

  if invoke_batch "$ids_json" >"$stdout" 2>"$stderr" && invocation_id="$(parse_invocation_id <"$stdout" 2>"$stderr.parse")"; then
    emit_invoked_rows "$invocation_id" "batch" "${rows[@]}" | while IFS= read -r line; do
      append_result "$line"
    done
    return 0
  fi

  error="$(cat "$stderr" "$stderr.parse" 2>/dev/null || true)"
  [[ -n "$error" ]] || error="$(cat "$stdout" 2>/dev/null || true)"
  [[ -n "$error" ]] || error="empty tccli output"
  log "batch failed; retrying ${#rows[@]} instances one by one: ${error//$'\n'/ }"

  for row in "${rows[@]}"; do
    retry_single "$row" || true
  done
}

TOTAL="$(wc -l <"$TARGET_JSONL" | tr -d ' ')"
PROCESSED=0
declare -a BATCH_ROWS=()

while IFS= read -r row_json; do
  [[ -n "$row_json" ]] || continue
  BATCH_ROWS+=("$row_json")
  if [[ "${#BATCH_ROWS[@]}" -ge "$BATCH_SIZE" ]]; then
    flush_batch "${BATCH_ROWS[@]}"
    PROCESSED=$((PROCESSED + ${#BATCH_ROWS[@]}))
    log "progress=${PROCESSED}/${TOTAL}"
    BATCH_ROWS=()
  fi
done <"$TARGET_JSONL"

if [[ "${#BATCH_ROWS[@]}" -gt 0 ]]; then
  flush_batch "${BATCH_ROWS[@]}"
  PROCESSED=$((PROCESSED + ${#BATCH_ROWS[@]}))
  log "progress=${PROCESSED}/${TOTAL}"
fi

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

counts = collections.Counter(row.get("invoke_status") for row in results)
by_error = collections.Counter()
for row in results:
    if row.get("invoke_status") != "INVOKED":
        error = row.get("error") or ""
        if "AgentNotInstalled" in error:
            key = "ResourceUnavailable.AgentNotInstalled"
        elif not error:
            key = "empty error"
        else:
            key = error.splitlines()[0][:240]
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
