---
id: minisandbox-runtime-generation-rollout-2026-10-02
type: task
scope: 将依赖闭合 Runtime generation 正式发布到北京 A/B，并独立核验恢复与缩容证据。
triggers: ["minisandbox runtime generation rollout", "Beijing runtime recovery evidence", "runtime release ledger verification"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/release-runtime.sh
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

以正式事务发布相同的依赖闭合 generation 到北京 A/B，独立验证静态账本、现网镜像、UID、
Ready 下限及 maintenance 配置，并保留自动缩回低容量的真实证据。

## non_goals

- 不重复编译 workerd，不把 source push 或 release 成功当作 admission qualification。
- 不手工清 MachineSet intent、修改 HPA 副本或强删活 Host；不弱化所有权和 UID fencing。
- 不把本次发布替代完整 Stateless Workers/DO 目标、strict 10k 或其他故障矩阵。

## requirement_ids / requirement_refs / requirement_excerpt

- stateless-workers-do-routing/phase-4、phase-5：从低容量负载驱动扩容、安全缩回，严格容量证据。
- 正式设计当前事实：refresh/compaction 每 Engine 上限改为 8/2；Node prepared 意图恢复须 CAS。
- infra/cells/AGENTS.md：唯一生产 Runtime 发布入口、完整 operation lock、不可变 image inventory。

## interface_refs / data_structure_refs

- runtime/release-runtime.sh、capacity-controller-recovery.py、check-runtime-capacity-settle.py。
- operations/release_ledger.py、autonomy_audit.collect_static_release_state。
- runtime scale-in hold、immutable recovery journal、Node/Machine/MachineSet UID-bound provider intent。
- image inventory 11-product/28-image closure；原始 Runtime 和 controller source identities 分别保留。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：a2f68ea8 Runtime 修正后台预算和取消 gauge；2c4ced82 controller 修复 prepared
  intent orphan 恢复；c5923a4e 的区域 cold proof 解除了完整 inventory 晋级阻塞。
- superseded_refs：61709962 Runtime 与 4f7ce controller 不再作为候选镜像；旧失败 10k 不冒充成功。

## acceptance

- canonical release 同一句柄终态 SUCCESS/0，hold 正常释放、immutable static ledger 已写入。
- 独立 audit 比对 ledger、外部 receipt、实际 Pod images 与 release-owned ConfigMap，零 drift。
- Engine 6/6、Host 4/4、controller singleton Recreate，既有 Host/controller UID 不变。
- live config 精确 refresh=8、compaction=2；主 FDB fully replicated、healthy、generation reconciled。
- A Node 自动串行缩回四台；过程中只观察 exact UID/provider acknowledgement，不直接改节点。
- B 发布后与 A 共享同一 cell-neutral release artifact，但保留独立 Cell releaseId。

## affected_paths

- 本 Task Pack 与 Context catalog。
- minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md。

## required_context

- release-gitops、upstream-subtrees、argocd-ci-secrets adjacency。
- root AGENTS、minisandbox/CLAUDE.md、infra/cells/AGENTS.md、fleet README。

## context_receipt

- root AGENTS、CLAUDE、infra/cells AGENTS：jj revision、凭据保护、唯一发布入口及 qualification 边界。
- release-gitops、upstream-subtrees、MONO2_SUBTREE：mono2/master 为 source truth，不等于 release。
- argocd-ci-secrets adjacency 与 release_ledger 测试邻居：只核验已有授权产品的 immutable 引用。
- fleet README、release-runtime、autonomy_audit、release_ledger 及 recovery/render 测试：独立验真静态状态。
- 正式 Stateless Workers/DO 设计：仍有 strict 10k、ACK fault、Router 性能与百万 dormant 要求。
- cloud-environment-runtime/networking：复用现有腾讯云 CLI/TAT 通道，不输出凭据或绕过授权。

## evidence

- A release inv-e9d7gqgp3v 回查 SUCCESS/0；正常释放 release hold 并发布 static ledger。
- 独立只读 inv-a9d831gj9q SUCCESS/0：driftCount=0、payloadDigestMatches/externalReceiptMatches=true，
  Engine 6/6、Host 4/4、controller 1/1 Recreate，Host/controller UID 与前值一致。
- A releaseId 前缀 a6ce4fc13fa7；文件 SHA 前缀 dd26f2cb7687。官方 tat-download 完整验真，
  本地不可变证据为 /data/tmp/minisandbox-a01-runtime-release-c5923a4e-ledger.json。
- A MachineSet 从 201 自动降低到 156；最近 provider acknowledgement 对应 157→156，采样时无
  pending intent，实际/Ready/desired Node 均为 156。B 四台。缩容尚未完成，不能报告回到低容量。
- A/B 主 FDB available/fullReplication/healthy=true，generation=reconciled=2；HPA floor=4/max=301，
  scale-up Min(Pods 6/60s, Percent 100/60s)、scale-down Disabled，缩容仍归独立 controller。
- B normal release inv-c9d83v01pt 已 SUCCESS/0，recovery=0；hold 正常释放、ledger 已写入。
- 两 Cell 独立 audit inv-d9d8a90q8b SUCCESS/0：各自 driftCount=0、payload/external receipt 验真，
  Engine 6/6、Host 4/4、controller 1/1 Recreate，Host/controller UID 未变、revision 已收敛。
- live config 两边均精确 refresh=8/compaction=2；cell-neutral artifact 前缀 3a3f47792c10 相同，
  Runtime source 为 a2f68ea8、controller 为 2c4ced82，不混淆 orchestrator source。
- B releaseId 前缀 847138778c90，文件 SHA 前缀 33863eb5d378；官方下载验真至
  /data/tmp/minisandbox-b01-runtime-release-c5923a4e-ledger.json。
- 旧失败 10k cleanup inv-a9cwx404ak 仍 RUNNING；本轮未启动任何新并发 workload。

## risks

- release 关闭 reporter placement qualification 是正确行为，不能为了压测跳过重新绑定资格。
- Node contraction 与 durable request traffic 分属不同 owner，不能把 replica 数当作 Actor truth。
- 任何 TAT 观察断开只续接相同 invocation；终态失败保留 journal，按正式回滚证据处理。

## validation

- release ledger 14、controller recovery 11、config render 1 条回归通过。
- 编辑前全库 Context 4,826 errors；这是既有 baseline，不能报告全库绿色。
- 文档 errors/warnings=[]，显式三文件 change-impact 与 diff 检查通过；Context 仍为 4,826，
  新 Task errors=[]。26 条 Context 测试仍有相同四项既有失败，33 条 Context-audit 测试通过。
- 官方下载的两份 ledger 还通过本地 validate_ledger，并精确比较 cell-neutral scope 全部字段相同。

## decisions

- A 用显式 controller-first recovery=1；B 用 normal recovery=0，不把异常恢复变成默认发布路径。
- 继续保留同一 generation 的 Runtime/controller provenance，不把 orchestrator commit 重标为镜像源码。

## scan_scope

- runtime/release-runtime、operations/release_ledger/autonomy_audit 与直接测试邻居。
- load/ten-thousand-active、command-ack-disconnect 的既有资格入口，不扩大到全仓库搜索。

## scan_output

- 编辑前 Context 输出：/data/tmp/minisandbox-runtime-release-context-before.json。

## handoff

- stage：A/B 正式 release 与独立 audit 通过；A 正常串行缩容，B 已回四台。
- verified：完整 image closure、两 Cell 实际 images/ledger/UID/readiness、live 8/2 config、A intent
  恢复、主 FDB 健康。release qualification scope 在两 Cell 相同，Cell releaseId 保持分离。
- unverified：A 回到四台、旧失败 cleanup terminal、当前 runtime 重新 qualification。
- discard：以旧 failed receipt 或单次 release success 宣称 strict 10k 与完整目标完成。
- restore：c592 source、2c generation inventory、a2 Runtime，B 句柄 inv-c9d83v01pt。
- next_action：回查旧 cleanup inv-a9cwx404ak，独立核验 A 的低容量与 controller intent；
  等收尾后按原资格链重新绑定当前 runtime，再做 ACK fault 和 strict 10k，不重叠负载。
- remaining_goal：strict 10k、ACK/commit disconnect、真实告警、Router 性能、百万 dormant 与完整矩阵。
