---
title: 'CTL 测试环境 K8s 云原生部署'
slug: 'ctl-test-env-k8s-deploy'
created: '2026-03-23'
status: 'completed'
stepsCompleted: [1, 2, 3, 4]
tech_stack:
  - OpenTofu (Terraform) >= 1.6.0
  - Kubernetes (TKE v1.30.0)
  - Go (CTL 应用, golang-migrate)
  - TOML (BurntSushi, 两层配置覆盖)
  - CynosDB MySQL 8.0
  - 腾讯云 Redis (标准版)
  - Prometheus + ServiceMonitor (coreos)
  - Docker (自建 base image 推送到 ccr)
files_to_modify:
  - ctl/Dockerfile (修改: BASE_IMAGE 默认值改为 ccr)
  - ctl/Dockerfile.base (参考: 构建 ctl-base 镜像)
  - infra/tencentcloud/beijing-sandbox/redis/ctl-mq/main.tf (新建)
  - infra/tencentcloud/beijing-sandbox/redis/ctl-mq/variables.tf (新建)
  - infra/tencentcloud/beijing-sandbox/redis/ctl-mq/terraform.tfvars (新建)
  - infra/tencentcloud/beijing-sandbox/redis/ctl-mq/secrets.auto.tfvars.example (新建)
  - infra/tencentcloud/beijing-sandbox/redis/ctl-mq/README.md (新建)
  - ctl/conf/test/common/server_conf.toml (新建)
  - ctl/conf/test/rewrite/server_conf_rewrite.toml (新建)
  - ctl/k8s/manifests.yaml (新建)
  - ctl/Makefile (修改: 新增测试环境 target)
code_patterns:
  - OpenTofu 模块结构: main.tf + variables.tf + terraform.tfvars + secrets.auto.tfvars.example + README.md
  - K8s 清单风格: 参照 sandbox/k8s/manifests.yaml 的单文件多资源模式
  - CTL 配置加载: config.Init(confDir) → parseConfFile(confDir+"/common/server_conf.toml") → parseConfFile(confDir+"/rewrite/server_conf_rewrite.toml"), rewrite 文件必须存在
  - CTL 二进制命名: bin/api, bin/service, bin/bypass, 唯一启动 flag -conf-dir
  - Health check: GET /health on API port 9590, 返回 {"status":"ok"} HTTP 200
  - Metrics: 独立 HTTP 服务器, /metrics path, api=9591 service=9592 bypass=9593
  - ConfigMap 挂载 TOML 文件到 Pod, 需要 common/ 和 rewrite/ 两个子目录
  - ServiceMonitor 部署到 kube-system namespace, label metrics-target="true"
  - Dockerfile 无 CMD/ENTRYPOINT, 需在 K8s command 中显式指定
test_patterns:
  - golang-migrate SQL 文件在 ctl/migrations/, 7 个 migration 版本
  - 密码加密: go test -v -test.run=TestCipherEncrypt ./pkg/util/ -args <password>
---

# Tech-Spec: CTL 测试环境 K8s 云原生部署

**Created:** 2026-03-23

> 历史说明：
> 本文档保留方案设计背景，但其中出现的集群 ID、实例 ID、数据库地址等环境值可能已变化。
> 当前真实环境应以现网 K8s 资源、repo 外部 `.secret/` 和最新 deploy guide 为准。

## 架构总览

### 部署架构图

```mermaid
graph TB
    subgraph TKE集群["TKE 集群 (<sandbox-tke-cluster>)"]
        subgraph NS_CTL["Namespace: ctl"]
            API["ctl-api<br/>:9590 HTTP<br/>:9591 Metrics"]
            SVC["ctl-service<br/>:9592 Metrics<br/>(MQ Consumer)"]
            BYP["ctl-bypass<br/>:9593 Metrics<br/>(补偿扫描)"]
            CM_C["ConfigMap<br/>ctl-conf-common"]
            CM_R["ConfigMap<br/>ctl-conf-rewrite"]
            SEC["Repo-external<br/>.secret/ctl/test.env"]
        end
        subgraph NS_SB["Namespace: sandbox"]
            SB_API["sandbox-api<br/>:80"]
        end
        subgraph NS_KS["Namespace: kube-system"]
            PROM["Prometheus"]
            SM["ServiceMonitor<br/>ctl-workloads"]
        end
    end

    CLB["内网 CLB<br/>(LoadBalancer)"]
    CYNOSDB[("CynosDB MySQL<br/><current-host>:3306<br/>db=ctl")]
    REDIS[("Redis 集群版<br/>按量付费<br/>stream_key=ctl")]

    CLB -->|":80 → :9590"| API
    API -->|"HTTP"| SB_API
    API -->|"读写"| CYNOSDB
    API -->|"投递 Stream"| REDIS
    SVC -->|"XREADGROUP"| REDIS
    SVC -->|"读写"| CYNOSDB
    BYP -->|"补偿扫描"| CYNOSDB
    BYP -->|"补投 Stream"| REDIS
    SM -->|"抓取 /metrics"| API
    SM -->|"抓取 /metrics"| SVC
    SM -->|"抓取 /metrics"| BYP
    PROM --> SM

    CM_C -.->|"挂载 TOML"| API
    CM_R -.->|"挂载 TOML"| API
    CM_C -.->|"挂载 TOML"| SVC
    CM_R -.->|"挂载 TOML"| SVC
    CM_C -.->|"挂载 TOML"| BYP
    CM_R -.->|"挂载 TOML"| BYP
    SEC -.->|"envFrom"| API
    SEC -.->|"envFrom"| SVC
    SEC -.->|"envFrom"| BYP
```

### 异步任务流

```mermaid
sequenceDiagram
    participant U as 用户
    participant A as ctl-api
    participant DB as CynosDB
    participant R as Redis Stream<br/>(key=ctl)
    participant S as ctl-service
    participant B as ctl-bypass
    participant SB as sandbox-api

    U->>A: POST /v1/instances
    A->>DB: 写入 tasks 表
    A->>R: XADD ctl {task_msg}
    A-->>U: 202 Accepted

    S->>R: XREADGROUP (阻塞读)
    R-->>S: task_msg
    S->>SB: 创建沙箱
    SB-->>S: sandbox_id
    S->>DB: 更新 instance 状态 → Running

    loop 每轮扫描
        B->>DB: 查询未完成 tasks
        B->>R: 补投遗漏消息
    end
```

### 云资源与 IaC 模块

```mermaid
graph LR
    subgraph INFRA["infra/tencentcloud/beijing-sandbox/"]
        TF_REDIS["redis/ctl-mq/<br/>main.tf<br/>OpenTofu 模块"]
        TF_CYNOSDB["cynosdb/<br/>(已有,复用)"]
        TF_TKE["tke/<br/>(已有,复用)"]
    end

    subgraph CLOUD["腾讯云资源 (全部按量付费)"]
        C_REDIS[("Redis 集群版<br/>1GB 3分片1副本<br/>~¥150-300/月")]
        C_CYNOSDB[("CynosDB MySQL<br/>2核4GB<br/>(已有)")]
        C_TKE["TKE 集群<br/>(已有)"]
        C_CLB["内网 CLB<br/>~¥20/月"]
    end

    TF_REDIS -->|"tofu apply"| C_REDIS
    TF_CYNOSDB -.->|"已管理"| C_CYNOSDB
    TF_TKE -.->|"已管理"| C_TKE
    C_TKE -->|"K8s Service 自动创建"| C_CLB
```

## Overview

### Problem Statement

CTL 服务目前只有 Dockerfile 和本地 docker-compose 开发环境，缺少 K8s 部署清单，无法部署到测试集群。需要一套完整的云原生部署方案，包括云端资源购买（Redis）和 K8s 编排，使 CTL 能与 sandbox 部署到同一个 TKE 集群中。

### Solution

1. **通过 infra OpenTofu 模块购买 CTL 专用 Redis 实例**（用于 MQ Stream），MySQL 复用现有 CynosDB 实例（建库隔离）
2. **编写完整的 K8s 清单**，部署 CTL 的 api / service / bypass 三个 workload 到独立 namespace
3. **Prometheus 监控共用集群已有的 Prometheus**，通过 ServiceMonitor 接入
4. 所有部署脚本落到 `ctl/` 目录，infra 模块落到 `infra/` 目录

### Scope

**In Scope:**
- OpenTofu 模块：CTL 专用 Redis 实例
- K8s Namespace + ConfigMap + Secret
- 3 个 Deployment（api / service / bypass）+ Service + HPA
- ConfigMap 挂载 TOML 配置文件（common + rewrite 覆盖）
- 内网 CLB Service 暴露 api
- ServiceMonitor 接入集群 Prometheus
- DB Migration Makefile target（测试环境用 golang-migrate 手动执行）
- Makefile 新增测试环境相关 target（镜像构建 + migration）
- Base Image 重建并推送到 ccr

**Out of Scope:**
- CI/CD pipeline（GitHub Actions 等）
- Ingress / 域名配置
- Grafana Dashboard 的 K8s 部署
- 生产环境部署配置
- CTL 代码变更

## Context for Development

### Codebase Patterns

1. **infra 模块结构**：每个资源是独立的 OpenTofu 栈，目录结构固定为 `main.tf` + `variables.tf` + `terraform.tfvars` + `secrets.auto.tfvars.example` + `README.md`
2. **K8s 清单风格**：sandbox 采用单个 `manifests.yaml` 包含所有资源（Namespace, ConfigMap, Deployment, Service, HPA, ServiceMonitor）
3. **CTL 配置加载机制**（源码验证）：
   - `config.Init(confDir)` → `parseServerConf(confDir)`
   - 第 1 层：`parseConfFile(confDir + "/common/server_conf.toml")` — 基础配置
   - 第 2 层：`parseConfFile(confDir + "/rewrite/server_conf_rewrite.toml")` — 覆盖配置
   - **两个文件都必须存在**（不是可选的），第 2 层 TOML 会覆盖第 1 层同名字段
   - 后续调用 `parseRedisConf()`、`parseMySQLConf()` 等做密码解密和默认值设置
4. **CTL 三进程模型**：
   - `main/api/main.go` → 编译为 `bin/api`，监听 HTTP 9590 + Metrics 9591
   - `main/service/main.go` → 编译为 `bin/service`，Metrics 9592
   - `main/bypass/main.go` → 编译为 `bin/bypass`，Metrics 9593
   - 唯一必需启动 flag：`-conf-dir`，缺失会报错退出
   - 同一个 Docker 镜像，不同 command 启动不同进程
5. **Health Check**（源码验证）：
   - 路径：`GET /health`，端口：API 9590
   - 响应：`{"status": "ok"}`，HTTP 200
   - 实现在 `main/api/server.go` 第 101-103 行
6. **Metrics 暴露**（源码验证）：
   - 路径：`/metrics`，使用独立 HTTP 服务器（不与 API 端口共用）
   - 实现在 `main/common/common.go:InitMonitor()`，每个进程各自启动
   - 当 `enable_pprof=true` 时同时暴露 `/debug/pprof/*`
7. **Dockerfile 特点**：
   - `Dockerfile` 没有 `CMD`/`ENTRYPOINT`，必须在 K8s Deployment 的 `command` 中显式指定
   - **Base Image 需重建**：原 `mirrors.tencent.com/lighthouse/lightglobal_base_image:latest` 是内部镜像仓库，TKE 节点无法拉取。需基于 `Dockerfile.base`（alpine + tzdata + curl）构建后推送到 `ccr.ccs.tencentyun.com/clawhub/ctl-base:latest`，并修改 `Dockerfile` 的 `BASE_IMAGE` ARG 默认值
   - App Image: COPY `bin/` 和 `i18n/` 到 `/usr/local/lightglobal/`
8. **Migration**：golang-migrate，SQL 文件在 `ctl/migrations/`（当前 7 个版本）。生产环境手动执行 SQL；测试环境通过 Makefile target `make migrate-up-test` 使用 golang-migrate 自动化执行（类似 alembic），无需 K8s Job 自动触发

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `sandbox/k8s/manifests.yaml` | K8s 清单参考模板 |
| `ctl/conf/server/common/server_conf.toml` | CTL 通用配置模板（含全部配置项及注释） |
| `ctl/conf/local/common/server_conf.toml` | CTL 本地配置参考（实际填充值的例子） |
| `ctl/Dockerfile` + `Dockerfile.base` | CTL 镜像构建 |
| `ctl/Makefile` + `tools/build_src.sh` | 构建脚本（binary 命名逻辑） |
| `ctl/main/api/server.go:101` | Health Check 实现（`/health` endpoint） |
| `ctl/main/common/common.go:64` | Metrics 服务器实现（`InitMonitor`） |
| `ctl/main/api/main.go:122` | 启动参数解析（`-conf-dir` flag） |
| `ctl/pkg/config/config.go:17` | 配置加载入口（`Init` 函数，两层 TOML） |
| `ctl/pkg/config/config.go:47` | `parseServerConf`（common + rewrite 加载逻辑） |
| `ctl/pkg/config/define.go` | 完整配置结构体定义（GlobalConfig） |
| `docs/deploy-guides/ctl-deploy-guide.md` | CTL 部署形态文档 |
| `infra/tencentcloud/beijing-sandbox/redis/sandbox-route/` | Redis OpenTofu 模块参考 |
| `infra/tencentcloud/beijing-sandbox/cynosdb/` | CynosDB OpenTofu 模块参考 |

### Technical Decisions

#### 决策 1：MySQL — 复用现有 CynosDB 实例，建库隔离

- 现有实例：`<current-cynosdb-cluster>`，地址 `<current-cynosdb-host>:3306`
- sandbox 使用 database=`cvm`，CTL 使用 database=`ctl`
- 理由：测试环境负载低，2核4GB 足够两个服务共用；同实例便于联调和管理
- **不需要新建 infra 模块**，只需在 K8s 清单的 ConfigMap 中正确配置连接信息
- CynosDB 上需要手动或通过 migration job 创建 `ctl` 数据库

#### 决策 2：Redis — 新购集群版独立实例（按量付费），通过 infra OpenTofu 模块管理

- CTL 使用 Redis Stream 做 MQ（阻塞读 XREADGROUP、长连接 mq_rw_timeout=300s），是重度使用场景
- sandbox Redis 用于路由缓存（读多写少），混用会互相影响
- 新模块路径：`infra/tencentcloud/beijing-sandbox/redis/ctl-mq/`
- **集群版兼容性说明**：CTL 代码使用 `redis.NewClient`（go-redis 单机客户端），腾讯云 Redis 集群版自带 Proxy 层对外暴露单地址单端口，与单机客户端完全兼容，**无需修改代码**。本地 Docker 开发环境继续使用单机 `redis:7-alpine`（接口等价，无需替换为 Redis Cluster 模式）
- **推荐规格（按量付费）**：

| 参数 | 值 | 说明 |
|------|-----|------|
| name | `ctl-mq-redis-bj8` | 命名规范与 sandbox-route 一致 |
| mem_size | `1024` | 1GB，测试环境足够 |
| type_id | `7` | 集群版（与 sandbox 同系列），参数组合在 tencentcloud provider 上验证过 |
| redis_shard_num | `3` | 最小分片数 |
| redis_replicas_num | `1` | 每分片 1 副本（测试环境最低配置） |
| vpc_id | `vpc-21gzr2dc` | 复用同一 VPC |
| subnet_id | `subnet-ieszm71b` | 复用同一子网 |
| security_groups | `["sg-85w4itn9"]` | 复用 TKE 节点安全组 |

- **MQ 配置更正**：
  - `stream_key = "ctl"`（不再使用模板遗留的 `lightglobal`）
  - `group_name = "ctl_service"`

#### 决策 3：Prometheus — 共用集群 Prometheus

- sandbox 已通过 ServiceMonitor（namespace=kube-system）接入
- CTL 只需添加自己的 ServiceMonitor，label 匹配 `metrics-target: "true"` 即可
- CTL 三个进程分别暴露 metrics 端口：api=9591, service=9592, bypass=9593
- **不需要购买额外的 Prometheus 实例**

#### 决策 4：Namespace — 独立 `ctl`

- 与 sandbox namespace 隔离，资源互不影响

#### 决策 5：配置注入 — ConfigMap + Secret

- 将 `server_conf.toml`（common）和 `server_conf_rewrite.toml`（rewrite）分别放入 ConfigMap
- 挂载到 Pod 内：`/etc/ctl/conf/common/` 和 `/etc/ctl/conf/rewrite/`
- 启动命令：`bin/api -conf-dir /etc/ctl/conf`
- 敏感信息不入仓库；由 repo-external `.secret/ctl/test.env` 提供，再在部署脚本里渲染成最终的 rewrite TOML 与 migration DSN

#### 决策 6：镜像仓库 — 复用 `ccr.ccs.tencentyun.com/clawhub/`

- Base 镜像：`ccr.ccs.tencentyun.com/clawhub/ctl-base:latest`（基于 `Dockerfile.base` 构建推送）
- App 镜像：`ccr.ccs.tencentyun.com/clawhub/ctl:{tag}`
- tag 格式：`test-{YYYYMMDD}-{git-short-hash}`
- `ctl/Dockerfile` 的 `BASE_IMAGE` ARG 默认值需从 `mirrors.tencent.com/lighthouse/lightglobal_base_image:latest` 改为 `ccr.ccs.tencentyun.com/clawhub/ctl-base:latest`

#### 决策 7：网络暴露 — 内网 CLB

- 仅 api 需要对外暴露（通过内网 LoadBalancer Service + subnet annotation）
- service 和 bypass 无外部调用，仅暴露 metrics 端口

#### 决策 8：HPA — 全部配置

| Workload | minReplicas | maxReplicas | 指标 |
|----------|-------------|-------------|------|
| api | 1 | 5 | memory 75% |
| service | 1 | 3 | memory 75% |
| bypass | 1 | 2 | memory 75% |

## Implementation Plan

### Tasks

- [x] **Task 1: 创建 CTL Redis OpenTofu 模块**
  - File: `infra/tencentcloud/beijing-sandbox/redis/ctl-mq/main.tf` (新建)
  - Action: 参照 `redis/sandbox-route/main.tf`，定义 `tencentcloud_redis_instance` 资源。`charge_type = "POSTPAID"`（按量付费）。新增 `password` 变量（sensitive）。输出 `redis_instance_id` 和私网连接地址。provider block 配置 `tencentcloudstack/tencentcloud`，required_version `>= 1.6.0`
  - File: `infra/tencentcloud/beijing-sandbox/redis/ctl-mq/variables.tf` (新建)
  - Action: 定义变量 — `region` (default "ap-beijing"), `availability_zone`, `mem_size`, `name`, `type_id`, `vpc_id`, `subnet_id`, `redis_shard_num`, `redis_replicas_num`, `security_groups` (list), `password` (sensitive)
  - File: `infra/tencentcloud/beijing-sandbox/redis/ctl-mq/terraform.tfvars` (新建)
  - Action: 填入以下值：
    ```hcl
    availability_zone  = "ap-beijing-8"
    mem_size           = 1024
    name               = "ctl-mq-redis-bj8"
    type_id            = 7
    vpc_id             = "vpc-21gzr2dc"
    subnet_id          = "subnet-ieszm71b"
    redis_shard_num    = 3
    redis_replicas_num = 1
    security_groups    = ["sg-85w4itn9"]
    ```
  - File: `infra/tencentcloud/beijing-sandbox/redis/ctl-mq/secrets.auto.tfvars.example` (新建)
  - Action: 内容 `password = "your-redis-password-here"`，注释说明通过 `TF_VAR_password` 环境变量注入
  - File: `infra/tencentcloud/beijing-sandbox/redis/ctl-mq/README.md` (新建)
  - Action: 说明模块用途（CTL MQ 专用 Redis）、初始化命令（`tofu init`）、apply 命令、输出值含义
  - Notes: apply 后记录 Redis 私网地址，供 Task 2 使用。type_id=7 是集群版，参数组合与 sandbox-route 同系列

- [x] **Task 2: 创建测试环境 TOML 配置文件**
  - File: `ctl/conf/test/common/server_conf.toml` (新建)
  - Action: 完整拷贝 `ctl/conf/server/common/server_conf.toml` 内容，不做任何修改。此文件作为第 1 层基础配置
  - File: `ctl/conf/test/rewrite/server_conf_rewrite.toml` (新建)
  - Action: 创建测试环境覆盖配置，内容如下（所有值经过 Step 2 源码验证可被正确解析）：
    ```toml
    [api]
    enable_inner_sign = false
    enable_swagger = true

    [api.instance]
    default_template_id = "pool-c0"
    candidate_template_ids = ["pool-c0", "pool-bj8", "pool-c2"]

    [db]
    host = "<current-cynosdb-host>"
    port = 3306
    user = "root"
    password = "<PLACEHOLDER: 加密后的 CynosDB 密码>"
    database = "ctl"
    rw_timeout_seconds = 10

    [redis]
    host = "<PLACEHOLDER: Task 1 输出的 Redis 私网地址>"
    pass = "<PLACEHOLDER: 加密后的 Redis 密码>"
    port = 6379
    connect_timeout_seconds = 5
    rw_timeout_seconds = 5
    mq_rw_timeout_seconds = 300
    pool_size = 16

    [mq]
    stream_key = "ctl"
    group_name = "ctl_service"
    max_len = 100000

    [monitor.api]
    enable_pprof = true
    port = 9591

    [monitor.service]
    enable_pprof = true
    port = 9592

    [monitor.bypass]
    enable_pprof = false
    port = 9593

    [adapter.sandbox]
    baseUrl = "http://sandbox-api.sandbox.svc.cluster.local"
    timeout = 60
    maxRetries = 3
    retryInterval = 1000

    # 测试环境不可用的 adapter，设置 use_mock = true 或保持空 URL（代码遇到空 URL 不会调用）
    [adapter.lightpro]
    use_mock = true

    [adapter.sts]
    use_mock = true

    [log.api]
    enable_color = true

    [log.service]
    enable_color = true

    [log.bypass]
    enable_color = true

    [translate]
    dir = "/usr/local/lightglobal/i18n"

    [tracing]
    protocol = "grpc"
    async = false
    grpc_endpoint = ""
    http_endpoint = ""
    tenant_id = "default"
    service_namespace = "test"

    [misc]
    region = "ap-beijing"
    object_id_password_suffix = "test_env"
    apps_data_dir = "/data/lightglobal/apps"
    block_bypass_and_service = false
    use_random_machine_id = true
    account_area = "0"

    [global_quota]
    valid_modify_resource_names = ["OPENCLAW_INSTANCE"]

    [global_quota.resource_default_quotas]
    OPENCLAW_INSTANCE = 5
    ```
  - Notes: PLACEHOLDER 值需在 Task 1 完成后替换。密码加密方式：`cd ctl && go test -v -test.run=TestCipherEncrypt ./pkg/util/ -args <明文密码>`

- [x] **Task 3: 构建并推送 Base Image + 修改 Dockerfile**
  - File: `ctl/Dockerfile` (修改)
  - Action: 将第 1 行的 `BASE_IMAGE` ARG 默认值从 `mirrors.tencent.com/lighthouse/lightglobal_base_image:latest` 改为 `ccr.ccs.tencentyun.com/clawhub/ctl-base:latest`
  - Notes: 首次部署前需执行一次 `make release-base-image` 将 base 镜像推送到 ccr。base 镜像内容不变（alpine + tzdata + curl），仅换仓库地址。Task 3 仅改 Dockerfile，Makefile 变更统一在 Task 5

- [x] **Task 4: 创建 CTL K8s 清单文件**
  - File: `ctl/k8s/manifests.yaml` (新建)
  - Action: 创建单文件多资源清单，包含以下 K8s 资源（用 `---` 分隔），按依赖顺序排列：
    1. **Namespace** `ctl`
    2. **Repo-external env** `.secret/ctl/test.env` — 存放测试环境真实值；部署脚本先读取它，再渲染 ConfigMap 与 migration DSN
    3. **ConfigMap** `ctl-conf-common` (namespace=ctl) — data key `server_conf.toml`。**不内嵌文件内容**，部署时通过 `kubectl create configmap ctl-conf-common --from-file=server_conf.toml=ctl/conf/test/common/server_conf.toml -n ctl` 创建，manifests.yaml 中仅写注释说明
    4. **ConfigMap** `ctl-conf-rewrite` (namespace=ctl) — data key `server_conf_rewrite.toml`。同上，通过 `kubectl create configmap` 从文件创建
    5. **Deployment** `ctl-api` (namespace=ctl) — 规格：
       - `replicas: 1`
       - `image: ccr.ccs.tencentyun.com/clawhub/ctl:<TAG>`
       - `command: ["/usr/local/lightglobal/bin/api"]`
       - `args: ["-conf-dir", "/etc/ctl/conf"]`
       - `ports: [{name: http, containerPort: 9590}, {name: metrics, containerPort: 9591}]`
       - `volumeMounts`: ctl-conf-common → `/etc/ctl/conf/common/`（subPath: server_conf.toml → server_conf.toml），ctl-conf-rewrite → `/etc/ctl/conf/rewrite/`（subPath: server_conf_rewrite.toml → server_conf_rewrite.toml），apps-data (emptyDir) → `/data/lightglobal/apps`（R2 阻塞项：目录必须存在）
       - `resources: {requests: {cpu: 50m, memory: 64Mi}, limits: {cpu: 500m, memory: 512Mi}}`
       - `readinessProbe: {httpGet: {path: /health, port: http}, initialDelaySeconds: 5, periodSeconds: 10}`
       - `livenessProbe: {httpGet: {path: /health, port: http}, initialDelaySeconds: 15, periodSeconds: 20}`
       - `nodeSelector: {pool: general-bj8}`
       - 注：测试环境 replicas=1，topologySpreadConstraints 无意义，省略
    6. **Deployment** `ctl-service` (namespace=ctl) — 同 ctl-api 但：
       - `command: ["/usr/local/lightglobal/bin/service"]`
       - `ports: [{name: metrics, containerPort: 9592}]`（无 http 端口）
       - `readinessProbe: {tcpSocket: {port: metrics}, initialDelaySeconds: 5, periodSeconds: 10}`（metrics 端口能响应说明 InitMonitor 已完成，进程基本就绪）
       - `livenessProbe: {tcpSocket: {port: metrics}, initialDelaySeconds: 15, periodSeconds: 20}`
    7. **Deployment** `ctl-bypass` (namespace=ctl) — 同 ctl-api 但：
       - `command: ["/usr/local/lightglobal/bin/bypass"]`
       - `ports: [{name: metrics, containerPort: 9593}]`（无 http 端口）
       - `readinessProbe: {tcpSocket: {port: metrics}, initialDelaySeconds: 5, periodSeconds: 10}`
       - `livenessProbe: {tcpSocket: {port: metrics}, initialDelaySeconds: 15, periodSeconds: 20}`
       - `terminationGracePeriodSeconds: 60`（R6：bypass 不响应 SIGTERM，需要足够的 grace period 等 SIGKILL）
    8. **Service** `ctl-api` (namespace=ctl, ClusterIP) — selector `app: ctl-api`，ports: `[{name: http, port: 80, targetPort: http}, {name: metrics, port: 9591, targetPort: metrics}]`，labels: `{metrics-target: "true"}`
    9. **Service** `ctl-api-internal` (namespace=ctl, LoadBalancer) — annotations: `{service.kubernetes.io/qcloud-loadbalancer-internal-subnetid: subnet-ieszm71b}`，selector: `app: ctl-api`，ports: `[{name: http, port: 80, targetPort: http}]`
    10. **Service** `ctl-service-metrics` (namespace=ctl, ClusterIP) — selector `app: ctl-service`，ports: `[{name: metrics, port: 9592, targetPort: metrics}]`，labels: `{metrics-target: "true"}`
    11. **Service** `ctl-bypass-metrics` (namespace=ctl, ClusterIP) — selector `app: ctl-bypass`，ports: `[{name: metrics, port: 9593, targetPort: metrics}]`，labels: `{metrics-target: "true"}`
    12. **HPA** `ctl-api` (namespace=ctl) — scaleTargetRef: Deployment/ctl-api, min=1, max=5, memory averageUtilization=75, scaleUp/scaleDown behavior 参照 sandbox
    13. **HPA** `ctl-service` (namespace=ctl) — scaleTargetRef: Deployment/ctl-service, min=1, max=3, memory averageUtilization=75
    14. **HPA** `ctl-bypass` (namespace=ctl) — scaleTargetRef: Deployment/ctl-bypass, min=1, max=2, memory averageUtilization=75
    15. **ServiceMonitor** `ctl-workloads` (namespace=kube-system) — `namespaceSelector: {matchNames: [ctl]}`，`selector: {matchLabels: {metrics-target: "true"}}`，`endpoints: [{port: metrics, path: /metrics, interval: 30s}]`。注：三个 Service 的 metrics 端口名都叫 `metrics`，ServiceMonitor 按端口名匹配会自动抓取各自的实际端口（9591/9592/9593），无需 PodMonitor
  - Notes:
    - `<TAG>` 占位符需在部署时替换为实际镜像 tag
    - **ConfigMap 不内嵌到 manifests.yaml**，而是部署时通过命令创建：
      ```bash
      kubectl create configmap ctl-conf-common --from-file=server_conf.toml=ctl/conf/test/common/server_conf.toml -n ctl --dry-run=client -o yaml | kubectl apply -f -
      kubectl create configmap ctl-conf-rewrite --from-file=server_conf_rewrite.toml=ctl/conf/test/rewrite/server_conf_rewrite.toml -n ctl --dry-run=client -o yaml | kubectl apply -f -
      ```
      这样配置文件只维护 `ctl/conf/test/` 一处，无需在 manifests.yaml 中同步
    - Deployment labels 需一致：`metadata.labels` 和 `spec.selector.matchLabels` 都用 `app: ctl-{component}`

- [x] **Task 5: 更新 CTL Makefile**
  - File: `ctl/Makefile` (修改)
  - Action: 修改现有 base image 变量 + 新增测试环境 target。在文件中做以下变更：
    1. 修改 `BASE_IMAGE_REPOSITORY` 默认值：
    ```makefile
    BASE_IMAGE_REPOSITORY ?= ccr.ccs.tencentyun.com/clawhub/ctl-base
    IMAGE_REPOSITORY ?= ccr.ccs.tencentyun.com/clawhub/ctl
    ```
    2. 在文件末尾（`swagger:` target 之后）新增：
    ```makefile
    # ===== Test environment targets =====
    TEST_IMAGE_TAG ?= test-$(shell date +%Y%m%d)-$(shell git rev-parse --short HEAD)
    DB_DSN_TEST ?= ""

    build-test-image: build
    	$(DOCKER) build \
    		--build-arg BASE_IMAGE=${BASE_IMAGE_REPOSITORY}:${BASE_IMAGE_TAG} \
    		-t ${IMAGE_REPOSITORY}:${TEST_IMAGE_TAG} \
    		./

    push-test-image: build-test-image
    	$(DOCKER) push ${IMAGE_REPOSITORY}:${TEST_IMAGE_TAG}
    	@echo "Image: ${IMAGE_REPOSITORY}:${TEST_IMAGE_TAG}"

    deploy-test: push-test-image
    	@echo "Image pushed: ${IMAGE_REPOSITORY}:${TEST_IMAGE_TAG}"
    	@echo "Next steps:"
    	@echo "  1. Update image tag in ctl/k8s/manifests.yaml"
    	@echo "  2. kubectl apply -f ctl/k8s/manifests.yaml"

    migrate-up-test:
    	@test -n "$(DB_DSN_TEST)" || (echo "ERROR: DB_DSN_TEST is required. Example: make migrate-up-test DB_DSN_TEST=\"mysql://root:pass@tcp(host:3306)/ctl?multiStatements=true\""; exit 1)
    	@$(MAKE) migrate-up DB_DSN=$(DB_DSN_TEST)

    migrate-version-test:
    	@test -n "$(DB_DSN_TEST)" || (echo "ERROR: DB_DSN_TEST is required"; exit 1)
    	@$(MAKE) migrate-version DB_DSN=$(DB_DSN_TEST)
    ```
  - Notes: Makefile 中的缩进必须使用 tab。`IMAGE_REPOSITORY` 统一使用 ccr 仓库地址。`make release-base-image` 首次需手动执行一次，将 base 镜像推送到 ccr

### Acceptance Criteria

- [ ] AC1: Given Redis OpenTofu 模块已创建，When 执行 `tofu plan`，Then 输出显示将创建 1 个 `tencentcloud_redis_instance` 资源且无 error
- [ ] AC2: Given `tofu apply` 成功，When 从 jumpserver 执行 `redis-cli -h <redis-ip> -p 6379 -a <password> ping`，Then 返回 `PONG`
- [ ] AC3: Given 测试环境 TOML 配置文件就绪（PLACEHOLDER 已替换），When CTL api 以 `-conf-dir ctl/conf/test` 启动，Then 不报 config 解析错误
- [ ] AC4: Given `ctl/Dockerfile` 已修改 BASE_IMAGE 默认值，When `make release-base-image`，Then base 镜像推送到 `ccr.ccs.tencentyun.com/clawhub/ctl-base:latest` 成功
- [ ] AC5: Given base 镜像已推送，When `make build-test-image`，Then 应用镜像构建成功且 tag 格式为 `test-YYYYMMDD-<hash>`
- [ ] AC6: Given `kubectl apply -f ctl/k8s/manifests.yaml` 完成，When 执行 `kubectl -n ctl get pods`，Then ctl-api、ctl-service、ctl-bypass 三个 Pod 状态均为 Running
- [ ] AC7: Given ctl-api Pod 运行中，When 从集群内执行 `curl http://ctl-api.ctl.svc.cluster.local/health`，Then 返回 HTTP 200 `{"status":"ok"}`
- [ ] AC8: Given ctl-api Pod 运行中，When 通过内网 CLB 地址执行 `curl http://<clb-ip>/health`，Then 返回 HTTP 200
- [ ] AC9: Given 所有 Pod 运行中，When 在 Prometheus UI 查看 targets，Then 能看到 ctl namespace 下的 3 个 metrics endpoint（api:9591, service:9592, bypass:9593）
- [ ] AC10: Given 所有 Pod 运行中，When 通过 api 创建实例 `POST /v1/instances`，Then ctl-service Pod 日志显示成功消费了 stream_key=`ctl` 中的异步任务
- [ ] AC11: Given 测试环境 MySQL 可达，When 执行 `make migrate-up-test DB_DSN_TEST="mysql://root:<password>@tcp(<current-cynosdb-host>:3306)/ctl?multiStatements=true"`，Then migration 全部执行成功，`SHOW TABLES FROM ctl` 显示完整表结构
- [ ] AC12: Given HPA 已配置，When 执行 `kubectl -n ctl get hpa`，Then 显示 ctl-api (1/5)、ctl-service (1/3)、ctl-bypass (1/2) 三条 HPA 规则
- [ ] AC13: Given mq 配置 stream_key="ctl"，When 检查 Redis 中的 stream，Then key 名称为 `ctl` 而非 `lightglobal`
- [ ] AC14: Given Redis 不可达（错误地址或实例关闭），When ctl-service 启动，Then Pod 应进入 CrashLoopBackOff 或日志明确报错 Redis 连接失败（不会静默运行）
- [ ] AC15: Given 测试环境 quota 数据未 seed，When `POST /v1/instances`，Then API 返回 quota 不足错误（需先执行 `make seed-local-quota` 初始化 quota 后才能正常创建实例）

## Additional Context

### Dependencies

**Task 执行顺序（可并行优化）：**
```
并行路径 A:                          并行路径 B:
Task 1 (购买 Redis)                  Task 3 (Dockerfile 改 BASE_IMAGE)
  ↓ 产出: Redis 私网地址                ↓
Task 2 (创建配置文件)                 Task 5 (Makefile 变更)
  ↓                                    ↓
手动: CREATE DATABASE + migrate       make release-base-image
  ↓                                  make push-test-image
  ↓                                    ↓
  └──────── 汇合 ──────────────────────┘
                    ↓
           Task 4 (K8s 清单, 需要配置 + 镜像 tag)
                    ↓
           kubectl apply -f ctl/k8s/manifests.yaml
```
注意：**migration 必须在 kubectl apply 之前完成**，否则 Pod 启动时连接空数据库可能 panic。

**外部依赖（已存在，需确认可用）：**
- TKE 集群 `<sandbox-tke-cluster>` 正常运行，存在可用节点池
- CynosDB MySQL `<current-cynosdb-cluster>` (`<current-cynosdb-host>:3306`) 可用，root 密码已知
- TCR 镜像仓库 `lightclaw-bj8` 可推送（ccr.ccs.tencentyun.com/clawhub/）
- VPC `vpc-21gzr2dc` 网络连通
- 安全组 `sg-85w4itn9`（TKE 节点 SG）已允许集群内互访
- sandbox-api Service 在 `sandbox` namespace 可达（CTL 的 adapter.sandbox 依赖）

**腾讯云 API 凭据：**
- OpenTofu 需要 `TENCENTCLOUD_SECRET_ID` 和 `TENCENTCLOUD_SECRET_KEY` 环境变量

### Testing Strategy

**1. 基础设施验证（Task 1 完成后）：**
- 从 jumpserver (ins-0ry130tf) 执行 `redis-cli -h <redis-ip> -p 6379 -a <password> ping`，确认返回 PONG

**2. 配置验证（Task 2 完成后）：**
- 检查 TOML 中无 PLACEHOLDER 残留
- 实际配置解析验证推迟到 Pod 启动时，通过 `kubectl -n ctl logs deployment/ctl-api` 检查是否有 config 解析报错（本地机器不在 VPC 内，无法直连 CynosDB/Redis）

**3. 镜像验证（Task 3 + 5 完成后）：**
- `make release-base-image` 成功推送 base 镜像到 ccr
- `make build-test-image` 成功构建应用镜像

**4. Migration（部署前手动执行）：**
- 在 jumpserver 或本地（通过 port-forward）执行：
  ```bash
  mysql -h <current-cynosdb-host> -P 3306 -u root -p -e "CREATE DATABASE IF NOT EXISTS ctl CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
  make migrate-up-test DB_DSN_TEST="mysql://root:<password>@tcp(<current-cynosdb-host>:3306)/ctl?multiStatements=true"
  ```
- 验证：`SHOW TABLES FROM ctl` 显示完整表结构

**5. K8s 部署验证（Task 4 完成后，镜像和 migration 已就绪）：**
- `kubectl -n ctl get all` 检查所有资源创建成功
- `kubectl -n ctl logs deployment/ctl-api` 检查 api 启动日志无报错
- `kubectl -n ctl logs deployment/ctl-service` 检查 service 启动并连接 Redis Stream
- `kubectl -n ctl logs deployment/ctl-bypass` 检查 bypass 启动并开始补偿扫描
- `kubectl -n ctl get hpa` 确认 3 条 HPA 规则存在

**6. 功能验证：**
- 通过内网 CLB 地址 `curl http://<clb-ip>/health`，确认 api 可达
- `POST /v1/instances` 触发异步任务，检查 service 日志确认消费成功
- 在 Prometheus UI (`http://<prometheus-ip>:9090/targets`) 确认 ctl 的 3 个 scrape target 状态为 UP

**7. 监控验证：**
- Prometheus 查询 `up{namespace="ctl"}`，确认 3 个 target 值为 1
- 查询 `process_resident_memory_bytes{namespace="ctl"}`，确认 metrics 数据正常上报

### 代码审查：部署风险点

> 以下是基于源码分析发现的部署相关风险，实现时必须逐项确认。

#### 🔴 阻塞部署的问题

| # | 风险 | 源码位置 | 现象 | 应对 |
|---|------|---------|------|------|
| R1 | **MySQL 连接失败时直接 panic** | `pkg/resource/mysql.go` InitGormDB | 所有 Pod CrashLoopBackOff | 部署前确保 CynosDB 可达、密码正确、ctl 库已创建 |
| R2 | **`apps_data_dir` 目录不存在导致启动失败** | `pkg/logic/app/common.go` loadAppsCache → `os.Open(dir)` | 所有 Pod CrashLoopBackOff | Deployment 中挂载 `emptyDir` 到 `/data/lightglobal/apps`，或在 Dockerfile 中 `RUN mkdir -p` |
| R3 | **Sandbox adapter config 为 nil 时 panic** | `pkg/adapter/sandbox/adapter.go:86` | 所有 Pod panic | rewrite TOML 中必须包含完整的 `[adapter.sandbox]` 段（已在 Task 2 中覆盖 ✅） |

#### ⚠️ 需关注的问题

| # | 风险 | 源码位置 | 现象 | 应对 |
|---|------|---------|------|------|
| R4 | **Tracing endpoint 为空时 warn 但不 crash** | `pkg/tracing/tracing.go` genSpanExporter | 启动日志 warn | rewrite 中已将 `grpc_endpoint` 和 `http_endpoint` 设为空（已在 Task 2 中覆盖 ✅） |
| R5 | **Redis MQ 客户端无连接验证** | `pkg/resource/redis.go:24` | Service 的 consumer.Start 时才会失败 | TCP probe on metrics port 可检测到启动失败（已在 Task 4 中配置 ✅） |
| R6 | **Bypass 不响应 SIGTERM** | `main/bypass/main.go` RunBypasses → wg.Wait 永久阻塞 | `terminationGracePeriodSeconds` 超时后被 SIGKILL | 在 Deployment 中设置 `terminationGracePeriodSeconds: 60`，测试环境可接受 |
| R7 | **内部 adapter (lightpro/sts/clouddc 等) URL 为空** | `pkg/config/config.go` parseAdapterConf | 调用这些 adapter 时会超时/报错 | rewrite 中已设 `use_mock = true`（已在 Task 2 中覆盖 ✅） |

#### ✅ 已验证无风险

| # | 项目 | 说明 |
|---|------|------|
| R8 | PID 文件 | 配置项 `pid_file` 在代码中未使用，不会尝试写文件 |
| R9 | SIGTERM 优雅关闭 | api 正确调用 `http.Shutdown()`，service 正确停止 consumer |
| R10 | Consumer Group 创建 | 使用 `XGroupCreateMkStream`，空 Redis 首次启动可正常创建 |
| R11 | Redis 集群版兼容性 | 代码使用 `redis.NewClient`，腾讯云集群版 Proxy 层对外暴露单地址，完全兼容 |

### Notes

**⚠️ 注意事项：**
1. **Base Image 必须先构建**：首次部署前执行 `make release-base-image`，将 `ctl-base:latest` 推送到 ccr。后续只有 Dockerfile.base 变更时才需要重新构建。注意 `Dockerfile.base` 当前用 `alpine:3` 未 pin 版本，建议改为 `alpine:3.19`（与 sandbox 一致）避免不可预期的 breaking change
2. **Migration 不自动化触发**：不通过 K8s Job 自动触发 migration。测试环境使用 `make migrate-up-test`（golang-migrate，类似 alembic）手动执行；生产环境手动执行 SQL
3. **stream_key 命名**：使用 `ctl`，group_name 使用 `ctl_service`（不用模板遗留的 `lightglobal` / `lightglobal_service`）
4. **密码加密**：CTL 配置中的密码需通过 `cd ctl && go test -v -test.run=TestCipherEncrypt ./pkg/util/ -args <明文密码>` 加密后填入 rewrite TOML
5. **sandbox 内网调用**：CTL 调用 sandbox 走集群内 Service DNS（`sandbox-api.sandbox.svc.cluster.local`），不走 CLB
6. **CynosDB 建库**：需在 migration 前手动执行 `CREATE DATABASE IF NOT EXISTS ctl`
7. **ConfigMap 热更新限制**：ConfigMap 更新后需重启 Pod 才能生效（subPath 挂载不支持热更新），可通过修改 Deployment annotation 触发滚动更新
8. **`apps_data_dir` 目录（R2 阻塞项）**：rewrite 配置中 `apps_data_dir = "/data/lightglobal/apps"`，代码启动时会 `os.Open` 该目录读取 app 缓存。**必须**在 Deployment 中挂载 `emptyDir` volume 到该路径，否则 Pod 启动失败
9. **Quota seed**：测试环境首次创建实例前需执行 quota 初始化（参考 `make seed-local-quota`），否则 API 会返回 quota 不足

**已知限制：**
- 测试环境 bypass 推荐单副本，HPA max=2 仅作为安全网，正常不应扩容
- Redis 集群版有数据持久化，但如果 Redis 实例被删除重建，consumer group 会丢失。CTL service 重连时如果遇到 `NOGROUP` 错误，bypass 补偿机制会在下一轮扫描中重新投递未完成任务

**后续迭代（Out of Scope 但值得记录）：**
- CI/CD pipeline：GitHub Actions 自动构建镜像 + 自动部署
- Grafana Dashboard 部署到 K8s
- Secret 管理升级：改用 External Secrets Operator 或 Vault
- Ingress + 域名配置

### 云资源购买清单

> **⚠️ 所有云资源统一采用按量付费（POSTPAID），不购买包年包月。**

| 资源 | 操作 | 规格 | 计费方式 | 预估月费 |
|------|------|------|---------|---------|
| CynosDB MySQL | 复用现有（建库隔离） | 无新增 | — | ¥0 |
| Redis | **新购** (infra OpenTofu) | 集群版 1GB, 3分片1副本 | 按量付费 | ~¥150-300/月 |
| Prometheus | 共用集群已有 | 无新增 | — | ¥0 |
| 内网 CLB | **新增** (K8s Service 自动创建) | — | 按量付费 | ~¥20/月 |
| **合计** | | | | **~¥170-320/月** |
