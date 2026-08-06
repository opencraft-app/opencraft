# workers / shprod overlay

上海正式环境（`shprod` 集群）下 `website-deployer` 的 **source-facing** overlay。

## 这个 overlay 与 `shanghai-workers` 的本质区别

| 维度 | `shanghai-workers` | `shprod`（本目录） |
|---|---|---|
| 工作负载类型 | Temporal `WorkerDeployment` CRD | 普通 `apps/v1 Deployment` |
| 集群 | `cls-56a1mbml`（装了 `temporal-worker-controller`） | `shprod` |
| namespace | `temporal-workers` | `ctl` |
| 依赖 | 公网 `temporal.lightvela.com:443` | 集群内 ctl-api + VPC 内 Redis |

**不要把 `shanghai-workers/*/worker-deployment.yaml` 的形态照抄过来。**
`website-deployer` 与 Temporal 完全无关（北京把它放在名为 `temporal-workers`
的 namespace 里纯粹是复用了命名空间名字）。

## 为什么落在 `shprod` 集群的 `ctl` namespace

`website-deployer` 有两条**集群内网/VPC 内**的强依赖：

1. `CTL_BASE_URL` = `http://ctl-api.ctl.svc.cluster.local`。这是 Kubernetes 集群内
   DNS，跨集群解析不了。
2. Redis `BLPOP website:operations:pending`。Redis 同时承担跨 Pod 的 COS 上传令牌桶，
   是 fail-closed 的强依赖：ping 失败默认直接 `log.Fatalf`。

ctl 与它的 Redis / MySQL 都在 `shprod` 集群及其 VPC 内，所以就近部署是唯一没有
未验证网络前提的路径。选 `ctl` namespace 而不是新建 namespace，是因为现有的三个
实例级 TCR pull secret（`tcr.ips*`）只存在于既有 namespace 内，跨 namespace 复制
Secret 不在 GitOps 里，会多出一个不可见依赖。

这是**运行位置**的耦合，不是**发布归属**的耦合：发布归属由独立的 Argo
Application / AppProject / SOPS secret / 流水线保证。

## 镜像 pin 走哪里

- 本目录的 `website-deployer/generated/platform.env` 只用于本地渲染，不提交真值。
- 真正生效的 pin 文件是
  `argocd/services/workers-website-deployer/shprod/workers-platform.env`（`WORKERS_IMAGE`），
  由 `.ci/workers-website-deployer.yml` 的 promote 流程写入。
- 这条通道与 `.ci/workers.yml`（shanghai-workers）**互相独立**，两处的 workers 镜像
  版本可以不同，这是"独立发布通道"的固有语义。

## 与 deploy-facing 目录的同步义务

`argocd/services/workers-website-deployer/shprod/` 下的 `deployment.yaml` /
`serviceaccount.yaml` 是本目录对应文件的副本。**改这里必须同步改那里**，
否则 Argo 收敛的是旧内容。

## 本地渲染

```bash
cp workers/k8s/overlays/shprod/website-deployer/generated/platform.env.example \
   workers/k8s/overlays/shprod/website-deployer/generated/platform.env
kustomize build workers/k8s/overlays/shprod
```

## 生产只读验证

```bash
kubectl -n ctl get deploy website-deployer
kubectl -n ctl get pods -l app=website-deployer
kubectl -n ctl logs -l app=website-deployer --tail=100
```

健康日志应出现：

```
website-deployer connected to Redis at <addr>
website-deployer starting: concurrency=2, redis=true, fallback_poll=10s
```

故障对照：

| 日志 | 含义 |
|---|---|
| `requires WEBSITE_INTERNAL_API_TOKEN` | `website-deployer-secrets` 缺 key 或仍是占位符被清空 |
| `requires Redis for the global COS upload limiter` | `REDIS_ADDR` / `REDIS_PASSWORD` 未替换真值 |
| `TCB_ENV_ALLOWLIST is empty; website deployer is disabled` | allowlist 未配（等 TCB 采购） |

## 资源配置依据

`replicas: 1` + `MAX_CONCURRENCY: 2` + `memory limit 512Mi`。

业务量级每周约 500 用户 ≈ 每天 70 个 ≈ 每 10 分钟 1 个；建站 Skill 默认推荐 AI 生成
单文件站点，部署亚秒级，**实际并发几乎恒为 1**。峰值内存约为
`MAX_CONCURRENCY × WEBSITE_MAX_ARTIFACT_BYTES(64MB)` = 128MB。
对照 shprod ctl 三进程实测内存 16Mi / 9Mi / 9Mi，512Mi 已是过量供给。

**调大 `MAX_CONCURRENCY` 必须同步调大 memory limit**，否则会 OOMKilled。
