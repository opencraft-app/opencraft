#!/usr/bin/env bash
set -euo pipefail
umask 077

NAMESPACE=${LLMGATEWAY_REGRESSION_NAMESPACE:-llmgateway}
CONTROL_URL=${LLMGATEWAY_REGRESSION_CONTROL_URL:-https://llmgw-control.lightvela.com}
TRAFFIC_URL=${LLMGATEWAY_REGRESSION_TRAFFIC_URL:-https://llmgw-inner.lightvela.com}
TRAFFIC_KEY=${LLMGATEWAY_REGRESSION_TRAFFIC_KEY:-}
MODEL=${LLMGATEWAY_REGRESSION_MODEL:-auto}
TIMEOUT_SECONDS=${LLMGATEWAY_ROUTE_RECOVERY_TIMEOUT_SECONDS:-600}
PROBE_TIMEOUT_SECONDS=${LLMGATEWAY_ROUTE_RECOVERY_PROBE_TIMEOUT_SECONDS:-90}
CONFIRM=${LLMGATEWAY_ROUTE_RECOVERY_CONFIRM:-}
REDIS_SECRET=${LLMGATEWAY_ROUTE_REDIS_SECRET:-llmgateway-worker-runtime}
REDIS_CLI_IMAGE=${LLMGATEWAY_ROUTE_REDIS_CLI_IMAGE:-redis:7.2-alpine}
POD_NAME="llmgateway-route-redis-flush-$(date -u +%Y%m%dt%H%M%Sz | tr '[:upper:]' '[:lower:]')"
JOB_NAME=rebuild_api_key_routes
JOB_PATH=/api/admin/jobs/rebuild_api_key_routes/run
flushed=false
recovered=false

if [[ "$CONFIRM" != "I_UNDERSTAND_FLUSHDB" ]]; then
  echo "Refusing to clear Route Redis. Set LLMGATEWAY_ROUTE_RECOVERY_CONFIRM=I_UNDERSTAND_FLUSHDB." >&2
  exit 2
fi
if [[ -z "$TRAFFIC_KEY" ]]; then
  echo "LLMGATEWAY_REGRESSION_TRAFFIC_KEY is required and must be an active disposable test key." >&2
  exit 2
fi
if ! [[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "LLMGATEWAY_ROUTE_RECOVERY_TIMEOUT_SECONDS must be a positive integer." >&2
  exit 2
fi
if ! [[ "$PROBE_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "LLMGATEWAY_ROUTE_RECOVERY_PROBE_TIMEOUT_SECONDS must be a positive integer." >&2
  exit 2
fi

admin_token=$(kubectl -n "$NAMESPACE" get secret llmgateway-control-runtime -o jsonpath='{.data.CLUSTER_ADMIN_TOKEN}' | base64 -d)
if [[ -z "$admin_token" ]]; then
  echo "CLUSTER_ADMIN_TOKEN is missing from llmgateway-control-runtime." >&2
  exit 1
fi

queue_rebuild() {
	local attempt status response_file
	response_file=$(mktemp)
	for attempt in $(seq 1 60); do
		status=$(curl -sS -o "$response_file" -w '%{http_code}' -X POST "$CONTROL_URL$JOB_PATH" \
			-H "Authorization: Bearer $admin_token" || true)
		if [[ "$status" == "200" ]]; then
			rm -f "$response_file"
			return 0
		fi
		sleep 2
	done
	rm -f "$response_file"
	return 1
}

cleanup() {
  kubectl -n "$NAMESPACE" delete pod "$POD_NAME" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if [[ "$flushed" == true && "$recovered" != true ]]; then
    queue_rebuild >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

traffic_probe() {
  local output_file=$1
  curl -fsS --max-time "$PROBE_TIMEOUT_SECONDS" "$TRAFFIC_URL/v1/chat/completions" \
    -H "Authorization: Bearer $TRAFFIC_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"route redis recovery gate\"}],\"stream\":false}" \
    >"$output_file"
}

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"; cleanup' EXIT

echo "Preflight: verifying the disposable traffic key and recovery job."
traffic_probe "$tmp_dir/preflight.json"
jobs_json=$(curl -fsS "$CONTROL_URL/api/admin/jobs" -H "Authorization: Bearer $admin_token")
JOBS_JSON="$jobs_json" python3 - "$JOB_NAME" <<'PY'
import json, os, sys
doc = json.loads(os.environ["JOBS_JSON"])
names = {item.get("name") for item in doc.get("data", [])}
if sys.argv[1] not in names:
    raise SystemExit(f"recovery job {sys.argv[1]!r} is not registered")
PY

cat <<EOF | kubectl -n "$NAMESPACE" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $POD_NAME
  labels:
    app: llmgateway-route-redis-recovery-gate
spec:
  restartPolicy: Never
  activeDeadlineSeconds: 120
  containers:
    - name: redis-cli
      image: $REDIS_CLI_IMAGE
      imagePullPolicy: IfNotPresent
      env:
        - name: LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL
          valueFrom:
            secretKeyRef:
              name: $REDIS_SECRET
              key: LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL
      command: ["/bin/sh", "-ec"]
      args:
        - |
          redis-cli --no-auth-warning -u "\$LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL" PING
          redis-cli --no-auth-warning -u "\$LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL" FLUSHDB
EOF

deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  phase=$(kubectl -n "$NAMESPACE" get pod "$POD_NAME" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  if [[ "$phase" == "Succeeded" ]]; then
    flushed=true
    break
  fi
  if [[ "$phase" == "Failed" ]]; then
    kubectl -n "$NAMESPACE" logs "$POD_NAME" >&2 || true
    exit 1
  fi
  sleep 2
done
if [[ "$flushed" != true ]]; then
  echo "Timed out waiting for the Route Redis FLUSHDB pod." >&2
  kubectl -n "$NAMESPACE" describe pod "$POD_NAME" >&2 || true
  exit 1
fi

queued_epoch=$(date -u +%s)
queue_rebuild
echo "Route Redis cleared. Waiting for MySQL-backed route reconstruction."

deadline=$((SECONDS + TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  jobs_json=$(curl -fsS "$CONTROL_URL/api/admin/jobs" -H "Authorization: Bearer $admin_token" || true)
  if JOBS_JSON="$jobs_json" python3 - "$JOB_NAME" "$queued_epoch" <<'PY'
import datetime, json, os, sys
try:
    doc = json.loads(os.environ["JOBS_JSON"])
    job = next(item for item in doc.get("data", []) if item.get("name") == sys.argv[1])
    value = job.get("last_success_at", "")
    success = datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    complete = not job.get("cursor") and job.get("status") == "success" and success >= int(sys.argv[2])
except Exception:
    complete = False
raise SystemExit(0 if complete else 1)
PY
  then
    metrics=$(curl -fsS "$CONTROL_URL/metrics" -H "Authorization: Bearer $admin_token" || true)
    if grep -q '^llmgateway_key_route_rebuild_in_progress 0$' <<<"$metrics" && traffic_probe "$tmp_dir/recovered.json"; then
      recovered=true
      elapsed=$(( $(date -u +%s) - queued_epoch ))
      echo "Route Redis recovery gate passed in ${elapsed}s."
      exit 0
    fi
  fi
  sleep 2
done

echo "Route Redis recovery did not complete within ${TIMEOUT_SECONDS}s." >&2
exit 1
