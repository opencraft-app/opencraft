---
id: minisandbox-workers-api-image-binding-2026-10-02
type: task
scope: 将 Workers API 渲染的产品收据精确绑定到完整镜像清单。
triggers: ["minisandbox workers api image binding", "workers api inventory provenance", "Workers API 镜像清单绑定"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/workers-api/render.py
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

在任何 manifest 输出或 Argo 发布前，拒绝不属于当前完整镜像清单的 Workers API 产品。

## non_goals

- 不重编 Runtime/workerd，不修改运行时 admission、共享操作锁或现有云上资格任务。
- 不用渲染通过代替真实部署、strict 10k 或跨 Cell 性能资格。

## requirement_ids / requirement_refs / requirement_excerpt

- Stateless Workers/DO 设计的生产编排与镜像身份门禁。
- workers-api/README.md：Workers API 不得独立于完整 28 项 inventory 选择镜像。

## interface_refs / data_structure_refs

- image_contract.resolve：完整清单中 exact repository/ref/build provenance。
- product-lock.assemble：产品收据原始文件字节的 buildReceiptDigest。
- workers-api/render.py：bootstrap 和 serving 共用的纯渲染入口。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：现有渲染器仅比较 Go 基础依赖，未比较产品本身与 inventory 项。
- superseded_refs：无。

## acceptance

- ref、sourceRevision、sourceManifestDigest 和原始 buildReceiptDigest 全部精确一致才允许渲染。
- 两种发布阶段均覆盖有效产品和错镜像、错源码、错收据的拒绝路径。
- 回归使用真实文件系统、完整 11 产品/28 镜像合同，不 mock 合同校验器。
- CLI 拒绝时不产生 manifest 或 render receipt。

## affected_paths

- minisandbox/infra/cells/deploy/tencent/fleet/workers-api/render.py、test_render.py、README.md。
- 正式 Stateless Workers/DO 设计、本 Task Pack 和对应 Context catalog 记录。

## required_context

- release-gitops、upstream-subtrees、adjacency-argocd-ci-secrets。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@cef58c57 | 仓库边界 | 隔离工作区、精确验证和推送 |
| docs/context/domains/release-gitops.md@cef58c57 | 发布权威 | 不以源码或渲染冒充上线 |
| docs/context/project/upstream-subtrees.md@cef58c57 | 源码所有权 | 只修改 mono2 subtree |
| docs/context/project/adjacency/argocd-ci-secrets.md@cef58c57 | 邻接检查 | 核对 Workers API renderer、测试和 verify.sh |
| minisandbox/CLAUDE.md@cef58c57 | 测试和版本规则 | jj revision 已创建，不新增模块 mock |
| minisandbox/infra/cells/AGENTS.md@cef58c57 | 云操作和资格边界 | 续接同一句柄，不重复资格或重编 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@cef58c57 | Fleet 运维边界 | 保持 FDB 和 release 资格流程 |
| minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@cef58c57 | 完整目标 | 修复生产编排门禁，保留全部未完成项 |

## evidence

- 已有 A 资格与旧压测收尾任务重新查询均为 RUNNING；不重发或修改原失败 verdict。
- 修复前 CLI 回归产生十个失败：五类不匹配在两种发布阶段均被错误接受。
- 修复后 renderer 14 tests、产品 lock 9 tests 通过；完整 Workers API verify.sh 终态成功。
- Python 编译与 diff 检查通过，documentation errors/warnings 均为空。
- Context errors 前后均为 4,855、错误集合完全相同；26 tests 仍为相同四项基线失败。
  context-audit 33 tests 通过；发现报告为 needs_agent_review/not_assessed，不是生产资格。
- 云上只读 inv-c9da5801w9 证明 A 从 47 自动缩到五台，随后原资格句柄已进入 bottomless_started。
  当前仍 RUNNING，不能当成资格通过或开放 A placement。

## risks

- buildReceiptDigest 按原始字节定义；禁止将语义相同但重新格式化的收据当作原始收据。
- 现有单测 mock 会掩盖真实合同缺口；本次将对应测试改用完整合法清单。

## validation

- workers-api/verify.sh、image-seed/test_product_lock.py、Python 编译检查、diff 和文档影响门禁。

## decisions

- 保持原始 immutable receipt 身份，不引入兼容开关或 fallback。

## scan_scope

- workers-api renderer、测试、README 和 image-seed 合同。

## scan_output

- 所有检索限于上述目录，未读取日志或凭据内容。

## handoff

- 源码修复与永久回归完成；现网采用仍需正式 GitOps 发布，这不是现网 rollout。
- 原 A qualifier/monitor 保持运行，先完成当前 Runtime admission 再做 ACK 断线和 strict 10k。
