---
id: minisandbox-exploration-drain-profile-2026-10-04
type: task
scope: 探索阶段快速Host缩容的配置身份与离线转换校验，不改变云上原任务。
triggers: ["探索缩容", "host drain profile", "快速缩容模式"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/host-drain-profile.py
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/install-host-autoscaling.sh
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/qualify-runtime.sh
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

为生产参数下的探索缩容建立独立profile，只改变Host drain的等待节奏。
不改Actor/存储配额，不切换e2e-fast，不改AZ/PDB/UID/单活或逐台排空；不发布、不缩短
原strict10k的36h观察窗口、不停止或重启原supervisor，不重编workerd或Go controller。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户：探索阶段能否增加快速缩容模式；原stateless/DO设计Phase4安全缩容仍适用。
- 用户最新要求：后续先用探索模式作为第一道验收，加快推进；生产资格仍独立验收。
- profile不得混入生产容量资格，短稳定窗口不能解决111Host的拓扑liveness卡点。
- 用户另问AZ售罄：供应不足不是健康节点故障；本任务不自动降低三AZ约束。

## interface_refs / data_structure_refs

- runtime/host-autoscaling.yaml的controller Deployment及HOST_DRAIN环境字段。
- production=5m/5s；exploration=30s/2s；固定10m取消期限、45s freshness和三AZ保持。
- Pod template annotation作为profile身份；离线检查同时核对实际值，不只信任标记。

## history_context / acceptance / affected_paths

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md Phase4。
- relevant_evolution：8c0b6a8d源码与TKE入口准备；prod installer固定5m/5s。
- superseded_refs：e2e-fast还改变存储/Actor参数，不是本profile的别名。
- 验收：实际manifest生成fixture；默认不改变对象；探索仅改两个timer与自身annotation；
  非法/重复/混合配置拒绝，往返恢复；真实CLI和shell子进程回归。云API/Argo接线另需证据。
- 影响：runtime/profile helper、installer/release/qualify、strict10k入口及测试、局部AGENTS、
  README、正式设计、Task/catalog。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md与infra/cells/AGENTS.md@8c0b6a8d | 全文 | mono2唯一写入源、operation lock、无强删 |
| release-gitops.md与upstream-subtrees.md@8c0b6a8d | route全文 | 源码不等于部署、授权FF push |
| adjacency/argocd-ci-secrets.md@8c0b6a8d | 全文及test_host_autoscaling.py邻居 | 现有manifest测试与profile部署边界 |
| runtime/install-host-autoscaling.sh及host-autoscaling.yaml@8c0b6a8d | 全文/相关controller块 | 现有5m/5s、唯一scale-in writer |
| runtime/install.sh与release-runtime.sh@8c0b6a8d | profile与调用段 | 不混用e2e-fast、不修改生产release |
| runtime/qualify-runtime.sh@8c0b6a8d | profile段 | 后续必须核对live配置，不只看caller环境 |
| hostdrain/state_machine.go@8c0b6a8d | stabilization/converging段 | 连续低负载只需一次稳定窗口，仍逐台收敛 |
| AGENTS.md、infra/cells/AGENTS.md、upstream-subtrees.md、adjacency/argocd-ci-secrets.md@fbd675d2 | 最新要求后重读全文；test_host_drain_profile.py邻居 | 持久化探索优先、不混用生产结果 |
| minisandbox/AGENTS.md（指向CLAUDE.md）、release-gitops.md、TASK/CHECKPOINT模板@fbd675d2 | 本轮全文 | jj连续当前变更、真实进程double、源码交付不是发布 |

## evidence / risks / validation / decisions

- 原run7d5fa6ac于00:46:46Z仍同PID261665/InvocationID live；inv-a9fk5sgigw SUCCESS/0，
  A111Hosts/115Machines、B4/4、active0。没有部署或新增云fixture。
- fbd675d2已FF push，离线工具14项回归通过；本轮开始接入installer及真实配置读取门禁，
  只做本地回归，不调用live installer或替换原supervisor。
- 最新探索优先顺序已写入局部AGENTS与runtime README；这是后续验收策略，不是云上已启用。
- 本轮源码接线回归：runtime 24项通过（profile/manifest16、真实shell8）；strict10k目录
  64项通过（含supervisor5项）。本地fixture不访问云API或继承kubeconfig/credential env。
- installer 默认生产对象结构保持不变；探索转换同一渲染List，SA/RBAC/HPA不变，
  返回前GET live核对profile。exploration拒绝e2e-fast配额、缺锁；production release早拒绝
  exploration。qualify在lock/control后GET live，在hold之前拒绝探索/漂移/API失败；strict10k
  在observer/load/cleanup/verifier之前拒绝。helper支持受限List，仅check接受单Deployment。
- 01:23:10Z inv-e9fm7x09ns SUCCESS/0：同PID/InvocationID live，A111/115、B4/4、active0；
  final等待16239s。工具未提供managed environment_status，network-policy文件缺失；
  不据此声称ready，沿用正常配置selector并验证本次TAT结果。没有任何云mutation。
- 后续生产门禁必须读取实际Deployment并核对profile，不能仅检查环境变量。
- 风险：30s窗口增加反复扩缩容可能；它不缩短排空超时，也不保证真实Node释放时长。
- 验证：Python真实manifest/CLI回归、documentation/context/impact/secret门禁。
- 离线工具现已实现；production转换结构不变，exploration仅两timer及自身annotation。
  已跑14项回归（9项profile+5项既有manifest），包含真实CLI、往返、重复/非有限JSON、
  marker/参数混合、间接env及安全字段拒绝；没有installer接线或live发布。
- docs校验0错误/警告；context sorted errors4970项与8c0b6a8d基线逐项一致。
  root26测试仍相同4个历史失败，audit33测试通过；discovery不等于Agent语义评审。
- 两次验证命令启动失败已修正：impact曾误用runtime cwd；audit JSON曾缺少必需的
  --output。正确repo cwd的impact覆盖全部6个变更并通过；audit已使用受保护本地产物。
- scoped secret scan只检查本次5个文件及新增catalog行，通过；没有扩大到历史catalog。
- 00:53:18Z inv-a9fkbx0s8r SUCCESS/0：原unit同PID/InvocationID仍live，A111/115、B4/4、
  active0；load失败/cleanup通过结论不变。没有修改原source bundle或supervisor。
- 本轮最终门禁：邻接runtime 59项通过，docs0错误/警告、shell语法、diff check、impact覆盖
  全部15文件、14文件及1行catalog secret扫描通过。root26仍同4项历史失败（逐名与
  tke-native-go基线核对），audit33通过；discovery=needs_agent_review/not_assessed/Unknown。
- context仍4970项：唯一diff是局部AGENTS历史超预算错误的字节数77452→77885。
  只归一该条的bytes后逐项cmp通过，不能称全量green或无条件exact baseline一致。
  初次exact cmp失败后已核对diff并压缩新增操作指令，未重建历史catalog。
- 01:33:37Z inv-d9fmhqg067 SUCCESS/0：原unit同PID/InvocationID仍live，A111/115、B4/4、
  active0，原load失败/cleanup通过不变。没有部署、缩容或平行负载。

## scan_scope / scan_output

- runtime及hostdrain的有界rg，不读Secret、kubeconfig或其他租户日志。
- 已失败locator：hostdrain/types.go、ten-thousand-active/run.sh、fleet/workerd-host-drain-controller、
  两nodepool根machineset.yaml、runtime/capacity-controller.yaml；实际通过bounded rg定位
  state_machine.go、run-on-builder.sh、runtime/host-autoscaling.yaml和base/machineset.yaml。

## checkpoint / handoff

- stage：安装与生产入口源码已接线、聚焦及邻接回归和交付门禁完成；准备FF交付。
- verified：无需二进制重编；24 runtime+64 strict10k本地测试通过，shell语法通过；
  不改原live任务，未运行云installer/qualifier/probe。
- unverified：真实云安装/转换与Argo收敛、探索扩缩容、生产容量与完整Phase5、CLS采集。
- discard：不存在的上述locator与把e2e-fast当快速缩容的方案。
- restore：仅编辑mono2隔离工作副本，继续原unit/InvocationID观察，不运行云probe。
- next_action：FF交付源码；原任务释放锁后，先探索功能收敛，
  再实际TKE身份绑定故障门禁及生产容量验收，不启动平行producer。
