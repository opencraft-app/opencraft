---
id: minisandbox-cls-fault-evidence-2026-10-04
type: task
scope: 核验现有北京CLS采集并用严格负载故障窗口补充可归因证据。
triggers: ["minisandbox CLS", "CLS故障日志", "strict10k logs"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/ten-thousand-active/evidence/README.md
  - minisandbox/infra/cells/internal/workersapi/upstream.go
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

用户扩展正式stateless/DO/跨Cell目标，指出可能有CLS日志。先核验当前资源绑定，再按
run7d5fa6ac的20:47:07.847Z故障窗、明确Pod UID查询既有日志；不读取无关租户日志。
不部署采集器、不修改云日志主题、不开新producer、不在原supervisor持锁时发布候选。
CLS证据不是持久状态真值，空查询/未配置采集不能作为无故障证明。

## requirement_ids / requirement_refs / requirement_excerpt / interface_refs / data_structure_refs

- 正式设计：minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md。
- ed896268已推master的control transport诊断尚未发布；生产runtime仍为2757。
- 腾讯官方CLS SearchLog的时间为Unix毫秒、左闭右开；只用已配置SDK/CLI，不打印credentials。
- requirement_ids：正式Phase5 strict-load/evidence；excerpt为零普通重试、精确清理与无人值守缩容。
- data_structure_refs：非资格CLS discovery JSON、原生API RequestId、TAT TaskStatus/ExitCode。

## history_context

- current_design_refs：正式stateless-workers-durable-object-routing方案。
- relevant_evolution：前Task已保留failed/cleanup/Prom历史query；一万活跃仍失败。
- superseded_refs：只检查容器本地日志不足以排除云端留存日志；也不得假定存在CLS采集。

## acceptance / affected_paths

- 只读核验北京现有Topic与当前TKE log config，不能从topic名字猜拥有者。
- 查询绑定明确的API/Registry/Engine topic；白名单输出元数据、时间、错误分类和请求ID。
- 保存无secret证据、查询范围/分页/采样限制；不根据采样或空日志反证故障不存在。
- 修改范围限本Task/catalog、严格负载证据与正式设计文档，不改已发布控制面行为。

## required_context / context_receipt

- 新jj oszyypvn，保留自己的空checkpoint父版本；owned mono2 worktree为唯一编辑源。
- route must-read仅upstream-subtrees，已读；最近infra/cells AGENTS已读。
- cloud-environment SKILL及networking reference已读，environment_status工具不提供，policy文件
  缺失不建立ready；使用原配置Tencent identity的实际CLI结果验真，不换身份或规避限制。
- bounded filename查询没有cls文件；初次泛cls匹配只是TKE cluster ID噪声。扩大为明确
  tencentcloud_cls/DescribeLogConfigs/loglistener等在terraform/observability路径仍未命中。
- argocd-ci-secrets邻接卡已读，并核验已有workers-api/api.yaml的metrics/部署邻居。

## evidence / validation / handoff

- 原supervisor的最后native观察21:13:21Z仍running：active0，Hosts116/113，Machines119/117。
  下一常规进度不早于21:18:30Z；云操作为只读，不重发负载、不手工缩容。
- 当前正在枚举北京topic元数据与TKE正式日志配置接口。结果未验真前不声称接通CLS。
- 整体目标仍active；无论CLS是否有历史日志，都必须保留严格负载failed判定。

## 核验结果 / checkpoint

- DescribeTopics成功：北京total7/returned7，分页完整，API requestId已留无secret证据。
  都未核验成当前fleet的采集绑定；未读任何Topic内容，不查询无关服务日志。
- DescribeClusters成功核验A/B/C名称和当前ID，三个Running。DescribeLogConfigs均明确返回
  FailedOperation.KubernetesListOperationError：logconfigs.cls.cloud.tencent.com不存在。
  这是缺CRD，不是IAM拒绝；没有规避权限或换身份。
- inv-a9fe2800vk SUCCESS/0：三集群matching log CRD和常见collector DS/Deployment均空；
  只证明标准TKE采集路径未安装，不排除外部自定义agent/sidecar。
- 非资格JSON证据保留Topic总数/分页完整、cluster绑定、API RequestId和TAT invocation，
  不保存无关Topic ID/name或payload。正式设计和evidence README同步记录采集缺口。
- progress14 inv-d9fe350pep SUCCESS/0于21:19:07Z：原supervisor仍running，active0；
  21:18:47Z样本Hosts111/100、Machines115/104，未到floor。下一观察不早于21:24:07Z。
- source-only ed896268尚未部署，不能当作503已修复；标准CLS不存在也不会重标failed。
- 后续回主体：原持锁自然缩容结束后，沿现有Workers API image/完整inventory/Argo发布
  路径发布已验诊断，再收集真实控制面错误。此Go-only镜像不需要重新编workerd/V8/Rust。
  已读build-image.sh、build-image-via-tat.sh、Dockerfile.workers-api和Workers API README；
  release.sh猜测路径不存在，已纠正为真实install/gitops入口，本轮没有提交构建/发布。
- JSON语义检验通过：false claimEligible、topicContentsRead=false、mutations空、完整Topic分页、
  三集群身份和SUCCESS/0独立collector观察。Impact五个真实变更路径passed；scoped secret scan
  无命中；documentation零error/warning。首次Task检查缺三个required heading，已补齐后重验。
- 重验新Task0errors，历史4970错误数组与上一正式checkpoint排序cmp完全一致；26个
  context测试仍只失败于同四个历史项目。没有重写整个catalog或无关服务治理。
- progress15 inv-e9fe8309xs SUCCESS/0于21:24:23Z：样本A/B Hosts111/87、Machines115/91，
  active0；A最近五分钟样本未继续下降，不把此直接当故障，也不宣称缩容已通过。
  下一常规检查不早于21:29:23Z。需继续观察原supervisor并按实际drain状态判断等待原因。
