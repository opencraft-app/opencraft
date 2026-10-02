---
id: minisandbox-api-shutdown-drain-2026-10-02
type: task
scope: Workers API 等待公共与内部 HTTP listener 排空后再退出，避免自动缩容中断请求。
triggers: ["Workers API 退出排空", "API 缩容断流", "双 listener shutdown"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/cmd/workers-api/main.go
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

SIGTERM 后关闭两个 HTTP listener 的新准入，同时在原十秒总期限内等待现有请求，最后才关闭 API 或退出进程。

## non_goals

- 不放宽3秒或零稳态重试，不关闭HPA，不添加客户端隐式副作用重放。
- 不改变原50秒Pod grace、30秒preStop与10秒HTTP drain，不重编workerd。
- 原run94270692仍在缩容，不并发发布或提交新云资格，不宣称一万活跃通过。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式 Stateless Workers / DO 设计的公共/内部入口与负载驱动安全缩容要求。
- 云上11:09:05删除API Pod，11:09:35发生11次transport retry；时间吻合但非逐请求因果证明。
- main收到第一个ErrServerClosed就退出，是源码可确定的排空排序缺陷。

## interface_refs / data_structure_refs

- http.Server.Serve/Shutdown/Close、signal.NotifyContext、API.Close。
- listener返回不代表活动请求完成；两个listener共享总期限且必须同时停止新连接。
- 期限耗尽时有界关闭连接，请求结果仍可能不确定，不能自动重放业务。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：当前main在goroutine中顺序Shutdown，主goroutine只等一个listener返回。
- superseded_refs：增加preStop或禁止缩容不能替代等待排空。

## acceptance

- 真实HTTP加真实子进程SIGTERM，单/双listener的在途请求在释放前不得导致进程退出。
- 一个listener发生真实accept错误时，也先停止并排空另一个listener，保留错误。
- 超时关闭有界，不永久等待流；正常/超时/监听失败均等待全部listener终态。
- 聚焦测试、race、vet和API构建通过；文档与Context不引入新增错误。

## affected_paths

- Workers API命令入口、HTTP生命周期文件与真实网络/进程测试。
- 正式设计、本Task与catalog。

## required_context

- upstream-subtrees；根AGENTS、minisandbox CLAUDE、cells AGENTS和fleet README。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@f30042a0 | 根入口 | 单目标revision与门禁 |
| docs/context/project/upstream-subtrees.md@f30042a0 | 路由 | mono2唯一写源 |
| docs/context/project/adjacency/argocd-ci-secrets.md@f30042a0 | 邻接 | 现有manifest与验收邻居 |
| minisandbox/CLAUDE.md@f30042a0 | 工程规范 | 实际网络与进程，不mock模块 |
| minisandbox/infra/cells/AGENTS.md@f30042a0 | 云边界 | 原资格结束前不发布 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@f30042a0 | 资格边界 | 源码通过不等于上线 |
| minisandbox/infra/cells/cmd/workers-api/main.go@f30042a0 | 源码定位 | listener与API.Close排序 |
| minisandbox/infra/cells/deploy/tencent/fleet/workers-api/api.yaml@f30042a0 | 部署邻居 | 保留50/30秒合同 |

## evidence

- 新任务前创建jj revision；原云周期仍独占高风险操作锁。
- 准备真实子进程与HTTP故障回归，先证明旧排序失败，再修复。
- BEFORE 独立owned pipe回归三门禁全部失败0.089秒：stopped事件先于双listener关闭/请求释放。
- AFTER 三门禁通过0.289秒，含单/双listener SIGTERM、真实accept失败和200ms测试期限。
- 最终三个相关包完整测试通过0.291/0.760/0.005秒，race通过5.517/2.349/1.017秒。
- 真实请求计数均为一次；非超时返回前每个请求均已完成，排空开始后两个端口均拒绝新TCP连接。
- 外部测试日志保存在 `/data/tmp/minisandbox-api-shutdown-checked-stream-{tests,race}-20261002.log`，SHA-256记录在本轮checkpoint中。
- 超时测试还要求客户端得到错误，不能把未完成的流当成干净的截断200。

## risks

- 无限流不能承诺永不终止；十秒总期限后关闭连接，并保留结果可能不确定的语义。
- 关闭listener和退出进程必须区分；禁止只等ListenAndServe返回。
- 子进程证据管道由测试显式拥有，不能让Cmd.Wait提前关闭StdoutPipe并丢掉最后一条事件。

## validation

- Go测试/race/vet/build通过；只构建Go API，没有重编workerd。
- 文档与六路径impact通过；audit33通过，根Context26仍为旧四项失败，不把基线错误说成全绿。
- Task中的两个日志摘要被安全扫描器误识别为凭据，已改为外部证据路径，不修改检测器或忽略规则；门禁要求不增加原有4855项Context错误。

## decisions

- 复用现有Go命令入口，不新增服务、hypercall或调度组件。
- 启动前绑定全部端口，任一bind失败关闭已绑定的端口；真实accept失败也进入同一排空路径。
- Shutdown共享十秒总期限且并行运行；必须收齐Shutdown与Serve结果，错误不被ErrServerClosed掩盖。

## scan_scope

- cmd/workers-api、internal/workersapi和现有公共API manifest。

## scan_output

- 源码确认first listener exit不能代表Shutdown完成；无新增凭据或网络暴露。

## handoff

- 本地确定复现与修复完成，最终文档门禁后正常提交；云上发布待原安全缩容周期结束。
- 原云资格因11次transport retry失败且未达一万；下一云门禁必须重新验证，不能复用失败收据。
