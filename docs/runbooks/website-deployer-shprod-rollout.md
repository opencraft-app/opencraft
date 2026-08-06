# website-deployer 上生产 Runbook（shprod / ctl namespace）

> 面向执行者。方案依据：`docs/proposals/2026-08-05-website-deployer-shprod-rollout.md`
> 库变更部分引用：`docs/runbooks/ctl-website-migration-shprod.md`（不在这里重写）
>
> 结论前置：**配置已全部就位，但仓库里全是占位符。在完成第 1 节的必填清单之前，
> 不要触发 promote，也不要执行 Argo sync。**

---

## 0. 部署形态速查

| 项 | 值 |
|---|---|
| 集群 / namespace | `shprod` / `ctl` |
| 工作负载 | `Deployment/website-deployer`，`replicas: 1` |
| 镜像 | `lightclaw-shprod.tencentcloudcr.com/lightclaw/workers`（与 shanghai-workers 同一个镜像，不同 pin） |
| Argo App | `workers-website-deployer-shprod` |
| AppProject | `shprod-workers-website-deployer` |
| 发布流水线 | `.ci/workers-website-deployer.yml`（**独立于** `.ci/workers.yml`） |
| Secret | `website-deployer-secrets`（namespace `ctl`） |
| 自动同步 | **无**。上海正式环境不启用 `syncPolicy.automated` |

为什么落在 `ctl` namespace 而不是 `shanghai-workers` 集群：worker 依赖集群内 DNS
`ctl-api.ctl.svc.cluster.local` 和 VPC 内 Redis（fail-closed），跨集群两条链路都未打通。
详见方案文档 §1 与 `workers/k8s/overlays/shprod/README.md`。

---

## 1. 上线前必填值清单（**阻塞项**）

下面每一项在仓库里都是占位符。**全部填完之前 promote 会被 CI 门禁拦下**
（`.ci/runtime/gitops/gitops_kustomize_validation.py` 的 `PLACEHOLDER_RE = \bREPLACE_[A-Z0-9_]+\b`
会把渲染结果里任何未替换占位符判为失败——这是有意的安全网，不要绕过它）。

### 1.1 等 TCB 企业版采购

| 值 | 落点 | 当前占位符 | 说明 |
|---|---|---|---|
| `TCB_ENV_ALLOWLIST` | ctl 侧 `ctl-runtime-secrets` + worker 侧 `website-deployer-secrets` | `REPLACE_ME_PENDING_TCB_PROCUREMENT` | 逗号分隔的 TCB env_id 列表。**为空则 ctl 与 worker 双侧直接禁用建站**（fail-closed） |
| `TCB_ENV_CAPACITY_MAP` | 仅 ctl 侧 `ctl-runtime-secrets` | 尚未写入 | JSON `{"<env-id>": <int>}`。不填回落到 `TCB_ENV_MAX_SITES`（默认 500）。worker 不读这个 key |
| TCB 环境 region | 采购时确定 | — | 影响 COS bucket 发现；桶名形如 `{prefix}-static-{env_id}-{app_id}` |

### 1.2 等受保护密钥流程（不依赖采购，但必须人工到位）

| 值 | 落点 | 当前占位符 | 说明 |
|---|---|---|---|
| `WEBSITE_INTERNAL_API_TOKEN` | **两侧同值**：`ctl-runtime-secrets` + `website-deployer-secrets` | `REPLACE_ME_VIA_PROTECTED_PIPELINE` | 需新生成。两侧不一致 ⇒ worker 全部 claim 返回 401 |
| `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | 两侧 | `REPLACE_ME_VIA_PROTECTED_PIPELINE` | 注意与 shanghai-workers 现有的 `TENCENTCLOUD_SECRET_ID/KEY` **不是同一个名字** |
| `REDIS_ADDR` | 仅 worker 侧 | `REPLACE_ME_VIA_PROTECTED_PIPELINE` | **必须从 ctl 现有配置取，不要猜。** 来源：`argocd/secrets/shprod/ctl-conf-common.sops.yaml` 解密后的 `server_conf.toml` 里的 Redis 地址。DB 固定 0（`main.go:30`），与 ctl 的 `ctl/pkg/resource/redis.go:48` 一致 |
| `REDIS_PASSWORD` | 仅 worker 侧 | `REPLACE_ME_VIA_PROTECTED_PIPELINE` | 与 `ctl-runtime-secrets/CTL_REDIS_PASS` 同值 |

### 1.3 ctl 侧四个 key 目前一个都没有

只读核对结论：`argocd/secrets/shprod/ctl-runtime-secrets.sops.yaml` 当前 12 个 key，
`WEBSITE_INTERNAL_API_TOKEN` / `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` / `TCB_ENV_ALLOWLIST`
**都不存在**；shprod live `ctl-api` 的容器 env 里也没有。

**即使本次不部署 worker，ctl 自己也必须补齐这 4 项**，否则建站在生产上分配环境直接
fail-closed（`ctl/pkg/logic/website/tcb_env.go:201-204`）。

---

## 2. 密钥写入流程（受保护变更路径）

`argocd/apps/shprod/README.md` 明确要求：**secret 变更必须经过受保护流水线和受保护变更路径。**

长期权威真源是腾讯云 SSM，Git 里的 `*.sops.yaml` 只是 deployable snapshot
（`argocd/secrets/README.md`、`argocd/secrets/shprod/README.md`）。
**走 SSM → SOPS 导出，不要用 `sops <file>` 手工编辑**（手工编辑会让 Git 与 SSM 漂移）。

### 2.1 ctl 侧

1. 在腾讯云 SSM 更新 `mono-shprod-ctl-runtime-secrets`，追加 4 个 key
   （`WEBSITE_INTERNAL_API_TOKEN`、`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TCB_ENV_ALLOWLIST`，
   可选 `TCB_ENV_CAPACITY_MAP`）。
2. 导出并扫描：

```bash
python3 scripts/export_ssm_to_sops.py \
  --manifest scripts/ssm_manifest.ctl.shprod.yaml \
  --only ctl-runtime-secrets
python3 scripts/scan_secrets.py argocd/secrets/shprod/ctl-runtime-secrets.sops.yaml
```

`TCB_ENV_ALLOWLIST` / `TCB_ENV_CAPACITY_MAP` 已在 manifest 里登记为
**`optional_plaintext_keys`**（不是 `plaintext_keys`）：这两项是运营策略不是凭据，
明文入库便于评审；用 optional 是为了让 SSM 里**还没有**这两个 key 时导出不会报
`unknown plaintext_keys` 而阻塞现有 ctl 凭据刷新。

> ⚠️ 不要试图把 `TCB_ENV_ALLOWLIST` 放进 `argocd/services/ctl/shprod/ctl-platform.env`。
> `ctl/k8s/base/manifests.yaml` 里三个 Deployment 只显式 wire 了 4 个 `configMapKeyRef`
> （`SHADOW_ACCOUNT_ENABLED` / `SHADOW_BINDING_REQUIRED` / `LIGHTVELA_SITE_KIND` / `SHADOW_BASE_URL`），
> platform-values 里的其他 key **不会**变成容器 env；而 `envFrom: secretRef: ctl-runtime-secrets`
> 是全量注入的。放 platform.env 等于什么都没配，且不会报错。

### 2.2 worker 侧

1. 在腾讯云 SSM 新建 `mono-shprod-website-deployer-secrets`（region `ap-shanghai`），
   JSON 对象，包含 6 个 key：
   `WEBSITE_INTERNAL_API_TOKEN`、`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、
   `REDIS_ADDR`、`REDIS_PASSWORD`、`TCB_ENV_ALLOWLIST`。
2. 导出并扫描：

```bash
python3 scripts/export_ssm_to_sops.py \
  --manifest scripts/ssm_manifest.workers-website-deployer.shprod.yaml \
  --only website-deployer-secrets
python3 scripts/scan_secrets.py argocd/secrets/shprod/website-deployer-secrets.sops.yaml
```

3. 确认导出后的文件 **不再含任何 `REPLACE_ME_*`**，且
   `metadata.annotations.lightclaw.dev/placeholder` 已消失：

```bash
rg -n "REPLACE_ME|lightclaw.dev/placeholder" argocd/secrets/shprod/website-deployer-secrets.sops.yaml \
  && echo "占位符仍在，禁止 promote" || echo "OK"
```

4. 一致性硬校验（**不要打印明文**，只比对指纹）：ctl 侧与 worker 侧的
   `WEBSITE_INTERNAL_API_TOKEN` 必须同值。解密后分别取 sha256 前 12 位比对即可。

---

## 3. 完整执行顺序

> **铁律：19 个迁移（`000028`–`000046`）必须在 ctl 新镜像之前执行。**
> `ctl/pkg/model/website/dao.go` 直接依赖 `website_sites` 等新表；
> `000028_add_bundle_static_site_quota` 给 `bundle` 加的 `static_site_quota` 被
> `ctl/pkg/logic/userresourcequota/logic.go` 读取。**镜像与迁移不能拆开发布。**
> 已核对：本分支 `ctl/migrations/` 46 个 `*.up.sql`，`origin/master` 27 个，
> 生产 `schema_migrations = 27`。

| # | 步骤 | 执行者 | 门禁 |
|---|---|---|---|
| 1 | 建站分支合入 `master`（触发 ctl 与 workers 两条镜像构建） | 研发 | MR review |
| 2 | **ctl 迁移先行** | 发布负责人 | 人工审批 |
| 3 | ctl 侧凭据到位（§2.1） | 有 SSM + age key 权限的人 | 受保护流水线 |
| 4 | ctl promote → gitops MR → 人工合并 → **人工 Argo sync** | 发布负责人 | 人工审批 + 人工 sync |
| 5 | worker 侧凭据到位（§2.2） | 同 3 | 受保护流水线 |
| 6 | worker promote → gitops MR → 人工合并 → **人工 Argo sync** | 发布负责人 | 人工审批 + 人工 sync |
| 7 | 冒烟验证（§4） | 发布负责人 | — |

### 3.1 步骤 2：迁移

```bash
python3 .ci/runtime/commands/run_gitops_db_job.py \
  --service ctl --operation migration --env shprod \
  --revision <合入 master 的 commit sha> --apply --wait
```

或走 `.ci/db-migration.yml` 流水线（自动探测当前版本 + 打印 pending SQL + 人工审批 + 一次性 Job）。
**细节、dirty 语义与回滚见 `docs/runbooks/ctl-website-migration-shprod.md`，这里不重复。**

`argocd/services/ctl/shprod/delete-migration-job.yaml` 用 `$patch: delete` 移除了稳态 migrate Job，
所以迁移不会随 Argo 同步自动发生，必须显式触发。

### 3.2 步骤 4 / 6：中间态是可接受的

步骤 4 完成、步骤 6 未完成时，生产上建站"能分配环境但没有执行器"，
`website_operations` 会积压在 `pending`。这是**可接受的中间态**，也是一个天然的
ctl 侧独立验证窗口。步骤 6 上线后，积压的 operation 会被 BLPOP / fallback poll 消化。

### 3.3 步骤 6：promote → 合并 → sync

`.ci/workers-website-deployer.yml` 的参数
（`MASTER_BUILD_ENVS: shprod` + `MASTER_AUTO_PIN_ENVS: none`）会让
`resolve_prod_promote_envs` 返回 `["shprod"]`，即走**人工审批 + 人工 promote** 路径。

三个动作**不能合并理解**：

1. **promote**：CI 构建镜像 + 创建 `promote-shprod-*` 分支 + 创建到 `gitops` 的 MR。
2. **合并 gitops MR**：只代表**发布批准**。`argocd/apps/shprod/README.md` 明确写了
   "GitOps MR 合入 `gitops` 只代表发布批准；实际下发必须由人工或发布系统在发布窗口执行 Argo sync"。
3. **人工 Argo sync**：在发布窗口对 `workers-website-deployer-shprod` 执行 sync。
   这才是真正下发。**不要给这个 app 加 `syncPolicy.automated`。**

Argo 侧发布完成判定（`argocd/apps/shprod/README.md:64-69`）：

- live app `repoURL` = `git@git.woa.com:wisp/mono2.git`
- live app `targetRevision` = `gitops`
- live app `revision` = 本次合入 `gitops` 的提交
- 状态 `Synced / Healthy`
- 实际 workload image = 目标 tag

不要把"master 已提交"/"镜像已推送"/"promote 分支已创建"/"MR 已创建未合并"当作发布完成。

---

## 4. 上线后冒烟验证

### 4.1 集群侧（生产只读）

```bash
kubectl -n ctl get deploy website-deployer
kubectl -n ctl get pods -l app=website-deployer
kubectl -n ctl logs -l app=website-deployer --tail=100
```

健康日志：

```
website-deployer connected to Redis at <addr>
website-deployer starting: concurrency=2, redis=true, fallback_poll=10s
```

故障对照：

| 日志 | 根因 |
|---|---|
| `requires WEBSITE_INTERNAL_API_TOKEN` | secret 缺 key |
| `requires Redis for the global COS upload limiter` | `REDIS_ADDR` / `REDIS_PASSWORD` 错误或仍是占位符 |
| `TCB_ENV_ALLOWLIST is empty; website deployer is disabled` | allowlist 未配 |
| `ImagePullBackOff` | TCR pull 权限，见 §6 风险表第 1 条 |

### 4.2 链路侧（四步全链路）

1. **建站**：真实用户走一次建站，确认分配到 TCB 环境、`website_sites` 落库。
2. **发布**：确认 `website_operations` 从 `pending` → `running` → `succeeded`。
3. **访问**：站点 URL 公网可访问，返回预期内容。
4. **删除**：删除站点，确认 operation 走完且配额释放（`website_site_quota` 行数回落）。

第 4 步不要省。删除路径依赖 `TCB_ENV_ALLOWLIST` 能解析出该站点所在 env（见 §5 铁律）。

---

## 5. 运维铁律：下线 TCB 环境的顺序

> **下线某个 TCB 环境时，必须保留它在 `TCB_ENV_ALLOWLIST` 中，
> 直到该环境下所有站点清理完毕。**

原因：worker 在执行 delete 操作时要先从 allowlist 解析出站点所属 env。
提前把 env 从 allowlist 摘掉，会导致：

1. worker 拿不到 env → delete 操作失败；
2. 站点永久卡在 `deleting` 状态；
3. 配额锁死（站点不落地删除，配额不释放，用户建不了新站）。

虽然已经加了重试上限和死信状态兜底，仍然必须按下面顺序操作：

1. 停止向该 env 分配新站点（用 `TCB_ENV_DISABLED` 或把它的 `TCB_ENV_CAPACITY_MAP` 容量设为 0，
   **不要**从 allowlist 移除）。
2. 清空该 env 下所有存量站点，确认 `website_sites` 中该 env 的行数归零。
3. 确认 `website_operations` 中没有指向该 env 的未完成 operation。
4. **此时**才能把该 env 从 `TCB_ENV_ALLOWLIST` 移除，并走 §2 的受保护流程重新导出。

---

## 6. 回滚

### 6.1 worker 侧（无状态，回滚最简单）

| 场景 | 动作 |
|---|---|
| 新镜像有问题 | 把 `argocd/services/workers-website-deployer/shprod/workers-platform.env` 的 `WORKERS_IMAGE` 改回上一个 tag，走 gitops MR + 人工 sync |
| 需要整体停摆 | 把 `deployment.yaml` 的 `replicas` 改成 `0`，走 gitops MR + 人工 sync。**这是首选的快速止血手段** |
| 紧急且来不及走 MR | 由有权限的人 `kubectl -n ctl scale deploy/website-deployer --replicas=0`，**事后必须立刻把等价期望态反投影回 GitOps**，否则下次 sync 会被覆盖 |

worker 停摆的影响面是**有界的**：`website_operations` 会积压在 `pending`，
DB 侧的租约与指数退避保证任务不丢，worker 恢复后自动消化。**不会丢数据。**

### 6.2 ctl 侧

镜像回滚走 ctl 自己的通道。**但注意：ctl 镜像回滚不能连带回滚迁移。**
19 个迁移是向前兼容的加列/加表，回滚镜像后旧代码不读新表即可；
**不要执行 `migrate down`**，dirty 语义的代价远大于收益（见 ctl 迁移 runbook §2）。

### 6.3 功能级熔断（不需要发版）

把 ctl 侧 `TCB_ENV_ALLOWLIST` 清空 ⇒ ctl 与 worker 双侧建站功能立即 fail-closed 禁用。
这是最轻量的功能开关，但**受 §5 铁律约束**：只有在确认没有待删除站点时才可以这么做。

---

## 7. 已知风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| TCR pull 权限未验证 | `ctl` namespace 已有三个实例级 `tcr.ips*` pull secret（只读核对过），同 TCR 实例换 repo 路径（`lightclaw/ctl` → `lightclaw/workers`）按语义应当覆盖，**但只有首次 pull 才能证实** | 首次 sync 即验证；`ImagePullBackOff` 就补一个 pull secret，不影响方案成立 |
| 出网能力未验证 | worker 需访问 COS / TCB 公网 API。`infra_pulumi/envs/tencentcloud/shprod/inventory.yaml` 配了 `snat_subnets`，且 ctl 自身分配 TCB 环境也要出网，**推断**可用 | 部署当天验证 |
| 无健康探针 | worker 没有健康端口，Deployment 也没有 readiness/liveness probe（对比 `rescue-exporter` 有 `WORKERS_HEALTH_ADDR=:9090`）。进程假死时 K8s 不会重启它 | 补探针要改 Go 代码，本次不做，记二期。上线初期靠日志与 `website_operations` 积压量监控 |
| 新通道每一样都是新失败点 | 独立 Application / AppProject / SOPS / 流水线，多数只有发布当天才验证得到 | 可选：先在北京把同一套 overlay 走一遍 GitOps（顺带还掉北京手工部署的债），再上 shprod |
| 北京 live 与仓库 overlay 不一致 | 北京的 `website-deployer` 是手工 `kubectl apply` 的，从未被 GitOps 收敛；live 有 21 个 env、`resources: {}`、revision 34 | **不要拿北京 live 当生产配置的参考真源**，本次 shprod 配置按代码枚举重新推导 |
| 北京 live 的 secret 以明文写在 Deployment spec 里 | 只读核对发现：北京 live 21 个 env 中，`WEBSITE_INTERNAL_API_TOKEN`、`REDIS_PASSWORD`、`WEBSITE_COS_SECRET_ID/KEY`、`CLOUDBASE_STATIC_COS_SECRET_ID/KEY` 全部是**内联明文值**，只有 `TENCENT_SECRET_ID/KEY` 走 secretKeyRef | 与本次上生产无关，但**是一个应当单独处理的既有安全问题**。shprod 配置已全部改为 `secretKeyRef` |
| legacy env 不要带进生产 | 北京 live 上的 `WEBSITE_PUBLIC_DOMAIN`、`WEBSITE_COS_*`、`CLOUDBASE_STATIC_*`、`CLOUDBASE_APP_ID` 共 9 个 env，在**当前分支的 `workers/` 与 `ctl/` 里零引用**（已 rg 核对），是更早镜像迭代的遗留 | shprod 配置已排除它们 |
| 两条 workers 通道镜像版本可能不同步 | `.ci/workers.yml`（shanghai-workers）与 `.ci/workers-website-deployer.yml`（shprod）各自 pin 同一个 workers 镜像 | 这是"独立发布通道"的固有语义，不是缺陷；两个 worker 之间无耦合 |

---

## 8. 相关文件索引

| 类别 | 路径 |
|---|---|
| source overlay | `workers/k8s/overlays/shprod/`（+ 该目录 `README.md`） |
| deploy-facing | `argocd/services/workers-website-deployer/shprod/`（+ 该目录 `README.md`） |
| Argo App | `argocd/apps/shprod/workers-website-deployer.yaml` |
| AppProject | `argocd/projects/shprod-workers-website-deployer.yaml` |
| SOPS secret | `argocd/secrets/shprod/website-deployer-secrets.sops.yaml` |
| SSM manifest | `scripts/ssm_manifest.workers-website-deployer.shprod.yaml`、`scripts/ssm_manifest.ctl.shprod.yaml` |
| 流水线 | `.ci/workers-website-deployer.yml` |
| release bundle | `.ci/runtime/bundles/workers.bundle` |
| 迁移 runbook | `docs/runbooks/ctl-website-migration-shprod.md` |
| 方案 | `docs/proposals/2026-08-05-website-deployer-shprod-rollout.md` |
| 交接 | `docs/handover/2026-08-05-cloudbase-static-site-handover.md` |
