# Sandbox Agent Guide

本文件约束 `sandbox` 的开发与运维入口。涉及 `sandbox` 代码、Pool 状态机、测试环境镜像切换时，Agent 应先阅读本文件。

相关补充文档：

- 发布与测试环境 rollout： [docs/deploy-guides/sandbox-deploy-guide.md](../deploy-guides/sandbox-deploy-guide.md)
- Pool 镜像切换背景说明： [docs/developer-guide/sandbox-pool-image-update.md](../developer-guide/sandbox-pool-image-update.md)
- 镜像版本台账： [docs/developer-guide/sandbox-image-version-inventory.md](../developer-guide/sandbox-image-version-inventory.md)
- 镜像清理指引： [docs/developer-guide/sandbox-image-cleanup-guide.md](../developer-guide/sandbox-image-cleanup-guide.md)
- 镜像切换实操： [docs/agent-guides/sandbox-image-rollout-guide.md](sandbox-image-rollout-guide.md)
- 镜像构建入口： [images/README.md](../../images/README.md)
- 镜像构建/运行时约束： [docs/agent-guides/sandbox-image-agent-guide.md](sandbox-image-agent-guide.md)

## 1. 关键不变量

- 状态机是唯一可信事实来源：`CREATING -> CLEAN -> ALLOCATED -> DRY -> RESETTING -> CLEAN`
- 请求路径只做分配与释放，不做创建或重装
- 切 pool 镜像时，只允许把 `CLEAN` 标成 `DRY`，`ALLOCATED` 不应被强改
- 测试环境切 pool 镜像的唯一标准入口是 `.codebuddy/skills/sandbox-ops` 的 SQL fallback；不要再尝试已删除的 pool API / `sandbox/scripts/update-image.sh`

## 2. 目录入口

- `sandbox/cmd/server`: API 入口
- `sandbox/cmd/worker`: 组合 worker，负责 refill/reset/cleanup/waterline
- `sandbox/k8s/base/manifests.yaml`: sandbox-api、sandbox-worker、sandbox-worker-sharded 的基础运行清单
- `sandbox/k8s/overlays/<env>/`: 按环境发布的 Kustomize overlay
- `argocd/`: sandbox 正式发布入口（纳管完成后）
- `sandbox/scripts/dev-compose.sh`: 本地 docker compose 入口，会先加载 `.secret/sandbox/local.env`
- `images/build-image.py`: 生成新的 sandbox 基础镜像 / 应用层镜像
- `docs/agent-guides/sandbox-image-agent-guide.md`: 镜像分层、TAT 验收和 OpenClaw/gateway 不变量

## 3. 运维规则

- 当前测试环境的 pool rollout API 已删除；不要再尝试 `GET /pools`、`PATCH /pools/{id}` 或 `sandbox/scripts/update-image.sh`
- 测试环境切 pool 镜像时，统一按 `.codebuddy/skills/sandbox-ops` 的 SQL fallback 执行：更新 `pools.base_image`，并只把目标 pool 的 `CLEAN` 实例标成 `DRY`
- 在测试环境执行 fallback 时，优先显式绑定 `KUBECONFIG="${DEPLOY_KUBECONFIG}"`，避免误用 shell 里残留的其他集群上下文
- 如果需要临时 reset worker，运行参数应从现网 `sandbox-worker` deployment 派生，不要硬编码镜像 tag、hostAliases 或 envFrom
- 如果 rollout 后需要观察库存恢复，优先看目标 pool 的 `DRY` / `RESETTING` 是否归零，而不是只看 Pod 是否存活
- 本地敏感配置统一放在 `.secret/sandbox/local.env`
- 测试环境敏感配置统一放在 `.secret/sandbox/test.env`；当前主要提供腾讯云密钥、可选 `MYSQL_USER`，以及每个默认 pool 显式的 `SANDBOX_POOL_*_SECURITY_GROUPS`；MySQL/Redis 密码由 `platform.env` 统一下发
- 本地 e2e 同样读取 `.secret/sandbox/local.env`，入口是 `sandbox/scripts/e2e/run.sh`

## 4. 推荐操作顺序

0. 确认 `.secret/sandbox/test.env` 已更新到目标真实值
1. 用 `images/build-image.py` 产出新的北京地域镜像 ID
1.5. 如需初始化或回写默认 pools，使用 `ENV=<env> bash sandbox/scripts/sync-default-pools.sh --base-image <img-id>`，不要再依赖 K8s 自动 seed 或单个全局 sandbox SG
2. 用 `# 在仓库根目录下执行
   source deploy/envs/<env>/platform.env && KUBECONFIG="${DEPLOY_KUBECONFIG}" bash .codebuddy/skills/sandbox-ops/scripts/query_pool_status.sh 'pool-%'` 查看当前 pools
3. 按 `.codebuddy/skills/sandbox-ops` 的 SQL fallback 更新目标 pools 的 `base_image`
4. 默认按 CTL 在用池全量切换（`default_template_id + candidate_template_ids`，当前测试环境为 `pool-c0,pool-c1,pool-c2,pool-c3,pool-c4,pool-c5`）
5. 若现场确认 `pool-bj8` 也承载 CTL 流量，或用户明确要求“所有 pool 一起切”，再扩展覆盖 `pool-bj8,pool-c0,pool-c1,pool-c2,pool-c3,pool-c4,pool-c5`
5. 回填完成后，观察 `DRY` / `RESETTING` 是否归零

## 5. Review Checklist

- 是否说明了当前测试环境 pool rollout API 已删除，不能再尝试 `GET /pools` / `PATCH /pools/{id}`
- 是否在 fallback 中只更新目标 pool 的 `base_image`，并仅把 `CLEAN` 标成 `DRY`
- 是否避免了硬编码现网 worker 镜像/hostAliases
- 若给出示例，是否体现“默认切 CTL 在用池全量、按需扩展到 `pool-bj8`”
- 若修改了部署或 rollout 方式，是否同步更新本文件和 deploy guide
