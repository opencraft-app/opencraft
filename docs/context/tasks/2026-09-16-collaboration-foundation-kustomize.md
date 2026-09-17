---
id: collaboration-foundation-kustomize-root-20260916
type: task
scope: 修复北京 Collaboration foundation 在 Argo CD 默认 Kustomize 路径限制下无法渲染。
triggers: ["collaboration foundation", "Argo Kustomize load restriction"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - argocd/services/collaboration/beijing-sandbox-foundation/kustomization.yaml
  - .ci/runtime/tests/contract_tests/test_collaboration_delivery.py
status: active
reviewed_at: 2026-09-16
review_due: 2026-12-15
revision: 1.0.0
precedence: task
derived: false
---

## goal
让 Argo CD 能在默认 Kustomize load restriction 下渲染 Collaboration 北京 foundation。

## non_goals
- 不改变数据库、SSM、Secret 明文、运行时 Deployment/migration 或 Argo 全局 load-restrictor。
- 不在源码 MR 合入前直接修改 live Argo；runtime phase 仍须等待 foundation `Synced/Healthy` 和资源实证。

## requirement_ids / requirement_refs / requirement_excerpt
- Foundation #9 已完成 bootstrap，GitOps MR !4090 已合入；Argo `collaboration-beijing-sandbox` 为 `Sync: Unknown`、`Health: Healthy`、资源树为空。
- Argo `ComparisonError`：默认 `kustomize build` 拒绝 foundation 目录外的 `../../../../collaboration/k8s/base/namespace.yaml`，表现为 `security; file ... is not in or below ...`。

## interface_refs / data_structure_refs
- `argocd/catalogs/sandbox/beijing-sandbox/collaboration.yaml` 激活 `argocd/services/collaboration/beijing-sandbox-foundation`。
- Foundation 仅包含 Namespace、默认 ServiceAccount 和 KSOPS 加密 Secret 引用；不得启用 Deployment 或 Job。
- `collaboration/k8s/base/namespace.yaml` 和 `argocd/services/collaboration/common/serviceaccount.yaml` 是两个非敏感资源的源形状。

## history_context
- `current_design_refs`: `docs/engineering/domains/release-gitops.md`、`argocd/README.md`。
- `relevant_evolution`: !4090 将 foundation catalog 合入 `gitops`；首个 live manifest generation 暴露了之前静态测试未覆盖的 Argo 默认路径限制。
- `superseded_refs`: 无。

## acceptance
- 聚焦测试先以与 Argo 相同的 Kustomize `security` 错误 RED，修复后 GREEN。
- Foundation 的 `resources` 均在自身目录内；不解密 Secret 的本地渲染恰好输出 Namespace 和默认 ServiceAccount，内容与源清单一致。
- `gitops` 投影后 Argo 应用 `Synced/Healthy` 且资源树出现 Namespace、ServiceAccount、Secret 才能称 foundation ready。

## affected_paths
- `argocd/services/collaboration/beijing-sandbox-foundation/`
- `.ci/runtime/tests/contract_tests/test_collaboration_delivery.py`
- `docs/engineering/domains/release-gitops.md`
- 本 Task Pack。

## required_context
- `site-environment-routing`、`release-gitops`、`control-plane-ops`、`service-collaboration`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@2.0.0` | 北京环境边界 | 不扩散到其他地域 |
| `docs/context/domains/release-gitops.md@2.0.0` | 源码、GitOps、live 分层 | 不把源码测试当发布证据 |
| `docs/context/project/services/ctl.md@2.1.0` | 路由附带命中 | 确认 CTL 非本次改动面 |
| `docs/context/project/services/collaboration.md@1.0.0`、`collaboration/AGENTS.md` | 服务边界 | 保持数据和 API 契约不变 |
| `.ci/AGENTS.md`、`argocd/README.md` | CI 与 Argo 约束 | 仅修改 deploy-facing 组合层 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@1.0.0` | Secret 邻接 | 不读取解密内容 |

## evidence
- Argo API 查询：应用存在，sourcePath 为 foundation，`ComparisonError` 指向 Kustomize 外部资源路径，资源树为空；未输出凭据或 Secret 内容。
- 新的聚焦测试最初因同一 `security; file ... is not in or below ...` 错误失败。
- 本地资源改为同目录后，聚焦 12 项 Collaboration 交付测试通过；完整 CI runtime 555 项测试、物化 smoke 和 YAML 解析通过。
- 文档校验、docs-impact、改动文件密钥扫描、diff 检查通过；未解密或输出任何 Secret。

## risks
- 两份本地非敏感清单可能与源清单漂移；契约测试比较解析后的 YAML 内容。
- 只修复 foundation，runtime overlay 另有 `../common` 组合；runtime phase 前独立验证其 Argo 渲染。
- Argo 自动同步依赖 `gitops` MR；源码分支修复不等于 live 恢复。

## validation
- `python3 -m unittest discover -s .ci/runtime/tests/contract_tests -p 'test_collaboration_delivery.py' -v`
- `bash .ci/runtime/check_ci_runtime.sh`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- 文档、diff 和改动文件密钥检查；后续分别核对 `gitops` 与 Argo live。

## decisions
- 只在 foundation 目录复制 Namespace、ServiceAccount 两份非敏感资源；不降低整个 Argo 控制面的 Kustomize 路径限制。

## scan_scope
- `argocd/services/collaboration/`、`collaboration/k8s/base/`、`.ci/runtime/tests/contract_tests/test_collaboration_delivery.py`。

## scan_output
- 有界路径检索和测试摘要；不持久化 Argo 认证材料。

## handoff
- 用户已确认提交、推送并创建源码 MR；GitOps 投影、合入与 Argo live 收敛尚未执行。
