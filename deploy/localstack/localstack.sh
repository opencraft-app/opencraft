#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCALSTACK_ROOT="$REPO_ROOT/deploy/localstack"
ENV_ROOT="$REPO_ROOT/deploy/envs/localstack"
STATE_DIR="$REPO_ROOT/.localstack"
KUBECTL="${KUBECTL:-kubectl}"
KUSTOMIZE="${KUSTOMIZE:-kustomize}"
DOCKER="${DOCKER:-docker}"
LABEL="app.kubernetes.io/part-of=lightclaw-localstack"

app_components=(
  auth
  payment
  subscription
  ai-gateway
  sandbox
  cloudladdergateway
  shadow
  trade
  ctl
  service-gateway
  frontend
)

namespaces=(
  localstack-system
  user-auth
  ai-gateway
  sandbox
  cloudladdergateway
  shadow
  trade
  ctl
  lightclaw-gateway
  localstack-frontend
)

log() {
  printf '[localstack] %s\n' "$*"
}

die() {
  printf '[localstack] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

current_context() {
  "$KUBECTL" config current-context 2>/dev/null
}

require_local_context() {
  local context
  context="$(current_context)" || die "kubectl has no current context"
  if [[ "${LOCALSTACK_ALLOW_CONTEXT:-}" == "1" ]]; then
    log "using explicitly allowed context: $context"
    return
  fi
  case "$context" in
    orbstack|docker-desktop) ;;
    *)
      die "refusing non-local Kubernetes context '$context'; set LOCALSTACK_ALLOW_CONTEXT=1 only when intentional"
      ;;
  esac
}

doctor() {
  require_command "$KUBECTL"
  require_command "$KUSTOMIZE"
  require_command "$DOCKER"
  require_local_context
  "$KUBECTL" get node >/dev/null
  "$DOCKER" info >/dev/null
  log "context=$(current_context)"
  log "docker=$("$DOCKER" version --format '{{.Server.Arch}}' 2>/dev/null)"
}

render_component() {
  local component="$1"
  "$KUSTOMIZE" build \
    --load-restrictor LoadRestrictionsNone \
    "$LOCALSTACK_ROOT/$component"
}

apply_component() {
  local component="$1"
  log "applying $component"
  render_component "$component" | "$KUBECTL" apply -f -
}

delete_job_if_present() {
  local namespace="$1"
  local name="$2"
  "$KUBECTL" delete job "$name" -n "$namespace" --ignore-not-found --wait=true >/dev/null
}

wait_job() {
  local namespace="$1"
  local name="$2"
  if ! "$KUBECTL" wait -n "$namespace" --for=condition=complete "job/$name" --timeout=300s; then
    "$KUBECTL" logs -n "$namespace" "job/$name" --all-containers=true --tail=200 || true
    die "job failed or timed out: $namespace/$name"
  fi
}

apply_secret_override() {
  local component="$1"
  local namespace secret override
  override="$ENV_ROOT/overrides/$component.env"
  [[ -f "$override" ]] || return 0

  case "$component" in
    infrastructure)
      namespace=localstack-system
      secret=localstack-infra-secrets
      ;;
    auth)
      namespace=user-auth
      secret=lightclaw-auth-secrets
      ;;
    payment)
      namespace=user-auth
      secret=payment-runtime-secrets
      ;;
    subscription)
      namespace=user-auth
      secret=subscription-runtime-secrets
      ;;
    ai-gateway)
      namespace=ai-gateway
      secret=ai-gateway-runtime-secrets
      ;;
    sandbox)
      namespace=sandbox
      secret=sandbox-runtime-secrets
      ;;
    cloudladdergateway)
      namespace=cloudladdergateway
      secret=cloudladdergateway-runtime-secrets
      ;;
    shadow)
      namespace=shadow
      secret=shadow-runtime-secrets
      ;;
    trade)
      namespace=trade
      secret=trade-runtime-secrets
      ;;
    service-gateway)
      namespace=lightclaw-gateway
      secret=service-gateway-runtime-secrets
      ;;
    *)
      die "unknown secret override component: $component"
      ;;
  esac

  log "applying developer-local Secret override for $component"
  "$KUBECTL" create secret generic "$secret" \
    -n "$namespace" \
    --from-env-file="$override" \
    --dry-run=client \
    -o yaml |
    "$KUBECTL" apply -f -
  "$KUBECTL" label secret "$secret" -n "$namespace" "$LABEL" --overwrite >/dev/null
}

prepare_shadow_sdk() {
  local sdk_dir repo ref tracked_ref
  sdk_dir="$REPO_ROOT/shadow/tencentcloud-sdk-go"
  repo="${SHADOW_TENCENT_SDK_REPO:-git@git.woa.com:tencentcloud-internal/tencentcloud-sdk-go.git}"
  tracked_ref="$(
    git -C "$REPO_ROOT" ls-files --stage shadow/tencentcloud-sdk-go |
      awk '$1 == "160000" { print $2; exit }'
  )"
  ref="${SHADOW_TENCENT_SDK_REF:-$tracked_ref}"
  if [[ -f "$sdk_dir/tencentcloud/common/go.mod" ]]; then
    return
  fi
  [[ -n "$ref" ]] || die "cannot resolve the tracked Shadow Tencent SDK revision"
  if [[ -d "$sdk_dir" ]] && [[ -z "$(find "$sdk_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    rmdir "$sdk_dir"
  fi
  [[ ! -e "$sdk_dir" ]] || die "shadow SDK directory exists but is incomplete: $sdk_dir"
  require_command git
  log "preparing Shadow Tencent Cloud SDK dependency at tracked ref $ref"
  git init -q "$sdk_dir"
  git -C "$sdk_dir" remote add origin "$repo"
  git -C "$sdk_dir" fetch -q --depth 1 origin "$ref"
  git -C "$sdk_dir" checkout -q --detach FETCH_HEAD
}

build_image() {
  local component="$1"
  case "$component" in
    auth)
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/lightclaw-auth:dev \
        -f "$LOCALSTACK_ROOT/images/auth.Dockerfile" "$REPO_ROOT"
      ;;
    payment)
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/payment:dev \
        -f "$LOCALSTACK_ROOT/images/payment.Dockerfile" "$REPO_ROOT/payment"
      ;;
    subscription)
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/subscription:dev \
        -f "$LOCALSTACK_ROOT/images/subscription.Dockerfile" "$REPO_ROOT/subscription"
      ;;
    ai-gateway)
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/ai-gateway:dev \
        -f "$LOCALSTACK_ROOT/images/ai-gateway.Dockerfile" "$REPO_ROOT"
      ;;
    sandbox)
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/sandbox-api:dev \
        -f "$LOCALSTACK_ROOT/images/sandbox-api.Dockerfile" "$REPO_ROOT/sandbox"
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/sandbox-migrate:dev \
        -f "$LOCALSTACK_ROOT/images/sandbox-migrate.Dockerfile" "$REPO_ROOT/sandbox"
      ;;
    cloudladdergateway)
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/cloudladdergateway:dev \
        -f "$LOCALSTACK_ROOT/images/cloudladdergateway.Dockerfile" "$REPO_ROOT"
      ;;
    shadow)
      prepare_shadow_sdk
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/shadow:dev \
        -f "$LOCALSTACK_ROOT/images/shadow.Dockerfile" "$REPO_ROOT"
      ;;
    trade)
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/trade:dev \
        -f "$LOCALSTACK_ROOT/images/trade.Dockerfile" "$REPO_ROOT/trade"
      ;;
    ctl)
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/ctl:dev \
        -f "$LOCALSTACK_ROOT/images/ctl.Dockerfile" "$REPO_ROOT/ctl"
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/fake-envd:dev \
        -f "$LOCALSTACK_ROOT/images/fake-envd.Dockerfile" "$REPO_ROOT"
      ;;
    service-gateway)
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/service-gateway:dev \
        -f "$LOCALSTACK_ROOT/images/service-gateway.Dockerfile" "$REPO_ROOT/service-gateway"
      ;;
    mock-control)
      "$DOCKER" build --platform linux/arm64 \
        -t lightclaw-local/mock-control:dev \
        -f "$REPO_ROOT/deploy/local/mockservers/control/Dockerfile" \
        "$REPO_ROOT/deploy/local/mockservers/control"
      ;;
    frontend)
      "$DOCKER" build --platform linux/arm64 \
        --build-arg VITE_AUTH_API_BASE_URL=http://localhost:8085 \
        --build-arg NEXT_PUBLIC_AUTH_API_BASE_URL=http://localhost:8085 \
        --build-arg VITE_REGION=cn \
        --build-arg NEXT_PUBLIC_REGION=cn \
        --build-arg VITE_AEGIS_ENABLED=false \
        -t lightclaw-local/frontend:dev \
        -f "$LOCALSTACK_ROOT/images/frontend.Dockerfile" "$REPO_ROOT"
      ;;
    all)
      local item
      for item in "${app_components[@]}"; do
        build_image "$item"
      done
      build_image mock-control
      ;;
    *)
      die "unknown build component: $component"
      ;;
  esac
}

stop_legacy_compose() {
  if "$DOCKER" ps --format '{{.Names}}' | grep -q '^lightclaw-local-'; then
    log "stopping the legacy Compose stack before binding local ports"
    "$DOCKER" compose -f "$REPO_ROOT/deploy/local/docker-compose.yml" down
  fi
}

exposure_specs=(
  "frontend|localstack-frontend|service/frontend|5173:8080"
  "gateway|lightclaw-gateway|service/service-gateway|8085:80"
  "auth|user-auth|service/lightclaw-auth|28081:80"
  "payment|user-auth|service/payment|18082:80"
  "subscription|user-auth|service/subscription|8086:80"
  "ai-gateway|ai-gateway|service/gateway|18080:80"
  "sandbox|sandbox|service/sandbox-api|18081:80"
  "cloudladdergateway|cloudladdergateway|service/cloudladdergateway|18095:8095"
  "shadow|shadow|service/shadow|18083:80"
  "trade|trade|service/trade|18084:80"
  "ctl|ctl|service/ctl-api|19590:80"
  "fake-qq|localstack-system|service/fake-qq-oauth|19010:19010"
  "fake-jifei|localstack-system|service/fake-jifei|19020:19020"
  "fake-tencentcloud|localstack-system|service/fake-tencentcloud|19030:19030"
  "fake-wechat-pay|localstack-system|service/fake-wechat-pay-bridge|19040:19040"
  "mysql|localstack-system|service/mysql|43306:3306"
  "redis|localstack-system|service/redis|36379:6379"
)

launchd_domain() {
  printf 'gui/%s\n' "$(id -u)"
}

stop_exposure() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  local spec name label
  for spec in "${exposure_specs[@]}"; do
    IFS='|' read -r name _ _ _ <<<"$spec"
    label="com.lightclaw.localstack.$name"
    launchctl bootout "$(launchd_domain)/$label" >/dev/null 2>&1 || true
  done
  rm -rf "$STATE_DIR/launchd"
}

start_exposure() {
  [[ "$(uname -s)" == "Darwin" ]] || die "automatic localhost exposure currently requires macOS launchd"
  require_command launchctl
  local kubectl_path context domain spec name namespace resource mapping label plist log_file
  kubectl_path="$(command -v "$KUBECTL")"
  context="$(current_context)"
  domain="$(launchd_domain)"
  mkdir -p "$STATE_DIR/launchd" "$STATE_DIR/logs"
  stop_exposure
  mkdir -p "$STATE_DIR/launchd" "$STATE_DIR/logs"

  for spec in "${exposure_specs[@]}"; do
    IFS='|' read -r name namespace resource mapping <<<"$spec"
    label="com.lightclaw.localstack.$name"
    plist="$STATE_DIR/launchd/$label.plist"
    log_file="$STATE_DIR/logs/$name.log"
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$kubectl_path</string>
    <string>--context</string>
    <string>$context</string>
    <string>port-forward</string>
    <string>-n</string>
    <string>$namespace</string>
    <string>--address</string>
    <string>127.0.0.1</string>
    <string>$resource</string>
    <string>$mapping</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>2</integer>
  <key>StandardOutPath</key>
  <string>$log_file</string>
  <key>StandardErrorPath</key>
  <string>$log_file</string>
</dict>
</plist>
EOF
    launchctl bootstrap "$domain" "$plist"
  done

  sleep 1
  log "localhost exposure is managed by macOS launchd"
}

wait_rollouts() {
  "$KUBECTL" rollout status -n localstack-system deployment/mock-control --timeout=180s
  "$KUBECTL" rollout status -n localstack-system deployment/fake-qq-oauth --timeout=180s
  "$KUBECTL" rollout status -n localstack-system deployment/fake-jifei --timeout=180s
  "$KUBECTL" rollout status -n localstack-system deployment/fake-tencentcloud --timeout=180s
  "$KUBECTL" rollout status -n localstack-system deployment/fake-wechat-pay-bridge --timeout=180s
  "$KUBECTL" rollout status -n localstack-system deployment/fake-envd --timeout=180s
  "$KUBECTL" rollout status -n user-auth deployment/lightclaw-auth --timeout=300s
  "$KUBECTL" rollout status -n user-auth deployment/payment --timeout=300s
  "$KUBECTL" rollout status -n user-auth deployment/subscription --timeout=300s
  "$KUBECTL" rollout status -n ai-gateway deployment/gateway-backend --timeout=300s
  "$KUBECTL" rollout status -n sandbox deployment/sandbox-api --timeout=300s
  "$KUBECTL" rollout status -n cloudladdergateway deployment/cloudladdergateway --timeout=300s
  "$KUBECTL" rollout status -n shadow deployment/shadow --timeout=300s
  "$KUBECTL" rollout status -n shadow deployment/shadow-trade-adapter --timeout=300s
  "$KUBECTL" rollout status -n trade deployment/trade --timeout=300s
  "$KUBECTL" rollout status -n ctl deployment/ctl-api --timeout=300s
  "$KUBECTL" rollout status -n ctl deployment/ctl-service --timeout=300s
  "$KUBECTL" rollout status -n ctl deployment/ctl-bypass --timeout=300s
  "$KUBECTL" rollout status -n lightclaw-gateway deployment/service-gateway --timeout=300s
  "$KUBECTL" rollout status -n localstack-frontend deployment/frontend --timeout=300s
}

restart_app_deployments() {
  log "restarting deployments to load fixed-name ConfigMaps and Secrets"
  "$KUBECTL" rollout restart -n localstack-system deployment/mock-control deployment/fake-qq-oauth deployment/fake-jifei deployment/fake-tencentcloud deployment/fake-wechat-pay-bridge deployment/fake-envd
  "$KUBECTL" rollout restart -n user-auth deployment/lightclaw-auth deployment/payment deployment/subscription
  "$KUBECTL" rollout restart -n ai-gateway deployment/gateway-backend
  "$KUBECTL" rollout restart -n sandbox deployment/sandbox-api
  "$KUBECTL" rollout restart -n cloudladdergateway deployment/cloudladdergateway
  "$KUBECTL" rollout restart -n shadow deployment/shadow deployment/shadow-trade-adapter
  "$KUBECTL" rollout restart -n trade deployment/trade
  "$KUBECTL" rollout restart -n ctl deployment/ctl-api deployment/ctl-service deployment/ctl-bypass
  "$KUBECTL" rollout restart -n lightclaw-gateway deployment/service-gateway
  "$KUBECTL" rollout restart -n localstack-frontend deployment/frontend
}

up() {
  doctor
  if [[ "${LOCALSTACK_SKIP_BUILD:-}" != "1" ]]; then
    build_image all
  else
    log "skipping image build because LOCALSTACK_SKIP_BUILD=1"
  fi

  stop_legacy_compose
  delete_job_if_present localstack-system localstack-databases
  apply_component infrastructure
  apply_secret_override infrastructure
  "$KUBECTL" rollout status -n localstack-system statefulset/mysql --timeout=300s
  "$KUBECTL" rollout status -n localstack-system deployment/redis --timeout=180s
  "$KUBECTL" rollout status -n localstack-system deployment/mock-control --timeout=180s
  "$KUBECTL" rollout status -n localstack-system deployment/fake-qq-oauth --timeout=180s
  "$KUBECTL" rollout status -n localstack-system deployment/fake-jifei --timeout=180s
  "$KUBECTL" rollout status -n localstack-system deployment/fake-tencentcloud --timeout=180s
  "$KUBECTL" rollout status -n localstack-system deployment/fake-wechat-pay-bridge --timeout=180s
  "$KUBECTL" rollout status -n localstack-system deployment/fake-envd --timeout=180s
  wait_job localstack-system localstack-databases

  local component
  for component in "${app_components[@]}"; do
    if [[ "$component" == "ctl" ]]; then
      delete_job_if_present ctl ctl-migrate
    fi
    apply_component "$component"
    case "$component" in
      frontend|ctl) ;;
      *) apply_secret_override "$component" ;;
    esac
  done

  wait_job ctl ctl-migrate

  delete_job_if_present user-auth lightclaw-auth-migrate
  delete_job_if_present user-auth payment-migrate
  delete_job_if_present user-auth subscription-migrate
  delete_job_if_present ai-gateway ai-gateway-migrate
  delete_job_if_present sandbox sandbox-migrate
  delete_job_if_present trade trade-migrate
  apply_component migrations
  wait_job user-auth lightclaw-auth-migrate
  wait_job user-auth payment-migrate
  wait_job user-auth subscription-migrate
  wait_job ai-gateway ai-gateway-migrate
  wait_job sandbox sandbox-migrate
  wait_job trade trade-migrate

  delete_job_if_present localstack-system localstack-seed
  apply_component seed
  wait_job localstack-system localstack-seed

  restart_app_deployments
  wait_rollouts
  start_exposure
  log "frontend=http://localhost:5173 gateway=http://localhost:8085 ctl=http://localhost:19590 clgateway=http://localhost:18095 shadow=http://localhost:18083 trade=http://localhost:18084"
  status
}

status() {
  require_local_context
  "$KUBECTL" get pods -A -l "$LABEL" -o wide
}

logs() {
  require_local_context
  "$KUBECTL" logs -A -l "$LABEL" --all-containers=true --prefix=true --tail=200 -f
}

down() {
  require_local_context
  stop_exposure
  local namespace
  for namespace in "${namespaces[@]}"; do
    "$KUBECTL" delete \
      deployment,statefulset,service,configmap,secret,job,horizontalpodautoscaler \
      -n "$namespace" -l "$LABEL" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
  log "workloads removed; PVC data is preserved"
}

wait_for_namespaces_deleted() {
  local deadline=$((SECONDS + 180))
  local namespace
  local remaining

  while true; do
    remaining=()
    for namespace in "${namespaces[@]}"; do
      if "$KUBECTL" get namespace "$namespace" >/dev/null 2>&1; then
        remaining+=("$namespace")
      fi
    done

    if [[ ${#remaining[@]} -eq 0 ]]; then
      return
    fi
    if ((SECONDS >= deadline)); then
      die "timed out waiting for namespaces to be deleted: ${remaining[*]}"
    fi
    sleep 1
  done
}

reset() {
  down
  "$KUBECTL" delete pvc -n localstack-system -l "$LABEL" --ignore-not-found --wait=true
  "$KUBECTL" delete namespace "${namespaces[@]}" --ignore-not-found --wait=false
  wait_for_namespaces_deleted
  log "workloads, namespaces, and local data removed"
}

render_all() {
  local component
  for component in infrastructure "${app_components[@]}" migrations seed; do
    printf '# component: %s\n' "$component"
    render_component "$component"
    printf '\n---\n'
  done
}

usage() {
  cat <<'EOF'
Usage: deploy/localstack/localstack.sh <command> [component]

Commands:
  doctor             Validate local Docker and Kubernetes prerequisites
  build [component]  Build all images or one component
  render             Render all localstack Kustomize components
  up                 Build, apply, migrate, seed, and wait
  expose             Recreate launchd-managed localhost endpoints
  stop-expose        Stop launchd-managed localhost endpoints
  status             Show localstack Pods
  logs               Follow logs from localstack Pods
  down               Remove workloads while preserving PVC data
  reset              Remove workloads, namespaces, and PVC data
EOF
}

command="${1:-}"
case "$command" in
  doctor) doctor ;;
  build) doctor; build_image "${2:-all}" ;;
  render) render_all ;;
  up) up ;;
  expose) require_local_context; start_exposure ;;
  stop-expose) stop_exposure ;;
  status) status ;;
  logs) logs ;;
  down) down ;;
  reset) reset ;;
  *) usage; [[ -z "$command" ]] || exit 1 ;;
esac
