# AI 编程友好规范（cvm-mock-e2b）

为便于 AI/自动化协作改进本项目，约定以下写作与开发指引。保持文档短平快，聚焦易错点与关键不变量。

相关文档：
- 开发/运维入口： [docs/agent-guides/sandbox-agent-guide.md](../docs/agent-guides/sandbox-agent-guide.md)
- 部署与镜像 rollout： [docs/deploy-guides/sandbox-deploy-guide.md](../docs/deploy-guides/sandbox-deploy-guide.md)
- 镜像构建与 TAT 运行时： [docs/agent-guides/sandbox-image-agent-guide.md](../docs/agent-guides/sandbox-image-agent-guide.md)

## 设计不变量
- 状态机唯一可信：`CREATING → CLEAN → ALLOCATED → DRY → RESETTING → CLEAN`，销毁/失败流转走 `FAILED/DELETING/DELETED`。任何代码改动不得跳过合法转移或静默修改状态。
- 请求路径**不创建/重装**，只做分配(`CLEAN→ALLOCATED`)与释放(`ALLOCATED→DRY`)；后台 Worker 才能推进 `DRY→RESETTING→CLEAN`。
- 并发安全依赖存储层：MySQL 版使用 `SELECT ... FOR UPDATE` 和基于 `expected_state` 的条件更新，避免同一实例被重复分配。

## 代码速览
- `cmd/server`：HTTP 入口；若替换存储/Provider，从这里切换构造函数。
- `internal/service/pool.go`：状态校验与转移集中于此；新增状态需先扩展 `internal/core/types.go` 并在此处落地规则。
- `internal/store/{memory,mysql}.go`：库存实现；MySQL 依赖行锁，内存版适合本地演示。
- `internal/provider`：云厂商适配层；Mock 为默认，腾讯云需环境变量配置。

## 本地运行与验证
```bash
# 启动本地 compose（统一读取 .secret/sandbox/local.env）
./scripts/dev-compose.sh up --build

# 或手工 source 后直接跑二进制
source .secret/sandbox/local.env
go run ./cmd/server

# 补货与重装 Worker（按需选择）
go run ./cmd/refill -pool <POOL_ID> -count 2
go run ./cmd/worker -refill-count -1 -waterline-interval 0 -cleanup-interval 0 -reset-pool <POOL_ID> -reset-concurrency 10

# 基本回归
go test ./...
./scripts/e2e/run.sh
```

## 发布与镜像切换

- 本地敏感配置统一放在 `.secret/sandbox/local.env`（相对仓库根目录）
- 测试环境敏感配置统一放在 `.secret/sandbox/test.env`（相对仓库根目录）；除腾讯云密钥外，还应显式提供每个默认 pool 的 `SANDBOX_POOL_*_SECURITY_GROUPS`
- 正式发布目标只认 `Argo CD`
- `sandbox/scripts/deploy-k8s.sh` 已移除；当前只建立了后续纳管所需的 skeleton / source-facing 边界
- 默认池配置统一走 `sandbox/config/default-pools.tsv` + `ENV=<env> bash sandbox/scripts/sync-default-pools.sh --base-image <img-id>`；不要再通过 K8s 发布链或全局安全组环境变量隐式 seed
- 切 pool 镜像优先走 `sandbox/scripts/rollout-pool-image-via-pod.sh`：脚本会在目标集群内拉起一次性旁路 pod，通过 `sandbox-api` 的 `/internal/pools` API 更新 `base_image`，不做本地端口转发，也不直连 MySQL
- pool rollout 前先 `source deploy/envs/beijing-sandbox/platform.env`，并显式使用 `KUBECONFIG="${DEPLOY_KUBECONFIG}"`；不要依赖 shell 里残留的 `KUBECONFIG`
- 默认切 CTL 在用池 `pool-c0~pool-c5`；如果用户明确要求全量切换，再使用 `--all` 覆盖 `/internal/pools` 返回的所有 pool
- 不要通过直改数据库修改 `base_image`

### Kustomize 发布标准

- `sandbox` 的 source-facing 真源仍然是 `Kustomize`，但正式 apply 入口改为 `Argo CD`。
- 基础清单位于 `sandbox/k8s/base/`，环境差异位于 `sandbox/k8s/overlays/<env>/`。
- 集群级镜像拉取凭据由 `infra_pulumi` 在建集群时通过 TKE `tcr` addon 自动下发；不要再为 `sandbox` 单独手工复制 registry secret。
- `sandbox` namespace 的 `default ServiceAccount` 应显式挂上集群级 pull secret（当前兼容名为 `tcr.ipsqcloudregistrykey`、`tcr.ipstcr-regcred`、`tcr.ipstcr-lightclaw-secret`），避免仅依赖 addon 的异步补丁，导致新 ReplicaSet 在新节点上拉镜像失败。
- `deploy/envs/<env>/platform.env` 是 `infra_pulumi` 产出的环境事实来源；它可以包含敏感值，但不应直接作为 Kustomize ConfigMap 输入整体消费。
- 历史发布脚本曾在 `sandbox/k8s/overlays/<env>/generated/` 下生成本地输入文件：
  - `platform.env`：只保留 Kustomize replacements 需要的非敏感字段，例如 DB/Redis 地址、VPC、subnet、node pool。
  - `sandbox-runtime-secrets.env`：提供 `secretGenerator` 使用的敏感字段，例如 `MYSQL_PASSWORD`、`REDIS_PASSWORD`、腾讯云密钥。
- 这些输入以后只能作为 source-facing 参考，不再作为正式 apply 主线。
- 若目标集群不存在 `servicemonitors.monitoring.coreos.com` / `podmonitors.monitoring.coreos.com` 这两个 CRD，发布脚本会在 apply 前自动剔除 `ServiceMonitor` / `PodMonitor` 资源，不让新集群因为监控插件未安装而整体发布失败。
- 若目标集群是刚打开公网 API 访问的新集群，`kubectl apply` 在下载 OpenAPI 时偶发 `EOF`，发布脚本会自动回退到 `kubectl apply --validate=false` 再重试一次。
- 最终正式发布统一走：
  - `argocd/`
- 对新清单，优先依赖 namespace/default ServiceAccount 上的集群级 pull secret；只有在明确需要隔离时才单独写 `imagePullSecrets`。
- `ingressproxy` 的 `startupProbe` / `livenessProbe` / `readinessProbe` 统一使用 `tcpSocket`，不要再用 HTTP `/health` 或 `/ready`；kubelet/CLB 的探针 Host 可能触发 ingressproxy 的 Host 解析逻辑，导致无意义重启或一直不 Ready。
- 运行时连接数据库/Redis 的标准方式是：
  - ConfigMap 提供地址类字段：`MYSQL_HOST`、`MYSQL_PORT`、`REDIS_ADDR`
  - Secret 提供凭据类字段：`MYSQL_USER`、`MYSQL_PASSWORD`、`REDIS_PASSWORD`
- `sandbox-api`、`sandbox-worker`、`refill` 都必须支持从上述拆分变量自动拼装 MySQL DSN；不要让线上 K8s workload 退回到“只有显式 `MYSQL_DSN` 才能用 MySQL”的旧逻辑。
- 不要再把 `MYSQL_DSN` 作为测试/线上发布的主连接方式。`MYSQL_DSN` 适合本地运行，但会把环境耦合进单个字符串，容易在多 region 下串库。
- 线上数据库初始化只保留 migration job：
  - `sandbox-db-migrate-*`：只应用 `sandbox/migrations/*.sql`
- 不要再通过 K8s 发布链自动 seed/回填默认 pools；pool 属于运营态数据，应通过 API 或明确的人工 SQL 管理。
- 不要再把 schema SQL 直接内嵌进 K8s manifest。
- `sandbox-api`、`sandbox-worker`、`sandbox-worker-sharded` 应通过 initContainer 等待 schema ready，避免发布时因为 migration job 还没完成而 CrashLoop。
- `NODE_PASSWORD` 这类 infra 侧密码不属于 workload 运行时，不应下发到 Pod manifest。
- `kubectl kustomize` / `kustomize build` 的输出会包含 Secret 资源内容，只能用于本地验证，不要把生成结果提交到 Git 或散发到不受控位置。
- `sandbox/k8s/overlays/<env>/generated/` 一律视为本地生成物，不提交到 Git。

## 提交/改动建议
- 保持最小变更集，写清状态机影响范围；新增状态或字段时同步更新 README 和 API 文档（`openapi.yaml`）。
- 为易错流程补充表格/时序图，优先用 Markdown 内嵌 mermaid。
- 覆盖测试：
  - 服务层：用表驱动测试覆盖合法/非法状态转移。
  - 存储层：添加并发分配或条件更新的用例。
- 日志与错误：对外返回 `error` 字段简洁可读；内部日志保留 `pool_id`、`instance_id`、目标状态，便于排查。
- 配置/环境变量：在 README 的运行章节追加参数说明，保证一处权威。

## 文档风格
- 采用 Markdown，标题简短，段落不冗余；示例代码使用 fenced code block 并提供上下文注释。
- 中文为主，保留关键字段/常量的英文原样，避免翻译导致歧义。
- 避免大段粘贴日志或生成冗长解释，优先给出最小可复现命令。

<!-- 重新触发 CI：2026-06-04 将 sandbox/k8s/base 重新发布到 gitops，恢复 sandbox-bj-7 感知 POD_NAMESPACE 的 ingressproxy 分片路由（后被 1c0bbf021 promote 覆盖）。 -->
<!-- 重新触发 CI：2026-07-08 从最新 master 构建 sandbox shprod 镜像，用于 billing rollout。 -->
