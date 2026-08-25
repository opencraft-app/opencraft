# workers-website-deployer / shprod

上海正式环境 `website-deployer` 的 **deploy-facing** GitOps 真源。
Argo 直接从这个目录（在 `gitops` 分支上）渲染并下发。

## 归属

| 项 | 值 |
|---|---|
| Argo Application | `argocd/apps/shprod/workers-website-deployer.yaml`（`workers-website-deployer-shprod`） |
| AppProject | `argocd/projects/shprod-workers-website-deployer.yaml`（`shprod-workers-website-deployer`） |
| Root app | `argocd/root/shprod.yaml`（`root-shprod` 扫描 `argocd/apps/shprod`） |
| 目标集群 / namespace | `shprod` / `ctl` |
| 发布流水线 | `.ci/workers-website-deployer.yml`（**独立于** `.ci/workers.yml`） |
| Release bundle | `workers`（`.ci/runtime/bundles/workers.bundle`），pin target `workers-website-deployer` |
| 镜像 pin | `workers-platform.env` 的 `WORKERS_IMAGE` |
| 运行时 secret | `argocd/secrets/shprod/website-deployer-secrets.sops.yaml`（经 `ksops-secret-generator.yaml` 引入） |
| Source overlay | `workers/k8s/overlays/shprod/website-deployer/`（本目录的 `deployment.yaml` / `serviceaccount.yaml` 是它的副本） |

## 为什么是独立通道

`.ci/workers.yml` 的 `BUNDLE` 参数实际语义是 **pin targets 列表**，且是**环境无关的扁平列表**：
`.ci/runtime/gates/config.py` 会对列表里的**每一个** pin target 强制要求
`argocd/services/<pin-target>/<env>/kustomization.yaml` 存在。

所以不能往现有 `.ci/workers.yml` 追加 `workers-website-deployer`：
- shanghai-workers 的 auto-pin 会因为找不到 `argocd/services/workers-website-deployer/shanghai-workers/` 而失败；
- 反之 shprod promote 会找不到 `argocd/services/workers-rescue-exporter/shprod/`。

另有两个契约测试把 `.ci/workers.yml` 的 `BUNDLE` 值写死
（`test_release_bundle_contracts.py` 的 `test_workers_release_bundle_targets_shanghai_worker_cluster`
和 `test_workers_catalog_matches_shanghai_deploy_units`）。

因此本服务走 `.ci/workers-website-deployer.yml`，`SERVICE: workers`（共用 workers 镜像 bundle）、
`BUNDLE: workers-website-deployer`（只含自己的 pin target）。
两条通道的 `concurrency.group` 也不同，避免互相排队。

## secret 来源

`website-deployer-secrets`（namespace `ctl`）包含 5 个 key：

| key | 说明 |
|---|---|
| `WEBSITE_INTERNAL_API_TOKEN` | **必须与 ctl 侧 `ctl-runtime-secrets` 的同名 key 同值**，否则全部 claim 401 |
| `WEBSITE_COS_SECRET_ID` / `WEBSITE_COS_SECRET_KEY` | 用户站点独立 COS 桶的最小权限凭据；CTL、worker、site-gateway 必须使用同一套 |
| `REDIS_ADDR` / `REDIS_PASSWORD` | VPC 内网地址不进 Git 明文，所以放 secret。取值必须来自 ctl 现有配置，不要凭猜 |

桶名和地域不是凭据，放在 `workers-platform.env` 的 `WEBSITE_COS_BUCKET` /
`WEBSITE_COS_REGION`。当前实现固定使用一个独立 COS 桶。

长期权威真源是腾讯云 SSM，Git 里的 `*.sops.yaml` 只是 deployable snapshot。
导出 manifest：`scripts/ssm_manifest.workers-website-deployer.shprod.yaml`。

```bash
python3 scripts/export_ssm_to_sops.py \
  --manifest scripts/ssm_manifest.workers-website-deployer.shprod.yaml \
  --only website-deployer-secrets
python3 scripts/scan_secrets.py argocd/secrets/shprod/website-deployer-secrets.sops.yaml
```

当前 SOPS snapshot 已从上海 SSM 导出。生产同步前仍需通过流水线的 SOPS/KSOPS
渲染检查，并核对它与 CTL 使用同一个内部 Token 和 COS 凭据。

## COS 生命周期门禁

首次生产同步前，先读取桶的现有生命周期规则，将 `website-cos-lifecycle.xml` 中仅匹配
`_artifacts/` 的规则合并后写入，再读回确认：临时 ZIP 两天过期，未完成分块上传一天终止。
`PutBucketLifecycle` 会覆盖桶的完整生命周期配置，因此禁止直接覆盖已有规则，也禁止让
`sites/` 前缀进入过期范围。

## 与 source overlay 的同步义务

`deployment.yaml` / `serviceaccount.yaml` 是
`workers/k8s/overlays/shprod/website-deployer/` 下同名文件的副本。
**任一侧改动都必须同步另一侧**，否则 Argo 收敛的内容与 source-facing 真源不一致。

差异只有两处（有意为之）：
- 本目录的 `configMapGenerator.envs` 指向同目录 `workers-platform.env`，
  source overlay 指向不提交的 `generated/platform.env`；
- 本目录多一个 `generators: [ksops-secret-generator.yaml]`。

## 发布规则

- **不要添加 `syncPolicy.automated`**（`argocd/apps/shprod/README.md` 明确禁止）。
- GitOps MR 合入 `gitops` 只代表**发布批准**；实际下发必须由人工在发布窗口执行 Argo sync。
