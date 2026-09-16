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
version=
signing_key_id=
signing_private_key=
signing_public_key=
release_output=
health_base_url=
temporary_root=
live_patched=false
original_computer_release_configmap=

usage() {
  cat <<'EOF'
用法：scripts/deploy-computer-canary.sh \
  --kubeconfig /absolute/path/to/kubeconfig \
  --agent-source /absolute/path/to/go-client \
  --version v0.1.31 \
  --signing-key-id computer-release-2026-08-04-v31 \
  --signing-private-key /secure/path/release.private \
  --signing-public-key /secure/path/release.public \
  --release-output /absolute/path/to/release-evidence \
  [--health-base-url http://9.135.236.64]

脚本会测试并构建唯一 macOS ARM64 raft-computer-go，生成和独立验签 release，
禁止覆盖发布私有 COS，创建唯一 catalog ConfigMap，切换 3 副本 Canary 并验收。
签名私钥和腾讯云凭据不会写入仓库、Kubernetes、Agent 或日志。
EOF
}

fail() {
  echo "Computer Canary 发布失败：$*" >&2
  exit 1
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
    kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status \
      "deployment/$deployment" --timeout=300s >/dev/null 2>&1 || true
  fi
  if [ -n "$temporary_root" ] && [ -d "$temporary_root" ]; then
    rm -rf -- "$temporary_root"
  fi
  exit "$exit_code"
}
trap cleanup EXIT HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --kubeconfig) [ "$#" -ge 2 ] || fail "--kubeconfig 缺少值"; kubeconfig=$2; shift 2 ;;
    --agent-source) [ "$#" -ge 2 ] || fail "--agent-source 缺少值"; agent_source=$2; shift 2 ;;
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
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数 $1" ;;
  esac
done

for value_name in kubeconfig agent_source signing_private_key signing_public_key release_output; do
  eval "value=\${$value_name}"
  [ -n "$value" ] || fail "必须提供 --$(printf '%s' "$value_name" | tr '_' '-')"
  case "$value" in /*) ;; *) fail "$value_name 必须是绝对路径" ;; esac
done
[ -f "$kubeconfig" ] || fail "kubeconfig 不存在"
[ -d "$agent_source" ] || fail "Agent 源码目录不存在"
[ -x "$agent_source/scripts/build-vela-macos-arm64.sh" ] || fail "Agent canonical 构建入口不存在"
[ -f "$signing_private_key" ] && [ ! -L "$signing_private_key" ] || fail "签名私钥不是受限普通文件"
[ -f "$signing_public_key" ] && [ ! -L "$signing_public_key" ] || fail "签名公钥不是普通文件"
[ "$(stat -f '%Lp' "$signing_private_key")" = 600 ] || fail "签名私钥权限必须为 0600"
[ -n "$version" ] || fail "必须提供 --version"
printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$' || fail "version 必须是不可变语义版本"
case "$signing_key_id" in *[!A-Za-z0-9._-]*|'') fail "signing-key-id 无效" ;; esac
case "$bucket" in *[!a-z0-9-]*|'') fail "bucket 无效" ;; esac
case "$region" in *[!a-z0-9-]*|'') fail "region 无效" ;; esac
[ ! -e "$release_output" ] || fail "release-output 已存在；拒绝覆盖发布证据"

for command_name in kubectl jq go cargo base64 curl shasum stat; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少命令 $command_name"
done

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/computer-canary.XXXXXX")
secret_directory="$temporary_root/secrets"
mkdir -m 0700 "$secret_directory"

echo "[1/7] 运行 Agent/Computer 与发布器门禁……"
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

echo "[2/7] 校验 live Canary 与不可变版本……"
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

echo "[3/7] 构建唯一 macOS ARM64 单二进制……"
agent_binary="$temporary_root/raft-computer-go"
"$agent_source/scripts/build-vela-macos-arm64.sh" --version "$version" --output "$agent_binary" >/dev/null
expected_version="{\"mode\":\"vela\",\"name\":\"raft-computer-go\",\"version\":\"$version\"}"
[ "$("$agent_binary" version --json)" = "$expected_version" ] || fail "构建产物版本不匹配"
program_hash=$(shasum -a 256 "$agent_binary" | awk '{print $1}')
[ "${#program_hash}" -eq 64 ] || fail "Agent SHA-256 无效"

echo "[4/7] 生成并独立验签 release……"
release_directory="$temporary_root/release"
(
  cd "$repository_root"
  go run ./cmd/computer-release \
    --version "$version" \
    --target darwin-arm64 \
    --os-type macos \
    --architecture arm64 \
    --signing-key-id "$signing_key_id" \
    --private-key-file "$signing_private_key" \
    --program "$agent_binary" \
    --output "$release_directory" >/dev/null
  go run ./cmd/computer-release verify \
    --release-directory "$release_directory" \
    --public-key-file "$signing_public_key" >/dev/null
)
catalog_hash=$(jq -r '.program.sha256' "$release_directory/release.catalog.json")
[ "$catalog_hash" = "$program_hash" ] || fail "catalog 与 Agent 二进制摘要不一致"

echo "[5/7] 禁止覆盖发布 COS 并保留验签证据……"
(
  cd "$repository_root"
  go run ./cmd/computer-release publish \
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

echo "[6/7] 创建 catalog 并切换 Canary……"
catalog_json="$temporary_root/catalog-configmap.json"
kubectl create configmap "$target_configmap" \
  --kubeconfig "$kubeconfig" -n "$namespace" \
  --from-file="release.catalog.json=$release_output/release.catalog.json" \
  --dry-run=client -o json |
  jq '.immutable = true | .metadata.labels = {
    "app.kubernetes.io/name":"chatserver",
    "app.kubernetes.io/component":"computer-release"
  }' >"$catalog_json"
kubectl --kubeconfig "$kubeconfig" create -f "$catalog_json" >/dev/null
kubectl --kubeconfig "$kubeconfig" -n "$namespace" patch deployment "$deployment" \
  --type=strategic \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"agentnetwork.io/computer-release\":\"$version\"}},\"spec\":{\"volumes\":[{\"name\":\"computer-release\",\"configMap\":{\"name\":\"$target_configmap\",\"defaultMode\":292}}]}}}}" \
  >/dev/null
live_patched=true
kubectl rollout status "deployment/$deployment" \
  --kubeconfig "$kubeconfig" -n "$namespace" --timeout=600s

echo "[7/7] 验收 3 副本、catalog 与健康端点……"
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
echo "programSHA256=$program_hash"
echo "catalog=$target_configmap"
echo "releaseOutput=$release_output"
