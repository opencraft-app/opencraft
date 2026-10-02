---
id: minisandbox-fetch-transport-trace-2026-10-02
type: task
scope: 为 Object fetch 传输失败补齐客户端阶段证据，不改变执行语义。
triggers: ["minisandbox fetch transport trace", "Object header timeout stages", "client transport milestones"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/workersapi/fetch_trace.go
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

将真实 B Cell header timeout 从单一错误细化为可校验的客户端传输里程碑，为后续根因修复提供证据。

## non_goals

- 不扩大超时、透明重放、手工预扩容或与现有原任务并发发布。
- 不宣称本诊断已修复四次超时，也不重新构建 workerd/Runtime。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式设计 Phase 5 的零重试、万级 active 与网络故障资格；原请求失败必须保留。

## interface_refs / data_structure_refs

- Workers API fetchActorAtURL、Go httptrace.ClientTrace。
- trace 只记录客户端 connection/write/first-byte，不能证明目标执行、提交或没有副作用。
- 保持 indeterminate_result、retryable=false 与 caller-owned streaming/cancellation。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：master d2c75f49 已记录原 f564 失败及精确清理，不以重试成功取代资格。
- superseded_refs：旧 p99 和聚合 CPU 无法排除少数长尾。

## acceptance

- 真实 HTTP header timeout、partial header、caller cancellation、streaming 覆盖里程碑。
- 每个失败仍只调用一次 upstream，不记录 body、header、URL query、token 或新高基数 metric。
- race、vet、完整 Workers API 回归及文档门禁通过；发布须另获正式收敛证据。

## affected_paths

- minisandbox/infra/cells/internal/workersapi/{api.go,fetch_trace.go,fetch_trace_test.go}
- 正式设计、本 Task 与 catalog。

## required_context

- agent-gateway-runtime、upstream-subtrees、frontend-service-detail、adjacency-argocd-ci-secrets。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@d2c75f49 | 仓库入口 | 单写源与外部变更边界 |
| docs/context/domains/agent-gateway-runtime.md@d2c75f49 | 路由结果 | 故障必须检查真实传输 |
| docs/context/project/upstream-subtrees.md@d2c75f49 | 路由结果 | mono2 是唯一真源 |
| docs/context/project/services/frontend.md@d2c75f49 | 路由弱词命中 | 本次不改 frontend |
| docs/context/project/adjacency/argocd-ci-secrets.md@d2c75f49 | 测试邻接 | 检查 Router 实际 HTTP 测试 |
| minisandbox/CLAUDE.md@d2c75f49 | 实现约束 | 分阶段、有界日志，不放宽失败 |
| minisandbox/infra/cells/AGENTS.md@d2c75f49 | 云端操作 | 原任务 lock 期间只读 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@d2c75f49 | 资格边界 | 不混淆源码与发布 |
| minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@d2c75f49 | 当前设计 | 完整目标仍未完成 |
| docs/context/tasks/TASK-TEMPLATE.md@d2c75f49 | Task 格式 | 完整记录 |

## evidence

- 原 inv-c9def3gxtj / wait97781 仍在自然安全缩容，不重提。
- inv-c9df7pg6ju SUCCESS/0：B 六 Engine CPU 峰值不超过0.43核，throttle0。
- inv-a9df8s0nrr SUCCESS/0：已修正真实 le=10.0，Guard proxy、ready-wait、dispatch、tunnel 完成样本均无大于10秒增长；不能证明取消或未到达的请求正常。
- inv-d9dfcp0b2n SUCCESS/0：六 Engine UID 早于故障窗口且restart0，Envoy WS处理无大于1秒增长。node listener/conntrack 与 tunnel ping series 缺失，不当作健康；publish 的实际 success label 为 ok，不把它当错误。
- inv-c9dfet0qmd SUCCESS/0，09:41 UTC：A Hosts17/MS19、B Hosts12/MS14，继续生产串行 drain；FDB仍9/9全复制、active0。Node异步观察不替代最终严格样本。

## risks

- trace milestone 只属于本地 socket，不能按 awaiting_response_headers 推导请求没有副作用。
- httptrace 回调可能异步，使用短临界区锁；不复制或缓存请求 payload。

## validation

- 首次默认 Go 命令被 mono2 根 go.work 的1.26要求拒绝，无产品测试结论。
- 改用 GOWORK=off 和本地已缓存 Go1.25.4：完整 Workers API/objectrouter race 回归和 vet 通过，其中新增4项真实 HTTP 测试。
- documentation errors/warnings 均为空，六个显式 changed-file 的 change-impact 与 diff check 通过。
- Context audit 33 tests通过；根 Context 26 tests仍有既有4项失败，不宣称根门禁全绿。新增 Task 初次只有两个 triggers，已补齐第三项，最终 baseline差异待复核。

## decisions

- 仅失败时输出固定字段日志，正常请求不增加日志；不改变现有25秒 response-header deadline。
- 原任务未 terminal 前不发布，不重跑正式负载。

## scan_scope

- Workers API fetch 与其 HTTP 回归、B Engine 原绝对时间窗口的指标和日志。

## scan_output

- 只输出固定阶段、耗时、socket地址与既有内部 request_id，不输出凭据或 payload。

## handoff

- 本地新增代码尚未发布；完整目标 active，下一步验证并提交，再等原任务释放操作锁。
- 根因仍未确定；不能把诊断覆盖当作 strict10k 通过。
