#!/usr/bin/env bash
# Installs the vela-im Hermes plugin on every running instance through CTL, batch by batch. Instances that already
# have the configured package report up_to_date; non-Hermes instances report no_hermes. Safe to rerun.
#
#   CTL_URL=http://ctl-api.ctl.svc.cluster.local CTL_INTERNAL_TOKEN_FILE=/path/to/token \
#     bash vela-im/deploy/backfill-hermes-plugin.sh [start-after-id]
#
# Needs curl and python3. The token is read from a file and never printed.
set -euo pipefail
: "${CTL_URL:?set CTL_URL, e.g. http://ctl-api.ctl.svc.cluster.local}"
: "${CTL_INTERNAL_TOKEN_FILE:?set CTL_INTERNAL_TOKEN_FILE to a file holding CTL_INTERNAL_TOKEN}"
token=$(tr -d '\r\n' < "$CTL_INTERNAL_TOKEN_FILE")
after=${1:-0}
batch=${BATCH:-10}
log=${LOG:-backfill-hermes-plugin.$(date +%Y%m%d%H%M%S).jsonl}

while :; do
  response=$(curl -fsS --max-time 900 -X POST "$CTL_URL/internal/vela-im/plugin:backfill" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "{\"afterId\":$after,\"limit\":$batch}")
  printf '%s\n' "$response" >> "$log"
  read -r after done summary < <(python3 -c '
import json, sys
batch = json.load(sys.stdin)
counts = {}
for result in batch["results"]:
    key = "failed" if result.get("error") else result["status"]
    counts[key] = counts.get(key, 0) + 1
print(batch["nextAfterId"], str(batch["done"]).lower(), " ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "none")
' <<< "$response")
  echo "through id $after: $summary"
  [ "$done" = true ] && break
done
python3 - "$log" <<'PY'
import json, sys
counts, failures = {}, []
for line in open(sys.argv[1]):
    for result in json.loads(line)["results"]:
        key = "failed" if result.get("error") else result["status"]
        counts[key] = counts.get(key, 0) + 1
        if result.get("error"):
            failures.append(f'{result["instanceId"]}: {result["error"][:200]}')
print("total:", " ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "none")
for failure in failures:
    print("  failed", failure)
print("details:", sys.argv[1])
PY
