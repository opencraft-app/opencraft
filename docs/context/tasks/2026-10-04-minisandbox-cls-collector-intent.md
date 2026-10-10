---
id: minisandbox-cls-collector-intent-2026-10-04
type: task
scope: 官方CLS collector的固定版本与镜像可重建声明，默认不安装或采集。
triggers: ["CLS collector声明", "tke-log-agent固定版本", "禁用Kafka listener"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/terraform/create-first/management/cls.tf
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

推进完整stateless/DO/CLS目标，补官方collector的Terraform所有权与固定镜像声明。
不安装/升级collector，不创建LogConfig、IAM role、云topic或开启Argo；不改原strict10k。
不以mock provider或registry manifest读取冒充collector行为、cold pull或生产资格。

## requirement_ids / requirement_refs / requirement_excerpt

正式stateless/DO routing设计CLS接线要求actual addon/CRD及安全采集，不能使用latest或第二
套自研agent。用户要求所有资产可重建、工作在/data，后续探索先行，不改当前资格任务。

## interface_refs / data_structure_refs / history_context

current_design_refs：正式2026-09-22设计CLS段、CLS README、create-first README。
relevant_evolution：8439d81c server规则往返检查；d7c8a5ee安全API候选尚未部署。
superseded_refs：按Kind=log能找到全部日志addon；DescribeAddonValues非空能证明已安装。
platform_cls_binding保持旧精确schema，collector另出credential-free binding且canaryAuthorized=false。
management TF只拥有C的官方addon；TKE addon manager拥有工作负载/CRD，Argo只拥有单份规则。

## acceptance / affected_paths

- storage与collector分别默认关闭，开storage不会隐式装collector。
- 开collector要求storage已声明；显式1.1.25 chart、三个registry manifest digest，无latest。
- raw_values为JSON，provider 1.83.11自行base64；禁Kafka与alternate规则controllers/role creation。
- 新旧binding保持分离，不能从Terraform输出获得采集资格。
- native mock plan直接复制生产cls.tf，测默认、storage-only、pinned opt-in与缺storage拒绝。
- 修改production cls.tf、native fixture、CLS README/证据、正式设计和自己的Task/catalog。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| 根/minisandbox/infra/cells继承AGENTS当前全文 | 同会话已读取，当前未变 | 不改现有持锁任务，mono2单源 |
| release-gitops/upstream-subtrees Pack全文 | router全部must_read | 源码与部署资格分开 |
| adjacency/argocd-ci-secrets、CLS native test邻居 | 有界历史定位 | 所有权/验证副作用边界 |
| create-first README、management cls.tf/versions.tf | 实际生产入口 | 不接旧state，不虚构ID，固定provider |
| CLI DescribeAddon/GetTkeAppChartList/DescribeAddonValues help | 实际只读API | 不猜不存在的DescribeAddonVersions |
| 官方InstallAddon及provider 1.83.11源文件全文 | RawValues和版本语义 | JSON不二次base64；缺version会latest |
| cloud-environment主文/network全文 | read-only cloud/registry观察 | 普通凭据选择器，status/policy缺失不冒充ready |

## evidence / risks / validation / decisions

- 北京C全addon列表无tke-log-agent，direct query ResourceNotFound；默认Values仍非空。
- Kind=log筛选为空；不筛kind的73项catalog在other下给出tke-log-agent 1.1.25。
- DefaultValues给出三image tag并默认开Kafka；完整响应仅留protected /data/tmp，源内仅白名单。
- inv-e9fuk40v24 SUCCESS/0实际skopeo读取三个官方manifest digest；没有cold pull或执行。
  证据见CLS/evidence/beijing-collector-discovery-20261004.json。
- provider1.83.11实际schema支持addon_version/raw_values，源码确认create/update自行base64。
- 首轮native mock plan捕获logAgent tag拆分漏掉v，修正后重跑；不掩盖失败或称为云故障。
- 所有tf检查隔离backend与credentials，只plan；云安装仍待整段operation lock。
- native mock七项通过，直接复制production cls.tf并与归档catalog/manifest pins对照；
  Python CLS17项回归、完整management静态validate与文档基线交接前复核。
- 最终native七项、Python17项和完整management validate通过；native fixture使用生产provider
  lock且init -lockfile=readonly，不从任意cache生成新的信任hash。所有本轮资产默认关闭。
- 文档零error/warning，Context sorted5026历史问题与原基线逐字一致；根26项保持原四项
  失败，audit33项通过。不用这些本地结果宣称集群或CLS生产资格通过。
- 原任务inv-a9fun8gnit只读SUCCESS/0，05:37:21Z同PID/Invocation仍active/running，
  A111Host/115Machine、B4/4、active0；没有停止任务或缩短36h窗口。
- addon chart是否逐字使用tag-plus-digest、实际imageID/CRD/安全metadata与CLS查询尚未验证。
  仅版本或manifest hash不足以授权collection；拒绝手工绕过未就绪门禁。
- 用户未要求长期soak或物理restore，不扩大资格范围。

## scan_scope / scan_output / handoff / checkpoint

stage：collector可重建intent，native plan七项通过；完整目标仍active。
verified：官方区域catalog、C未安装、三manifest digest、固定provider JSON转换语义。
unverified：真实addon安装、节点冷拉、chart实际渲染、镜像UID/CRD/Argo及CLS正反查询。
discard：Kind=log覆盖完整、Values非空等于installed、chart tag可以充当image digest的假设。
restore：mono2 8439d81c；原strict10k固定Invocation/PID；本轮独立jj change。
next_action：native plan和回归通过后提交；锁释放后安全API探索发布，再串行collector/canary门禁。
scan限定本轮源文件，不输出credentials、默认env或全量addon values。
