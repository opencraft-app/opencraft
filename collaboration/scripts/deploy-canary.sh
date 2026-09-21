#!/bin/sh
set -eu

umask 077

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
namespace=dep
deployment=chatserver-canary
service=chatserver-canary
registry=csighub.tencentyun.com/skipzhang/chatserver
source_secret=chatserver-canary-sharded-secrets
kubeconfig=
fresh_database=
release_id=
health_base_url=
temporary_root=
target_secret=
migration_job=
verify_job=
live_patched=false
original_image=
original_secret=
original_args=
canonical_args=
original_computer_release_configmap=
canonical_computer_release_configmap=

usage() {
  cat <<'EOF'
用法：scripts/deploy-canary.sh \
  --kubeconfig /absolute/path/to/kubeconfig \
  --release-id 20260804-clean-v1 \
  --fresh-database chatserver_canary_20260804_clean_v1 \
  [--source-secret chatserver-canary-sharded-secrets] \
  [--health-base-url http://9.135.236.64]

脚本会执行完整门禁、构建并推送不可变 linux/amd64 镜像、创建全新数据库和
新 Secret、运行 database migrate/verify、精确切换 Deployment，并验证 3 个 Pod。
不会删除旧数据库、旧 Secret 或旧镜像。
EOF
}

fail() {
  echo "Canary 发布失败：$*" >&2
  exit 1
}

wait_for_job() {
  job_name=$1
  max_attempts=$2
  attempt=0
  while [ "$attempt" -lt "$max_attempts" ]; do
    if kubectl --kubeconfig "$kubeconfig" -n "$namespace" wait \
      --for=condition=complete "job/$job_name" --timeout=5s >/dev/null 2>&1; then
      return 0
    fi
    if kubectl --kubeconfig "$kubeconfig" -n "$namespace" get job "$job_name" -o json |
      jq -e '[.status.conditions[]? | select(.type == "Failed" and .status == "True")] | length > 0' >/dev/null; then
      return 1
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

cleanup() {
  exit_code=$?
  trap - EXIT HUP INT TERM
  if [ "$exit_code" -ne 0 ] && [ "$live_patched" = true ]; then
    echo "发布失败，正在恢复原镜像和原 Secret……" >&2
    kubectl --kubeconfig "$kubeconfig" -n "$namespace" patch deployment "$deployment" \
      --type=strategic \
      -p "{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"chatserver\",\"image\":\"$original_image\",\"args\":$original_args}],\"volumes\":[{\"name\":\"computer-release\",\"configMap\":{\"name\":\"$original_computer_release_configmap\",\"defaultMode\":292}},{\"name\":\"secrets\",\"secret\":{\"secretName\":\"$original_secret\",\"defaultMode\":288}}]}}}}" \
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
    --release-id) [ "$#" -ge 2 ] || fail "--release-id 缺少值"; release_id=$2; shift 2 ;;
    --fresh-database) [ "$#" -ge 2 ] || fail "--fresh-database 缺少值"; fresh_database=$2; shift 2 ;;
    --source-secret) [ "$#" -ge 2 ] || fail "--source-secret 缺少值"; source_secret=$2; shift 2 ;;
    --health-base-url) [ "$#" -ge 2 ] || fail "--health-base-url 缺少值"; health_base_url=$2; shift 2 ;;
    --namespace) [ "$#" -ge 2 ] || fail "--namespace 缺少值"; namespace=$2; shift 2 ;;
    --deployment) [ "$#" -ge 2 ] || fail "--deployment 缺少值"; deployment=$2; shift 2 ;;
    --registry) [ "$#" -ge 2 ] || fail "--registry 缺少值"; registry=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数 $1" ;;
  esac
done

[ -n "$kubeconfig" ] || fail "必须显式提供 --kubeconfig"
case "$kubeconfig" in /*) ;; *) fail "--kubeconfig 必须是绝对路径" ;; esac
[ -f "$kubeconfig" ] || fail "kubeconfig 不存在"
[ -n "$release_id" ] || fail "必须提供 --release-id"
[ -n "$fresh_database" ] || fail "必须提供 --fresh-database"
case "$release_id" in *[!a-z0-9-]*|'') fail "release-id 只允许小写字母、数字和连字符" ;; esac
case "$fresh_database" in *[!a-z0-9_]*|'') fail "fresh-database 只允许小写字母、数字和下划线" ;; esac
[ "${#release_id}" -le 40 ] || fail "release-id 过长"
[ "${#fresh_database}" -le 63 ] || fail "fresh-database 过长"

for command_name in kubectl docker jq base64 curl go; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少命令 $command_name"
done

cd "$repository_root"
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/chatserver-canary.XXXXXX")
secret_directory="$temporary_root/secret"
mkdir -m 0700 "$secret_directory"

echo "[1/8] 运行发布门禁……"
(umask 022; go test -p 1 ./... -count=1)
go vet ./...
./scripts/check-generated.sh
./scripts/scan-secrets.sh

echo "[2/8] 校验 live Canary 与源 Secret……"
deployment_json="$temporary_root/deployment.json"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get deployment "$deployment" -o json >"$deployment_json"
replicas=$(jq -r '.spec.replicas // 0' "$deployment_json")
[ "$replicas" = 3 ] || fail "Canary 必须固定为 3 副本"
strategy=$(jq -r '.spec.strategy.type // ""' "$deployment_json")
[ "$strategy" = Recreate ] || fail "Canary Deployment 策略不是 Recreate"
selector=$(jq -r '.spec.selector.matchLabels | to_entries | sort_by(.key) | map("\(.key)=\(.value)") | join(",")' "$deployment_json")
[ -n "$selector" ] || fail "Deployment selector 为空"
original_image=$(jq -r '.spec.template.spec.containers[] | select(.name == "chatserver") | .image' "$deployment_json")
original_secret=$(jq -r '.spec.template.spec.volumes[] | select(.name == "secrets") | .secret.secretName' "$deployment_json")
original_args=$(jq -c '.spec.template.spec.containers[] | select(.name == "chatserver") | .args' "$deployment_json")
original_computer_release_configmap=$(jq -r '.spec.template.spec.volumes[] | select(.name == "computer-release") | .configMap.name' "$deployment_json")
[ -n "$original_image" ] && [ "$original_image" != null ] || fail "无法读取当前镜像"
[ -n "$original_secret" ] && [ "$original_secret" != null ] || fail "无法读取当前 Secret"
[ "$original_args" != null ] || fail "无法读取当前启动参数"
[ -n "$original_computer_release_configmap" ] && [ "$original_computer_release_configmap" != null ] || fail "无法读取当前 Computer 发布目录"
kubectl create --dry-run=client -f "$repository_root/deploy/k8s/deployment.yaml" -o json \
  >"$temporary_root/canonical-deployment.json"
canonical_args=$(jq -c '.spec.template.spec.containers[] | select(.name == "chatserver") | .args' \
  "$temporary_root/canonical-deployment.json")
[ "$canonical_args" != null ] || fail "正式 Deployment 缺少 chatserver 启动参数"
canonical_computer_release_configmap=$(jq -r '.spec.template.spec.volumes[] | select(.name == "computer-release") | .configMap.name' \
  "$temporary_root/canonical-deployment.json")
[ -n "$canonical_computer_release_configmap" ] && [ "$canonical_computer_release_configmap" != null ] || fail "正式 Deployment 缺少 Computer 发布目录"
kubectl create --dry-run=client -f "$repository_root/deploy/k8s/computer-release-configmap.yaml" -o json \
  >"$temporary_root/canonical-computer-release.json"
catalog_name=$(jq -r '.metadata.name' "$temporary_root/canonical-computer-release.json")
[ "$catalog_name" = "$canonical_computer_release_configmap" ] || fail "Computer 发布目录与 Deployment 不匹配"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get secret "$source_secret" -o json >"$temporary_root/source-secret.json"

target_secret="chatserver-canary-$release_id-secrets"
migration_job="chatserver-canary-$release_id-migrate"
verify_job="chatserver-canary-$release_id-verify"
if kubectl --kubeconfig "$kubeconfig" -n "$namespace" get secret "$target_secret" >/dev/null 2>&1; then
  fail "目标 Secret 已存在；release-id 必须不可变且唯一"
fi
if kubectl --kubeconfig "$kubeconfig" -n "$namespace" get job "$migration_job" >/dev/null 2>&1 ||
  kubectl --kubeconfig "$kubeconfig" -n "$namespace" get job "$verify_job" >/dev/null 2>&1; then
  fail "目标 Job 已存在；release-id 必须不可变且唯一"
fi

echo "[3/8] 构建并推送不可变镜像……"
image_tag="$registry:canary-$release_id"
if docker buildx imagetools inspect "$image_tag" >/dev/null 2>&1; then
  fail "远端 tag 已存在；拒绝覆盖不可变发布"
fi
docker buildx build \
  --platform linux/amd64 \
  --build-arg "VERSION=$release_id" \
  --tag "$image_tag" \
  --push \
  "$repository_root"
digest=$(docker buildx imagetools inspect "$image_tag" | awk '$1 == "Digest:" {print $2; exit}')
case "$digest" in sha256:[0-9a-f][0-9a-f]*) ;; *) fail "远端镜像未返回 sha256: digest" ;; esac
[ "${#digest}" -eq 71 ] || fail "远端镜像 digest 长度无效"
image="$registry@$digest"

echo "[4/8] 创建全新数据库 Secret……"
for key in im-callback.token im-identity.key im-secret.key jwt.key mysql-bootstrap.cnf tdsql.dsn tencent-cloud-secret-id tencent-cloud-secret-key; do
  encoded=$(jq -r --arg key "$key" '.data[$key] // empty' "$temporary_root/source-secret.json")
  [ -n "$encoded" ] || fail "源 Secret 缺少 $key"
  printf '%s' "$encoded" | base64 --decode >"$secret_directory/$key"
  chmod 0600 "$secret_directory/$key"
done
old_dsn=$(cat "$secret_directory/tdsql.dsn")
case "$old_dsn" in */*) ;; *) fail "tdsql.dsn 格式无效" ;; esac
dsn_prefix=${old_dsn%/*}
dsn_tail=${old_dsn##*/}
case "$dsn_tail" in
  *\?*) dsn_parameters="?${dsn_tail#*\?}" ;;
  *) dsn_parameters= ;;
esac
old_database=${dsn_tail%%\?*}
[ "$old_database" != "$fresh_database" ] || fail "fresh-database 必须不同于当前数据库"
printf '%s/%s%s' "$dsn_prefix" "$fresh_database" "$dsn_parameters" >"$secret_directory/tdsql.dsn"
unset old_dsn dsn_prefix dsn_tail dsn_parameters encoded

kubectl --kubeconfig "$kubeconfig" -n "$namespace" create secret generic "$target_secret" \
  --from-file="$secret_directory" \
  --dry-run=client -o yaml >"$temporary_root/target-secret.yaml"
kubectl --kubeconfig "$kubeconfig" apply -f "$temporary_root/target-secret.yaml" >/dev/null

echo "[5/8] 创建空数据库并运行 database migrate……"
cat >"$temporary_root/migration-job.yaml" <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $migration_job
  namespace: $namespace
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 600
  template:
    spec:
      restartPolicy: Never
      imagePullSecrets:
        - name: csighub-skipzhang
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        fsGroup: 65532
      initContainers:
        - name: bootstrap-database
          image: mysql@sha256:a2d126916bc2ba79a890a4bf62d305eb8b68fcbdd35c6e582d529df18faf5ebb
          command: ["/bin/sh", "-ec"]
          args:
            - exec mysql --defaults-extra-file=/var/run/secrets/chatserver/mysql-bootstrap.cnf -e "CREATE DATABASE IF NOT EXISTS $fresh_database CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
          volumeMounts:
            - {name: secrets, mountPath: /var/run/secrets/chatserver, readOnly: true}
      containers:
        - name: migration
          image: $image
          args: ["database", "migrate", "--database-driver", "tdsql", "--database-dsn-file", "/var/run/secrets/chatserver/tdsql.dsn"]
          volumeMounts:
            - {name: secrets, mountPath: /var/run/secrets/chatserver, readOnly: true}
      volumes:
        - name: secrets
          secret: {secretName: $target_secret, defaultMode: 288}
EOF
kubectl --kubeconfig "$kubeconfig" apply -f "$temporary_root/migration-job.yaml" >/dev/null
if ! wait_for_job "$migration_job" 120; then
  kubectl --kubeconfig "$kubeconfig" -n "$namespace" logs "job/$migration_job" --all-containers=true --tail=200 >&2 || true
  fail "database migrate Job 失败"
fi

echo "[6/8] 运行 database verify……"
cat >"$temporary_root/verify-job.yaml" <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $verify_job
  namespace: $namespace
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 300
  template:
    spec:
      restartPolicy: Never
      imagePullSecrets:
        - name: csighub-skipzhang
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        fsGroup: 65532
      containers:
        - name: verify
          image: $image
          args: ["database", "verify", "--database-driver", "tdsql", "--database-dsn-file", "/var/run/secrets/chatserver/tdsql.dsn"]
          volumeMounts:
            - {name: secrets, mountPath: /var/run/secrets/chatserver, readOnly: true}
      volumes:
        - name: secrets
          secret: {secretName: $target_secret, defaultMode: 288}
EOF
kubectl --kubeconfig "$kubeconfig" apply -f "$temporary_root/verify-job.yaml" >/dev/null
if ! wait_for_job "$verify_job" 60; then
  kubectl --kubeconfig "$kubeconfig" -n "$namespace" logs "job/$verify_job" --all-containers=true --tail=200 >&2 || true
  fail "database verify Job 失败"
fi

echo "[7/8] 精确切换 Deployment 并等待 rollout……"
if kubectl --kubeconfig "$kubeconfig" -n "$namespace" get configmap "$canonical_computer_release_configmap" -o json \
  >"$temporary_root/live-computer-release.json" 2>/dev/null; then
  canonical_catalog_data=$(jq -S -c '.data' "$temporary_root/canonical-computer-release.json")
  live_catalog_data=$(jq -S -c '.data' "$temporary_root/live-computer-release.json")
  [ "$canonical_catalog_data" = "$live_catalog_data" ] || fail "Computer 发布目录已存在且内容不同；拒绝覆盖"
else
  kubectl --kubeconfig "$kubeconfig" create -f "$repository_root/deploy/k8s/computer-release-configmap.yaml" >/dev/null
fi
kubectl --kubeconfig "$kubeconfig" -n "$namespace" patch deployment "$deployment" \
  --type=strategic \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"agentnetwork.io/release-id\":\"$release_id\",\"agentnetwork.io/database\":\"$fresh_database\"}},\"spec\":{\"containers\":[{\"name\":\"chatserver\",\"image\":\"$image\",\"args\":$canonical_args}],\"volumes\":[{\"name\":\"computer-release\",\"configMap\":{\"name\":\"$canonical_computer_release_configmap\",\"defaultMode\":292}},{\"name\":\"secrets\",\"secret\":{\"secretName\":\"$target_secret\",\"defaultMode\":288}}]}}}}" \
  >/dev/null
live_patched=true
kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status "deployment/$deployment" --timeout=600s

pods_json="$temporary_root/pods.json"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get pods -l "$selector" -o json >"$pods_json"
[ "$(jq '.items | length' "$pods_json")" -eq 3 ] || fail "rollout 后 Pod 数不是 3"
jq -e --arg digest "$digest" '
  [.items[] |
    (.status.containerStatuses[] | select(.name == "chatserver")) |
    select(.ready == true and .restartCount == 0 and (.imageID | contains($digest)))] |
  length == 3
' "$pods_json" >/dev/null || fail "Pod Ready、零重启或统一 digest 验收失败"

echo "[8/8] 验证健康端点……"
if [ -z "$health_base_url" ]; then
  load_balancer_ip=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get service "$service" -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
  [ -n "$load_balancer_ip" ] || fail "无法读取 Canary 内网入口"
  health_base_url="http://$load_balancer_ip"
fi
case "$health_base_url" in http://*|https://*) ;; *) fail "health-base-url 必须是 http(s) URL" ;; esac
curl -fsS "$health_base_url/healthz" >/dev/null
curl -fsS "$health_base_url/readyz" >/dev/null

kubectl --kubeconfig "$kubeconfig" -n "$namespace" delete job "$migration_job" "$verify_job" --ignore-not-found >/dev/null
live_patched=false
echo "Canary 发布成功"
echo "release-id=$release_id"
echo "image=$image"
echo "database=$fresh_database"
echo "secret=$target_secret"
