# GitOps Beijing Wave 1 Candidates

这份文档把当前 mono 仓库里会进 Kubernetes 的服务，按“北京测试环境优先迁入 Argo CD”的顺序收成一张执行表。

排序依据沿用 [gitops-service-readiness.md](gitops-service-readiness.md) 里的 rubric，但这次额外把下面几类现实阻塞计入了优先级：

- 是否已经有 `beijing-sandbox` overlay
- 是否仍依赖本地 `generated/*`
- 是否仍依赖本地 `.secret/*`
- 是否包含 migration / seed job
- 是否承载公网入口
- 是否和别的命名空间或平台能力强耦合

## Summary

### Wave 1

- `nextgen-dashboard`
- `gateway-dashboard`
- `admin-gateway`

### Wave 2

- `payment`
- `subscription`
- `ai-gateway`

### Wave 3

- `service-gateway`
- `user/auth`

### Wave 4

- `ctl`
- `sandbox`

### Not Beijing-ready Yet

- `frontend`
- `frontend-ds`

## Ranking

| Service | Recommended wave | Current judgment | Main blockers before Argo primary |
| --- | --- | --- | --- |
| `nextgen-dashboard` | Wave 1 | 最适合先做北京首个正式服务试点 | `generated/platform.env`、`generated/nextgen-dashboard-runtime-secrets.env`、仍依赖本地 `.secret/nextgen-dashboard/test.env`、当前直接落在 `user-auth` namespace |
| `gateway-dashboard` | Wave 1 | 复杂度低于业务后端，但有环境耦合 | `generated/platform.env`、`generated/gateway-dashboard-runtime-secrets.env`、仍依赖本地 `.secret/gateway-dashboard/test.env`、当前直接落在 `ai-gateway` namespace |
| `admin-gateway` | Wave 1 | 结构还算单纯，但已经承接公网入口 | `generated/config.yaml`、`generated/platform.env`、`generated/admin-gateway-runtime-secrets.env`、仍依赖本地 `.secret/admin-gateway/test.env`、需要把公网 host/TLS/image pin 收进 deploy-facing artifact |
| `payment` | Wave 2 | 业务面不大，但带 migration job | `generated/platform.env`、`generated/payment-runtime-secrets.env`、仍依赖本地 `.secret/payment/test.env`、迁移 job 名称和镜像仍由脚本注入 |
| `subscription` | Wave 2 | 和 `payment` 同类，稍多一点跨服务依赖 | `generated/platform.env`、`generated/subscription-runtime-secrets.env`、仍依赖本地 `.secret/subscription/test.env`、迁移 job 仍由脚本注入 |
| `ai-gateway` | Wave 2 | 后端能力多，已有 migration 和内部入口 | `generated/config.yaml`、`generated/platform.env`、`generated/ai-gateway-runtime-secrets.env`、仍依赖本地 `.secret/ai-gateway/test.env`、内部 ingress / LB 绑定还在脚本路径上 |
| `service-gateway` | Wave 3 | 核心公网入口，不适合首批 | `generated/config.yaml`、`generated/platform.env`、`generated/service-gateway-runtime-secrets.env`、仍依赖本地 `.secret/service-gateway/test.env`、公网 host/TLS/CLB 配置仍由脚本和 overlay replacement 收敛 |
| `user/auth` | Wave 3 | 用户身份入口，带 migration + seed | `generated/platform.env`、`generated/lightclaw-auth-secrets.env`、仍依赖本地 `.secret/user-auth/test.env`、migration job / seed job 名称仍由脚本注入 |
| `ctl` | Wave 4 | 结构最重的控制面之一 | `generated/ctl-migrations-configmap.yaml`、`generated/common/server_conf.toml`、`generated/rewrite/server_conf_rewrite.toml`、`generated/platform.env`、多份 runtime secret、仍依赖 `.secret/ctl/test.env`，还回读别的服务 secret 和 `deploy/envs/<env>/platform.env` |
| `sandbox` | Wave 4 | 当前 blast radius 最大，不应首批迁入 | `generated/platform.env`、`generated/sandbox-runtime-secrets.env`、仍依赖 `.secret/sandbox/test.env`、多组 ingressproxy、Stateful/网络资源、pool/subnet/TLS 强耦合 |
| `frontend` | Not Beijing-ready yet | 结构本身不重，但现在没有北京 overlay | 只有 `shprod` overlay；北京环境还没有 `frontend/k8s/overlays/beijing-sandbox/` |
| `frontend-ds` | Not Beijing-ready yet | 当前不在北京目标范围 | 只有 `shprod` overlay；而且脚本仍依赖 `.secret/frontend/test.env` 和 `generated/platform.env` |

## Why Wave 1 Looks Like This

### `nextgen-dashboard`

- 优点：
  - 已有 `base + overlays/beijing-sandbox`
  - 没有 migration job
  - 没有公网 ingress 入口
  - 主要只是 image、node pool、secret、redeploy timestamp 注入
- 风险：
  - 现在直接使用 `user-auth` namespace，这个边界不够清楚
- 结论：
  - 最适合当北京首个“正式迁入 Argo”的服务，但迁入前应先决定是否保留这个 namespace 耦合
  - 已有首版 cutover 骨架可继续收敛：
    - [nextgen-dashboard-argocd-cutover.md](nextgen-dashboard-argocd-cutover.md)

### `gateway-dashboard`

- 优点：
  - 已有 `base + overlays/beijing-sandbox`
  - 没有 migration job
  - 只有内部 Service，没有公网 Ingress
- 风险：
  - 当前在 `ai-gateway` namespace
  - 配置里依赖多个上游 URL，意味着它不是纯静态前端
- 结论：
  - 适合作为 Wave 1 第二个服务，用来验证“多上游 URL 配置 + SSM/sops secret”这类中等复杂度模式

### `admin-gateway`

- 优点：
  - 结构仍然是单 Deployment 为主
  - 已有北京 overlay
- 风险：
  - 已经是公网入口
  - 当前还依赖 `generated/config.yaml` 和公网 host/TLS 注入
- 结论：
  - 可以进 Wave 1，但不应作为第一个正式 cutover 服务

## Recommended Beijing Cutover Order

1. `nextgen-dashboard`
2. `gateway-dashboard`
3. `admin-gateway`
4. `payment`
5. `subscription`

这条顺序的意图很明确：

- 先验证低 blast radius 的 Deployment/Secret/Image pin 收敛
- 再验证带更多配置替换的服务
- 最后才碰 migration job、内部 LB、公网入口和身份链路

## Per-service Exit Conditions

服务只有满足下面条件，才允许从“候选”进入“可 cutover”：

- deploy artifact 已收进 `argocd/`
- image pin 已进 Git，而不是继续由脚本临时拼接
- secret 已从本地 `.secret/*` 迁到 `SSM -> sops`
- 不再依赖本地 `generated/*` 作为 Argo 必需输入
- 北京 Argo root app 已接入对应 `Application`
- 至少一次通过 `git revert + Argo sync` 完成回滚演练

## Immediate Next Actions

1. 先对 `nextgen-dashboard` 做一次 Argo-ready 收敛：
   - 把 runtime secret 改成 `SSM -> sops`
   - 把 image pin 收进 deploy-facing artifact
   - 决定是否继续复用 `user-auth` namespace
2. 再对 `gateway-dashboard` 做同样动作：
   - 特别确认 `ai-gateway` namespace 耦合是否保留
3. `admin-gateway` 只在前两个服务稳定后再切：
   - 因为它已经碰公网入口
