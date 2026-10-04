---
id: minisandbox-cls-rule-preflight-2026-10-04
type: task
scope: 核验首次CLS canary之前的API server规则往返，不启用采集。
triggers: ["CLS规则往返", "LogConfig server dry-run", "采集规则裁剪"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/observability/cls/preflight-rule.py
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

推进完整stateless/DO/CLS目标，防止CRD裁剪安全采集字段后仍允许首次canary。
不安装collector、创建规则、开Argo同步、查询无绑定topic或修改原strict10k。
不以本地double或server dry-run替代CLS正反查询和完整规模资格。

## requirement_ids / requirement_refs / requirement_excerpt

正式2026-09-22设计的CLS接线要求actual addon/CRD与安全metadata/过滤兼容。
用户要求后续探索作为第一道，不中途修改现有qualification。

## interface_refs / data_structure_refs / history_context

current_design_refs：正式stateless/DO routing设计CLS段、observability/cls/README。
relevant_evolution：071c3d10安全规则、d7c8a5ee API候选实际OCI回执。
superseded_refs：renderer成功可以证明API server/collector保留所有安全字段。
规则继续来自现有binding/render.py，不复制第二套规则或topic所有权。
回执只claim server-side-logconfig-roundtrip-only，canaryAuthorized固定false。

## acceptance / affected_paths

- 实际kubectl进程只get Namespace/CRD和create --dry-run=server --validate=strict。
- 两次Namespace UID一致；CRD kind/group/scope/served/conditions/UID正确，前后定义/状态不变。
- exact spec/名称/annotations往返，拒绝剪裁、改写、增加选择或metadata范围。
- 错误不回显Kubernetes stderr或任意响应字段，失败无成功回执。
- 本地真实进程协议double覆盖成功、身份替换、CRD不就绪、过滤丢失及请求错误。
- 修改CLS入口/测试/README、正式设计和本Task；不动云desired state。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| 根及minisandbox/infra/cells AGENTS全文 | 当前继承边界 | 云持锁、单源、独立制品与准入 |
| upstream-subtrees Pack全文 | router唯一must_read | mono2唯一写入源 |
| adjacency/argocd-ci-secrets及CLS render-gitops/test邻居 | 历史定位 | 独立未授权Argo准备不是实际采集 |
| CLS README/render.py/test_render.py全文 | 当前规则真源 | 核验实际返回而非新建规则 |
| 正式设计CLS段、Task/Checkpoint模板 | 当前要求与交接 | 不缩小完整目标 |
| cloud-environment主文/network全文 | 实际TAT只读 | 无status/policy不冒充ready，保留正常凭据选择器 |

## evidence / risks / validation / decisions

- 原strict10k只读inv-c9ftsx060c SUCCESS/0：05:08:05Z，同Invocation仍active/running，
  A111Host/115Machine、B4/4、active0；load failed/cleanup passed结论不变。
- 官方LogConfig格式及版本说明确认metadata省略会全报，backtracking=0才增量；
  网站open超时，搜索返回官方完整相关字段，不能代替实际collector行为验证。
- 新检查不叫readyForCollection，不授权canary；无API镜像/collector/Argo/query证明时继续拒绝。
- 可信发布链提供expected UID和kubeconfig；本CLI不能从本地选择器证明云cluster ID。
- create dry-run仍要求create RBAC，webhook不支持dry-run直接拒绝。已有同名规则冲突不覆盖。
- 本地unittest/文档/context基线/diff与敏感扫描交接前记录。
- 文档零error/warning，audit工具33项通过；根26项仍为原四项历史失败。
  首轮Context多出本Task只有两个trigger的错误，已补第三项并重新检查，不覆盖旧错误。
- CLS完整17项测试通过，新五项回归执行23次实际CLI进程协议double，包含CRD前后替换、
  定义改变、删除中、集群替换及12类规则改写；不访问Kubernetes或Tencent API。
  日志为/data/tmp/cls-rule-preflight-final-tests-20261004.log，不将其当云dry-run证明。

## scan_scope / scan_output / handoff / checkpoint

stage：CLS前置往返检查实现，本地协议回归通过；完整目标仍active。
verified：原supervisor精确身份仍live；API候选源码/证据已master，不是现网发布。
unverified：真实TKE dry-run、collector行为、CLS canary/清理及全规模资格。
discard：local render能证明CRD字段保留的假设。
restore：mono2 d7c8a5ee及原strict10k固定Invocation/PID；本轮独立jj revision。
next_action：跑真实CLI协议回归并审阅失败边界，记录证据；锁释放后先探索发布，不手工绕过。
scan限定本轮文件，原始日志/回执留/data/tmp，不输出credentials或无绑定服务日志。
