---
id: minisandbox-cls-platform-source-2026-10-04
type: task
scope: 补齐Workers API进程日志边界及精确CLS资源/采集声明，不安装云上agent。
triggers: ["CLS平台采集", "CLS Terraform", "安全HTTP日志"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/workersapi/platform_logger.go
  - minisandbox/infra/cells/cmd/workers-api/main.go
  - minisandbox/infra/cells/deploy/tencent/fleet/terraform/create-first/management/cls.tf
  - minisandbox/infra/cells/deploy/tencent/fleet/observability/cls/render.py
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

推进stateless/DO跨Cell方案的CLS诊断链：安全进程logger、可重建C集群topic、精确容器规则。
不安装collector、不改现有云配置、不重启strict10k、不编workerd/Rust、不自动promote GitOps。
本轮生成声明不等于采集上线；必须后续核对API安全镜像、agent版本、CRD和实际CLS写入。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户完整目标：按2026-09-22-stateless-workers-durable-object-routing.md完成实现，可能含CLS。
- bb5aa863完成库内错误分类，但cmd启动错误和net/http默认stderr仍有原始内容。
- 首条规则只采集C的workers-api-system/Deployment workers-api/Container workers-api。
- WARN/ERROR、标准JSON、解析失败不上传、增量采集、白名单metadata；禁止用户JS stdout。
- topic/logset使用Terraform精确ID；创建、保留、索引归Terraform，LogConfig不写同名字段。

## interface_refs / data_structure_refs / history_context

- management采用Tencent provider1.83.11；新增独立CLS output，不改变严格management inventory。
- current_design_refs：原stateless/DO正式设计的CLS诊断章节；observability README。
- relevant_evolution：7d5fa6ac严格负载失败并在自然排空观察，标准LogConfig CRD尚缺。
- superseded_refs：不查询/复用无平台绑定的其他CLS topic，不开DEBUG/全容器采集。
- 外部字段权威：腾讯LogConfig文档product/457/111541，provider v1.83.11 cls_topic/logset/index。
  官方说明existing topic的retention/index自动创建字段不生效，规则仍省略这些字段避免双写。

## acceptance / affected_paths

- typed error、未知字符串及net/http panic内容不进入平台logger；保留有限类和相关标识。
- 真实TCP handler panic后断连，不写用户panic文字/堆栈，不影响原HTTP启停测试。
- Terraform本地validate及格式校验，默认不创建CLS资源；启用后保留期有限、匿名写关闭。
- 真实renderer CLI验证ID/范围与无通配allowlist；规则仅JSON+WARN/ERROR且不自动创建topic。
- 影响Workers API logger/cmd/tests、management cls.tf、observability/cls、正式设计、Task/catalog。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| 根AGENTS、infra/cells/AGENTS及minisandbox/AGENTS@bb5aa863 | 本轮/上轮全文，指令未变 | 唯一工作树、jj、锁、无并行发布 |
| release-gitops及upstream-subtrees@bb5aa863 | route全文 | master仅源码，Argo/live证据另验 |
| adjacency/argocd-ci-secrets和test_multi_cell_observability.py@bb5aa863 | 全文/邻居 | 部署与采集声明分离 |
| TASK/CHECKPOINT模板@bb5aa863 | 全文 | 有界规划与恢复 |
| main.go、http_servers.go、http_servers_test.go相关段@bb5aa863 | 进程源与真实TCP邻居 | 关闭默认raw stderr边界，复用logger |
| management versions/variables/outputs/main及rebuild/test_management_code_plane.py相关段@bb5aa863 | 有界读取 | 现有inventory严格，日志binding单独output |
| cloud-environment skill及networking reference | 全文 | 只读观察，凭据selector无输出 |

## evidence / risks / validation / decisions

- 原进程02:48:59Z inv-e9fpqd0kn2 SUCCESS/0，同PID261665/InvocationID仍active。
- environment_status工具不可用、network-policy snapshot缺失，不能据此声称setup ready。
- 三次官方网页open超时后用精确search返回的官方完整字段核对，未采用社区二手样例。
- 初次宽范围rg定位工具慢，完成后改为已存在工具目录；没有停止或重启任何云进程。
- 已找到Terraform1.9.8，并以仓内锁核对binary SHA；provider1.83.11缓存可用，不访问state。
- stage：实现源码与本地门禁。unverified：agent版本/安装、API安全镜像发布、CLS实际查询。
- discard：先前空logger安全范围声明；restore：bb5aa863与本Task；next_action：真实本地门禁。
- 风险：抑制HTTP原始panic文字会损失堆栈，保留有限panic事件与listener作为生产默认诊断。
- CLS规则不能替代源日志安全；开启前还需资格证明新API镜像，不能采集现有旧镜像输出。
- 初次provider schema读取被未初始化COS backend拒绝；未执行reconfigure/migrate，
  改用无backend、原生mock provider的独立fixture验证当前生产cls.tf。fixture缺必需vpc_id
  已修正为模型ID；不会调用真实云API。
- 本轮115项Go race通过，含实际main启动失败子进程与真实TCP panic；renderer5项通过，
  管理Terraform validate零错误/警告。重复JSON字段和64KiB输入上限另加真实CLI拒绝回归。
- 原生Terraform mock-provider的5个plan门禁通过：默认关闭、有限保留/索引/采集身份、
  拒绝零值、永久及小数保留期；不证明云API或LogConfig agent兼容性。
- 邻接rebuild/test_render_inputs.py的9项通过；本机没有pytest，原pytest命令未运行测试。
  随后以runpy加载真实test_multi_cell_observability.py并直接执行两个测试函数，2项通过。
- 文档零错误/警告、change-impact通过；Context仍为5026项既有错误，其排序数组与
  bb5aa863基线逐字比较一致。根Context测试26项中4个既有失败：governance assets、
  Chinese-first、compact budget和repository context；不是仓库全绿。
- context-audit测试33项通过，默认discovery仍needs_agent_review/Unknown/score=null，
  不把候选扫描或测试计数解释为仓库语义评分。回执和完整输出仅留在/data/tmp。
- 最新原任务只读观察02:58:27Z inv-d9fq19g2uw SUCCESS/0；PID261665及原InvocationID
  未变，仍active/running。没有云写入、镜像构建、规则安装或并行负载。

## checkpoint

- stage：源码收尾与本地证据；完整stateless/DO/跨Cell目标仍未完成。
- restore：唯一mono2工作树当前修订、bb5aa863父基线和本Task，不回写旧独立仓库。
- artifacts：/data/tmp/cls-platform-go-race-final-20261004.jsonl、
  cls-platform-terraform-tests-final-20261004.log、cls-platform-context-errors-20261004.json、
  cls-platform-root-context-receipt-20261004.json、cls-platform-root-audit-receipt-20261004.json。
- next_action：源码普通FF推送后，待原operation lock实际释放，先探索容量收敛；
  CLS上线仍需安全API镜像、真实addon/CRD兼容性、精确topic归属及正反查询门禁。
- unverified：上述云接线、实际扩缩容、完整Phase5；不改生产资格为探索结果。

## scan_scope / scan_output / handoff

仅本轮文件和本Task新增catalog行，产物保存在/data/tmp，不扫描或输出凭据。
完整目标仍待实际探索扩缩容、严格容量/跨Cell故障资格与CLS安装查询；保持goal active。
