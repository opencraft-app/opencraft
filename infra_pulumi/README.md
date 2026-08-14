# Infra Pulumi

`infra_pulumi/` 是当前腾讯云 landing zone 的 Go + Pulumi 控制面实现。

`cmd/infractl` 现在通过 Pulumi Automation API 驱动 stack 生命周期，不再手工 `exec pulumi preview/up/config`。

它负责两类事情：

- 定义并管理北京、上海等环境的基础设施资源
- 把基础设施输出回写给部署层，例如 `deploy/envs/<env>/platform.env`、运行时密码和集群 kubeconfig

## 目录说明

- `cmd/infra-pulumi`
  - Pulumi program 入口
- `cmd/infractl`
  - 运维入口，负责 `preview / up / sync / reconcile / validate / import / set-secrets`
- `pkg/config`
  - inventory 加载、运行时配置
- `pkg/components`
  - 各类资源组件，例如 networking、tke、cynosdb、redis、tcr
- `pkg/importplan`
  - 存量环境纳管时的资源 ID 映射
- `envs/tencentcloud/<env>/inventory.yaml`
  - 非敏感环境事实

## 基本用法

先准备 Pulumi 和腾讯云凭据：

```bash
export PATH="$HOME/.pulumi/bin:$PATH"
export TENCENTCLOUD_SECRET_ID=...
export TENCENTCLOUD_SECRET_KEY=...
# SCF 运行时为 Python 3.10；本地存在多个 Python 时显式指定可用的打包解释器
export SCF_BUILD_PYTHON=/path/to/working/python3
```

### 1. 设置资源密码

资源密码和集群级镜像拉取凭据都不写进 `inventory.yaml`，而是写进 Pulumi stack secrets：

```bash
export NODE_PASSWORD=...
export DB_PASSWORD=...
export REDIS_PASSWORD=...
# 可选；未显式提供时，infractl 会尝试从本机 ~/.docker/config.json 发现 ccr.ccs.tencentyun.com 登录态
export REGISTRY_PULL_SERVER=ccr.ccs.tencentyun.com
export REGISTRY_PULL_USERNAME=...
export REGISTRY_PULL_PASSWORD=...

cd infra_pulumi
GOWORK=off go run ./cmd/infractl set-secrets --stack beijing-sandbox
```

### 2. 预览变更

```bash
cd infra_pulumi
GOWORK=off go run ./cmd/infractl preview --stack beijing-sandbox
```

### 3. 开启纳管模式

仅在存量环境分阶段纳管时使用：

```bash
cd infra_pulumi
GOWORK=off go run ./cmd/infractl import --stack beijing-sandbox
```

### 4. 执行变更

`up` 会做三件事：

- 通过 Pulumi Automation API 执行 stack update
- 回写 `deploy/envs/<env>/platform.env`，其中包含部署所需地址和资源密码
- 拉取并写入 `.secret/<cluster-id>-config`

```bash
cd infra_pulumi
GOWORK=off go run ./cmd/infractl up --stack beijing-sandbox
```

只发布到期短信通知组件时，使用组件 scope。该模式不会同步或改写整个平台的 deploy 输出：

```bash
INFRA_COMPONENT_SCOPE=notify GOWORK=off go run ./cmd/infractl preview --stack beijing-sandbox
INFRA_COMPONENT_SCOPE=notify GOWORK=off go run ./cmd/infractl up --stack beijing-sandbox
```

### 5. 只同步部署输出

如果云资源不需要变更，只想把最新 infra 输出重新写回部署层：

```bash
cd infra_pulumi
GOWORK=off go run ./cmd/infractl sync --stack beijing-sandbox
```

### 6. 本地校验

```bash
cd infra_pulumi
GOWORK=off go run ./cmd/infractl validate --stack beijing-sandbox
```

## 设计约定

### 环境事实

- 非敏感环境事实放在 `envs/tencentcloud/<env>/inventory.yaml`
- 敏感信息不放 inventory
- 存量纳管环境可用 `stacks.cynosdb.existing_endpoint` 和 `stacks.redis.*.existing_endpoint` 记录只读核验到的服务端点；这些字段不替代 provider import ID，也不会单独触发资源变更
- 部署层使用的运行时事实由 Pulumi outputs 回流到 `../deploy/envs/<env>/platform.env`
- `platform.env` 现在属于敏感文件，包含 deploy 运行时密码，权限应保持 `0600`

### Secret

资源密码使用 Pulumi stack secrets：

- `infra-pulumi:nodePassword`
- `infra-pulumi:dbPassword`
- `infra-pulumi:redisPassword`
- `infra-pulumi:registryPullServer`
- `infra-pulumi:registryPullUsername`
- `infra-pulumi:registryPullPassword`
- `infra-pulumi:notifyTestAllowlistSHA256`（仅非生产环境，保存允许接收测试短信的号码 SHA-256）

更多说明见 [secrets/README.md](secrets/README.md)。

### 集群级镜像拉取凭据

- TKE 在建集群时会安装 `tcr` addon。
- addon 会把同一套 registry pull 凭据自动分发到所有 namespace 和 default ServiceAccount。
- 当前统一下发的 Secret 名包括：
  - `qcloudregistrykey`
  - `tcr-regcred`
  - `tcr-lightclaw-secret`
- 这样旧 workload 清单里的不同 `imagePullSecrets` 名称都能继续工作，同时新项目可以逐步收敛到“不再手工维护项目级 pull secret”。
- 当前集群级 pull secret 的 server 来自 TCR 实例真实公网域名，例如 `lightclaw-shprod.tencentcloudcr.com`；不要再假设固定是 `ccr.ccs.tencentyun.com`。

### TKE 日志 Agent

- `infra_pulumi` 不安装 TKE `tke-log-agent` addon。
- 业务侧仍可保留 `LogConfig` 清单作为日志采集意图，但集群级日志 agent 不由本控制面启用。
- 如果未来需要恢复 CLS 容器日志采集，必须先验证 TKE addon 在目标地域的 `clusterID`、`localRegion`、`clsHost` 渲染正确，再显式建模；不要依赖 addon 默认值。

### TCR 公网访问

- `stacks.tcr.open_public_operation=true` 只表示开启 TCR 的公网能力，不代表公网来源已经放通。
- `infra_pulumi` 现在会在创建/更新 TCR 实例时一并下发公网访问白名单，默认放通 `0.0.0.0/0`，确保外部机器可以直接对实例公网域名执行 `docker pull/push`。
- 如果后续要收紧来源范围，应在 `pkg/components/tcr` 里统一收口，不要靠某一台机器的临时网络例外。

### 网络规划

网络布局按共享规则从 `vpc_cidr` 推导：

- `pool-a .. pool-f` 对应 VPC 内前 6 个 `/16`
- `support` 对应 VPC 内最后一个 `/19`
- subnet 落在哪个 AZ，仍由 inventory 指定
- 如果 `network.vpc_cidr` 缺省，默认使用 `10.0.0.0/12`

### 控制面接入 VPC

- `stacks.connectivity.enabled=true` 时，会为该环境创建一套额外的 access VPC / subnet / route table，用于承接跨地域控制面接入。
- 当前设计目标是给统一 Argo CD 控制面 这类外部控制面提供一条私网入口，不直接把控制面 VPC 与北京主业务 VPC 硬连。
- `stacks.connectivity.ccn` 目前只负责：
  - 创建控制面专用 CCN
  - 挂载本地 access VPC
  - 挂载远端控制面 VPC
  - 给 access VPC 写回到远端控制面 VPC 的 `USER_CCN` 路由
- 这一步只完成跨地域私网骨架，不等同于 PrivateLink 已经落地；后续仍需要在北京业务 VPC 与 access VPC 之间补私有接入面。
- `stacks.connectivity.private_link` 用于第二阶段：
  - 在北京业务 VPC 暴露 `VpcEndPointService`
  - 在北京 access VPC 创建消费端 `VpcEndPoint`
  - 当前 provider service 仅支持 `CLB` / `CDB` / `CRS` 等腾讯云原生实例；本仓库计划使用北京业务 VPC 内的私有 `CLB`

### TKE 网络模式

- `stacks.tke.network_type` 现在必须显式声明，当前统一收敛为 `VPC-CNI`
- `stacks.tke.vpc_cni_type` 当前统一使用 `tke-route-eni`
- `stacks.tke.service_cidr` 可选；如显式配置则会下发到集群，留空时由云侧按默认行为处理
- 若 `stacks.tke.eni_subnet_keys` 省略，`infra_pulumi` 会默认把 `sandbox_pool_subnet_keys + support_subnet_key` 全部作为 `EniSubnetIds`
- `stacks.tke.subnet_id` 继续作为 `cluster_subnet_id`

注意：

- 现有 `GR` 集群不能原地切到 `VPC-CNI`
- 正确方式是新建一套 `VPC-CNI` 集群，再迁移 workload
- 如果要保留旧集群并存，应先把旧集群在云上改名，再让 IaC 创建新的目标集群

### 集群公网访问

- 新建环境可以在 `stacks.tke.cluster_internet` 打开 TKE 公网 API 访问。
- `stacks.tke.cluster_internet_cidrs` 用于控制公网 API 白名单。
- 当前实现对“新建环境”会：
  - 复用 TKE node pool 安全组作为 cluster endpoint 安全组
  - 给该安全组补 `443/TCP` 的白名单规则
  - 创建 `Kubernetes.ClusterEndpoint`
- 这样 `infractl sync` 拉回来的 kubeconfig 会优先落到公网 CLB 地址，而不是不可直连的 `ccs.tencent-cloud.com` 域名。
- 存量纳管环境不会因为这项能力自动改动原有公网访问形态，除非你显式对该环境执行对应变更。

### 命名规则

核心资源名由 `env_short` 派生：

- `tke-<env_short>`
- `general-<env_short>`
- `cynosdb-<env_short>`
- `lightclaw-<env_short>`
- `ctl-mq-redis-<env_short>`
- `sandbox-route-redis-<env_short>`
- `jumpserver-<env_short>`

### Pass 到期短信通知

`stacks.notify` 管理两个位于业务 VPC 内的 SCF：

- scanner：每天按北京时间扫描 D-7 和 D0 到期 Pass，分页读取只读 DB，并用 Lua 原子写入 Redis Stream 与 60 天防重键。
- worker：消费 Redis Stream，发送前再次检查 Pass 的到期时间和状态；续费或状态变化的消息会取消。短信按 Redis TIME 令牌桶限制为 15 QPS。

运行状态、队列、重试集合、扫描水位和防重信息都按环境写入 Redis。成功、失败、取消和不确定状态保留 60 天；已 ACK 的 Stream 消息会删除。明确限流最多重试 5 次，短信请求结果不确定时标记 `unknown`，不自动重发。

非生产环境必须开启 `test_allowlist_enabled` 并配置 `notifyTestAllowlistSHA256`；生产环境会拒绝启用测试白名单。scanner 和 worker 的 SCF 超时均为 900 秒，worker 在 840 秒主动退出，后续定时触发继续处理剩余消息。

上海生产按以下三步上线，每一步都先 preview，再经人工确认执行 up：

1. `manage_triggers: false`、`triggers_enabled: false`：只创建 SSM、CAM 和两个 SCF，不创建定时器。验证 SCF 为 `Active / Available` 后，手动 dry-run scanner，只读 DB 且不入队。
2. `manage_triggers: true`、`triggers_enabled: false`：创建两个关闭状态的 timer，核对 scanner 为每天 09:00、worker 为每 15 分钟。
3. `manage_triggers: true`、`triggers_enabled: true`：启用 timer。先手动执行 scanner 并观察 CLS、Redis 状态和短信统计，再开启自动调度。

生产回滚优先把 `triggers_enabled` 改回 `false` 并执行 notify scope update，停止新增扫描和消费。不要直接清空 Redis；排障确认后可重新开启 worker 继续消费。代码回滚使用上一版本 SCF zip，防重键和状态键仍按 60 天 TTL 保留。

### 运行时自动推导

以下能力已经做成运行时自动推导：

- COS `account_app_id` 通过 CAM `GetUserAppId` 获取
- 新环境 bucket 名自动生成为 `lightclawuser-<env_short>-<app_id>`
- 如当前凭据不允许新增 CAM 用户，可在 inventory 里设置 `stacks.storage.manage_cam_access=false`，仅创建 bucket / policy，跳过 CAM user、policy attachment 和 access key
- jumpserver 镜像缺省时自动发现当前 region 下的 Ubuntu 24 公共镜像
- TKE kubeconfig 通过 `DescribeClusterKubeconfig` 拉取，并写入 `.secret/<cluster-id>-config`
- 安全组引用可以使用 `__TKE_NODE_SECURITY_GROUP_ID__`

对于新建环境，以下字段可以省略，由同次运行创建出的资源自动补齐：

- `stacks.networking.primary_nat_public_ips`
- `stacks.networking.secondary_nat_public_ips`
- `stacks.networking.snat_subnets.*.public_ip_addrs`
- `stacks.monitoring.ctl_cls_logs.logset_id`
- `stacks.monitoring.sandbox_cls_logs.logset_id`

## 运行约束

- 运行 `cmd/infractl` 时带上 `GOWORK=off`，因为这个模块故意不挂到 repo 根 `go.work`
- `cmd/infractl` 默认使用项目内本地 Pulumi backend：`infra_pulumi/.pulumi-state`
- 如果 repo 根存在未跟踪的 `secrets.local.sh`，`cmd/infractl` 会自动加载其中的本地环境变量
- `storageAccessKeyImportId` 不提交到仓库，因为 access key import ID 也属于敏感信息

## 当前状态

- 北京环境已经纳管
- 东京已建立 `tokyo-sandbox` inventory 和静态 import/adoption 元数据；当前没有 Pulumi stack 配置，不执行 `preview / import / up`
- `shprod` 已经能正常 `preview` 且当前是 `60 unchanged`
- 北京当前仍有一个已知变更：VPC 名称会从旧名字收敛到新的 `lightclaw-*` 规则
