# Production Kubernetes Manifests

这个目录放生产 TKE 侧的最小部署拼图。Terraform 只负责创建 VPC、TKE、CDB、Redis、TCR 仓库；这里的 Job 负责把数据库资源初始化成 LLMGateway 能使用的状态，应用模板负责部署 control、traffic，以及 core、BYOK、observer 三类 worker，`LLMFleet` 负责描述 new-api Set runtime。

## 镜像

镜像按 commit tag 推送到目标地域 TCR。仓库地址从该地域 Terraform 的 `llmgateway_image_repository` output 获取：

```bash
tofu -chdir=deploy/terraform/tencentcloud-prod output -raw llmgateway_image_repository
```

TKE 需要 `tcr-pull-secret`。建议用 TCR 长期 token 或专用机器人账号创建 `kubernetes.io/dockerconfigjson` Secret，不要把 token 写入 YAML。

## DB Bootstrap

`db-bootstrap-job.yaml` 是模板，不应原样 apply。需要先把 `${...}` 替换成真实 CDB endpoint 和密码，或由 CI/Secret Manager 渲染成最终 Secret。

Job 的职责：

- 创建 control DB：`llmgateway`
- 创建 control app 用户：`llmgateway_app`
- 授权 control app 用户访问 `llmgateway`
- 给每个 shard 创建 `newapi_app` 用户
- 授权 `newapi_app` 访问 `newapi_%` 数据库集合
- 可选创建 `initial_databases`
- 打开 LLMGateway control DB，触发 schema migration
- seed `llmgateway_shards`，让控制面知道 `shard-a` / `shard-b`

它是幂等的：建库、建用户、授权、seed shard 都可以重复执行。新增 shard 时，扩展 `shards` 配置后重跑即可。

数据库和 control 启动后，用正常管理 API 导入平台权益模板，不直接修改 new-api 数据库：

```bash
export LLMGATEWAY_CONTROL_URL="https://llm-gateway-control.example.com"
export LLMGATEWAY_CONTROL_TOKEN="$(kubectl -n llmgateway get secret llmgateway-control-runtime -o jsonpath='{.data.CLUSTER_ADMIN_TOKEN}' | base64 -d)"
deploy/k8s/prod/bootstrap/import-entitlement-plans.sh
```

`bootstrap/entitlement-plans.json` 当前只包含 CTL 正在引用的 6 个权益模板，以及业务 Plan 下显式登记的非默认周期；入门型包含 `14 days` 周期变体。文件不包含 Coding 历史模板或北京压测产生的 `load-*` 数据。脚本可重复执行：同 ID 同权益幂等成功，同 ID 不同权益会返回 409 并停止；周期变体通过 `/api/plans/{id}/periods` 登记，不创建拼接 ID 的独立 Plan。模板和周期入库后由 `sync_plans` worker 下发到各 Set。

```bash
kubectl apply -f rendered-db-bootstrap-job.yaml
kubectl -n llmgateway logs job/llmgateway-db-bootstrap
```

## 应用部署

`llmgateway-app.yaml.template` 是不含敏感信息的模板。渲染前需要提供：

- `LLMGATEWAY_IMAGE`：目标地域 Terraform 输出的 TCR 镜像地址加 commit tag。
- `LLMGATEWAY_VERSION`：与镜像 tag 对应的 Git commit，用作 OTel `service.version`。
- `K8S_CLUSTER_NAME`：当前 TKE 集群名称，用作 OTel Resource。
- `CLOUD_REGION`：当前地域，例如 `ap-beijing`。
- `CONTROL_HOST`：管理面正式域名，和流量面域名分开。
- `CONTROL_CERT_SECRET`：TKE Service HTTPS 使用的管理面证书 Secret 名称。
- `CONTROL_CERT_ID`：腾讯云 SSL 证书 ID；模板会写入管理面 Secret 的 `qcloud_cert_id`。
- `TRAFFIC_HOST`：正式业务域名，不要使用腾讯云默认的 `*.tencentclb.com` 域名。
- `TRAFFIC_CERT_SECRET`：TKE Service HTTPS 使用的证书 Secret 名称。
- `TRAFFIC_CERT_ID`：腾讯云 SSL 证书 ID；模板会写入 Secret 的 `qcloud_cert_id`。

需要预先创建这些 Secret：

- `tcr-pull-secret`：拉取 TCR 镜像。
- `llmgateway-control-runtime`：控制面运行时环境变量，包括 `LLMGATEWAY_SQL_DSN`、`LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL`、`CLUSTER_ADMIN_TOKEN`、`INTERNAL_SERVICE_TOKEN`、`NEWAPI_SET_ROOT_USERNAME`、`NEWAPI_SET_ROOT_PASSWORD` 等。
- `llmgateway-worker-runtime`：后台任务运行时环境变量，至少包括 `LLMGATEWAY_SQL_DSN`、`LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL`、`CLUSTER_ADMIN_TOKEN`、`INTERNAL_SERVICE_TOKEN`、`NEWAPI_SET_ROOT_USERNAME`、`NEWAPI_SET_ROOT_PASSWORD`。
- `llmgateway-traffic-runtime`：流量面运行时环境变量，默认只需要 `LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL`。traffic 进程必须保持 Redis route snapshot only，不应暴露 LLMGateway MySQL DSN。

control 和 worker 的生产模板把 `LLMGATEWAY_SQL_STARTUP_TIMEOUT` 设为 10 分钟。control 还使用 startup probe 屏蔽启动期的 liveness，确保大表在线索引迁移期间旧副本继续服务，新副本不会被提前重启。

`llmgateway-traffic` 运行时必须能读取 `LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL`，它只使用 Redis route snapshot 转发 `/v1/*`，不会打开 LLMGateway MySQL；control/worker 仍然使用 `LLMGATEWAY_SQL_DSN` 维护控制面状态和后台任务。生产模板刻意拆成三个 runtime Secret，是为了避免把控制面数据库凭据下发到流量 Pod。

如果线上仍然只有旧的 `llmgateway-runtime`，先执行一次迁移脚本：

```bash
LLMGATEWAY_PROD_NAMESPACE=llmgateway deploy/k8s/prod/migrate-runtime-secrets.sh
```

脚本会从原 Secret 生成 `llmgateway-control-runtime`、`llmgateway-worker-runtime`、`llmgateway-traffic-runtime`。其中 traffic Secret 只保留 `LLMGATEWAY_KEY_ROUTE_CACHE_*` 变量。

示例：

```bash
export LLMGATEWAY_IMAGE="$(tofu -chdir=deploy/terraform/tencentcloud-prod output -raw llmgateway_image_repository):<commit>"
export LLMGATEWAY_VERSION="<commit>"
export K8S_CLUSTER_NAME="<tke-cluster-name>"
export CLOUD_REGION="ap-beijing"
export CONTROL_HOST="llm-gateway-control.example.com"
export CONTROL_CERT_SECRET="llm-gateway-control-example-com-cert"
export CONTROL_CERT_ID="example-control-cert-id"
export TRAFFIC_HOST="llm-gateway.example.com"
export TRAFFIC_CERT_SECRET="llm-gateway-example-com-cert"
export TRAFFIC_CERT_ID="example-cert-id"
envsubst < llmgateway-app.yaml.template > rendered-llmgateway-app.yaml
kubectl apply -f rendered-llmgateway-app.yaml
kubectl -n llmgateway rollout status deploy/llmgateway-control
kubectl -n llmgateway rollout status deploy/llmgateway-traffic
kubectl -n llmgateway rollout status deploy/llmgateway-worker-core
kubectl -n llmgateway rollout status deploy/llmgateway-worker-byok
kubectl -n llmgateway rollout status deploy/llmgateway-worker-observer
```

control、各 worker、set-manager 和 runtime-cleaner 默认输出单行 OTLP protobuf JSON 到 stdout，
由 TKE 的 CLS 日志采集直接入库；traffic 默认关闭。Pod 名称、UID 和 namespace 通过 Downward API
注入，退出时会在 5 秒上限内 flush。显式填写错误的 OTel 队列、批次或 duration 会让进程启动失败，
避免生产配置悄悄退回默认值。

腾讯云 CLB 会阻断平台默认域名的 HTTP 访问。生产必须把自定义域名 CNAME 到 Service 输出的 CLB 默认域名，并把同一个自定义域名填入 `CONTROL_HOST` 或 `TRAFFIC_HOST`。HTTPS 由 CLB 终止，TKE 要求 HTTPS listener 的 `tls` 指向一个 Opaque Secret，Secret 的 `qcloud_cert_id` 值为腾讯云 SSL 证书 ID。临时验证时可以使用 `curl --resolve` 指定 Host 和 CLB IP。

DNS 记录由 `deploy/terraform/tencentcloud-prod/edge_dns.tf` 管理；CLB 本体仍由这里的 K8s `Service type=LoadBalancer` 和腾讯云 Service controller 管理。新地域首次部署先以 `edge_dns_enabled=false` 创建基础设施和 Service，获得 CLB 默认域名后写回地域 tfvars，再开启 DNS。重新创建 Service 导致 CLB 默认域名变化时，应先更新 Terraform 的 `control_clb_domain` / `traffic_clb_domain` 并执行 plan/apply，再切流量。

### 当前北京生产环境

当前北京生产入口：

```text
管理面：https://llmgw-control.lightvela.com
流量面：https://llmgw-inner.lightvela.com
```

DNS 解析：

```text
llmgw-control.lightvela.com CNAME lb-m2z2hu01-gc1pzodr6i4eyjq5.clb.bj-tencentclb.com
llmgw-inner.lightvela.com CNAME lb-kmvdis9v-zjksm2601iqxwrvl.clb.bj-tencentclb.com
```

当前线上渲染变量：

```bash
export CONTROL_HOST="llmgw-control.lightvela.com"
export CONTROL_CERT_SECRET="llmgw-control-lightvela-com-cert"
export CONTROL_CERT_ID="XCYa3P4e"
export TRAFFIC_HOST="llmgw-inner.lightvela.com"
export TRAFFIC_CERT_SECRET="llmgw-inner-lightvela-com-cert"
export TRAFFIC_CERT_ID="XCYa3P4e"
```

`CONTROL_CERT_ID` 和 `TRAFFIC_CERT_ID` 当前都对应腾讯云 SSL 证书 `*.lightvela.com`，覆盖 `llmgw-control.lightvela.com` 和 `llmgw-inner.lightvela.com`。

管理面只承载 control API 和控制台，不承载 `/v1/*`。内部系统调用管理 API 时不使用用户模型 key，也不传 `sk-...`；如果直接调用 `/api/admin/*`，当前仍需要 `Authorization: Bearer <CLUSTER_ADMIN_TOKEN>` 或后续替换成上层服务身份。调用模型流量时使用 OpenAI-compatible 入口，例如 `POST https://llmgw-inner.lightvela.com/v1/chat/completions`。

管理台推理自检统一调用 control 的 `POST /api/admin/traffic-probe`。只传用户 ID 时，每个用户固定复用一个 `traffic_probe` key，不会在每次测试时重复签发。`gateway` 模式通过 `LLMGATEWAY_TRAFFIC_BASE_URL=http://llmgateway-traffic` 进入统一流量面；`set_direct` 模式由 control 根据 external key binding 直连目标 Set 的 traffic Service，用于区分统一路由故障与 Set/上游故障。LLMGateway MySQL 同时保存完整 external key 和 SHA-256；明文用于故障恢复，哈希唯一索引用于路由查询，Redis 热路由不保存 external key 明文。

管理 key 不写入 Git 仓库。当前生产管理 key 存在 TKE Secret `llmgateway-control-runtime` 的 `CLUSTER_ADMIN_TOKEN` 字段里，需要有集群权限的人按需读取：

```bash
kubectl --kubeconfig /tmp/llmgateway-prod-kubeconfig \
  -n llmgateway get secret llmgateway-control-runtime \
  -o jsonpath='{.data.CLUSTER_ADMIN_TOKEN}' | base64 -d
```

调用管理 API 示例：

```bash
export LLMGATEWAY_CONTROL_TOKEN="$(kubectl --kubeconfig /tmp/llmgateway-prod-kubeconfig -n llmgateway get secret llmgateway-control-runtime -o jsonpath='{.data.CLUSTER_ADMIN_TOKEN}' | base64 -d)"

curl -sS https://llmgw-control.lightvela.com/api/admin/overview \
  -H "Authorization: Bearer ${LLMGATEWAY_CONTROL_TOKEN}"
```

## LLMFleet

new-api 数据库连接池由 `LLMFleet.spec.newapi.databasePool` 提供默认值，Shard 可通过
`spec.shards[].databasePool` 按叶子字段覆盖。Set 中的连接池字段由 set-manager 物化，
不得人工逐个维护。生产初值为 admin/traffic `maxOpenConns=32`、`maxIdleConns=2`、
`maxLifetimeSeconds=60`，订阅写入并发为每 Set 8。

每个 Shard 必须配置 `maxSets`。自动扩容按已纳管 Set、非终态 provision request 和
runtime lease 去重后的 `allocated/maxSets` 选择 Shard；数据库连接数只作为安全告警，
不参与日常放置排序。

生产默认使用 `LLMFleet` 作为 Set runtime 的事实入口：

1. 安装 kro。当前 TKE Serverless 云测使用 `0.8.5`；`0.9.2` 会依赖 `GraphRevision` 字段选择器，在当前 apiserver 上会出现 `field label not supported: spec.snapshot.name`。
2. `kubectl apply -f llmfleet-rgd.yaml`，等待 `rgd/llmfleets.llmgateway.io` Ready。
3. 渲染并 apply `llmfleet-shard-secrets.yaml.template`，创建 shard Secret。
4. 首次渲染并 apply `llmfleet.yaml.template`，创建初始 `prod` Fleet。模板只声明 shard，`spec.sets` 初始为空。
5. 渲染并 apply `llmgateway-set-manager.yaml.template`。

示例 kro 安装：

```bash
helm upgrade --install kro oci://registry.k8s.io/kro/charts/kro \
  --version 0.8.5 \
  --namespace kro \
  --create-namespace \
  --set image.repository="${KRO_IMAGE_REPOSITORY}" \
  --set image.tag=v0.8.5-amd64 \
  --set 'imagePullSecrets[0].name=tcr-pull-secret' \
  --wait \
  --timeout 5m
```

`KRO_IMAGE_REPOSITORY` 应指向目标地域 TCR 中预先镜像的 kro 仓库；北京当前值为 `lightclaw-bj82.tencentcloudcr.com/llmgateway/kro`。

set-manager 不再直接创建 new-api Secret、Deployment、Service。它先消费 control 产生的 `pending` request，以 `slave replicas=0` 把新 Set patch 到 `LLMFleet.spec.sets`；control 完成 bootstrap、合规、渠道、定价和权益模板后将 request 标记为 `configured`；set-manager 再把 slave 扩到目标副本数，等待 Fleet Ready 后标记为 `managed`。最终 admission 独立检查通过后才允许分配用户和承载流量。生产不再保留手工写死的创世 Set；首批 Set 也必须通过同一条路径创建。

首批 Set 的标准动作由 `llmgateway-worker-core` 的 `reconcile_set_capacity` 任务触发。生产模板显式设置 `LLMGATEWAY_SET_AUTOSCALER_ENABLED=true`、`LLMGATEWAY_SET_AUTOSCALER_MIN_WARM_SETS=4`、`LLMGATEWAY_SET_AUTOSCALER_MAX_SCALE_UP_PER_CYCLE=2`，所以全新 Fleet 即使 `spec.sets` 为空，也会分两轮写入四个 pending provision request。每个请求都按 `pending → created → configured → managed` 幂等推进；失败会停留在当前可重试阶段或记录为 `error`，不会越过 admission。

每个生产 Set 的 new-api runtime 使用双入口拓扑：

- admin Service：`<fleet>-<set>-newapi-admin` 只选择一个 `admin-master`。控制面写入和紧随其后的订阅操作固定进入该进程，避免 `SYNC_FREQUENCY` 窗口内读到旧配置。
- traffic Service：`<fleet>-<set>-newapi-traffic` 只选择 N 个 `NODE_TYPE=slave` traffic Pod。admin master 不承载 `/v1/*` 推理流量，`set.replicas` 就是该 Set 的推理副本数。

master 使用 `Recreate` 保证任一时刻只有一个控制写进程；升级窗口内管理写进入 MySQL 命令队列，已有 slave 继续承载模型流量。traffic slave 使用版本化蓝绿 runtime，详见 `docs/set-blue-green-upgrade.md`。

注意：`llmfleet.yaml.template` 是 bootstrap 模板，不是持续覆盖模板。Fleet 的 `spec.sets` 由 set-manager 动态维护；反复 apply 空 `spec.sets` 的模板会删除动态扩出来的 Set。后续若要变更 shard host/port，应使用 `patch-llmfleet-shards.sh` 只 patch `spec.shards`，或先从线上 Fleet 导出完整 `spec.sets` 后再发布。

`llmfleet.yaml.template` 里 shard 只保留 host/port 和 `secretName`；initContainer 从 shard Secret 读取 admin 凭据幂等建库，new-api 主容器只用 `newapi_app` 连接对应 `newapi_%` 数据库。

## 生产冒烟

生产部署完成后，可以用和本地 KRO 相同的链路做一次集群内冒烟：

```bash
LLMGATEWAY_PROD_NAMESPACE=llmgateway deploy/k8s/prod/smoke/run-traffic-smoke.sh
```

这条脚本会复用 `k8s/orbstack-kro/e2e` 的 Go runner，并临时部署开源 `kagent-dev/mockllm` 作为 OpenAI-compatible 上游。它会在 control 里保存渠道包、同步到已纳管 Set、创建租户和外部 key、给上游 new-api 用户加测试额度，然后通过 `llmgateway-traffic` 调用 `/v1/chat/completions`。返回内容包含 `llmgateway k8s e2e` 时，说明“Set 纳管 + 渠道同步 + Redis 路由 + 流量面转发 + new-api relay”闭环是通的。
