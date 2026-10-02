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
revision: 1.1.0
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
- 后续只读采样 inv-e9d966gx34 SUCCESS/0（06:07:09 UTC）：A desired/current/Ready Node 均为
  85，最近 provider acknowledgement 为 86→85；B 保持四台。A 自动回收仍在推进。
- 原 A/B immutable audit 均使用 initial-cell qualification mode。恢复这条既有资格链不是把
  autoscaling-cell 降级；同时它不能单独证明 strict 10k 或完整无人值守容量目标。
- B 严格 post-release governance inv-e9d973gcuv SUCCESS/0，审计实际返回 control=block：
  仅 latest_bottomless_receipt_release_binding_mismatch 和
  latest_engine_ha_receipt_not_recent_passed，warnings=[]。FDB available/fullReplication、backup
  restorable、Engine/runtime Ready、三个三域 topology、static release convergence 和 FDB 自动扩容
  稳态均为 true。
- 旧 10k 原句柄仍 RUNNING，输出处于 final capacity wait；源码证明该阶段已完成 Object cleanup，
  不再发起负载。B 自身精确 MachineSet/Cell/Host UID、四台 admitted Ready Node、Idle/no hold/no intent
  经启动前检查，正式 post-release 资格任务 inv-e9d99rguwf 已 detached，并确认 RUNNING。
  它先调用 qualify-runtime.sh 的 production-cell 门禁，再串行执行 qualify-engine-ha.sh、fresh strict
  governance 与 publish-qualified-release.sh。失败即停止，不手工改 reporter；未宣称资格已通过。
- 同一句柄后续已终态 SUCCESS/0：48 个 Actor、6,240 次写入，online checkpoint 期间无服务中断，
  sleep/cold/wake、跨 transient write-debt limit 与 cleanup 均通过。冷醒 p95=1,210.67 ms，
  p99/max=4,752.22 ms；这是 production-cell 数据路径资格，不是 strict 10k 容量资格。
- Engine HA 真实删除一个 exact Pod UID，1,500 次公共 /v1 请求全部成功，并完成故障后写入及
  六副本恢复。Bottomless、Engine HA、activation 三份收据经官方传输完整验真，文件 SHA 前缀
  分别为 a3528ee61847、eb547965ab82、b5695bd739c5；完整 SHA 保留在正式设计与不可变收据中。
- 独立现场核验 inv-e9d9ktg8be SUCCESS/0：B spoke 与中央 Hub 均为 Ready/readyForPlacement=true，
  UID/generation 与 release digest 精确匹配，Host 4/4、Idle/no hold，MachineSet 4/4/4、no intent。
  A 为 47/47/47，仍 Qualifying；没有将 B 通过描述成整个目标完成。
- A 资格任务 inv-d9d9jw0nhw 已 detached 并确认 RUNNING，当前仅用 Kubernetes watch 等待
  MachineSet 回到四台。到达低容量后取得 shared operation lock，重新采集严格审计，再经相同的
  canonical Bottomless/Engine HA/governance/publisher 入口。等待期间不持 lock、不冻结空节点回收。

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
- 后续 Bottomless verifier 10 条通过；两个临时 TAT 编排脚本 bash -n 通过。本轮无 Runtime 编译。
- rebase 到远端 62c1bf91 后，编辑前 Context baseline 为 4,855；原先 4,826 只描述前一 revision。
- 本轮文档 errors/warnings=[]、change-impact/diff 通过，Context 前后仍为 4,855，无新增错误。
  26 条 Context 测试仍为相同四项 baseline 失败，33 条 context-audit 测试通过；自动发现工具输出
  needs_agent_review/not_assessed，不伪报全库门禁绿色。
- qualification activation 3 条、autonomy control shell gate、ACK fault harness 7 条通过。下载的 HA
  receipt 独立验真 canonical digest、前后 immutable release 与 exact victim replacement，activation
  精确绑定 B Cell UID/generation/runtime。

## decisions

- A 用显式 controller-first recovery=1；B 用 normal recovery=0，不把异常恢复变成默认发布路径。
- 继续保留同一 generation 的 Runtime/controller provenance，不把 orchestrator commit 重标为镜像源码。
- 先恢复已经回低容量的 B；A Node controller 独立回收空节点。旧 runner 已结束流量且进入 final wait，
  允许 B 在 shared operation lock 与自身 UID-CAS scale-in hold 下做资格恢复；不允许重叠新的 10k。

## scan_scope

- runtime/release-runtime、operations/release_ledger/autonomy_audit 与直接测试邻居。
- load/ten-thousand-active、command-ack-disconnect 的既有资格入口，不扩大到全仓库搜索。

## scan_output

- 编辑前 Context 输出：/data/tmp/minisandbox-runtime-release-context-before.json。

## handoff

- stage：B 新 Runtime 正式资格已通过且两层 admission 收敛；A 正常串行缩容，资格等待低容量。
- verified：完整 image closure、两 Cell 实际 images/ledger/UID/readiness、live 8/2 config、A intent
  恢复、主 FDB 健康。release qualification scope 在两 Cell 相同，Cell releaseId 保持分离。
- unverified：A 回到四台、旧失败 cleanup terminal、A 当前 runtime 重新 qualification。
- discard：以旧 failed receipt 或单次 release success 宣称 strict 10k 与完整目标完成。
- restore：c592 source、2c generation inventory、a2 Runtime；B inv-e9d99rguwf SUCCESS，A 资格
  句柄 inv-d9d9jw0nhw RUNNING，旧 final-wait inv-a9cwx404ak 不重发。
- next_action：续接 A 句柄，验真低容量、资格与中央 admission；两 Cell Ready 后运行真实 ACK fault，
  旧 runner 终态且全部低容量后再做 strict 10k。
- remaining_goal：strict 10k、ACK/commit disconnect、真实告警、Router 性能、百万 dormant 与完整矩阵。
