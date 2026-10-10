---
id: minisandbox-serving-recertification-2026-10-02
type: task
scope: 为 serving 阶段补齐严格只读 Workers API GitOps 收敛重验。
triggers: ["serving workers api recertification", "minisandbox missing convergence receipt", "C 收敛重验"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/workers-api/gitops/recertify-live-convergence.sh
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.2.0
precedence: task
derived: false
---

## goal

从精确 pinned Git tree 与现网只读数据恢复缺失的 serving convergence 基线，使后续 C 发布可用正式 CAS。

## non_goals

- 不修补现网、改 Application revision、重新采用资源、变更 Secret 或伪造已有收据。
- 不把这条只读重验当压力、灾备、业务资格或历史 self-heal 证据。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式 Stateless Workers/DO 设计要求 C 产品镜像通过 GitOps 收敛发布。
- current App4541556 Synced/Healthy，归档只找到旧4c3b2052，不能拿旧基线推进当前 App。

## interface_refs / data_structure_refs

- actor-management-workers-api-argocd-convergence/v1，精确 revision、Deployment/Service/Secret UID。
- serving 额外绑定 Object Router receipt、现网 Service、四个外置身份/serving route ConfigMap。
- 集群分配字段不进入 desired 比较；不得忽略镜像、配置、路由、VIP、端口或安全组漂移。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：原 recertify 只接受 durable-legacy/object-router-bootstrap，当前 serving 无正式恢复入口。
- superseded_refs：旧4c3b2052仅历史，不作为当前 CAS。

## acceptance

- 纯函数与真实文件 fixture 覆盖正确输入，以及 route/UID/image/manifest/Service/Secret/resource 漂移拒绝。
- 不新增模块 mock，保留原 pre-serving 检查，严格 serving 14 个 tracked resource。
- 云上只读重验成功后才可用其作为新镜像发布 prior-convergence。

## affected_paths

- Workers API GitOps recertify/helper/tests/README，正式设计与本 Task/catalog。

## required_context

- release-gitops、upstream-subtrees、adjacency-argocd-ci-secrets。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@9c15872b | 仓库规则 | 不以源码代替发布 |
| docs/context/domains/release-gitops.md@9c15872b | 发布边界 | pinned Git 与 live state |
| docs/context/project/upstream-subtrees.md@9c15872b | 单写源 | mono2 subtree |
| docs/context/project/adjacency/argocd-ci-secrets.md@9c15872b | 邻接 | 只核验 Secret 身份，不打印值 |
| minisandbox/CLAUDE.md@9c15872b | 项目规则 | 无模块 mock，隔离 revision |
| minisandbox/infra/cells/AGENTS.md@9c15872b | 操作边界 | 不与高风险资格并发 mutation |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@9c15872b | 门禁入口 | 只读恢复不等于准入 |
| minisandbox/infra/cells/deploy/tencent/fleet/workers-api/gitops/README.md@9c15872b | 正式发布协议 | 不重复采用或绕过 CAS |
| minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@9c15872b | 完整目标 | C 叶子正式发布前置 |

## evidence

- bounded 查找 bootstrap receipts/max4、build/max5 convergence 及当前 exact revision 查询均无匹配。
- 管理 Git publisher 已定位配置文件路径，未读取或打印 credential 值。
- Workers API 正式 manifest 门禁通过，23 项 render/product 测试和 18 项 GitOps 测试通过。
- 新增 serving 重验 4 项测试，包含 22 个身份/策略漂移、2 个原始字节变更以及完整审计摘要场景。
- 首次云端重验 inv-a9de7ggwj1 FAILED/1：A immutable 身份路由保留四个资格审计摘要，现网未 mutation。
- 只读诊断 inv-c9de8901a0 证明五个身份字段及 UID 正确；修复只允许完整四项 SHA-256 审计字段，拒绝未知、残缺或畸形字段。新增真实文件回归，不改既有路由。
- 原失败日志官方下载，摘要前缀 cfb7f30d3b59，后续重验必须新输出路径，不能覆盖旧失败。
- reviewed source 8d39a4a8 native inv-e9deam0h3k SUCCESS/0，正式门禁通过，没有重编 Runtime/workerd。
- C 正式发布 inv-a9deatgjx5 SUCCESS/0，Argo revision 10b5ef6eeac9，API 镜像摘要前缀 2f7b6e9b4687。
- convergence 官方下载并独立验真，摘要前缀 57207003ec5f；三副本三节点三可用区、UID/VIP 保留、A/B Application 不变、自愈通过。
- 发布后独立 serving 只读重验 inv-d9dedt0wte SUCCESS/0，收据摘要前缀 c0b636478ee2，十四资源及四路由核验通过。
- 新万级 active 门禁 inv-c9def3gxtj 已运行，run f56405fe9169424fb97d3c81b3da2704；两 Cell fresh strict governance 为 allow、从各四台起步。不能提前认定其通过。
- ACK 实际门禁独立终态 SUCCESS/0，收据摘要前缀 37e8f31cf9fe，完整摘要见正式设计；不将它替代 C 发布或万级容量资格。

## risks

- 所有异常 fail closed，不把 live drift 写成有效证据。
- 只允许缺失收据恢复，原收据与历史失败不可覆写。

## validation

- 新语义回归、Workers API 正式门禁、Bash/Python、Context/文档及影响门禁。
- 新源码验真后再在 C 执行同一只读入口。

## decisions

- 扩展已有 recertify，不自制 ad-hoc 收据，也不依赖手工修 App。

## scan_scope

- Workers API GitOps、正式 route publisher、当前非秘密 receipts 身份字段。

## scan_output

- 只输出 revision/UID/schema/digest 与路径，无凭据值。

## handoff

- 本 Task 的严格 serving 重验和 C 正式镜像发布完成，并取得发布后独立现网证据。
- ACK 本次 after_commit_before_barrier 门禁通过；完整目标保持 active，尚未完成万级低容量扩缩容。
