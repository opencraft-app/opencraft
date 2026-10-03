---
id: minisandbox-control-upstream-retry-2026-10-04
type: task
scope: 定位strict10k一次普通503的控制面传输原因，保留失败与自动清理证据。
triggers: ["strict10k upstream retry", "control transport failure", "active upstream unavailable"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/workersapi/upstream.go
  - minisandbox/infra/cells/deploy/tencent/fleet/load/shared-agent-scale/runner.mjs
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.1.0
precedence: task
derived: false
---

## goal

解释真实run7d5fa6ac的active/index360/503 upstream_unavailable，不把重试成功作为容量通过。
由原supervisor完成精确清理和生产自然缩容；定位证据缺口后再单独修改正确性/可用性路径。

## non_goals

- 不重启producer，不提高retry/SLO，不提前发布cache候选或变更现有共享锁。
- 不做长soak、物理恢复、新Runtime构建或手工改replicas/删Node。
- 不能由普通503推导FDB不足、计算不足、请求未执行或已经丢数据。

## requirement_ids / requirement_refs / requirement_excerpt

- 2026-09-22 stateless-workers-durable-object-routing：零普通重试、低容量扩容和安全缩容。
- 保留HTTP结果不确定性与generation/FDB ACK，不透明重放可能有副作用的请求。

## interface_refs / data_structure_refs

- shared-agent-scale journal的retry事件和独立load receipt；supervisor终态另由完整资格receipt证明。
- Workers API requestJSON的控制面client与fetchClient的数据面ClientTrace是不同路径。
- cache/root JS候选c87006e0未部署；运行镜像仍为2757 source/digest06797c64前缀。

## history_context

- current_design_refs：正式stateless-workers-durable-object-routing设计及ten-thousand-active/verifier。
- relevant_evolution：32af2709早期压力与扩容；c87006e0有界stateless命名缓存本地开发门禁。
- superseded_refs：截至4763对象零普通失败不再代表本轮终态通过；node数量不是单位成本证明。

## acceptance

- 精确保存load receipt/journal单个retry、原run/systemd身份、cleanup及自然缩容收据。
- 按控制面/业务转发边界定位503；缺少日志时明确unknown，不用错误code猜底层原因。
- 若修源码，先补真实HTTP故障回归；记录依赖输入并区分本地验证与正式发布。

## affected_paths

- 本Task与catalog、后续严格门禁evidence。
- workersapi/upstream.go与真实HTTP upstream_trace_test.go，正式设计和failed/cleanup收据。

## required_context / context_receipt

- 当前turn已完整读取AGENTS.md、minisandbox/AGENTS.md、infra/cells/AGENTS.md；新jj lrzvwkzn。
- 20:51路由must-read为upstream-subtrees、agent-gateway-runtime、services/ctl、services/sandbox，
  都已在本turn读取，非相邻服务变更。沿用argocd-ci-secrets邻接卡，检查真实manifest/test/Hook。
- bounded exact search：upstream_unavailable命中workersapi/upstream.go，没有命中Engine/Registry。
- 已读fetchActorAtURL/ensureActor、object_router、requestJSON、deployment_read、runner事件与停止逻辑。

## evidence

- inv-e9fd570ai2 SUCCESS/0于20:47:11Z：5394 ready/5381proven；普通retry1、stopReason=request_retry。
- inv-c9fd6f0i1p SUCCESS/0于20:48:31Z：journal事件20:47:07.847Z/index360/active/attempt1/
  backoff100ms/status503/code upstream_unavailable。load receipt于20:47:09.117Z终态failed，
  721990交互最终成功、身份漂移0；load_exit_status=1。完整收据摘要前缀a38991d48c0484b6。
- 原systemd c5d5db1b/PID261665仍为唯一supervisor，随后由原图执行cleanup和final drain。
- inv-c9fdad0ta6只读C Pod/有界日志诊断和progress9已提交；需复用immutable invocation读回，
  不因调用机断线重复诊断或重提producer。
- progress9 inv-c9fdadg3bg SUCCESS/0于20:52:44Z：cleanup_exit_status=0、A/B active0，
  正在原生产final drain；Host155/152、Machines156/153（含surge），未到floor4。
- 第一C日志诊断FAILED/1：自己的matchedPods<=32断言被55条匹配Pod打断，非权限失败或
  产品故障。改为报告总数并仅采样4个，不删除任何旧Pod；inv-e9fdcd05bd SUCCESS/0。
  Registry3/3、API12/12，7个样本restart0、无匹配警告；样本包含旧Pod，不能当完整故障窗口证据。

## risks

- requestJSON的client.Do错误会映射503，但目前丢弃具体原因；不足以证明是某一个连接失败。
- publicUpstreamCode也会把未知的retryable错误（包括deployment-read overloaded）映射到
  upstream_unavailable。因此此次不能仅靠外部code归因网络；需内部code/route/transport证据。
- 503可被上游传回；公开journal没有完整request ID，跨层join可能unknown。
- 当前容器日志和有限时间窗口缺少异常不构成健康证明；不要凭没有重启就排除网络事件。

## validation / decisions

- 保持负载失败；缓存实现c87006e0已经正常FF推master，未发布，不混入本Task修复。
- 所有云操作只读，使用已配置凭据/官方TAT；临时脚本/原始响应留在/data/tmp并保护权限。
- 接下来先收据和日志验真；任何控制面诊断补丁都不能引入自动副作用重试。

## scan_scope / scan_output

- 使用准确的load/shared-agent-scale与workersapi目录，不再猜local/mesh harness或actor_cache路径。
- 不能因聚合正常或已有单Cell资格通过而把一次普通失败改成warmup容量事件。

## handoff / checkpoint

- 整体目标仍active，严格万活跃没有通过。master c87006e0只解决未发布的stateless缓存问题。
- 下一步读取inv-c9fdad0ta6及progress9，保存failed load receipt和完整压力轨迹，再定位控制面503。
- 不改任务图、不force drain；下次常规进度观察以progress9真实native终态加五分钟为界。
- 当前明确下一步：保存完整failed receipt/压力快照，核验C Prometheus内部code计数与活跃Pod
  日志，不以任意四个旧Pod样本为结论；必要时补控制面结构化诊断，不新增透明重试。
- 下次常规进度观察不早于20:57:44Z；源码修复c87006e0已推master、当前Task尚未推送。
- progress10 inv-d9fdf8gsx4 SUCCESS/0于20:57:54Z：同一supervisor仍running，cleanup0、
  active0；A/B Hosts已由155/152降至153/150，Machines155/152，自然缩容已开始但未完成。
  下一常规观察不早于21:02:54Z。当前Task是本地调查checkpoint，不替代正式failed receipt归档。

## 21:10调查与实现检查点

- progress11 inv-d9fdk6gw9p SUCCESS/0于21:03:10Z，原unit/InvID/PID未变化：
  A/B active0、Hosts140/138、Machines143/141。progress12 inv-e9fdqsgq64 SUCCESS/0
  于21:08:06Z，最近capacity样本21:07:48Z为Hosts129/126、Machines131/129。
  下一常规只读观察不早于21:13:06Z，不重发producer、不强行回floor。
- C准确监控namespace是mesh-observability。inv-e9fdmw0n5p SUCCESS/0历史窗口20:43..20:48Z：
  deployment-read/router overload增量0；routing server_error increase约1.0526，indeterminate0，
  scrape12/12。increase为采样外推，不声称它是严格整数事件计数。
- inv-a9fdnf0rau SUCCESS/0将新routing error定位到wbtzz Pod，UID706244c2前缀；
  inv-c9fdp10vx4 SUCCESS/0验证同UID，窗口日志0字节。不能把空日志当transport健康。
- inv-a9fdrjgjaq SUCCESS/0：该Pod deployment registry/started/shared/overloaded增量均0；
  claim error约17.89（包含其他请求）；一个target unassigned server_error series值1。
  推断错误在placement resolution阶段，但socket根因和控制面副作用仍unknown。
- inv-a9fdm4gphk SUCCESS/0生成自己的immutable evidence tar；官方COS relay下载校验bytes/
  SHA一致，5,417,555压缩字节，209完整capacity行/47,756,875原始字节。临时COS relay key
  已由helper清理，原始/归档远端证据保留；本地artifact_dir为/data/tmp/
  minisandbox-strict10k-failed-review.dZfREZ。原字节load/cleanup收据已纳入仓库，sha前缀
  a38991d48c0484b6/e026d65e319658e0，cleanup5394删除、pending0/retries0。
- 原生control client.Do错误以前完全丢失。现复用socket trace，只在Do error记录
  bounded error/code/status、连接阶段和已有request_id；不记录raw error/URL/header/body。
  不添加重试、不修改返回契约和deadline，也不声称已修复本次503；仍未发布。
- 本地真实HTTP POST被接收后断连回归通过：attempt1、EOF、awaiting_response_headers、
  request_id保留、凭据/路径/query/body不在日志。wrapped error类型分类回归通过。
- 聚焦tests、全workersapi/objectrouter tests、race与go vet已通过。
  首次go test遇root go.work/1.26与系统1.24.4不一致；auto toolchain遇GOSUMDB=off，
  最终用已存在的/data/build-cache/go-mod下1.25.4和GOWORK=off，无下载或runtime重编译。
- 查询错误已收敛：8081是ObjectRouter而非metrics入口，read-only scrape返回NotFound；
  改为已有Prom Service历史查询，没有部署监控或改路由。初次registry histogram查server_error
  label不匹配实际error，空结果不作零错误证明；后续准确error查询已有记录。
- 当前待完成：正常FF推送诊断/收据，再继续原自然缩容，不宣称根因已修复。
- Documentation gate零errors/warnings；impact以真实9文件集检验，正式设计已同步。
  Context4970项历史errors与先前原数组排序cmp完全一致，新Task0errors；根26测试仍为
  同四项历史失败，context-audit33测试全过。audit discovery仍为needs_agent_review/
  not_assessed/Unknown，不宣称它通过成熟度评估。
- Scoped secret scan只针对七个变更文本/收据和catalog自己的新增行，无匹配。扫全catalog
  会碰到历史行，不能把未变更历史内容作为本补丁新增secret；原错误集没有增加。
- 原始Prom query及exact Pod日志解析后保留9th evidence文件，所有immutable invocation
  SUCCESS/0、Prom query success、explicit claimEligible=false。不提交47MB raw trace。
- progress13 inv-e9fdvq0w2j SUCCESS/0：21:13:10Z capacity样本A/B active0、Host116/113、
  Machines119/117，原supervisor持续running，未到各floor4。下一常规检查不得早于21:18:30Z。
  云上无发布或手工资源变更；代码推送完成后也不能把source-only诊断当作修复证据。
