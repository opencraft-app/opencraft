# 持续集成与制品晋级

本目录负责把源码构建为可晋级制品，并更新 deploy-facing GitOps 输入；它不拥有生产运行态，也不能单独证明发布完成。

## 权威入口

- [目录说明](../README.md) 与 [Agent 约束](../AGENTS.md)
- [服务目录记录](../catalog-info.yaml)
- [发布与 GitOps 领域](../../docs/engineering/domains/release-gitops.md)

## 变更边界

流水线定义位于 `.ci/*.yml`，复用命令位于 `.ci/runtime/commands/`。凭据由外部流水线或 Secret 系统注入，文档和日志不得记录值。镜像成功只证明制品存在；交付还需核对目标 GitOps revision 与 Argo `Synced/Healthy`。

## 验证

按变更范围运行 `.ci/runtime/check_ci_runtime.py` 和对应命令的测试或 dry-run；任何真实构建、晋级或发布均需用户单独授权。
