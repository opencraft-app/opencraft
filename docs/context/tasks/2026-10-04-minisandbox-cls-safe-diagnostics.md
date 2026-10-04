---
id: minisandbox-cls-safe-diagnostics-2026-10-04
type: task
scope: CLS采集前的Workers API结构化错误安全与真实HTTP断连回归。
triggers: ["CLS安全日志", "Workers API错误日志", "HTTP断连诊断"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/workersapi/api.go
  - minisandbox/infra/cells/internal/workersapi/upstream.go
  - minisandbox/infra/cells/internal/workersapi/deployment_cache.go
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

推进stateless/DO跨Cell方案中的CLS可诊断边界，消除Workers API库的原始错误消息日志。
本轮不安装采集器、不查询其他服务topic内容、不构建或发布镜像、不修改正在运行的
strict10k，不把局部日志回归或探索结果当作完整容量资格。

## requirement_ids / requirement_refs / requirement_excerpt

- 原目标：完成Stateless Workers、Durable Objects与跨Cell内网寻址，可能还有CLS日志。
- 当前正式设计：2026-09-22-stateless-workers-durable-object-routing.md的CLS检查结论。
- 日志不包含原始URL、headers、用户body、Secret、用户console或上游任意错误消息。
- fetch在交给transport后断连仍返回非retryable indeterminate_result；响应中途断开仍abort。

## interface_refs / data_structure_refs

- internal/workersapi/api.go的dispatchFetch、fetchActorAtURL、prepare/activation cleanup。
- upstream.go的upstreamError和HTTP transport分类；deployment_cache.go的watch错误日志。
- 保留既有HTTP状态、错误响应、request ID和socket阶段；错误分类必须为源码有限常量。

## history_context

- current_design_refs：minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：bef26bb6已实现受锁profile切换；原strict10k仍在观察，不能部署诊断。
  requestJSON已有安全分类，但fetch/stream/cleanup/placement/watch尚有原始error或code。
- superseded_refs：不采用DEBUG全量日志，不以现有无绑定CLS topic推断平台已接线。

## acceptance / affected_paths

- 真实HTTP server接收POST后断连：stateless与DO均恰好执行一次、502且不可透明重试。
- 真实truncated response：部分响应后必须http.ErrAbortHandler，不重放用户请求。
- 两类路径日志均只输出有限error分类，不出现测试URL、body、token或上游消息。
- cleanup、placement、watch的任意上游message/code不进入日志；类型分类回归。
- 影响workersapi源码/测试、正式设计、observability说明、Task/catalog。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| 根AGENTS、minisandbox/AGENTS与infra/cells/AGENTS@bef26bb6 | 全文 | 唯一工作树、jj、operation lock、源码不等于发布 |
| upstream-subtrees与release-gitops@bef26bb6 | route/发布边界全文 | master仅交付源码，不自动promote |
| adjacency/argocd-ci-secrets与test_multi_cell_observability.py@bef26bb6 | 全文/邻居 | monitoring不能与现有资格并行安装 |
| TASK/CHECKPOINT模板@bef26bb6 | 全文 | 有界上下文与交接 |
| workersapi/upstream_trace_test.go与fetch_trace_test.go@bef26bb6 | 全文 | 真实HTTP、不重放与socket阶段测试 |
| workersapi/api.go及api_test.go相关fetch/cleanup段@bef26bb6 | 有界源码读取 | 原始URL/error日志缺口，不改变产品语义 |
| cloud-environment skill及networking reference | 全文 | 不输出凭据，不绕过代理，仅正常selector只读观察 |

## evidence / risks / validation / decisions

- 本轮原进程只读观测：inv-e9fp790gte SUCCESS/0，02:30:42Z同PID261665与InvocationID，
  A111Host/115Machine、B4/4、active0。没有云mutation。
- 日志安全用typed error分类而不是对敏感字符串正则清洗；任意上游错误只能回退有限类。
- 代价：不保留原始error文字；保留request correlation、status与已有socket milestones。
- 验证：聚焦Go测试、包测试/race/vet，docs/context/impact与本次变更敏感扫描。
- 聚焦真实HTTP回归通过；workersapi、workersapi/objectrouter和cmd/workers-api共103项
  race回归通过，vet通过。修正两处验证入口错误：根go.work要求1.26，本模块应GOWORK=off
  使用既有1.25.4工具链；Object Router实际位于workersapi/objectrouter而非internal/objectrouter。
- watch为惰性启动，首版用例仅构造API未启动watch而失败；已显式启动真实watch，不加retry。
  两次有界读取找不到猜测的lifecycle.go/deployment_reads.go，实际源为api.go/deployment_read.go。
- 先前catalog定位失败：真源在docs/context/.context/catalog.jsonl，不在.agents/context。
- 本轮stage：库内日志源码已收敛；unverified为CLS容器/启动输出审计与实际desired-state接线。
  discard为首次错误包路径的race结果，不把其中两个包通过视为三包门禁通过。
  restore为bef26bb6父版本、本轮Task和原supervisor7d5fa6ac；next_action为最终本地门禁及FF交付。
- 最终源码103项race回归通过，vet通过；documentation为0错误/警告，impact覆盖9个文件。
  root26仍为相同4个历史失败，audit33通过；discovery为needs_agent_review/Unknown/null，
  不声称完成语义评分。首次context多1项本Task的triggers不足3，已补齐后重新验证基线。
- 本轮多条组合命令混用了module/repo cwd，导致文件定位失败；修正为显式workdir，
  失败结果不作为门禁证据。最终交付只采用正确包路径的race和根目录校验产物。
- CLS后续仍需精确topic/logset、容器allowlist、保留期和Terraform/LogConfig字段所有权；
  本轮不声称启动日志或整个runtime已可安全全量采集。

## scan_scope / scan_output

仅本轮文件和本Task新增catalog行；产物保存在/data/tmp，禁止输出历史secret扫描内容。

## handoff

阶段：本地源码实现。下一道门禁是实际HTTP错误/stream回归，不触发云发布。
完整目标仍含真实探索扩缩容、严格容量资格、跨Cell故障与CLS实际接线。
