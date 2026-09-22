#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCALSTACK_ROOT="$REPO_ROOT/deploy/localstack"
ENV_ROOT="$REPO_ROOT/deploy/envs/localstack"
SECRET_OVERRIDE_ROOTS="${LOCALSTACK_SECRET_OVERRIDE_DIRS:-${LOCALSTACK_SECRET_OVERRIDE_DIR:-$ENV_ROOT/overrides}}"
STATE_DIR="${LOCALSTACK_STATE_DIR:-$REPO_ROOT/.localstack}"
SITE_SEED_ROOT="$LOCALSTACK_ROOT/seed-data"
KUBECTL="${KUBECTL:-kubectl}"
KUSTOMIZE="${KUSTOMIZE:-kustomize}"
DOCKER="${DOCKER:-docker}"
LABEL="app.kubernetes.io/part-of=lightclaw-localstack"
LOCALSTACK_SITE_KIND="${LOCALSTACK_SITE_KIND:-cn}"
LOCALSTACK_PUBLIC_HOST="${LOCALSTACK_PUBLIC_HOST:-localhost}"
LOCALSTACK_PUBLIC_PROTOCOL="${LOCALSTACK_PUBLIC_PROTOCOL:-http}"

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

localstack_images=(
  lightclaw-local/lightclaw-auth:dev
  lightclaw-local/payment:dev
  lightclaw-local/subscription:dev
  lightclaw-local/ai-gateway:dev
  lightclaw-local/sandbox-api:dev
  lightclaw-local/sandbox-migrate:dev
  lightclaw-local/cloudladdergateway:dev
  lightclaw-local/shadow:dev
  lightclaw-local/trade:dev
  lightclaw-local/ctl:dev
  lightclaw-local/fake-envd:dev
  lightclaw-local/service-gateway:dev
  lightclaw-local/mock-control:dev
  lightclaw-local/frontend:dev
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

case "$LOCALSTACK_SITE_KIND" in
  cn | intl) ;;
  *) die "LOCALSTACK_SITE_KIND must be cn or intl" ;;
esac

if [[ "$LOCALSTACK_PUBLIC_HOST" == "localhost" || "$LOCALSTACK_PUBLIC_HOST" == "127.0.0.1" ]]; then
  PUBLIC_BIND_ADDRESS="127.0.0.1"
else
  PUBLIC_BIND_ADDRESS="0.0.0.0"
fi

FRONTEND_URL="$LOCALSTACK_PUBLIC_PROTOCOL://$LOCALSTACK_PUBLIC_HOST:5173"
GATEWAY_URL="$LOCALSTACK_PUBLIC_PROTOCOL://$LOCALSTACK_PUBLIC_HOST:8085"
FAKE_QQ_URL="$LOCALSTACK_PUBLIC_PROTOCOL://$LOCALSTACK_PUBLIC_HOST:19010"
FAKE_WECHAT_PAY_URL="$LOCALSTACK_PUBLIC_PROTOCOL://$LOCALSTACK_PUBLIC_HOST:19040"

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# 镜像构建平台按宿主机架构推导，而不是写死 arm64。
#
# 这里原来是 16 处硬编码 linux/arm64，只照顾了 Apple Silicon 本机。个人测试环境实际都搭在
# DevCloud（Linux x86_64）上，写死 arm64 会让每个镜像都走 QEMU 模拟构建甚至直接失败。
# 需要交叉构建时用 LOCALSTACK_PLATFORM 显式覆盖。
detect_platform() {
  case "$(uname -m)" in
    arm64 | aarch64) printf 'linux/arm64\n' ;;
    x86_64 | amd64) printf 'linux/amd64\n' ;;
    *) die "unsupported host architecture '$(uname -m)'; set LOCALSTACK_PLATFORM explicitly" ;;
  esac
}

PLATFORM="${LOCALSTACK_PLATFORM:-$(detect_platform)}"

current_context() {
  "$KUBECTL" config current-context 2>/dev/null
}

# 判断当前 context 的 API server 是不是回环地址。
#
# k3s 和 kind 生成的 context 名分别是 `default` 和 `kind-<name>`，光看名字没法跟共享集群区分
# （尤其 `default` 太泛）。看 server 是否指向 127.0.0.1 才是真正可靠的「这是我自己机器上的集群」证据。
local_apiserver() {
  local context server
  context="$1"
  server="$("$KUBECTL" config view -o "jsonpath={.clusters[?(@.name=='$context')].cluster.server}" 2>/dev/null)"
  if [[ -z "$server" ]]; then
    # context 名与 cluster 名不一定相同，退回按 context 解析 cluster 名再查一次。
    local cluster
    cluster="$("$KUBECTL" config view -o "jsonpath={.contexts[?(@.name=='$context')].context.cluster}" 2>/dev/null)"
    [[ -n "$cluster" ]] || return 1
    server="$("$KUBECTL" config view -o "jsonpath={.clusters[?(@.name=='$cluster')].cluster.server}" 2>/dev/null)"
  fi
  case "$server" in
    https://127.0.0.1:* | http://127.0.0.1:* | https://localhost:* | http://localhost:* | "https://[::1]:"* | "http://[::1]:"*) return 0 ;;
    *) return 1 ;;
  esac
}

require_local_context() {
  local context
  context="$(current_context)" || die "kubectl has no current context"
  if [[ "${LOCALSTACK_ALLOW_CONTEXT:-}" == "1" ]]; then
    log "using explicitly allowed context: $context"
    return
  fi
  case "$context" in
    # DevCloud 上常用 k3s / minikube / kind 起本地单机集群，它们和 orbstack 一样是「自己机器上的
    # 一次性集群」，不该被守卫拦住。真正要拦的是误指到共享测试或生产集群。
    orbstack | docker-desktop | minikube | kind-* | k3d-*) ;;
    *)
      local_apiserver "$context" ||
        die "refusing non-local Kubernetes context '$context'; set LOCALSTACK_ALLOW_CONTEXT=1 only when intentional"
      log "allowing context '$context' because its API server is loopback"
      ;;
  esac
}

doctor() {
  require_command "$KUBECTL"
  require_command "$KUSTOMIZE"
  require_command "$DOCKER"
  require_command python3
  require_local_context
  "$KUBECTL" get node >/dev/null
  "$DOCKER" info >/dev/null
  log "context=$(current_context)"
  log "docker=$("$DOCKER" version --format '{{.Server.Arch}}' 2>/dev/null)"
  log "build platform=$PLATFORM"
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
  local namespace secret override override_root

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

  while IFS= read -r override_root; do
    [[ -n "$override_root" ]] || continue
    override="$override_root/$component.env"
    [[ -f "$override" ]] || continue
    log "applying developer-local Secret override for $component from $override_root"
    "$KUBECTL" create secret generic "$secret" \
      -n "$namespace" \
      --from-env-file="$override" \
      --dry-run=client \
      -o yaml |
      "$KUBECTL" apply -f -
    "$KUBECTL" label secret "$secret" -n "$namespace" "$LABEL" --overwrite >/dev/null
  done < <(printf '%s' "$SECRET_OVERRIDE_ROOTS" | tr ':' '\n')
}

shadow_sdk_repository() {
  local parent_remote=""
  if [[ -n "${SHADOW_TENCENT_SDK_REPO:-}" ]]; then
    printf '%s\n' "$SHADOW_TENCENT_SDK_REPO"
    return 0
  fi
  parent_remote="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  case "$parent_remote" in
    https://git.woa.com/* | http://git.woa.com/*)
      printf 'https://git.woa.com/tencentcloud-internal/tencentcloud-sdk-go.git\n'
      ;;
    *)
      printf 'git@git.woa.com:tencentcloud-internal/tencentcloud-sdk-go.git\n'
      ;;
  esac
}

prepare_shadow_sdk() {
  local sdk_dir repo ref tracked_ref
  sdk_dir="$REPO_ROOT/shadow/tencentcloud-sdk-go"
  repo="$(shadow_sdk_repository)"
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
  require_command git
  if [[ -e "$sdk_dir" ]]; then
    git -C "$sdk_dir" rev-parse --git-dir >/dev/null 2>&1 \
      || die "shadow SDK directory exists but is incomplete: $sdk_dir"
    log "repairing incomplete Shadow Tencent Cloud SDK checkout at tracked ref $ref"
  else
    log "preparing Shadow Tencent Cloud SDK dependency at tracked ref $ref"
    git init -q "$sdk_dir"
  fi
  if git -C "$sdk_dir" remote get-url origin >/dev/null 2>&1; then
    git -C "$sdk_dir" remote set-url origin "$repo"
  else
    git -C "$sdk_dir" remote add origin "$repo"
  fi
  git -C "$sdk_dir" fetch -q --depth 1 origin "$ref"
  git -C "$sdk_dir" checkout -q --detach FETCH_HEAD
  [[ -f "$sdk_dir/tencentcloud/common/go.mod" ]] \
    || die "Shadow Tencent Cloud SDK checkout is incomplete after fetch: $sdk_dir"
}

build_image() {
  local component="$1"
  case "$component" in
    auth)
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/lightclaw-auth:dev \
        -f "$LOCALSTACK_ROOT/images/auth.Dockerfile" "$REPO_ROOT"
      ;;
    payment)
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/payment:dev \
        -f "$LOCALSTACK_ROOT/images/payment.Dockerfile" "$REPO_ROOT/payment"
      ;;
    subscription)
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/subscription:dev \
        -f "$LOCALSTACK_ROOT/images/subscription.Dockerfile" "$REPO_ROOT/subscription"
      ;;
    ai-gateway)
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/ai-gateway:dev \
        -f "$LOCALSTACK_ROOT/images/ai-gateway.Dockerfile" "$REPO_ROOT"
      ;;
    sandbox)
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/sandbox-api:dev \
        -f "$LOCALSTACK_ROOT/images/sandbox-api.Dockerfile" "$REPO_ROOT/sandbox"
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/sandbox-migrate:dev \
        -f "$LOCALSTACK_ROOT/images/sandbox-migrate.Dockerfile" "$REPO_ROOT/sandbox"
      ;;
    cloudladdergateway)
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/cloudladdergateway:dev \
        -f "$LOCALSTACK_ROOT/images/cloudladdergateway.Dockerfile" "$REPO_ROOT"
      ;;
    shadow)
      prepare_shadow_sdk
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/shadow:dev \
        -f "$LOCALSTACK_ROOT/images/shadow.Dockerfile" "$REPO_ROOT"
      ;;
    trade)
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/trade:dev \
        -f "$LOCALSTACK_ROOT/images/trade.Dockerfile" "$REPO_ROOT/trade"
      ;;
    ctl)
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/ctl:dev \
        -f "$LOCALSTACK_ROOT/images/ctl.Dockerfile" "$REPO_ROOT/ctl"
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/fake-envd:dev \
        -f "$LOCALSTACK_ROOT/images/fake-envd.Dockerfile" "$REPO_ROOT"
      ;;
    service-gateway)
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/service-gateway:dev \
        -f "$LOCALSTACK_ROOT/images/service-gateway.Dockerfile" "$REPO_ROOT/service-gateway"
      ;;
    mock-control)
      "$DOCKER" build --platform "$PLATFORM" \
        -t lightclaw-local/mock-control:dev \
        -f "$REPO_ROOT/deploy/local/mockservers/control/Dockerfile" \
        "$REPO_ROOT/deploy/local/mockservers/control"
      ;;
    frontend)
      local frontend_region
      frontend_region=cn
      if [[ "$LOCALSTACK_SITE_KIND" == "intl" ]]; then
        frontend_region=global
      fi
      "$DOCKER" build --platform "$PLATFORM" \
        --build-arg VITE_AUTH_API_BASE_URL="$GATEWAY_URL" \
        --build-arg NEXT_PUBLIC_AUTH_API_BASE_URL="$GATEWAY_URL" \
        --build-arg VITE_REGION="$frontend_region" \
        --build-arg NEXT_PUBLIC_REGION="$frontend_region" \
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

load_images_into_local_cluster() {
  local context cluster
  context="$(current_context)"
  case "$context" in
    kind-*)
      require_command kind
      cluster="${context#kind-}"
      log "loading local images into kind cluster $cluster"
      kind load docker-image --name "$cluster" "${localstack_images[@]}"
      ;;
    k3d-*)
      require_command k3d
      cluster="${context#k3d-}"
      log "loading local images into k3d cluster $cluster"
      k3d image import --cluster "$cluster" "${localstack_images[@]}"
      ;;
    minikube)
      require_command minikube
      log "loading local images into minikube"
      minikube image load "${localstack_images[@]}"
      ;;
    *)
      log "context $context is expected to share locally built images"
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
  "frontend|localstack-frontend|service/frontend|5173:8080|$PUBLIC_BIND_ADDRESS|required"
  "gateway|lightclaw-gateway|service/service-gateway|8085:80|$PUBLIC_BIND_ADDRESS|required"
  "auth|user-auth|service/lightclaw-auth|28081:80|127.0.0.1|debug"
  "payment|user-auth|service/payment|18082:80|127.0.0.1|debug"
  "subscription|user-auth|service/subscription|8086:80|127.0.0.1|debug"
  "ai-gateway|ai-gateway|service/gateway|18080:80|127.0.0.1|debug"
  "sandbox|sandbox|service/sandbox-api|18081:80|127.0.0.1|debug"
  "cloudladdergateway|cloudladdergateway|service/cloudladdergateway|18095:8095|127.0.0.1|debug"
  "shadow|shadow|service/shadow|18083:80|127.0.0.1|debug"
  # Only this callback proxy is reachable from the DevCloud network. The full
  # Trade listener contains privileged order/payment RPCs and stays loopback-only.
  "trade-callback|trade|service/trade-callback-proxy|18084:80|$PUBLIC_BIND_ADDRESS|required"
  "trade-internal|trade|service/trade|28084:80|127.0.0.1|required"
  "ctl|ctl|service/ctl-api|19590:80|127.0.0.1|debug"
  "fake-qq|localstack-system|service/fake-qq-oauth|19010:19010|$PUBLIC_BIND_ADDRESS|required"
  "fake-jifei|localstack-system|service/fake-jifei|19020:19020|127.0.0.1|debug"
  "fake-tencentcloud|localstack-system|service/fake-tencentcloud|19030:19030|127.0.0.1|debug"
  "fake-wechat-pay|localstack-system|service/fake-wechat-pay-bridge|19040:19040|$PUBLIC_BIND_ADDRESS|required"
  "mysql|localstack-system|service/mysql|43306:3306|127.0.0.1|debug"
  "redis|localstack-system|service/redis|36379:6379|127.0.0.1|debug"
)

exposure_enabled() {
  local profile="$1"
  [[ "$profile" == "required" ]] ||
    [[ "${LOCALSTACK_EXPOSE_INTERNAL_ENDPOINTS:-}" == "1" ]] ||
    [[ "$PUBLIC_BIND_ADDRESS" == "127.0.0.1" ]]
}

print_exposure_plan() {
  local spec name profile
  for spec in "${exposure_specs[@]}"; do
    IFS='|' read -r name _ _ _ _ profile <<<"$spec"
    exposure_enabled "$profile" || continue
    printf '%s\n' "$name"
  done
}

launchd_domain() {
  printf 'gui/%s\n' "$(id -u)"
}

stop_exposure() {
  local spec name label pid_file pid cmdline
  if [[ "$(uname -s)" == "Darwin" ]]; then
    for spec in "${exposure_specs[@]}"; do
      IFS='|' read -r name _ _ _ _ _ <<<"$spec"
      label="com.lightclaw.localstack.$name"
      launchctl bootout "$(launchd_domain)/$label" >/dev/null 2>&1 || true
    done
    rm -rf "$STATE_DIR/launchd"
    return
  fi

  for spec in "${exposure_specs[@]}"; do
    IFS='|' read -r name _ _ _ _ _ <<<"$spec"
    pid_file="$STATE_DIR/exposure/$name.pid"
    [[ -f "$pid_file" ]] || continue
    pid="$(tr -dc '0-9' <"$pid_file")"
    if [[ -n "$pid" && -r "/proc/$pid/cmdline" ]]; then
      cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
      if [[ "$cmdline" == *"kubectl"*"port-forward"* ]]; then
        kill "$pid" >/dev/null 2>&1 || true
      fi
    fi
    rm -f "$pid_file"
  done
  rm -rf "$STATE_DIR/exposure"
}

start_exposure_macos() {
  require_command launchctl
  local kubectl_path context domain spec name namespace resource mapping address profile label plist log_file
  kubectl_path="$(command -v "$KUBECTL")"
  context="$(current_context)"
  domain="$(launchd_domain)"
  mkdir -p "$STATE_DIR/launchd" "$STATE_DIR/logs"
  stop_exposure
  mkdir -p "$STATE_DIR/launchd" "$STATE_DIR/logs"

  for spec in "${exposure_specs[@]}"; do
    IFS='|' read -r name namespace resource mapping address profile <<<"$spec"
    exposure_enabled "$profile" || continue
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
    <string>$address</string>
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
  log "endpoint exposure is managed by macOS launchd"
}

start_exposure_linux() {
  local kubectl_path context spec name namespace resource mapping address profile log_file pid_file pid
  kubectl_path="$(command -v "$KUBECTL")"
  context="$(current_context)"
  stop_exposure
  mkdir -p "$STATE_DIR/exposure" "$STATE_DIR/logs"

  for spec in "${exposure_specs[@]}"; do
    IFS='|' read -r name namespace resource mapping address profile <<<"$spec"
    exposure_enabled "$profile" || continue
    log_file="$STATE_DIR/logs/$name.log"
    pid_file="$STATE_DIR/exposure/$name.pid"
    nohup "$kubectl_path" --context "$context" port-forward -n "$namespace" \
      --address "$address" "$resource" "$mapping" >"$log_file" 2>&1 </dev/null &
    pid=$!
    printf '%s\n' "$pid" >"$pid_file"
    chmod 600 "$pid_file"
  done

  sleep 2
  for spec in "${exposure_specs[@]}"; do
    IFS='|' read -r name _ _ _ _ profile <<<"$spec"
    exposure_enabled "$profile" || continue
    pid_file="$STATE_DIR/exposure/$name.pid"
    pid="$(tr -dc '0-9' <"$pid_file")"
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      tail -n 20 "$STATE_DIR/logs/$name.log" >&2 || true
      stop_exposure
      die "failed to expose $name"
    fi
  done
  log "endpoint exposure is managed by Linux background processes under $STATE_DIR/exposure"
}

start_exposure() {
  case "$(uname -s)" in
    Darwin) start_exposure_macos ;;
    Linux) start_exposure_linux ;;
    *) die "automatic endpoint exposure supports macOS and Linux" ;;
  esac
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
  "$KUBECTL" rollout status -n trade deployment/trade-callback-proxy --timeout=180s
  "$KUBECTL" rollout status -n ctl deployment/ctl-api --timeout=300s
  "$KUBECTL" rollout status -n ctl deployment/ctl-service --timeout=300s
  "$KUBECTL" rollout status -n ctl deployment/ctl-bypass --timeout=300s
  "$KUBECTL" rollout status -n lightclaw-gateway deployment/service-gateway --timeout=300s
  "$KUBECTL" rollout status -n localstack-frontend deployment/frontend --timeout=300s
}

internal_service_token_patch_plan() {
  cat <<'EOF'
user-auth|lightclaw-auth-secrets|LIGHTCLAW_INTERNAL_SERVICE_TOKEN,SHADOW_BINDING_INTERNAL_TOKEN
trade|trade-runtime-secrets|LIGHTCLAW_INTERNAL_SERVICE_TOKEN
ctl|ctl-runtime-secrets|LIGHTCLAW_INTERNAL_SERVICE_TOKEN,CTL_INTERNAL_TOKEN,CTL_SHADOW_TOKEN,CTL_AIGATEWAY_INTERNAL_SERVICE_TOKEN
shadow|shadow-runtime-secrets|SHADOW_INTERNAL_SERVICE_TOKEN
ai-gateway|ai-gateway-runtime-secrets|LIGHTCLAW_INTERNAL_SERVICE_TOKEN
EOF
}

randomize_shared_internal_tokens() {
  local token encoded namespace secret keys patch_file
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  encoded="$(printf '%s' "$token" | base64 | tr -d '\n')"
  while IFS='|' read -r namespace secret keys; do
    patch_file="$(mktemp "$STATE_DIR/internal-token-patch.XXXXXX")"
    chmod 600 "$patch_file"
    python3 - "$patch_file" "$encoded" "$keys" <<'PY'
import json
import sys

path, encoded, keys = sys.argv[1:]
with open(path, "w", encoding="utf-8") as output:
    json.dump({"data": {key: encoded for key in keys.split(",")}}, output, separators=(",", ":"))
    output.write("\n")
PY
    if "$KUBECTL" patch secret "$secret" -n "$namespace" --type merge --patch-file "$patch_file" >/dev/null; then
      rm -f "$patch_file"
      continue
    fi
    rm -f "$patch_file"
    unset token encoded
    die "failed to install the per-run shared internal service token for $namespace/$secret"
  done < <(internal_service_token_patch_plan)
  unset token encoded
  log "generated a per-run shared internal service token"
}

seed_site_data() {
  local seed_file
  for seed_file in "$SITE_SEED_ROOT/$LOCALSTACK_SITE_KIND/030-ctl-bundles.sql" "$SITE_SEED_ROOT/$LOCALSTACK_SITE_KIND/040-trade-bundles.sql"; do
    [[ -f "$seed_file" ]] || die "missing site seed: $seed_file"
    log "applying $(basename "$seed_file")"
    "$KUBECTL" exec -i -n localstack-system statefulset/mysql -- \
      sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' <"$seed_file"
  done
}

restart_app_deployments() {
  log "restarting deployments to load fixed-name ConfigMaps and Secrets"
  "$KUBECTL" rollout restart -n localstack-system deployment/mock-control deployment/fake-qq-oauth deployment/fake-jifei deployment/fake-tencentcloud deployment/fake-wechat-pay-bridge deployment/fake-envd
  "$KUBECTL" rollout restart -n user-auth deployment/lightclaw-auth deployment/payment deployment/subscription
  "$KUBECTL" rollout restart -n ai-gateway deployment/gateway-backend
  "$KUBECTL" rollout restart -n sandbox deployment/sandbox-api
  "$KUBECTL" rollout restart -n cloudladdergateway deployment/cloudladdergateway
  "$KUBECTL" rollout restart -n shadow deployment/shadow deployment/shadow-trade-adapter
  "$KUBECTL" rollout restart -n trade deployment/trade deployment/trade-callback-proxy
  "$KUBECTL" rollout restart -n ctl deployment/ctl-api deployment/ctl-service deployment/ctl-bypass
  "$KUBECTL" rollout restart -n lightclaw-gateway deployment/service-gateway
  "$KUBECTL" rollout restart -n localstack-frontend deployment/frontend
}

up() {
  doctor
  if [[ "${LOCALSTACK_SKIP_BUILD:-}" != "1" ]]; then
    build_image all
    load_images_into_local_cluster
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

  randomize_shared_internal_tokens

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
  seed_site_data

  restart_app_deployments
  wait_rollouts
  start_exposure
  log "frontend=$FRONTEND_URL gateway=$GATEWAY_URL trade=http://$LOCALSTACK_PUBLIC_HOST:18084 fake-qq=$FAKE_QQ_URL fake-wechat-pay=$FAKE_WECHAT_PAY_URL"
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
  exposure-plan      Print endpoint names that would be exposed
  stop-expose        Stop launchd-managed localhost endpoints
  status             Show localstack Pods
  logs               Follow logs from localstack Pods
  down               Remove workloads while preserving PVC data
  reset              Remove workloads, namespaces, and PVC data
EOF
}

main() {
  local command="${1:-}"
  case "$command" in
    doctor) doctor ;;
    build) doctor; build_image "${2:-all}" ;;
    render) render_all ;;
    up) up ;;
    expose) require_local_context; start_exposure ;;
    exposure-plan) print_exposure_plan ;;
    internal-token-patch-plan) internal_service_token_patch_plan ;;
    stop-expose) stop_exposure ;;
    status) status ;;
    logs) logs ;;
    down) down ;;
    reset) reset ;;
    *) usage; [[ -z "$command" ]] || return 1 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
