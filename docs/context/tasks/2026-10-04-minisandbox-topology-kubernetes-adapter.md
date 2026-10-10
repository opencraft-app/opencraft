---
id: minisandbox-topology-kubernetes-adapter-2026-10-04
type: task
scope: 将Host拓扑修复动作接到精确身份与持久取消凭据的Kubernetes adapter。
triggers: ["minisandbox eviction adapter", "Host取消凭据", "Pod RV fence"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/hostdrain/controller.go
  - minisandbox/infra/cells/internal/hostdrain/topology_adapter.go
  - minisandbox/infra/cells/internal/hostdrain/topology_capacity.go
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

实现精确Pod UID/RV eviction及其取消CAS adapter，并核验持久状态、owner UID和每次动作。
不发布、不修改云资源/RBAC、不干扰原supervisor，不编译workerd。增加目的zone容量接线
和源码manifest的显式默认关闭开关；真实Kubernetes eviction资格仍需后续验证。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式stateless/DO/跨Cell设计Phase5安全串行缩容；A111Host拓扑死锁。
- requirement_refs：infra/cells AGENTS与2026-09-22-stateless-workers-durable-object-routing.md。
- 摘录：单一所有者、单target、UID/RV、扩容优先、尊重PDB/grace、取消证明先于恢复placement。

## interface_refs / data_structure_refs

- StateAnnotation是操作权威；Pod controller OwnerReference而非Pod名称证明workload身份。
- policy/v1 Eviction DeleteOptions Preconditions UID/RV，不指定强制grace、不直接Delete。
- 取消token绑定workload UID、target UID、epoch、原eviction RV；当前Pod metadata CAS写入。
- Snapshot读取Pod RV和exact token，不能从任意RV变化推断取消成功。

## history_context

- current_design_refs：正式方案末尾缩容liveness章节。
- relevant_evolution：24a7d42c纯FSM已合并，controller没有目的zone容量，仍不会发起修复。
- superseded_refs：仅凭RV变化取消不安全；官方server先写DisruptionTarget再按新RV删除。

## acceptance / affected_paths

- typed client真实HTTP请求载荷：UID/RV/PDB429、无强删、取消CAS/丢响应/替换身份。
- 动作重新GET持久state/UID/hold；错误/不完整观测fail closed；严格JSON EOF。
- hostdrain全包/race/vet及文档/context/impact门禁零新增错误。
- 受影响：本Task/catalog、hostdrain adapter/controller/tests、cmd、源码manifest/installer/tests
  与正式设计；不部署云manifest。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@24a7d42c | 根P0与context规则 | 唯一mono2写入、授权及门禁 |
| minisandbox/infra/cells/AGENTS.md@24a7d42c | 局部操作规则 | 持锁任务不变更、PDB/身份 |
| docs/context/project/upstream-subtrees.md@24a7d42c | route must_read | 不编辑旧独立仓库 |
| docs/context/project/services/ctl.md@24a7d42c | route must_read | 泛adapter命中；不扩展CTL范围 |
| docs/context/project/adjacency/argocd-ci-secrets.md@24a7d42c | 相邻发布门禁 | 源码不等于发布 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@24a7d42c | Cell入口 | 只读查询与现有发布协议 |
| minisandbox/infra/cells/internal/hostdrain/controller.go、topology_rebalance.go及controller_test.go@24a7d42c | 精确定位 | owner/RV/token与fresh action检查 |
| minisandbox/infra/cells/deploy/tencent/fleet/runtime/host-autoscaling.yaml及install-host-autoscaling.sh@24a7d42c | 部署邻居已完整读 | 当前pods只读RBAC，未发布adapter |

## evidence / risks / validation / decisions

- 当前jj sonnrpzm在任务动作前已创建，保留空父4281cd8c，不改无关历史。
- inv-d9ff2rg769 SUCCESS/0：21:52:39Z A/B111/18，Machines115/23、active0；
  原unit InvocationID c5d5db1b472d4631aa48ab25e91a629a/MainPID261665仍live。
- cloud-environment skill/networking已读；environment_status不可用、policy缺失不证明ready。
- 无准备好的destination证据时RebalanceZones为空；不能发布adapter为完整云修复。
- Kubernetes source主分支的语义不是当前TKE实测，真实API门禁仍待做。

## handoff

源码adapter/capacity接线已实现，严格负载已failed、cleanup passed，最终A缩容未完成。
保留原operation lock与任务；不发布，不重编workerd，不宣称目标完成。

## checkpoint

- 基础adapter全包与race通过；取消不依赖Host管理listener，caller不得直接restore placement。
- 实际发现runtimecapacity admission文件为state.go、K8s模块为go.mod所列v0.35.2；
  两次猜测不存在文件已改为有界rg定位，不扩展其他服务。
- inv-e9ffam0qji SUCCESS/0：22:01:11Z B已缩到4Hosts/4Machines，A仍111/115；active0。
  原unit仍相同InvocationID/MainPID，下一常规观察不早于22:06:14Z。
- 目的capacity证据只读、当前模板允许的保守子集；未知调度约束fail closed，不模拟完整scheduler。
- 21组新测试通过：typed-client真实HTTP eviction/cancel、UID/RV/grace/PDB429、丢响应、
  不依赖管理HTTP的取消恢复、fresh deadline、owner替换、partial API库存、精确准入身份、
  allocatable/requests、111Host完整reconcile以及边界HPA扩容/STS RV变化。全hostdrain和
  runtimecapacity/admission的race通过；HTTP double不是实际Kubernetes server资格。
- 修复Token proof需own metadata CAS，任意RV变化不算；配置开关默认false，尚未部署。
- 实际Node/Machine/Pod容量观测有界且无写入，不预留scheduler容量；新Pod必须实际改善score。
- 最终race覆盖hostdrain、runtimecapacity/admission；vet、五个manifest测试、bash语法通过。
  cmd仅编译，没有独立测试。文档zero errors/warnings；context新Task零错误，历史4970
  errors排序数组与前一checkpoint完全cmp一致。26个context测试仍为同四个历史失败，
  audit33测试通过；不宣称整个仓库context成熟度通过。
- CLI audit输出为Markdown（两次jq格式读取失败不改其报告），随后按实际输出读取结果；
  不把discovery报告提升为assessed生产证据。
- inv-c9ffmb0j39 SUCCESS/0：22:12:35Z A/B111/4，Machines115/4、active0，原unit同UID/PID。
  无新增error/warning/missing signals；原load failed与cleanup passed的结果仍不变。
- 下一步：真实Kubernetes UID/RV/PDB/cancel API门禁；通过后才能授权开启false开关。
  源码push不改正在持锁的云controller，严格10k整体目标仍active。
