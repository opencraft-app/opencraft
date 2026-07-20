#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NAMESPACE="${LLMGATEWAY_K8S_NAMESPACE:-llmgateway-kro-demo}"
FLEET="${LLMGATEWAY_K8S_FLEET:-fleet-demo}"
SET_ID="${LLMGATEWAY_K8S_UPGRADE_SET:-set-a}"
CONTROL_PORT="${LLMGATEWAY_K8S_CONTROL_PORT:-18082}"
TRAFFIC_PORT="${LLMGATEWAY_K8S_TRAFFIC_PORT:-18083}"
MANAGER_JOB="llmgateway-set-manager-upgrade-e2e"

wait_for_job() {
  job_name=$1
  timeout_seconds=$2
  deadline=$(( $(date +%s) + timeout_seconds ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    succeeded=$(kubectl get job "$job_name" -n "$NAMESPACE" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)
    failed=$(kubectl get job "$job_name" -n "$NAMESPACE" -o jsonpath='{.status.failed}' 2>/dev/null || true)
    if [ "${succeeded:-0}" -ge 1 ]; then
      return 0
    fi
    if [ "${failed:-0}" -ge 1 ]; then
      kubectl logs -n "$NAMESPACE" "job/$job_name" --all-containers=true || true
      return 1
    fi
    sleep 2
  done
  kubectl logs -n "$NAMESPACE" "job/$job_name" --all-containers=true || true
  return 1
}

cleanup() {
  kill "${CONTROL_PF_PID:-0}" "${TRAFFIC_PF_PID:-0}" 2>/dev/null || true
  kubectl patch cronjob llmgateway-set-manager -n "$NAMESPACE" --type=merge -p '{"spec":{"suspend":false}}' >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"$SCRIPT_DIR/run.sh"

# 本地镜像标签会被重复构建；显式重启常驻入口，确保 control 与 traffic
# 和本次创建的 set-manager Job 使用同一份 llmgateway:local 代码。
kubectl rollout restart deployment/llmgateway-control deployment/llmgateway-traffic deployment/llmgateway-worker-admin -n "$NAMESPACE" >/dev/null
kubectl rollout status deployment/llmgateway-control -n "$NAMESPACE" --timeout=120s
kubectl rollout status deployment/llmgateway-traffic -n "$NAMESPACE" --timeout=120s
kubectl rollout status deployment/llmgateway-worker-admin -n "$NAMESPACE" --timeout=120s

kubectl patch cronjob llmgateway-set-manager -n "$NAMESPACE" --type=merge -p '{"spec":{"suspend":true}}' >/dev/null
kubectl port-forward -n "$NAMESPACE" service/llmgateway-control "$CONTROL_PORT:18080" >/tmp/llmgateway-control-port-forward.log 2>&1 &
CONTROL_PF_PID=$!
kubectl port-forward -n "$NAMESPACE" service/llmgateway-traffic "$TRAFFIC_PORT:18080" >/tmp/llmgateway-traffic-port-forward.log 2>&1 &
TRAFFIC_PF_PID=$!

for base_url in "http://127.0.0.1:$CONTROL_PORT" "http://127.0.0.1:$TRAFFIC_PORT"; do
  deadline=$(( $(date +%s) + 30 ))
  until curl -fsS "$base_url/readyz" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "port-forward for $base_url did not become ready" >&2
      exit 1
    fi
    sleep 1
  done
done

admin_token=$(kubectl get secret llmgateway-control-admin -n "$NAMESPACE" -o jsonpath='{.data.token}' | base64 -d)
internal_token=$(kubectl get secret llmgateway-control-admin -n "$NAMESPACE" -o jsonpath='{.data.internal-token}' | base64 -d)
target_image=$(kubectl get llmfleet "$FLEET" -n "$NAMESPACE" -o jsonpath='{.spec.newapiImage}')
batch_response=$(curl -fsS -X POST "http://127.0.0.1:$CONTROL_PORT/api/admin/set-upgrades" \
  -H "Authorization: Bearer $admin_token" \
  -H 'Content-Type: application/json' \
  -d "{\"set_ids\":[\"$SET_ID\"],\"target_image\":\"$target_image\",\"source\":\"kro\",\"namespace\":\"$NAMESPACE\",\"fleet\":\"$FLEET\",\"max_parallel\":1,\"stop_on_failure\":true,\"drain_timeout_seconds\":15,\"rollback_window_seconds\":10}")
batch_id=$(printf '%s' "$batch_response" | jq -er '.data.id')
from_generation=$(printf '%s' "$batch_response" | jq -er '.data.runs[0].from_generation')
to_generation=$(printf '%s' "$batch_response" | jq -er '.data.runs[0].to_generation')

kubectl delete job "$MANAGER_JOB" -n "$NAMESPACE" --ignore-not-found >/dev/null
kubectl create job "$MANAGER_JOB" -n "$NAMESPACE" --from=cronjob/llmgateway-set-manager >/dev/null
external_user_id=$(kubectl exec -n "$NAMESPACE" deployment/llmgateway-mysql -- \
  mysql -uroot -p123456 -Nse "SELECT external_user_id FROM llmgateway.llmgateway_user_bindings WHERE set_id='$SET_ID' ORDER BY created_at LIMIT 1" 2>/dev/null)
if [ -z "$external_user_id" ]; then
  echo "no existing user was available for the admin write queue check" >&2
  exit 1
fi

# set-manager 在预检后暂停该 Set 的管理写。窗口内签发密钥必须得到 202，
# 并由独立 admin worker 在 Green 切流后恢复执行。
command_id=""
deadline=$(( $(date +%s) + 180 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  paused=$(kubectl exec -n "$NAMESPACE" deployment/llmgateway-mysql -- \
    mysql -uroot -p123456 -Nse "SELECT admin_writes_paused FROM llmgateway.llmgateway_sets WHERE id='$SET_ID'" 2>/dev/null || true)
  if [ "$paused" = "1" ]; then
    command_response=$(curl -sS -w '\n%{http_code}' -X POST \
      "http://127.0.0.1:$CONTROL_PORT/api/admin/users/$external_user_id/api-keys" \
      -H "Authorization: Bearer $admin_token" -H 'Content-Type: application/json' \
      -d "{\"name\":\"upgrade-e2e-$batch_id\"}")
    command_status=$(printf '%s\n' "$command_response" | tail -n 1)
    command_body=$(printf '%s\n' "$command_response" | sed '$d')
    if [ "$command_status" != "202" ]; then
      printf '%s\n' "$command_body" >&2
      echo "admin write during upgrade returned $command_status, want 202" >&2
      exit 1
    fi
    command_id=$(printf '%s' "$command_body" | jq -er '.data.id')
    break
  fi
  sleep 1
done
if [ -z "$command_id" ]; then
  echo "admin write pause window was not observed" >&2
  exit 1
fi
wait_for_job "$MANAGER_JOB" 360
kubectl logs -n "$NAMESPACE" "job/$MANAGER_JOB"

batch=$(curl -fsS "http://127.0.0.1:$CONTROL_PORT/api/admin/set-upgrades/$batch_id" \
  -H "Authorization: Bearer $admin_token")
status=$(printf '%s' "$batch" | jq -er '.data.status')
if [ "$status" != "completed" ]; then
  printf '%s\n' "$batch" | jq . >&2
  echo "upgrade batch did not complete" >&2
  exit 1
fi

deadline=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  command=$(curl -fsS "http://127.0.0.1:$CONTROL_PORT/api/internal/admin-commands/$command_id" \
    -H "Authorization: Bearer $internal_token")
  command_status=$(printf '%s' "$command" | jq -er '.data.status')
  if [ "$command_status" = "succeeded" ]; then
    break
  fi
  if [ "$command_status" = "unknown" ]; then
    printf '%s\n' "$command" | jq . >&2
    echo "queued admin write outcome became unknown" >&2
    exit 1
  fi
  sleep 1
done
if [ "${command_status:-}" != "succeeded" ]; then
  echo "queued admin write did not finish after cutover" >&2
  exit 1
fi

new_deployment="$FLEET-$SET_ID-g$to_generation-newapi-traffic"
if [ "$from_generation" -eq 0 ]; then
  old_deployment="$FLEET-$SET_ID-newapi-traffic"
else
  old_deployment="$FLEET-$SET_ID-g$from_generation-newapi-traffic"
fi
kubectl rollout status "deployment/$new_deployment" -n "$NAMESPACE" --timeout=180s
if kubectl get "deployment/$old_deployment" -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "old traffic deployment $old_deployment still exists after drain" >&2
  exit 1
fi

route=$(kubectl exec -n "$NAMESPACE" deployment/shared-redis-a -- \
  redis-cli -a 123456 --raw GET "llmgateway:set-runtime:{$SET_ID}" 2>/dev/null)
printf '%s' "$route" | jq -e --arg set "$SET_ID" --argjson generation "$to_generation" \
  '.set_id==$set and .runtime_generation==$generation and .route_revision>=2 and .enabled==true' >/dev/null

external_key=$(kubectl exec -n "$NAMESPACE" deployment/llmgateway-mysql -- \
  mysql -uroot -p123456 -Nse "SELECT external_key FROM llmgateway.llmgateway_api_key_bindings WHERE set_id='$SET_ID' AND external_key<>'' ORDER BY created_at DESC LIMIT 1" 2>/dev/null)
if [ -z "$external_key" ]; then
  echo "no external key was available for upgraded set" >&2
  exit 1
fi

chat_body='{"model":"llmgw-k8s-chat","messages":[{"role":"user","content":"你好"}],"stream":false}'
chat=$(curl -fsS -X POST "http://127.0.0.1:$TRAFFIC_PORT/v1/chat/completions" \
  -H "Authorization: Bearer $external_key" -H 'Content-Type: application/json' -d "$chat_body")
printf '%s' "$chat" | grep -q 'llmgateway k8s e2e'

stream_body='{"model":"llmgw-k8s-chat","messages":[{"role":"user","content":"你好"}],"stream":true}'
stream=$(curl -fsS -N -X POST "http://127.0.0.1:$TRAFFIC_PORT/v1/chat/completions" \
  -H "Authorization: Bearer $external_key" -H 'Content-Type: application/json' -d "$stream_body")
printf '%s' "$stream" | grep -q 'data:'

printf '\nSet database-aware upgrade e2e completed: batch=%s set=%s generation=%s command=%s\n' "$batch_id" "$SET_ID" "$to_generation" "$command_id"
