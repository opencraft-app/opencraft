---
id: minisandbox-deployment-read-coalescing-2026-10-03
type: task
scope: 合并同一 generation 的 Worker Deployment 冷填充，限制 Registry 读放大。
triggers: ["Deployment 读合并", "Registry 回填羊群", "deployment read coalescing"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/workersapi/deployment_cache.go
  - minisandbox/infra/cells/internal/workersapi/deployment_read.go
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-03
review_due: 2026-11-03
revision: 1.1.0
precedence: task
derived: false
---

## goal

将同一 API replica、Worker 和观察 generation 的并发冷填充合并成一次 Registry GET。

## non_goals

- 不取消 namespace cursor、watch 断线 fail closed 或迟到响应 fence。
- 不宣称此机制已解释旧十六 Version 万级负载的所有等待。
- 不修改 Object claim、Actor owner、用户 fetch 重试、Runtime 源码或正在执行的构建。
- 不用本地协议测试代替云上 Router replica/cache 曲线。

## requirement_ids / requirement_refs / requirement_excerpt

- Stateless Workers / DO 设计的稳定请求无 Registry 热路径和 Router 扩展要求。
- 用户要求从模型解释性能劣化，不能只增加副本。

## interface_refs / data_structure_refs

- activeWorker、deploymentCache.Fence/PutIfCurrent 与 API.Close。
- 每个共享读取绑定 Worker 和 generation；不同 generation 不加入旧读取。
- 最后一个等待者离开后取消读取；一个调用者取消不影响其他调用者。
- 独立读取及等待者均有上限，失败不缓存，不透明重试用户 fetch。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：namespace watch 已正确失效，但并发 miss 分别发起 GET。
- superseded_refs：取消 cursor 或放宽失效语义不能作为吞吐修复。

## acceptance

- 真实 HTTP、事件有序暂停，证明旧实现的并发读放大及修复后的单次读取。
- 取消、全体离开、generation 改变、失败、容量耗尽、进程关闭均有确定性回归。
- 不缓存迟到旧响应，提供 bounded coalescing 指标。
- Go test、race、vet、Docs/Context/impact 通过；未部署前不声称云端已修复。

## affected_paths

- Workers API 的 Deployment cache/read group、指标、测试、正式设计、本 Task 与 catalog。

## required_context

- release-gitops、upstream-subtrees、根与 cells AGENTS、minisandbox CLAUDE。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@1800baf3 | 根入口 | 单任务 revision 与证据边界 |
| minisandbox/infra/cells/AGENTS.md@1800baf3 | 生命周期 | 不干扰发布、源构建或 qualification |
| minisandbox/CLAUDE.md@1800baf3 | 工程规范 | 真实 HTTP、无模块 mock |
| docs/context/domains/release-gitops.md@1800baf3 | 路由 | 本地通过不等于上线 |
| docs/context/project/upstream-subtrees.md@1800baf3 | 路由 | mono2 唯一真源 |
| docs/context/project/adjacency/argocd-ci-secrets.md@1800baf3 | 邻接 | existing API manifest/test 边界 |
| docs/context/domains/agent-gateway-runtime.md@1800baf3 | 路由补充 | 不将 Registry 回填与用户执行混为一体 |
| docs/context/project/services/ctl.md@1800baf3 | 路由补充 | 未修改其他实例编排服务 |
| docs/context/project/services/sandbox.md@1800baf3 | 路由补充 | 未修改独立 Sandbox pool |
| minisandbox/infra/cells/deploy/tencent/fleet/workers-api/api.yaml@1800baf3 | 配置邻居 | 4,096 Deployment cache 容量 |
| minisandbox/infra/cells/internal/workersapi/deployment_cache_integration_test.go@1800baf3 | 测试邻居 | 三副本 watch 失效不变量 |

## evidence

- 新任务前创建独立 jj revision；候选 Runtime 构建仍执行，未修改其输入。
- 先执行真实 HTTP 冷填充基线，再实现读合并。
- 旧路径实际命令 `GOWORK=off go test ./internal/workersapi -run '^TestDeploymentReadColdFillBaseline$' -count=1 -v`：32 并发产生 32 GET；原测试随后替换为修复后永久回归，不保留断言旧 bug 的测试。
- 修复后同一真实 HTTP 屏障：32 并发产生 1 GET，31 个 shared 等待；热请求无 GET。
- 完整 workersapi/objectrouter 测试及 race 已通过，日志在 `/data/tmp/minisandbox-deployment-read-tests-20261003.log` 和 `/data/tmp/minisandbox-deployment-read-full-race-20261003.log`。追加 lifecycle watch 后，三包 workersapi/objectrouter/cmd-workers-api 的最终 race 完整门禁亦通过：`/data/tmp/minisandbox-deployment-read-final-race-20261003.log`。最终 vet 通过。
- 首次测试误用 mono2 Go 1.26 workspace；以 `GOWORK=off` 使用该 cells module 自身锁定 Go 1.25.4。首轮取消清理测试有 defer/cleanup 顺序 bug，改为事件释放并在 context 取消前 await 终态，不加等待或重试。

## risks

- 共享 context 必须由 group 生命周期拥有，不由首个请求拥有。
- 全体取消后未终态的读取仍占独立任务配额，避免取消风暴绕过上限。
- 不将读合并扩展到用户代码执行或任何非幂等写。

## validation

- workersapi 聚焦/完整测试、race、vet，Docs/Context/impact 与 diff。
- 最终三包 race、vet、Go binary build 均通过；Docs errors/warnings 为零，own Task Context errors 为零。全仓 Context 仍有历史错误和 stale catalog，根 Context 单测 26 项中 4 项旧失败；audit 单测 33 项及 audit 命令通过。未将全仓门禁标为 green。

## decisions

- 有界 generation-aware read group 独立文件；保留原 cache 和 Registry 真值。
- 配额先复用 Deployment cache 容量，不增加产品配置或永久协调服务。
- watch 和共享读使用同一 API-owned context，避免懒初始化 cancel function 与 Close 的竞态。
- 指标分别记录 started、实际 registry GET、shared、overloaded；无 Worker/Object ID label。
- 只有 watch 已同步才合并；未同步时读操作以独立身份参与同一有界 admission，保留原逐请求快照语义。新增真实 HTTP 回归已先复现错误合并，再修复。

## scan_scope

- internal/workersapi 的 cache、HTTP transport、metrics 与相邻 integration test。

## scan_output

- activeWorker 在 cache miss 后直接 Registry GET，多个调用者未合并。

## handoff

- 本地机制修复已实现；最终门禁后待独立 Go API 发布。候选 Runtime 继续原任务，不重编译 workerd。
- 保持完整云发布/strict10k/Router/百万 dormant 目标不变；不以局部回归替代云性能资格。
