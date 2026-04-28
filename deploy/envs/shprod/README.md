# Shanghai Production Deploy Facts

上海正式环境的部署事实统一收口在这个目录，但这里不再承担 service-local 发布入口说明。

当前正式主线：

- `infra_pulumi` 负责基础设施和环境事实
- `deploy/envs/shprod/platform.env` 提供环境运行时事实
- `argocd/` 是唯一正式 deploy-facing 入口
- 统一 Argo CD 控制面负责把当前 repo 的 `gitops` 发布视图同步到上海正式集群

## Files

- `platform.env`
  - 由 `infra_pulumi` 回写的环境事实
  - 包含 kubeconfig、registry、内网地址、节点池、部分 deploy 运行时密码
  - 敏感文件，不手改、不提交
- `secrets.example.env`
  - 本地或外部 secret 存储需要补齐的敏感项说明

## 正式发布规则

- 上海正式环境正式发布只认 GitOps / Argo CD
- 不再使用服务目录内的 `deploy-k8s.sh`、`kubectl apply -k` 或其他 service-local apply/release 脚本作为正式入口
- 服务目录只保留 source-facing 语义：
  - 源码
  - `k8s/base`
  - `k8s/overlays/shprod`
  - Docker build 输入
  - migration / seed 二进制与 SQL（如适用）

## 正式发布链路

1. 在 `infra_pulumi` 刷新环境事实
2. 按 release bundle 构建并推送镜像
3. 更新 `argocd/services/<service>/shprod/*-platform.env` 中的 image pin / 平台参数
4. 合并 Git 变更，让统一 Argo CD 控制面同步上海正式集群
5. 如涉及数据库变更，单独执行平台级 DB job

## 推荐操作

### 1. 刷新环境事实

```bash
# 在 infra_pulumi 目录下执行
GOWORK=off go run ./cmd/infractl sync --stack shprod
```

必要时再执行 `preview / up`，但不要手工编辑 `platform.env`。

### 2. 构建镜像

统一入口：

```bash
python3 scripts/build-release-image.py --service <service> --env shprod --tag <tag> --push
```

release bundle 清单见：

- `scripts/release-bundles.yaml`

当前显式例外：

- `sandbox` 仍走 `python3 images/build-image.py`

### 3. 更新 GitOps pin

正式 image pin 只允许写在：

- `argocd/services/<service>/shprod/*-platform.env`

### 4. 由 Argo 同步

上海正式环境 root app：

- `argocd/root/shprod.yaml`
- root app project:
  - `argocd/projects/shprod-root.yaml`

子应用入口：

- `argocd/apps/shprod/`

服务 deploy-facing 真源：

- `argocd/services/<service>/shprod/`

验证入口：

- GitOps MR 时间线
- 统一 Argo CD 控制面 API

### 5. 数据库变更

数据库 migration / seed 不属于 steady-state Argo sync。

统一走平台级入口：

- `scripts/run_gitops_db_job.py`
- 历史 DB job 模板已退役；当前以脚本和 runbook 为准

## 约束

- `platform.env` 是 `infra_pulumi` 产物，不要手改
- 路径类变量默认相对 mono repo 根目录解析
- 不要把本地 `.secret/*`、`generated/*`、service-local 脚本上下文作为 Argo 必需输入
- 正式回滚只允许：
  - `git revert`
  - 或等价的 image pin reverse / promotion reverse

## 关联文档

- `docs/deploy-guides/deployment-model-overview.md`
- `docs/runbooks/gitops-platform-standard.md`
- `docs/runbooks/gitops-release-contract.md`
- `argocd/README.md`
