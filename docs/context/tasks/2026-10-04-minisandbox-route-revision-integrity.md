---
id: minisandbox-route-revision-integrity-2026-10-04
type: task
scope: 保证同一Cell UID和route revision只对应一份已接受的路由内容。
triggers: ["route revision完整性", "同revision路由漂移", "serving route内容身份"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/workersapi/serving_routes.go
  - minisandbox/infra/cells/internal/workersapi/serving_routes_integration_test.go
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

收敛完整stateless/DO/跨Cell方案中的route内容身份：同revision不能静默改endpoint。
不修改云路由、不部署API、不重编workerd，不把本地REST fixture当作云网络资格。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式设计第二层寻址：endpoint变更通过新revision与CAS发布，Router拒绝回退。
- 当前resolver只存最高revision，未保存其manifest；同revision不同合法digest仍被接受。
- 保持不可复用Cell UID、placement匹配、全inventory检查后原子接受、旧Cell不夺主。

## interface_refs / data_structure_refs / history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md的第二层寻址。
- relevant_evolution：bd655092父基线；publish-cell-serving-route.py已要求更新revision加一。
- superseded_refs：仅比较数字revision而不比较同revision的内容身份。
- resolver的进程内high-water记录保存revision与manifest digest；不是新持久真值。

## acceptance / affected_paths

- 实际client-go通过本地HTTP API读取ConfigMap，合法重算digest但同revision改内容必须拒绝。
- 精确重读允许，新revision允许；撤销后同revision重写仍拒绝，失败inventory不更新high-water。
- 对象route与stateless route两入口都拒绝；race测试覆盖workersapi与objectrouter。
- 仅上述resolver/test、正式设计和本Task/catalog，保留既有HTTP bootstrap token协议。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| 根AGENTS、minisandbox/AGENTS、infra/cells/AGENTS@bd655092 | 本轮读取，截断段另读 | jj先建修订、唯一mono2、云锁和源码发布分离 |
| upstream-subtrees@bd655092 | route全文 | 不回写旧仓库 |
| adjacency/argocd-ci-secrets、cell-registration/publish-cell-serving-route.py及测试 | 卡片与实际邻居 | Publisher CAS和revision语义 |
| TASK/CHECKPOINT模板、serving_routes.go与现有测试 | 本轮全文/精确入口 | 恢复及全inventory接受边界 |
| 正式设计第二层、失败表与网络矩阵 | 本轮正文 | 不把源码修复冒充TLS/CCN资格 |

## evidence / risks / validation / decisions

- 原strict10k仍持整段锁；上一只读观察inv-e9fr3fg319确认原PID/InvocationID存活。
- bounded search初次误定位objectrouter和cell-serving-route目录，文件列表定位实际嵌套包与
  gitops/cell-registration发布器；未读取密钥或扩大云范围。
- red回归真实TCP/client-go确认5个同revision字段改写及撤销后改写被错误接受；
  失败inventory不更新high-water的既有正向断言通过。
- 修复后workersapi/objectrouter共79个顶层测试通过race，包含3个新增主测试；
  Go vet通过、gofmt无待格式化文件；相邻Publisher 5项测试通过。
- 原任务03:40:44Z inv-e9fr8w0rmm SUCCESS/0，PID261665/原InvocationID仍active/running。
  final drain24659秒，未提交部署或平行负载。cloud-environment技能和networking已读，
  status工具及policy snapshot不可用；不宣称managed readiness，仅用既有selector观察。
- next_action：Context精确基线对比、有界扫描与普通FF source push；不隐式发布。
- high-water仍仅进程内；重启后的持久发布CAS由既有Publisher负责，本变更不是跨重启防回退证明。
- 文档零错误/警告、change-impact通过；首轮Context新增项是本Task缺第三trigger，已补齐。
  根26项测试仍只有4个历史失败类型，最终精确基线仍须重核；audit 33项通过。
  discovery为needs_agent_review/Unknown/score=null，不宣称全仓语义Assessment完成。
- 有界敏感扫描仅当前4个文件和自己的catalog行；无凭据发现，不扫描或修订历史catalog内容。

## scan_scope / scan_output / handoff / checkpoint

仅本轮文件和自己的catalog行；输出留/data/tmp，完整goal保持active。
stage：源码门禁收尾；verified：上述red/green与相邻回归；unverified：云发布及网络矩阵。
discard：不存在的独立objectrouter/cell-serving-route目录假设。
restore：唯一mono2当前jj修订与bd655092基线；不修改原live任务。
artifacts：/data/tmp/route-revision-red-20261004.log、route-revision-race-20261004.log、
route-revision-vet-20261004.log、route-revision-publisher-tests-20261004.log。
根回执为route-revision-root-context-receipt及root-audit-receipt；输出保持本地。
next_action：收尾源码门禁并提交；云上后续仍探索先行。
