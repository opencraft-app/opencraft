# CVM Mock Resource Pool

> AI/自动化协作指引：见根目录 `AGENTS.md`（Copilot 兼容版位于 `.github/copilot-instructions.md`）。

面向“预建库存 + 状态机驱动”的云主机池系统。提前创建一批 CVM，库存中的主机处于 `CLEAN` 状态；业务请求仅在库存中分配与回收，不在请求路径创建或重装。回收后由后台 Worker 异步重装，再次回到库存。

## 快速启动（Docker Compose）
提供 gin API（对齐 openapi sandboxes）与后台 Worker 的组合，默认 Mock Provider：
```bash
mkdir -p .secret/sandbox
cp sandbox/secret-templates/local.env.example \
  .secret/sandbox/local.env

./sandbox/scripts/dev-compose.sh up --build
# API:  http://localhost:8080
# MySQL/Redis credentials come from .secret/sandbox/local.env
```
如需腾讯云，在 compose 覆盖 `CLOUD_PROVIDER=tencent` 并填充 `TENCENT_*` 环境变量。

## 体系与状态机
- **状态机**：`CREATING → CLEAN → ALLOCATED → DRY → RESETTING → CLEAN`，失败/销毁流转：`CREATING → FAILED → DELETED`，缩容销毁时会经过 `DELETING → DELETED`。
  - 用户分配：`CLEAN → ALLOCATED`
  - 用户释放：`ALLOCATED → DRY`（请求路径不做重装）
  - 后台重装：`DRY → RESETTING → CLEAN`
- **组件**
  - API / 控制面（本项目）：暴露池管理、分配、释放、状态推进接口。
  - PoolManager：面向业务的调度/策略层，调用 API。
  - 库存数据库：`pools` / `instances` 表记录状态，驱动 Worker。
  - Worker：`Refill` 负责补货（创建实例至 `CLEAN`），`Reinstall` 负责将 `DRY` 的实例重装回 `CLEAN`。
  - CVM Provider：封装云厂商 API，隐藏镜像/网络等细节。

## 项目结构
- `cmd/server/main.go`：HTTP 入口。
- `internal/api/router.go`：路由与 HTTP 处理。
- `internal/core/types.go`：状态机常量与领域模型。
- `internal/store/memory.go`：内存版库存实现（可替换为 MySQL）。
- `internal/store/mysql.go`：MySQL 实现，支持多实例并发。
- `internal/provider/`：云厂商 Adapter（当前为 Mock）。
- `internal/service/pool.go`：业务层，封装状态校验与转移。
- `cmd/refill`：补货 Worker。
- `cmd/worker`：组合 Worker（补货/重装/清理/水位）。

## API 概览（示例）
- `POST /pools`：创建池（运营侧）。
  - Body: `{"name":"pool-a","description":"demo","base_image":"img-xxxx","security_groups":["sg-xxx","sg-yyy"],"desired_capacity":5}`
  - `desired_capacity` 表示池子的总目标 `CLEAN` 库存；如果启用了 worker 分片，worker 会把这个总量自动拆到各个 shard。
  - `base_image` 建议使用真实镜像 ID（如 `img-xxxx`），创建/重装均按池的 `base_image`。
- `GET /pools`：列出池。
- `PATCH /pools/{poolID}`：更新池配置（运营侧）。
  - `system_disk_size` 单位为 GB，只影响之后创建的实例；现有实例需要受控销毁重建，标记为 `DRY` 只会触发重装，不能扩容系统盘。
  - 这些接口保留为服务内部能力说明，不再作为测试环境 pool 镜像 rollout 入口。
  - 当前测试环境切镜像统一走 [../docs/agent-guides/sandbox-image-rollout-guide.md](../docs/agent-guides/sandbox-image-rollout-guide.md) 里的旁路 pod 脚本。
  - rollout 语义仍然是：只更新目标 pool 的 `base_image`，并只把 `CLEAN` 实例标成 `DRY`；`ALLOCATED` 不受影响。
- `POST /pools/{poolID}/inventory`：补货 N 台，进入 `CLEAN`（模拟 `Refill`）。
  - Body: `{"count":2}` 或 `{"addresses":["ip1","ip2"]}` 或 `{"cloud_ids":["c1","c2"]}`。传入 `addresses` 或 `cloud_ids` 时数量由数组长度决定，`count` 被忽略；未提供地址时按 `count` 生成内网地址。
- `GET /pools/{poolID}/instances`：查看池内实例与状态。
- `POST /pools/{poolID}/allocate`：业务分配一台 `CLEAN` 主机，状态改为 `ALLOCATED`。
- `POST /instances/{id}/release`：业务释放实例，改为 `DRY`。
- `PATCH /instances/{id}/state`：Worker 推进状态（`DRY→RESETTING→CLEAN` 或 `CREATING→CLEAN`）。

所有接口返回 JSON，失败返回 `{"error": "..."}`

### SKU 与系统盘规格

- `SKU.system_disk_size` 是动态 pool 的系统盘规格真源，未填写时归一为 50GB。
- `000008` migration 会将已有 `openclaw-4c8g80g` SKU 回填为 80GB。
- 从 capacity bundle 派生的 pool，以及通过绑定 SKU 创建的运营 pool，都会继承该值。
- `Pool.system_disk_size` 只影响后续创建的实例，不会在线扩容已有云盘。
- 修正规格时先更新 SKU，防止后续动态 pool 再次使用旧值；再 PATCH 已存在的 pool，并单独受控退役旧规格实例。

## 运行与开发
```bash
go run ./cmd/server
# 端口默认 :8080
```

正式 K8s 发布已经改为 `Argo CD` 主线。  
`sandbox` 服务目录不再承担正式 `apply / release`。

默认 pools 不再通过 K8s 发布链自动 seed。需要初始化或修正默认 pool 配置时，统一走：

```bash
source deploy/envs/beijing-sandbox/platform.env
ENV=beijing-sandbox bash sandbox/scripts/sync-default-pools.sh --base-image img-xxxx
```

默认 pool 的显式清单位于 [config/default-pools.tsv](config/default-pools.tsv)。

### 切换 MySQL 存储
`sandbox` 优先读取显式 `MYSQL_DSN`；若未提供，也支持从拆分变量自动拼装：

- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_DB`
- `MYSQL_USER`
- `MYSQL_PASSWORD`

本地手工运行时仍建议先执行 migration：

```bash
cd sandbox
make migrate-up DB_DSN="mysql://user:pass@tcp(127.0.0.1:3306)/cvm_pool?multiStatements=true"
```

常用命令：

```bash
cd sandbox
make migrate-version DB_DSN="mysql://user:pass@tcp(127.0.0.1:3306)/cvm_pool?multiStatements=true"
make migrate-down DB_DSN="mysql://user:pass@tcp(127.0.0.1:3306)/cvm_pool?multiStatements=true"
```

迁移文件位于 `sandbox/migrations/`，当前初始 schema 在 `000001_init_schema.*.sql`，增量迁移按编号顺序执行。

K8s 发布路径与本地不同：

- 这类运行时值现在应由 GitOps secret / deploy-facing 组合层承担
- `sandbox-api`、`sandbox-worker`、`refill` 会在运行时自动拼装 DSN
- `sandbox-db-migrate-v1` 会应用 `sandbox/migrations/000001_init_schema.up.sql`
- `sandbox-api`、`sandbox-worker`、`sandbox-worker-sharded` 都会在 initContainer 里等待 schema ready，再启动主容器
- `ClaimCleanInstance` 使用 `SELECT ... FOR UPDATE` + 状态更新，确保多实例并发分配时不会拿到同一台。
- `UpdateInstanceState` 依赖 `expected_state` 做条件更新，避免状态被并发覆盖。***

## Worker 说明
- Refill Worker：`go run ./cmd/refill -pool <POOL_ID> -count 2`，使用 CloudProvider 创建实例并将 `cloud_id/address` 记录到 DB，状态直接入库 `CLEAN`。
- Reset Loop（用组合 Worker 启动）：`go run ./cmd/worker -refill-count -1 -waterline-interval 0 -cleanup-interval 0 -reset-pool <POOL_ID> -reset-concurrency 10`，默认循环扫描 `DRY` 实例，推进 `RESETTING→CLEAN`，中间调用 CloudProvider 的重装接口。***
- 组合 Worker：`go run ./cmd/worker -refill-pool <POOL_ID> -refill-count 5 -refill-interval 1m -reset-pool <POOL_ID> -reset-concurrency 10 -cleanup-interval 5m`，同一进程内分别跑补货与重装循环，并定期清理 `FAILED`；任一功能传入 0 或缺省参数即可禁用。省略 `-refill-pool` 时会对所有池补货；当 `-refill-count`<=0 时采用池的 `desired_capacity` 自动伸缩（按池总目标 `CLEAN` 库存计算，worker 若启用分片会先把总量拆成当前 shard 的目标，再按 `CLEAN+in-flight` 计算缺口补货，超出会回收多余的 `CLEAN` 实例）。
  - Refill 流程：先插入 `CREATING`，成功后转 `CLEAN`；创建失败会记录 `FAILED`（含 cloud_id/address，便于后续清理）。

## 架构示意（本项目对应）
```mermaid
flowchart TB
  subgraph API["API Server\n(allocate / release / state)"]
  end
  subgraph DB["MySQL\npools / instances"]
  end
  subgraph Workers["Worker 进程（单进程双循环）"]
    RF["Refill Loop\nCREATING→CLEAN / FAILED"]
    RS["Reset Loop\nDRY→RESETTING→CLEAN"]
  end
  subgraph Provider["Cloud Provider\nMock / Tencent CVM"]
  end
  API -->|List/Allocate/Release| DB
  Workers -->|读写实例状态| DB
  RF -->|CreateInstance| Provider
  RS -->|Reinstall/Reboot| Provider
  DB -->|CLEAN 库存| API
  API -->|业务分配| API

  %% State machine note
  classDef state fill:#eef,stroke:#999,stroke-width:1px;
```
### 选择云后端
- 默认：Mock（本地演示）。
  - 腾讯云：设置 `CLOUD_PROVIDER=tencent` 并提供以下环境变量：
    - `TENCENT_SECRET_ID`, `TENCENT_SECRET_KEY`
    - `TENCENT_REGION`, `TENCENT_ZONE`
    - `TENCENT_INSTANCE_TYPE`
    - `TENCENT_VPC_ID`, `TENCENT_SUBNET_ID`
    - 二选一：`TENCENT_INSTANCE_PASSWORD` 或 `TENCENT_KEY_PAIR_ID`
    - 可选：`TENCENT_ADDRESS_TYPE`（`private` 默认 / `public`），控制创建后返回的地址类型，默认走内网地址。
    - 可选：`TENCENT_KEY_PAIR_ID`
  例：先 `source .secret/sandbox/local.env`，再执行 `CLOUD_PROVIDER=tencent TENCENT_REGION=ap-shanghai TENCENT_ZONE=ap-shanghai-2 TENCENT_INSTANCE_TYPE=S5.MEDIUM4 TENCENT_VPC_ID=vpc-xxx TENCENT_SUBNET_ID=subnet-xxx go run ./cmd/refill -pool <POOL_ID> -count 1`
  - 池的 `base_image` 必须是镜像 ID（`img-...`），创建/重装均按池配置执行；`TENCENT_IMAGE_ID` 不再使用。
  - pool 必须显式提供 `security_groups`；腾讯云 provider 不再从全局运行时环境变量回退安全组。
  - 创建逻辑会根据 `TENCENT_ADDRESS_TYPE` 选择等待公网或内网 IP（默认内网），等待最长 180s，否则标记为 `FAILED`。
  - 清理逻辑在 TERMINATE 后轮询确认，最多等待 60s。

## 组件协同与运行方式
1. 先 `source .secret/sandbox/local.env`
2. 启动 API（控制面）：`MYSQL_DSN="$MYSQL_DSN" PORT=8080 go run ./cmd/server`
2. 运营侧创建池：`curl -X POST http://localhost:8080/pools -d '{"name":"pool-a"}'`
3. 启动补货 Worker：`MYSQL_DSN="$MYSQL_DSN" go run ./cmd/refill -pool <POOL_ID> -count 5`
   - Worker 调用云厂商创建实例，写入 `instances` 表为 `CLEAN`。
4. 业务分配/释放（请求路径仅做状态切换，不做创建/重装）：
   - 分配：`POST /pools/{poolID}/allocate`，从池中原子挑一台 `CLEAN` → `ALLOCATED`，返回实例信息（含 cloud_id/address）。
   - 释放：`POST /instances/{id}/release`，校验当前为 `ALLOCATED`，改为 `DRY`；不会同步重装，由 Reset Worker 异步处理。

   示例 curl：
   ```bash
   # 分配：CLEAN -> ALLOCATED
   curl -s -X POST http://localhost:8080/pools/$POOL_ID/allocate | jq .

   # 释放：ALLOCATED -> DRY（先用上一步返回的 id 赋值 INSTANCE_ID）
   curl -s -X POST http://localhost:8080/instances/$INSTANCE_ID/release | jq .
   ```
5. 启动重装 Loop（组合 Worker）：`MYSQL_DSN="$MYSQL_DSN" go run ./cmd/worker -refill-count -1 -waterline-interval 0 -cleanup-interval 0 -reset-pool <POOL_ID>`
   - Worker 找到 `DRY`，推进 `RESETTING→CLEAN`，重装结束后回到库存；`-interval 0` 仅执行一轮。

两个进程（API、Worker）共享同一 MySQL，使多实例并发时库存状态一致。***

## 设计要点
- 请求路径**不做创建/重装**，仅做分配与释放。
- 状态变更由业务层统一校验，所有数据以状态机为核心。
- 默认池和自定义 pool 都必须按 pool 维度维护 `security_groups`；不要再依赖单个全局 sandbox 安全组。
- 内存存储便于演示，实际落地可替换为 MySQL + 行级锁/乐观锁。***

## Ingressproxy（两级代理）
- 运行时代理统一由 `ingressproxy` 承担：
  - `cmd/ingressproxy-router`：第一层入口，只解析 `sandboxID` 或 `ip-backdoor`，按 `crc32(key) % N` 选择 shard。
  - `cmd/ingressproxy-shard`：第二层代理，真正读取 Redis 路由并转发到 sandbox 实例。
- 第一层不会直接查询实例地址，只会把请求转发到：
  - `ingressproxy-g0.sandbox.svc.cluster.local`
  - `ingressproxy-g1.sandbox.svc.cluster.local`
  - `ingressproxy-g2.sandbox.svc.cluster.local`
  - `ingressproxy-g3.sandbox.svc.cluster.local`
- 第二层当前复用已有 Redis 结构：
  - `route:sandbox:<sandboxID> -> address`
- 基础清单见 [k8s/base/ingressproxy-manifests.yaml](k8s/base/ingressproxy-manifests.yaml)。
- 北京集群的公网入口使用 qcloud `Ingress + TkeServiceConfig` 形态承接 `*.sandbox.lightclaw.tech`，对应 TLS secret 在 [k8s/overlays/beijing-sandbox/tls-secrets.yaml](k8s/overlays/beijing-sandbox/tls-secrets.yaml)。
- 公网 wildcard 接入时，不再使用 `ingressproxy-router` 的 `LoadBalancer` Service 直出；标准形态是：
  - `ingressproxy-router`：`ClusterIP`
  - `ingressproxy-router-ingress`：`NodePort`
  - qcloud `Ingress + TkeServiceConfig`：承接 `*.sandbox.<domain>`
- `ingressproxy-router/shard` 的 `/health` 现在对 `Host` 无要求，专门用于 CLB 健康检查；不要把健康检查再改回业务 host 解析链。




## 创建沙箱

* 从池子中拿到一个已经创建好的机器。
* 可显式指定 `templateID/pool`；如果不传，控制面会在可用池里随机重试分配。
* 创建时会把执行地域持久化到 `sandboxes.region`。
* TAT command / session 只读取 `sandbox.region`，不再在运行时从 `pool.zone` 反推 region。
* 老 sandbox 若没有 `region`，TAT / session 会显式返回 `sandbox region missing`。

## 销毁沙箱

* 退换机器到池子


```
flowchart LR
    subgraph biz[业务 / e2b 调用方]
        B1[PoolManager / e2b Runtime]
        B2[业务服务/流水线]
    end

    subgraph ctrl[控制面 API<br/>cmd/server]
        API[HTTP API\n/pools /allocate /release /state]
    end

    subgraph store[库存存储]
        DB[(MySQL / 内存)]
    end

    subgraph workers[后台 Worker]
        R1[Refill\n预创建 CVM → CLEAN]
        R2[Reset\nDRY → RESETTING → CLEAN]
    end

    subgraph cloud[CloudProvider 封装]
        P1[Mock Provider]
        P2[Tencent Provider\nResetInstance / RunInstances]
        CVM[CVM 预创建池]
    end

    B1 -->|分配/释放| API
    B2 -->|调用 API| API

    API -->|读写状态机| DB

    R1 -->|查询补货需求| DB
    R1 -->|RunInstances| P2
    R1 -->|写入 CLEAN 实例| DB

    R2 -->|扫 DRY| DB
    R2 -->|ResetInstance(可带镜像)| P2
    R2 -->|更新状态| DB

    P1 -. 可替换 .-> API
    P2 -->|创建/重装| CVM

    DB <--> API
```



## 敏感配置约定

- 本地真实值统一维护在 `.secret/sandbox/local.env`（相对仓库根目录）
- 测试环境真实值统一维护在 `.secret/sandbox/test.env`（相对仓库根目录）
- 仓库内只保留 `sandbox/secret-templates/*.example`
- 不再在 README、脚本示例或排障笔记里保留任何真实 Redis/MySQL/Tencent 凭据

如果需要线上联调，请先找团队拿 `.secret/sandbox/test.env`，然后通过 `kubectl port-forward` 访问服务，不要把线上地址、账号或密码写回仓库。
