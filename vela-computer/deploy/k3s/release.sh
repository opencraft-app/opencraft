#!/bin/sh
set -eu

umask 077

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd -P)
namespace=dep
backend_deployment=chatserver-canary
computer_service=vela-computer.service
computer_root=/var/lib/vela/computer
bucket=an-computer-1388575217
region=ap-beijing
buildx_builder=vela-computer-release
version=
builder=
builder_port=36000
builder_identity=
target=
target_port=36000
target_identity=
computer=
computer_port=36000
computer_identity=
expected_agent_ids=
update_channel_url=
allow_insecure_update_http=false
release_key_id=
release_private_key=
release_public_key=
channel_key_id=
channel_public_key=
evidence=
temporary_root=
builder_root=
target_root=
computer_stage=
computer_transaction=
original_catalog=
original_catalog_version=
original_computer_version=
original_computer_sha=
target_catalog=
catalog_patched=false
computer_patched=false
rollback_succeeded=false
commit=
mac_hash=
linux_hash=

usage() {
  cat <<'EOF'
用法：
  agent/deploy/k3s/release.sh deploy \
    --version vX.Y.Z \
    --builder USER@HOST --builder-port 36000 --builder-identity /absolute/key \
    --target root@K3S_HOST --target-port 36000 --target-identity /absolute/key \
    --computer root@COMPUTER_HOST --computer-port 36000 --computer-identity /absolute/key \
    --expected-agent-id UUID [--expected-agent-id UUID ...] \
    --update-channel-url https://UPDATE_HOST \
    --release-key-id ID --release-private-key /absolute/key --release-public-key /absolute/key \
    --channel-key-id ID --channel-public-key /absolute/key \
    --evidence /absolute/new-directory \
    [--allow-insecure-update-http] [--namespace dep]

Mac 运行 TUI/Agent 门禁并构建 darwin-arm64；授权 Linux Buildx host 构建
linux-amd64；k3s target 只切 immutable catalog；指定测试 Computer 通过
公钥 SSH 做带备份、健康验收和自动回滚的原子升级。
EOF
}

fail() { echo "独立 k3s Computer 发布失败：$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "缺少命令 $1"; }

validate_port() {
  case "$1" in ''|*[!0-9]*) fail "$2 必须是端口" ;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || fail "$2 超出范围"
}

validate_host() { case "$1" in ''|*[!A-Za-z0-9._@:-]*) fail "$2 无效" ;; esac; }
validate_identity() {
  case "$1" in /*) ;; *) fail "$2 必须是绝对路径" ;; esac
  [ -f "$1" ] && [ ! -L "$1" ] || fail "$2 不是普通文件"
}

ssh_builder() { ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$builder_identity" -p "$builder_port" "$builder" "$@"; }
ssh_target() { ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$target_identity" -p "$target_port" "$target" "$@"; }
ssh_computer() { ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$computer_identity" -p "$computer_port" "$computer" "$@"; }

ensure_builder_prerequisites() {
  ssh_builder 'set -eu; command -v docker >/dev/null; command -v tar >/dev/null; command -v sh >/dev/null'
}

# jq is a release-runner dependency on the trusted k3s control host: it
# validates the immutable catalog and is also needed by rollback. Bootstrap it
# before any external release mutation so a fresh target does not fail midway.
ensure_target_prerequisites() {
  ssh_target sh -s <<'REMOTE_PREREQUISITES'
set -eu
command -v k3s >/dev/null
if ! command -v jq >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y jq
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y jq
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache jq
  else
    echo "无法自动安装 jq：目标主机没有受支持的包管理器" >&2
    exit 1
  fi
fi
for command in k3s jq base64 sh; do command -v "$command" >/dev/null; done
REMOTE_PREREQUISITES
}

ensure_computer_prerequisites() {
  ssh_computer 'set -eu; for command in systemctl jq sha256sum awk cp mv mktemp sh; do command -v "$command" >/dev/null; done'
}

quote_remote() { printf "'"; printf '%s' "$1" | sed "s/'/'\\''/g"; printf "'"; }
target_kubectl() {
  command="k3s kubectl -n $(quote_remote "$namespace")"
  for argument in "$@"; do command="$command $(quote_remote "$argument")"; done
  ssh_target "$command"
}

backend_ready() {
  state=$(target_kubectl get deployment "$backend_deployment" -o 'jsonpath={.metadata.generation}{" "}{.status.observedGeneration}{" "}{.spec.replicas}{" "}{.status.updatedReplicas}{" "}{.status.readyReplicas}{" "}{.status.availableReplicas}{" "}{.status.unavailableReplicas}{"\n"}') || return 1
  # shellcheck disable=SC2086
  set -- $state
  [ "$#" -eq 6 ] && set -- "$@" 0
  [ "$#" -eq 7 ] && [ "$1" = "$2" ] && [ "$3" = 1 ] &&
    [ "$4" = 1 ] && [ "$5" = 1 ] && [ "$6" = 1 ] && [ "$7" = 0 ]
}

wait_backend() {
  attempt=0
  while [ "$attempt" -lt 300 ]; do
    backend_ready && return 0
    attempt=$((attempt + 2)); sleep 2
  done
  return 1
}

rollback_catalog() {
  [ "$catalog_patched" = true ] || return 0
  patch=$(jq -nc --arg catalog "$original_catalog" --arg version "$original_catalog_version" '{spec:{template:{metadata:{annotations:{"agentnetwork.io/computer-release":$version}},spec:{volumes:[{name:"computer-release",configMap:{name:$catalog,defaultMode:292}}]}}}}')
  target_kubectl patch deployment "$backend_deployment" --type=strategic -p "$patch" >/dev/null || return 1
  wait_backend || return 1
  restored=$(target_kubectl get deployment "$backend_deployment" -o 'jsonpath={.spec.template.spec.volumes[?(@.name=="computer-release")].configMap.name}') || return 1
  [ "$restored" = "$original_catalog" ] || return 1
  catalog_patched=false
}

rollback_computer() {
  [ "$computer_patched" = true ] || return 0
  ssh_computer sh -s -- "$computer_root" "$computer_service" "$computer_transaction" "$original_computer_version" "$original_computer_sha" "$expected_agent_ids" <<'REMOTE_ROLLBACK'
set -eu
root=$1
service=$2
transaction=$3
expected_version=$4
expected_sha=$5
expected_agents=$6
[ -f "$transaction/vela-computer" ] && [ -f "$transaction/install.journal.json" ]
systemctl stop "$service"
cp -p "$transaction/vela-computer" "$root/bin/vela-computer"
cp -p "$transaction/install.journal.json" "$root/state/install.journal.json"
systemctl start "$service"
for attempt in $(seq 1 60); do
  ready=true
  for agent in $expected_agents; do jq -e --arg version "$expected_version" --arg agent "$agent" '.version==$version and .online==true and any(.agents[]; .agentId==$agent and .phase=="running" and .health=="ready")' "$root/state/daemon.state.json" >/dev/null 2>&1 || ready=false; done
  if systemctl is-active --quiet "$service" && [ "$(sha256sum "$root/bin/vela-computer" | awk '{print $1}')" = "$expected_sha" ] && [ "$ready" = true ]; then exit 0; fi
  sleep 2
done
exit 1
REMOTE_ROLLBACK
  computer_patched=false
}

write_evidence() {
  status=$1
  rolled_back=$2
  jq -n \
    --arg status "$status" --arg commit "$commit" --arg version "$version" \
    --arg catalog "$target_catalog" --arg macSHA256 "$mac_hash" \
    --arg linuxSHA256 "$linux_hash" --arg computer "$computer" \
    --argjson rolledBack "$rolled_back" \
    '{schemaVersion:1,status:$status,commit:$commit,version:$version,catalog:$catalog,targets:{"darwin-arm64":$macSHA256,"linux-amd64":$linuxSHA256},computer:$computer,rolledBack:$rolledBack,recordedAt:(now|todateiso8601)}' \
    >"$evidence/release-evidence.json"
  chmod 0600 "$evidence/release-evidence.json"
}

cleanup() {
  code=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$code" -ne 0 ]; then
    rollback_computer
    computer_rollback=$?
    rollback_catalog
    catalog_rollback=$?
    [ "$computer_rollback" -eq 0 ] && [ "$catalog_rollback" -eq 0 ] && rollback_succeeded=true
  fi
  case "$builder_root" in /tmp/vela-computer-k3s.*) ssh_builder sh -s -- "$builder_root" <<'REMOTE_CLEAN' >/dev/null 2>&1 || true
set -eu
case "$1" in /tmp/vela-computer-k3s.*) find "$1" -depth -delete ;; *) exit 2 ;; esac
REMOTE_CLEAN
  esac
  case "$target_root" in /tmp/vela-computer-k3s.*) ssh_target sh -s -- "$target_root" <<'REMOTE_CLEAN' >/dev/null 2>&1 || true
set -eu
case "$1" in /tmp/vela-computer-k3s.*) find "$1" -depth -delete ;; *) exit 2 ;; esac
REMOTE_CLEAN
  esac
  case "$computer_stage" in /var/lib/vela/computer/bin/.vela-computer.*) ssh_computer "find $(quote_remote "$computer_stage") -maxdepth 0 -type f -delete" >/dev/null 2>&1 || true ;; esac
  case "$temporary_root" in "${TMPDIR:-/tmp}"/vela-computer-k3s.*) find "$temporary_root" -depth -delete ;; esac
  if [ -n "$evidence" ] && [ -d "$evidence" ]; then
    if [ "$code" -eq 0 ]; then write_evidence published false
    elif [ "$rollback_succeeded" = true ]; then write_evidence rolled_back true
    else write_evidence failed false
    fi
  fi
  exit "$code"
}
trap cleanup EXIT HUP INT TERM

case "${1:-}" in -h|--help) usage; exit 0 ;; deploy) shift ;; *) usage >&2; exit 2 ;; esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) version=$2; shift 2 ;; --builder) builder=$2; shift 2 ;;
    --builder-port) builder_port=$2; shift 2 ;; --builder-identity) builder_identity=$2; shift 2 ;;
    --target) target=$2; shift 2 ;; --target-port) target_port=$2; shift 2 ;;
    --target-identity) target_identity=$2; shift 2 ;; --computer) computer=$2; shift 2 ;;
    --computer-port) computer_port=$2; shift 2 ;; --computer-identity) computer_identity=$2; shift 2 ;;
    --expected-agent-id) expected_agent_ids="$expected_agent_ids $2"; shift 2 ;;
    --update-channel-url) update_channel_url=$2; shift 2 ;;
    --allow-insecure-update-http) allow_insecure_update_http=true; shift ;;
    --release-key-id) release_key_id=$2; shift 2 ;; --release-private-key) release_private_key=$2; shift 2 ;;
    --release-public-key) release_public_key=$2; shift 2 ;; --channel-key-id) channel_key_id=$2; shift 2 ;;
    --channel-public-key) channel_public_key=$2; shift 2 ;; --evidence) evidence=$2; shift 2 ;;
    --namespace) namespace=$2; shift 2 ;; --backend-deployment) backend_deployment=$2; shift 2 ;;
    --bucket) bucket=$2; shift 2 ;; --region) region=$2; shift 2 ;;
    --buildx-builder) buildx_builder=$2; shift 2 ;; -h|--help) usage; exit 0 ;; *) fail "未知参数 $1" ;;
  esac
done

printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$' || fail "version 无效"
validate_host "$builder" --builder; validate_host "$target" --target; validate_host "$computer" --computer
validate_port "$builder_port" --builder-port; validate_port "$target_port" --target-port; validate_port "$computer_port" --computer-port
validate_identity "$builder_identity" --builder-identity; validate_identity "$target_identity" --target-identity; validate_identity "$computer_identity" --computer-identity
validate_identity "$release_private_key" --release-private-key; validate_identity "$release_public_key" --release-public-key; validate_identity "$channel_public_key" --channel-public-key
[ "$(stat -f '%Lp' "$release_private_key")" = 600 ] || fail "Release 私钥权限必须是 0600"
[ -n "$(printf '%s' "$expected_agent_ids" | tr -d ' ')" ] || fail "至少提供一个 --expected-agent-id"
for id in $expected_agent_ids; do printf '%s\n' "$id" | grep -Eq '^[0-9a-f]{8}-[0-9a-f-]{27}$' || fail "expected-agent-id 无效"; done
case "$update_channel_url" in https://*) [ "$allow_insecure_update_http" = false ] || fail "HTTPS 不得启用 insecure" ;; http://*) [ "$allow_insecure_update_http" = true ] || fail "HTTP 必须显式启用" ;; *) fail "update-channel-url 无效" ;; esac
case "$evidence" in /*) ;; *) fail "evidence 必须是绝对路径" ;; esac
[ ! -e "$evidence" ] || fail "evidence 已存在"
for command in bun git go cargo jq ssh scp tar file shasum stat mktemp find base64 cp cut grep sed tr xargs; do require_command "$command"; done

cd "$repository_root"
git fetch --quiet origin
[ -z "$(git status --porcelain)" ] || fail "Git 工作区不干净"
upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null) || fail "当前分支没有 upstream"
commit=$(git rev-parse HEAD); [ "$commit" = "$(git rev-parse "$upstream")" ] || fail "HEAD 尚未推送"
short_commit=$(printf '%s' "$commit" | cut -c1-12)
target_catalog="chatserver-computer-release-$(printf '%s' "$version" | tr '.' '-' | tr '[:upper:]' '[:lower:]')"
computer_transaction="$computer_root/state/release-rollback/$version-$short_commit"
mkdir -m 0700 "$evidence"
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/vela-computer-k3s.XXXXXX")

echo "[1/8] 预检 builder、k3s、Computer 与当前 catalog……"
ssh_builder true; ssh_target true; ssh_computer true
ensure_builder_prerequisites
ensure_target_prerequisites
ensure_computer_prerequisites
backend_ready || fail "Backend 当前不是 1/1 Ready"
target_kubectl get configmap "$target_catalog" >/dev/null 2>&1 && fail "目标 catalog 已存在"
original_catalog=$(target_kubectl get deployment "$backend_deployment" -o 'jsonpath={.spec.template.spec.volumes[?(@.name=="computer-release")].configMap.name}')
original_catalog_version=$(target_kubectl get deployment "$backend_deployment" -o 'jsonpath={.spec.template.metadata.annotations.agentnetwork\.io/computer-release}')
[ -n "$original_catalog" ] && [ -n "$original_catalog_version" ] || fail "无法读取原 catalog"
ssh_computer "test -x $(quote_remote "$computer_root/bin/vela-computer")"
original_computer_version=$(ssh_computer "$(quote_remote "$computer_root/bin/vela-computer") version" | awk '{print $NF}')
original_computer_sha=$(ssh_computer "sha256sum $(quote_remote "$computer_root/bin/vela-computer")" | awk '{print $1}')
printf '%s\n' "$original_computer_version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$' || fail "原 Computer 版本无效"
printf '%s\n' "$original_computer_sha" | grep -Eq '^[0-9a-f]{64}$' || fail "原 Computer 摘要无效"
for agent in $expected_agent_ids; do
  ssh_computer "jq -e --arg agent $(quote_remote "$agent") 'any(.agents[]; .agentId==\$agent and .phase==\"running\" and .health==\"ready\")' $(quote_remote "$computer_root/state/daemon.state.json") >/dev/null" || fail "目标 Agent 当前不是 ready"
done

echo "[2/8] 运行 TUI、Agent 与发布器门禁……"
(cd web && bun run --cwd apps/client check:tui && bun run --cwd apps/client test:tui && bun run --cwd apps/client test:tui-build)
(cd agent && go test -p 1 ./... -count=1 && go vet ./... && cargo test --manifest-path native/tat-agent/Cargo.toml)
(cd backend && go test ./cmd/computer-release ./internal/computerrelease ./internal/adapters/tencent/cos -count=1)

echo "[3/8] 构建 darwin-arm64 与 linux-amd64……"
release_public=$(tr -d '\r\n' <"$release_public_key"); channel_public=$(tr -d '\r\n' <"$channel_public_key")
http_arg=; [ "$allow_insecure_update_http" = true ] && http_arg=--allow-insecure-update-http
mac_binary="$temporary_root/vela-computer-darwin-arm64"; linux_binary="$temporary_root/vela-computer-linux-amd64"; linux_metadata="$temporary_root/linux-buildx-metadata.json"
# shellcheck disable=SC2086
agent/scripts/build-vela-macos-arm64.sh --version "$version" --output "$mac_binary" --update-channel-url "$update_channel_url" $http_arg --channel-key-id "$channel_key_id" --channel-public-key "$channel_public" --release-key-id "$release_key_id" --release-public-key "$release_public" >/dev/null
builder_root=$(ssh_builder 'mktemp -d /tmp/vela-computer-k3s.XXXXXX')
COPYFILE_DISABLE=1 tar --no-xattrs --exclude='./native/tat-agent/target' --exclude='./dist' --exclude='./._*' -czf - -C agent . | ssh_builder "tar -xzf - -C $(quote_remote "$builder_root")"
# shellcheck disable=SC2086
ssh_builder "VELA_BUILDX_BUILDER=$(quote_remote "$buildx_builder") $(quote_remote "$builder_root/scripts/build-vela-linux-amd64-buildx.sh") --version $(quote_remote "$version") --output $(quote_remote "$builder_root/vela-computer-linux-amd64") --metadata $(quote_remote "$builder_root/buildx-metadata.json") --update-channel-url $(quote_remote "$update_channel_url") $http_arg --channel-key-id $(quote_remote "$channel_key_id") --channel-public-key $(quote_remote "$channel_public") --release-key-id $(quote_remote "$release_key_id") --release-public-key $(quote_remote "$release_public")" >/dev/null
scp -q -P "$builder_port" -i "$builder_identity" "$builder:$builder_root/vela-computer-linux-amd64" "$linux_binary"
scp -q -P "$builder_port" -i "$builder_identity" "$builder:$builder_root/buildx-metadata.json" "$linux_metadata"
mac_hash=$(shasum -a 256 "$mac_binary" | awk '{print $1}'); linux_hash=$(shasum -a 256 "$linux_binary" | awk '{print $1}')

echo "[4/8] 生成、验签并 create-only 发布 Release Set……"
release_directory="$temporary_root/release"
(cd backend && go run ./cmd/computer-release build-set --version "$version" --signing-key-id "$release_key_id" --private-key-file "$release_private_key" --macos-program "$mac_binary" --linux-program "$linux_binary" --output "$release_directory" >/dev/null)
(cd backend && go run ./cmd/computer-release verify-set --release-directory "$release_directory" --public-key-file "$release_public_key" >/dev/null)
[ "$(jq -r '.targets[] | select(.target=="darwin-arm64") | .program.sha256' "$release_directory/release.catalog.json")" = "$mac_hash" ] || fail "macOS catalog 摘要不一致"
[ "$(jq -r '.targets[] | select(.target=="linux-amd64") | .program.sha256' "$release_directory/release.catalog.json")" = "$linux_hash" ] || fail "Linux catalog 摘要不一致"
secret_name=$(target_kubectl get deployment "$backend_deployment" -o 'jsonpath={.spec.template.spec.volumes[?(@.name=="secrets")].secret.secretName}')
[ -n "$secret_name" ] || fail "无法读取 Backend Secret"
target_kubectl get secret "$secret_name" -o json >"$temporary_root/live-secret.json"
for key in tencent-cloud-secret-id tencent-cloud-secret-key; do jq -r --arg key "$key" '.data[$key]' "$temporary_root/live-secret.json" | base64 --decode >"$temporary_root/$key"; chmod 0600 "$temporary_root/$key"; done
(cd backend && go run ./cmd/computer-release publish-set --release-directory "$release_directory" --public-key-file "$release_public_key" --bucket "$bucket" --region "$region" --secret-id-file "$temporary_root/tencent-cloud-secret-id" --secret-key-file "$temporary_root/tencent-cloud-secret-key" >/dev/null)
cp "$linux_metadata" "$release_directory/linux-buildx-metadata.json"
cp agent/internal/vela/humantui/assets/human-client.bundle.manifest.json "$release_directory/"
cp agent/internal/vela/humantui/assets/human-client.bundle.sha256 "$release_directory/"
cp -R "$release_directory" "$evidence/release"

echo "[5/8] 创建 immutable catalog 并切换独立 k3s……"
target_root=$(ssh_target 'mktemp -d /tmp/vela-computer-k3s.XXXXXX')
scp -q -P "$target_port" -i "$target_identity" "$release_directory/release.catalog.json" "$target:$target_root/release.catalog.json"
ssh_target "k3s kubectl -n $(quote_remote "$namespace") create configmap $(quote_remote "$target_catalog") --from-file=release.catalog.json=$(quote_remote "$target_root/release.catalog.json") --dry-run=client -o json" | jq '.immutable=true | .metadata.annotations={"agentnetwork.io/catalog-write-policy":"create-only-v1"} | .metadata.labels={"app.kubernetes.io/name":"chatserver","app.kubernetes.io/component":"computer-release"}' | ssh_target 'k3s kubectl create -f -' >/dev/null
created=$(target_kubectl get configmap "$target_catalog" -o json)
[ "$(printf '%s' "$created" | jq -r '.immutable')" = true ] || fail "catalog 非 immutable"
expected_catalog_digest=$(jq -cS . "$release_directory/release.catalog.json" | shasum -a 256 | awk '{print $1}')
created_catalog_digest=$(printf '%s' "$created" | jq -r '.data["release.catalog.json"]' | jq -cS . | shasum -a 256 | awk '{print $1}')
[ "$created_catalog_digest" = "$expected_catalog_digest" ] || fail "k3s catalog 内容不一致"
patch=$(jq -nc --arg catalog "$target_catalog" --arg version "$version" '{spec:{template:{metadata:{annotations:{"agentnetwork.io/computer-release":$version}},spec:{volumes:[{name:"computer-release",configMap:{name:$catalog,defaultMode:292}}]}}}}')
target_kubectl patch deployment "$backend_deployment" --type=strategic -p "$patch" >/dev/null
catalog_patched=true; wait_backend || fail "Backend catalog 切换未收敛"

echo "[6/8] 原子升级指定测试 Computer……"
computer_stage="$computer_root/bin/.vela-computer.$version.$short_commit.stage"
scp -q -P "$computer_port" -i "$computer_identity" "$linux_binary" "$computer:$computer_stage"
expected_agents=$(printf '%s' "$expected_agent_ids" | xargs)
ssh_computer sh -s -- "$computer_root" "$computer_service" "$computer_stage" "$version" "$linux_hash" "$expected_agents" "$computer_transaction" <<'REMOTE_UPGRADE'
set -eu
root=$1; service=$2; stage=$3; version=$4; expected_sha=$5; expected_agents=$6; transaction=$7
program=$root/bin/vela-computer; journal=$root/state/install.journal.json
[ -f "$stage" ] && [ "$(sha256sum "$stage" | awk '{print $1}')" = "$expected_sha" ]
[ "$("$stage" version)" = "vela-computer vela $version" ]
[ ! -e "$transaction" ]; mkdir -m 0700 -p "$transaction"
cp -p "$program" "$transaction/vela-computer"; cp -p "$journal" "$transaction/install.journal.json"
swapped=false
rollback() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ "$code" -ne 0 ] && [ "$swapped" = true ]; then
    set +e
    systemctl stop "$service"
    cp -p "$transaction/vela-computer" "$program"
    cp -p "$transaction/install.journal.json" "$journal"
    systemctl start "$service"
  fi
  exit "$code"
}
trap rollback EXIT HUP INT TERM
next=$(mktemp "$root/state/.install.journal.XXXXXX")
jq --arg version "$version" --arg sha "$expected_sha" '.version=$version | .programSha256=$sha' "$journal" >"$next"; chmod 0600 "$next"
systemctl stop "$service"; chmod 0755 "$stage"; mv "$stage" "$program"; mv "$next" "$journal"; swapped=true; systemctl start "$service"
for attempt in $(seq 1 90); do
  ready=true
  for agent in $expected_agents; do jq -e --arg version "$version" --arg agent "$agent" '.version==$version and .online==true and any(.agents[]; .agentId==$agent and .phase=="running" and .health=="ready")' "$root/state/daemon.state.json" >/dev/null 2>&1 || ready=false; done
  if systemctl is-active --quiet "$service" && [ "$ready" = true ]; then
    trap - EXIT HUP INT TERM
    exit 0
  fi
  sleep 2
done
exit 1
REMOTE_UPGRADE
computer_patched=true

echo "[7/8] 验证实际版本、Agent heartbeat 与摘要……"
ssh_computer "test \"\$($(quote_remote "$computer_root/bin/vela-computer") version)\" = $(quote_remote "vela-computer vela $version")"
ssh_computer "jq -c '{online,version,reconcileState,agents:[.agents[]|{agentId,phase,health}]}' $(quote_remote "$computer_root/state/daemon.state.json")" >"$evidence/computer-after.json"
target_kubectl get deployment "$backend_deployment" -o yaml >"$evidence/backend-after.yaml"
printf '%s\n' "$target_catalog" >"$evidence/catalog.txt"

echo "[8/8] 固化成功证据……"
computer_patched=false; catalog_patched=false
echo "独立 k3s Computer 发布成功"
echo "version=$version"
echo "catalog=$target_catalog"
echo "darwinProgramSHA256=$mac_hash"
echo "linuxProgramSHA256=$linux_hash"
echo "evidence=$evidence"
