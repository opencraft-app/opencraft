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
#   HERMES_TAT_OUTPUT_DIR    Default: /tmp.
#   HERMES_TAT_DRY_RUN       true | false. Default: false.

set -euo pipefail

REGION="${HERMES_TAT_REGION:-ap-shanghai}"
COMMAND_ID="${HERMES_TAT_COMMAND_ID:-}"
API_BASE="${HERMES_TAT_API_BASE:-}"
INPUT_FILE="${HERMES_TAT_INPUT_FILE:-}"
OUTPUT_DIR="${HERMES_TAT_OUTPUT_DIR:-/tmp}"
DRY_RUN="${HERMES_TAT_DRY_RUN:-false}"

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
      Default: /tmp.
  HERMES_TAT_DRY_RUN
      true | false. Default: false.

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

command -v python3 >/dev/null 2>&1 || fail "missing required command: python3"
command -v tccli >/dev/null 2>&1 || fail "missing required command: tccli"

mkdir -p "$OUTPUT_DIR"

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
: >"$RESULT_JSONL"

while IFS= read -r line; do
  line="$(echo "$line" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -n "$line" ]] || continue

  cloud_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["cloud_id"])' "$line")"
  website_key="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["website_key"])' "$line")"

  # Build parameters JSON: website_key (hidden param) + api_base
  params_json="$(python3 -c '
import json, sys
params = {"website_key": sys.argv[1], "api_base": sys.argv[2]}
print(json.dumps(params, separators=(",", ":")))
' "$website_key" "$API_BASE")"

  # Build instance IDs JSON array
  instance_ids_json="$(python3 -c '
import json, sys
print(json.dumps([sys.argv[1]]))
' "$cloud_id")"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "DRY_RUN: would invoke command=$COMMAND_ID instance=$cloud_id"
    python3 -c '
import json, sys
row = json.loads(sys.argv[1])
row.update({"invoke_status": "DRY_RUN", "instance_id": row["cloud_id"]})
print(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
' "$line" >>"$RESULT_JSONL"
    PROCESSED=$((PROCESSED + 1))
    continue
  fi

  log "invoking instance=${cloud_id} (${PROCESSED}/${TOTAL})"

  invocation_id=""
  invoke_error=""
  invoke_stdout="${WORK_DIR}/invoke-${cloud_id}.stdout"
  invoke_stderr="${WORK_DIR}/invoke-${cloud_id}.stderr"

  if tccli tat InvokeCommand \
    --region "$REGION" \
    --CommandId "$COMMAND_ID" \
    --InstanceIds "$instance_ids_json" \
    --Parameters "$params_json" \
    >"$invoke_stdout" 2>"$invoke_stderr"; then
    invocation_id="$(python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get("InvocationId", ""))
except Exception:
    print("")
' <"$invoke_stdout" 2>/dev/null || true)"
  fi

  if [[ -n "$invocation_id" ]]; then
    python3 -c '
import json, sys
row = json.loads(sys.argv[1])
row.update({
    "invoke_status": "INVOKED",
    "invocation_id": sys.argv[2],
    "instance_id": row["cloud_id"],
})
print(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
' "$line" "$invocation_id" >>"$RESULT_JSONL"
  else
    invoke_error="$(cat "$invoke_stderr" 2>/dev/null || true)"
    [[ -n "$invoke_error" ]] || invoke_error="$(cat "$invoke_stdout" 2>/dev/null || true)"
    [[ -n "$invoke_error" ]] || invoke_error="empty tccli output"
    python3 -c '
import json, sys
row = json.loads(sys.argv[1])
row.update({
    "invoke_status": "INVOKE_FAILED",
    "error": sys.argv[2][:500],
    "instance_id": row["cloud_id"],
})
print(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
' "$line" "$invoke_error" >>"$RESULT_JSONL"
    log "FAILED: instance=${cloud_id} error=${invoke_error}"
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

counts = collections.Counter(row.get("invoke_status") for row in results)
by_error = collections.Counter()
for row in results:
    if row.get("invoke_status") != "INVOKED":
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
log "done: ${PROCESSED} instances processed"
