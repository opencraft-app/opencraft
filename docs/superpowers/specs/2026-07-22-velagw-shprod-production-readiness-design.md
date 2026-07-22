# 上海 VelaGW 生产对标与发布闸门设计

## 背景

上海 VelaGW 已接入 mono2 的 GitOps 发布链路，控制面和流量面也已在线，但当前
`gitops` 期望态仍停留在 2026-07-20 的 legacy set-manager 版本。北京测试环境已运行
VelaGWSet Controller/Provisioner，并持续承接最新 VelaGW 变更。上海将成为正式生产
环境，因此不能仅以镜像构建成功或 GitOps MR 已合并作为发布完成标准。

## 目标

- 上海 GitOps 服务包与当前北京架构对标，包含 VelaGWSet CRD、删除策略、Controller
  和 Provisioner。
- VelaGW 发布镜像必须在构建过程中通过 Go 单元测试和控制台前端测试。
- 上海继续保持人工 Argo Sync，但 promote 合并后必须自动等待并验证实际 Argo 收敛。
- 验收必须同时确认 Git revision、`Synced`、`Healthy` 和目标镜像 digest。
- 保留 legacy set-manager 只用于自然退役前的存量 Set；新增 Set 只能走
  `runtime_backend=velagwset`。

## 非目标

- 不启用上海生产自动 Argo Sync。
- 不直接修改上海生产 Secret、数据库、DNS、证书或 CLB。
- 不在这次变更中自动执行数据库 DDL。
- 不强制迁移或重建已有 legacy Set。

## 方案

### 镜像测试门禁

VelaGW Dockerfile 在生成二进制前执行 `go test ./...`。控制台依赖安装完成后执行
`pnpm test`，再执行生产构建。这样无论镜像由本地还是 CI 构建，都不能绕过服务测试。
集成测试继续由显式 E2E 流程承担，不在普通镜像构建中访问外部 MySQL、Redis 或模型
服务。

### 上海专属生产验收策略

保留通用 `shprod` 的 merge-only 策略，避免改变其他生产服务。为
`promote-shprod-velagw-*` 增加更具体的策略：仍然 `auto_sync=false`，但 MR 合并后进入
Argo convergence 验收并等待人工 Sync。由于策略按最长分支前缀匹配，只有 VelaGW
使用该行为。

验收复用现有 `verify_gitops_release.py`，确认：

- Argo Application 为 `velagw-shprod`；
- live revision 包含本次 GitOps merge commit；
- Application 为 `Synced / Healthy`；
- live images 包含本次上海 digest。

等待窗口设为 30 分钟，给人工检查 diff 和执行 Sync 留出时间；超时按发布失败处理，
不会自动触发 Sync。

### GitOps 对标

上海服务包声明以下静态资源：

- 中央 control、traffic 和分池 worker；
- legacy set-manager；
- LLMFleet RGD；
- VelaGWSet CRD 和删除准入策略；
- VelaGWSet Controller 和 Provisioner。

AppProject 必须允许 CRD、ValidatingAdmissionPolicy 和对应 Binding。动态 `LLMFleet/prod`、
VelaGWSet 实例、派生 new-api Deployment/Service 和运行时 Secret 仍不进入 Git。

### 数据库边界

当前 VelaGW 仍由应用启动过程幂等补齐 MySQL 表、列和索引。本次生产发布必须在人工
Sync 前检查目标版本新增的 schema 项，并确认变更为向后兼容的 add-only DDL。后续再
把 schema 检查和迁移拆成独立 Job；在该能力落地前，不把 bundle 错误声明为可自动
迁移，也不允许流水线自动执行 DDL。

## 测试

- 发布合约测试确认 Dockerfile 包含 Go 和前端测试门禁。
- 策略单元测试确认 VelaGW shprod 使用人工 Sync + Argo convergence，其他 shprod
  服务仍为 merge-only。
- GitOps 合约测试确认上海服务包包含 Controller/Provisioner/CRD，且 AppProject 权限
  完整。
- `go test ./...`、`pnpm test`、`pnpm build`。
- `kustomize build argocd/services/velagw/shprod`。
- `.ci/runtime/check_ci_runtime.sh` 和发布 bundle 合约测试。

## 发布与回滚

1. 合并源码和闸门变更到 `master`，构建上海 digest。
2. 生成 `promote-shprod-velagw-*` 候选并完成人工审批。
3. 合并到 `gitops` 后检查 Argo diff，再人工 Sync。
4. 流水线等待并验证 `velagw-shprod` 收敛。
5. 做控制面、流量面、Set 创建和推理 Canary。

回滚只通过上一版本 digest 的新 promotion 或 Git revert 完成。新增 CRD 在回滚时保留，
不级联删除现有 VelaGWSet；数据库 add-only 变更不做自动反向 DDL。
