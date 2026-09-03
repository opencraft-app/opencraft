---
id: playground-environment-runbook
type: runbook
scope: 创建、诊断、修复、扩容和删除北京 playground 环境，且不得臆测部署状态。
triggers:
  - playground
  - sandbox-bj
  - beijing environment
owner: mingyuxiao
authority: primary
source_of_truth:
  - .ci/runtime/create_playground_from_gitops.sh
  - .ci/runtime/commands/create_playground_environment.py
  - .ci/runtime/commands/check_playground_environment_contract.py
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: project
derived: false
---

# Playground 环境 Runbook

## 入口 contract

- playground 名称必须符合现有 `sandbox-bj-N` 或 `beijing-playground` 约定。任何写操作前解析确切 catalog 和 GitOps 目标。
- 使用 `.ci/runtime/create_playground_from_gitops.sh` 作为支持的入口。`.ci/runtime/commands/` 下的 Python 命令定义实现 contract；不得用临时 `kubectl` 命令重建流程。
- 先运行 contract 检查或诊断路径。创建、修复、扩容和拆除是不同操作，不能仅从环境名推断。
- Secret 来自环境的 SSM-to-SOPS 路径。绝不从其他沙箱复制已解密值，也不得提交生成的明文。
- 前端镜像选择是环境 contract 的一部分。通过 `ensure_playground_frontend_image.py` 验证；不得假定源码分支即为已部署镜像。

## 必需证据

记录请求环境、源码 revision、生成的 GitOps 路径、secret 解析结果、前端镜像和最终 Argo application 状态。成功要求预期 revision 和镜像以及 `Synced`、`Healthy`；仅有生成文件不是部署证据。

## 失败处理

遇到缺少 SSM key、无法解析 SOPS material、环境已被其他任务占用或 catalog/GitOps 冲突时停止。将生成 diff 和诊断输出保留在 Task Pack，随后仅回滚本操作创建的文件。
