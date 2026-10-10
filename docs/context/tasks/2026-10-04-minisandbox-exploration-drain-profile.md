---
id: minisandbox-exploration-drain-profile-2026-10-04
type: task
scope: 探索Host缩容配置、共享容量周期与独立开发证据，不改变云上原任务。
triggers: ["探索缩容", "host drain profile", "快速缩容模式"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/host-drain-profile.py
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/install-host-autoscaling.sh
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/qualify-runtime.sh
  - minisandbox/infra/cells/deploy/tencent/fleet/load/capacity-cycle/run-on-builder.sh
  - minisandbox/infra/cells/deploy/tencent/fleet/load/exploration-capacity/run-on-builder.sh
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.2.0
precedence: task
derived: false
---

## goal / non_goals

为生产参数下的探索缩容建立独立profile，只改变Host drain的等待节奏。
第一道容量验收使用固定较小真实负载，复用生产编排/校验，不能晋升为生产证据。
不改Actor/存储配额，不切换e2e-fast，不改AZ/PDB/UID/单活或逐台排空；不发布、不缩短
原strict10k的36h观察窗口、不停止或重启原supervisor，不重编workerd或Go controller。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户：探索阶段能否增加快速缩容模式；原stateless/DO设计Phase4安全缩容仍适用。
- 用户最新要求：后续先用探索模式作为第一道验收，加快推进；生产资格仍独立验收。
- 本轮延伸：建立独立探索容量入口，复用现有真实负载/清理/采样/验证逻辑，输出明确开发证据。
- 后续延伸：原installer增加仅profile切换，绑定现有Deployment UID/RV，不重部署镜像/RBAC/HPA。
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
| release-gitops.md、upstream-subtrees.md、adjacency/argocd-ci-secrets.md@227681a2 | route全文及test_supervisor/test_capacity_receipt邻居 | 共享实际shell入口、不同scope、生产拒绝开发证据 |
| shared-agent-scale/runner.mjs与README、strict10k入口/verify/tests@227681a2 | recipe段及完整编排/校验 | 保留真实代码上传、SQLite、稳态3秒及精确清理 |
| operations/with-autonomy-operation-lock.sh与assert-autonomy-control.sh@227681a2 | 全文 | 真整段flock、两Cell控制门禁、不新增bypass |
| 根AGENTS、minisandbox/AGENTS、infra/cells/AGENTS及route must_read@b43776e0 | 本轮重读全文 | 无构建/云mutation、同一installer owner |
| adjacency/argocd-ci-secrets与test_host_autoscaling/profile/scripts及API double@b43776e0 | 全文与邻居 | 真实CLI/CAS回归、不是静态文本证明 |
| runtime/gitops/render-desired-state.py及release_ledger.py相关inventory段@b43776e0 | 有界读取 | 现有stateless Argo不拥有Host drain，ledger也未纳入该Deployment |

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
- 探索入口已源码实现：320活跃/352总Object/4Version；共用capacity-cycle、同一JS负载器、
  cleanup和verifier谓词。begin/end profile读取，drainProfile独立exit status；开发schema
  与claimEligible=false，生产参数/36h窗口保持，原冻结snapshot不变。
- 探索默认沿用真实operation-lock wrapper；两Cell autonomy control先于输出/API/负载。
  73 strict10k目录测试通过，含真实flock冲突、控制block、模式互拒、生产argv不变、
  开发成功与各种终态失败；Router邻接11项通过，开发收据在任何性能输出/查询前拒绝。
- 01:46:24Z inv-e9fmvpg61d SUCCESS/0：原unit仍同PID/InvocationID，A111/115、B4/4、
  active0。本轮仅正常selector的只读TAT；没有安装、Argo发布、probe或新producer。
- 本轮locator失败已收敛：launch-on-builder.sh不存在，实际在evidence的launch-prepared；
  operations/policy.json不存在，实际autonomy-policy.json。没有扩大到租户日志或secret内容。
- 共享JS负载器13项真实HTTP/heartbeat测试通过；docs仍0错误/警告，context4970项
  sorted errors与227681a2基线逐项cmp一致。root26仍相同4个历史失败，audit33通过；
  discovery为needs_agent_review/not_assessed/Unknown，不声称全仓green或生产资格。
- impact覆盖当前14文件；shell语法与diff check通过。仅本次文件和当前catalog行进行
  secret扫描，不读取历史catalog或租户内容。根scripts路径未命中，实际校验器在
  .agents/context/scripts，已收敛到该有界路径。
- 02:00:42Z inv-e9fnb5056w SUCCESS/0：原unit同PID261665/InvocationID仍live，A111/115、
  B4/4、active0；原load request_retry失败/cleanup通过不变。本轮没有云mutation。
- 初次普通push因远端master前进被拒绝，已fetch并将仅本轮未发布revision置于
  50b1af24之后；保留团队30个文件变更，无重叠冲突、无force，minisandbox tree逐字不变。
  重读当前docs仍0错误/警告；context新增56项全部来自该远端新增的4个sidebar Task文件，
  其余4970项与原基线一致；不替其他团队修改或重建历史catalog。
- b43776e0后的本轮源码事实：Host drain没有进入stateless executor Argo或静态release
  ledger；不为探索把它塞进另一个应用。原installer新增仅profile路径，先control，再
  GET并绑定expected UID，patch内UID/RV CAS，不更新镜像/RBAC/HPA。final GET比较原UID、
  target profile与其余完整spec；检测到Argo owner拒绝。没有新writer或控制bypass。
- 34 focused测试通过，含10个新增transition测试；真实CLI/shell double复现UID/RV冲突、
  dry-run/提交失败、响应丢失、rollout失败、最终无关spec漂移。丢响应不能宣称配置未变；
  仅原UID受锁恢复生产。syntax/diff check通过，仍未运行live installer。
- 02:13:36Z inv-e9fnp80gkt SUCCESS/0：原unit同PID/InvocationID active/running，
  没有因本地工作启动平行producer。managed环境状态工具缺失、policy文件缺失，不把
  此缺失当作网络ready；沿用已配置selector，验证实际TAT终态，不输出凭据。
- 最终仅profile路径还核对单副本Recreate；34 focused测试通过，邻接容量73项通过。
  root26仍同4项历史失败（逐名对照），audit33通过；discovery仅needs_agent_review、
  Unknown/null，不等于语义评审。docs0错误/警告、context5026项与b43776e0后的基线
  sorted cmp一致；impact、syntax、diff check通过。本轮无Rust/workerd/Go构建。
- 本轮一次apply_patch hunk格式错误已修正；没有以shell写文件代替源码patch或改变云状态。
- 02:21:47Z inv-e9fnwvgq43 SUCCESS/0：原PID/InvocationID仍active/running，A111/115、
  B4/4、active0；本轮没有发布、模式切换、probe或平行负载。

## scan_scope / scan_output

- runtime及hostdrain的有界rg，不读Secret、kubeconfig或其他租户日志。
- 已失败locator：hostdrain/types.go、ten-thousand-active/run.sh、fleet/workerd-host-drain-controller、
  两nodepool根machineset.yaml、runtime/capacity-controller.yaml；实际通过bounded rg定位
  state_machine.go、run-on-builder.sh、runtime/host-autoscaling.yaml和base/machineset.yaml。

## checkpoint / handoff

- stage：UID/RV绑定仅profile切换与回归完成，准备FF源码交付；云上接线尚未验证。
- verified：本轮34 focused测试与shell语法通过；上一轮73容量+11 Router+13 JS已通过；
  不改原live任务，未运行云installer/qualifier/probe。
- unverified：真实云安装/转换与Argo收敛、探索扩缩容、生产容量与完整Phase5、CLS采集。
- discard：不存在的上述locator与把e2e-fast当快速缩容的方案。
- restore：仅编辑mono2隔离工作副本，继续原unit/InvocationID观察，不运行云probe。
- next_action：FF源码交付；原任务释放锁后
  再探索功能收敛、实际TKE身份绑定故障门禁与生产容量验收，不启动平行producer。
