# COS website-deployer 上生产 Runbook（sgprod）

> 当前实现固定使用一个独立 COS 桶，通过 `site-gateway` 对外服务。
> 桶名、地域和最小权限凭据全部通过生产配置注入。

## 1. 部署形态

| 项 | 值 |
|---|---|
| 集群 / namespace | `sgprod` / `ctl` |
| 工作负载 | `Deployment/website-deployer`，`replicas: 1` |
| Argo Application | `workers-website-deployer-sgprod` |
| 发布流水线 | `.ci/workers-website-deployer.yml` |
| COS 布局 | `sites/{siteID}/releases/{releaseID}/**`（当前 + 上一完整版本）+ 临时 `_artifacts/{siteID}/{releaseID}.zip` |
| 自动同步 | 无；GitOps MR 合并后仍需人工 Argo sync |

worker 与 `ctl-api.ctl.svc.cluster.local`、VPC Redis 同集群部署。Redis 同时负责
operation 队列和 COS 上传限流，连接失败时 fail-closed。

## 2. 上线前配置

### 2.1 独立 COS 桶

准备一个只承载用户生成站点的 COS 桶，并确定：

- `WEBSITE_COS_BUCKET`
- `WEBSITE_COS_REGION`
- `WEBSITE_COS_SECRET_ID`
- `WEBSITE_COS_SECRET_KEY`

CAM 凭据只授予该桶所需的对象读写、列举和删除权限。CTL、website-deployer、
site-gateway 必须指向同一个桶并使用同一套站点专用凭据。

发布成功前 worker 会删除临时 zip；失败路径也会尽力删除。生产桶还必须应用
`argocd/services/workers-website-deployer/sgprod/website-cos-lifecycle.xml` 作为兜底：
只匹配 `_artifacts/`，对象 2 天过期、未完成分块上传 1 天中止。应用前先读取现有
生命周期规则并合并，因为 `PutBucketLifecycle` 是全量覆盖；绝不能把 `sites/` 纳入过期规则。

worker 的桶名和地域写入：

```text
argocd/services/workers-website-deployer/sgprod/workers-platform.env
```

### 2.2 CTL SSM

在 `mono-sgprod-ctl-runtime-secrets` 中补齐：

- `WEBSITE_INTERNAL_API_TOKEN`
- `WEBSITE_COS_BUCKET`
- `WEBSITE_COS_REGION`
- `WEBSITE_COS_SECRET_ID`
- `WEBSITE_COS_SECRET_KEY`

然后导出并扫描：

```bash
python3 scripts/export_ssm_to_sops.py \
  --manifest scripts/ssm_manifest.ctl.sgprod.yaml \
  --only ctl-website-runtime-secrets
python3 scripts/scan_secrets.py argocd/secrets/sgprod/ctl-website-runtime-secrets.sops.yaml
```

CTL 使用这套配置签发 COS 上传预签名 URL，因此缺任一项都不能发布新镜像。

### 2.3 website-deployer SSM

在 `mono-sgprod-website-deployer-secrets` 中写入：

- `WEBSITE_INTERNAL_API_TOKEN`
- `WEBSITE_COS_SECRET_ID`
- `WEBSITE_COS_SECRET_KEY`
- `REDIS_ADDR`
- `REDIS_PASSWORD`

然后导出并扫描：

```bash
python3 scripts/export_ssm_to_sops.py \
  --manifest scripts/ssm_manifest.workers-website-deployer.sgprod.yaml \
  --only website-deployer-secrets
python3 scripts/scan_secrets.py argocd/secrets/sgprod/website-deployer-secrets.sops.yaml
```

`WEBSITE_INTERNAL_API_TOKEN` 必须与 CTL 同值。只比较指纹，不打印明文。

## 3. 发布顺序

1. 先幂等 upsert 两个 leaf AppProject；这一步必须早于 root-sgprod 同步：

```bash
for project in sgprod-site-gateway sgprod-workers-website-deployer; do
  python3 .ci/runtime/commands/onboard_argocd_target_cluster.py \
    --cluster-manifest argocd/clusters/sgprod.yaml \
    --project-manifest "argocd/projects/${project}.yaml" \
    --kubeconfig "$KUBECONFIG_SGPROD" \
    --argocd-base-url "$ARGOCD_BASE_URL" \
    --argocd-username "$ARGOCD_USERNAME" \
    --argocd-password "$ARGOCD_PASSWORD"
done
```

2. 合入源码并构建 CTL、workers、site-gateway 镜像。
3. 按 `docs/runbooks/ctl-website-migration-shprod.md` 用单个 000028 将 sgprod CTL 数据库从版本 27 前滚到最终建站结构。CTL 流水线已显式禁用 shprod migration。
4. 从 SSM 导出 CTL、website-deployer、site-gateway 的 SOPS secret，并通过 secret scan。
5. 合并并应用网站桶生命周期配置，读回确认只匹配 `_artifacts/`。
6. promote CTL 和 service-gateway，合并 GitOps MR，人工 Argo sync。
7. promote website-deployer 和 site-gateway，合并 GitOps MR，人工 Argo sync。
8. 对少量生产 Hermes 实例签发 per-instance website key，通过 TAT 下发。
9. 完成创建、发布、公网访问、删除、公网 404 的闭环后再扩大下发范围。

迁移必须先于新 CTL 镜像。GitOps MR 合并只代表发布批准，不代表 live workload 已更新。

## 4. 验证

```bash
kubectl -n ctl get deploy website-deployer site-gateway
kubectl -n ctl get pods -l app=website-deployer
kubectl -n ctl get pods -l app=site-gateway
kubectl -n ctl logs -l app=website-deployer --tail=100
```

故障对照：

| 日志 | 根因 |
|---|---|
| `requires WEBSITE_INTERNAL_API_TOKEN` | worker internal token 缺失 |
| `requires Redis for the global COS upload limiter` | Redis 配置错误 |
| `WEBSITE_COS_BUCKET and WEBSITE_COS_REGION are required` | COS 桶名或地域缺失 |
| `WEBSITE_COS_SECRET_ID/KEY ... are required` | COS 桶级凭据缺失 |

业务闭环必须包含：创建站点、上传 release、operation succeeded、站点公网 200、删除站点、
公网 404、站点数和存储配额释放。

## 5. 回滚

- worker 异常：将 `website-deployer` 缩容到 0；operation 保留在数据库和 Redis，恢复后继续消费。
- 镜像异常：通过 GitOps 把对应 image pin 回退到上一版本，再人工 Argo sync。
- site-gateway 异常：回退网关镜像；不要删除 COS 对象。
- CTL 异常：回退 CTL 镜像，但数据库迁移保持前滚，不执行 `migrate down`。
- COS 凭据异常：撤销新 CAM key，恢复上一套有效凭据并重新导出 SOPS。

## 6. 发布完成标准

- Argo Application 指向本次 GitOps revision，状态 `Synced / Healthy`。
- workload 实际镜像等于目标 tag。
- 三个组件的 COS bucket/region 一致。
- COS 生命周期已读回确认只清理 `_artifacts/`，不会清理 `sites/`。
- website-deployer 无持续 claim/upload/delete 错误。
- site-gateway 公网 HTTPS 返回正确内容。
- 真实 Hermes 对话建站与删除闭环通过。
