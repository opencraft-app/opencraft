---
id: minisandbox-drain-topology-deadlock-2026-10-04
type: task
scope: 确定性复现严格负载后StatefulSet串行缩容的拓扑死锁，不绕过安全门禁。
triggers: ["minisandbox drain topology", "缩容拓扑死锁", "StatefulSet缩容阻滞"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/hostdrain/state_machine.go
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

复现run7d5fa6ac精确清理后A停在111个Host的原因，并收敛后续安全修复边界。
不放宽skew、不强删、不改replicas、不终止持锁supervisor、不重发producer、不发布镜像。
本轮只读云证据、纯状态机测试和文档；新的再平衡动作必须独立实现并验证后才能发布。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式设计Phase5：从低容量负载扩容，最后安全缩回基线；失败不得改写为通过。
- 需求摘录：UID fencing、每次最多一台drain、扩容优先、fresh evidence、fail closed。
- requirement_refs：正式stateless/DO/跨Cell设计与infra/cells AGENTS的Cell安全契约。

## interface_refs / data_structure_refs

- hostdrain.State/Snapshot/Decide/topologyScaleInBlockReason。
- StatefulSet UID、Host Pod UID、HPA、drain/release-hold annotation。
- 当前控制器只允许最高ordinal缩容；pods权限只有get/list，没有eviction/delete。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：已有三AZ缩容边界允许max(配置skew,6,剩余Host数的5%)，仍不能
  保证任意StatefulSet ordinal前缀可缩容。新的111Host分布超过此前81Host回归覆盖。
- superseded_refs：不能把不断提高经验性skew阈值当作无人值守收敛算法。

## acceptance / affected_paths

- 只读核验精确当前UID、各AZ计数、最高ordinal和后续前缀，保存无secret证据。
- 用真实计数与尾部序列复现Idle/ActionNone及原因；同时证明较低前缀恢复边界。
- 保留现有fail-closed行为，记录需要显式再平衡而不是偷偷绕过门禁。
- 受影响路径：本Task/catalog、hostdrain测试、正式设计和严格负载evidence目录。

## required_context / context_receipt

- 路由must-read仅upstream-subtrees，已完整读取；根/minisandbox/infra-cells AGENTS已读。
- 新jj trsolmsx，保留上轮推master 3632f68d和空checkpoint父版本，无其他worktree写入。
- 有界搜索hostdrain源码/测试，runtime/render.py猜测不存在，已按文件清单纠正真实入口。
- 邻接argocd-ci-secrets已读，核验host-autoscaling.yaml及test_host_autoscaling.py部署邻居。
- cloud-environment skill/networking已读；仅原配置CLI，不打印凭据或任意环境。

## evidence / validation / handoff

- inv-c9fecxg7m8 SUCCESS/0：21:29:35Z A111 Ready、Idle、无release hold、零采样reconcile
  error；控制器原因为scale-down would violate runtime topology maxSkew。HPA正常，缩容禁用
  是既定所有权策略，不是故障。B74正在Draining。
- inv-a9fedmgbjh SUCCESS/0：A三AZ35/35/41，最高ordinal110在第一AZ；110前缀34/35/41
  skew7，109前缀34/35/40 skew6，105前缀34/34/37 skew3；调度约束maxSkew1仅约束新放置。
- 原inv-e9fed008a9 SUCCESS/0：supervisor仍running，同InvocationID/MainPID；load已failed，
  cleanup passed，active0，A/B111/74，Machines115/78。下一常规观察不早于21:34:36Z。
- 计划门禁：聚焦/full hostdrain测试、race/vet、文档/impact/context增量零新增错误。
- 下一步不是发布诊断或开新压测：先固化此liveness缺口，再实现可恢复的单Host再平衡。

## risks / decisions

- 现有阻止删除是安全的，但会保留空闲成本并阻止最终低容量资格收敛，不能宣称通过。
- 再平衡候选必须来自过量AZ，不与串行缩容并发；保持replicas不变并允许扩容抢占。
  仅在精确Pod UID对应Host已fenced且quiescent时通过尊重PDB的eviction替换，不能裸delete。
- 要确认有可调度的已准入目标zone容量，替换Ready后重新证明拓扑改善，不假设scheduler
  必然迁移；迟到响应、UID替换、controller重启、release hold和共享故障均fail closed。
- 此路径尚未实现/部署；本轮不增加云RBAC，不通过操作锁旁路修复live集群。
- eviction发出前可以恢复旧UID placement并取消；发出后不可假装回滚已删除Pod，必须
  保留不可逆阶段并等待精确继任UID Ready。扩容仅停止后续缩容/修复，不能把旧UID
  unfence发送给新Pod。deadline到期告警并停止动作，不强删、不无限重试替换。

## 验证checkpoint

- 新确定性测试、完整hostdrain包、race及vet全部通过，未修改产品状态机逻辑。
- JSON语义、diff whitespace及真实六文件impact通过；documentation零error/warning。
- 首次context因新Task只有两个trigger多出一个error，已补第三个；重验新Task零error，
  历史4970错误数组与上轮排序cmp完全一致。catalog只修改本Task单行hash。
- context26测试仍为同四个历史失败，context-audit33测试全部通过；审计discovery不是成熟度
  assessment。首次audit漏--output被拒绝，按要求改为完整产物只落/data/tmp。
- progress17 inv-d9fehk0u2a SUCCESS/0：21:34:25Z样本A/B111/62、Machines115/66、active0，
  原supervisor仍running。下一常规观察不早于21:39:33Z；A阻滞不重标为final-capacity通过。
