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
  unset PERSONAL_DEV_EMAIL PERSONAL_DEV_PASSWORD PERSONAL_DEV_LOCAL_EMAIL PERSONAL_DEV_LOCAL_PASSWORD
  source "$SCRIPT"
  prepare_state
  curl_with_token() { return 0; }

  assert_eq 'short-lived-testing-session' "$(central_session)" "central session reuse"
  prepare_local_credentials
  [[ "$LOCAL_IDENTITY_EMAIL" == lv-local-*@example.com ]] \
    || fail "session-only flow did not generate a local email"
  [[ -n "$LOCAL_IDENTITY_PASSWORD" ]] \
    || fail "session-only flow did not generate a local password"
  assert_eq "$LOCAL_IDENTITY_EMAIL" "$(state_get local_email)" "local email state"
  assert_eq "$LOCAL_IDENTITY_PASSWORD" "$(state_get local_password)" "local password state"
  assert_eq '' "$(state_get central_email)" "central email remains unset"
  assert_eq '' "$(state_get central_password)" "central password remains unset"
)

test_fresh_state_leases_testing_account_without_credentials() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/account-lease" PERSONAL_DEV_SITE=intl
  unset PERSONAL_DEV_SESSION_TOKEN PERSONAL_DEV_EMAIL PERSONAL_DEV_PASSWORD
  source "$SCRIPT"
  prepare_state
  discover_devcloud_ip() { printf '%s\n' '21.214.48.147'; }
  curl() {
    [[ "${*: -1}" == "$ACCOUNT_LEASE_URL" ]] || return 22
    printf '%s\n' '{"userId":"usr_pool_intl","sessionToken":"lease-session-token-abcdefghijklmnopqrstuvwxyz012345","sessionExpiresAt":"2026-09-23T08:00:00Z","leaseExpiresAt":"2026-09-23T08:00:00Z","leaseVersion":7}'
  }

  local token
  token="$(central_session)"
  assert_eq 'lease-session-token-abcdefghijklmnopqrstuvwxyz012345' "$token" "leased central session"
  assert_eq 'leased' "$(state_get central_account_mode)" "leased account mode"
  assert_eq 'usr_pool_intl' "$(state_get central_user_id)" "leased account user"
  assert_eq '7' "$(state_get central_account_lease_version)" "lease version"
  assert_eq '' "$(state_get central_email)" "leased account email remains private"
  assert_eq '' "$(state_get central_password)" "leased account password remains private"
  assert_eq '600' "$(stat -f '%Lp' "$STATE_FILE" 2>/dev/null || stat -c '%a' "$STATE_FILE")" "private lease state mode"
)

test_lease_renewal_failure_reuses_still_valid_session() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/account-lease-renewal-fallback" PERSONAL_DEV_SITE=intl
  unset PERSONAL_DEV_SESSION_TOKEN PERSONAL_DEV_EMAIL PERSONAL_DEV_PASSWORD
  source "$SCRIPT"
  prepare_state
  state_set central_account_mode leased
  state_set central_session_token 'still-valid-lease-session-abcdefghijklmnopqrstuvwxyz'
  account_lease_needs_renewal() { return 0; }
  discover_devcloud_ip() { printf '%s\n' '21.214.48.147'; }
  curl_with_token() { return 0; }
  curl() { return 22; }

  local token errors="$TEST_ROOT/account-lease-renewal-fallback.err"
  if ! token="$(central_session 2>"$errors")"; then
    fail "central_session discarded a still-valid session after renewal failed"
  fi
  assert_eq 'still-valid-lease-session-abcdefghijklmnopqrstuvwxyz' "$token" "lease renewal fallback session"
  grep -Fq 'reusing the still-valid session until its TTL expires' "$errors" \
    || fail "lease renewal fallback was not reported"
)

test_lease_renewal_proves_current_session_ownership() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/account-lease-renewal-auth" PERSONAL_DEV_SITE=intl
  unset PERSONAL_DEV_SESSION_TOKEN PERSONAL_DEV_EMAIL PERSONAL_DEV_PASSWORD
  source "$SCRIPT"
  prepare_state
  state_set central_account_mode leased
  state_set central_session_token 'current-lease-session-abcdefghijklmnopqrstuvwxyz'
  discover_devcloud_ip() { printf '%s\n' '21.214.48.147'; }
  curl() { fail "lease renewal fell back to an unauthenticated request"; }
  curl_with_token() {
    assert_eq 'current-lease-session-abcdefghijklmnopqrstuvwxyz' "$1" "lease renewal authorization token"
    shift
    [[ " $* " == *' --data-binary '*"@$STATE_ROOT/"* ]] || fail "lease renewal request body was not submitted"
    printf '%s\n' '{"userId":"usr_pool_intl","sessionToken":"renewed-lease-session-abcdefghijklmnopqrstuvwxyz","sessionExpiresAt":"2099-01-01T00:00:00Z","leaseExpiresAt":"2099-01-01T00:00:00Z","leaseVersion":8}'
  }

  acquire_central_account_lease >/dev/null
  assert_eq 'renewed-lease-session-abcdefghijklmnopqrstuvwxyz' "$(state_get central_session_token)" "renewed lease session"
  assert_eq '8' "$(state_get central_account_lease_version)" "renewed lease version"
)

test_expired_lease_session_reclaims_anonymously_after_server_rejects_renewal() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/account-lease-expired-session" PERSONAL_DEV_SITE=intl
  unset PERSONAL_DEV_SESSION_TOKEN PERSONAL_DEV_EMAIL PERSONAL_DEV_PASSWORD
  source "$SCRIPT"
  prepare_state
  state_set central_account_mode leased
  state_set central_session_token 'expired-lease-session-abcdefghijklmnopqrstuvwxyz'
  discover_devcloud_ip() { printf '%s\n' '21.214.48.147'; }
  curl_with_token() {
    printf '%s\n' '{"code":"session_expired","message":"expired"}'
    return 22
  }
  curl() {
    printf '%s\n' '{"userId":"usr_pool_intl","sessionToken":"reclaimed-lease-session-abcdefghijklmnopqrstuvwxyz","sessionExpiresAt":"2099-01-01T00:00:00Z","leaseExpiresAt":"2099-01-01T00:00:00Z","leaseVersion":9}'
  }

  acquire_central_account_lease >/dev/null
  assert_eq 'reclaimed-lease-session-abcdefghijklmnopqrstuvwxyz' "$(state_get central_session_token)" "reclaimed lease session"
  assert_eq '9' "$(state_get central_account_lease_version)" "reclaimed lease version"
)

test_local_identity_preserves_central_credentials_and_expired_session_reauthenticates() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/credential-separation" PERSONAL_DEV_SITE=intl
  unset PERSONAL_DEV_SESSION_TOKEN PERSONAL_DEV_EMAIL PERSONAL_DEV_PASSWORD PERSONAL_DEV_LOCAL_EMAIL PERSONAL_DEV_LOCAL_PASSWORD
  source "$SCRIPT"
  prepare_state
  state_set central_email 'managed@example.com'
  state_set central_password 'managed-password' # pragma: allowlist secret
  state_set central_session_token 'expired-testing-session' # pragma: allowlist secret

  prepare_local_credentials
  [[ "$LOCAL_IDENTITY_EMAIL" == lv-local-*@example.com ]] \
    || fail "local identity was not generated independently"
  [[ "$LOCAL_IDENTITY_EMAIL" != "$(state_get central_email)" ]] \
    || fail "local identity reused the central email"

  local request_body="$TEST_ROOT/credential-separation-signin.json"
  curl_with_token() { return 1; }
  curl() {
    local previous='' arg
    for arg in "$@"; do
      if [[ "$previous" == '--data-binary' && "$arg" == @* ]]; then
        cp "${arg#@}" "$request_body"
      fi
      previous="$arg"
    done
    printf '%s\n' '{"session":{"sessionToken":"fresh-testing-session"}}'
  }

  assert_eq 'fresh-testing-session' "$(central_session)" "expired central session reauthentication"
  python3 - "$request_body" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["email"] == "managed@example.com", payload
assert payload["password"] == "managed-password", payload
PY
  assert_eq 'managed@example.com' "$(state_get central_email)" "central email after reauthentication"
  assert_eq 'managed-password' "$(state_get central_password)" "central password after reauthentication"
  assert_eq "$LOCAL_IDENTITY_EMAIL" "$(state_get local_email)" "local email after reauthentication"
  assert_eq "$LOCAL_IDENTITY_PASSWORD" "$(state_get local_password)" "local password after reauthentication"
)

test_legacy_local_identity_is_not_used_as_central_login() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/legacy-local-state" PERSONAL_DEV_SITE=intl
  unset PERSONAL_DEV_SESSION_TOKEN PERSONAL_DEV_EMAIL PERSONAL_DEV_PASSWORD PERSONAL_DEV_LOCAL_EMAIL PERSONAL_DEV_LOCAL_PASSWORD
  source "$SCRIPT"
  prepare_state
  state_set email 'lv-local-old@example.com'
  state_set password 'legacy-local-password' # pragma: allowlist secret
  state_set central_user_id 'usr_existing'
  state_set central_session_token 'expired-testing-session' # pragma: allowlist secret
  curl_with_token() { return 1; }
  curl() {
    fail "legacy local identity was submitted to central Auth"
  }

  if (central_session) >/dev/null 2>&1; then
    fail "legacy local identity unexpectedly authenticated as the central user"
  fi
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

test_doctor_reuses_bootstrapped_private_tools() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/doctor-private-tools" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_IP='21.214.48.147'
  source "$SCRIPT"
  prepare_state
  : >"$KUBECONFIG_FILE"
  local tool
  for tool in kubectl kind kustomize; do
    cat >"$TOOLS_DIR/$tool" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "config current-context") printf '%s\n' 'kind-lightvela-personal-intl' ;;
  *".context.cluster}"*) printf '%s\n' 'lightvela-personal-intl' ;;
  *".cluster.server}"*) printf '%s\n' 'https://127.0.0.1:53421' ;;
esac
EOF
    chmod 700 "$TOOLS_DIR/$tool"
  done
  docker() {
    case "$*" in
      info) return 0 ;;
      "version --format {{.Server.Arch}}") printf '%s\n' 'amd64' ;;
      *) return 1 ;;
    esac
  }
  PATH="$(dirname "$(type -P bash)"):$(dirname "$(type -P curl)"):/usr/bin:/bin" ensure_tools >/dev/null 2>&1
  PATH="$(dirname "$(type -P bash)"):$(dirname "$(type -P curl)"):/usr/bin:/bin" doctor >/dev/null 2>&1
)

# 真实踩过：/data 只剩 977M 时 `up` 一路跑到 frontend 镜像的最后一层才炸
# "no space left on device"，前面 40 分钟的构建全部白费，新同学完全看不懂。
# 预检必须在 doctor 阶段就 fail fast，并给出可执行的清理指引。
test_disk_preflight_blocks_up_before_image_builds() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/disk-preflight-low" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_IP='21.214.48.147'
  local out=""
  source "$SCRIPT"
  prepare_state
  docker() {
    case "$*" in
      "info --format {{.DockerRootDir}}") printf '%s\n' "$PERSONAL_DEV_STATE_DIR" ;;
      *) return 0 ;;
    esac
  }
  df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/vdb 51200000 50200000 1000000 99%% /data\n'; }
  if out="$(ensure_docker_disk_headroom 2>&1)"; then
    fail "disk preflight passed with under 1Gi free"
  fi
  case "$out" in
    *"insufficient docker disk headroom"*) ;;
    *) fail "disk preflight did not explain the failure: $out" ;;
  esac
  case "$out" in
    *"docker image prune"*) ;;
    *) fail "disk preflight did not hand out a reclaim command: $out" ;;
  esac
)

test_disk_preflight_allows_enough_headroom_and_is_overridable() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/disk-preflight-ok" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_IP='21.214.48.147'
  source "$SCRIPT"
  prepare_state
  docker() {
    case "$*" in
      "info --format {{.DockerRootDir}}") printf '%s\n' "$PERSONAL_DEV_STATE_DIR" ;;
      *) return 0 ;;
    esac
  }
  df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/vdb 51200000 20000000 31200000 40%% /data\n'; }
  ( ensure_docker_disk_headroom ) >/dev/null 2>&1 \
    || fail "disk preflight blocked a host with ~29Gi free"
  df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/vdb 51200000 47000000 4200000 92%% /data\n'; }
  if ( ensure_docker_disk_headroom ) >/dev/null 2>&1; then
    fail "default threshold accepted ~4Gi free"
  fi
  ( REQUIRED_DOCKER_FREE_GIB=2; ensure_docker_disk_headroom ) >/dev/null 2>&1 \
    || fail "PERSONAL_DEV_REQUIRED_DOCKER_FREE_GIB override was ignored"
)

test_port_forward_supervisor_restarts_and_stops_child() (
  local supervisor="$REPO_ROOT/deploy/localstack/port-forward-supervisor.sh"
  local test_dir="$TEST_ROOT/port-forward-supervisor"
  local fake_command="$test_dir/fake-port-forward.sh"
  local count_file="$test_dir/count"
  local child_pid_file="$test_dir/child.pid"
  local log_file="$test_dir/port-forward.log"
  local supervisor_pid child_pid count
  mkdir -p "$test_dir"
  printf '0\n' >"$count_file"
  cat >"$fake_command" <<'EOF'
#!/usr/bin/env bash
set -u
count="$(<"$1")"
count=$((count + 1))
printf '%s\n' "$count" >"$1"
if ((count == 1)); then
  exit 42
fi
printf '%s\n' "$$" >"$2"
trap 'exit 0' HUP INT TERM
while true; do sleep 1; done
EOF
  chmod 700 "$fake_command"
  LOCALSTACK_PORT_FORWARD_RESTART_DELAY_SECONDS=0.05 \
    "$supervisor" "$log_file" "$fake_command" "$count_file" "$child_pid_file" &
  supervisor_pid=$!
  for _ in $(seq 1 100); do
    [[ -s "$child_pid_file" ]] && break
    sleep 0.05
  done
  [[ -s "$child_pid_file" ]] || fail "port-forward supervisor did not restart the failed command"
  count="$(<"$count_file")"
  ((count >= 2)) || fail "port-forward supervisor restart count was $count"
  child_pid="$(<"$child_pid_file")"
  kill -0 "$child_pid" >/dev/null 2>&1 || fail "restarted port-forward child is not running"
  kill "$supervisor_pid"
  wait "$supervisor_pid" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    ! kill -0 "$child_pid" >/dev/null 2>&1 && break
    sleep 0.05
  done
  ! kill -0 "$child_pid" >/dev/null 2>&1 || fail "supervisor left the port-forward child running"
)

# 跨 checkout 串台回归。
#
# 真实踩过：旧 intl checkout 的 port-forward 还占着 8085，新 checkout 起 cn 时本地 sign-up
# 打到了 intl 的 Auth，用户落在 intl 库、shadow binding 写进 cn 库，最后炸外键。站点互斥必须
# 看主机端口归属，不能只看 checkout 内的 current-site。
start_foreign_port_holder() {
  local port="$1" pid_file="$2" holder="$3" i
  cat >"$holder" <<'EOF'
#!/usr/bin/env bash
set -u
exec python3 - "$1" <<'PY'
import socket, sys, time
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", int(sys.argv[1])))
server.listen(1)
while True:
    time.sleep(1)
PY
EOF
  chmod 700 "$holder"
  "$holder" "$port" >/dev/null 2>&1 </dev/null &
  printf '%s\n' "$!" >"$pid_file"
  for i in $(seq 1 100); do
    if python3 - "$port" <<'PY'
import socket, sys
probe = socket.socket()
probe.settimeout(0.2)
raise SystemExit(0 if probe.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
    then
      return 0
    fi
    sleep 0.05
  done
  return 1
}

free_tcp_port() {
  python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

test_foreign_checkout_port_holder_blocks_site_activation() (
  local state_base="$TEST_ROOT/host-port-guard" port pid_file holder holder_pid output=""
  mkdir -p "$state_base"
  port="$(free_tcp_port)"
  pid_file="$state_base/holder.pid"
  holder="$state_base/holder.sh"
  start_foreign_port_holder "$port" "$pid_file" "$holder" || fail "could not start the foreign port holder"
  holder_pid="$(<"$pid_file")"
  export PERSONAL_DEV_STATE_DIR="$state_base" PERSONAL_DEV_SITE=cn
  export PERSONAL_DEV_GATEWAY_PORT="$port"
  source "$SCRIPT"
  prepare_state
  if output="$(ensure_site_activation_safe 2>&1)"; then
    kill "$holder_pid" >/dev/null 2>&1 || true
    fail "a foreign process holding the gateway port did not block site activation"
  fi
  kill "$holder_pid" >/dev/null 2>&1 || true
  wait "$holder_pid" >/dev/null 2>&1 || true
  [[ "$output" == *"another personal DevCloud stack"* ]] \
    || fail "port conflict message did not name the competing stack: $output"
  [[ "$output" == *"port $port is held by pid"* ]] \
    || fail "port conflict message did not identify the holder: $output"
)

test_site_activation_allows_own_context_port_forward() (
  local state_base="$TEST_ROOT/host-port-own" port pid_file holder holder_pid
  mkdir -p "$state_base"
  port="$(free_tcp_port)"
  pid_file="$state_base/holder.pid"
  holder="$state_base/holder.sh"
  start_foreign_port_holder "$port" "$pid_file" "$holder" || fail "could not start the port holder"
  holder_pid="$(<"$pid_file")"
  export PERSONAL_DEV_STATE_DIR="$state_base" PERSONAL_DEV_SITE=cn
  export PERSONAL_DEV_GATEWAY_PORT="$port"
  source "$SCRIPT"
  prepare_state
  host_process_cmdline() {
    printf 'kubectl --context %s port-forward -n lightclaw-gateway service/service-gateway ' "$KUBE_CONTEXT"
  }
  if ! (ensure_site_activation_safe) >/dev/null 2>&1; then
    kill "$holder_pid" >/dev/null 2>&1 || true
    fail "this site's own port-forward was treated as a conflict"
  fi
  kill "$holder_pid" >/dev/null 2>&1 || true
  wait "$holder_pid" >/dev/null 2>&1 || true
)

test_localstack_exposure_ports_are_overridable() (
  local ports
  ports="$(LOCALSTACK_SITE_KIND=cn LOCALSTACK_PUBLIC_HOST=127.0.0.1 \
    LOCALSTACK_FRONTEND_PORT=15173 LOCALSTACK_GATEWAY_PORT=18085 \
    LOCALSTACK_TRADE_CALLBACK_PORT=18184 LOCALSTACK_TRADE_INTERNAL_PORT=28184 \
    bash -c '
      source "$1" >/dev/null 2>&1 || true
      printf "%s\n" "${exposure_specs[@]}"
    ' bash "$REPO_ROOT/deploy/localstack/localstack.sh" 2>/dev/null)"
  [[ "$ports" == *"|15173:8080|"* ]] || fail "frontend port override was ignored: $ports"
  [[ "$ports" == *"|18085:80|"* ]] || fail "gateway port override was ignored: $ports"
  [[ "$ports" == *"|18184:80|"* ]] || fail "trade callback port override was ignored: $ports"
  [[ "$ports" == *"|28184:80|"* ]] || fail "trade internal port override was ignored: $ports"
)

test_exposure_fails_when_port_is_held_by_another_stack() (
  local state_base="$TEST_ROOT/exposure-conflict" port pid_file holder holder_pid output=""
  mkdir -p "$state_base"
  port="$(free_tcp_port)"
  pid_file="$state_base/holder.pid"
  holder="$state_base/holder.sh"
  start_foreign_port_holder "$port" "$pid_file" "$holder" || fail "could not start the foreign port holder"
  holder_pid="$(<"$pid_file")"
  if output="$(LOCALSTACK_SITE_KIND=cn LOCALSTACK_PUBLIC_HOST=127.0.0.1 \
    LOCALSTACK_GATEWAY_PORT="$port" \
    bash -c '
      source "$1" >/dev/null 2>&1 || true
      ensure_exposure_ports_free kind-lightvela-personal-cn
    ' bash "$REPO_ROOT/deploy/localstack/localstack.sh" 2>&1)"; then
    kill "$holder_pid" >/dev/null 2>&1 || true
    fail "exposure did not fail closed on a foreign port holder"
  fi
  kill "$holder_pid" >/dev/null 2>&1 || true
  wait "$holder_pid" >/dev/null 2>&1 || true
  [[ "$output" == *"another stack already owns the ports above"* ]] \
    || fail "exposure conflict message was not actionable: $output"
)

test_auth_override_is_sandbox_only() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/auth-allowlist" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_AUTH_BASE_URL='https://api.lightvela.ai'
  source "$SCRIPT"
  if (configure_site) >/dev/null 2>&1; then
    fail "production Auth override was accepted"
  fi
)

test_auth_admin_override_is_loopback_only() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/auth-admin-allowlist" PERSONAL_DEV_SITE=cn
  export PERSONAL_DEV_AUTH_ADMIN_BASE_URL='http://10.0.0.8:38081'
  source "$SCRIPT"
  if (configure_site) >/dev/null 2>&1; then
    fail "non-loopback Auth admin override was accepted"
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

test_devcloud_ip_accepts_current_networks_and_rejects_unsafe_overrides() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/devcloud-ip" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state

  PERSONAL_DEV_IP='9.134.214.121'
  assert_eq '9.134.214.121' "$(discover_devcloud_ip)" "legacy DevCloud IP"
  PERSONAL_DEV_IP='21.214.48.147'
  assert_eq '21.214.48.147' "$(discover_devcloud_ip)" "current DevCloud IP"

  for unsafe_ip in 127.0.0.1 14.22.11.161 2001:db8::1 not-an-ip; do
    PERSONAL_DEV_IP="$unsafe_ip"
    if discover_devcloud_ip >/dev/null 2>&1; then
      fail "unsafe DevCloud IP override was accepted: $unsafe_ip"
    fi
  done
)

test_intl_registration_starts_tunnel() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/intl-register" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_IP='21.214.48.147'
  export PERSONAL_DEV_REGISTRATION_SOURCE_IP='14.22.11.161'
  source "$SCRIPT"
  prepare_state
  state_set uin '450860000013'
  require_personal_context() { :; }
  central_session() { printf 'session-token\n'; }
  curl() { return 0; }
  curl_with_token() {
    printf '%s\n' "$*" >"$TEST_ROOT/intl-registration-request"
    printf '%s\n' '{"uin":450860000013,"status":"active","targetIp":"14.22.11.161","port":18084,"tunnelHost":"uin-450860000013.sg.tunnel.internal","tunnelToken":"lvdt1.450860000013.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","expiresAt":"2099-01-01T00:00:00Z"}'
  }
  ensure_devtunnel_agent() { printf '%s|%s\n' "$1" "$2" >"$TEST_ROOT/intl-tunnel-assignment"; }
  install_billing_capability() { printf '%s\n' "$1" >"$TEST_ROOT/intl-billing-capability"; }
  register_route
  assert_eq 'uin-450860000013.sg.tunnel.internal|lvdt1.450860000013.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' \
    "$(<"$TEST_ROOT/intl-tunnel-assignment")" "tunnel assignment passed to agent"
  assert_eq 'lvdt1.450860000013.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' \
    "$(<"$TEST_ROOT/intl-billing-capability")" "billing capability installed"
  assert_eq 'active' "$(state_get registration_status)" "intl registration status"
  ! grep -q '"targetIp"' "$TEST_ROOT/intl-registration-request"
  ! grep -q '"uin"' "$TEST_ROOT/intl-registration-request"
  assert_eq '14.22.11.161' "$(state_get registration_target_ip)" "server-confirmed Intl NAT source IP"
  ! grep -Eq 'lvdt1\.450860000013|tunnelToken' "$STATE_FILE"
)

test_intl_registration_source_override_fails_closed_on_mismatch() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/intl-source-mismatch" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_IP='21.214.48.147'
  export PERSONAL_DEV_REGISTRATION_SOURCE_IP='14.22.11.161'
  source "$SCRIPT"
  prepare_state
  state_set uin '450860000013'
  require_personal_context() { :; }
  central_session() { printf 'session-token\n'; }
  curl() { return 0; }
  curl_with_token() {
    if [[ " $* " == *' -X DELETE '* ]]; then
      printf 'disabled\n' >"$TEST_ROOT/intl-source-mismatch-delete"
      printf '%s\n' '{"uin":450860000013,"status":"disabled"}'
      return
    fi
    printf '%s\n' '{"uin":450860000013,"status":"active","targetIp":"14.22.11.162","port":18084,"tunnelHost":"uin-450860000013.sg.tunnel.internal","tunnelToken":"short-lived-registration-token","expiresAt":"2099-01-01T00:00:00Z"}'
  }
  ensure_devtunnel_agent() { fail "agent must not start for an unexpected registration source IP"; }
  if (register_route) >/dev/null 2>&1; then
    fail "Intl registration accepted an unexpected server-confirmed source IP"
  fi
  [[ -s "$TEST_ROOT/intl-source-mismatch-delete" ]] \
    || fail "source IP mismatch left an active developer route"
)

test_registration_failure_surfaces_safe_business_error() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/registration-error" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_IP='21.214.48.147'
  source "$SCRIPT"
  prepare_state
  state_set uin '450860000013'
  require_personal_context() { :; }
  central_session() { printf 'session-token\n'; }
  curl() { return 0; }
  curl_with_token() {
    printf '%s\n' '{"code":"target_ip_not_allowed","message":"request source IP is not allowlisted"}'
    return 22
  }
  local output
  output="$((register_route) 2>&1 || true)"
  grep -Fq 'code=target_ip_not_allowed' <<<"$output"
  grep -Fq 'message=request source IP is not allowlisted' <<<"$output"
  ! grep -Fq 'curl: (22)' <<<"$output"
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

test_cn_registration_requires_server_confirmed_devcloud_target() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/cn-register" PERSONAL_DEV_SITE=cn
  export PERSONAL_DEV_IP='21.214.48.147'
  source "$SCRIPT"
  prepare_state
  state_set uin '450860000013'
  require_personal_context() { :; }
  central_session() { printf 'session-token\n'; }
  curl() { return 0; }
  curl_with_token() {
    printf '%s\n' "$*" >"$TEST_ROOT/cn-registration-request"
    printf '%s\n' '{"uin":450860000013,"status":"active","targetIp":"21.214.48.147","port":18084,"tunnelHost":"uin-450860000013.cn.tunnel.internal","tunnelToken":"lvdt1.450860000013.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","expiresAt":"2099-01-01T00:00:00Z"}'
  }
  ensure_devtunnel_agent() { printf '%s|%s\n' "$1" "$2" >"$TEST_ROOT/cn-tunnel-assignment"; }
  install_billing_capability() { printf '%s\n' "$1" >"$TEST_ROOT/cn-billing-capability"; }
  register_route
  grep -Fq '"targetIp":"21.214.48.147"' "$TEST_ROOT/cn-registration-request"
  ! grep -q '"uin"' "$TEST_ROOT/cn-registration-request"
  assert_eq 'uin-450860000013.cn.tunnel.internal|lvdt1.450860000013.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' \
    "$(<"$TEST_ROOT/cn-tunnel-assignment")" "CN tunnel assignment"
  assert_eq '21.214.48.147' "$(state_get registration_target_ip)" "CN registration target IP"
  assert_eq '18084' "$(state_get registration_port)" "CN registration port"
  ! grep -Eq 'lvdt1\.450860000013|tunnelToken' "$STATE_FILE"
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

test_intl_status_accepts_server_confirmed_nat_source() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/status-intl-nat" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_IP='21.214.48.147'
  export PERSONAL_DEV_REGISTRATION_SOURCE_IP='14.22.11.161'
  source "$SCRIPT"
  prepare_state
  state_set central_session_token 'session-token'
  state_set uin '450860000013'
  require_personal_context() { :; }
  curl() { return 0; }
  curl_with_token() {
    printf '%s\n' '{"uin":450860000013,"status":"active","targetIp":"14.22.11.161","port":18084,"tunnelHost":"uin-450860000013.sg.tunnel.internal","expiresAt":"2099-01-01T00:00:00Z"}'
  }
  kubectl() { return 0; }
  verify_billing_capability() { return 0; }
  heartbeat_running() { return 0; }
  devtunnel_agent_running() { return 0; }
  status >/dev/null
)

test_billing_capability_rotates_without_state_persistence() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/billing-capability" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state
  state_set uin '450860000013'
  local patch_count=0
  kubectl() {
    if [[ "$*" == patch\ secret\ trade-runtime-secrets* ]]; then
      local previous='' arg patch_file=''
      for arg in "$@"; do
        if [[ "$previous" == '--patch-file' ]]; then
          patch_file="$arg"
          break
        fi
        previous="$arg"
      done
      [[ -n "$patch_file" && -f "$patch_file" ]] || fail "capability patch file was not provided"
      patch_count=$((patch_count + 1))
      cp "$patch_file" "$TEST_ROOT/billing-capability-patch-$patch_count.json"
      return 0
    fi
    [[ "$*" == rollout\ restart\ deployment/trade\ -n\ trade || "$*" == rollout\ status\ deployment/trade\ -n\ trade\ --timeout=180s ]]
  }
  local first='lvdt1.450860000013.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  local second='lvdt1.450860000013.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
  install_billing_capability "$first"
  install_billing_capability "$second"
  assert_eq '2' "$patch_count" "capability rotation patch count"
  python3 - "$TEST_ROOT/billing-capability-patch-1.json" "$TEST_ROOT/billing-capability-patch-2.json" "$first" "$second" <<'PY'
import base64, json, sys

first_path, second_path, first, second = sys.argv[1:]
def capability(path):
    payload = json.load(open(path, encoding="utf-8"))
    data = payload["data"]
    assert base64.b64decode(data["PERSONAL_DEV_BILLING_PROXY_URL"]).decode().endswith("/auth/dev-environments/billing-proxy")
    return base64.b64decode(data["PERSONAL_DEV_BILLING_CAPABILITY"]).decode()

assert capability(first_path) == first
assert capability(second_path) == second
PY
  ! grep -Fq "$first" "$STATE_FILE"
  ! grep -Fq "$second" "$STATE_FILE"
)

test_billing_capability_readiness_requires_json_200() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/billing-readiness" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state
  current_billing_capability() {
    printf '%s\n' 'lvdt1.450860000013.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'
  }
  local response_body='{"code":"OK","message":"ready"}' response_status='200'
  curl() {
    local previous='' arg output_file=''
    for arg in "$@"; do
      if [[ "$previous" == '--output' ]]; then
        output_file="$arg"
        break
      fi
      previous="$arg"
    done
    [[ -n "$output_file" ]] || fail "readiness probe did not capture its response body"
    printf '%s' "$response_body" >"$output_file"
    printf '%s' "$response_status"
  }
  verify_billing_capability || fail "HTTP 200 readiness response was rejected"
  response_body='<html>upstream error</html>'
  if verify_billing_capability; then
    fail "non-JSON HTTP 200 readiness response was accepted"
  fi
  response_body='{"code":"OK","message":"not_ready"}'
  if verify_billing_capability; then
    fail "unexpected JSON HTTP 200 readiness response was accepted"
  fi
  response_status='204'
  response_body=''
  if verify_billing_capability; then
    fail "legacy empty HTTP 204 readiness response was accepted"
  fi
)

test_unregister_requires_old_billing_capability_revocation() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/unregister-capability" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state
  state_set uin '450860000013'
  state_set registration_status active
  current_billing_capability() {
    printf '%s\n' 'lvdt1.450860000013.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
  }
  central_session() { printf '%s\n' 'session-token'; }
  stop_heartbeat() { :; }
  stop_devtunnel_agent() { :; }
  curl_with_token() {
    [[ " $* " == *' -X DELETE '* ]] || return 1
    printf '%s\n' '{"uin":450860000013,"status":"disabled","expiresAt":"2026-09-22T12:00:00Z"}'
  }
  curl() {
    [[ "$*" == *'/auth/dev-environments/billing-proxy/cloudapi/?Action=DescribeOrderList'* ]] || return 1
    printf 'revocation-probed\n' >"$TEST_ROOT/unregister-capability-probed"
    printf '401'
  }
  unregister >/dev/null
  [[ -s "$TEST_ROOT/unregister-capability-probed" ]] || fail "unregister did not verify capability revocation"
  assert_eq 'disabled' "$(state_get registration_status)" "unregister state"
)

test_release_binding_unregisters_before_releasing_leased_account() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/release-leased-binding" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state
  state_set central_account_mode leased
  local events="$TEST_ROOT/release-leased-binding-events"
  unregister() { printf '%s\n' unregister >>"$events"; }
  release_account_lease() { printf '%s\n' release >>"$events"; }

  release_binding
  assert_eq $'unregister\nrelease' "$(<"$events")" "leased binding cleanup order"
)

test_release_binding_keeps_lease_when_unregister_fails() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/release-leased-binding-failure" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state
  state_set central_account_mode leased
  local events="$TEST_ROOT/release-leased-binding-failure-events"
  unregister() { printf '%s\n' unregister >>"$events"; return 1; }
  release_account_lease() { printf '%s\n' release >>"$events"; }

  if release_binding >/dev/null 2>&1; then
    fail "leased binding release ignored unregister failure"
  fi
  assert_eq 'unregister' "$(<"$events")" "failed unregister must retain lease"
)

test_invalid_release_response_returns_to_caller_for_ttl_fallback() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/release-invalid-response" PERSONAL_DEV_SITE=intl
  source "$SCRIPT"
  prepare_state
  state_set central_account_mode leased
  state_set central_session_token 'still-valid-lease-session-abcdefghijklmnopqrstuvwxyz'
  state_set devcloud_ip '21.214.48.147'
  curl_with_token() { printf '%s\n' '{"released":false}'; }

  local marker errors="$TEST_ROOT/release-invalid-response.err"
  if ! marker="$({
    if release_account_lease 2>"$errors"; then
      fail "invalid release response was accepted"
    fi
    printf '%s' continued
  })"; then
    fail "invalid release response terminated the caller instead of falling back to TTL"
  fi
  assert_eq 'continued' "$marker" "release failure caller continuation"
  assert_eq 'leased' "$(state_get central_account_mode)" "invalid release response lease state"
  assert_eq 'still-valid-lease-session-abcdefghijklmnopqrstuvwxyz' "$(state_get central_session_token)" "invalid release response session state"
  grep -Fq 'lease will expire by TTL' "$errors" \
    || fail "invalid release response did not report the TTL fallback"
)

test_down_unregisters_then_releases_before_stopping_stack() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/down-cleanup-order" PERSONAL_DEV_SITE=cn
  source "$SCRIPT"
  prepare_state
  state_set central_account_mode leased
  local events="$TEST_ROOT/down-cleanup-order-events"
  local fake_localstack="$TEST_ROOT/fake-localstack-down"
  cat >"$fake_localstack" <<EOF
#!/usr/bin/env bash
printf '%s\n' localstack >>'$events'
EOF
  chmod 700 "$fake_localstack"
  LOCALSTACK="$fake_localstack"
  stop_browser_bootstrap() { :; }
  unregister_for_down() { printf '%s\n' unregister >>"$events"; }
  release_account_lease() { printf '%s\n' release >>"$events"; }
  require_personal_context() { :; }
  command() {
    case "${2:-}" in
      kubectl) printf '%s\n' /usr/bin/kubectl ;;
      kustomize) printf '%s\n' /usr/bin/kustomize ;;
      *) builtin command "$@" ;;
    esac
  }

  down
  assert_eq $'unregister\nrelease\nlocalstack' "$(<"$events")" "down cleanup order"
)

test_down_after_release_binding_does_not_reacquire_account() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/down-after-release-binding" PERSONAL_DEV_SITE=cn
  source "$SCRIPT"
  prepare_state
  state_set central_account_mode released
  state_set registration_status disabled
  local events="$TEST_ROOT/down-after-release-binding-events"
  local fake_localstack="$TEST_ROOT/fake-localstack-released"
  cat >"$fake_localstack" <<EOF
#!/usr/bin/env bash
printf '%s\n' localstack >>'$events'
EOF
  chmod 700 "$fake_localstack"
  LOCALSTACK="$fake_localstack"
  stop_browser_bootstrap() { :; }
  unregister_for_down() { printf '%s\n' reacquired >>"$events"; return 1; }
  release_account_lease() { printf '%s\n' release >>"$events"; }
  require_personal_context() { :; }
  command() {
    case "${2:-}" in
      kubectl) printf '%s\n' /usr/bin/kubectl ;;
      kustomize) printf '%s\n' /usr/bin/kustomize ;;
      *) builtin command "$@" ;;
    esac
  }

  down
  assert_eq 'localstack' "$(<"$events")" "released account down must not reacquire"
)

test_intl_active_registration_accepts_server_confirmed_nat_source() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/active-registration-intl-nat" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_IP='21.214.48.147'
  export PERSONAL_DEV_REGISTRATION_SOURCE_IP='14.22.11.161'
  source "$SCRIPT"
  prepare_state
  central_session() { printf '%s\n' 'session-token'; }
  curl_with_token() {
    printf '%s\n' '{"uin":450860000013,"status":"active","targetIp":"14.22.11.161","port":18084,"tunnelHost":"uin-450860000013.sg.tunnel.internal","expiresAt":"2099-01-01T00:00:00Z"}'
  }
  devtunnel_agent_running() { [[ "$1" == 'uin-450860000013.sg.tunnel.internal' ]]; }
  require_active_registration
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
  export PERSONAL_DEV_RUNTIME_BILLING_APIGW_URL=http://billing-gateway.example/v1/proxy/jifei-billing-apigw-test/resource-center/interface
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
  grep -Fq 'JIFEI_BILLING_APIGW_URL: "http://billing-gateway.example/v1/proxy/jifei-billing-apigw-test/resource-center/interface"' "$trade_render"
  grep -Fq 'TRADE_BILLING_PAY_REDIRECT_URL: "http://9.134.214.121:5173/subscribe"' "$trade_render"
  grep -Fq 'LIGHTVELA_TRADE_REGION: "ap-singapore"' "$trade_render"
  grep -Fq 'LIGHTVELA_SITE_KIND: "intl"' "$ctl_render"
  ! grep -q '9.134.214.121' "$REPO_ROOT/deploy/localstack/auth/kustomization.yaml"
  ! grep -q 'testing-gateway.example' "$REPO_ROOT/deploy/localstack/trade/kustomization.yaml"
)

test_billing_apigw_rejects_non_testing_routes() {
  if PERSONAL_DEV_STATE_DIR="$TEST_ROOT/billing-apigw-prod" \
    PERSONAL_DEV_SITE=intl \
    PERSONAL_DEV_BILLING_APIGW_URL=http://billing.example/v1/proxy/jifei-billing-apigw-prod/resource-center/interface \
    bash -c 'source "$1"; prepare_state' bash "$SCRIPT" >/dev/null 2>&1; then
    fail "production Billing APIGW route was accepted"
  fi
}

test_prerequisites_document_account_balance_binding_and_capability() {
  local cn_output intl_output
  cn_output="$(PERSONAL_DEV_SITE=cn bash -c 'source "$1"; prerequisites' bash "$SCRIPT")"
  intl_output="$(PERSONAL_DEV_SITE=intl bash -c 'source "$1"; prerequisites' bash "$SCRIPT")"

  grep -Fq 'resource/account/4/' <<<"$cn_output"
  grep -Fq '状态=正常' <<<"$cn_output"
  grep -Fq '/充值' <<<"$cn_output"
  grep -Fq 'DevCloud 测试绑定' <<<"$cn_output"
  grep -Fq '短期 capability' <<<"$cn_output"
  grep -Fq '不需要 SOPS' <<<"$cn_output"
  grep -Fq '自动租用合法 testing 账号' <<<"$cn_output"
  grep -Fq '无需 SOPS、owner 文件' <<<"$cn_output"
  grep -Fq 'international=false' <<<"$cn_output"
  grep -Fq '不执行 /国际开户' <<<"$cn_output"
  grep -Fq '已实名且 active binding 的国内 testing 用户' <<<"$cn_output"

  grep -Fq 'international=true' <<<"$intl_output"
  grep -Fq '/国际开户' <<<"$intl_output"
  grep -Fq '已开户映射且 active binding 的国际 testing 用户' <<<"$intl_output"
  ! grep -Fq '已实名且 active binding 的 testing 用户' <<<"$intl_output"
  grep -Fq '/充值' <<<"$intl_output"
  grep -Fq '金额单位为分' <<<"$intl_output"
  grep -Fq '旧 pending 单不要重试' <<<"$intl_output"
}

test_real_kustomize_rejects_runtime_wrapper_alias() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/kustomize-alias" PERSONAL_DEV_SITE=intl
  local bin_dir="$TEST_ROOT/kustomize-alias-bin"
  mkdir -p "$bin_dir"
  ln -s "$RUNTIME_KUSTOMIZE" "$bin_dir/kustomize"
  if PATH="$bin_dir:$PATH" \
    PERSONAL_DEV_STATE_DIR="$PERSONAL_DEV_STATE_DIR" \
    PERSONAL_DEV_SITE=intl \
    bash -c 'source "$1"; prepare_state; real_kustomize_binary' bash "$SCRIPT" >/dev/null 2>&1; then
    fail "runtime kustomize wrapper was accepted as the real binary"
  fi
)

test_browser_login_is_minted_privately() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/browser-login" PERSONAL_DEV_SITE=intl
  export PERSONAL_DEV_IP=21.214.48.147 PERSONAL_DEV_BROWSER_SESSION_TTL_SECONDS=900
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
  local output output_file url headers pid first_pid curl_bin blocker_pid blocker_ready
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
  [[ "$url" =~ ^http://21\.214\.48\.147:[0-9]+/[A-Za-z0-9_-]{24,128}$ ]] \
    || fail "one-time browser URL is malformed: $url"
  [[ "$url" != *private-token* ]] || fail "one-time URL leaked the browser session token"
  pid="$(<"$BROWSER_BOOTSTRAP_PID_FILE")"
  local bootstrap_port bootstrap_path local_url
  bootstrap_port="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.urlparse(sys.argv[1]).port)' "$url")"
  bootstrap_path="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.urlparse(sys.argv[1]).path)' "$url")"
  local_url="http://127.0.0.1:$bootstrap_port$bootstrap_path"
  blocker_ready="$TEST_ROOT/browser-partial-connection-ready"
  python3 - "$bootstrap_port" "$blocker_ready" <<'PY' &
import pathlib
import socket
import sys
import time

port = int(sys.argv[1])
ready = pathlib.Path(sys.argv[2])
with socket.create_connection(("127.0.0.1", port), timeout=2) as connection:
    ready.write_text("ready\n", encoding="utf-8")
    time.sleep(3)
PY
  blocker_pid=$!
  for _ in $(seq 1 40); do
    [[ -s "$blocker_ready" ]] && break
    sleep 0.05
  done
  [[ -s "$blocker_ready" ]] || fail "partial browser connection was not established"
  headers="$("$curl_bin" --silent --show-error --max-time 2 --dump-header - --output /dev/null "$local_url")"
  grep -q '^HTTP/1\.[01] 303 ' <<<"$headers"
  grep -Fq 'Location: http://21.214.48.147:5173/dashboard/settings#session_token=private-token' <<<"$headers"
  wait "$blocker_pid"
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

test_testing_binding_bootstrap_uses_session_identity_without_persisting_admin_token() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/binding-bootstrap" PERSONAL_DEV_SITE=cn
  export PERSONAL_DEV_ADMIN_TOKEN='managed-admin-token' # pragma: allowlist secret
  export PERSONAL_DEV_SHADOW_USER_NAME='mock_personal_dev'
  export PERSONAL_DEV_SHADOW_UIN='450860000013'
  export PERSONAL_DEV_SHADOW_OWNER_UIN='450860000013'
  export PERSONAL_DEV_SHADOW_APP_ID='1250000000'
  export PERSONAL_DEV_BINDING_REASON='personal DevCloud testing'
  source "$SCRIPT"
  prepare_state
  central_session() { printf '%s\n' 'testing-user-session'; }
  curl_with_token() {
    local token="$1"
    shift
    if [[ "$token" == 'testing-user-session' ]]; then
      printf '%s\n' '{"session":{"user":{"id":"usr_testing_1"}}}'
      return
    fi
    assert_eq 'managed-admin-token' "$token" "admin token"
    local previous='' arg
    for arg in "$@"; do
      if [[ "$previous" == '--data-binary' && "$arg" == @* ]]; then
        cp "${arg#@}" "$TEST_ROOT/binding-bootstrap-request.json"
      fi
      previous="$arg"
    done
    printf '%s\n' '{"userId":"usr_testing_1","shadowUserName":"mock_personal_dev","uin":450860000013,"ownerUin":450860000013,"appId":1250000000,"status":"active"}'
  }

  local output
  output="$(bootstrap_binding)"
  grep -q '"status":"active"' <<<"$output"
  python3 - "$TEST_ROOT/binding-bootstrap-request.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    body = json.load(fh)
assert body == {
    "userId": "usr_testing_1",
    "shadowUserName": "mock_personal_dev",
    "uin": 450860000013,
    "ownerUin": 450860000013,
    "appId": 1250000000,
    "reason": "personal DevCloud testing",
}, body
PY
  ! grep -Rq 'managed-admin-token' "$STATE_ROOT"
  ! grep -q 'managed-admin-token' <<<"$output"
)

test_wait_for_binding_bootstraps_when_managed_inputs_are_present() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/binding-auto" PERSONAL_DEV_SITE=cn
  export PERSONAL_DEV_ADMIN_TOKEN='managed-admin-token' # pragma: allowlist secret
  export PERSONAL_DEV_SHADOW_USER_NAME='mock_personal_dev'
  export PERSONAL_DEV_SHADOW_UIN='450860000013'
  export PERSONAL_DEV_SHADOW_OWNER_UIN='450860000013'
  export PERSONAL_DEV_SHADOW_APP_ID='1250000000'
  export PERSONAL_DEV_BINDING_REASON='personal DevCloud testing'
  source "$SCRIPT"
  prepare_state
  curl_with_token() {
    local token="$1"
    shift
    if [[ "$token" == 'testing-user-session' && "$*" == *'/auth/shadow/binding'* ]]; then
      printf '%s\n' '{"binding":{"status":"missing"}}'
      return
    fi
    if [[ "$token" == 'testing-user-session' && "$*" == *'/auth/session'* ]]; then
      printf '%s\n' '{"session":{"user":{"id":"usr_testing_1"}}}'
      return
    fi
    printf '%s\n' '{"userId":"usr_testing_1","shadowUserName":"mock_personal_dev","uin":450860000013,"ownerUin":450860000013,"appId":1250000000,"status":"active"}'
  }

  local binding
  binding="$(wait_for_binding 'testing-user-session')"
  python3 -c 'import json,sys; assert json.load(sys.stdin)["binding"]["status"] == "active"' <<<"$binding"
)

test_testing_binding_release_derives_user_and_keeps_admin_token_private() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/binding-release" PERSONAL_DEV_SITE=cn
  export PERSONAL_DEV_ADMIN_TOKEN='managed-admin-token' # pragma: allowlist secret
  export PERSONAL_DEV_AUTH_ADMIN_BASE_URL='http://127.0.0.1:38081'
  export PERSONAL_DEV_BINDING_RELEASE_REASON='test completed'
  source "$SCRIPT"
  prepare_state
  central_session() { printf '%s\n' 'testing-user-session'; }
  curl_with_token() {
    local token="$1"
    shift
    if [[ "$token" == 'testing-user-session' ]]; then
      printf '%s\n' '{"session":{"user":{"id":"usr_testing_1"}}}'
      return
    fi
    assert_eq 'managed-admin-token' "$token" "release admin token"
    [[ "$*" == *'-X DELETE'*'http://127.0.0.1:38081/admin/shadow-bindings/usr_testing_1'* ]] \
      || fail "release request did not target the configured testing admin endpoint"
    local previous='' arg
    for arg in "$@"; do
      if [[ "$previous" == '--data-binary' && "$arg" == @* ]]; then
        cp "${arg#@}" "$TEST_ROOT/binding-release-request.json"
      fi
      previous="$arg"
    done
    printf '%s\n' '{"userId":"usr_testing_1","status":"disabled"}'
  }

  local output
  output="$(release_binding)"
  grep -q '"status":"disabled"' <<<"$output"
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1])) == {"reason":"test completed"}' \
    "$TEST_ROOT/binding-release-request.json"
  ! grep -Rq 'managed-admin-token' "$STATE_ROOT"
  ! grep -q 'managed-admin-token' <<<"$output"
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

test_intl_dynamic_route_allowlists_match() {
  local gateway_manifest tunnel_manifest gateway_cidrs tunnel_cidrs
  gateway_manifest="$REPO_ROOT/argocd/services/cloudladdergateway/tkexsg/statefulsetplus-testing.yaml"
  tunnel_manifest="$REPO_ROOT/argocd/services/cloudladdergateway/tkexsg/devtunnel-testing.yaml"
  gateway_cidrs="$(awk '
    $0 ~ /name: CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_ALLOWED_CIDRS/ { getline; sub(/^[[:space:]]*value:[[:space:]]*/, ""); print; exit }
  ' "$gateway_manifest")"
  tunnel_cidrs="$(awk '
    $0 ~ /name: DEVTUNNEL_CAPABILITY_ALLOWED_CIDRS/ { getline; sub(/^[[:space:]]*value:[[:space:]]*/, ""); print; exit }
  ' "$tunnel_manifest")"
  test -n "$gateway_cidrs"
  assert_eq "$gateway_cidrs" "$tunnel_cidrs" "SG testing CloudLadder/devtunnel allowlists"
  [[ ",$gateway_cidrs," == *,9.0.0.0/8,* ]] || fail "SG testing allowlist lost the DevCloud 9/8 range"
  [[ ",$gateway_cidrs," == *,21.0.0.0/8,* ]] || fail "SG testing allowlist lost the DevCloud 21/8 range"
  [[ "$gateway_cidrs" != *'0.0.0.0/0'* ]] || fail "SG testing allowlist became globally open"
}

test_payment_and_production_guardrails() {
  ! grep -En 'api\.lightvela\.(com|ai)|production|staging|kubectl.*sync|argocd/secrets/(shprod|sgprod|beijing-sandbox|sandbox-jp-1)' "$SCRIPT"
  ! grep -Eq 'sops|JIFEI_BILLING_APP_SECRET|TRADE_BILLING_CLOUDLADDER_HMAC_SECRET|PERSONAL_DEV_PAID_E2E_SECRET_FILE' "$SCRIPT"
  grep -Fq 'PERSONAL_DEV_BILLING_CAPABILITY' "$SCRIPT"
  grep -q 'verify-order-no-pay' "$SCRIPT"
  grep -q 'verify-checkmodify-no-pay' "$SCRIPT"
  ! grep -q 'verified.*checkCreate' "$SCRIPT"
  # 真实付费只允许出现在 loopback 的 trade internal API 上，绝不能出现米大师/收银台等外部支付入口。
  ! grep -Eq 'buy\.cloud\.tencent\.com|midas|pay\.weixin|cashier' "$SCRIPT"
  ! grep -Eq 'place-and-pay|pay-url' "$SCRIPT_DIR/real-payment-loop.py" \
    || grep -Fq 'http://127.0.0.1:' "$SCRIPT_DIR/real-payment-loop.py" \
    || fail "real payment loop must only call the loopback trade internal API"
}

# checkModify 只有"付过钱的变配单"才能证明，所以旧的 no-pay 子命令必须继续拒绝，
# 并把调用方引导到真正的付费闭环命令。
test_checkmodify_no_pay_refuses_and_points_at_real_loop() (
  export PERSONAL_DEV_STATE_DIR="$TEST_ROOT/checkmodify-refusal" PERSONAL_DEV_SITE=cn
  source "$SCRIPT"
  local output=""
  if output="$(verify_checkmodify_no_pay 2>&1)"; then
    fail "verify-checkmodify-no-pay must keep failing closed"
  fi
  grep -q 'verify-real-payment-loop' <<<"$output" \
    || fail "the refusal must name the real paid command, got: $output"
)

# verify-real-payment-loop 必须被 dispatch/usage 接线，且 internal token 只能经环境变量
# 传给子进程（写进命令行会被 ps 看到）。
test_real_payment_loop_is_wired_and_keeps_token_out_of_argv() {
  grep -q 'verify-real-payment-loop) verify_real_payment_loop ;;' "$SCRIPT" \
    || fail "verify-real-payment-loop is not dispatched"
  grep -q 'verify-real-payment-loop ' "$SCRIPT" || fail "verify-real-payment-loop is not documented in usage"
  test -x "$SCRIPT_DIR/real-payment-loop.py" || fail "real-payment-loop.py must be executable"
  grep -q 'LV_INTERNAL_TOKEN="$internal_token"' "$SCRIPT" \
    || fail "the internal token must be passed through the environment"
  ! grep -Eq 'python3 .*real-payment-loop\.py.*(--token|\$internal_token)' "$SCRIPT" \
    || fail "the internal token must never appear in argv"
  grep -q 'chmod 600 "$transcript"' "$SCRIPT" || fail "the transcript must be private"
}

# curDeadline 是本次最大的坑：计费协议层按北京时间（CST/UTC+8）字面值解析，
# 而 ctl.pass.expired_time 在 DB 里是 UTC 字面值，直接透传必然 PASS_MODIFY_CONFIG_MISMATCH。
test_cur_deadline_is_converted_to_cst() {
  local converted
  converted="$(python3 - "$SCRIPT_DIR/real-payment-loop.py" <<'PY'
import importlib.util
import sys

spec = importlib.util.spec_from_loader("loop", loader=None)
module = importlib.util.module_from_spec(spec)
source = open(sys.argv[1], encoding="utf-8").read()
start = source.index("def utc_literal_to_cst")
end = source.index("def wait_for")
exec(compile(source[start:end], "loop", "exec"), module.__dict__)
print(module.utc_literal_to_cst("2026-10-23 21:08:49"))
PY
)"
  assert_eq '2026-10-24 05:08:49' "$converted" "UTC pass deadline must become a CST literal"
  grep -Fq 'CurDeadlineLocation' "$SCRIPT_DIR/real-payment-loop.py" \
    || fail "the CST contract must cite its source of truth"
}

# 下面这些用例锁定的是真实跑出来的 transcript（真实扣款、真实计费回调），
# 它们是"个人环境确实打通了计费"的回归基线，不是 mock。
assert_transcript_closed_loop() {
  local transcript="$1" site="$2" currency="$3"
  test -f "$transcript" || fail "missing recorded transcript $transcript"
  python3 - "$transcript" "$site" "$currency" <<'PY'
import json
import sys

path, site, currency = sys.argv[1], sys.argv[2], sys.argv[3]
entries = json.load(open(path, encoding="utf-8"))
calls = [e for e in entries if "method" in e]
obs = {e["observation"]: e["value"] for e in entries if "observation" in e}


def die(message):
    raise SystemExit(path + ": " + message)


for call in calls:
    if call.get("site") != site:
        die("call recorded for the wrong site: " + str(call.get("site")))
    if call["status"] != 200:
        die("non-200 recorded for " + call["path"] + ": " + str(call["status"]))

paths = [c["path"] for c in calls]
for required in ("/inquiry/modify", "/orders/modify/place-and-pay"):
    if required not in paths:
        die("missing " + required)
if not any(p.endswith("/refund") for p in paths):
    die("missing refund call")
if not any(p.endswith("/delete") for p in paths):
    die("missing delete call")

inquiry = next(c for c in calls if c["path"] == "/inquiry/modify")
prices = inquiry["response"]["prices"]
if not prices:
    die("modify inquiry returned no price")
for price in prices:
    if price["currency"] != currency:
        die("expected " + currency + ", got " + price["currency"])

target = inquiry["request"]["targetBundleId"]
source = inquiry["request"]["sourceBundleId"]
if source == target:
    die("the recorded loop must actually change the bundle")

deadline = inquiry["request"]["curDeadline"]
if deadline != obs["curDeadlineCST"]:
    die("modify request did not use the CST deadline")

order = next(c for c in calls if c["path"] == "/orders/modify/place-and-pay")
if not order["response"].get("dealName") or not order["response"].get("bigOrderId"):
    die("paid modify order did not return a deal")

if not obs["passAfterModify"].startswith("active|" + target + "|"):
    die("pass did not settle on the target bundle: " + obs["passAfterModify"])
if obs["passAfterRefund"] not in ("isolated", "expired"):
    die("refund did not isolate the pass: " + obs["passAfterRefund"])
if not obs["historyPassAfterDelete"].startswith("deleted|"):
    die("delete did not reach a deleted history pass: " + obs["historyPassAfterDelete"])

flows = obs["tradeFlowsForDeals"]
for flow in ("create_resource:completed", "modify_resource:completed",
             "isolate_resource:completed", "destroy_resource:completed"):
    if flow not in flows:
        die("missing terminal flow " + flow + " in " + flows)

blob = json.dumps(entries)
for secret_marker in ("Bearer ", "LV_INTERNAL_TOKEN", "secretKey", "password"):
    if secret_marker in blob:
        die("transcript leaked a credential marker: " + secret_marker)
PY
}

test_recorded_cn_loop_proves_paid_closed_loop() {
  assert_transcript_closed_loop "$SCRIPT_DIR/../tests/fixtures/real-payment-loop-cn.json" cn CNY
}

test_recorded_intl_loop_proves_paid_closed_loop() {
  local transcript="$SCRIPT_DIR/../tests/fixtures/real-payment-loop-intl.json"
  if [[ ! -f "$transcript" ]]; then
    printf '# skip - intl transcript not recorded in this checkout\n'
    return 0
  fi
  assert_transcript_closed_loop "$transcript" intl USD
}

test_personal_dev_billing_proxy_patches_target_trade_namespace() {
  local site patch
  for site in sandbox-bj-7 sandbox-kr-1; do
    patch="$REPO_ROOT/argocd/services/trade/$site/patch-personal-dev-billing-proxy.yaml"
    test -f "$patch" || fail "missing personal DevCloud billing proxy patch for $site"
    awk '
      /^metadata:/ { in_metadata = 1; next }
      in_metadata && /^[^[:space:]]/ { in_metadata = 0 }
      in_metadata && /^[[:space:]]+namespace:[[:space:]]+trade[[:space:]]*$/ { found = 1 }
      END { exit found ? 0 : 1 }
    ' "$patch" || fail "$site billing proxy patch must target ConfigMap trade-config in namespace trade"
  done
}

run_test 'CN and Intl state are isolated' test_site_state_isolation
run_test 'saved kind cluster is restored for follow-up commands' test_saved_kind_cluster_is_restored
run_test 'active site blocks cross-site activation' test_active_site_blocks_switch
run_test 'state updates are atomic' test_state_updates_are_atomic
run_test 'auth failure removes credential temp files' test_auth_failure_removes_temp_credentials
run_test 'session-only auth generates private local credentials' test_session_only_generates_local_credentials
run_test 'fresh state leases a testing account without credentials' test_fresh_state_leases_testing_account_without_credentials
run_test 'lease renewal failure reuses the still-valid session' test_lease_renewal_failure_reuses_still_valid_session
run_test 'lease renewal proves ownership with the current lease session' test_lease_renewal_proves_current_session_ownership
run_test 'expired lease session reclaims anonymously only after server rejection' test_expired_lease_session_reclaims_anonymously_after_server_rejects_renewal
run_test 'local identity preserves central credentials across session refresh' test_local_identity_preserves_central_credentials_and_expired_session_reauthenticates
run_test 'legacy local identity is not reused as central login' test_legacy_local_identity_is_not_used_as_central_login
run_test 'personal kubeconfig guard rejects shared clusters' test_personal_kubeconfig_guard
run_test 'doctor reuses bootstrapped private tools' test_doctor_reuses_bootstrapped_private_tools
run_test 'port-forward supervisor restarts and cleans up its child' test_port_forward_supervisor_restarts_and_stops_child
run_test 'a foreign checkout holding a host port blocks site activation' test_foreign_checkout_port_holder_blocks_site_activation
run_test "this site's own port-forward is not treated as a conflict" test_site_activation_allows_own_context_port_forward
run_test 'localstack exposure ports are overridable' test_localstack_exposure_ports_are_overridable
run_test 'localstack exposure fails closed when a port is held by another stack' test_exposure_fails_when_port_is_held_by_another_stack
run_test 'Auth override is sandbox-only' test_auth_override_is_sandbox_only
run_test 'Auth admin override is loopback-only' test_auth_admin_override_is_loopback_only
run_test 'binary bootstrap is safe under nounset' test_download_binary_is_nounset_safe
run_test 'DevCloud IP discovery accepts 9/8 and 21/8 only' test_devcloud_ip_accepts_current_networks_and_rejects_unsafe_overrides
run_test 'Intl registration starts the assigned tunnel' test_intl_registration_starts_tunnel
run_test 'Intl registration source override fails closed on mismatch' test_intl_registration_source_override_fails_closed_on_mismatch
run_test 'registration failures surface safe business errors' test_registration_failure_surfaces_safe_business_error
run_test 'devtunnel-agent builds from the current checkout' test_devtunnel_build_uses_current_checkout
run_test 'Intl registration without a capability fails closed' test_intl_registration_without_capability_fails_closed
run_test 'CN registration requires the server-confirmed DevCloud target' test_cn_registration_requires_server_confirmed_devcloud_target
run_test 'CN registration without a capability fails closed' test_cn_registration_without_capability_fails_closed
run_test 'registration agent failure fails closed' test_registration_agent_failure_fails_closed
run_test 'heartbeat survives transient failures' test_heartbeat_survives_transient_failures
run_test 'heartbeat stop interrupts a long sleep' test_stop_heartbeat_interrupts_long_sleep
run_test 'no-pay order verification stays on loopback and validates USD' test_order_no_pay_is_loopback_only_and_intl_usd
run_test 'status fails closed' test_status_fails_when_dependencies_fail
run_test 'Intl status accepts the server-confirmed NAT source IP' test_intl_status_accepts_server_confirmed_nat_source
run_test 'billing capability rotates without state persistence' test_billing_capability_rotates_without_state_persistence
run_test 'billing capability readiness requires JSON HTTP 200' test_billing_capability_readiness_requires_json_200
run_test 'unregister verifies old billing capability revocation' test_unregister_requires_old_billing_capability_revocation
run_test 'release-binding unregisters before releasing a leased account' test_release_binding_unregisters_before_releasing_leased_account
run_test 'release-binding retains the lease when unregister fails' test_release_binding_keeps_lease_when_unregister_fails
run_test 'invalid lease release response falls back to TTL without terminating cleanup' test_invalid_release_response_returns_to_caller_for_ttl_fallback
run_test 'down unregisters then releases before stopping localstack' test_down_unregisters_then_releases_before_stopping_stack
run_test 'down after release-binding does not reacquire an account' test_down_after_release_binding_does_not_reacquire_account
run_test 'Intl active-registration guard accepts the server-confirmed NAT source IP' test_intl_active_registration_accepts_server_confirmed_nat_source
run_test 'down continues after unregister failure' test_down_stops_stack_after_unregister_failure
run_test 'gateway override reaches Trade runtime' test_gateway_override_reaches_trade_runtime
run_test 'testing gateway migrates stale state and rejects production overrides' test_testing_gateway_migrates_stale_state_and_rejects_prod_override
run_test 'Billing APIGW accepts only the testing route' test_billing_apigw_rejects_non_testing_routes
run_test 'prerequisites cover account, balance, binding, and capability' test_prerequisites_document_account_balance_binding_and_capability
run_test 'runtime kustomize wrapper cannot become its own real binary' test_real_kustomize_rejects_runtime_wrapper_alias
run_test 'runtime instrumentation streams from the Skill without source writes' test_runtime_instrumentation_is_streamed_from_skill
run_test 'browser login is minted into private state without token output' test_browser_login_is_minted_privately
run_test 'browser login retries an empty nonce generation' test_browser_nonce_retries_empty_generation
run_test 'testing binding bootstrap derives the target user and keeps admin token private' test_testing_binding_bootstrap_uses_session_identity_without_persisting_admin_token
run_test 'missing binding is bootstrapped when managed inputs are present' test_wait_for_binding_bootstraps_when_managed_inputs_are_present
run_test 'testing binding release derives the target user and keeps admin token private' test_testing_binding_release_derives_user_and_keeps_admin_token_private
run_test 'skill name and paths are consistent' test_skill_name_and_paths_are_consistent
run_test 'SG testing CloudLadder and devtunnel allowlists stay aligned' test_intl_dynamic_route_allowlists_match
run_test 'payment and production guardrails remain absent' test_payment_and_production_guardrails
run_test 'checkmodify no-pay keeps failing closed and points at the real loop' test_checkmodify_no_pay_refuses_and_points_at_real_loop
run_test 'real payment loop is wired and keeps the token out of argv' test_real_payment_loop_is_wired_and_keeps_token_out_of_argv
run_test 'curDeadline is converted from the DB UTC literal to CST' test_cur_deadline_is_converted_to_cst
run_test 'recorded CN loop proves a real paid closed loop' test_recorded_cn_loop_proves_paid_closed_loop
run_test 'recorded Intl loop proves a real paid closed loop' test_recorded_intl_loop_proves_paid_closed_loop
run_test 'personal DevCloud billing proxy patches target the original Trade namespace' test_personal_dev_billing_proxy_patches_target_trade_namespace
run_test 'disk preflight blocks up before the image builds burn an hour' test_disk_preflight_blocks_up_before_image_builds
run_test 'disk preflight allows real headroom and stays overridable' test_disk_preflight_allows_enough_headroom_and_is_overridable

printf 'personal devcloud skill contract passed\n'
