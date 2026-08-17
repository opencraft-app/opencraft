#!/bin/sh
set -eu

umask 077

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
registry="lightclaw-bj8.tencentcloudcr.com/lightclaw/vela-platform-web"
namespace=dep
deployment=raft-web-static
container=static
service=raft-web-static
builder=root@9.134.208.109
builder_port=36000
preview_port=63886
preview_pid_file="${TMPDIR:-/tmp}/vela-web-devcloud-preview.pid"
preview_log_file="${TMPDIR:-/tmp}/vela-web-devcloud-preview.log"
kubeconfig=
live_patched=false
original_image=
original_runtime_digest=
selector=
expected_replicas=0
temporary_root=
remote_root=

usage() {
  cat <<'EOF'
用法：
  web/deploy/devcloud/release.sh preview [--port 63886]
  web/deploy/devcloud/release.sh preview-stop
  web/deploy/devcloud/release.sh deploy --kubeconfig /absolute/path/to/dep.conf \
    [--builder root@9.134.208.109] [--builder-port 36000] \
    [--registry lightclaw-bj8.tencentcloudcr.com/lightclaw/vela-platform-web] \
    [--namespace dep] [--deployment raft-web-static] \
    [--container static] [--service raft-web-static]

preview 在 Mac 上用 Bun/Expo 编译，并以 Bun 静态服务器预览 dist，不需要 Docker。

deploy 要求工作区干净且 HEAD 已推送。Mac 原生完成 Web 门禁与 dist 编译，再把最小
构建上下文发给内网 Linux builder；远端 Docker buildx 负责打包并推送 TCR。Mac 只用
显式 kubeconfig 完成 rollout 和 live 验收。
EOF
}

fail() {
  echo "DevCloud Web 发布失败：$*" >&2
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

build_web() {
  require_command bun
  bun run --cwd web typecheck
  bun run --cwd web build:web
}

stop_preview_process() {
  [ -f "$preview_pid_file" ] || return 1
  pid=$(cat "$preview_pid_file" 2>/dev/null || true)
  case "$pid" in ''|*[!0-9]*) rm -f "$preview_pid_file"; return 1 ;; esac
  command_line=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$command_line" in
    *web/deploy/devcloud/preview-server.ts*)
      kill "$pid" >/dev/null 2>&1 || true
      attempt=0
      while kill -0 "$pid" >/dev/null 2>&1 && [ "$attempt" -lt 20 ]; do
        sleep 0.1
        attempt=$((attempt + 1))
      done
      ;;
  esac
  rm -f "$preview_pid_file"
  return 0
}

preview() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --port) [ "$#" -ge 2 ] || fail "--port 缺少值"; preview_port=$2; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) fail "preview 未知参数 $1" ;;
    esac
  done
  validate_port "$preview_port" "--port"
  require_command curl
  cd "$repository_root"
  build_web
  stop_preview_process >/dev/null 2>&1 || true

  echo "[preview 1/2] 启动 Mac 本地生产静态预览……"
  bun web/deploy/devcloud/preview-server.ts \
    --root web/apps/client/dist \
    --port "$preview_port" \
    >"$preview_log_file" 2>&1 &
  preview_pid=$!
  printf '%s\n' "$preview_pid" >"$preview_pid_file"
  trap 'stop_preview_process >/dev/null 2>&1 || true' EXIT HUP INT TERM

  echo "[preview 2/2] 验证健康与 SPA fallback……"
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if curl -fsS "http://127.0.0.1:$preview_port/healthz-web" >/dev/null &&
      curl -fsS "http://127.0.0.1:$preview_port/join" |
        grep -qi '<html'; then
      echo "本地预览已启动：http://127.0.0.1:$preview_port/"
      wait "$preview_pid"
      return $?
    fi
    if ! kill -0 "$preview_pid" >/dev/null 2>&1; then break; fi
    attempt=$((attempt + 1))
    sleep 0.2
  done
  cat "$preview_log_file" >&2 || true
  fail "本地预览健康检查失败"
}

preview_stop() {
  if stop_preview_process; then
    echo "本地预览已停止"
  else
    echo "本地预览未运行"
  fi
}

verify_pods() {
  target_digest=$1
  kubectl --kubeconfig "$kubeconfig" -n "$namespace" get pods \
    -l "$selector" -o json |
    jq -e \
      --arg container "$container" \
      --arg digest "$target_digest" \
      --argjson expected "$expected_replicas" '
        (.items | length) == $expected and
        ([
          .items[] |
          [.status.containerStatuses[]? | select(.name == $container)] as $statuses |
          select(($statuses | length) == 1) |
          $statuses[0] |
          select(
            .ready == true and
            .restartCount == 0 and
            (.imageID | contains($digest))
          )
        ] | length) == $expected
      ' >/dev/null || return 1
}

remove_remote_root() {
  case "$remote_root" in
    /tmp/vela-web-release.*)
      ssh -p "$builder_port" "$builder" sh -s -- "$remote_root" <<'REMOTE_CLEANUP' >/dev/null 2>&1 || true
set -eu
target=$1
case "$target" in /tmp/vela-web-release.*) rm -rf -- "$target" ;; *) exit 2 ;; esac
REMOTE_CLEANUP
      ;;
  esac
  remote_root=
}

cleanup() {
  exit_code=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$exit_code" -ne 0 ] && [ "$live_patched" = true ]; then
    echo "发布失败，正在恢复原镜像……" >&2
    rollback_ok=true
    kubectl --kubeconfig "$kubeconfig" -n "$namespace" set image \
      "deployment/$deployment" "$container=$original_image" >/dev/null 2>&1 ||
      rollback_ok=false
    kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status \
      "deployment/$deployment" --timeout=300s >/dev/null 2>&1 ||
      rollback_ok=false
    verify_pods "$original_runtime_digest" >/dev/null 2>&1 || rollback_ok=false
    if [ "$rollback_ok" = true ]; then
      echo "原镜像已恢复：$original_image" >&2
    else
      current_image=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get \
        deployment "$deployment" \
        -o jsonpath="{.spec.template.spec.containers[?(@.name=='$container')].image}" \
        2>/dev/null || true)
      echo "自动恢复未通过验收；当前镜像：$current_image" >&2
    fi
  fi
  remove_remote_root
  if [ -n "$temporary_root" ] && [ -d "$temporary_root" ]; then
    rm -rf -- "$temporary_root"
  fi
  exit "$exit_code"
}

deploy() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --kubeconfig) [ "$#" -ge 2 ] || fail "--kubeconfig 缺少值"; kubeconfig=$2; shift 2 ;;
      --builder) [ "$#" -ge 2 ] || fail "--builder 缺少值"; builder=$2; shift 2 ;;
      --builder-port) [ "$#" -ge 2 ] || fail "--builder-port 缺少值"; builder_port=$2; shift 2 ;;
      --registry) [ "$#" -ge 2 ] || fail "--registry 缺少值"; registry=$2; shift 2 ;;
      --namespace) [ "$#" -ge 2 ] || fail "--namespace 缺少值"; namespace=$2; shift 2 ;;
      --deployment) [ "$#" -ge 2 ] || fail "--deployment 缺少值"; deployment=$2; shift 2 ;;
      --container) [ "$#" -ge 2 ] || fail "--container 缺少值"; container=$2; shift 2 ;;
      --service) [ "$#" -ge 2 ] || fail "--service 缺少值"; service=$2; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) fail "deploy 未知参数 $1" ;;
    esac
  done

  [ -n "$kubeconfig" ] || fail "deploy 必须显式提供 --kubeconfig"
  case "$kubeconfig" in /*) ;; *) fail "--kubeconfig 必须是绝对路径" ;; esac
  [ -f "$kubeconfig" ] || fail "kubeconfig 不存在"
  validate_port "$builder_port" "--builder-port"
  case "$builder" in
    -*|''|*[!A-Za-z0-9._@-]*|*@*@*) fail "--builder 格式无效" ;;
    *@*) ;;
    *) fail "--builder 必须包含 user@host" ;;
  esac
  for value in "$namespace" "$deployment" "$container" "$service"; do
    case "$value" in ''|*[!a-z0-9.-]*) fail "Kubernetes 名称无效：$value" ;; esac
  done
  case "$registry" in */*) ;; *) fail "--registry 格式无效" ;; esac

  for command_name in git bun kubectl curl awk grep jq ssh scp tar mktemp; do
    require_command "$command_name"
  done
  cd "$repository_root"

  echo "[deploy 1/8] 校验 Git 与 Web 发布门禁……"
  [ -z "$(git status --porcelain --untracked-files=all)" ] ||
    fail "Git 工作区不干净"
  git rev-parse --verify '@{upstream}' >/dev/null 2>&1 ||
    fail "当前分支没有 upstream"
  git fetch --quiet
  head_commit=$(git rev-parse HEAD)
  upstream_commit=$(git rev-parse '@{upstream}')
  [ "$head_commit" = "$upstream_commit" ] || fail "HEAD 尚未推送或远端已有新提交"
  release_tag=$(printf '%s' "$head_commit" | cut -c 1-12)
  image_tag="$registry:$release_tag"

  bun run --cwd web typecheck
  bun run --cwd web test
  bun run --cwd web security:scan
  bun run --cwd web build:web
  bun run --cwd web/apps/client verify:web-fallback

  echo "[deploy 2/8] 校验 live 工作负载……"
  live_name=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get \
    deployment "$deployment" -o jsonpath='{.metadata.name}')
  [ "$live_name" = "$deployment" ] || fail "目标 Deployment 不存在"
  live_container=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get \
    deployment "$deployment" \
    -o jsonpath="{.spec.template.spec.containers[?(@.name=='$container')].name}")
  [ "$live_container" = "$container" ] || fail "目标容器不存在"
  selector_value=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get \
    deployment "$deployment" \
    -o jsonpath='{.spec.selector.matchLabels.app\.kubernetes\.io/name}')
  [ "$selector_value" = "$deployment" ] || fail "Deployment selector 与合同不一致"
  selector="app.kubernetes.io/name=$selector_value"
  expected_replicas=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get \
    deployment "$deployment" -o jsonpath='{.spec.replicas}')
  [ "$expected_replicas" -ge 1 ] || fail "Deployment 副本数无效"
  available_replicas=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get \
    deployment "$deployment" -o jsonpath='{.status.availableReplicas}')
  [ "$available_replicas" = "$expected_replicas" ] || fail "发布前 Deployment 不健康"
  original_image=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get \
    deployment "$deployment" \
    -o jsonpath="{.spec.template.spec.containers[?(@.name=='$container')].image}")
  original_image_id=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get pods \
    -l "$selector" -o json |
    jq -r --arg container "$container" '
      [.items[] | .status.containerStatuses[]? |
        select(.name == $container) | .imageID][0] // empty
    ')
  original_runtime_digest=${original_image_id##*@}
  case "$original_runtime_digest" in sha256:[0-9a-f][0-9a-f]*) ;; *) fail "无法读取原运行 digest" ;; esac
  kubectl --kubeconfig "$kubeconfig" -n "$namespace" get service "$service" >/dev/null

  echo "[deploy 3/8] 校验内网 Linux builder……"
  ssh -p "$builder_port" "$builder" \
    'docker info >/dev/null && docker buildx version >/dev/null' ||
    fail "远端 Docker/buildx 不可用"

  echo "[deploy 4/8] 发送最小构建上下文……"
  temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/vela-web-release.XXXXXX")
  trap cleanup EXIT HUP INT TERM
  context_archive="$temporary_root/context.tar.gz"
  tar -C web -czf "$context_archive" \
    deploy/devcloud/Dockerfile \
    deploy/devcloud/nginx.conf \
    apps/client/dist
  remote_root=$(ssh -p "$builder_port" "$builder" \
    'mktemp -d /tmp/vela-web-release.XXXXXX')
  case "$remote_root" in /tmp/vela-web-release.*) ;; *) fail "远端临时目录无效" ;; esac
  scp -q -P "$builder_port" "$context_archive" \
    "$builder:$remote_root/context.tar.gz"

  echo "[deploy 5/8] 在 Linux builder 构建并推送不可变镜像……"
  remote_output=$(ssh -p "$builder_port" "$builder" sh -s -- \
    "$remote_root" "$image_tag" <<'REMOTE_BUILD'
set -eu
release_root=$1
image_tag=$2
context_root="$release_root/context"
mkdir -m 0700 "$context_root"
tar -xzf "$release_root/context.tar.gz" -C "$context_root"
cd "$context_root"
if docker buildx imagetools inspect "$image_tag" >/dev/null 2>&1; then
  echo "远端 tag 已存在，拒绝覆盖：$image_tag" >&2
  exit 1
fi
docker buildx build \
  --file deploy/devcloud/Dockerfile \
  --platform linux/amd64 \
  --tag "$image_tag" \
  --push \
  .
digest=$(docker buildx imagetools inspect "$image_tag" |
  awk '$1 == "Digest:" {print $2; exit}')
printf 'VELA_IMAGE_DIGEST=%s\n' "$digest"
REMOTE_BUILD
  )
  printf '%s\n' "$remote_output"
  digest=$(printf '%s\n' "$remote_output" |
    sed -n 's/^VELA_IMAGE_DIGEST=//p' | tail -n 1)
  case "$digest" in sha256:[0-9a-f][0-9a-f]*) ;; *) fail "TCR 未返回有效 digest" ;; esac
  [ "${#digest}" -eq 71 ] || fail "TCR digest 长度无效"
  image="$registry@$digest"
  remove_remote_root

  echo "[deploy 6/8] 切换 Deployment 并等待 rollout……"
  kubectl --kubeconfig "$kubeconfig" -n "$namespace" set image \
    "deployment/$deployment" "$container=$image" >/dev/null
  live_patched=true
  kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status \
    "deployment/$deployment" --timeout=600s

  echo "[deploy 7/8] 验证 Pod imageID、Ready 与零重启……"
  verify_pods "$digest" || fail "Pod digest、Ready 或重启次数验收失败"

  echo "[deploy 8/8] 验证 Service 健康与 SPA fallback……"
  service_ip=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get \
    service "$service" -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
  [ -n "$service_ip" ] || fail "Service 没有 LoadBalancer IP"
  curl -fsS "http://$service_ip/healthz-web" >/dev/null
  curl -fsS "http://$service_ip/join" | grep -qi '<html' ||
    fail "Service SPA fallback 验证失败"

  live_patched=false
  echo "DevCloud Web 发布成功"
  echo "commit=$head_commit"
  echo "image=$image"
  echo "service=http://$service_ip/"
}

command=${1:---help}
if [ "$#" -gt 0 ]; then shift; fi
case "$command" in
  preview) preview "$@" ;;
  preview-stop) preview_stop "$@" ;;
  deploy) deploy "$@" ;;
  -h|--help|help) usage ;;
  *) usage >&2; fail "未知子命令 $command" ;;
esac
