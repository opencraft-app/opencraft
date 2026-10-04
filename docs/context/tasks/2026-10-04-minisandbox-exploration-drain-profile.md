---
id: minisandbox-exploration-drain-profile-2026-10-04
type: task
scope: 探索阶段快速Host缩容的配置身份与离线转换校验，不改变云上原任务。
triggers: ["探索缩容", "host drain profile", "快速缩容模式"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/host-drain-profile.py
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
  非法/重复/混合配置拒绝，往返恢复；真实CLI子进程回归。安装/资格接线仍需独立完成。
- 影响：runtime/profile helper及测试、README、正式设计、Task/catalog。

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

## evidence / risks / validation / decisions

- 原run7d5fa6ac于00:46:46Z仍同PID261665/InvocationID live；inv-a9fk5sgigw SUCCESS/0，
  A111Hosts/115Machines、B4/4、active0。没有部署或新增云fixture。
- 本轮先实现离线纯配置转换和验证；尚未连入installer/资格入口，不能称可直接启用。
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

## scan_scope / scan_output

- runtime及hostdrain的有界rg，不读Secret、kubeconfig或其他租户日志。
- 已失败locator：hostdrain/types.go、ten-thousand-active/run.sh、fleet/workerd-host-drain-controller、
  两nodepool根machineset.yaml、runtime/capacity-controller.yaml；实际通过bounded rg定位
  state_machine.go、run-on-builder.sh、runtime/host-autoscaling.yaml和base/machineset.yaml。

## checkpoint / handoff

- stage：离线profile转换/检查与14项回归通过，待源码门禁及授权FF push。
- verified：现有环境字段支持不重编二进制；工具没有Kubernetes/网络调用，不改原live任务。
- unverified：installer/Argo/实际资格接线、云缩容及完整Phase5。
- discard：不存在的上述locator与把e2e-fast当快速缩容的方案。
- restore：仅编辑mono2隔离工作副本，继续原unit/InvocationID观察，不运行云probe。
- next_action：完成文档/Context/impact/secret门禁并交付源码，随后接入实际安装与资格边界。
