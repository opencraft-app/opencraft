#!/usr/bin/env sh
set -eu

NAMESPACE="${LLMGATEWAY_PROD_NAMESPACE:-llmgateway}"
SOURCE_SECRET="${LLMGATEWAY_SOURCE_RUNTIME_SECRET:-llmgateway-runtime}"
CONTROL_SECRET="${LLMGATEWAY_CONTROL_RUNTIME_SECRET:-llmgateway-control-runtime}"
WORKER_SECRET="${LLMGATEWAY_WORKER_RUNTIME_SECRET:-llmgateway-worker-runtime}"
TRAFFIC_SECRET="${LLMGATEWAY_TRAFFIC_RUNTIME_SECRET:-llmgateway-traffic-runtime}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

kubectl -n "$NAMESPACE" get secret "$SOURCE_SECRET" -o json > "$TMP_DIR/source.json"

python3 - "$TMP_DIR/source.json" "$TMP_DIR/control.env" "$TMP_DIR/worker.env" "$TMP_DIR/traffic.env" <<'PY'
import base64
import json
import sys

source_path, control_path, worker_path, traffic_path = sys.argv[1:5]
with open(source_path, encoding="utf-8") as handle:
    raw = json.load(handle).get("data", {})

decoded = {}
for key, value in raw.items():
    decoded[key] = base64.b64decode(value).decode("utf-8")

def write_env(path, values):
    with open(path, "w", encoding="utf-8") as handle:
        for key in sorted(values):
            value = values[key].replace("\n", "\\n")
            handle.write(f"{key}={value}\n")

traffic = {
    key: value
    for key, value in decoded.items()
    if key.startswith("LLMGATEWAY_KEY_ROUTE_CACHE_")
}

if "LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL" not in traffic:
    raise SystemExit("source secret is missing LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL")

write_env(control_path, decoded)
write_env(worker_path, decoded)
write_env(traffic_path, traffic)
PY

for item in \
  "$CONTROL_SECRET:$TMP_DIR/control.env" \
  "$WORKER_SECRET:$TMP_DIR/worker.env" \
  "$TRAFFIC_SECRET:$TMP_DIR/traffic.env"; do
  name="${item%%:*}"
  env_file="${item#*:}"
  kubectl -n "$NAMESPACE" create secret generic "$name" \
    --from-env-file="$env_file" \
    --dry-run=client \
    -o yaml | kubectl apply -f -
done

printf 'Runtime secrets migrated in namespace %s: %s, %s, %s\n' "$NAMESPACE" "$CONTROL_SECRET" "$WORKER_SECRET" "$TRAFFIC_SECRET"
