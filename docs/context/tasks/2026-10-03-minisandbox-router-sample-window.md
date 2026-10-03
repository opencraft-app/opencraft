---
id: minisandbox-router-sample-window-2026-10-03
type: task
scope: Router 性能采集拒绝错窗、重复或倒序的 Prometheus 样本时间，保留缺失与 NaN 边界。
triggers: ["minisandbox router sample window", "Router query range integrity", "performance sample timestamps"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/router-performance/capture.py
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: retired
reviewed_at: 2026-10-03
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal

只有属于实际负载时间窗口、时间严格递增且结构有效的样本才能形成 Router 性能证据。

## non_goals

- 不启动第二负载，不修改原 run 55b55875、Runtime、超时或重试。
- 不降低 10k 完整周期前置门禁，也不宣称云端性能或 replica/cache matrix 已通过。
- 不把 histogram 在无完成请求时的 NaN 改成零时延。

## requirement_ids / requirement_refs / requirement_excerpt

- stateless-workers-do-routing/phase-5：性能证据绑定精确负载时间窗及原始 query-range 响应。
- 性能容量矩阵仍包括 1/50/99% cache hit 和 1/4/8/16+ replica，当前工具未覆盖控制变量。

## interface_refs / data_structure_refs

- Prometheus query_range matrix 的 values 是 [numeric timestamp, string value]；
  样本必须匹配请求范围/step 网格且在各 series 中严格递增。标签集合不得重复。
- 10k 周期校验、至少五分钟/一万次零重试 binding 请求、跨 Cell RTT 要求保持。

## history_context

- current_design_refs：正式 Stateless Workers/DO 设计 Phase 5。
- relevant_evolution：master 51d79791 已修正 Depot 单位；采集器仍忽略 sample[0]。
- superseded_refs：有一个有限数值不能证明该数值属于当前负载。

## acceptance

- 旧 collector 对真实 HTTP 返回的历史时间 matrix 错误通过，保留重现命令证据。
- 错窗、重复/倒序/非数值时间、畸形行和重复 series 必须在输出发布前拒绝。
- 合法 NaN 可跳过且计数；NaN-only 和没有有限样本仍失败，合法数值不补零。
- 最后评估点缺失或 NaN 时不能用历史有限点顶替；跨 Cell pair 也必须在末端有效。
- 使用真实 HTTP 服务与 collector 子进程回归，正常数据保留原始响应及 SHA。
- Router suite、fleet、documentation、change-impact 及 Context 基线比较。

## affected_paths

- minisandbox/infra/cells/deploy/tencent/fleet/load/router-performance/
- minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md

## required_context

- upstream-subtrees、minisandbox/AGENTS.md、cells AGENTS、adjacency-argocd-ci-secrets。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@51d79791、docs/context/project/upstream-subtrees.md@51d79791 | 入口与实际路由 | 仅 mono2 写入，独立 revision |
| minisandbox/AGENTS.md@51d79791、minisandbox/infra/cells/AGENTS.md@51d79791 | 实现与云边界 | 真实 HTTP 回归，不并发负载 |
| docs/context/project/adjacency/argocd-ci-secrets.md@51d79791、minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_monitor_bottomless.py@51d79791 | 邻接实测 | 观察失败不重启原作业 |
| minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@51d79791 | 完整验收 | 不删减矩阵或容量前置门禁 |
| minisandbox/infra/cells/deploy/tencent/fleet/load/router-performance/capture.py@51d79791、minisandbox/infra/cells/deploy/tencent/fleet/load/router-performance/test_capture.py@51d79791 | 精确实现 | 数值有检查而 timestamp 未检查 |
| minisandbox/infra/cells/deploy/tencent/fleet/verify-manifests.sh@51d79791 | 验证邻居 | 三个显式入口漏掉 lifecycle/capacity/new tests，改为本目录 discover |

## evidence

- 实际 finite_values() 只读取 sample[1]；旧 fixture 时间为 1/2 而负载为 2026 年，仍通过。
- 修改 collector 前真实 HTTP/CLI 重现 exit1（9 failures/1 error）：historical/future、
  duplicate 与畸形行均暴露错误放行；NaN timestamp 还暴露输出目录提前创建。
  原日志 `/data/tmp/minisandbox-router-sample-window-before-20261003.log`。
- 原 run `inv-d9efts05nb` SUCCESS/0，04:07:16 UTC：5,632 ready、5,622 proven、
  787,957 active success，普通 retry/失败零。service/InvocationID/MainPID 未变；
  A/B Host desired 161/164、Ready 147/150。尚无 post-warmup 三秒创建样本。

## risks

- histogram 无完成样本时 NaN 合法，时间错误与非有限值不能混为同一情况。
- 本地完整性回归不等于真实云端性能证据。

## validation

- Router 最终 42 项 exit0，包含真实 HTTP/CLI、亚毫秒窗口网格与最终 artifact 哈希；日志
  `/data/tmp/minisandbox-router-sample-window-tests-grid-20261003.log`。
- collector 最终源码的 fleet exit0，日志 `/data/tmp/minisandbox-router-sample-window-fleet-final-20261003.log`；
  验证入口改为 discover 后再次全门禁 exit0，明确包含 41 项，日志
  `/data/tmp/minisandbox-router-sample-window-fleet-discovery-20261003.log`。
- 最终毫秒网格修正后完整 fleet exit0 且包含 42 项，日志
  `/data/tmp/minisandbox-router-sample-window-fleet-grid-20261003.log`。
- documentation 零 errors/warnings，九路径 change-impact 通过；audit 33 项 exit0。
- Context 26 项仍为原四项失败，名称与旧 baseline 一致；catalog 更新后再核对完整 Counter。
- 完整 Context 4,942 个历史 errors 的归一化 Counter 无新增或消失，不能标成全仓通过。

## decisions

- 修复只读采集器，不增加服务、Runtime 指标或线上配置。
- 合法非有限 metric 与时间错误分开处理，最新缺失不回退；保留 1 ms 请求参数舍入容差。
- 最后评估点由实际序列化的毫秒边界做整数除法决定，不能用浮点 epsilon 猜测下一个网格点。

## scan_scope

- fleet/load/router-performance/ 精确函数与测试，以及正式设计 Phase 5。

## scan_output

- 查到 finite_values/summarize/collect 唯一调用链；没有扩展到无关服务。

## handoff

- 原 run 55b55875 保持运行，按五分钟只读节奏观察；完整容量收据通过后再运行 Router。

## checkpoint

### stage

上一轮是 progress（单位修正已推 master）。本轮也是 progress：已复现历史样本错误通过，
实现 collector 时间与末端新鲜度检查，42 项真实 HTTP/CLI 与邻居回归和最终完整 fleet 通过。
原唯一云负载仍 running，没有新 cloud mutation、Runtime build 或并行压力。

### next_action

本地 gates 已通过，刷新两 Task catalog、Context Counter 并推 master；下一只读进度不早于 04:28:54 UTC。
真实 Router 仍须等完整 10k 周期通过；cache hit 与 replica 控制变量矩阵仍未实现/验证。
