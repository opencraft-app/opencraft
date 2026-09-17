#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOCALSTACK="$REPO_ROOT/deploy/localstack/localstack.sh"
STATE_BASE="${PERSONAL_DEV_STATE_DIR:-$REPO_ROOT/.localstack/personal-devcloud}"
CURRENT_SITE_FILE="$STATE_BASE/current-site"
SITE="${PERSONAL_DEV_SITE:-}"
if [[ -z "$SITE" && -f "$CURRENT_SITE_FILE" ]]; then
  SITE="$(tr -dc 'a-z' <"$CURRENT_SITE_FILE")"
fi
SITE="${SITE:-intl}"
case "$SITE" in
  cn | intl) ;;
  *) printf '[personal-devcloud] ERROR: PERSONAL_DEV_SITE must be intl or cn\n' >&2; exit 1 ;;
esac
STATE_ROOT="$STATE_BASE/$SITE"
STATE_FILE="$STATE_ROOT/state.json"
TOOLS_DIR="$STATE_ROOT/bin"
LOG_DIR="$STATE_ROOT/logs"
HEARTBEAT_PID_FILE="$STATE_ROOT/heartbeat.pid"
DEVTUNNEL_PID_FILE="$STATE_ROOT/devtunnel-agent.pid"
DEVTUNNEL_BIN="$STATE_ROOT/bin/devtunnel-agent"
BROWSER_BOOTSTRAP_PID_FILE="$STATE_ROOT/browser-bootstrap.pid"
BROWSER_BOOTSTRAP_READY_FILE="$STATE_ROOT/browser-bootstrap.ready"
BROWSER_BOOTSTRAP="$SCRIPT_DIR/browser-login-bootstrap.py"
BROWSER_BOOTSTRAP_PORT="${PERSONAL_DEV_BROWSER_BOOTSTRAP_PORT:-19050}"
RUNTIME_KUSTOMIZE="$SCRIPT_DIR/kustomize-runtime-wrapper.sh"
KIND_CLUSTER_EXPLICIT="${PERSONAL_DEV_KIND_CLUSTER:-}"
KIND_CLUSTER="${KIND_CLUSTER_EXPLICIT:-lightvela-personal-$SITE}"
KUBE_CONTEXT="kind-$KIND_CLUSTER"
KUBECONFIG_FILE="$STATE_ROOT/kubeconfig"
CALLBACK_PORT="${PERSONAL_DEV_CALLBACK_PORT:-18084}"
INTERNAL_TRADE_PORT="${PERSONAL_DEV_INTERNAL_TRADE_PORT:-28084}"
TTL_SECONDS="${PERSONAL_DEV_TTL_SECONDS:-28800}"
BROWSER_SESSION_TTL_SECONDS="${PERSONAL_DEV_BROWSER_SESSION_TTL_SECONDS:-28800}"

AUTH_BASE=""
CLGATEWAY_BASE=""
REGISTRATION_URL=""
TEMP_FILES=()

cleanup_temp_files() {
  local rc=$? path
  for path in "${TEMP_FILES[@]:-}"; do
    [[ -n "$path" ]] && rm -f "$path"
  done
  return "$rc"
}

trap cleanup_temp_files EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

new_private_temp() {
  local prefix="$1"
  TEMP_FILE_RESULT="$(mktemp "$STATE_ROOT/$prefix.XXXXXX")"
  chmod 600 "$TEMP_FILE_RESULT"
  TEMP_FILES+=("$TEMP_FILE_RESULT")
}

remove_private_temp() {
  rm -f "$1"
}

log() {
  printf '[personal-devcloud] %s\n' "$*" >&2
}

die() {
  printf '[personal-devcloud] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

prepare_state() {
  local saved_kind_cluster=""
  mkdir -p "$STATE_BASE" "$STATE_ROOT" "$TOOLS_DIR" "$LOG_DIR"
  chmod 700 "$STATE_BASE" "$STATE_ROOT" "$TOOLS_DIR" "$LOG_DIR"
  if [[ ! -f "$STATE_FILE" ]]; then
    printf '{}\n' >"$STATE_FILE"
  fi
  chmod 600 "$STATE_FILE"
  if [[ -z "$KIND_CLUSTER_EXPLICIT" ]]; then
    saved_kind_cluster="$(state_get kind_cluster)"
    if [[ -n "$saved_kind_cluster" ]]; then
      KIND_CLUSTER="$saved_kind_cluster"
      KUBE_CONTEXT="kind-$KIND_CLUSTER"
    fi
  fi
  export PATH="$TOOLS_DIR:$PATH"
  if [[ -f "$KUBECONFIG_FILE" ]]; then
    chmod 600 "$KUBECONFIG_FILE"
    export KUBECONFIG="$KUBECONFIG_FILE"
  fi
  configure_site
}

state_get() {
  local key="$1"
  python3 - "$STATE_FILE" "$key" <<'PY'
import json, sys
path, key = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as fh:
        value = json.load(fh).get(key, "")
except (FileNotFoundError, json.JSONDecodeError):
    value = ""
if value is None:
    value = ""
print(value)
PY
}

state_set() {
  local key="$1" value="$2"
  STATE_KEY="$key" STATE_VALUE="$value" python3 - "$STATE_FILE" <<'PY'
import fcntl, json, os, sys, tempfile
path = sys.argv[1]
lock_path = path + ".lock"
with open(lock_path, "a+", encoding="utf-8") as lock:
    os.chmod(lock_path, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}
    data[os.environ["STATE_KEY"]] = os.environ["STATE_VALUE"]
    fd, tmp = tempfile.mkstemp(prefix="state.", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
PY
}

configure_site() {
  local explicit_gateway="${PERSONAL_DEV_CLGATEWAY_BASE_URL:-}"
  case "$SITE" in
    intl)
      AUTH_BASE="${PERSONAL_DEV_AUTH_BASE_URL:-$(state_get auth_base)}"
      AUTH_BASE="${AUTH_BASE:-https://api-sandbox-kr-1.lightclaw.tech}"
      CLGATEWAY_BASE="${PERSONAL_DEV_CLGATEWAY_BASE_URL:-$(state_get clgateway_base)}"
      CLGATEWAY_BASE="${CLGATEWAY_BASE:-http://43.153.246.14}"
      ;;
    cn)
      AUTH_BASE="${PERSONAL_DEV_AUTH_BASE_URL:-$(state_get auth_base)}"
      AUTH_BASE="${AUTH_BASE:-https://api-sandbox-bj-7.lightclaw.tech}"
      CLGATEWAY_BASE="${PERSONAL_DEV_CLGATEWAY_BASE_URL:-$(state_get clgateway_base)}"
      CLGATEWAY_BASE="${CLGATEWAY_BASE:-http://1.12.212.56}"
      ;;
    *)
      die "PERSONAL_DEV_SITE must be intl or cn"
      ;;
  esac
  if [[ -z "$explicit_gateway" ]]; then
    case "$SITE:$CLGATEWAY_BASE" in
      intl:http://43.153.236.65)
        CLGATEWAY_BASE="http://43.153.246.14"
        ;;
      cn:http://81.71.196.13)
        CLGATEWAY_BASE="http://1.12.212.56"
        ;;
    esac
  fi
  AUTH_BASE="${AUTH_BASE%/}"
  CLGATEWAY_BASE="${CLGATEWAY_BASE%/}"
  validate_auth_base
  validate_clgateway_base
  REGISTRATION_URL="$AUTH_BASE/auth/dev-environments/registration"
}

validate_auth_base() {
  python3 - "$AUTH_BASE" <<'PY' || die "Auth endpoint must be an HTTPS api-sandbox-*.lightclaw.tech origin without credentials, query, or fragment"
import re, sys
from urllib.parse import urlsplit

parsed = urlsplit(sys.argv[1])
hostname = (parsed.hostname or "").lower()
valid = (
    parsed.scheme == "https"
    and parsed.username is None
    and parsed.password is None
    and parsed.port in (None, 443)
    and parsed.path in ("", "/")
    and not parsed.query
    and not parsed.fragment
    and re.fullmatch(r"api-sandbox-[a-z0-9-]+\.lightclaw\.tech", hostname)
)
raise SystemExit(0 if valid else 1)
PY
}

validate_clgateway_base() {
  python3 - "$CLGATEWAY_BASE" <<'PY' || die "CloudLadder endpoint must be a non-production HTTP(S) origin without credentials or a path"
import sys
from urllib.parse import urlsplit

parsed = urlsplit(sys.argv[1])
hostname = (parsed.hostname or "").lower()
forbidden = {
    "81.71.196.13",
    "43.153.236.65",
    "lightclaw.tech",
    "api.lightvela.com",
    "api.lightvela.ai",
}
valid = (
    parsed.scheme in ("http", "https")
    and hostname
    and hostname not in forbidden
    and parsed.username is None
    and parsed.password is None
    and parsed.path in ("", "/")
    and not parsed.query
    and not parsed.fragment
)
raise SystemExit(0 if valid else 1)
PY
}

persist_endpoint_config() {
  state_set site "$SITE"
  state_set auth_base "$AUTH_BASE"
  state_set clgateway_base "$CLGATEWAY_BASE"
}

mark_current_site() {
  local tmp
  tmp="$(mktemp "$STATE_BASE/current-site.XXXXXX")"
  chmod 600 "$tmp"
  printf '%s\n' "$SITE" >"$tmp"
  mv "$tmp" "$CURRENT_SITE_FILE"
}

site_switch_blocker() {
  local previous_site previous_state
  [[ -f "$CURRENT_SITE_FILE" ]] || return 0
  previous_site="$(tr -dc 'a-z' <"$CURRENT_SITE_FILE")"
  [[ -n "$previous_site" && "$previous_site" != "$SITE" ]] || return 0
  previous_state="$STATE_BASE/$previous_site/state.json"
  python3 - "$previous_site" "$previous_state" <<'PY'
import datetime as dt, json, sys
site, path = sys.argv[1:]
try:
    data = json.load(open(path, encoding="utf-8"))
except (FileNotFoundError, json.JSONDecodeError):
    raise SystemExit(0)
status = data.get("registration_status", "")
expires = data.get("registration_expires_at", "")
if not status and data.get("registration_response"):
    try:
        response = json.loads(data["registration_response"])
        status = response.get("status", "")
        expires = response.get("expiresAt", "")
    except (TypeError, json.JSONDecodeError):
        pass
active = status == "active"
if active and expires:
    try:
        expiry = dt.datetime.fromisoformat(expires.replace("Z", "+00:00"))
        active = expiry > dt.datetime.now(dt.timezone.utc)
    except ValueError:
        active = True
stack_up = data.get("stack_status") == "up"
if active or stack_up:
    details = []
    if active:
        details.append("active registration")
    if stack_up:
        details.append("running stack")
    print(f"site {site} still has " + " and ".join(details))
    raise SystemExit(1)
PY
}

ensure_site_activation_safe() {
  local blocker=""
  if ! blocker="$(site_switch_blocker)"; then
    die "$blocker; run PERSONAL_DEV_SITE=$(tr -dc 'a-z' <"$CURRENT_SITE_FILE") $SCRIPT_DIR/personal-devcloud.sh down before switching to $SITE"
  fi
}

json_value() {
  local expression="$1"
  python3 -c "import json,sys; d=json.load(sys.stdin); v=$expression; print('' if v is None else v)"
}

json_without_secrets() {
  python3 -c '
import json, sys
data = json.load(sys.stdin)
blocked = ("token", "password", "secret")
def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items() if not any(word in k.lower() for word in blocked)}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value
json.dump(clean(data), sys.stdout, ensure_ascii=False, separators=(",", ":"))
'
}

json_body_file() {
  local output="$1"
  shift
  python3 - "$output" "$@" <<'PY'
import json, sys
path = sys.argv[1]
items = sys.argv[2:]
data = {}
for item in items:
    key, value = item.split("=", 1)
    data[key] = value
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False)
PY
  chmod 600 "$output"
}

curl_with_token() {
  local token="$1"
  shift
  [[ "$token" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || die "session token contains unsupported characters"
  local cfg
  new_private_temp curl
  cfg="$TEMP_FILE_RESULT"
  printf 'header = "Authorization: Bearer %s"\n' "$token" >"$cfg"
  local rc=0
  curl --fail-with-body --silent --show-error --connect-timeout 10 --max-time 90 --config "$cfg" "$@" || rc=$?
  remove_private_temp "$cfg"
  return "$rc"
}

os_name() {
  case "$(uname -s)" in
    Linux) printf 'linux\n' ;;
    Darwin) printf 'darwin\n' ;;
    *) die "unsupported operating system: $(uname -s)" ;;
  esac
}

arch_name() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'amd64\n' ;;
    arm64 | aarch64) printf 'arm64\n' ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

download_binary() {
  local name="$1" url="$2" checksum_url="$3"
  local output="$TOOLS_DIR/$name"
  local artifact checksum expected actual
  [[ -x "$output" ]] && return 0
  log "installing $name"
  new_private_temp "$name.download"
  artifact="$TEMP_FILE_RESULT"
  new_private_temp "$name.sha256"
  checksum="$TEMP_FILE_RESULT"
  curl --fail --location --silent --show-error "$url" -o "$artifact"
  curl --fail --location --silent --show-error "$checksum_url" -o "$checksum"
  expected="$(awk 'NF {print $1; exit}' "$checksum")"
  actual="$(sha256_file "$artifact")"
  expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
  [[ "$expected" =~ ^[a-f0-9]{64}$ && "$expected" == "$actual" ]] \
    || die "checksum verification failed for $name"
  mv "$artifact" "$output"
  chmod 700 "$output"
}

ensure_tools() {
  prepare_state
  local dependency
  for dependency in curl docker python3 tar git nohup base64 awk; do
    require_command "$dependency"
  done
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    die "missing SHA-256 tool: install sha256sum or shasum"
  fi
  local os arch archive tmp
  os="$(os_name)"
  arch="$(arch_name)"

  if ! command -v kubectl >/dev/null 2>&1; then
    download_binary kubectl \
      "https://dl.k8s.io/release/v1.36.0/bin/$os/$arch/kubectl" \
      "https://dl.k8s.io/release/v1.36.0/bin/$os/$arch/kubectl.sha256"
  fi
  if ! command -v kind >/dev/null 2>&1; then
    download_binary kind \
      "https://kind.sigs.k8s.io/dl/v0.30.0/kind-$os-$arch" \
      "https://kind.sigs.k8s.io/dl/v0.30.0/kind-$os-$arch.sha256sum"
  fi
  if ! command -v kustomize >/dev/null 2>&1; then
    local checksums filename expected actual
    new_private_temp kustomize.tar.gz
    archive="$TEMP_FILE_RESULT"
    new_private_temp kustomize.checksums
    checksums="$TEMP_FILE_RESULT"
    tmp="$STATE_ROOT/kustomize-unpack"
    rm -rf "$tmp"
    mkdir -p "$tmp"
    filename="kustomize_v5.4.3_${os}_${arch}.tar.gz"
    curl --fail --location --silent --show-error \
      "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v5.4.3/$filename" \
      -o "$archive"
    curl --fail --location --silent --show-error \
      "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v5.4.3/checksums.txt" \
      -o "$checksums"
    expected="$(awk -v name="$filename" '{candidate=$2; sub(/^\*/, "", candidate); sub(/^.*\//, "", candidate); if (candidate == name) {print $1; exit}}' "$checksums")"
    actual="$(sha256_file "$archive")"
    expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
    [[ "$expected" =~ ^[a-f0-9]{64}$ && "$expected" == "$actual" ]] \
      || die "checksum verification failed for kustomize"
    tar -xzf "$archive" -C "$tmp" kustomize
    mv "$tmp/kustomize" "$TOOLS_DIR/kustomize"
    chmod 700 "$TOOLS_DIR/kustomize"
    rm -rf "$tmp"
    remove_private_temp "$archive"
    remove_private_temp "$checksums"
  fi
}

discover_devcloud_ip() {
  if [[ -n "${PERSONAL_DEV_IP:-}" ]]; then
    printf '%s\n' "$PERSONAL_DEV_IP"
    return
  fi
  python3 - <<'PY'
import ipaddress, socket
candidates = []
try:
    candidates.extend(socket.gethostbyname_ex(socket.gethostname())[2])
except OSError:
    pass
try:
    candidates.extend(__import__('subprocess').check_output(['hostname', '-I'], text=True).split())
except Exception:
    pass
for raw in candidates:
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        continue
    if ip.version == 4 and ip in ipaddress.ip_network('9.0.0.0/8'):
        print(ip)
        raise SystemExit(0)
raise SystemExit(1)
PY
}

ensure_kind_cluster() {
  mkdir -p "$STATE_ROOT"
  if kind get clusters 2>/dev/null | grep -Fxq "$KIND_CLUSTER"; then
    kind export kubeconfig --name "$KIND_CLUSTER" --kubeconfig "$KUBECONFIG_FILE" >/dev/null
  else
    log "creating local Kubernetes cluster $KUBE_CONTEXT"
    kind create cluster --name "$KIND_CLUSTER" --kubeconfig "$KUBECONFIG_FILE" --wait 180s
  fi
  chmod 600 "$KUBECONFIG_FILE"
  export KUBECONFIG="$KUBECONFIG_FILE"
  require_personal_context
}

require_personal_context() {
  [[ -f "$KUBECONFIG_FILE" ]] || die "personal kubeconfig is missing; run bootstrap/up first"
  export KUBECONFIG="$KUBECONFIG_FILE"
  local context cluster server
  context="$(kubectl config current-context 2>/dev/null || true)"
  [[ "$context" == "$KUBE_CONTEXT" ]] || die "refusing Kubernetes context '$context'; expected '$KUBE_CONTEXT'"
  cluster="$(kubectl config view -o "jsonpath={.contexts[?(@.name=='$context')].context.cluster}" 2>/dev/null)"
  server="$(kubectl config view -o "jsonpath={.clusters[?(@.name=='$cluster')].cluster.server}" 2>/dev/null)"
  case "$server" in
    https://127.0.0.1:* | http://127.0.0.1:* | https://localhost:* | http://localhost:* | "https://[::1]:"* | "http://[::1]:"*) ;;
    *) die "refusing non-loopback Kubernetes API server for $context: ${server:-missing}" ;;
  esac
  state_set kind_cluster "$KIND_CLUSTER"
}

doctor() {
  local dependency
  for dependency in curl docker python3 tar git nohup base64 awk; do
    require_command "$dependency"
  done
  configure_site
  docker info >/dev/null
  local ip=""
  ip="$(discover_devcloud_ip 2>/dev/null || true)"
  [[ -n "$ip" ]] || die "cannot discover a 9.0.0.0/8 DevCloud IP; set PERSONAL_DEV_IP"
  log "site=$SITE devcloud_ip=$ip auth=$AUTH_BASE clgateway=$CLGATEWAY_BASE"
  log "docker=$(docker version --format '{{.Server.Arch}}')"
  for tool in kubectl kustomize kind; do
    if command -v "$tool" >/dev/null 2>&1; then
      log "$tool=$(command -v "$tool")"
    else
      log "$tool=missing (bootstrap will install it under $TOOLS_DIR)"
    fi
  done
  if [[ -f "$KUBECONFIG_FILE" ]]; then
    require_personal_context
    log "context=$KUBE_CONTEXT api_server=loopback"
  fi
}

bootstrap() {
  ensure_tools
  doctor
  ensure_kind_cluster
  kubectl get nodes >/dev/null
  log "local Kubernetes cluster is ready"
}

clear_legacy_runtime_overrides() {
  require_personal_context
  if kubectl get deployment lightclaw-auth -n user-auth >/dev/null 2>&1; then
    kubectl set env -n user-auth deployment/lightclaw-auth \
      LIGHTVELA_SITE_KIND- LIGHTCLAW_FRONTEND_BASE_URL- LIGHTCLAW_OAUTH_RETURN_TO_ALLOWED_HOSTS- \
      LIGHTCLAW_PUBLIC_BASE_URL- LIGHTCLAW_QQ_REDIRECT_URI- LIGHTCLAW_QQ_AUTHORIZE_URL- \
      LIGHTCLAW_WECHAT_REDIRECT_URI- LIGHTVELA_WECHAT_WEBSITE_REDIRECT_URI- \
      LIGHTVELA_WECHAT_OFFICIAL_ACCOUNT_REDIRECT_URI- LIGHTCLAW_GITHUB_REDIRECT_URI- \
      SHADOW_BINDING_ENABLED- LIGHTCLAW_PASSWORD_SIGNUP_SHADOW_PROVISIONING_ENABLED- SHADOW_PLATFORM- \
      >/dev/null
  fi
  if kubectl get deployment trade -n trade >/dev/null 2>&1; then
    kubectl set env -n trade deployment/trade \
      LIGHTVELA_SITE_KIND- LIGHTVELA_TRADE_REGION- JIFEI_CGW_GATEWAY_URL- \
      JIFEI_CGW_X_QCLOUD_USER_ID- TRADE_SHADOW_MOCK_ENABLED- >/dev/null
  fi
  local deployment
  for deployment in ctl-api ctl-service ctl-bypass; do
    if kubectl get deployment "$deployment" -n ctl >/dev/null 2>&1; then
      kubectl set env -n ctl "deployment/$deployment" LIGHTVELA_SITE_KIND- >/dev/null
    fi
  done
}

generate_password() {
  if [[ -n "${PERSONAL_DEV_PASSWORD:-}" ]]; then
    printf '%s\n' "$PERSONAL_DEV_PASSWORD"
    return
  fi
  python3 - <<'PY'
import secrets
print('Lv!' + secrets.token_urlsafe(18))
PY
}

prepare_local_credentials() {
  LOCAL_IDENTITY_EMAIL="${PERSONAL_DEV_EMAIL:-$(state_get email)}"
  LOCAL_IDENTITY_PASSWORD="${PERSONAL_DEV_PASSWORD:-$(state_get password)}"
  if [[ -z "$LOCAL_IDENTITY_EMAIL" ]]; then
    LOCAL_IDENTITY_EMAIL="lv-local-$(hostname -s | tr -cd 'A-Za-z0-9-' | tr '[:upper:]' '[:lower:]')-$(date +%s)@example.com"
  fi
  if [[ -z "$LOCAL_IDENTITY_PASSWORD" ]]; then
    LOCAL_IDENTITY_PASSWORD="$(generate_password)"
  fi
  state_set email "$LOCAL_IDENTITY_EMAIL"
  state_set password "$LOCAL_IDENTITY_PASSWORD"
}

central_session() {
  local token email password body response
  token="${PERSONAL_DEV_SESSION_TOKEN:-$(state_get central_session_token)}"
  if [[ -n "$token" ]]; then
    if curl_with_token "$token" "$AUTH_BASE/auth/shadow/binding" >/dev/null 2>&1; then
      persist_endpoint_config
      if [[ -n "${PERSONAL_DEV_EMAIL:-}" ]]; then
        state_set email "$PERSONAL_DEV_EMAIL"
      fi
      if [[ -n "${PERSONAL_DEV_PASSWORD:-}" ]]; then
        state_set password "$PERSONAL_DEV_PASSWORD"
      fi
      state_set central_session_token "$token"
      printf '%s\n' "$token"
      return
    fi
  fi

  email="${PERSONAL_DEV_EMAIL:-$(state_get email)}"
  password="${PERSONAL_DEV_PASSWORD:-$(state_get password)}"
  if [[ -z "$email" && "$SITE" == "intl" ]]; then
    email="lv-dev-$(hostname -s | tr -cd 'A-Za-z0-9-' | tr '[:upper:]' '[:lower:]')-$(date +%s)@example.com"
  fi
  [[ -n "$email" ]] || die "CN requires PERSONAL_DEV_EMAIL/PERSONAL_DEV_PASSWORD or PERSONAL_DEV_SESSION_TOKEN for a pre-provisioned real-name test account"
  [[ -n "$password" ]] || password="$(generate_password)"

  new_private_temp signup
  body="$TEMP_FILE_RESULT"
  json_body_file "$body" "name=devcloud-$(hostname -s)" "email=$email" "password=$password" # pragma: allowlist secret
  if [[ "$SITE" == "intl" && -z "${PERSONAL_DEV_EMAIL:-}" && -z "$(state_get email)" ]]; then
    if ! response="$(curl --fail-with-body --silent --show-error --connect-timeout 10 --max-time 90 \
      -H 'Content-Type: application/json' --data-binary "@$body" "$AUTH_BASE/auth/password/sign-up")"; then
      remove_private_temp "$body"
      return 1
    fi
  else
    if ! response="$(curl --fail-with-body --silent --show-error --connect-timeout 10 --max-time 90 \
      -H 'Content-Type: application/json' --data-binary "@$body" "$AUTH_BASE/auth/password/sign-in")"; then
      remove_private_temp "$body"
      return 1
    fi
  fi
  remove_private_temp "$body"
  token="$(printf '%s' "$response" | json_value 'd["session"]["sessionToken"]')"
  [[ -n "$token" ]] || die "central auth did not return a session token"
  persist_endpoint_config
  state_set email "$email"
  state_set password "$password"
  state_set central_session_token "$token"
  printf '%s\n' "$token"
}

wait_for_binding() {
  local token="$1" response status i
  for i in $(seq 1 15); do
    response="$(curl_with_token "$token" "$AUTH_BASE/auth/shadow/binding" 2>/dev/null || true)"
    status="$(printf '%s' "$response" | json_value 'd.get("binding", {}).get("status", "")' 2>/dev/null || true)"
    if [[ "$status" == "active" ]]; then
      printf '%s\n' "$response"
      return
    fi
    curl_with_token "$token" -X POST "$AUTH_BASE/auth/shadow/binding/retry" >/dev/null 2>&1 || true
    log "waiting for central shadow binding ($i/15, status=${status:-missing})"
    sleep 5
  done
  die "central shadow binding did not become active"
}

ensure_local_identity() {
  local email password body response token local_user_id binding shadow_name uin owner_uin app_id central_token
  require_personal_context
  central_token="$(central_session)"
  prepare_local_credentials
  email="$LOCAL_IDENTITY_EMAIL"
  password="$LOCAL_IDENTITY_PASSWORD"

  new_private_temp local-signup
  body="$TEMP_FILE_RESULT"
  json_body_file "$body" "name=devcloud-$(hostname -s)" "email=$email" "password=$password" # pragma: allowlist secret
  if ! response="$(curl --silent --show-error --connect-timeout 10 --max-time 90 \
    -H 'Content-Type: application/json' --data-binary "@$body" "http://127.0.0.1:8085/auth/password/sign-up")"; then
    remove_private_temp "$body"
    return 1
  fi
  token="$(printf '%s' "$response" | json_value 'd.get("session", {}).get("sessionToken", "")' 2>/dev/null || true)"
  if [[ -z "$token" ]]; then
    if ! response="$(curl --fail-with-body --silent --show-error --connect-timeout 10 --max-time 90 \
      -H 'Content-Type: application/json' --data-binary "@$body" "http://127.0.0.1:8085/auth/password/sign-in")"; then
      remove_private_temp "$body"
      return 1
    fi
  fi
  remove_private_temp "$body"
  token="$(printf '%s' "$response" | json_value 'd["session"]["sessionToken"]')"
  local_user_id="$(printf '%s' "$response" | json_value 'd["session"]["user"]["id"]')"
  [[ "$local_user_id" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid local user id"

  binding="$(wait_for_binding "$central_token")"
  shadow_name="$(printf '%s' "$binding" | json_value 'd.get("binding", {}).get("shadowUserName", "")')"
  uin="$(printf '%s' "$binding" | json_value 'd.get("binding", {}).get("uin", "")')"
  owner_uin="$(printf '%s' "$binding" | json_value 'd.get("binding", {}).get("ownerUin", "")')"
  app_id="$(printf '%s' "$binding" | json_value 'd.get("binding", {}).get("appId", "")')"
  [[ "$shadow_name" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid shadow username"
  [[ "$uin" =~ ^[0-9]+$ && "$owner_uin" =~ ^[0-9]+$ ]] || die "invalid central shadow identity"
  [[ "$app_id" =~ ^[1-9][0-9]*$ ]] \
    || die "central shadow binding is active but appId is unavailable; use a pre-provisioned testing account"

  kubectl exec -i -n localstack-system statefulset/mysql -- \
    sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' <<SQL
USE lightclaw_auth;
INSERT INTO shadow_bindings
  (user_id, shadow_user_name, uin, owner_uin, app_id, status, created_at, updated_at)
VALUES
  ('$local_user_id', '$shadow_name', $uin, $owner_uin, $app_id, 'active', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
ON DUPLICATE KEY UPDATE
  shadow_user_name=VALUES(shadow_user_name), uin=VALUES(uin), owner_uin=VALUES(owner_uin),
  app_id=VALUES(app_id), status='active', last_error_code=NULL, last_error_message=NULL,
  updated_at=UTC_TIMESTAMP(6);
SQL

  state_set local_session_token "$token"
  state_set local_user_id "$local_user_id"
  state_set shadow_user_name "$shadow_name"
  state_set uin "$uin"
  state_set owner_uin "$owner_uin"
  state_set app_id "$app_id"
  log "local browser account is aligned with central shadow uin=$uin"
}

stop_browser_bootstrap() {
  local pid="" cmdline=""
  if [[ -f "$BROWSER_BOOTSTRAP_PID_FILE" ]]; then
    pid="$(tr -dc '0-9' <"$BROWSER_BOOTSTRAP_PID_FILE")"
  fi
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    if [[ -r "/proc/$pid/cmdline" ]]; then
      cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
    else
      cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    fi
    if [[ "$cmdline" == *"browser-login-bootstrap.py"* ]]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$BROWSER_BOOTSTRAP_PID_FILE" "$BROWSER_BOOTSTRAP_READY_FILE"
}

start_browser_bootstrap() {
  local token="$1" ip listen_host token_file nonce pid url i
  [[ -x "$BROWSER_BOOTSTRAP" ]] || die "missing browser bootstrap helper: $BROWSER_BOOTSTRAP"
  [[ -n "$token" ]] || die "browser bootstrap session is empty"
  ip="$(discover_devcloud_ip)"
  listen_host=0.0.0.0
  [[ "$ip" == "127.0.0.1" || "$ip" == "localhost" ]] && listen_host=127.0.0.1
  nonce="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  stop_browser_bootstrap
  token_file="$(mktemp "$STATE_ROOT/browser-session.XXXXXX")"
  chmod 600 "$token_file"
  printf '%s' "$token" >"$token_file"
  unset token
  nohup python3 "$BROWSER_BOOTSTRAP" \
    --listen-host "$listen_host" \
    --port "$BROWSER_BOOTSTRAP_PORT" \
    --public-host "$ip" \
    --frontend-url "http://$ip:5173/dashboard/settings" \
    --nonce "$nonce" \
    --token-file "$token_file" \
    --ready-file "$BROWSER_BOOTSTRAP_READY_FILE" \
    --ttl-seconds "${PERSONAL_DEV_BROWSER_BOOTSTRAP_TTL_SECONDS:-120}" \
    >"$LOG_DIR/browser-bootstrap.log" 2>&1 </dev/null &
  pid=$!
  printf '%s\n' "$pid" >"$BROWSER_BOOTSTRAP_PID_FILE"
  chmod 600 "$BROWSER_BOOTSTRAP_PID_FILE"
  for i in $(seq 1 100); do
    if [[ -s "$BROWSER_BOOTSTRAP_READY_FILE" ]]; then
      url="$(tr -d '\r\n' <"$BROWSER_BOOTSTRAP_READY_FILE")"
      [[ "$url" =~ ^http://[^/]+:[0-9]+/$nonce$ ]] \
        || die "browser bootstrap returned an unexpected URL"
      return 0
    fi
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$token_file" "$BROWSER_BOOTSTRAP_PID_FILE"
      tail -n 20 "$LOG_DIR/browser-bootstrap.log" >&2 || true
      die "browser bootstrap exited before becoming ready"
    fi
    sleep 0.05
  done
  stop_browser_bootstrap
  rm -f "$token_file"
  die "browser bootstrap did not become ready"
}

mint_browser_login() {
  local local_user_id e2e_token body response session_token expires_at port forward_log forward_pid rc=0 i
  local_user_id="$(state_get local_user_id)"
  [[ "$local_user_id" =~ ^[A-Za-z0-9_-]+$ ]] || die "local user is not ready for browser login"
  state_set browser_login_url ""
  [[ "$BROWSER_SESSION_TTL_SECONDS" =~ ^[0-9]+$ ]] \
    || die "PERSONAL_DEV_BROWSER_SESSION_TTL_SECONDS must be an integer"
  ((BROWSER_SESSION_TTL_SECONDS >= 300 && BROWSER_SESSION_TTL_SECONDS <= 86400)) \
    || die "browser session TTL must be between 300 and 86400 seconds"

  e2e_token="$(kubectl get secret lightclaw-auth-secrets -n user-auth \
    -o jsonpath='{.data.LIGHTVELA_E2E_AUTH_TOKEN}' | base64 --decode)"
  [[ -n "$e2e_token" ]] || die "local Auth E2E token is missing"

  port="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
  new_private_temp browser-login-body
  body="$TEMP_FILE_RESULT"
  python3 - "$body" "$local_user_id" "http://$(discover_devcloud_ip):5173/" "$BROWSER_SESSION_TTL_SECONDS" <<'PY'
import json, sys
path, user_id, return_to, ttl = sys.argv[1:]
with open(path, "w", encoding="utf-8") as output:
    json.dump({"userId": user_id, "returnTo": return_to, "ttlSeconds": int(ttl)}, output)
PY
  new_private_temp auth-port-forward
  forward_log="$TEMP_FILE_RESULT"
  kubectl port-forward -n user-auth --address 127.0.0.1 service/lightclaw-auth "$port:80" \
    >"$forward_log" 2>&1 </dev/null &
  forward_pid=$!
  for i in $(seq 1 50); do
    if curl --fail --silent --show-error --max-time 1 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$forward_pid" >/dev/null 2>&1; then
      rc=1
      break
    fi
    sleep 0.1
  done
  if [[ "$rc" == "0" ]]; then
    response="$(curl_with_token "$e2e_token" \
      -H 'Content-Type: application/json' --data-binary "@$body" \
      "http://127.0.0.1:$port/admin/e2e/session-mint")" || rc=$?
  fi
  kill "$forward_pid" >/dev/null 2>&1 || true
  wait "$forward_pid" >/dev/null 2>&1 || true
  remove_private_temp "$body"
  remove_private_temp "$forward_log"
  unset e2e_token
  [[ "$rc" == "0" ]] || die "local Auth could not mint the temporary browser session"

  session_token="$(printf '%s' "$response" | json_value 'd["sessionToken"]')"
  expires_at="$(printf '%s' "$response" | json_value 'd["expiresAt"]')"
  [[ -n "$session_token" ]] || die "local Auth returned an empty browser session"
  state_set browser_login_expires_at "$expires_at"
  start_browser_bootstrap "$session_token"
  unset response session_token
  log "temporary browser login is ready until $expires_at"
}

ensure_devtunnel_agent_binary() {
  local revision build_cache
  revision="$(python3 - "$REPO_ROOT" <<'PY'
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
inputs = [
    root / "cloudladdergateway" / "go.mod",
    root / "cloudladdergateway" / "go.sum",
    root / "cloudladdergateway" / "cmd" / "devtunnel-agent",
    root / "cloudladdergateway" / "internal" / "devtunnel",
    root / "shared" / "cloudladdertransport",
]
digest = hashlib.sha256()
for entry in inputs:
    if not entry.exists():
        raise SystemExit(f"missing devtunnel build input: {entry}")
    files = [entry] if entry.is_file() else sorted(path for path in entry.rglob("*") if path.is_file())
    for path in files:
        relative = path.relative_to(root).as_posix().encode()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
print(digest.hexdigest())
PY
)" || die "cannot fingerprint the current checkout's devtunnel-agent sources"
  if [[ -x "$DEVTUNNEL_BIN" && "$(state_get devtunnel_revision)" == "$revision" ]]; then
    return 0
  fi
  build_cache="$STATE_ROOT/devtunnel-build-cache"
  mkdir -p "$build_cache/gomod" "$build_cache/gocache"
  chmod 700 "$build_cache" "$build_cache/gomod" "$build_cache/gocache"
  log "building devtunnel-agent from current checkout@$revision"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e GOMODCACHE=/cache/gomod \
    -e GOCACHE=/cache/gocache \
    -v "$REPO_ROOT:/workspace:ro" \
    -v "$build_cache:/cache" \
    -v "$TOOLS_DIR:/output" \
    -w /workspace/cloudladdergateway \
    golang:1.26 \
    sh -c 'CGO_ENABLED=0 go build -mod=readonly -trimpath -o /output/devtunnel-agent ./cmd/devtunnel-agent'
  chmod 700 "$DEVTUNNEL_BIN"
  state_set devtunnel_revision "$revision"
}

stop_devtunnel_agent() {
  local pid="" cmdline=""
  [[ -f "$DEVTUNNEL_PID_FILE" ]] || return 0
  pid="$(tr -dc '0-9' <"$DEVTUNNEL_PID_FILE")"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    if [[ -r "/proc/$pid/cmdline" ]]; then
      cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
    else
      cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    fi
    if [[ "$cmdline" == *"devtunnel-agent"* ]]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$DEVTUNNEL_PID_FILE"
  state_set devtunnel_agent_status stopped
}

devtunnel_agent_running() {
  local expected_host="$1" pid cmdline=""
  [[ -f "$DEVTUNNEL_PID_FILE" ]] || return 1
  pid="$(tr -dc '0-9' <"$DEVTUNNEL_PID_FILE")"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1 || return 1
  if [[ -r "/proc/$pid/cmdline" ]]; then
    cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
  else
    cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  fi
  [[ "$cmdline" == *"devtunnel-agent"* && "$cmdline" == *"$expected_host"* ]]
}

ensure_devtunnel_agent() {
  local tunnel_host="$1" tunnel_token="$2" token_sha pid
  [[ "$tunnel_host" =~ ^[A-Za-z0-9.-]+$ ]] || die "registration did not return a valid tunnelHost"
  [[ "$tunnel_token" =~ ^[A-Za-z0-9._~+/=-]+$ && ${#tunnel_token} -ge 16 && ${#tunnel_token} -le 512 ]] \
    || die "registration did not return a valid short-lived tunnel capability"
  token_sha="$(printf '%s' "$tunnel_token" | if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | awk '{print $1}')"
  if devtunnel_agent_running "$tunnel_host" && [[ "$(state_get tunnel_token_sha256)" == "$token_sha" ]]; then
    return 0
  fi
  stop_devtunnel_agent
  ensure_devtunnel_agent_binary
  DEVTUNNEL_TOKEN="$tunnel_token" nohup "$DEVTUNNEL_BIN" \
    -hub "$CLGATEWAY_BASE/v1/proxy/devtunnel" \
    -env "$tunnel_host" \
    -local "http://127.0.0.1:$CALLBACK_PORT" \
    -allow-prefix "/trade/jifei/callback" \
    >"$LOG_DIR/devtunnel-agent.log" 2>&1 </dev/null &
  pid=$!
  printf '%s\n' "$pid" >"$DEVTUNNEL_PID_FILE"
  chmod 600 "$DEVTUNNEL_PID_FILE"
  sleep 2
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    tail -n 20 "$LOG_DIR/devtunnel-agent.log" >&2 || true
    die "devtunnel-agent failed to start"
  fi
  state_set tunnel_host "$tunnel_host"
  state_set tunnel_token_sha256 "$token_sha"
  state_set devtunnel_agent_status running
  unset tunnel_token
  log "devtunnel-agent is polling tunnelHost=$tunnel_host and replays only to callback-only 127.0.0.1:$CALLBACK_PORT"
}

register_route() {
  prepare_state
  ensure_site_activation_safe
  require_personal_context
  persist_endpoint_config
  local token response safe_response ip registered_uin target_ip registered_port status tunnel_host tunnel_token expires_at registration_body
  token="$(central_session)"
  ip="$(discover_devcloud_ip)"
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$CALLBACK_PORT/healthz" >/dev/null \
    || die "local trade callback is not healthy on port $CALLBACK_PORT"
  registration_body="{\"targetIp\":\"$ip\",\"port\":$CALLBACK_PORT,\"ttlSeconds\":$TTL_SECONDS}"
  response="$(curl_with_token "$token" -X POST -H 'Content-Type: application/json' \
    --data-binary "$registration_body" "$REGISTRATION_URL")"
  registered_uin="$(printf '%s' "$response" | json_value 'd.get("uin", "")' 2>/dev/null || true)"
  target_ip="$(printf '%s' "$response" | json_value 'd.get("targetIp", "")' 2>/dev/null || true)"
  registered_port="$(printf '%s' "$response" | json_value 'd.get("port", "")' 2>/dev/null || true)"
  status="$(printf '%s' "$response" | json_value 'd.get("status", "")' 2>/dev/null || true)"
  tunnel_host="$(printf '%s' "$response" | json_value 'd.get("tunnelHost", "")' 2>/dev/null || true)"
  tunnel_token="$(printf '%s' "$response" | json_value 'd.get("tunnelToken", "")' 2>/dev/null || true)"
  expires_at="$(printf '%s' "$response" | json_value 'd.get("expiresAt", "")' 2>/dev/null || true)"
  [[ "$registered_uin" == "$(state_get uin)" ]] || die "registration returned an unexpected uin"
  [[ "$status" == "active" ]] || die "registration is not active: ${status:-missing}"
  [[ "$target_ip" == "$ip" && "$registered_port" == "$CALLBACK_PORT" ]] \
    || die "registration source address mismatch: expected $ip:$CALLBACK_PORT, got ${target_ip:-missing}:${registered_port:-missing}"
  if [[ ! "$tunnel_token" =~ ^[A-Za-z0-9._~+/=-]+$ || ${#tunnel_token} -lt 16 || ${#tunnel_token} -gt 512 ]]; then
    curl_with_token "$token" -X DELETE "$REGISTRATION_URL" >/dev/null 2>&1 || true
    die "registration API did not return a short-lived tunnel capability; unsafe active registration was disabled"
  fi
  ensure_devtunnel_agent "$tunnel_host" "$tunnel_token"
  safe_response="$(printf '%s' "$response" | json_without_secrets)"
  state_set devcloud_ip "$ip"
  state_set registration_response "$safe_response"
  state_set registration_status "$status"
  state_set registration_expires_at "$expires_at"
  state_set registration_target_ip "$target_ip"
  state_set registration_port "$registered_port"
  state_set tunnel_host "$tunnel_host"
  state_set registered_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  unset tunnel_token
  mark_current_site
  log "registered uin=$(state_get uin) through tunnelHost=$tunnel_host"
}

stop_heartbeat() {
  local pid=""
  [[ -f "$HEARTBEAT_PID_FILE" ]] || return 0
  pid="$(tr -dc '0-9' <"$HEARTBEAT_PID_FILE")"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    local cmdline=""
    if [[ -r "/proc/$pid/cmdline" ]]; then
      cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
    else
      cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    fi
    if [[ "$cmdline" == *"personal-devcloud.sh"*"heartbeat-loop"* ]]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$HEARTBEAT_PID_FILE"
}

start_heartbeat() {
  stop_heartbeat
  nohup env PERSONAL_DEV_SITE="$SITE" PERSONAL_DEV_STATE_DIR="$STATE_BASE" \
    "$SCRIPT_DIR/personal-devcloud.sh" heartbeat-loop >"$LOG_DIR/heartbeat.log" 2>&1 </dev/null &
  printf '%s\n' "$!" >"$HEARTBEAT_PID_FILE"
  chmod 600 "$HEARTBEAT_PID_FILE"
  log "registration heartbeat started"
}

heartbeat_loop() {
  local iterations=0 max_iterations="${PERSONAL_DEV_HEARTBEAT_MAX_ITERATIONS:-0}"
  while true; do
    sleep "${PERSONAL_DEV_HEARTBEAT_INTERVAL_SECONDS:-14400}"
    if ! heartbeat_once; then
      log "registration heartbeat failed; the loop remains alive and will retry"
    fi
    iterations=$((iterations + 1))
    if [[ "$max_iterations" =~ ^[0-9]+$ && "$max_iterations" != "0" && "$iterations" -ge "$max_iterations" ]]; then
      return 0
    fi
  done
}

heartbeat_once() {
  env PERSONAL_DEV_SITE="$SITE" PERSONAL_DEV_STATE_DIR="$STATE_BASE" \
    "$SCRIPT_DIR/personal-devcloud.sh" heartbeat
}

register_command() {
  prepare_state
  ensure_site_activation_safe
  require_personal_context
  ensure_local_identity
  mint_browser_login
  register_route
  start_heartbeat
  show_access
}

show_access() {
  local ip login_url=""
  ip="$(discover_devcloud_ip)"
  log "frontend=http://$ip:5173"
  log "gateway=http://$ip:8085"
  if [[ -s "$BROWSER_BOOTSTRAP_READY_FILE" ]]; then
    login_url="$(tr -d '\r\n' <"$BROWSER_BOOTSTRAP_READY_FILE")"
    log "one_time_login=$login_url expires_at=$(state_get browser_login_expires_at)"
  else
    log "browser_login=expired; run browser-login to create a new one-time URL"
  fi
}

browser_login() {
  prepare_state
  require_personal_context
  mint_browser_login
  show_access
}

mysql_scalar() {
  local sql="$1"
  kubectl exec -i -n localstack-system statefulset/mysql -- \
    sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -N -B -uroot -e "$1"' sh "$sql"
}

up() {
  prepare_state
  ensure_site_activation_safe
  bootstrap
  local ip
  ip="$(discover_devcloud_ip)"
  clear_legacy_runtime_overrides
  LOCALSTACK_SITE_KIND="$SITE" LOCALSTACK_PUBLIC_HOST="$ip" \
    LOCALSTACK_STATE_DIR="$STATE_ROOT/localstack" \
    LOCALSTACK_JIFEI_GATEWAY_URL="$CLGATEWAY_BASE/v1/proxy/jifei-test/interfaces/interface.php" \
    PERSONAL_DEV_REAL_KUSTOMIZE="$(command -v kustomize)" \
    PERSONAL_DEV_RUNTIME_SITE="$SITE" PERSONAL_DEV_RUNTIME_PUBLIC_HOST="$ip" \
    PERSONAL_DEV_RUNTIME_JIFEI_GATEWAY="$CLGATEWAY_BASE/v1/proxy/jifei-test/interfaces/interface.php" \
    KUBECTL="$(command -v kubectl)" KUSTOMIZE="$RUNTIME_KUSTOMIZE" \
    "$LOCALSTACK" up
  state_set stack_status up
  mark_current_site
  register_command
}

status() {
  prepare_state
  require_personal_context
  local token="" ip="" response="" status="" target_ip="" registered_port="" tunnel_host="" rc=0
  token="$(state_get central_session_token)"
  ip="$(discover_devcloud_ip 2>/dev/null || true)"
  log "site=$SITE devcloud_ip=${ip:-unknown} uin=$(state_get uin)"
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:5173/healthz" || rc=1
  printf '\n'
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:8085/healthz" || rc=1
  printf '\n'
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$CALLBACK_PORT/healthz" || rc=1
  printf '\n'
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$INTERNAL_TRADE_PORT/healthz" || rc=1
  printf '\n'
  if [[ -n "$token" ]]; then
    if response="$(curl_with_token "$token" "$REGISTRATION_URL")"; then
      printf '%s\n' "$response"
      status="$(printf '%s' "$response" | json_value 'd.get("status", "")' 2>/dev/null || true)"
      target_ip="$(printf '%s' "$response" | json_value 'd.get("targetIp", "")' 2>/dev/null || true)"
      registered_port="$(printf '%s' "$response" | json_value 'd.get("port", "")' 2>/dev/null || true)"
      tunnel_host="$(printf '%s' "$response" | json_value 'd.get("tunnelHost", "")' 2>/dev/null || true)"
      [[ "$status" == "active" ]] || rc=1
      [[ -n "$ip" && "$target_ip" == "$ip" && "$registered_port" == "$CALLBACK_PORT" ]] || rc=1
      [[ "$tunnel_host" =~ ^[A-Za-z0-9.-]+$ ]] || rc=1
      devtunnel_agent_running "$tunnel_host" || rc=1
    else
      rc=1
    fi
  else
    rc=1
  fi
  kubectl get pods -A -l app.kubernetes.io/part-of=lightclaw-localstack -o wide || rc=1
  local pod_namespace pod_name
  while IFS=$'\t' read -r pod_namespace pod_name; do
    [[ -n "$pod_namespace" && -n "$pod_name" ]] || continue
    kubectl wait --for=condition=Ready "pod/$pod_name" -n "$pod_namespace" --timeout=2s >/dev/null || rc=1
  done < <(kubectl get pods -A -l app.kubernetes.io/part-of=lightclaw-localstack \
    --field-selector=status.phase!=Succeeded,status.phase!=Failed \
    -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\n"}{end}' 2>/dev/null) || rc=1
  heartbeat_running || rc=1
  return "$rc"
}

heartbeat_running() {
  local pid="" cmdline=""
  [[ -f "$HEARTBEAT_PID_FILE" ]] || return 1
  pid="$(tr -dc '0-9' <"$HEARTBEAT_PID_FILE")"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1 || return 1
  if [[ -r "/proc/$pid/cmdline" ]]; then
    cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
  else
    cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  fi
  [[ "$cmdline" == *"personal-devcloud.sh"*"heartbeat-loop"* ]]
}

require_active_registration() {
  local token response status target_ip registered_port tunnel_host ip
  token="$(central_session)"
  response="$(curl_with_token "$token" "$REGISTRATION_URL")"
  status="$(printf '%s' "$response" | json_value 'd.get("status", "")' 2>/dev/null || true)"
  target_ip="$(printf '%s' "$response" | json_value 'd.get("targetIp", "")' 2>/dev/null || true)"
  registered_port="$(printf '%s' "$response" | json_value 'd.get("port", "")' 2>/dev/null || true)"
  tunnel_host="$(printf '%s' "$response" | json_value 'd.get("tunnelHost", "")' 2>/dev/null || true)"
  [[ "$status" == "active" ]] || die "developer route is not active"
  ip="$(discover_devcloud_ip)"
  [[ "$target_ip" == "$ip" && "$registered_port" == "$CALLBACK_PORT" ]] \
    || die "developer route is registered for ${target_ip:-missing}:${registered_port:-missing}, not this DevCloud $ip:$CALLBACK_PORT"
  devtunnel_agent_running "$tunnel_host" || die "devtunnel-agent is not running for tunnelHost=${tunnel_host:-missing}"
}

verify_order_no_pay() {
  prepare_state
  require_personal_context
  require_active_registration
  local uin app_id internal_token inquiry_body order_body inquiry_response order_response
  local price_count currencies expected_currency flow_before flow_after pass_before pass_after
  local deal_name big_order_id order_record rc
  uin="$(state_get uin)"
  app_id="$(state_get app_id)"
  [[ "$uin" =~ ^[0-9]+$ && "$app_id" =~ ^[0-9]+$ ]] || die "run up/register first"
  internal_token="$(kubectl get secret -n trade trade-runtime-secrets -o jsonpath='{.data.LIGHTCLAW_INTERNAL_SERVICE_TOKEN}' | base64 --decode)"
  new_private_temp inquiry
  inquiry_body="$TEMP_FILE_RESULT"
  new_private_temp order
  order_body="$TEMP_FILE_RESULT"
  python3 - "$inquiry_body" "$uin" "$app_id" <<'PY'
import json, sys, time
path, uin, app_id = sys.argv[1:]
payload = {
    "externalUserId": f"probe_{time.time_ns()}",
    "uin": uin,
    "appId": app_id,
    "bundleIds": ["bundle_launch_01", "bundle_cruise_01"],
    "period": 1,
    "timeUnit": "m",
    "goodsNum": 1,
    "payMode": 1,
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh)
PY
  if inquiry_response="$(curl_with_token "$internal_token" -H 'Content-Type: application/json' \
    --data-binary "@$inquiry_body" "http://127.0.0.1:$INTERNAL_TRADE_PORT/internal/trade/inquiry/batch")"; then
    remove_private_temp "$inquiry_body"
  else
    rc=$?
    remove_private_temp "$inquiry_body"
    remove_private_temp "$order_body"
    unset internal_token
    return "$rc"
  fi
  price_count="$(printf '%s' "$inquiry_response" | json_value 'len(d.get("prices", []))' 2>/dev/null || true)"
  currencies="$(printf '%s' "$inquiry_response" | json_value '",".join(sorted(set(str(x.get("currency", "")) for x in d.get("prices", []))))' 2>/dev/null || true)"
  expected_currency=CNY
  [[ "$SITE" == "intl" ]] && expected_currency=USD
  [[ "$price_count" == "2" && "$currencies" == "$expected_currency" ]] || {
    remove_private_temp "$order_body"
    unset internal_token
    die "inquiry verification failed: price_count=${price_count:-invalid} currencies=${currencies:-invalid}, expected $expected_currency"
  }

  flow_before="$(mysql_scalar 'SELECT COUNT(*) FROM trade.trade_flow;')"
  pass_before="$(mysql_scalar 'SELECT COUNT(*) FROM ctl.`pass`;')"

  python3 - "$order_body" "$uin" "$app_id" <<'PY'
import json, sys, time
path, uin, app_id = sys.argv[1:]
payload = {
    "externalUserId": f"probe_{time.time_ns()}",
    "uin": uin,
    "appId": app_id,
    "bundleId": "bundle_launch_01",
    "period": 1,
    "timeUnit": "m",
    "goodsNum": 1,
    "payMode": 1,
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh)
PY
  if order_response="$(curl_with_token "$internal_token" -H 'Content-Type: application/json' \
    --data-binary "@$order_body" "http://127.0.0.1:$INTERNAL_TRADE_PORT/internal/trade/orders")"; then
    remove_private_temp "$order_body"
    unset internal_token
  else
    rc=$?
    remove_private_temp "$order_body"
    unset internal_token
    return "$rc"
  fi

  deal_name="$(printf '%s' "$order_response" | json_value 'd.get("dealName", "")' 2>/dev/null || true)"
  big_order_id="$(printf '%s' "$order_response" | json_value 'd.get("bigOrderId", "")' 2>/dev/null || true)"
  [[ "$deal_name" =~ ^[A-Za-z0-9_-]+$ && "$big_order_id" =~ ^[A-Za-z0-9_-]+$ ]] \
    || die "order verification failed: missing or invalid dealName/bigOrderId"
  order_record="$(mysql_scalar "SELECT CONCAT_WS('|', status, big_order_id, uin, app_id, bundle_id) FROM trade.trade_order WHERE deal_name='$deal_name';")"
  [[ "$order_record" == "pending_pay|$big_order_id|$uin|$app_id|bundle_launch_01" ]] \
    || die "order verification failed: unexpected personal trade_order state"
  flow_after="$(mysql_scalar 'SELECT COUNT(*) FROM trade.trade_flow;')"
  pass_after="$(mysql_scalar 'SELECT COUNT(*) FROM ctl.`pass`;')"
  [[ "$flow_after" == "$flow_before" ]] || die "no-pay verification created trade_flow rows"
  [[ "$pass_after" == "$pass_before" ]] || die "no-pay verification created ctl pass rows"

  printf '%s\n%s\n' "$inquiry_response" "$order_response"
  log "verified inquiry currency=$expected_currency and no-pay order deal=$deal_name status=pending_pay; no billing callback was expected"
}

verify_checkcreate_no_pay() {
  log "verify-checkcreate-no-pay is deprecated: an unpaid order does not prove a checkCreate callback"
  verify_order_no_pay
}

verify_checkmodify_no_pay() {
  die "checkModify verification is not implemented by this checkout's Trade API; verify-order-no-pay must not be reported as upgrade coverage"
}

verify_no_pay() {
  verify_order_no_pay
}

unregister() {
  prepare_state
  stop_heartbeat
  local token response rc=0
  if ! token="$(central_session)"; then
    stop_devtunnel_agent
    die "cannot refresh central session for unregister"
  fi
  if response="$(curl_with_token "$token" -X DELETE "$REGISTRATION_URL")"; then
    printf '%s\n' "$response"
    state_set registration_response "$response"
    state_set registration_status disabled
    state_set registration_expires_at "$(printf '%s' "$response" | json_value 'd.get("expiresAt", "")' 2>/dev/null || true)"
  else
    rc=$?
  fi
  stop_devtunnel_agent
  [[ "$rc" == "0" ]] || return "$rc"
  printf '\n'
  log "developer route disabled; tombstone retained to prevent shared-environment fallback"
}

down() {
  prepare_state
  stop_browser_bootstrap
  if ! unregister_for_down; then
    log "unregister failed; continuing local shutdown so callback replay becomes unreachable"
  fi
  require_personal_context
  LOCALSTACK_SITE_KIND="$SITE" LOCALSTACK_STATE_DIR="$STATE_ROOT/localstack" \
    KUBECTL="$(command -v kubectl)" KUSTOMIZE="$(command -v kustomize)" \
    "$LOCALSTACK" down
  state_set stack_status down
}

unregister_for_down() {
  env PERSONAL_DEV_SITE="$SITE" PERSONAL_DEV_STATE_DIR="$STATE_BASE" \
    "$SCRIPT_DIR/personal-devcloud.sh" unregister
}

usage() {
  cat <<'EOF'
Usage: personal-devcloud.sh <command>

Commands:
  doctor          Check DevCloud IP, Docker, and required tools
  bootstrap       Install user-local tools and create/reuse a kind cluster
  up              Build the full stack, provision identity, register callback, start heartbeat
  register        Align local identity and register/renew this DevCloud callback
  heartbeat       Renew the dynamic registration once
  heartbeat-loop  Internal background renewal loop
  status          Show local health, registration, and Kubernetes workload state
  browser-login   Create a single-use browser login URL without printing its session token
  verify-order-no-pay        Run inquiry, create a pending-pay order, and expect no billing callback
  verify-checkcreate-no-pay  Deprecated alias; does not prove checkCreate
  verify-checkmodify-no-pay  Refuse until this checkout exposes a real modify-order API
  verify-no-pay              Compatibility alias for verify-order-no-pay
  unregister      Disable the dynamic route and keep a fail-closed tombstone
  down            Unregister and stop localstack while preserving PVC data
EOF
}

main() {
  local command="${1:-}"
  case "$command" in
    doctor) doctor ;;
    bootstrap) bootstrap ;;
    up) up ;;
    register) register_command ;;
    heartbeat) register_route ;;
    heartbeat-loop) heartbeat_loop ;;
    status) status ;;
    browser-login) browser_login ;;
    verify-order-no-pay) verify_order_no_pay ;;
    verify-checkcreate-no-pay) verify_checkcreate_no_pay ;;
    verify-checkmodify-no-pay) verify_checkmodify_no_pay ;;
    verify-no-pay) verify_no_pay ;;
    unregister) unregister ;;
    down) down ;;
    *) usage; [[ -z "$command" ]] || exit 1 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
