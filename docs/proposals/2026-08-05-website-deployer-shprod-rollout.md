# website-deployer 上生产 — 独立服务 + 独立发布通道

> 日期：2026-08-05
> 状态：**A/B/C/E/F 已执行落地**（见文末 §十三 执行勘误）；D 组凭据待受保护流程
> 上线 runbook：`docs/runbooks/website-deployer-shprod-rollout.md`
> 关联需求：CloudBase 静态建站一期（TAPD `1010132091136767992`）
> 读者：mentor（架构评审）+ 执行者（照单做配置）

## 一句话

`website-deployer` 保持**独立服务**，为它在上海正式环境（`shprod`）建立**完整的、归属自己的 GitOps 发布通道**：独立 source overlay、独立 deploy-facing 目录、独立 Argo Application 与 AppProject、独立 SOPS secret、独立发布流水线。**Go 代码零改动**，工作量集中在配置与凭据。

---

## 零、先讲清楚：服务已经存在，开发量为零

本方案**不新写任何服务**。`website-deployer` 是已经写完、已经在北京 sandbox 跑通全链路验证的独立程序：

| 事实 | 举证 |
|---|---|
| 独立 main 包已存在 | `workers/cmd/website-deployer/main.go`（181 行，含 Redis BLPOP 主路径 + 定时 fallback poll + 优雅退出） |
| 业务逻辑已存在 | `workers/internal/website/deployer.go`、`workers/internal/website/tcb_env.go` |
| 镜像里已经有这个二进制 | `workers/Dockerfile:12` `go build ... -o /out/website-deployer ./cmd/website-deployer`；`workers/Dockerfile:21` `COPY --from=builder /out/website-deployer /usr/local/bin/website-deployer` |
| 北京线上正在运行 | 只读核对：`temporal-workers` namespace 下 `website-deployer` `1/1 Ready`，Deployment revision 已到 34 |
| 镜像仓库已覆盖 shprod | `.ci/runtime/bundles/workers.bundle:47` 已有 `shprod: lightclaw-shprod.tencentcloudcr.com/lightclaw/workers` |

所以本文的全部内容是**生产发布配置**，不是开发。凡是看起来像"要写代码"的地方，都是 YAML。

链路形态（不变）：`service-gateway` → `ctl`（编排 / 配额 / 状态机）→ Redis 队列 + DB 持久重试 → `website-deployer`（解压制品、传 COS / TCB 静态托管）。

---

## 一、必须先拍板的前置问题：部署到哪个集群

**这是本文唯一真正的架构决策点，它决定后面所有配置的形态。请 mentor 与运维先在这一节达成结论。**

### 约束来源

worker 有两条**集群内网**依赖：

1. `CTL_BASE_URL` 默认 `http://ctl-api.ctl.svc.cluster.local`（`workers/internal/website/deployer.go:47`，北京 overlay 显式写死同一地址：`workers/k8s/overlays/beijing-sandbox/website-deployer/deployment.yaml:46-47`）。这是 Kubernetes 集群内 DNS，**跨集群解析不了**。
2. Redis `BLPOP website:operations:pending`（`workers/cmd/website-deployer/main.go:129`），且 Redis 是 fail-closed 的强依赖——它同时承担跨 Pod 的 COS 上传令牌桶，ping 失败默认直接 `log.Fatalf`（`main.go:46-52`），只有显式 `WEBSITE_REQUIRE_REDIS_LIMITER=false` 才降级启动。

ctl 与其 Redis / MySQL 都在 `shprod` 集群及其 VPC 内。

### 选项 1（推荐）：部署到 shprod 集群的 `ctl` namespace

**为什么推荐**：代码零改动、无网络前置条件、无需运维介入、当天可自证。

已核对的支撑事实（全部来自 shprod 只读查询与仓库文件）：

- `shprod` 集群现有 namespace 中**没有** `temporal-workers`，也没有任何 website 相关工作负载（`kubectl get deploy -A | grep -i website` 为空）。所以不存在冲突，只是要新建。
- `ctl` namespace 的 `default` ServiceAccount 已挂三个实例级 TCR pull secret：`tcr.ipsqcloudregistrykey`、`tcr.ipstcr-regcred`、`tcr.ipstcr-lightclaw-secret`。ctl 三个 Deployment 自身 `imagePullSecrets` 为空，靠的就是这个默认 SA。**同一 TCR 实例换 repo 路径（`lightclaw/ctl` → `lightclaw/workers`）按实例级凭据语义应当覆盖，但首次 pull 才能证实。**
- 同集群同 namespace ⇒ `http://ctl-api.ctl.svc.cluster.local` 原样可用；Redis / MySQL 同 VPC。
- 两侧 Redis 都用 DB 0（`ctl/pkg/resource/redis.go:48`、`workers/cmd/website-deployer/main.go:30`），队列 key 两侧同为 `website:operations:pending`，BLPOP 能对上。

**它的代价（必须如实呈现给 mentor）**：

- **违反"worker 类服务放 `shanghai-workers`"的既有部署惯例。** 仓库里 `workers/k8s/overlays/` 当前只有 `beijing-sandbox` 和 `shanghai-workers` 两个目录，没有 `shprod`；`.ci/workers.yml:31` 的 `MASTER_BUILD_ENVS` 是 `beijing-sandbox,shanghai-workers`，也不含 `shprod`。选项 1 等于确立"worker 可以按依赖就近落集群"的第二种模式。
- 需要新建 `workers/k8s/overlays/shprod/` 与新的发布流水线（下面清单里的绝大部分条目都是为此）。
- 选 `ctl` namespace 会让"ctl 的 namespace 里长出一个 workers 镜像的工作负载"。这是**运行位置**的耦合，不是**发布归属**的耦合——发布归属由独立的 Argo Application / AppProject / 流水线保证，这正是本方案与已否决的"寄生在 `argocd/services/ctl/shprod/`"方案的本质区别。
- 也可以在 shprod 新开一个专用 namespace（如 `website-deployer`）。但那样必须为新 namespace 另行准备 TCR pull secret（现有 `tcr.ips*` 只存在于 `ctl` 等既有 namespace 内），而 Secret 的跨 namespace 复制不在 GitOps 里，反而增加一个不可见依赖。**建议先用 `ctl` namespace，二期若要拆再拆。**

### 选项 2：部署到 shanghai-workers 集群

**符合惯例，但有两条未验证的网络前置，且无法在只读条件下确认。**

- `shanghai-workers` 是独立 TKE 集群：`argocd/clusters/shanghai-workers.yaml`（`cls-56a1mbml`）。
- 该集群现有两个 worker（`rescue-exporter` / `hermes-importer`）**从未连接 shprod VPC 内的任何东西**：`envFrom` 只有 `workers-runtime-secrets`，该 SOPS 文件仅 4 个 key（`TEMPORAL_BEARER_TOKEN`、`TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY`、`RESCUE_PASSWORD`），唯一后端地址是公网域名 `temporal.lightvela.com:443`（`workers/k8s/overlays/shanghai-workers/shared/connection.yaml`）。**没有现成的内网访问范式可照抄。**
- 已知 ctl 侧存在一个**内网 CLB Service** `ctl-api-internal`（`ctl/k8s/base/manifests.yaml:416-425`，`type: LoadBalancer` + `qcloud-loadbalancer-internal-subnetid` 注解，subnet 由 `ctl-platform.env` 的 `CTL_INTERNAL_SUBNET_ID` 注入），可作为跨集群入口。但 Redis **没有**对应的内网入口，要打通的是**两条**链路。
- **VPC 对等关系无法在只读条件下确认**：本机无该集群 kubeconfig；仓库内无其 VPC 定义；`argocd/clusters/shanghai-workers.yaml` 的 `owner: deploy/terraform/temporal-worker-controller-tke` 指向的目录在本仓库中不存在。
- 该集群装的是 `temporal-worker-controller`，现有 worker 用 Temporal 官方 `WorkerDeployment` CRD（`workers/k8s/overlays/shanghai-workers/README.md`、`rescue-exporter/worker-deployment.yaml:1-2`）。**`website-deployer` 是普通 `apps/v1 Deployment`，与 Temporal 无关，不能照抄该形态**；`README.md:83-86` 还明确写了"不要把 plain Deployment apply 进这个集群"。也就是说选项 2 既要打通网络，又要在一个 CRD-first 的集群里破例塞一个 plain Deployment。

**配置改动量对比**：选项 2 的 YAML 条目数与选项 1 基本相同（只是 env 名从 `shprod` 换成 `shanghai-workers`，且 `.ci/workers.yml` 已含该 env 可省掉一条），但**额外背上两条待运维确认的内网链路**；若 VPC 未对等，需要开 VPC 对等或 CCN，属生产网络变更。

### 结论建议

**选选项 1。** 理由排序：(a) 唯一没有不确定前提的路径；(b) 代码零改动；(c) 不需要运维在关键路径上做生产网络变更；(d) 违反的只是一条**惯例**，而惯例的初衷（worker 集中管理）在只有一个 worker、且它的依赖全在另一个集群时并不成立。

**若 mentor 坚持选项 2**，请先让运维回答两个问题再动手：`shanghai-workers` 与 `shprod` VPC 是否已对等/CCN 互通？是否允许在该集群部署非 Temporal 的 plain Deployment？两个都是"是"，再按同一份清单把 env 名换掉即可。

---

## 二、一个调研中发现的、影响方案形态的 CI 事实

**不能简单地往 `.ci/workers.yml` 的 `BUNDLE` 里追加一个 pin target。必须新建独立流水线。**

举证链：

- `.ci/workers.yml:28` `BUNDLE: workers-rescue-exporter,workers-hermes-importer`。这个参数名叫 BUNDLE，实际语义是 **pin targets 列表**（`.ci/runtime/pin_image_to_gitops.sh:24` `SERVICE_ARG="$2"`，`.ci/runtime/tests/contract_tests/test_release_gates.py:111` 也直接叫 `pin_targets`）。
- pin target 列表是**环境无关的扁平列表**：`.ci/runtime/gitops/image_pin.py:23-30` 按 `argocd/services/<pin-target>/<env>/*-platform.env` 定位文件；`.ci/runtime/gates/config.py:179-182` 对**每一个** pin target 强制要求 `argocd/services/<pin-target>/<env>/kustomization.yaml` 存在，缺失即发布门禁失败。
- 因此若把 `workers-website-deployer` 加进现有 `BUNDLE`，`shanghai-workers` 的 auto-pin 会因为找不到 `argocd/services/workers-website-deployer/shanghai-workers/` 而失败；反之给 shprod promote 又会找不到 `argocd/services/workers-rescue-exporter/shprod/`。
- 另有两个契约测试把现有值写死：`test_release_bundle_contracts.py:314` 断言 `BUNDLE == "workers-rescue-exporter,workers-hermes-importer"`；`:974-977` 断言它等于 `workers/catalog.yaml` 中 `shanghai-workers` 环境下所有 worker 的 `serviceId` 拼接。

**这恰好与"建独立发布通道"的决策同向**：新增 `.ci/workers-website-deployer.yml`，`SERVICE: workers`（沿用 workers 镜像 bundle）、`BUNDLE: workers-website-deployer`（只含自己的 pin target）、`MASTER_BUILD_ENVS: shprod`、`MASTER_AUTO_PIN_ENVS: none`。这样两条通道互不干扰，上面两个契约测试也不会被破坏。

---

## 三、改动清单

共 **22 项必做 + 2 项可选**。按执行顺序分组。其中 A–C 是纯 YAML，D 需要腾讯云 SSM 与 sops 权限，E 需要 CI 侧 review。

### A. source-facing overlay（新建 6 个文件）

模板对象：`workers/k8s/overlays/beijing-sandbox/website-deployer/`（形态最接近）+ `workers/k8s/overlays/shanghai-workers/`（目录分层与 `generated/` 约定）。
**注意：不要照抄 `shanghai-workers` 的 `WorkerDeployment` CRD**，`website-deployer` 是 `apps/v1 Deployment`。

| # | 文件 | 内容 |
|---|---|---|
| A1 | `workers/k8s/overlays/shprod/kustomization.yaml` | 新建。`resources: [website-deployer]`。参照 `workers/k8s/overlays/beijing-sandbox/kustomization.yaml` |
| A2 | `workers/k8s/overlays/shprod/website-deployer/kustomization.yaml` | 新建。`namespace: ctl`；`resources: [serviceaccount.yaml, deployment.yaml]`；`generatorOptions.disableNameSuffixHash: true`；`configMapGenerator` 生成 `workers-platform-values`（`envs: [generated/platform.env]`）；`replacements` 把 `data.WORKERS_IMAGE` 注入 `Deployment website-deployer` 的 `spec.template.spec.containers.[name=website-deployer].image`。参照 `workers/k8s/overlays/shanghai-workers/rescue-exporter/kustomization.yaml:18-28` |
| A3 | `workers/k8s/overlays/shprod/website-deployer/serviceaccount.yaml` | 新建。`ServiceAccount website-deployer`，`imagePullSecrets` 列 `tcr.ipsqcloudregistrykey` / `tcr.ipstcr-regcred` / `tcr.ipstcr-lightclaw-secret`（这三个名字已在 shprod `ctl` namespace 中存在，只读核对过） |
| A4 | `workers/k8s/overlays/shprod/website-deployer/deployment.yaml` | 新建，约 70 行。`apps/v1 Deployment`，`replicas: 1`，`revisionHistoryLimit: 3`，`terminationGracePeriodSeconds: 30`，`nodeSelector.pool` 用占位符（shprod 现有节点池标签取自 `argocd/services/ctl/shprod/ctl-platform.env` 的 `CTL_NODE_POOL`），`command: [/usr/local/bin/website-deployer]`，env 见 §4，resources 见 §5 |
| A5 | `workers/k8s/overlays/shprod/website-deployer/generated/platform.env.example` | 新建。只含 `WORKERS_IMAGE=lightclaw-shprod.tencentcloudcr.com/lightclaw/workers:bootstrap`。`generated/` 是本地渲染用、不提交真值，沿用 `workers/k8s/overlays/shanghai-workers/*/generated/platform.env.example` 约定 |
| A6 | `workers/k8s/overlays/shprod/README.md` | 新建。说明：这是 plain Deployment 不是 WorkerDeployment；为什么落在 shprod 集群的 `ctl` namespace（依赖集群内 DNS 与 Redis）；镜像 pin 走哪个文件；`kubectl` 验证命令 |

### B. deploy-facing 目录（新建 6 个文件）

模板对象：`argocd/services/workers-rescue-exporter/shanghai-workers/`（目录形态、`workers-platform.env` 命名、README 结构）+ `argocd/services/workers-runtime/shanghai-workers/ksops-secret-generator.yaml`（ksops 写法）。

| # | 文件 | 内容 |
|---|---|---|
| B1 | `argocd/services/workers-website-deployer/shprod/kustomization.yaml` | 新建。A2 的 deploy-facing 副本，差别是 `configMapGenerator.envs` 指向同目录 `workers-platform.env`（不是 `generated/`），并追加 `generators: [ksops-secret-generator.yaml]` |
| B2 | `argocd/services/workers-website-deployer/shprod/serviceaccount.yaml` | 新建。A3 的副本 |
| B3 | `argocd/services/workers-website-deployer/shprod/deployment.yaml` | 新建。A4 的副本 |
| B4 | `argocd/services/workers-website-deployer/shprod/workers-platform.env` | 新建。`WORKERS_IMAGE=<bootstrap tag>` + `WORKERS_DEPLOYED_AT=<ts>`。**文件名必须以 `-platform.env` 结尾且目录内唯一**——pin key 由文件名推导（`.ci/runtime/gitops/image_pin.py:33-36`：`workers-platform.env` → `WORKERS_IMAGE`） |
| B5 | `argocd/services/workers-website-deployer/shprod/ksops-secret-generator.yaml` | 新建。`viaduct.ai/v1 ksops`，`files: [../../../secrets/shprod/website-deployer-secrets.sops.yaml]`。相对深度与 `argocd/services/workers-runtime/shanghai-workers/ksops-secret-generator.yaml` 一致 |
| B6 | `argocd/services/workers-website-deployer/shprod/README.md` | 新建。参照 `argocd/services/workers-rescue-exporter/shanghai-workers/README.md`：列出 AppProject / App / 镜像 pin 文件 / secret 来源 / 与 source overlay 的同步义务 |

### C. Argo 纳管（新建 2 个 + 改 1 个）

| # | 文件 | 内容 |
|---|---|---|
| C1 | `argocd/apps/shprod/workers-website-deployer.yaml` | 新建 Application。`metadata.name: workers-website-deployer-shprod`；`spec.project: shprod-workers-website-deployer`；`source.repoURL: git@git.woa.com:wisp/mono2.git`；`source.targetRevision: gitops`；`source.path: argocd/services/workers-website-deployer/shprod`；`destination.namespace: ctl`、`destination.name: shprod`。**绝对不要加 `syncPolicy.automated`**（`argocd/apps/shprod/README.md:21` 明确禁止，且静态校验之外这是发布安全边界）。形态参照 `argocd/apps/shprod/ctl.yaml` |
| C2 | `argocd/projects/shprod-workers-website-deployer.yaml` | 新建 AppProject。参照 `argocd/projects/shprod-ctl.yaml`：`sourceRepos` 只列 mono2；`destinations: [{namespace: ctl, name: shprod}]`；`clusterResourceWhitelist` / `namespaceResourceWhitelist` 全通。<br>*（也可以复用 `shprod-ctl` project 省掉这个文件，但那会把发布归属重新绑回 ctl，与本次决策相悖。）* |
| C3 | `argocd/apps/shprod/README.md` | 改。在"当前已切 live deploy-facing 入口的服务"与"leaf projects"两个列表各加一行 |

> 静态校验会检查这一层：`.ci/runtime/gitops/gitops_static_validation.py:328-361` 对 `shprod` 走 `validate_direct_apps`，遍历 `argocd/apps/shprod/*.yaml` 逐个校验 `repoURL` / `targetRevision == gitops` / `source.path` 形如 `argocd/services/<svc>/shprod` 且其下有 `kustomization.yaml`。C1 按上表填就能过。

### D. 凭据（新建 2 个 + 改 2 个）

**这一组是唯一需要腾讯云 SSM 与 sops age key 权限的部分，也是最容易被漏掉的部分。**

流程真源（`argocd/secrets/README.md:10`、`argocd/secrets/shprod/README.md:17-19`）：**长期权威真源是腾讯云 SSM，Git 里的 `*.sops.yaml` 只是 deployable snapshot。** 正规做法是先改 SSM，再用脚本导出：

```bash
python3 scripts/export_ssm_to_sops.py \
  --manifest scripts/ssm_manifest.ctl.shprod.yaml \
  --only ctl-runtime-secrets
python3 scripts/scan_secrets.py argocd/secrets/shprod/ctl-runtime-secrets.sops.yaml
```

直接 `sops <file>` 手工编辑在技术上可行（`argocd/services/workers-rescue-exporter/shanghai-workers/README.md:21-25` 就是这么写的，而且 `argocd/secrets/shanghai-workers/workers-runtime-secrets.sops.yaml` 确实**没有**对应的 `scripts/ssm_manifest.workers.*.yaml`——说明它是手工加密的），**但会让 Git 里的值与 SSM 漂移**。本方案建议走 SSM 路径，并为新 secret 补一份 manifest。无论哪条路径，**提交前必须跑 `python3 scripts/scan_secrets.py <file>`**。

| # | 文件 | 内容 |
|---|---|---|
| D1 | `argocd/secrets/shprod/ctl-runtime-secrets.sops.yaml` | 改。新增 4 个 key：`WEBSITE_INTERNAL_API_TOKEN`、`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TCB_ENV_ALLOWLIST`（+ 可选 `TCB_ENV_CAPACITY_MAP`）。**已只读核对：该文件当前 12 个 key（`CTL_DB_PASSWORD`、`CTL_REDIS_PASS`、`CTL_INTERNAL_TOKEN`、`CTL_AIGATEWAY_INTERNAL_SERVICE_TOKEN`、6 个 `CTL_LLMGATEWAY_*`、…），这 4 个一个都没有**；shprod live `ctl-api` 的 env 里也没有（只有 `SHADOW_*` / `LIGHTVELA_SITE_KIND` / 2 个 `CTL_LLMGATEWAY_*`）。**即使本次不部署 worker，ctl 自己也必须有这 4 项，否则建站分配环境直接 fail-closed**（`ctl/pkg/logic/website/tcb_env.go:201-204`：allowlist 为空即禁用静态站点分配） |
| D2 | `scripts/ssm_manifest.ctl.shprod.yaml` | 改。把 `TCB_ENV_ALLOWLIST` / `TCB_ENV_CAPACITY_MAP` 追加到 `items[ctl-runtime-secrets].plaintext_keys`（现有 6 个 `CTL_LLMGATEWAY_*` 就是这么处理的，见该文件 38-45 行注释："策略必须始终存在且可 review"）。这两项是运营策略不是凭据，明文入库便于评审 |
| D3 | `argocd/secrets/shprod/website-deployer-secrets.sops.yaml` | 新建。`kind: Secret`、`metadata.name: website-deployer-secrets`、`metadata.namespace: ctl`。key：`WEBSITE_INTERNAL_API_TOKEN`（必须与 D1 中 ctl 侧同值）、`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`REDIS_ADDR`、`REDIS_PASSWORD`。<br>**`REDIS_ADDR` 建议放 secret 而不是明文 env**：它是 VPC 内网地址，不该进 Git 明文；取值必须来自 ctl 现有配置（`argocd/secrets/shprod/ctl-conf-common.sops.yaml` 里的 `server_conf.toml`）解密后的 Redis 地址，**不要凭猜**。`REDIS_PASSWORD` 与 `ctl-runtime-secrets/CTL_REDIS_PASS` 同值 |
| D4 | `scripts/ssm_manifest.workers-website-deployer.shprod.yaml` | 新建。参照 `scripts/ssm_manifest.ctl.shprod.yaml` 的 `items` 结构：`secret_name: mono-shprod-website-deployer-secrets`、`namespace: ctl`、`kubernetes_resource_name: website-deployer-secrets`、`kubernetes_resource_kind: Secret`、`output_path: argocd/secrets/shprod/website-deployer-secrets.sops.yaml`、`secret_type: Opaque`、`defaults.region: ap-shanghai`、`age_recipients` 与 ctl manifest 一致 |

> 关于 `TCB_ENV_ALLOWLIST` 的放置位置，这里要纠正一个常见误解：**放进 `argocd/services/ctl/shprod/ctl-platform.env` 是无效的。** `ctl/k8s/base/manifests.yaml` 里三个 Deployment 只显式 wire 了 4 个 `configMapKeyRef`（`SHADOW_ACCOUNT_ENABLED` / `SHADOW_BINDING_REQUIRED` / `LIGHTVELA_SITE_KIND` / `SHADOW_BASE_URL`，见 `:114-138`、`:224-242`、`:327-345`），`ctl-platform-values` 里的其他 key 不会自动变成容器 env。而 `envFrom: secretRef: ctl-runtime-secrets`（`:111-113` 等）是全量注入的。<br>**所以推荐把 `TCB_ENV_ALLOWLIST` / `TCB_ENV_CAPACITY_MAP` 作为 `plaintext_keys` 放进 `ctl-runtime-secrets`（即 D1+D2），source-facing 零改动。** 备选方案是给 `ctl/k8s/base/manifests.yaml` 三个 Deployment 各加 2 段 `configMapKeyRef`（共 6 段，带 `optional: true`），但那会改动所有环境的 ctl base，评审面更大、收益相同。

### E. CI 发布通道（新建 1 个 + 改 1 个 + 2 项可选）

| # | 文件 | 内容 |
|---|---|---|
| E1 | `.ci/workers-website-deployer.yml` | 新建流水线。`version: v2.0`；`name: 构建 workers-website-deployer`；`on.push.branches: [master]`，`paths` 建议列 `workers/cmd/website-deployer/**`、`workers/internal/website/**`、`workers/go.mod`、`workers/go.sum`、`workers/Dockerfile`、`workers/k8s/overlays/shprod/**`、`argocd/services/workers-website-deployer/**`、`argocd/apps/shprod/workers-website-deployer.yaml`、`argocd/secrets/shprod/website-deployer-secrets.sops.yaml`；`manual: enabled`；`concurrency.group: mono2-service-release-workers-website-deployer`（**必须与 `mono2-service-release-workers` 不同**，否则两条通道互相排队）；`extends.template: service-release.yml`，参数：`SERVICE: workers`、`BUNDLE: workers-website-deployer`、`DISPLAY_NAME: workers-website-deployer`、`DEFAULT_TARGET_ENV: shprod`、`MASTER_BUILD_ENVS: shprod`、`MASTER_AUTO_PIN_ENVS: none`、`ENABLE_MASTER_PROD_PROMOTE: true`、`ENABLE_MASTER_PROD_DB_MIGRATION: false`（迁移归 ctl 流水线，见 §7）、`PLAYGROUND_BUILD_ENVS: none`、`PLAYGROUND_AUTO_PIN_ENVS: none`、`RUNNER_POOL_NAME: cn-pool`。<br>`MASTER_BUILD_ENVS=shprod` + `MASTER_AUTO_PIN_ENVS=none` 会让 `resolve_prod_promote_envs`（`.ci/runtime/harness_ci/prod_envs.py:16-27`）返回 `["shprod"]`，即走"人工审批 + 人工 promote"路径，符合 shprod 规则 |
| E2 | `.ci/runtime/bundles/workers.bundle` | 改 2 处。①`allowed_paths` 追加：`workers/k8s/overlays/shprod`、`argocd/apps/shprod/workers-website-deployer.yaml`、`argocd/projects/shprod-workers-website-deployer.yaml`、`argocd/secrets/shprod/website-deployer-secrets.sops.yaml`、`argocd/services/workers-website-deployer/shprod`。②新增 `publish_paths_by_env.shprod`（与 `shanghai-workers` 段同结构）：`argocd/apps/shprod/workers-website-deployer.yaml`、`argocd/projects/shprod-workers-website-deployer.yaml`、`argocd/secrets/shprod/website-deployer-secrets.sops.yaml`、`argocd/services/workers-website-deployer/shprod/**`、`workers/k8s/overlays/shprod/**`。<br>`image_repo.shprod` **已存在**（`:47`），不用改 |
| E3（可选） | `workers/catalog.yaml` | 建议新增 `spec.environments.shprod`（`namespace: ctl`，`workers.website-deployer` 描述 serviceId / appName / appPath / sourceOverlay / command / imagePullSecret）。**契约测试只读 `environments["shanghai-workers"]`**（`test_release_bundle_contracts.py:958`），所以新增 shprod 段不会破坏测试；纯为文档一致性 |
| E4（可选） | `.ci/guards.manifest` | 目前 `workers` 没有 guard 条目。可新增一个 `workers` guard（`paths: workers/**` + `argocd/services/workers-*/**`），把 `cd workers && go build ./... && go test ./...` 纳入变更门禁 |

改完 CI 相关文件后必须本地跑（`.ci/AGENTS.md` 的测试约束）：

```bash
python3 -m unittest discover -s .ci/runtime/tests/contract_tests -p test_release_bundle_contracts.py
python3 -m unittest discover -s .ci/runtime/tests/gitops_tests -p test_gitops_promotion_workflow.py
bash .ci/runtime/check_ci_runtime.sh
```

### F. 修一处既有隐患（改 1 个）

| # | 文件 | 内容 |
|---|---|---|
| F1 | `workers/k8s/overlays/beijing-sandbox/website-deployer/deployment.yaml` | 改。`MAX_CONCURRENCY: "10"` → `"2"`；`replicas: 3` → `1`；并补齐 live 上实际存在但文件里缺失的 env（见 §6）。<br>**为什么是隐患**：代码注释写明"峰值内存约为 concurrency × `WEBSITE_MAX_ARTIFACT_BYTES`（默认 64MB）"，且默认并发取 4 就是为了配 512Mi limit（`workers/cmd/website-deployer/main.go:66-71`）。文件里 `MAX_CONCURRENCY: 10` 配 `memory limit 512Mi`（`:80-82`），10 × 64MB = 640MB > 512Mi，是一个**尚未触发的 OOMKilled** |

### 工期与前置

| 分组 | 条目数 | 估计 | 依赖 |
|---|---|---|---|
| A source overlay | 6（全新建） | 0.25 人天 | 无 |
| B deploy-facing | 6（全新建） | 0.25 人天 | A（内容互为副本） |
| C Argo 纳管 | 3（2 新建 1 改） | 0.1 人天 | B |
| D 凭据 | 4（2 新建 2 改） | 0.25 人天 | **腾讯云 SSM + sops age key 权限**；`TCB_ENV_ALLOWLIST` 待采购（§9） |
| E CI 通道 | 2 必做 + 2 可选 | 0.4 人天（含跑契约测试与修回归） | 无 |
| F 修隐患 | 1 | 0.1 人天 | 无 |
| **合计** | **22 必做 + 2 可选** | **约 1.35 人天，取整 1–1.5 人天** | |

不含在内的时间：一次架构评审（§1 的集群选择）、一次代码 review、TCB 采购等待、ctl 迁移执行（走 ctl 自己的通道，见 §7）、以及 shprod 的人工 Argo sync 窗口。

硬前置：①§1 集群选择拍板；②建站分支合入 master；③TCB 采购结果到位（否则可以把配置全部就位但功能处于 fail-closed 状态）。

---

## 四、worker 生产环境变量清单

按代码枚举（`rg 'os.Getenv|getEnv|getPositiveInt64Env' workers/`，排除 `rescue-*` 与 `TEMPORAL_*` 无关项）：

**必需（缺失即启动失败或功能禁用）**

| env | 来源 | 说明 |
|---|---|---|
| `WEBSITE_INTERNAL_API_TOKEN` | `website-deployer-secrets` | 空则 `log.Fatal`（`main.go:58-63`）。必须与 ctl 侧同值 |
| `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | `website-deployer-secrets` | 缺失则 TCB 环境发现报错（`workers/internal/website/tcb_env.go:96`）。注意与 `shanghai-workers` 现有的 `TENCENTCLOUD_SECRET_ID/KEY` **不是同一个名字** |
| `TCB_ENV_ALLOWLIST` | `website-deployer-secrets` 或明文 env | 空则 worker 直接禁用（`tcb_env.go:124-127`）。值待 TCB 采购，见 §9 |
| `REDIS_ADDR` / `REDIS_PASSWORD` | `website-deployer-secrets` | ping 失败默认 `log.Fatalf`（`main.go:46-52`）。DB 固定 0（`main.go:30`） |

**建议显式设置**

| env | 建议值 | 说明 |
|---|---|---|
| `CTL_BASE_URL` | `http://ctl-api.ctl.svc.cluster.local` | 代码默认值就是它（`deployer.go:47`），显式写出便于审阅 |
| `MAX_CONCURRENCY` | `2` | 代码默认 4；见 §5 |
| `POLL_INTERVAL_SECONDS` | `10` | fallback 轮询间隔，代码默认 30s |
| `WEBSITE_REQUIRE_REDIS_LIMITER` | `true` | 保持 fail-closed，不要设成 `false` |
| `WEBSITE_COS_UPLOADS_PER_MINUTE` | `8000` | 与北京一致 |

**可选调参（有默认值，生产可不设）**：`WEBSITE_MAX_ARTIFACT_BYTES`、`WEBSITE_MAX_FILES`、`WEBSITE_MAX_UNCOMPRESSED_BYTES`、`WEBSITE_ARTIFACT_WAIT_ATTEMPTS`、`WEBSITE_ARTIFACT_WAIT_SECONDS`。

**ctl 侧必需**（同一批凭据，见 D1）：`WEBSITE_INTERNAL_API_TOKEN`、`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TCB_ENV_ALLOWLIST`；可选 `TCB_ENV_CAPACITY_MAP`、`TCB_ENV_MAX_SITES`（默认 500）、`TCB_ENV_DISABLED`（`ctl/pkg/logic/website/tcb_env.go:67-109`）。

---

## 五、资源配置与量级论证

**建议：`replicas: 1`、`MAX_CONCURRENCY: 2`、`requests 100m/128Mi`、`limits 1000m/512Mi`。**

论证：

- 业务量级：每周约 500 用户 ≈ 每天 70 个 ≈ 每 10 分钟 1 个。Skill 默认推荐 AI 生成**单文件站点**（CSS/JS 内联进 `index.html`），部署是亚秒级，**实际并发几乎恒为 1**。
- 内存上界：2 × 64MB = 128MB，距 512Mi limit 有 4 倍余量；同时满足代码注释给出的公式约束。
- 对照 shprod ctl 三进程实测（`kubectl top pod`，本次只读核对）：`ctl-api` 16Mi、`ctl-bypass` 9Mi、`ctl-service` 9Mi，limit 均 512Mi。同一量级下 512Mi 已是过量供给。
- 结论：**不需要为吞吐、并发或隔离付出任何架构代价。** 单副本 + 低并发即可；DB 侧的租约与指数退避（`website_operations` 表）已经覆盖单副本重启期间的任务不丢。

一个可选改进（不阻塞上线）：worker 目前没有健康端口，Deployment 也没有 readiness/liveness probe（对比 `rescue-exporter` 有 `WORKERS_HEALTH_ADDR=:9090` 与两个 probe）。要补需要改 Go 代码，**本次不做**，记二期。

---

## 六、北京那份 overlay 不能当作"已验证的生产配置"照抄

只读核对（北京 sandbox）与仓库文件逐项对比，差异远大于预期：

| 维度 | 仓库 `workers/k8s/overlays/beijing-sandbox/website-deployer/deployment.yaml` | 北京 live 实际 |
|---|---|---|
| `replicas` | `3`（`:27`） | `1` |
| `resources` | requests 100m/128Mi、limits 1000m/512Mi（`:76-82`） | **`{}`，完全没有 requests/limits** |
| 容器 env 数量 | 8 项 | **21 项** |
| `TCB_ENV_ALLOWLIST` | **缺失** | 存在（否则 worker 会自禁用） |
| `REDIS_PASSWORD` | **缺失** | 存在 |
| 管理方式 | — | Deployment 上有 `kubectl.kubernetes.io/last-applied-configuration`、无 Argo tracking 注解，`deployment.kubernetes.io/revision: 34` |

结论与影响：

1. **北京的 `website-deployer` 是手工 `kubectl apply` 部署的，从未被 GitOps 收敛过**（`argocd/apps/beijing-sandbox/` 下没有对应 Application，只有 `argocd-runtime.yaml` 与 `sandbox-family-appset.yaml`）。
2. **照抄这份 overlay 会得到一个跑不起来的生产部署**（缺 `TCB_ENV_ALLOWLIST` → 自禁用；缺 `REDIS_PASSWORD` → ping 失败 → `log.Fatalf`）。§4 的清单才是权威依据，**必须逐项核对，不要 copy-paste**。
3. 同样的问题在 ctl 侧也存在：北京 live `ctl-api` 有 `WEBSITE_COS_BUCKET` / `WEBSITE_COS_REGION` / `WEBSITE_COS_SECRET_ID` / `WEBSITE_COS_SECRET_KEY` / `CLOUDBASE_STATIC_ENV_ID` 五个 env，而这些名字在**整个仓库的 k8s / argocd 配置里零引用**，`ctl-runtime-secrets` live 也比 SOPS 文件多了 `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` 两个 key。→ 北京的建站相关配置同样是 GitOps 之外手工注入的。
4. 顺带一个有用发现：那五个 `WEBSITE_COS_*` / `CLOUDBASE_STATIC_*` 名字在**当前分支代码里已经不再被读取**（本分支 ctl 与 worker 只读 `TCB_ENV_*` 与 `TENCENT_SECRET_*`）。说明北京 live 跑的是更早的镜像迭代，**这些 legacy env 不要带进生产配置**。

---

## 七、合入 master 的硬约束：镜像与迁移不能拆开

建站分支合入 master 会同时引入 **19 个新迁移（`000028`–`000046`）** 和建站读写代码：

- `ctl/pkg/model/website/dao.go` 直接依赖 `website_sites` 等新表。
- `000028_add_bundle_static_site_quota` 给 `bundle` 加的 `static_site_quota` 字段被 `ctl/pkg/logic/userresourcequota/logic.go` 读取。

**因此必须迁移先行，再发镜像。**

已核对的版本事实：

- 本分支 `ctl/migrations/` 共 46 个 `*.up.sql`；`origin/master` 只有 27 个。
- master 上的建站迁移已于 2026-07-31 被 `ac2ea653f`（`Revert "完善CloudBase静态建站权益一期"`）回退，当前 master 的 27 个与生产 `schema_migrations = 27` 完全追平。本分支的 19 个新迁移尚未合入。

生产迁移只走受控入口：

```bash
python3 .ci/runtime/commands/run_gitops_db_job.py \
  --service ctl --operation migration --env shprod --revision <sha>
```

或 `.ci/db-migration.yml` 流水线（自动探测当前版本 + 打印 pending SQL + 人工审批 + 一次性 Job）。已有 runbook：`docs/runbooks/ctl-website-migration-shprod.md`。

这也是 E1 里 `ENABLE_MASTER_PROD_DB_MIGRATION: false` 的原因：**迁移归 ctl 的发布通道，worker 通道不碰 DB。**

发布顺序建议：

1. 建站分支合入 master（触发 ctl 与 workers 两条镜像构建）。
2. ctl 迁移先行（受控入口 / db-migration 流水线，人工审批）。
3. ctl 侧凭据到位（D1/D2）+ ctl promote 到 shprod + 人工 Argo sync。此时建站在生产上"能分配环境但没有执行器"，`website_operations` 会积压在 pending——这是可接受的中间态，也是一个天然的 ctl 侧独立验证窗口。
4. worker 侧凭据到位（D3/D4）+ 新流水线 promote + 人工 Argo sync。积压的 operation 会被 BLPOP/fallback poll 消化。

---

## 八、当天验证清单

Argo 侧（`argocd/apps/shprod/README.md:64-69` 的判定标准）：

- live app `workers-website-deployer-shprod` 的 `repoURL` = `git@git.woa.com:wisp/mono2.git`、`targetRevision` = `gitops`、`revision` = 本次合入 `gitops` 的提交、状态 `Synced / Healthy`。
- 实际 workload image = 目标 tag。

集群侧（生产只读）：

```bash
kubectl -n ctl get deploy website-deployer
kubectl -n ctl get pods -l app=website-deployer
kubectl -n ctl logs -l app=website-deployer --tail=100
```

健康日志应出现 `website-deployer connected to Redis at ...` 与 `website-deployer starting: concurrency=2, redis=true, fallback_poll=10s`（`main.go:54`、`:88-89`）。若看到 `requires WEBSITE_INTERNAL_API_TOKEN` 或 `requires Redis for the global COS upload limiter` 即为 D3 凭据缺失；若日志出现 `TCB_ENV_ALLOWLIST is empty; website deployer is disabled` 即为 allowlist 未配。

链路侧：跑一次真实建站，确认 `website_operations` 从 pending → running → succeeded，站点 URL 可访问。

---

## 九、必须等 TCB 企业版采购才能填的项

以下值依赖采购结果，现在只能占位，**不阻塞前面 A/B/C/E 的所有 YAML，但阻塞真正上线**：

| 项 | 依赖 | 备注 |
|---|---|---|
| `TCB_ENV_ALLOWLIST` | TCB 企业版 env_id 列表 | 逗号分隔。fail-closed：为空则 ctl 与 worker 双侧禁用（`ctl/pkg/logic/website/tcb_env.go:201-204`、`workers/internal/website/tcb_env.go:124-127`） |
| `TCB_ENV_CAPACITY_MAP` | 每环境站点容量上限 | JSON `{"<env-id>": <int>}`（`ctl/pkg/logic/website/tcb_env.go:79-92`）。不填则回落到 `TCB_ENV_MAX_SITES`，默认 500 |
| TCB 环境 region | 采购时确定的地域 | 影响 COS bucket 发现与就近访问；桶名形如 `{prefix}-static-{env_id}-{app_id}`（`ctl/pkg/logic/website/tcb_env.go:138-140`） |

另外两项虽不依赖采购、但同样是"人工到位"才能填的：`WEBSITE_INTERNAL_API_TOKEN`（新生成，两侧同值）与 `REDIS_ADDR`（从 ctl 现有 `server_conf.toml` 取）。

---

## 十、风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| TCR pull 权限 | `ctl` namespace 已有三个实例级 `tcr.ips*` pull secret（只读核对），同 TCR 实例换 repo 路径按语义应覆盖，**但未经验证** | 首次 pull 即验证；不覆盖就补一个 pull secret，不影响方案成立 |
| 出网能力 | worker 需访问 COS / TCB 公网 API。`infra_pulumi/envs/tencentcloud/shprod/inventory.yaml` 配了 `snat_subnets`，且 ctl 自身分配 TCB 环境也要出网，**推断**可用 | 部署当天验证 |
| 惯例分歧 | worker 落 shprod 而非 shanghai-workers，与既有惯例不一致 | 在 A6 / B6 两个 README 里写明原因；本文 §1 已列出代价供评审 |
| 新通道每一样配置都是新失败点 | 独立通道 = 新 Application / AppProject / SOPS / 流水线，且多数只有发布当天才验证得到 | 先在北京把同一套 overlay 走一遍 GitOps（顺带解决 §6 的手工部署债），再上 shprod；或接受当天验证 |
| 镜像 pin 与 shanghai-workers 通道解耦 | 两条通道各自 pin，同一 workers 镜像在两处可能版本不同步 | 这是"独立发布通道"的固有语义，不是缺陷；worker 之间无耦合 |

---

## 十一、已否决的方案（保留备查，不要再翻案）

### ❌ 把 worker 代码并入 ctl（约 650 行迁移，3–5 人天）
**已否决：量级不合理。** 它唯一的真实价值是消除 `tcb_env.go` 那 186 行重复实现——两边各一份且**已经在漂移**：ctl 那份有容量管理与超限切换（`TCB_ENV_CAPACITY_MAP` / `TCB_ENV_MAX_SITES` / `TCB_ENV_DISABLED`），worker 那份没有。这属于技术债清理，**与上线无关，记二期**。

### ❌ Argo 清单寄生在 `argocd/services/ctl/shprod/`（0.5 人天）
**已否决：发布归属仍与 ctl 耦合。** 技术上可行（`ctl.bundle:50` 的 `publish_paths` 含 `argocd/services/ctl/{env}/**`，`ctl-conf-rewrite.yaml` 就是这种额外资源的先例），但一个 workers 镜像的工作负载长在 ctl 的发布目录里，会让"谁负责发它"永久模糊，并且吃不到属于自己的 pin 与审批。省下的那 1 人天不值得。

### ❌ worker 直连 MySQL，绕过 ctl-api
**不成立。** MySQL 与 Redis 同样在 shprod VPC 内网，从 shanghai-workers 访问它们与访问内网 CLB 面临**完全相同**的网络前提，**没有解决跨集群问题**；若已落在 shprod 集群内，ctl-api 本来就能直调，绕过毫无收益。改造还要引入 GORM、模型层、ID 生成器、errcode 体系，量级接近"并入 ctl"，且会把 ctl 的 DAO 复制一份开始漂移。

### ❌ 手工 kubectl 部署，暂不接 ArgoCD
技术上可行（北京现在就是这么跑的，见 §6），约 2 小时。
- 一个此前被误解的事实：**shprod 的 Argo 应用都不开自动同步**（`argocd/apps/shprod/README.md:21`），所以手工资源**不会**被 selfHeal 覆盖或 prune 删除。
- **真实代价不是被删，是失忆**：生产出现 Git 里查不到的工作负载；Secret 不入 SOPS 会导致轮换遗漏、灾难恢复重建不出来（这比 Deployment 本身更严重）。§6 已经把北京这条路的后果摊开了：仓库里那份 overlay 与 live 有 6 处实质差异，谁都说不清哪份是对的。
- **补进 GitOps 的成本与正规做法相同**，省下的只是把工作往后推，还额外欠一笔债。

### ❌ 通过 service-gateway 中转
**不建议。** shprod 网关配置现无任何 `/internal/` 路由。`/internal/ctl/websites/*` 的鉴权是单一静态 token，而 `POST .../complete` 可直接改写站点发布状态。为每天 70 单的功能把生产内部 API 面暴露到公网，收益成本比极差。

### ❌ 改用 Temporal
**不推荐，粗估 8–15 人天。** Worker Controller 只装在 shanghai-workers，跨集群问题一点没解决；而 `website_operations` 表已实现持久化状态、租约、指数退避重试、幂等完成，迁移等于把已测试的机制推倒重来。

> 澄清一个命名误会：北京的 `website-deployer` 部署在名为 `temporal-workers` 的 namespace，纯粹是复用了命名空间的名字。它是普通 `apps/v1 Deployment`，与 Temporal 无关。这也是本方案在 shprod 选 `ctl` namespace（而不是新建一个 `temporal-workers`）的原因之一。

---

## 十二、两个正交项（可独立排期，与本方案无依赖）

1. **同步执行轻量分支。** `create` / `suspend` / `resume` 目前也要绕一整圈"LPush → BLPOP → claim → 回调 complete"，其中 `executeCreate` 实际只回写一个 URL、**根本不碰 COS**。这类操作可在 ctl 内同步完成，约 0.5–1 人天，能显著降低建站首屏的感知延迟。
2. **`tcb_env.go` 去重。** 见 §十一第一条，二期技术债。

---

## 十三、执行勘误（2026-08-05 落地时对本文的修正）

按本文清单执行时发现下列条目有误或需要收敛，已按修正后的做法落地。**以本节为准。**

### 勘误 1（D2）：`plaintext_keys` 会阻塞现有 ctl 凭据刷新，必须用 `optional_plaintext_keys`

原文 D2 建议把 `TCB_ENV_ALLOWLIST` / `TCB_ENV_CAPACITY_MAP` 追加到
`items[ctl-runtime-secrets].plaintext_keys`。**这会在 TCB 采购完成前直接打断 ctl 现有凭据的导出。**

举证：`scripts/export_ssm_to_sops.py:265-267`

```python
unknown = sorted(set(required_plaintext_keys) - set(string_data))
if unknown:
    raise ValueError(f"unknown plaintext_keys: {', '.join(unknown)}")
```

`plaintext_keys` 是**必须存在**语义。SSM payload 里还没有这两个 key 时，
`--only ctl-runtime-secrets` 会直接抛异常，连带 12 个既有 ctl 凭据都刷不出来。

**修正做法**：改用同一函数支持的 `optional_plaintext_keys`（`:258-261`、`:270`），
它只对"存在才明文"生效，缺失时静默跳过。已在
`scripts/ssm_manifest.ctl.shprod.yaml` 与新建的
`scripts/ssm_manifest.workers-website-deployer.shprod.yaml` 中按此落地。

### 勘误 2（D1）：这一条不是"写文件"，本次不落地

原文把 D1（给 `argocd/secrets/shprod/ctl-runtime-secrets.sops.yaml` 加 4 个 key）
与 A/B/C 并列为"改动清单"条目，容易被误解成可以在配置任务里顺手完成。

实际上它需要 **sops age 私钥**，且 `argocd/apps/shprod/README.md:17` 要求
"secret 变更必须经过受保护流水线和受保护变更路径"。本次执行**未改动**该文件，
改为写进 runbook §2.1 作为操作步骤。D3 同理，见勘误 3。

### 勘误 3（D3）：secret 是 6 个 key 不是 5 个，且本次只落占位符

原文 D3 列了 5 个 key，但 §4 又要求 worker 侧必须有 `TCB_ENV_ALLOWLIST`
（`workers/internal/website/tcb_env.go:124` 从 `os.Getenv("TCB_ENV_ALLOWLIST")` 读，
为空即禁用）。两处不一致。**修正：`website-deployer-secrets` 是 6 个 key**，
allowlist 在 manifest 里登记为 `optional_plaintext_keys`（运营策略，明文便于评审）。

`argocd/secrets/shprod/website-deployer-secrets.sops.yaml` 已创建，
但**全部是占位符**（`REPLACE_ME_VIA_PROTECTED_PIPELINE` /
`REPLACE_ME_PENDING_TCB_PROCUREMENT`），用真实 age recipient 加密以保证 ksops 闭包完整。
文件的 `metadata.annotations.lightclaw.dev/placeholder-warning` 是明文可见的替换提示。

### 勘误 4（新发现，原文完全没提）：占位符会被 CI 门禁拦下，这是好事

`.ci/runtime/gitops/gitops_kustomize_validation.py:33`

```python
PLACEHOLDER_RE = re.compile(r"\bREPLACE_[A-Z0-9_]+\b")
```

渲染结果里出现任何 `REPLACE_*` 都会让配置契约门禁失败（`:293-297`）。
所以**在凭据与 TCB 采购值落地之前，promote 一定会失败**——这是有意的安全网，
不要通过改占位符命名绕开它。已写进 runbook §1 开头。

影响面已核对**仅限本服务自己的 promote**：
- 门禁按 pin target 逐个 `--source-path` 调用（`.ci/runtime/gates/config.py:179-200`），不会波及 ctl / trade 等其他服务；
- `validate_gitops_static.py` 对 shprod 只做 YAML 字段校验，不做 kustomize 渲染；
- `.ci/gitops-drift-audit-shprod.yml` 比对的是 `origin/gitops`，占位符停留在 `master` 时不会触发。

### 勘误 5（A4/B4）：节点池用 `WORKERS_NODE_POOL` replacement，不用裸占位符

原文 A4 写"`nodeSelector.pool` 用占位符"。裸占位符会直接撞上勘误 4 的门禁。
**修正**：与 ctl / beijing rescue-exporter 的既有写法对齐，在 platform.env 里加
`WORKERS_NODE_POOL`，由 kustomize `replacements` 注入。实际值 `general-shprod`
取自 `argocd/services/ctl/shprod/ctl-platform.env` 的 `CTL_NODE_POOL`。

### 勘误 6（F1）：本次只改 `MAX_CONCURRENCY`，未动 replicas 与 env

原文 F1 要求同时把北京 overlay 的 `replicas: 3` → `1` 并"补齐 live 上实际存在但文件里缺失的 env"。
本次执行**只改了 `MAX_CONCURRENCY: 10` → `2`**（唯一的未触发 OOMKilled 隐患）。

理由：北京那份 overlay 从未被 GitOps 收敛过（live 是手工 `kubectl apply`，revision 34），
往里补 env 等于在一个**没有消费者**的文件里凭空补配置，既不会改变 live，
又会制造"仓库看起来是对的"的错觉。北京的 GitOps 收敛应当作为独立任务处理。

### 勘误 7（E3/E4）：两个可选项均**不做**

- **E3（`workers/catalog.yaml` 加 shprod 段）不做**：catalog 的 schema 强绑 Temporal
  （`runtime.temporalConnection`、`workerDeploymentName`、`taskQueue`），
  而 `website-deployer` 是普通 Deployment，硬塞进去会得到一个字段大面积缺失的畸形条目。
  已核对 `workers/catalog.yaml` **不被** `gitops_static_validation.py` 消费，
  所以它当前只是文档；文档职责已由两个新 README 承担。
- **E4（`.ci/guards.manifest` 加 workers guard）不做**：属于扩大 CI 门禁面的独立改动，
  与本次上生产无依赖，应单独评审。

### 补充 1（原文未列）：`.gitignore` 需要多一行

`workers/k8s/overlays/*/generated/` 匹配不到
`workers/k8s/overlays/shprod/website-deployer/generated/`（多一层 worker 目录）。
这是既有缺口（`shanghai-workers/*/generated/` 同样没被覆盖）。
已补 `workers/k8s/overlays/*/*/generated/*.env`，顺带覆盖 shanghai-workers。

### 补充 2：北京 live env 只读核对结果（§6 的精确版）

只读核对北京 live `Deployment/website-deployer` 的 21 个容器 env，逐项分类：

| 分类 | 数量 | key |
|---|---|---|
| 当前代码仍在读 | 12 | `CTL_BASE_URL`、`POLL_INTERVAL_SECONDS`、`MAX_CONCURRENCY`、`REDIS_ADDR`、`REDIS_PASSWORD`、`WEBSITE_INTERNAL_API_TOKEN`、`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TCB_ENV_ALLOWLIST`、`WEBSITE_REQUIRE_REDIS_LIMITER`（另 2 项为默认值覆盖） |
| **legacy，当前分支零引用** | 9 | `WEBSITE_PUBLIC_DOMAIN`、`WEBSITE_COS_BUCKET/REGION/SECRET_ID/SECRET_KEY`、`CLOUDBASE_STATIC_COS_BUCKET/REGION/SECRET_ID/SECRET_KEY`、`CLOUDBASE_STATIC_ENV_ID`、`CLOUDBASE_APP_ID` |

原文 §6 只点到 5 个 legacy env，实际是 9 个（还有一组 `CLOUDBASE_STATIC_COS_*`）。
已 `rg` 核对这 9 个名字在当前分支 `workers/` 与 `ctl/` 中**零引用**，全部排除在 shprod 配置之外。

**另一个原文没发现的问题**：北京 live 这 21 个 env 里，只有
`TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` 走 `secretKeyRef`，
其余 19 项（**含 `WEBSITE_INTERNAL_API_TOKEN`、`REDIS_PASSWORD` 和四个 COS 密钥**）
都是**内联明文值**直接写在 Deployment spec 里。这与本次上生产无关，
但是一个应当单独处理的既有安全问题。shprod 配置已全部改为 `secretKeyRef`。

其余只读核对与原文一致：`replicas=1`、`resources={}`。

---
