---
id: minisandbox-topology-rebalance-state-2026-10-04
type: task
scope: 实现同一串行Host drain所有者的UID/RV fenced拓扑再平衡状态机。
triggers: ["minisandbox topology repair", "Host再平衡", "eviction取消fence"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/hostdrain/state_machine.go
  - minisandbox/infra/cells/internal/hostdrain/topology_rebalance.go
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

让现有串行drain状态机可规划并恢复单Host拓扑修复，不再依赖不断放宽skew。
本轮先实现纯状态机与竞态测试；然后接controller真实节点/eviction/RV取消adapter与部署门禁。
不发布、不修改云RBAC、replicas或正在持锁的原supervisor，不重发producer。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式stateless/DO/跨Cell设计Phase5安全缩容；run7d5fa6ac已复现111Host拓扑死锁。
- requirement_refs：2026-09-22-stateless-workers-durable-object-routing.md和infra/cells AGENTS。
- 摘录：一个所有者、最多单Host、扩容优先、UID fence、fresh quiescence、尊重PDB。

## interface_refs / data_structure_refs

- State添加repair源zone、workload UID、旧Pod RV、prefix score，所有字段可JSON持久化。
- Snapshot由adapter提供已准入空闲目标zone证据；没有证据不能开启修复。
- 新Action仅描述同UID/RV eviction及RV取消fence；未接adapter前不可发布含新状态的controller。
- 旧最高ordinal缩容路径不改授权；新路径不改replicas，置换后必须证明拓扑改善。

## history_context

- current_design_refs：正式方案末尾缩容liveness章节。
- relevant_evolution：master3eb169cb保存111Host35/35/41回归和只读精确UID证据。
- superseded_refs：经验性扩充skew阈值不能证明全部ordinal前缀可收敛。

## acceptance / affected_paths

- 有界选择过量zone候选；新鲜、已准入目标zone、低负载稳定窗口、单target身份。
- 成功/丢响应/restart/PDB拒绝/迟到请求/UID替换/超时/扩容/不改善置换确定性测试。
- 取消已有eviction只能先使原Pod RV失效再unfence，已terminating则只等继任，不强删。
- 受影响：本Task/catalog、hostdrain状态机/测试/正式设计；adapter和manifest另有资格门禁。

## required_context / context_receipt

- 新jj mvvvkzrs已在读/规划前创建；保留自己empty120710f5，不squash其他历史。
- route仅must-read upstream-subtrees已完整读取；服务AGENTS承接上一轮已完整加载。
- 有界hostdrain源码、cmd入口、controller测试、runtime节点affinity和host-autoscaling邻居。
- argocd-ci-secrets邻接已读；node*.go猜测失败后改实际runtimecapacity文件列表。
- cloud-environment skill/networking已完整读；environment_status不可用、policy缺失不证明ready。
- 官方API eviction和Kubernetes server eviction.go核验PDB/termination grace及DeleteOptions
  preconditions，不凭回忆宣称RV fence有效；本轮不运行真实eviction。

## evidence / validation / handoff

- 前一目标turn为progress：提交3eb169cb、完整/race/vet通过，确认A阻滞非进程卡死。
- 当前云runtime仍2757；下一只读常规进度不早于21:39:33Z，观察原systemd InvocationID。
- 原严格负载failed、cleanup passed，不因新增组件测试改写资格或结束整体目标。
- 门禁：聚焦/完整hostdrain、race/vet、文档/impact/context零新增错误；源码不等于部署。
- 后续controller adapter必须逐动作重新核验工作负载/owner UID和持久state，处理RV CAS、
  PDB429、late response、重启；真实节点准入/调度容量和真实K8s eviction E2E仍需做。

## 实现checkpoint / validation

- 纯planner实现单target、跨AZ目的证据、稳定窗口、UID/RV持久权威、取消前置CAS和不改善
  Blocked；目标必须已quiescent且非最高ordinal。下一个prefix的sum(count²)是严格下降量。
- 候选用两项平方差计算，不对每个候选复制排序整个fleet；有界内存和单次排序，不做RPC。
  111Host本机benchmark约92微秒/次、102504 B/op，仅为planner成本，不是端到端性能。
- 12组新测试及子场景通过，四个120Host模型逐台收敛到4且三zone不丢、最多一台drain。
  模型明确假定目标zone成功调度；不能替代K8s或云证据。
- 全hostdrain包与cmd入口race/vet通过；cmd没有自己的测试，不能把其编译当作adapter验证。
- 官方server代码显示eviction会写DisruptionTarget并推进RV。因此取消必须是自己的metadata
  CAS凭据，不能仅凭RV变了就unfence；原RV请求可能已获服务端新的delete RV。
- 当前controller未填spare-zone/Pod-RV证据，仍不会进入新分支；两个新Action也未接adapter。
  本源码不能单独作为修复发布，云RBAC和运行image均未改。
- inv-a9fepp0qp3 SUCCESS/0，21:40:48Z A/B111/47、Machines115/51；
  inv-e9fevigr2f SUCCESS/0，21:47:09Z A/B111/32、Machines115/36；active0，原systemd
  invocation和MainPID261665仍live。下一常规观察不早于21:52:18Z。
- 整体目标仍active，strict10k失败原因与最终缩容缺口都未取得修复后实际资格。
- 最终文档零error/warning；新Task零context error，历史4970错误数组与上一checkpoint
  排序cmp一致；26个context测试仍只有同四个历史失败，audit33测试通过。audit结果为
  needs_agent_review/not_assessed/Unknown，不宣称仓库上下文成熟度门禁通过。
- 七个实际路径impact、whitespace和scoped secret scan通过；未改其他服务catalog记录。
