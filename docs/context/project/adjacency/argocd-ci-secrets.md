---
id: adjacency-argocd-ci-secrets
type: project
scope: 镜像交付、Argo CD manifest、密钥引用和发布验证测试的共同变更邻接。
triggers:
  - gitops
  - argocd
  - 镜像发布
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - argocd/
  - .ci/
  - docs/engineering/domains/release-gitops.md
status: active
reviewed_at: 2026-08-27
review_due: 2026-11-25
revision: 1.0.0
precedence: project
derived: true
related_packs:
  - release-gitops
---

# Argo CD、CI 与 Secret 邻接

## 当前实现锚点

- `.ci/` 定义构建、制品晋级和 GitOps promotion 入口；`argocd/` 保存环境和服务的部署声明。
- 环境目录中的 `kustomization.yaml` 组织资源，`ksops-secret-generator.yaml` 只描述密钥生成/引用关系，不应把密钥值带入 Context 或日志。
- 发布真实性仍由 GitOps revision、镜像、Argo 的 `Synced` 和 `Healthy` 状态共同决定，源码或流水线成功本身不构成发布证据。

## 适用触发

镜像构建、制品晋级、Argo manifest、环境覆盖、Secret 引用、GitOps drift 或发布验证。

## 必查邻居

1. 在 `.ci/` 查找对应服务或 promotion 模板。
2. 在 `argocd/` 查找同服务的 common/environment `kustomization.yaml` 与 README。
3. 若命中 `ksops-secret-generator.yaml`，只核验引用名称、生成器和环境关系；不得读取或输出解密内容。
4. 查找与目标服务/环境同名的测试、drift audit 或验证脚本。

## 验证命令

```bash
rg --max-count 50 "targetRevision|image|ksops" argocd .ci
```

随后仅读取命中服务的一个 manifest 与一个 CI/测试邻居；生产状态另按发布 Runbook 在用户授权范围内核验。

## 失效条件

若部署入口从 `argocd/` 或 `.ci/` 迁走、Secret 管理机制更换、或 promotion 模板改名，本卡必须更新后再作为定位邻居使用。
