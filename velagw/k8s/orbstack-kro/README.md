# OrbStack + kro 本地 Set 试验

这个目录是一个很薄的云原生 POC：用 kro 定义 `LLMFleet` 这个自定义资源，然后让一个 Fleet 实例自动展开多个 new-api Set。

P0 模型里，Shard 和 Set 都是一等资源，但粒度不同：

- `Shard` 是慢变量，表示一组 MySQL/Redis 基础设施池
- `Set` 是快变量，表示一组 new-api runtime
- 一个 `Shard` 可以承载多个 `Set`
- 一个 `Set` 通过 `shardRef` 绑定到一个 `Shard`
- 同一 Shard 内，不同 Set 使用不同 `databaseName` 和 `redisDB`
- `LLMFleet` 保存 Shard、连接池、HA 和调度策略，不再保存动态 Set 大数组
- `velagwset-provisioner` 把容量 request 物化为独立 `VelaGWSet`
- `velagwset-controller` 只负责展开 new-api runtime、Service 和 PDB
- LLMGateway-control 读取 facts 后执行 `RegisterSet + BootstrapSet`
- 本地 `05-shared-infra.yaml` 提供标准本地拓扑：`shard-a` 和 `shard-b`

## VelaGWSet Controller 路径

`VelaGWSet` 是标准单 Set Kubernetes 资源。旧 `LLMFleet.spec.sets[]` 路径只用于兼容已有请求；新容量请求必须声明 `runtime_backend=velagwset`，两条路径不会消费同一请求。

- LLMGateway 容量控制器负责 Set ID、Shard、数据库名和 Redis DB 的持久化分配。
- `velagwset-provisioner` 通过带 epoch、revision、version 和 lease 的内部 API 认领请求，创建运行 Secret、幂等建库 Job 和 `VelaGWSet`。
- `velagwset-controller` 只访问 Kubernetes API，负责 Deployment、Service、PDB 和 status 收敛。
- controller Deployment 不注入 MySQL、Redis、LLMGateway control URL 或内部 token，并且 RBAC 不允许读取 Secret。
- 未携带匹配 CR UID 和不可变身份的 `decommissionApproval` 时，Kubernetes API Server 直接拒绝删除。
- `Observe` 和 `AdoptionPending` 为只读迁移状态，不增加 runtime Finalizer，也不修改现有 workload。

已有共享 MySQL/Redis 夹具后，可运行完整回归：

```bash
k8s/orbstack-kro/e2e/run-velagwset-controller.sh
```

脚本会自动构建轻量 controller 镜像，安装 CRD/删除策略，创建真实 new-api admin 与两副本 traffic，并验证 Ready、稳定 reconcile、Service 自愈、两副本 leader 接管、未批准删除拒绝和批准删除清理。测试脚本会创建数据库作为夹具，但 controller 本身不会连接数据库或 Redis。

验证从容量意图到自动纳管的标准路径：

```bash
k8s/orbstack-kro/e2e/run-velagwset-provisioner.sh
```

该脚本使用空 `fleet-native.spec.sets` 创建一条真实容量请求，验证请求认领、数据库初始化、admin-only bootstrap、worker 配置、traffic 两副本启用、PDB 健康和最终 `managed`。脚本只按本次 request ID 判定结果，任何超时、CR 缺失或 `Ready` 未通过都会硬失败。

每个 Set 会展开成两组内部入口：

- `<fleet>-<set>-newapi-admin`：管理入口，只选择单个 master。LLMGateway-control 纳管、bootstrap、渠道同步都访问这个 Service。
- `<fleet>-<set>-newapi-traffic`：模型流量入口，只选择 traffic slave；`set.replicas` 就是推理副本数。admin master 不承载模型流量，LLMGateway-traffic 的 Redis route snapshot 指向这个 Service。

标准本地拓扑是 2 个 shard、4 个 set：

```text
shard-a
  set-a -> newapi_set_a, Redis DB 1
  set-b -> newapi_set_b, Redis DB 2

shard-b
  set-c -> newapi_set_c, Redis DB 1
  set-d -> newapi_set_d, Redis DB 2
```

## 前置条件

```bash
kubectl config current-context
helm version
```

本地期望使用 OrbStack Kubernetes。kro 安装命令：

```bash
helm upgrade --install kro oci://registry.k8s.io/kro/charts/kro \
  --version 0.9.2 \
  --namespace kro \
  --create-namespace \
  --wait \
  --timeout 5m
```

本地还需要先构建 control 镜像，OrbStack Kubernetes 可以直接使用本机 Docker 镜像：

```bash
docker build -t llmgateway:local .
```

## 创建本地 2 shard / 4 Set Fleet

```bash
kubectl apply -f k8s/orbstack-kro/00-namespace.yaml
kubectl apply -f k8s/orbstack-kro/05-shared-infra.yaml
kubectl apply -f k8s/orbstack-kro/06-llmgateway-control.yaml
kubectl apply -f k8s/orbstack-kro/07-llmgateway-traffic.yaml
kubectl apply -f k8s/orbstack-kro/08-llmgateway-worker.yaml
kubectl rollout status deployment/shared-mysql-a -n llmgateway-kro-demo --timeout=180s
kubectl rollout status deployment/shared-redis-a -n llmgateway-kro-demo --timeout=60s
kubectl rollout status deployment/shared-mysql-b -n llmgateway-kro-demo --timeout=180s
kubectl rollout status deployment/shared-redis-b -n llmgateway-kro-demo --timeout=60s
kubectl rollout status deployment/llmgateway-mysql -n llmgateway-kro-demo --timeout=180s
kubectl rollout status deployment/llmgateway-control -n llmgateway-kro-demo --timeout=120s
kubectl rollout status deployment/llmgateway-traffic -n llmgateway-kro-demo --timeout=120s
kubectl apply -f k8s/orbstack-kro/30-llmfleet-rgd.yaml
kubectl wait --for=condition=Ready rgd/llmfleets.llmgateway.io --timeout=120s
kubectl apply -f k8s/orbstack-kro/40-fleet.yaml
kubectl apply -f k8s/orbstack-kro/50-set-manager.yaml
kubectl get llmfleets.llmgateway.io -n llmgateway-kro-demo
kubectl get deploy,svc,pod -n llmgateway-kro-demo -l llmgateway.io/fleet=fleet-demo
```

`06-llmgateway-control.yaml` 和 `07-llmgateway-traffic.yaml` 故意拆成两个 Deployment：

- `llmgateway-control` 只提供管理面、纳管、facts/request 消费。
- `llmgateway-traffic` 只提供 `/v1/*` 数据面，默认 2 副本。
- `llmgateway-traffic` 只读取 Redis 的 key route 和 Set runtime route，不连接 LLMGateway MySQL。
- `llmgateway-worker-*` 分别处理核心任务、BYOK、观测和 durable outbox/删除维护。

`50-set-manager.yaml` 是旧 `LLMFleet.spec.sets[]` 路径的兼容胶水层：

1. 读取 pending `set_provision_requests`，把 admin 和 generation 1 traffic runtime patch 到 Fleet；新 Set 不创建 legacy traffic。
2. 把 Fleet 当前 Set 写入 reconcile facts；control 完成 bootstrap、配置同步和预检后写 `configured`，但 admission 保持 pending。
3. 读取 configured request，把 slave 扩到目标副本数；Fleet Ready 后写 `managed`。
4. admission worker 对 managed Set 做最终检查，通过后才允许用户分配和模型流量。
5. 每个步骤都以数据库状态为断点；重复执行不会重复创建 Set、渠道或 Plan。

它是一个 CronJob，默认每分钟跑一次。想立刻触发一轮：

```bash
kubectl create job llmgateway-set-manager-once \
  -n llmgateway-kro-demo \
  --from=cronjob/llmgateway-set-manager

kubectl logs -n llmgateway-kro-demo job/llmgateway-set-manager-once
```

## 本机访问 new-api

```bash
kubectl port-forward -n llmgateway-kro-demo svc/fleet-demo-set-a-newapi-admin 13082:3000
curl http://127.0.0.1:13082/api/status
```

## 本机访问 LLMGateway-control

```bash
kubectl port-forward -n llmgateway-kro-demo svc/llmgateway-control 18081:18080
curl http://127.0.0.1:18081/readyz
curl 'http://127.0.0.1:18081/api/admin/set-reconcile-facts?source=kro&namespace=llmgateway-kro-demo&fleet=fleet-demo' \
  -H 'Authorization: Bearer dev-cluster-token'
```

## 本机访问 LLMGateway-traffic

```bash
kubectl port-forward -n llmgateway-kro-demo svc/llmgateway-traffic 18082:18080
curl http://127.0.0.1:18082/readyz
```

## K8s 完整链路 e2e

`e2e/` 目录提供一条可重复运行的集群级冒烟测试：

- `00-mock-openai.yaml` 使用开源 `kagent-dev/mockllm` 提供 OpenAI-compatible `/v1/chat/completions`。
- `10-traffic-e2e-job.yaml` 使用 Go runner 编排测试流程。
- `run.sh` 负责部署 mock、重建 Job、等待完成并打印结果。

运行：

```bash
k8s/orbstack-kro/e2e/run.sh
```

这条测试会在 control 里保存渠道包、同步到所有已纳管 Set、创建租户和外部 key、给上游 new-api 用户加测试额度，然后通过 `llmgateway-traffic` 调用 `/v1/chat/completions`。返回内容里包含 `llmgateway k8s e2e` 时，说明“Set 纳管 + 渠道同步 + 流量路由 + new-api relay”完整闭环是通的。

从空 namespace 验证本地环境：

```bash
k8s/orbstack-kro/e2e/run-fresh.sh
```

这会删除并重建 `llmgateway-kro-demo` namespace、重建 `llmgateway:local` 镜像、部署 2 shard / 4 Set、触发 set-manager 纳管，然后执行完整链路 e2e。

验证 Set 内蓝绿升级：

```bash
k8s/orbstack-kro/e2e/run-upgrade.sh
```

脚本会先建立完整流量闭环，再对 `set-a` 执行 admin master Recreate、旧 traffic 兼容探针和 Green 切流。它还会在 admin 暂停窗口签发一条密钥命令，验证 `202` 排队、独立 admin worker 恢复、Redis revision 路由、旧 traffic 排空，以及切流后的普通和 SSE 请求。数据库兼容性在发布前回归环境验证，生产控制环不创建临时数据库。

验证自动扩容闭环：

```bash
k8s/orbstack-kro/e2e/run-autoscale.sh
```

这会先跑基础 traffic e2e，再用唯一 Set 前缀写入一条低水位扩容请求，触发 set-manager 把 request 采纳进 `LLMFleet`，等待新 Set 在 control 里 `setup=true`，最后要求 traffic e2e 的同步目标包含这个新 Set。这个脚本会覆盖 `redis_db_start/redis_db_limit` 的安全分配路径。

## 自动纳管触发

推荐把 kro 生成 Set runtime 和 LLMGateway 纳管拆成两段，中间只通过 facts/request 表交接：

1. kro 展开 Deployment/Service。
2. set-manager 观测 `LLMFleet.spec.sets`，调用 LLMGateway-control 只写入 Set reconcile fact。
3. LLMGateway-control 读取 pending fact，执行幂等纳管：注册 Set、初始化 root、确认合规、切新版前端、开启 2FA、保存 admin token。

写入 facts 的 API：

```bash
curl -X POST http://127.0.0.1:18081/api/admin/set-reconcile-facts \
  -H 'Authorization: Bearer cluster-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "kro",
    "namespace": "llmgateway-kro-demo",
    "fleet": "fleet-demo",
    "sets": [
      {
        "set_id": "set-a",
        "name": "Set A",
        "base_url": "http://fleet-demo-set-a-newapi-admin:3000",
        "traffic_base_url": "http://fleet-demo-set-a-newapi-traffic:3000",
        "shard_ref": "shard-a"
      }
    ]
  }'
```

消费 pending facts：

```bash
curl -X POST http://127.0.0.1:18081/api/admin/set-reconcile-facts/reconcile \
  -H 'Authorization: Bearer cluster-token' \
  -H 'Content-Type: application/json' \
  -d '{"source":"kro","namespace":"llmgateway-kro-demo","fleet":"fleet-demo","limit":20}'
```

查看事实状态：

```bash
curl 'http://127.0.0.1:18081/api/admin/set-reconcile-facts?source=kro&namespace=llmgateway-kro-demo&fleet=fleet-demo' \
  -H 'Authorization: Bearer cluster-token'
```

这个 API 的关键约束是：写 facts 不会直接创建或 bootstrap Set。它只把“某个 Fleet 观测到某个 Set 应存在”落到 LLMGateway MySQL；真正纳管由 reconcile 消费 pending facts 完成。

## 用户水位扩 Set

容量控制器只看 LLMGateway 自己的库存：

- ready Set：`active + setup + admin token`。
- 用户数：`llmgateway_user_bindings` 按 `set_id` 聚合。
- 在途容量：`pending/provisioning/created/configured` 的 Set provision request。
- 单 Set 用户上限和水位可调：`LLMGATEWAY_SET_AUTOSCALER_MAX_USERS_PER_SET`、`LLMGATEWAY_SET_AUTOSCALER_TARGET_UTILIZATION`、`LLMGATEWAY_SET_AUTOSCALER_MIN_READY_FREE_USERS`。

当 ready free users 低于水位时，LLMGateway 只写入扩容意图，不直接创建 new-api：

```bash
curl -X POST http://127.0.0.1:18081/api/admin/set-capacity/reconcile \
  -H 'Authorization: Bearer cluster-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "kro",
    "namespace": "llmgateway-kro-demo",
    "fleet": "fleet-demo",
    "shard_refs": ["shard-a", "shard-b"],
    "max_users_per_set": 10000,
    "target_utilization": 0.70,
    "min_ready_free_users": 3000,
    "max_scale_up_per_cycle": 1,
    "set_id_prefix": "set-auto",
    "redis_db_start": 10,
    "redis_db_limit": 16
  }'
```

`redis_db_start` 和 `redis_db_limit` 控制自动 Set 的 Redis DB 分配范围，范围是 `[redis_db_start, redis_db_limit)`。分配器按 `shard_ref` 独立计算空闲 DB，同一个 DB 编号可以在不同 shard 上复用；最终互斥由 MySQL 的 runtime lease 唯一索引兜底。本地 Redis 默认常见只有 DB 0-15，所以本地模板默认上限仍是 `16`；生产模板默认使用 `0..255`，也就是 `redis_db_start=0, redis_db_limit=256`。autoscaler 通过 `LLMGATEWAY_SET_AUTOSCALER_REDIS_DB_START` 和 `LLMGATEWAY_SET_AUTOSCALER_REDIS_DB_LIMIT` 变量化，autoscale e2e 也可用 `LLMGATEWAY_K8S_AUTOSCALE_REDIS_DB_START` 和 `LLMGATEWAY_K8S_AUTOSCALE_REDIS_DB_LIMIT` 覆盖。

生产不能假设 Redis 一定有 16 个 DB。如果云 Redis 代理只开放 DB 0，应配置 `redis_db_start=0, redis_db_limit=1`；如果多个 Set 共享同一个 Redis endpoint 但不能用 DB 隔离，应优先拆成多个 shard 或确认 new-api 支持可靠的 key prefix 隔离后再上线。

托管模式下，每个 new-api Set 都应关闭内置全局 API/Web 限流：`GLOBAL_API_RATE_LIMIT_ENABLE=false`、`GLOBAL_WEB_RATE_LIMIT_ENABLE=false`。这些 Set 只被 LLMGateway control/worker 和 traffic 访问，准入、鉴权、运营限流应放在 LLMGateway 或外层网关；否则批量纳管、订阅发放、BYOK 同步会被 new-api 自己的 `/api` 全局限流误伤。

set-manager 可以读取 pending request：

```bash
curl 'http://127.0.0.1:18081/api/admin/set-provision-requests?source=kro&namespace=llmgateway-kro-demo&fleet=fleet-demo&status=pending' \
  -H 'Authorization: Bearer cluster-token'
```

创建 runtime 后回写状态：

```bash
curl -X POST 'http://127.0.0.1:18081/api/admin/set-provision-requests/kro:llmgateway-kro-demo:fleet-demo:set-auto-000001/status' \
  -H 'Authorization: Bearer cluster-token' \
  -H 'Content-Type: application/json' \
  -d '{"status":"created"}'
```

`50-set-manager.yaml` 已经把上面三步串起来：触发容量 reconcile、读取 pending request、patch `LLMFleet.spec.sets`、写 facts、触发 facts reconcile。P0 不自动缩容，也不搬迁已有用户。

`examples/fleet-demo-fact-writer.yaml` 和 `examples/set-capacity-reconciler.yaml` 现在只作为调试样例：

- `Job/fleet-demo-set-fact-writer` 只写入 4 个 Set facts。
- `CronJob/llmgateway-set-fact-reconciler` 每分钟触发一次 reconcile API，让 llmgateway-control 消费 pending facts。
- `CronJob/llmgateway-set-capacity-reconciler` 只产生 provision request，不负责 patch Fleet。

## 清理

```bash
kubectl delete -f k8s/orbstack-kro/50-set-manager.yaml --ignore-not-found
kubectl delete -f k8s/orbstack-kro/40-fleet.yaml --ignore-not-found
kubectl delete -f k8s/orbstack-kro/30-llmfleet-rgd.yaml --ignore-not-found
kubectl delete -f k8s/orbstack-kro/07-llmgateway-traffic.yaml --ignore-not-found
kubectl delete -f k8s/orbstack-kro/08-llmgateway-worker.yaml --ignore-not-found
kubectl delete -f k8s/orbstack-kro/06-llmgateway-control.yaml --ignore-not-found
kubectl delete -f k8s/orbstack-kro/05-shared-infra.yaml --ignore-not-found
kubectl delete -f k8s/orbstack-kro/00-namespace.yaml --ignore-not-found
```

生产化还需要把明文密码改成 Secret/ExternalSecret，并把 shard 里的 `mysqlHost/redisHost` 指向腾讯云 MySQL、TDSQL 或 Redis 代理 endpoint。多个 MySQL/Redis 实例就是多个 shard，不需要改 Set 的核心模型。

## Shard 和 Set 配置

`40-fleet.yaml` 里先声明 shard，再声明 set 绑定到 shard：

```yaml
shards:
  - name: shard-a
    mysqlHost: shared-mysql-a
    mysqlPort: "3306"
    mysqlUser: root
    mysqlPassword: "123456"
    redisHost: shared-redis-a
    redisPort: "6379"
    redisPassword: "123456"
  - name: shard-b
    mysqlHost: shared-mysql-b
    mysqlPort: "3306"
    mysqlUser: root
    mysqlPassword: "123456"
    redisHost: shared-redis-b
    redisPort: "6379"
    redisPassword: "123456"

sets:
  - name: set-a
    shardRef: shard-a
    replicas: 1
    databaseName: newapi_set_a
    redisDB: "1"
    sessionSecret: llmgateway-kro-fleet-set-a-session-secret
```

`10-llmset-rgd.yaml` 和 `20-set-a.yaml` 是早期 all-in-one 烟测样例，会给单个 Set 附带创建 MySQL/Redis。它们可以用来理解 kro 图展开，不代表 P0 生产模型。

`30-llmfleet-rgd.yaml` 会在每个 new-api Pod 启动前用 initContainer 幂等创建 `${set.databaseName}`。这让动态扩出来的 `set-auto-*` 不需要提前人工建库；多个 MySQL/Redis 实例仍然通过多个 shard 表达。
