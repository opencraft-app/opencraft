---
id: ci-service-detail
type: service
scope: DevCloud/BlueKing CI 定义、构建与制品晋级的派生服务上下文。
triggers: ["ci detail", "blueking", "pipeline", "release runtime"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - .ci/docs/README.md
  - .ci/catalog-info.yaml
  - .ci/AGENTS.md
  - .ci
status: active
reviewed_at: 2026-09-01
review_due: 2026-11-30
revision: 2.1.0
precedence: service
derived: true
related_packs: ["release-gitops"]
---

# CI 服务 Context

仅在变更 `.ci/`、构建、晋级或流水线行为时加载；发布还必须加载 `release-gitops`，并遵守根入口的授权边界。

## 当前边界

- `.ci/*.yml` 定义流水线，`.ci/runtime/commands/` 存放复用命令；凭据只由受控运行环境注入，不能进入文档或日志。
- 构建成功只证明制品存在。交付结论还要核对目标 GitOps revision、镜像和 Argo `Synced/Healthy`。
- 真实构建、晋级、凭据或生产写入都需要用户单独授权；生成物默认不入 Git。

## 按需深入

- 当前命令、风险边界和验证：`.ci/AGENTS.md`、`.ci/docs/README.md`。
- 某条流水线或运行时脚本的细节：先精确定位文件，再读取相邻测试/配置；不把历史流水线说明默认加载。

## 验证

先运行 `python3 .ci/runtime/check_ci_runtime.py`，再运行受影响脚本的安全测试或 dry-run；真实发布状态另行验证。
