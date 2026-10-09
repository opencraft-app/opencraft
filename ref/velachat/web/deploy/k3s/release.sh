#!/bin/sh
set -eu

umask 077

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd -P)
registry=lightclaw-bj8.tencentcloudcr.com/lightclaw/vela-platform-web
namespace=dep
deployment=raft-web-static
container=static
backend_deployment=chatserver-canary
buildx_builder=vela-computer-release
builder=
builder_port=36000
builder_identity=
target=
target_port=36000
target_identity=
base_url=
evidence=
temporary_root=
remote_root=
original_image=
release_image=
release_digest=
live_patched=false
rollback_succeeded=false

usage() {
  cat <<'EOF'
用法：
  web/deploy/k3s/release.sh deploy \
    --builder USER@HOST --builder-port 36000 \
    --builder-identity /absolute/private-key \
    --target USER@HOST --target-port 36000 \
    --target-identity /absolute/private-key \
    --base-url http://HOST \
    --evidence /absolute/new-directory \
    [--buildx-builder vela-computer-release] \
    [--registry lightclaw-bj8.tencentcloudcr.com/lightclaw/vela-platform-web] \
    [--namespace dep] [--deployment raft-web-static] \
    [--container static] [--backend-deployment chatserver-canary]

Mac 原生运行 Web/TUI 门禁并导出 Expo dist；授权 Linux builder 仅负责
linux/amd64 Buildx build/push；目标主机仅使用自己的 k3s kubectl 切换 digest。
两个 SSH 边界都强制 BatchMode、IdentitiesOnly 和显式 identity，不回退密码。
EOF
}

fail() {
  echo "独立 k3s Web 发布失败：$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令 $1"
}

validate_port() {
  case "$1" in
    ''|*[!0-9]*) fail "$2 必须是 1-65535 的整数" ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ] ||
    fail "$2 必须是 1-65535 的整数"
}

validate_ssh_target() {
  case "$1" in
    ''|*[!A-Za-z0-9._@:-]*) fail "$2 无效" ;;
  esac
}

validate_identity() {
  identity=$1
  label=$2
  case "$identity" in /*) ;; *) fail "$label 必须是绝对路径" ;; esac
  [ -f "$identity" ] && [ ! -L "$identity" ] || fail "$label 不是普通文件"
}

ssh_builder() {
  ssh -o BatchMode=yes -o IdentitiesOnly=yes \
    -i "$builder_identity" -p "$builder_port" "$builder" "$@"
}

ssh_target() {
  ssh -o BatchMode=yes -o IdentitiesOnly=yes \
    -i "$target_identity" -p "$target_port" "$target" "$@"
}

quote_remote_argument() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

target_kubectl() {
  remote_command="k3s kubectl -n $(quote_remote_argument "$namespace")"
  for argument in "$@"; do
    remote_command="$remote_command $(quote_remote_argument "$argument")"
  done
  ssh_target "$remote_command"
}

deployment_state() {
  name=$1
  target_kubectl get deployment "$name" \
    -o 'jsonpath={.metadata.generation}{" "}{.status.observedGeneration}{" "}{.spec.replicas}{" "}{.status.updatedReplicas}{" "}{.status.readyReplicas}{" "}{.status.availableReplicas}{" "}{.status.unavailableReplicas}{"\n"}'
}

deployment_is_ready() {
  name=$1
  expected_image=${2:-}
  state=$(deployment_state "$name") || return 1
  # shellcheck disable=SC2086
  set -- $state
  if [ "$#" -eq 6 ]; then
    set -- "$@" 0
  fi
  [ "$#" -eq 7 ] || return 1
  generation=$1
  observed=$2
  replicas=$3
  updated=$4
  ready=$5
  available=$6
  unavailable=$7
  [ "$generation" = "$observed" ] && [ "$replicas" = 1 ] &&
    [ "$updated" = 1 ] && [ "$ready" = 1 ] &&
    [ "$available" = 1 ] && [ "$unavailable" = 0 ] || return 1
  if [ -n "$expected_image" ]; then
    live_image=$(target_kubectl get deployment "$name" \
      -o "jsonpath={.spec.template.spec.containers[?(@.name==\"$container\")].image}") || return 1
    [ "$live_image" = "$expected_image" ] || return 1
  fi
}

wait_for_rollout() {
  expected_image=$1
  timeout_seconds=$2
  attempt=0
  while [ "$attempt" -lt "$timeout_seconds" ]; do
    if deployment_is_ready "$deployment" "$expected_image"; then
      return 0
    fi
    attempt=$((attempt + 2))
    sleep 2
  done
  return 1
}

verify_target_pod() {
  expected_digest=$1
  pod_snapshot=$2
  target_kubectl get pods -l app.kubernetes.io/name=raft-web-static \
    -o 'jsonpath={range .items[*]}{.metadata.name}{" "}{.status.phase}{" "}{.status.containerStatuses[0].ready}{" "}{.status.containerStatuses[0].restartCount}{" "}{.status.containerStatuses[0].imageID}{"\n"}{end}' \
    >"$pod_snapshot"
  lines=$(wc -l <"$pod_snapshot" | tr -d ' ')
  [ "$lines" = 1 ] || return 1
  grep -Eq ' Running true 0 ' "$pod_snapshot" || return 1
  grep -F "$expected_digest" "$pod_snapshot" >/dev/null || return 1
}

run_http_checks() {
  output=$1
  : >"$output"
  for path in / /healthz-web /healthz /readyz /install /join /agents; do
    result=$(curl -sS -o "$temporary_root/http-body" \
      -w '%{http_code} %{content_type}' "$base_url$path") || return 1
    printf '%s %s\n' "$path" "$result" >>"$output"
    code=${result%% *}
    [ "$code" = 200 ] || return 1
  done
  curl -fsS "$base_url/join" | grep -qi '<html' || return 1
  curl -fsS "$base_url/agents" | grep -qi '<html' || return 1
  me_code=$(curl -sS -o "$temporary_root/me-body" -w '%{http_code}' "$base_url/v1/me") || return 1
  printf '/v1/me %s\n' "$me_code" >>"$output"
  [ "$me_code" = 401 ] || return 1
}

rollback_live_image() {
  [ "$live_patched" = true ] || return 0
  echo "发布失败，正在恢复原 Web digest……" >&2
  target_kubectl set image "deployment/$deployment" "$container=$original_image" >/dev/null || return 1
  original_digest=${original_image##*@}
  wait_for_rollout "$original_image" 300 || return 1
  verify_target_pod "$original_digest" "$evidence/pod-rollback.txt" || return 1
  run_http_checks "$evidence/http-rollback.txt" || return 1
  rollback_succeeded=true
  live_patched=false
}

remove_remote_root() {
  case "$remote_root" in
    /tmp/vela-k3s-web-release.*)
      ssh_builder sh -s -- "$remote_root" <<'REMOTE_CLEANUP' >/dev/null 2>&1 || true
set -eu
path=$1
case "$path" in /tmp/vela-k3s-web-release.*) find "$path" -depth -delete ;; *) exit 2 ;; esac
REMOTE_CLEANUP
      ;;
  esac
  remote_root=
}

write_evidence() {
  status=$1
  rolled_back=$2
  bun -e '
const fs = require("node:fs");
const [path, status, commit, tag, digest, image, previous, rolledBack] = process.argv.slice(1);
fs.writeFileSync(path, JSON.stringify({
  schemaVersion: 1,
  status,
  commit,
  tag,
  registryDigest: digest,
  releaseImage: image,
  previousImage: previous,
  rolledBack: rolledBack === "true",
  recordedAt: new Date().toISOString(),
}, null, 2) + "\n", {mode: 0o600});
' "$evidence/release-evidence.json" "$status" "$commit" "$image_tag" \
    "$release_digest" "$release_image" "$original_image" "$rolled_back"
}

cleanup() {
  exit_code=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$exit_code" -ne 0 ] && [ "$live_patched" = true ]; then
    rollback_live_image
    rollback_result=$?
    if [ "$rollback_result" -ne 0 ]; then
      echo "自动回滚未能完整验收，需要人工处理" >&2
    fi
  fi
  if [ -n "$evidence" ] && [ -d "$evidence" ]; then
    if [ "$exit_code" -eq 0 ]; then
      write_evidence published false
    elif [ "$rollback_succeeded" = true ]; then
      write_evidence rolled_back true
    else
      write_evidence failed false
    fi
  fi
  remove_remote_root
  case "$temporary_root" in
    "${TMPDIR:-/tmp}"/vela-k3s-web.*) rm -rf -- "$temporary_root" ;;
  esac
  exit "$exit_code"
}
trap cleanup EXIT HUP INT TERM

command_name=${1:-}
case "$command_name" in
  -h|--help) usage; exit 0 ;;
  deploy) shift ;;
  *) usage >&2; exit 2 ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --builder) [ "$#" -ge 2 ] || fail "--builder 缺少值"; builder=$2; shift 2 ;;
    --builder-port) [ "$#" -ge 2 ] || fail "--builder-port 缺少值"; builder_port=$2; shift 2 ;;
    --builder-identity) [ "$#" -ge 2 ] || fail "--builder-identity 缺少值"; builder_identity=$2; shift 2 ;;
    --target) [ "$#" -ge 2 ] || fail "--target 缺少值"; target=$2; shift 2 ;;
    --target-port) [ "$#" -ge 2 ] || fail "--target-port 缺少值"; target_port=$2; shift 2 ;;
    --target-identity) [ "$#" -ge 2 ] || fail "--target-identity 缺少值"; target_identity=$2; shift 2 ;;
    --base-url) [ "$#" -ge 2 ] || fail "--base-url 缺少值"; base_url=$2; shift 2 ;;
    --evidence) [ "$#" -ge 2 ] || fail "--evidence 缺少值"; evidence=$2; shift 2 ;;
    --buildx-builder) [ "$#" -ge 2 ] || fail "--buildx-builder 缺少值"; buildx_builder=$2; shift 2 ;;
    --registry) [ "$#" -ge 2 ] || fail "--registry 缺少值"; registry=$2; shift 2 ;;
    --namespace) [ "$#" -ge 2 ] || fail "--namespace 缺少值"; namespace=$2; shift 2 ;;
    --deployment) [ "$#" -ge 2 ] || fail "--deployment 缺少值"; deployment=$2; shift 2 ;;
    --container) [ "$#" -ge 2 ] || fail "--container 缺少值"; container=$2; shift 2 ;;
    --backend-deployment) [ "$#" -ge 2 ] || fail "--backend-deployment 缺少值"; backend_deployment=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数 $1" ;;
  esac
done

validate_ssh_target "$builder" "--builder"
validate_ssh_target "$target" "--target"
validate_port "$builder_port" "--builder-port"
validate_port "$target_port" "--target-port"
validate_identity "$builder_identity" "--builder-identity"
validate_identity "$target_identity" "--target-identity"
case "$base_url" in http://*|https://*) ;; *) fail "--base-url 必须是 HTTP(S) URL" ;; esac
case "$base_url" in *'?'*|*'#'*|*[!A-Za-z0-9.:/_-]*) fail "--base-url 无效" ;; esac
base_url=${base_url%/}
case "$evidence" in /*) ;; *) fail "--evidence 必须是绝对路径" ;; esac
[ ! -e "$evidence" ] || fail "--evidence 已存在；拒绝覆盖"
case "$buildx_builder" in ''|*[!A-Za-z0-9_.-]*) fail "--buildx-builder 无效" ;; esac
case "$namespace$deployment$container$backend_deployment" in *[!A-Za-z0-9_.-]*) fail "Kubernetes 名称无效" ;; esac
case "$registry" in ''|*[!A-Za-z0-9._/-]*) fail "--registry 无效" ;; esac

for command in bun git ssh tar curl grep tr wc mktemp mkdir cp chmod sed \
  head tail cut find rm; do
  require_command "$command"
done

cd "$repository_root"
git fetch --quiet origin
[ -z "$(git status --porcelain)" ] || fail "Git 工作区不干净"
upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null) ||
  fail "当前分支没有 upstream"
commit=$(git rev-parse HEAD)
upstream_commit=$(git rev-parse "$upstream")
[ "$commit" = "$upstream_commit" ] || fail "HEAD 尚未推送到 upstream"
short_commit=$(printf '%s' "$commit" | cut -c1-12)
image_tag="$registry:git-$short_commit"

mkdir -m 0700 "$evidence"
printf '%s\n' "$commit" >"$evidence/commit.txt"
printf '%s\n' "$image_tag" >"$evidence/image-tag.txt"

echo "[1/7] 验证 SSH、k3s 与 live workload……"
ssh_builder true
ssh_target true
deployment_is_ready "$deployment" || fail "Web Deployment 当前不是 1/1 Ready"
deployment_is_ready "$backend_deployment" || fail "Backend Deployment 当前不是 1/1 Ready"
original_image=$(target_kubectl get deployment "$deployment" \
  -o "jsonpath={.spec.template.spec.containers[?(@.name==\"$container\")].image}")
printf '%s\n' "$original_image" | grep -Eq '@sha256:[0-9a-f]{64}$' ||
  fail "当前 Web image 不是不可变 digest"
target_kubectl get deployment "$deployment" -o yaml >"$evidence/deployment-before.yaml"
target_kubectl get pods -l app.kubernetes.io/name=raft-web-static -o wide >"$evidence/pods-before.txt"

ssh_builder sh -s -- "$buildx_builder" "$original_image" <<'BUILDER_PREFLIGHT'
set -eu
builder=$1
live_image=$2
docker version >/dev/null
docker buildx inspect "$builder" >/dev/null
docker buildx inspect "$builder" --bootstrap | grep -q 'linux/amd64'
docker buildx imagetools inspect "$live_image" >/dev/null
BUILDER_PREFLIGHT

echo "[2/7] 运行 Mac Web/TUI 发布门禁并导出 Expo……"
(
  umask 022
  bun run --cwd web typecheck
  bun run --cwd web test
  bun run --cwd web security:scan
  bun run --cwd web/apps/client check:tui
  bun run --cwd web/apps/client test:tui
  bun run --cwd web/apps/client test:tui-build
  bun run --cwd web build:web
  bun run --cwd web/apps/client verify:web-fallback
)
[ -z "$(git status --porcelain)" ] || fail "发布门禁后 Git 工作区发生变化"

echo "[3/7] 创建并传输最小 Web 构建上下文……"
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/vela-k3s-web.XXXXXX")
context_root="$temporary_root/context"
mkdir -p "$context_root/apps/client" "$context_root/deploy/devcloud"
cp -R web/apps/client/dist "$context_root/apps/client/dist"
cp web/deploy/devcloud/Dockerfile "$context_root/deploy/devcloud/Dockerfile"
cp web/deploy/devcloud/nginx.conf "$context_root/deploy/devcloud/nginx.conf"
chmod -R u=rwX,go=rX "$context_root"
remote_root=$(ssh_builder 'mktemp -d /tmp/vela-k3s-web-release.XXXXXX')
case "$remote_root" in /tmp/vela-k3s-web-release.*) ;; *) fail "Builder 返回了不安全临时路径" ;; esac
COPYFILE_DISABLE=1 tar -C "$context_root" -cf - . | ssh_builder "tar -C '$remote_root' -xf -"

echo "[4/7] Buildx 构建并推送不可变 Web 镜像……"
if ssh_builder docker buildx imagetools inspect "$image_tag" >/dev/null 2>&1; then
  fail "目标 tag 已存在；拒绝覆盖不可变发布"
fi
build_result=$(ssh_builder sh -s -- "$remote_root" "$buildx_builder" "$image_tag" <<'REMOTE_BUILD'
set -eu
root=$1
builder=$2
tag=$3
cd "$root"
docker buildx build \
  --builder "$builder" \
  --platform linux/amd64 \
  --file deploy/devcloud/Dockerfile \
  --tag "$tag" \
  --push \
  --metadata-file build-metadata.json \
  . >&2
digest=$(docker buildx imagetools inspect "$tag" | sed -n 's/^Digest:[[:space:]]*//p' | head -1)
printf 'DIGEST=%s\n' "$digest"
REMOTE_BUILD
)
release_digest=$(printf '%s\n' "$build_result" | sed -n 's/^DIGEST=//p' | tail -1)
printf '%s\n' "$release_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
  fail "Registry 未返回有效 OCI digest"
release_image="$registry@$release_digest"
printf '%s\n' "$release_image" >"$evidence/release-image.txt"
ssh_builder "cat '$remote_root/build-metadata.json'" >"$evidence/build-metadata.json"

echo "[5/7] 切换目标 k3s Web digest……"
target_kubectl set image "deployment/$deployment" "$container=$release_image" >/dev/null
target_kubectl patch deployment "$deployment" --type=merge \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"agentnetwork.io/source-commit\":\"$commit\",\"agentnetwork.io/release-id\":\"web-$short_commit\"}}}}}" >/dev/null
live_patched=true

echo "[6/7] 验证 Deployment、唯一 Pod 与运行 digest……"
wait_for_rollout "$release_image" 300 || fail "Web Deployment 未在期限内收敛"
verify_target_pod "$release_digest" "$evidence/pod-after.txt" ||
  fail "Web Pod 未满足唯一、Ready、零重启和 imageID 条件"
target_kubectl get deployment "$deployment" -o yaml >"$evidence/deployment-after.yaml"

echo "[7/7] 验证外部 HTTP、SPA fallback 与鉴权边界……"
run_http_checks "$evidence/http-status.txt" || fail "外部 HTTP 验收失败"

live_patched=false
echo "独立 k3s Web 发布成功"
echo "commit=$commit"
echo "image=$release_image"
echo "evidence=$evidence"
