# 上海 LLMGateway 生产 CI/CD 接入设计

## 背景

上海 LLMGateway 已作为独立生产集群运行，流量入口为
`https://token.lightvela.com`，管理入口为
`https://token-admin.lightvela.com`。现有部署由临时 Argo CD Application 管理，
配置来源是临时分支，不符合 mono2 统一的生产发布模型。

本次把上海环境接入 mono2 已有的 `master -> shprod promote -> gitops -> Argo CD`
链路。Argo CD 继续负责声明式收敛，但不直接以临时分支作为生产配置源，也不启用
生产自动同步。

## 目标

- `master` 上的 velagw 变更由 `.ci/velagw.yml` 构建上海 TCR 镜像。
- 上海发布复用 mono2 的 `shprod` 人工确认和 GitOps promotion 流程。
- 正式 Application 由 `root-shprod` 发现，目标仍是独立 Argo cluster
  `shanghai-llmgateway-prod`。
- 生产期望态落在 `argocd/services/velagw/shprod`，镜像使用 digest 固定。
- 从临时 Argo Application 无损切换到正式 Application，不重建在线工作负载。
- 上海和北京可以独立发布、独立回滚，互不修改对方环境。

## 非目标

- 不把上海集群并入名为 `shprod` 的 Kubernetes 集群；`shprod` 只是 CI 发布环境名。
- 不在 Git 中保存运行时 Secret、数据库密码、管理 Token 或 kubeconfig。
- 不让 Argo CD 管理动态 `LLMFleet/prod` 实例及其派生 Set 资源。
- 不启用生产自动同步，也不在本次接入 CI 自动执行 Argo sync。
- 不修改或删除现有证书、DNS、CLB、VPC、数据库和 Redis。

## 发布链路

```text
mono2 master
  -> velagw CI 构建
  -> 推送 lightclaw-shprod.tencentcloudcr.com/llmgateway/llmgateway
  -> shprod 人工确认
  -> 创建 promote-shprod-velagw-* 分支与 GitOps MR
  -> 生产 promotion 审核
  -> 合入 gitops
  -> root-shprod 发现 velagw-shprod Application
  -> 人工执行 Argo sync
  -> 上海独立 TKE 集群
```

`.ci/velagw.yml` 使用以下环境策略：

- `MASTER_BUILD_ENVS`: `beijing-llmgateway,shprod`
- `MASTER_AUTO_PIN_ENVS`: `beijing-llmgateway`
- `DEFAULT_TARGET_ENV`: `shprod`
- `ENABLE_MASTER_PROD_PROMOTE`: `true`

因此北京验证环境可继续自动固定镜像；上海生产只生成待审核的 GitOps 变更，不会
随 `master` 提交自动上线。

## GitOps 资源模型

### 正式 Application

新增 `argocd/apps/shprod/velagw.yaml`：

- Application 名称：`velagw-shprod`
- AppProject：`shprod-velagw`
- Git 源：`git@git.woa.com:wisp/mono2.git`
- revision：`gitops`
- path：`argocd/services/velagw/shprod`
- destination cluster：`shanghai-llmgateway-prod`
- destination namespace：`llmgateway`
- 不配置 `spec.syncPolicy.automated`

新增 `argocd/projects/shprod-velagw.yaml`，只允许 mono2 Git 源、上海目标集群和
LLMGateway 所需的 namespaced 资源及 KRO `ResourceGraphDefinition`。

新增 `argocd/clusters/shanghai-llmgateway-prod.yaml` 作为非敏感集群登记事实：

- API 连接地址：`https://43.180.150.109:443`
- TLS server name：`cls-baiv5l5p.ccs.tencent-cloud.com`
- AppProject path：`argocd/projects/shprod-velagw.yaml`

这里必须保留“连接 IP、使用 TKE 集群域名校验 TLS”的模型。直接使用 CLB 域名作为
SNI 会出现间歇性 EOF，不能在正式化时退回该连接方式。kubeconfig 和 bearer token
仍只存在于受控的 CI/运维环境中。

`argocd/root/shprod.yaml` 已负责发现 `argocd/apps/shprod`，不新增上海专用 root
Application。`argocd/projects` 不在 `root-shprod` 的扫描范围内，因此在 leaf
Application 出现前，必须先通过仓库已有的 Argo target cluster onboarding 命令幂等
写入 `shprod-velagw` AppProject；现有目标 cluster registration 原地复用，不删除、不
重建。

### 上海服务包

新增 `argocd/services/velagw/shprod`，包含：

- control、traffic、worker 等中央服务；
- set-manager；
- `LLMFleet` 的 KRO `ResourceGraphDefinition`；
- 上海域名、证书引用、Service/CLB 注解和生产副本设置；
- `velagw-platform.env` 中的 digest 镜像固定值。

服务包不包含以下资源：

- 任何明文 Secret；
- `llmgateway` Namespace；
- 动态 `LLMFleet/prod` 实例；
- 由 KRO/set-manager 派生的 Set Deployment、Service、Job；
- Terraform 管理的云资源。

Namespace 和运行时 Secret 继续由集群外置引导流程创建；Argo 只引用既有名称。
这样即使未来 leaf Application 被误级联删除，也不会因 Namespace 被 prune 而连带
删除动态 Fleet、Set 和运行时 Secret。

## CI Bundle 合约

扩展 `.ci/runtime/bundles/velagw.bundle`：

- 为 `shprod` 增加镜像仓库
  `lightclaw-shprod.tencentcloudcr.com/llmgateway/llmgateway`；
- 把 `argocd/apps/shprod/velagw.yaml`、`argocd/projects/shprod-velagw.yaml`、
  `argocd/clusters/shanghai-llmgateway-prod.yaml` 和
  `argocd/services/velagw/shprod` 纳入允许发布路径；
- `publish_paths_by_env.shprod` 只投影上海所需路径，不覆盖北京期望态；
- 继续使用 `db_contract: none`，因为本次发布不执行中央数据库迁移。

生产 promotion 只更新 `velagw-platform.env` 的镜像 digest。平台工作负载升级与
Fleet 内 new-api Set 发布仍是两条不同的发布轨道，避免一次中央服务发布隐式更新
所有 Set。

set-manager 同时接收该 digest 作为期望的 runtime cleaner 镜像。每轮 reconcile
优先比较 `LLMFleet.spec.runtimeCleanerImage`，仅在漂移时使用 resourceVersion 保护的
JSON Patch 更新这一个字段并结束本轮。Argo 不声明 `LLMFleet/prod`，new-api 镜像、
Set、Shard、traffic runtime 和 cleanup 状态均不属于该 Patch。

## 临时 Application 无损接管

接管严格按以下顺序执行：

1. 将正式源码和 CI 变更合入 `master`。
2. 通过 shprod promotion 把完整上海服务包投影到 `gitops`。
3. 使用 `argocd/clusters/shanghai-llmgateway-prod.yaml` 和现有 kubeconfig 幂等更新
   cluster registration 与 `shprod-velagw` AppProject，确认 TLS SNI 配置未漂移。
4. 确认正式 `velagw-shprod` Application 已由 `root-shprod` 创建。
5. 首次同步前比对正式 Application 渲染结果与在线资源；镜像先固定为当前在线
   digest，避免接管过程触发升级。
6. 手动同步正式 Application，确认 `Synced/Healthy`，且所有入口、任务和 Set
   状态正常。
7. 以 non-cascade/orphan 方式删除临时 child Applications，禁止 prune 在线资源。
8. 删除临时 root Application 和仅供临时链路使用的 AppProjects。
9. 保留 `cluster-shanghai-llmgateway-prod` 注册 Secret、现有 Secret、证书、DNS、
   CLB、数据库、Redis、`LLMFleet/prod` 及所有派生资源。

正式 Application 健康前，不删除临时 Application。若正式同步出现问题，立即停止
接管并让临时 Application 继续作为当前管理入口。

## 验证标准

### 静态验证

- CI bundle 合约测试通过。
- `.ci/runtime/check_ci_runtime.sh` 通过。
- `kustomize build argocd/services/velagw/shprod` 成功。
- 渲染结果不包含 Secret 数据和动态 `LLMFleet/prod`。
- Application 无自动同步策略，目标 cluster/namespace 正确。
- 上海镜像仓库和 digest 替换覆盖所有中央进程，不影响 Fleet Set 镜像发布策略。

### 在线接管验证

- `velagw-shprod` 为 `Synced/Healthy`。
- `https://token.lightvela.com` 推理冒烟成功。
- `https://token-admin.lightvela.com` 管理健康检查成功。
- control、traffic、worker、set-manager 均 Ready。
- 2 个 Shard、4 个 Set 及各 Set 的 2 个 traffic 副本保持健康。
- 临时 Applications 删除后，在线 Pod、Service、Ingress/CLB 和域名无重建或中断。
- Argo diff 中不出现 Secret、动态 Fleet 和派生 Set 的待删除项。

## 回滚

- **接管阶段回滚**：正式 Application 尚未健康时不删除临时 Application；修复或
  删除正式 Application，在线资源由临时链路继续管理。
- **发布阶段回滚**：对上一版本 digest 发起新的 shprod promotion，通过相同审批和
  手动 Argo sync 回滚。
- **禁止操作**：不以 `kubectl delete`、级联删除 Application 或 Terraform destroy
  作为应用发布回滚方式。

## 交付边界

完成本设计后，上海 LLMGateway 的代码构建、镜像发布、GitOps 变更和 Argo 收敛均
进入 mono2 标准生产流程；上海仍是独立 VPC、独立 TKE、独立数据面和独立域名，
但不再依赖临时分支或上海专用 Argo root。
