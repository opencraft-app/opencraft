#!/bin/sh
set -eu

umask 077

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
namespace=dep
deployment=chatserver-canary
bucket=an-computer-1388575217
region=ap-beijing
kubeconfig=
agent_source=
web_source=
version=
signing_key_id=
signing_private_key=
signing_public_key=
release_output=
health_base_url=
linux_builder_host=root@9.134.208.109
linux_builder_port=36000
remote_build_root=
temporary_root=
live_patched=false
original_computer_release_configmap=

usage() {
  cat <<'EOF'
用法：scripts/deploy-computer-canary.sh \
  --kubeconfig /absolute/path/to/kubeconfig \
  --agent-source /absolute/path/to/go-client \
  --web-source /absolute/path/to/velachat/web \
  --version v0.1.31 \
  --signing-key-id computer-release-2026-08-04-v31 \
  --signing-private-key /secure/path/release.private \
  --signing-public-key /secure/path/release.public \
  --release-output /absolute/path/to/release-evidence \
  [--health-base-url http://9.135.236.64]

脚本会在 Mac 原生构建 macOS ARM64，并通过远端 Docker Buildx 构建 Linux AMD64，
生成和独立验签双 target Release Set，
禁止覆盖发布私有 COS，创建唯一 catalog ConfigMap，切换 3 副本 Canary 并验收。
签名私钥和腾讯云凭据不会写入仓库、Kubernetes、Agent 或日志。
EOF
}

fail() {
  echo "Computer Canary 发布失败：$*" >&2
  exit 1
}

wait_deployment_ready() {
  timeout_seconds=$1
  attempts=$((timeout_seconds / 2))
  [ "$attempts" -gt 0 ] || attempts=1
  for _attempt in $(seq 1 "$attempts"); do
    observed_json=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get deployment "$deployment" -o json) || return 1
    generation=$(printf '%s' "$observed_json" | jq -r '.metadata.generation')
    observed=$(printf '%s' "$observed_json" | jq -r '.status.observedGeneration // 0')
    ready=$(printf '%s' "$observed_json" | jq -r '.status.readyReplicas // 0')
    updated=$(printf '%s' "$observed_json" | jq -r '.status.updatedReplicas // 0')
    available=$(printf '%s' "$observed_json" | jq -r '.status.availableReplicas // 0')
    unavailable=$(printf '%s' "$observed_json" | jq -r '.status.unavailableReplicas // 0')
    if [ "$observed" = "$generation" ] && [ "$ready" = 3 ] && [ "$updated" = 3 ] &&
       [ "$available" = 3 ] && [ "$unavailable" = 0 ]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cleanup() {
  exit_code=$?
  trap - EXIT HUP INT TERM
  if [ "$exit_code" -ne 0 ] && [ "$live_patched" = true ]; then
    echo "发布失败，正在恢复原 Computer release catalog……" >&2
    kubectl --kubeconfig "$kubeconfig" -n "$namespace" patch deployment "$deployment" \
      --type=strategic \
      -p "{\"spec\":{\"template\":{\"spec\":{\"volumes\":[{\"name\":\"computer-release\",\"configMap\":{\"name\":\"$original_computer_release_configmap\",\"defaultMode\":292}}]}}}}" \
      >/dev/null 2>&1 || true
    wait_deployment_ready 300 >/dev/null 2>&1 || true
  fi
  if [ -n "$temporary_root" ] && [ -d "$temporary_root" ]; then
    rm -rf -- "$temporary_root"
  fi
  case "$remote_build_root" in
    /tmp/vela-computer-release.*)
      ssh -o BatchMode=yes -p "$linux_builder_port" "$linux_builder_host" \
        "rm -rf -- '$remote_build_root'" >/dev/null 2>&1 || true
      ;;
  esac
  exit "$exit_code"
}
trap cleanup EXIT HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --kubeconfig) [ "$#" -ge 2 ] || fail "--kubeconfig 缺少值"; kubeconfig=$2; shift 2 ;;
    --agent-source) [ "$#" -ge 2 ] || fail "--agent-source 缺少值"; agent_source=$2; shift 2 ;;
    --web-source) [ "$#" -ge 2 ] || fail "--web-source 缺少值"; web_source=$2; shift 2 ;;
    --version) [ "$#" -ge 2 ] || fail "--version 缺少值"; version=$2; shift 2 ;;
    --signing-key-id) [ "$#" -ge 2 ] || fail "--signing-key-id 缺少值"; signing_key_id=$2; shift 2 ;;
    --signing-private-key) [ "$#" -ge 2 ] || fail "--signing-private-key 缺少值"; signing_private_key=$2; shift 2 ;;
    --signing-public-key) [ "$#" -ge 2 ] || fail "--signing-public-key 缺少值"; signing_public_key=$2; shift 2 ;;
    --release-output) [ "$#" -ge 2 ] || fail "--release-output 缺少值"; release_output=$2; shift 2 ;;
    --health-base-url) [ "$#" -ge 2 ] || fail "--health-base-url 缺少值"; health_base_url=$2; shift 2 ;;
    --namespace) [ "$#" -ge 2 ] || fail "--namespace 缺少值"; namespace=$2; shift 2 ;;
    --deployment) [ "$#" -ge 2 ] || fail "--deployment 缺少值"; deployment=$2; shift 2 ;;
    --bucket) [ "$#" -ge 2 ] || fail "--bucket 缺少值"; bucket=$2; shift 2 ;;
    --region) [ "$#" -ge 2 ] || fail "--region 缺少值"; region=$2; shift 2 ;;
    --linux-builder-host) [ "$#" -ge 2 ] || fail "--linux-builder-host 缺少值"; linux_builder_host=$2; shift 2 ;;
    --linux-builder-port) [ "$#" -ge 2 ] || fail "--linux-builder-port 缺少值"; linux_builder_port=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数 $1" ;;
  esac
done

for value_name in kubeconfig agent_source web_source signing_private_key signing_public_key release_output; do
  eval "value=\${$value_name}"
  [ -n "$value" ] || fail "必须提供 --$(printf '%s' "$value_name" | tr '_' '-')"
  case "$value" in /*) ;; *) fail "$value_name 必须是绝对路径" ;; esac
done
[ -f "$kubeconfig" ] || fail "kubeconfig 不存在"
[ -d "$agent_source" ] || fail "Agent 源码目录不存在"
[ -d "$web_source/apps/client" ] || fail "Web 源码目录不存在"
[ -x "$agent_source/scripts/build-vela-macos-arm64.sh" ] || fail "Agent canonical 构建入口不存在"
[ -x "$agent_source/scripts/build-vela-linux-amd64-buildx.sh" ] || fail "Agent Linux Buildx 构建入口不存在"
[ -f "$signing_private_key" ] && [ ! -L "$signing_private_key" ] || fail "签名私钥不是受限普通文件"
[ -f "$signing_public_key" ] && [ ! -L "$signing_public_key" ] || fail "签名公钥不是普通文件"
[ "$(stat -f '%Lp' "$signing_private_key")" = 600 ] || fail "签名私钥权限必须为 0600"
[ -n "$version" ] || fail "必须提供 --version"
printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$' || fail "version 必须是不可变语义版本"
case "$signing_key_id" in *[!A-Za-z0-9._-]*|'') fail "signing-key-id 无效" ;; esac
case "$bucket" in *[!a-z0-9-]*|'') fail "bucket 无效" ;; esac
case "$region" in *[!a-z0-9-]*|'') fail "region 无效" ;; esac
case "$linux_builder_host" in *[!A-Za-z0-9._@:-]*|'') fail "linux-builder-host 无效" ;; esac
printf '%s\n' "$linux_builder_port" | grep -Eq '^[1-9][0-9]{0,4}$' || fail "linux-builder-port 无效"
[ ! -e "$release_output" ] || fail "release-output 已存在；拒绝覆盖发布证据"

for command_name in kubectl jq go cargo bun git base64 curl shasum stat ssh scp tar file; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少命令 $command_name"
done

agent_source=$(CDPATH= cd -- "$agent_source" && pwd -P)
web_source=$(CDPATH= cd -- "$web_source" && pwd -P)
repository_root=$(CDPATH= cd -- "$repository_root" && pwd -P)
agent_git_root=$(git -C "$agent_source" rev-parse --show-toplevel 2>/dev/null) || fail "Agent 源码不属于 Git 工作树"
web_git_root=$(git -C "$web_source" rev-parse --show-toplevel 2>/dev/null) || fail "Web 源码不属于 Git 工作树"
backend_git_root=$(git -C "$repository_root" rev-parse --show-toplevel 2>/dev/null) || fail "Backend 源码不属于 Git 工作树"
agent_git_root=$(CDPATH= cd -- "$agent_git_root" && pwd -P)
web_git_root=$(CDPATH= cd -- "$web_git_root" && pwd -P)
backend_git_root=$(CDPATH= cd -- "$backend_git_root" && pwd -P)
[ "$agent_git_root" = "$web_git_root" ] && [ "$agent_git_root" = "$backend_git_root" ] ||
  fail "Agent、Web 与 Backend 必须来自同一个 Git 工作树"
[ "$agent_source" = "$backend_git_root/agent" ] || fail "agent-source 必须是当前工作树的 agent 目录"
[ "$web_source" = "$backend_git_root/web" ] || fail "web-source 必须是当前工作树的 web 目录"
[ "$repository_root" = "$backend_git_root/backend" ] || fail "发布脚本必须从当前工作树的 backend 目录运行"
agent_head=$(git -C "$agent_source" rev-parse HEAD)
web_head=$(git -C "$web_source" rev-parse HEAD)
backend_head=$(git -C "$repository_root" rev-parse HEAD)
[ "$agent_head" = "$web_head" ] && [ "$agent_head" = "$backend_head" ] ||
  fail "Agent、Web 与 Backend 的 Git HEAD 不一致"

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/computer-canary.XXXXXX")
secret_directory="$temporary_root/secrets"
mkdir -m 0700 "$secret_directory"

echo "[1/8] 校验 Human TUI 可复现构建……"
(
  cd "$web_source/apps/client"
  umask 022
  bun run check:tui
  bun run test:tui
  bun run test:tui-build
)

echo "[2/8] 运行 Agent/Computer 与发布器门禁……"
(
  cd "$agent_source"
  umask 022
  go test -p 1 ./... -count=1
  go vet ./...
  cargo test --manifest-path native/tat-agent/Cargo.toml
)
(
  cd "$repository_root"
  umask 022
  go test ./cmd/computer-release ./internal/computerrelease ./internal/adapters/tencent/cos -count=1
)

echo "[3/8] 校验 live Canary 与不可变版本……"
deployment_json="$temporary_root/deployment.json"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get deployment "$deployment" -o json >"$deployment_json"
[ "$(jq -r '.spec.replicas // 0' "$deployment_json")" = 3 ] || fail "Canary 必须固定为 3 副本"
[ "$(jq -r '.status.availableReplicas // 0' "$deployment_json")" = 3 ] || fail "Canary 当前不是 3/3 Ready"
[ "$(jq -r '.spec.strategy.type // ""' "$deployment_json")" = Recreate ] || fail "Canary 策略不是 Recreate"
selector=$(jq -r '.spec.selector.matchLabels | to_entries | sort_by(.key) | map("\(.key)=\(.value)") | join(",")' "$deployment_json")
[ -n "$selector" ] || fail "Deployment selector 为空"
original_image=$(jq -r '.spec.template.spec.containers[] | select(.name == "chatserver") | .image' "$deployment_json")
case "$original_image" in *@sha256:[0-9a-f][0-9a-f]*) ;; *) fail "后台镜像未固定 sha256: digest" ;; esac
original_computer_release_configmap=$(jq -r '.spec.template.spec.volumes[] | select(.name == "computer-release") | .configMap.name' "$deployment_json")
[ -n "$original_computer_release_configmap" ] && [ "$original_computer_release_configmap" != null ] || fail "无法读取当前 Computer catalog"
live_secret=$(jq -r '.spec.template.spec.volumes[] | select(.name == "secrets") | .secret.secretName' "$deployment_json")
[ -n "$live_secret" ] && [ "$live_secret" != null ] || fail "无法读取当前 Secret"
target_configmap="chatserver-computer-release-$(printf '%s' "$version" | tr '.' '-' | tr '[:upper:]' '[:lower:]')"
if kubectl --kubeconfig "$kubeconfig" -n "$namespace" get configmap "$target_configmap" >/dev/null 2>&1; then
  fail "目标 Computer catalog 已存在；拒绝覆盖不可变版本"
fi

secret_json="$temporary_root/live-secret.json"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get secret "$live_secret" -o json >"$secret_json"
for key in tencent-cloud-secret-id tencent-cloud-secret-key; do
  encoded=$(jq -r --arg key "$key" '.data[$key] // empty' "$secret_json")
  [ -n "$encoded" ] || fail "线上 Secret 缺少 COS 发布凭据文件"
  printf '%s' "$encoded" | base64 --decode >"$secret_directory/$key"
  chmod 0600 "$secret_directory/$key"
done
unset encoded

echo "[4/8] 构建 macOS ARM64 与 Linux AMD64 双目标二进制……"
mac_agent_binary="$temporary_root/vela-computer-darwin-arm64"
linux_agent_binary="$temporary_root/vela-computer-linux-amd64"
linux_build_metadata="$temporary_root/linux-buildx-metadata.json"
"$agent_source/scripts/build-vela-macos-arm64.sh" --version "$version" --output "$mac_agent_binary" >/dev/null
expected_version="{\"mode\":\"vela\",\"name\":\"vela-computer\",\"version\":\"$version\"}"
[ "$("$mac_agent_binary" version --json)" = "$expected_version" ] || fail "macOS 构建产物版本不匹配"
remote_build_root=$(ssh -o BatchMode=yes -p "$linux_builder_port" "$linux_builder_host" \
  'mktemp -d /tmp/vela-computer-release.XXXXXX')
case "$remote_build_root" in /tmp/vela-computer-release.*) ;; *) fail "远端构建目录无效" ;; esac
COPYFILE_DISABLE=1 tar --no-xattrs --exclude='./native/tat-agent/target' --exclude='./dist' --exclude='./._*' -czf - -C "$agent_source" . |
  ssh -o BatchMode=yes -p "$linux_builder_port" "$linux_builder_host" \
    "tar -xzf - -C '$remote_build_root'"
ssh -o BatchMode=yes -p "$linux_builder_port" "$linux_builder_host" \
  "'$remote_build_root/scripts/build-vela-linux-amd64-buildx.sh' --version '$version' --output '$remote_build_root/vela-computer-linux-amd64' --metadata '$remote_build_root/buildx-metadata.json'"
scp -P "$linux_builder_port" "$linux_builder_host:$remote_build_root/vela-computer-linux-amd64" "$linux_agent_binary" >/dev/null
scp -P "$linux_builder_port" "$linux_builder_host:$remote_build_root/buildx-metadata.json" "$linux_build_metadata" >/dev/null
file "$linux_agent_binary" | grep -Eq 'ELF 64-bit.*x86-64' || fail "Linux 构建产物目标错误"
mac_program_hash=$(shasum -a 256 "$mac_agent_binary" | awk '{print $1}')
linux_program_hash=$(shasum -a 256 "$linux_agent_binary" | awk '{print $1}')
[ "${#mac_program_hash}" -eq 64 ] && [ "${#linux_program_hash}" -eq 64 ] || fail "Agent SHA-256 无效"

echo "[5/8] 生成并独立验签双 target Release Set……"
release_directory="$temporary_root/release"
(
  cd "$repository_root"
  go run ./cmd/computer-release build-set \
    --version "$version" \
    --signing-key-id "$signing_key_id" \
    --private-key-file "$signing_private_key" \
    --macos-program "$mac_agent_binary" \
    --linux-program "$linux_agent_binary" \
    --output "$release_directory" >/dev/null
  go run ./cmd/computer-release verify-set \
    --release-directory "$release_directory" \
    --public-key-file "$signing_public_key" >/dev/null
)
catalog_mac_hash=$(jq -r '.targets[] | select(.target == "darwin-arm64") | .program.sha256' "$release_directory/release.catalog.json")
catalog_linux_hash=$(jq -r '.targets[] | select(.target == "linux-amd64") | .program.sha256' "$release_directory/release.catalog.json")
[ "$catalog_mac_hash" = "$mac_program_hash" ] || fail "catalog 与 macOS Agent 摘要不一致"
[ "$catalog_linux_hash" = "$linux_program_hash" ] || fail "catalog 与 Linux Agent 摘要不一致"
cp "$linux_build_metadata" "$release_directory/linux-buildx-metadata.json"
cp "$agent_source/internal/vela/humantui/assets/human-client.bundle.manifest.json" \
  "$release_directory/human-client.bundle.manifest.json"
cp "$agent_source/internal/vela/humantui/assets/human-client.bundle.sha256" \
  "$release_directory/human-client.bundle.sha256"

echo "[6/8] 禁止覆盖发布 COS 并保留验签证据……"
(
  cd "$repository_root"
  go run ./cmd/computer-release publish-set \
    --release-directory "$release_directory" \
    --public-key-file "$signing_public_key" \
    --bucket "$bucket" \
    --region "$region" \
    --secret-id-file "$secret_directory/tencent-cloud-secret-id" \
    --secret-key-file "$secret_directory/tencent-cloud-secret-key" >/dev/null
)
release_parent=$(dirname -- "$release_output")
if [ ! -d "$release_parent" ]; then
  mkdir -m 0700 -p "$release_parent"
fi
mv "$release_directory" "$release_output"

echo "[7/8] 创建 create-only catalog 并切换 Canary……"
catalog_json="$temporary_root/catalog-configmap.json"
kubectl create configmap "$target_configmap" \
  --kubeconfig "$kubeconfig" -n "$namespace" \
  --from-file="release.catalog.json=$release_output/release.catalog.json" \
  --dry-run=client -o json |
  jq '.immutable = true |
    .metadata.annotations = {
      "agentnetwork.io/catalog-write-policy":"create-only-v1"
    } |
    .metadata.labels = {
      "app.kubernetes.io/name":"chatserver",
      "app.kubernetes.io/component":"computer-release"
    }' >"$catalog_json"
kubectl --kubeconfig "$kubeconfig" create -f "$catalog_json" >/dev/null
created_catalog_json="$temporary_root/created-catalog.json"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get configmap "$target_configmap" -o json >"$created_catalog_json"
created_write_policy=$(jq -r '.metadata.annotations["agentnetwork.io/catalog-write-policy"] // empty' "$created_catalog_json")
[ "$created_write_policy" = create-only-v1 ] || fail "catalog 缺少 create-only 写入策略"
expected_catalog_digest=$(jq -cS . "$release_output/release.catalog.json" | shasum -a 256 | awk '{print $1}')
created_catalog_digest=$(jq -r '.data["release.catalog.json"] // empty' "$created_catalog_json" | jq -cS . | shasum -a 256 | awk '{print $1}')
[ "$created_catalog_digest" = "$expected_catalog_digest" ] || fail "已创建 catalog 内容与验签 release 不一致"
catalog_api_immutable=$(jq -r '.immutable // false' "$created_catalog_json")
if [ "$catalog_api_immutable" != true ]; then
  echo "提示：集群不支持 ConfigMap immutable；由唯一版本名、create-only 和内容回读共同保证发布不可覆盖。"
fi
kubectl --kubeconfig "$kubeconfig" -n "$namespace" patch deployment "$deployment" \
  --type=strategic \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"agentnetwork.io/computer-release\":\"$version\"}},\"spec\":{\"volumes\":[{\"name\":\"computer-release\",\"configMap\":{\"name\":\"$target_configmap\",\"defaultMode\":292}}]}}}}" \
  >/dev/null
live_patched=true
wait_deployment_ready 600 || fail "Deployment 未在 600 秒内收敛"

echo "[8/8] 验收 3 副本、catalog 与健康端点……"
pods_json="$temporary_root/pods.json"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get pods -l "$selector" -o json >"$pods_json"
jq -e '
  .items | length == 3 and
  all(.[]; .status.phase == "Running" and
    (.status.containerStatuses[] | select(.name == "chatserver") |
      .ready == true and .restartCount == 0))
' "$pods_json" >/dev/null || fail "Canary Pod 未达到 3/3 Ready、零重启"
mounted_configmap=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get deployment "$deployment" -o json |
  jq -r '.spec.template.spec.volumes[] | select(.name == "computer-release") | .configMap.name')
[ "$mounted_configmap" = "$target_configmap" ] || fail "Deployment 未挂载新 catalog"
if [ -z "$health_base_url" ]; then
  service_ip=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get service "$deployment" -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
  [ -n "$service_ip" ] || fail "无法读取 Canary 内网入口"
  health_base_url="http://$service_ip"
fi
case "$health_base_url" in http://*|https://*) ;; *) fail "health-base-url 无效" ;; esac
curl -fsS "$health_base_url/healthz" >/dev/null
curl -fsS "$health_base_url/readyz" >/dev/null

live_patched=false
echo "Computer Canary 发布成功"
echo "version=$version"
echo "darwinProgramSHA256=$mac_program_hash"
echo "linuxProgramSHA256=$linux_program_hash"
echo "catalog=$target_configmap"
echo "releaseOutput=$release_output"
