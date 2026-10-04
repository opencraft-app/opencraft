---
id: minisandbox-cls-gitops-preparation-2026-10-04
type: task
scope: 建立仅包含精确CLS规则的中央Argo准备入口，不发布或同步云资源。
triggers: ["CLS Argo", "日志规则发布", "CLS Git准备"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/observability/cls/render-gitops.py
  - minisandbox/infra/cells/deploy/tencent/fleet/observability/cls/test_gitops.py
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

推进完整stateless/DO/跨Cell设计的可重建日志发布：独立中央AppProject/Application。
不安装agent、不发布API镜像、不调用Kubernetes/COS/CLS、不promote或修改原strict10k任务。
此入口只验证Git候选规则，不签发采集上线资格，也不替代安全镜像和真实addon/查询门禁。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户完整目标是2026-09-22-stateless-workers-durable-object-routing.md；CLS实际通道仍未完成。
- 071c3d10已提供默认关闭的Terraform资源和窄范围renderer，但缺中央Argo规则入口。
- 规则必须来自中央既有desired Git的精确commit，且与当前Storage binding完整一致。
- 仅LogConfig，不能顺带部署namespace、Secret、CRD、agent或runtime。
- 准备阶段禁用自动同步和prune；真实发布仍独立持整段operation lock。

## interface_refs / data_structure_refs / history_context

- 当前管理Git身份参考workers-api/gitops/render-application.py，固定集群内credential-free URL。
- current_design_refs：正式设计CLS诊断章节；observability/cls/README.md。
- relevant_evolution：bb5aa863日志分类、071c3d10安全进程logger/CLS声明；仍为源码证据。
- superseded_refs：不复用Workers API AppProject权限，不追踪mutable main/HEAD或全目录递归。
- Argo基座源码锁定v3.5.2；新增按资源name限制前核对官方ClusterResourceRestrictionItem源码。

## acceptance / affected_paths

- 真实本地Git和CLI回归：固定旧commit，不受工作树/HEAD变化影响；脏候选不被纳入。
- 拒绝错repo、错误revision、symlink、过大/重复JSON、topic/范围漂移；错误不回显输入。
- Application只读取logconfig.json；独立Project只允许同名cluster LogConfig，所有namespace资源拒绝。
- 变更仅cls renderer/Git准备/tests/README、正式设计及Task/catalog；门禁不宣称云采集就绪。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| 根AGENTS、minisandbox/AGENTS、infra/cells/AGENTS@071c3d10 | 当前/前轮全文，规则未变 | jj先建修订、唯一mono2、锁、source与GitOps分离 |
| release-gitops、upstream-subtrees@071c3d10 | 本轮route全文 | master仅源码，不隐式云发布 |
| adjacency/argocd-ci-secrets、workers-api/gitops/render-application.py和test_gitops.py相应测试 | 卡片与真实邻居 | 既有Git身份、独立kind权限与revision绑定 |
| TASK/CHECKPOINT模板、fleet README相关入口 | 本轮全文/入口段 | 规划恢复与操作边界 |
| cls/render.py及README@071c3d10 | 前轮/本轮源码 | 单一规则真源与未验证能力 |
| 官方Argo v3.5.2 types.go与project specification | 主源字段检查 | name/kind权限，拒绝依赖未支持字段 |

## evidence / risks / validation / decisions

- 原任务最新03:07:40Z inv-a9fq9w0pvu SUCCESS/0，PID261665/原InvocationID仍active/running。
- 初次查询误用不存在render-argocd.py，精确文件列表确认实际为render-application.py；未扩大云操作。
- stage：Git发布准备；unverified：安全API镜像发布、collector版本/CRD、精确topic查询、云上Argo。
- 所有input都是调用者已取得的非secret本地声明/Git clone；本入口不证明其云归属或来源真实性。
- next_action：实现并运行真实Git/CLI拒绝回归，核对正式设计；生产模式不采纳开发receipt。
- 本地CLS测试11项通过：6项真实Git/CLI准备与5项原规则渲染；邻接Workers API GitOps
  测试15项通过，包含本地bare Git CAS发布，未接任何云endpoint。
- JSON规则比对采用规范序列化而不是Python对象相等，避免0被当作false而绕过类型检查。
- 官方v3.5.2源码确认ClusterResourceRestrictionItem.Name及isNamedResourceInList；旧版
  v3.1.3仅GroupKind，不能宣称同样精确name权限。本轮没有改变已部署Argo版本。
- 原任务03:14:49Z inv-d9fqgkgvd7 SUCCESS/0，PID261665/原InvocationID仍active/running。
  cloud-environment skill及networking reference已读；status工具与policy snapshot仍不可用，
  不据此宣称managed setup ready，仅使用既有配置selector完成原观察命令。
- 文档零错误/警告、change-impact通过；Context仍5026项，其排序错误数组与071c3d10
  基线逐字一致。根Context测试26项仍4个既有失败：governance assets、Chinese-first、
  compact budget、repository context，不宣称根仓库全绿。
- context-audit测试33项通过，discovery仍needs_agent_review/Unknown/score=null；未提交
  全仓语义Assessment。仅当前8个文件及本Task新增catalog行的有界敏感扫描通过。

## checkpoint

- stage：源码门禁收尾；声明默认inactive，不等于发布、采集或完整goal已完成。
- verified：上述真实本地Git/CLI及邻接15项测试；未重编任何二进制。
- unverified：当前topic云身份、安全API镜像、collector/Argo兼容性、C-only discovery和正反查询。
- discard：旧版GroupKind支持name限制的假设；不能用通用stable文档代替基座精确版本。
- restore：071c3d10父基线、唯一mono2工作树当前修订及本Task；不回写旧仓库。
- artifacts：/data/tmp/cls-gitops-tests-20261004.log、cls-gitops-neighbor-tests-20261004.log；
  云只读观察在strict10k-original-verified-wait-20261004T0315Z.log，根检查回执在
  cls-gitops-root-context-receipt-20261004.json及cls-gitops-root-audit-receipt-20261004.json。
- next_action：有界敏感扫描、Context基线对比和普通FF source push；锁空闲后仍先探索。

## scan_scope / scan_output / handoff

仅本轮文件和新增catalog行；完整测试输出及扫描仅留/data/tmp。
完整goal保持active，原supervisor持锁期间不启动collector或平行负载。
