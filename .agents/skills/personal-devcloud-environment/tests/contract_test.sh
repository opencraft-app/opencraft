#!/usr/bin/env bash
set -euo pipefail

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
SCRIPT="$SCRIPT_DIR/personal-devcloud.sh"
RUNTIME_KUSTOMIZE="$SCRIPT_DIR/kustomize-runtime-wrapper.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

fail() {
  printf 'contract test failed: %s\n' "$*" >&2
  return 1
}

assert_eq() {
  local expected="$1" actual="$2" message="$3"
  [[ "$actual" == "$expected" ]] || fail "$message: expected '$expected', got '$actual'"
}

run_test() {
  local name="$1"
  shift
  "$@"
  printf 'ok - %s\n' "$name"
}

test_site_state_isolation() {
  local state_base="$TEST_ROOT/site-isolation" intl cn
  intl="$(PERSONAL_DEV_STATE_DIR="$state_base" PERSONAL_DEV_SITE=intl bash -c '
    source "$1"
    printf "%s|%s|%s|%s|%s" "$STATE_ROOT" "$KIND_CLUSTER" "$KUBECONFIG_FILE" "$HEARTBEAT_PID_FILE" "$DEVTUNNEL_PID_FILE"
  ' bash "$SCRIPT")"
  cn="$(PERSONAL_DEV_STATE_DIR="$state_base" PERSONAL_DEV_SITE=cn bash -c '
    source "$1"
    printf "%s|%s|%s|%s|%s" "$STATE_ROOT" "$KIND_CLUSTER" "$KUBECONFIG_FILE" "$HEARTBEAT_PID_FILE" "$DEVTUNNEL_PID_FILE"
  ' bash "$SCRIPT")"
  assert_eq "$state_base/intl|lightvela-personal-intl|$state_base/intl/kubeconfig|$state_base/intl/heartbeat.pid|$state_base/intl/devtunnel-agent.pid" "$intl" "intl state layout"
  assert_eq "$state_base/cn|lightvela-personal-cn|$state_base/cn/kubeconfig|$state_base/cn/heartbeat.pid|$state_base/cn/devtunnel-agent.pid" "$cn" "cn state layout"
}

test_saved_kind_cluster_is_restored() (
  local state_base="$TEST_ROOT/saved-kind-cluster"
  mkdir -p "$state_base/intl"
  printf '{"kind_cluster":"lightvela-personal-01a07ed6-intl"}\n' >"$state_base/intl/state.json"
  export PERSONAL_DEV_STATE_DIR="$state_base" PERSONAL_DEV_SITE=intl
  unset PERSONAL_DEV_KIND_CLUSTER
  source "$SCRIPT"
  prepare_state
  assert_eq 'lightvela-personal-01a07ed6-intl' "$KIND_CLUSTER" "saved kind cluster"
  assert_eq 'kind-lightvela-personal-01a07ed6-intl' "$KUBE_CONTEXT" "saved kube context"
)

test_active_site_blocks_switch() (
  local state_base="$TEST_ROOT/site-switch"
  mkdir -p "$state_base/intl"
  printf 'intl\n' >"$state_base/current-site"
  printf '{"registration_status":"active","registration_expires_at":"2099-01-01T00:00:00Z","stack_status":"up"}\n' \
    >"$state_base/intl/state.json"
  export PERSONAL_DEV_STATE_DIR="$state_base" PERSONAL_DEV_SITE=cn
  source "$SCRIPT"
  prepare_state
  if (ensure_site_activation_safe) >/dev/null 2>&1; then
    fail "switching away from an active site was allowed"
  fi
)

test_state_updates_are_atomic() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/concurrent-state" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state
  local i
  for i in $(seq 1 20); do
    state_set "key_$i" "value_$i" &
  done
  wait
  python3 - "$STATE_FILE" <<'PY'
import json, stat, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
for i in range(1, 21):
    assert data.get(f"key_{i}") == f"value_{i}", (i, data)
assert stat.S_IMODE(__import__("os").stat(path).st_mode) == 0o600
PY
)

test_auth_failure_removes_temp_credentials() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/auth-temp" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_EMAIL="managed@example.com" PERSONAL_DEV_PASSWORD="managed-password"
  source "$SCRIPT"
  prepare_state
  local seen_file="$TEST_ROOT/auth-body-path"
  curl() {
    local previous="" arg
    for arg in "$@"; do
      if [[ "$previous" == "--data-binary" && "$arg" == @* ]]; then
        printf '%s\n' "${arg#@}" >"$seen_file"
      fi
      previous="$arg"
    done
    return 22
  }
  if central_session >/dev/null 2>&1; then
    fail "central_session unexpectedly succeeded"
  fi
  [[ -s "$seen_file" ]] || fail "auth request body was not observed"
  local body_path
  body_path="$(<"$seen_file")"
  [[ ! -e "$body_path" ]] || fail "credential request body survived auth failure"
)

test_session_only_generates_local_credentials() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/session-only" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_SESSION_TOKEN='short-lived-testing-session' # pragma: allowlist secret
  unset PERSONAL_DEV_EMAIL PERSONAL_DEV_PASSWORD
  source "$SCRIPT"
  prepare_state
  curl_with_token() { return 0; }

  assert_eq 'short-lived-testing-session' "$(central_session)" "central session reuse"
  prepare_local_credentials
  [[ "$LOCAL_IDENTITY_EMAIL" == lv-local-*@example.com ]] \
    || fail "session-only flow did not generate a local email"
  [[ -n "$LOCAL_IDENTITY_PASSWORD" ]] \
    || fail "session-only flow did not generate a local password"
  assert_eq "$LOCAL_IDENTITY_EMAIL" "$(state_get email)" "local email state"
  assert_eq "$LOCAL_IDENTITY_PASSWORD" "$(state_get password)" "local password state"
)

test_personal_kubeconfig_guard() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/kube-guard" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state
  : >"$KUBECONFIG_FILE"
  kubectl() {
    case "$*" in
      "config current-context") printf '%s\n' "$KUBE_CONTEXT" ;;
      *".context.cluster}"*) printf '%s\n' "$KIND_CLUSTER" ;;
      *".cluster.server}"*) printf '%s\n' 'https://127.0.0.1:53421' ;;
      *) return 1 ;;
    esac
  }
  require_personal_context

  kubectl() {
    case "$*" in
      "config current-context") printf '%s\n' 'shared-testing' ;;
      *) return 1 ;;
    esac
  }
  if (require_personal_context) >/dev/null 2>&1; then
    fail "shared context passed the personal context guard"
  fi

  kubectl() {
    case "$*" in
      "config current-context") printf '%s\n' "$KUBE_CONTEXT" ;;
      *".context.cluster}"*) printf '%s\n' "$KIND_CLUSTER" ;;
      *".cluster.server}"*) printf '%s\n' 'https://10.0.0.8:6443' ;;
      *) return 1 ;;
    esac
  }
  if (require_personal_context) >/dev/null 2>&1; then
    fail "non-loopback API server passed the personal context guard"
  fi
)

test_auth_override_is_sandbox_only() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/auth-allowlist" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_AUTH_BASE_URL='https://api.lightvela.ai'
  source "$SCRIPT"
  if (configure_site) >/dev/null 2>&1; then
    fail "production Auth override was accepted"
  fi
)

test_download_binary_is_nounset_safe() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/download-binary" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state
  local digest
  digest="$(printf 'a%.0s' $(seq 1 64))"
  curl() {
    local output="" arg previous=""
    for arg in "$@"; do
      if [[ "$previous" == "-o" ]]; then
        output="$arg"
      fi
      previous="$arg"
    done
    [[ -n "$output" ]] || return 1
    if [[ "$*" == *checksum* ]]; then
      printf '%s  tool\n' "$digest" >"$output"
    else
      printf '#!/usr/bin/env bash\nexit 0\n' >"$output"
    fi
  }
  sha256_file() { printf '%s\n' "$digest"; }
  download_binary test-tool https://downloads.example/tool https://downloads.example/checksum
  [[ -x "$TOOLS_DIR/test-tool" ]] || fail "downloaded tool is not executable"
)

test_intl_registration_starts_tunnel() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/intl-register" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_IP='9.134.214.121'
  source "$SCRIPT"
  prepare_state
  state_set uin '450860000013'
  require_personal_context() { :; }
  central_session() { printf 'session-token\n'; }
  curl() { return 0; }
  curl_with_token() {
    printf '%s\n' "$*" >"$TEST_ROOT/intl-registration-request"
    printf '%s\n' '{"uin":450860000013,"status":"active","targetIp":"9.134.214.121","port":18084,"tunnelHost":"uin-450860000013.sg.tunnel.internal","tunnelToken":"short-lived-registration-token","expiresAt":"2099-01-01T00:00:00Z"}'
  }
  ensure_devtunnel_agent() { printf '%s|%s\n' "$1" "$2" >"$TEST_ROOT/intl-tunnel-assignment"; }
  register_route
  assert_eq 'uin-450860000013.sg.tunnel.internal|short-lived-registration-token' \
    "$(<"$TEST_ROOT/intl-tunnel-assignment")" "tunnel assignment passed to agent"
  assert_eq 'active' "$(state_get registration_status)" "intl registration status"
  grep -q '"targetIp":"9.134.214.121"' "$TEST_ROOT/intl-registration-request"
  ! grep -q '"uin"' "$TEST_ROOT/intl-registration-request"
  ! grep -Eq 'short-lived-registration-token|tunnelToken' "$STATE_FILE"
)

test_devtunnel_build_uses_current_checkout() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/devtunnel-current-checkout" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state

  local checkout="$TEST_ROOT/current-checkout"
  mkdir -p \
    "$checkout/cloudladdergateway/cmd/devtunnel-agent" \
    "$checkout/cloudladdergateway/internal/devtunnel" \
    "$checkout/shared/cloudladdertransport"
  printf 'package main\n' >"$checkout/cloudladdergateway/cmd/devtunnel-agent/main.go"
  printf 'package devtunnel\n' >"$checkout/cloudladdergateway/internal/devtunnel/current.go"
  printf 'package cloudladdertransport\n' >"$checkout/shared/cloudladdertransport/current.go"
  printf 'module example.test/current\n' >"$checkout/cloudladdergateway/go.mod"
  printf '\n' >"$checkout/cloudladdergateway/go.sum"
  REPO_ROOT="$checkout"

  docker() {
    printf '%s\n' "$*" >"$TEST_ROOT/devtunnel-docker-args"
    printf '#!/usr/bin/env bash\nexit 0\n' >"$DEVTUNNEL_BIN"
  }

  ensure_devtunnel_agent_binary
  [[ -x "$DEVTUNNEL_BIN" ]] || fail "devtunnel-agent binary was not created"
  grep -Fq -- "-v $checkout:/workspace:ro" "$TEST_ROOT/devtunnel-docker-args" \
    || fail "devtunnel-agent was not built from the current checkout"
  grep -Fq -- "-e GOWORK=off" "$TEST_ROOT/devtunnel-docker-args" \
    || fail "devtunnel-agent build did not disable the read-only root Go workspace"
)

test_intl_registration_without_capability_fails_closed() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/intl-missing-token" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_IP='9.134.214.121'
  source "$SCRIPT"
  prepare_state
  state_set uin '450860000013'
  require_personal_context() { :; }
  central_session() { printf 'session-token\n'; }
  curl() { return 0; }
  curl_with_token() {
    if [[ " $* " == *' -X DELETE '* ]]; then
      printf 'disabled\n' >"$TEST_ROOT/intl-missing-token-delete"
      printf '%s\n' '{"uin":450860000013,"status":"disabled"}'
      return
    fi
    printf '%s\n' '{"uin":450860000013,"status":"active","targetIp":"9.134.214.121","port":18084,"tunnelHost":"uin-450860000013.sg.tunnel.internal","expiresAt":"2099-01-01T00:00:00Z"}'
  }
  ensure_devtunnel_agent() { fail "agent must not start without a per-registration capability"; }
  if (register_route) >/dev/null 2>&1; then
    fail "Intl registration succeeded without a per-registration tunnel capability"
  fi
  [[ -s "$TEST_ROOT/intl-missing-token-delete" ]] || fail "unsafe active registration was not disabled"
)

test_cn_registration_sends_explicit_devcloud_target() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/cn-register" PERSONAL_DEV_SITE=cn
  export PERSONAL_DEV_IP='9.134.214.121'
  source "$SCRIPT"
  prepare_state
  state_set uin '450860000013'
  require_personal_context() { :; }
  central_session() { printf 'session-token\n'; }
  curl() { return 0; }
  curl_with_token() {
    printf '%s\n' "$*" >"$TEST_ROOT/cn-registration-request"
    printf '%s\n' '{"uin":450860000013,"status":"active","targetIp":"9.134.214.121","port":18084,"tunnelHost":"uin-450860000013.cn.tunnel.internal","tunnelToken":"short-lived-cn-registration-token","expiresAt":"2099-01-01T00:00:00Z"}'
  }
  ensure_devtunnel_agent() { printf '%s|%s\n' "$1" "$2" >"$TEST_ROOT/cn-tunnel-assignment"; }
  register_route
  grep -q '"targetIp":"9.134.214.121"' "$TEST_ROOT/cn-registration-request"
  ! grep -q '"uin"' "$TEST_ROOT/cn-registration-request"
  assert_eq 'uin-450860000013.cn.tunnel.internal|short-lived-cn-registration-token' \
    "$(<"$TEST_ROOT/cn-tunnel-assignment")" "CN tunnel assignment"
  assert_eq '9.134.214.121' "$(state_get registration_target_ip)" "CN registration target IP"
  assert_eq '18084' "$(state_get registration_port)" "CN registration port"
  ! grep -Eq 'short-lived-cn-registration-token|tunnelToken' "$STATE_FILE"
)

test_registration_agent_failure_fails_closed() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/agent-failure" PERSONAL_DEV_SITE=cn
  export PERSONAL_DEV_IP='9.134.214.121'
  source "$SCRIPT"
  prepare_state
  state_set uin '450860000013'
  require_personal_context() { :; }
  central_session() { printf 'session-token\n'; }
  curl() { return 0; }
  curl_with_token() {
    if [[ " $* " == *' -X DELETE '* ]]; then
      printf 'disabled\n' >"$TEST_ROOT/agent-failure-delete"
      printf '%s\n' '{"uin":450860000013,"status":"disabled"}'
      return
    fi
    printf '%s\n' '{"uin":450860000013,"status":"active","targetIp":"9.134.214.121","port":18084,"tunnelHost":"uin-450860000013.cn.tunnel.internal","tunnelToken":"short-lived-cn-registration-token","expiresAt":"2099-01-01T00:00:00Z"}'
  }
  ensure_devtunnel_agent() { return 1; }
  stop_devtunnel_agent() { printf 'stopped\n' >"$TEST_ROOT/agent-failure-stop"; }
  if (register_route) >/dev/null 2>&1; then
    fail "registration succeeded after the local tunnel agent failed"
  fi
  [[ -s "$TEST_ROOT/agent-failure-delete" ]] || fail "agent failure left an active developer route"
  [[ -s "$TEST_ROOT/agent-failure-stop" ]] || fail "agent failure did not stop local tunnel state"
)

test_cn_registration_without_capability_fails_closed() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/cn-missing-token" PERSONAL_DEV_SITE=cn
  export PERSONAL_DEV_IP='9.134.214.121'
  source "$SCRIPT"
  prepare_state
  state_set uin '450860000013'
  require_personal_context() { :; }
  central_session() { printf 'session-token\n'; }
  curl() { return 0; }
  curl_with_token() {
    if [[ " $* " == *' -X DELETE '* ]]; then
      printf 'disabled\n' >"$TEST_ROOT/cn-missing-token-delete"
      printf '%s\n' '{"uin":450860000013,"status":"disabled"}'
      return
    fi
    printf '%s\n' '{"uin":450860000013,"status":"active","targetIp":"9.134.214.121","port":18084,"tunnelHost":"uin-450860000013.cn.tunnel.internal","expiresAt":"2099-01-01T00:00:00Z"}'
  }
  ensure_devtunnel_agent() { fail "agent must not start without a per-registration capability"; }
  if (register_route) >/dev/null 2>&1; then
    fail "CN registration succeeded without a per-registration tunnel capability"
  fi
  [[ -s "$TEST_ROOT/cn-missing-token-delete" ]] || fail "unsafe CN registration was not disabled"
)

test_heartbeat_survives_transient_failures() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/heartbeat" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_HEARTBEAT_INTERVAL_SECONDS=0 PERSONAL_DEV_HEARTBEAT_MAX_ITERATIONS=3
  source "$SCRIPT"
  local attempts=0
  sleep() { :; }
  heartbeat_once() {
    attempts=$((attempts + 1))
    [[ "$attempts" -ge 3 ]]
  }
  heartbeat_loop
  assert_eq '3' "$attempts" "heartbeat retry count"
)

test_stop_heartbeat_interrupts_long_sleep() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/heartbeat-stop" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_HEARTBEAT_INTERVAL_SECONDS=300
  source "$SCRIPT"
  prepare_state
  "$SCRIPT" heartbeat-loop >"$TEST_ROOT/heartbeat-stop.log" 2>&1 &
  local heartbeat_pid="$!" sleeper_pid="" attempt
  printf '%s\n' "$heartbeat_pid" >"$HEARTBEAT_PID_FILE"
  for attempt in $(seq 1 50); do
    sleeper_pid="$(pgrep -P "$heartbeat_pid" 2>/dev/null | head -1 || true)"
    [[ -n "$sleeper_pid" ]] && break
    sleep 0.1
  done
  [[ -n "$sleeper_pid" ]] || fail "heartbeat did not enter its long sleep"
  stop_heartbeat
  wait "$heartbeat_pid" 2>/dev/null || true
  ! process_is_running "$heartbeat_pid" || fail "heartbeat parent survived stop"
  ! process_is_running "$sleeper_pid" || fail "heartbeat sleep child survived stop"
  [[ ! -e "$HEARTBEAT_PID_FILE" ]] || fail "heartbeat pid file survived stop"
)

test_order_no_pay_is_loopback_only_and_intl_usd() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/checkcreate" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state
  state_set uin '450860000013'
  state_set app_id '1374212056'
  require_personal_context() { :; }
  require_active_registration() { :; }
  kubectl() { printf 'aW50ZXJuYWwtdG9rZW4='; }
  curl_with_token() {
    local endpoint="${!#}"
    printf '%s\n' "$endpoint" >>"$TEST_ROOT/checkcreate-endpoints"
    case "$endpoint" in
      */inquiry/batch) printf '%s\n' '{"prices":[{"currency":"USD"},{"currency":"USD"}]}' ;;
      */orders) printf '%s\n' '{"dealName":"deal-1","bigOrderId":"big-1"}' ;;
      *) return 1 ;;
    esac
  }
  mysql_scalar() {
    case "$1" in
      *"WHERE deal_name='deal-1'"*) printf '%s\n' 'pending_pay|big-1|450860000013|1374212056|bundle_launch_01' ;;
      *) printf '0\n' ;;
    esac
  }
  local output endpoints
  output="$(verify_order_no_pay)"
  grep -q '"dealName":"deal-1"' <<<"$output"
  endpoints="$(<"$TEST_ROOT/checkcreate-endpoints")"
  grep -q 'http://127.0.0.1:28084/internal/trade/inquiry/batch' <<<"$endpoints"
  grep -q 'http://127.0.0.1:28084/internal/trade/orders' <<<"$endpoints"
  ! grep -q '127.0.0.1:18084/internal/trade' <<<"$endpoints"
)

test_status_fails_when_dependencies_fail() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/status" PERSONAL_DEV_SITE=intl PERSONAL_DEV_IP='9.134.214.121'
  source "$SCRIPT"
  prepare_state
  state_set central_session_token 'session-token'
  require_personal_context() { :; }
  curl() { return 1; }
  curl_with_token() { return 1; }
  kubectl() { return 1; }
  heartbeat_running() { return 1; }
  if status >/dev/null 2>&1; then
    fail "status returned success while every dependency failed"
  fi
)

test_down_stops_stack_after_unregister_failure() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/down" PERSONAL_DEV_SITE=intl
  export TEST_LOCALSTACK_MARKER="$TEST_ROOT/down-called"
  source "$SCRIPT"
  prepare_state
  local fake_localstack="$TEST_ROOT/fake-localstack"
  printf '#!/usr/bin/env bash\nprintf "%%s|%%s|%%s\\n" "$1" "$LOCALSTACK_SITE_KIND" "$LOCALSTACK_STATE_DIR" >"$TEST_LOCALSTACK_MARKER"\n' >"$fake_localstack"
  chmod 700 "$fake_localstack"
  LOCALSTACK="$fake_localstack"
  unregister_for_down() { return 1; }
  require_personal_context() { :; }
  kubectl() { :; }
  kustomize() { :; }
  down
  [[ -s "$TEST_LOCALSTACK_MARKER" ]] || fail "localstack down was skipped"
  grep -q "^down|intl|$PERSONAL_DEV_STATE_DIR/intl/localstack$" "$TEST_LOCALSTACK_MARKER"
)

test_gateway_override_reaches_trade_runtime() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/gateway-override" PERSONAL_DEV_SITE=intl PERSONAL_DEV_IP='9.134.214.121'
  export PERSONAL_DEV_CLGATEWAY_BASE_URL='http://testing-gateway.example'
  export TEST_LOCALSTACK_MARKER="$TEST_ROOT/up-called"
  source "$SCRIPT"
  prepare_state
  local fake_localstack="$TEST_ROOT/fake-localstack-up"
  printf '#!/usr/bin/env bash\nprintf "%%s|%%s|%%s|%%s\\n" "$1" "$LOCALSTACK_SITE_KIND" "$LOCALSTACK_STATE_DIR" "$LOCALSTACK_JIFEI_GATEWAY_URL" >"$TEST_LOCALSTACK_MARKER"\n' >"$fake_localstack"
  chmod 700 "$fake_localstack"
  LOCALSTACK="$fake_localstack"
  bootstrap() { :; }
  clear_legacy_runtime_overrides() { :; }
  register_command() { :; }
  kubectl() { :; }
  kustomize() { :; }
  up
  grep -q "^up|intl|$PERSONAL_DEV_STATE_DIR/intl/localstack|http://testing-gateway.example/v1/proxy/jifei-test/interfaces/interface.php$" \
    "$TEST_LOCALSTACK_MARKER"
)

test_testing_gateway_migrates_stale_state_and_rejects_prod_override() {
  local state_base="$TEST_ROOT/testing-gateway-guard"
  mkdir -p "$state_base/intl"
  printf '{"clgateway_base":"http://43.153.236.65"}\n' >"$state_base/intl/state.json"
  local migrated
  migrated="$(PERSONAL_DEV_STATE_DIR="$state_base" PERSONAL_DEV_SITE=intl bash -c '
    source "$1"
    prepare_state
    printf "%s" "$CLGATEWAY_BASE"
  ' bash "$SCRIPT")"
  assert_eq 'http://43.153.246.14' "$migrated" "stale intl production gateway migration"

  if PERSONAL_DEV_STATE_DIR="$TEST_ROOT/prod-gateway-reject" \
    PERSONAL_DEV_SITE=intl \
    PERSONAL_DEV_CLGATEWAY_BASE_URL=http://43.153.236.65 \
    bash -c 'source "$1"; prepare_state' bash "$SCRIPT" >/dev/null 2>&1; then
    fail "explicit production CloudLadder endpoint was accepted"
  fi
}

test_runtime_instrumentation_is_streamed_from_skill() (
  export PERSONAL_DEV_REAL_KUSTOMIZE="$(command -v kustomize)"
  export PERSONAL_DEV_RUNTIME_SITE=intl
  export PERSONAL_DEV_RUNTIME_PUBLIC_HOST=9.134.214.121
  export PERSONAL_DEV_RUNTIME_JIFEI_GATEWAY=http://testing-gateway.example/v1/proxy/jifei-test/interfaces/interface.php
  local auth_render trade_render ctl_render
  auth_render="$TEST_ROOT/runtime-auth.yaml"
  trade_render="$TEST_ROOT/runtime-trade.yaml"
  ctl_render="$TEST_ROOT/runtime-ctl.yaml"
  "$RUNTIME_KUSTOMIZE" build --load-restrictor LoadRestrictionsNone \
    "$REPO_ROOT/deploy/localstack/auth" >"$auth_render"
  "$RUNTIME_KUSTOMIZE" build --load-restrictor LoadRestrictionsNone \
    "$REPO_ROOT/deploy/localstack/trade" >"$trade_render"
  "$RUNTIME_KUSTOMIZE" build --load-restrictor LoadRestrictionsNone \
    "$REPO_ROOT/deploy/localstack/ctl" >"$ctl_render"

  grep -Fq 'LIGHTCLAW_FRONTEND_BASE_URL: "http://9.134.214.121:5173"' "$auth_render"
  grep -Fq 'LIGHTCLAW_PUBLIC_BASE_URL: "http://9.134.214.121:8085"' "$auth_render"
  grep -Fq 'LIGHTVELA_SITE_KIND: "intl"' "$auth_render"
  grep -Fq 'SHADOW_PLATFORM: "intlSaaSLightvela"' "$auth_render"
  grep -Fq 'JIFEI_CGW_GATEWAY_URL: "http://testing-gateway.example/v1/proxy/jifei-test/interfaces/interface.php"' "$trade_render"
  grep -Fq 'LIGHTVELA_TRADE_REGION: "ap-singapore"' "$trade_render"
  grep -Fq 'LIGHTVELA_SITE_KIND: "intl"' "$ctl_render"
  ! grep -q '9.134.214.121' "$REPO_ROOT/deploy/localstack/auth/kustomization.yaml"
  ! grep -q 'testing-gateway.example' "$REPO_ROOT/deploy/localstack/trade/kustomization.yaml"
)

test_browser_login_is_minted_privately() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/browser-login" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_IP=127.0.0.1 PERSONAL_DEV_BROWSER_SESSION_TTL_SECONDS=900
  export PERSONAL_DEV_BROWSER_BOOTSTRAP_PORT=0 PERSONAL_DEV_BROWSER_BOOTSTRAP_TTL_SECONDS=10
  source "$SCRIPT"
  prepare_state
  state_set local_user_id usr_browser
  kubectl() {
    case "$*" in
      "get secret lightclaw-auth-secrets -n user-auth -o jsonpath={.data.LIGHTVELA_E2E_AUTH_TOKEN}")
        printf '%s' 'e2e-token' | base64
        ;;
      "port-forward -n user-auth --address 127.0.0.1 service/lightclaw-auth "*)
        sleep 5
        ;;
      *) return 1 ;;
    esac
  }
  curl() { return 0; }
  curl_with_token() {
    printf '%s\n' '{"userId":"usr_browser","sessionToken":"private-token","loginUrl":"http://127.0.0.1:5173/#session_token=private-token","expiresAt":"2099-01-01T00:00:00Z","impersonated":false}'
  }
  local output output_file url headers pid first_pid curl_bin
  curl_bin="$(type -P curl)"
  output_file="$TEST_ROOT/browser-login-output"
  mint_browser_login >"$output_file" 2>&1
  output="$(<"$output_file")"
  [[ "$output" != *private-token* ]] || fail "browser session token leaked to command output"
  assert_eq '' "$(state_get browser_login_url)" "browser login token must not persist in state"
  assert_eq '2099-01-01T00:00:00Z' "$(state_get browser_login_expires_at)" "browser login expiry"
  first_pid="$(<"$BROWSER_BOOTSTRAP_PID_FILE")"
  mint_browser_login >>"$output_file" 2>&1
  ! process_is_running "$first_pid" || fail "previous browser bootstrap survived immediate replacement"
  output="$(<"$output_file")"
  [[ "$output" != *private-token* ]] || fail "replacement browser session token leaked to command output"
  url="$(<"$BROWSER_BOOTSTRAP_READY_FILE")"
  [[ "$url" =~ ^http://127\.0\.0\.1:[0-9]+/[A-Za-z0-9_-]{24,128}$ ]] \
    || fail "one-time browser URL is malformed: $url"
  [[ "$url" != *private-token* ]] || fail "one-time URL leaked the browser session token"
  pid="$(<"$BROWSER_BOOTSTRAP_PID_FILE")"
  headers="$("$curl_bin" --silent --show-error --max-time 2 --dump-header - --output /dev/null "$url")"
  grep -q '^HTTP/1\.[01] 303 ' <<<"$headers"
  grep -Fq 'Location: http://127.0.0.1:5173/dashboard/settings#session_token=private-token' <<<"$headers"
  wait "$pid"
  [[ ! -e "$BROWSER_BOOTSTRAP_READY_FILE" ]] || fail "one-time browser URL survived consumption"
  ! find "$STATE_ROOT" -maxdepth 1 -name 'browser-session.*' -print -quit | grep -q . \
    || fail "browser session token file survived bootstrap startup"
)

test_browser_nonce_retries_empty_generation() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/browser-nonce" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state
  local attempts_file nonce
  attempts_file="$TEST_ROOT/browser-nonce-attempts"
  printf '0\n' >"$attempts_file"
  browser_nonce_once() {
    local attempts
    attempts="$(<"$attempts_file")"
    attempts=$((attempts + 1))
    printf '%s\n' "$attempts" >"$attempts_file"
    if ((attempts == 1)); then
      return 0
    fi
    printf '%s\n' 'valid_browser_nonce_0123456789'
  }
  nonce="$(generate_browser_nonce)"
  assert_eq 'valid_browser_nonce_0123456789' "$nonce" "browser nonce retry result"
  assert_eq '2' "$(<"$attempts_file")" "browser nonce retry count"
)

test_skill_name_and_paths_are_consistent() {
  grep -q '^name: personal-devcloud-environment$' "$REPO_ROOT/.agents/skills/personal-devcloud-environment/SKILL.md"
  if grep -ERn 'personal[-]billing-devenv|\.localstack/personal[-]billing' \
    "$REPO_ROOT/.agents/skills/personal-devcloud-environment/SKILL.md" \
    "$REPO_ROOT/.agents/skills/personal-devcloud-environment/scripts" \
    "$REPO_ROOT/deploy/localstack/README.md"; then
    fail "old personal billing skill name or state path remains"
  fi
  test -x "$SCRIPT_DIR/browser-login-bootstrap.py"
}

test_payment_and_production_guardrails() {
  ! grep -En 'place-and-pay|pay-url' "$SCRIPT"
  ! grep -En 'api\.lightvela\.(com|ai)|production|staging|argocd|kubectl.*sync' "$SCRIPT"
  grep -q 'verify-order-no-pay' "$SCRIPT"
  grep -q 'verify-checkmodify-no-pay' "$SCRIPT"
  grep -q 'checkModify verification is not implemented' "$SCRIPT"
  ! grep -q 'verified.*checkCreate' "$SCRIPT"
}

run_test 'CN and Intl state are isolated' test_site_state_isolation
run_test 'saved kind cluster is restored for follow-up commands' test_saved_kind_cluster_is_restored
run_test 'active site blocks cross-site activation' test_active_site_blocks_switch
run_test 'state updates are atomic' test_state_updates_are_atomic
run_test 'auth failure removes credential temp files' test_auth_failure_removes_temp_credentials
run_test 'session-only auth generates private local credentials' test_session_only_generates_local_credentials
run_test 'personal kubeconfig guard rejects shared clusters' test_personal_kubeconfig_guard
run_test 'Auth override is sandbox-only' test_auth_override_is_sandbox_only
run_test 'binary bootstrap is safe under nounset' test_download_binary_is_nounset_safe
run_test 'Intl registration starts the assigned tunnel' test_intl_registration_starts_tunnel
run_test 'devtunnel-agent builds from the current checkout' test_devtunnel_build_uses_current_checkout
run_test 'Intl registration without a capability fails closed' test_intl_registration_without_capability_fails_closed
run_test 'CN registration sends the DevCloud target and starts its assigned tunnel' test_cn_registration_sends_explicit_devcloud_target
run_test 'CN registration without a capability fails closed' test_cn_registration_without_capability_fails_closed
run_test 'registration agent failure fails closed' test_registration_agent_failure_fails_closed
run_test 'heartbeat survives transient failures' test_heartbeat_survives_transient_failures
run_test 'heartbeat stop interrupts a long sleep' test_stop_heartbeat_interrupts_long_sleep
run_test 'no-pay order verification stays on loopback and validates USD' test_order_no_pay_is_loopback_only_and_intl_usd
run_test 'status fails closed' test_status_fails_when_dependencies_fail
run_test 'down continues after unregister failure' test_down_stops_stack_after_unregister_failure
run_test 'gateway override reaches Trade runtime' test_gateway_override_reaches_trade_runtime
run_test 'testing gateway migrates stale state and rejects production overrides' test_testing_gateway_migrates_stale_state_and_rejects_prod_override
run_test 'runtime instrumentation streams from the Skill without source writes' test_runtime_instrumentation_is_streamed_from_skill
run_test 'browser login is minted into private state without token output' test_browser_login_is_minted_privately
run_test 'browser login retries an empty nonce generation' test_browser_nonce_retries_empty_generation
run_test 'skill name and paths are consistent' test_skill_name_and_paths_are_consistent
run_test 'payment and production guardrails remain absent' test_payment_and_production_guardrails

printf 'personal devcloud skill contract passed\n'
