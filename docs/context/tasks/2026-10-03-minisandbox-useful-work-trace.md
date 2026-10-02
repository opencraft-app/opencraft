---
id: minisandbox-useful-work-trace-2026-10-03
type: task
scope: 负载观察同时记录有效压缩吞吐、失效重做与 Cell 账本，避免以副本数量解释性能。
triggers: ["minisandbox useful work trace", "compaction retry rate", "cold storage effective throughput"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/agent-upload-soak/observe.py
  - minisandbox/engine/packages/depot/src/metrics.rs
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: retired
reviewed_at: 2026-10-03
review_due: 2026-11-03
revision: 1.1.0
precedence: task
derived: false
---

## goal

在现有只读容量 trace 中保留同一查询时刻的有效后台工作与重复 Cell 账本范围。

## non_goals

- 不修改 Runtime、并发、维护周期、placement、持久化 fence 或资格 SLO。
- 不把采样或生产小负载通过当作万级、百万级资格。
- 不自动重试请求，不执行长时间 soak 或物理恢复。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户要求关注性能劣化，并从建模设计上解决。
- 正式设计“性能劣化的模型与验收口径”：有效 reclaim、失效比例、hot debt 与物理容量必须联合测量。

## interface_refs / data_structure_refs

- `metric_queries` 保留八个既有容量/压力字段。
- 一个 Prometheus instant vector 保留 query、采样时间、operation/result/class；先对每条 counter 做 rate，再聚合，避免 Pod 替换导致错误导数。
- Cell 账本用 min/max 描述 Engine 重复采样的分歧，不对副本累加。
- 缺失、非有限值和传输失败不能成为零；响应字节数和行数有硬上限。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：49b721 已加入有效吞吐模型；旧负载 trace 只有许可/队列，无法区分成功推进与计划重做。
- superseded_refs：不能将 6133 个后台 job 等价为 6133 个 COS 请求，也不能以重复账本之和估算 FDB 占用。

## acceptance

- 单个 Cell 每次只发一个有界 Prometheus HTTP 请求，兼容现有八个字段。
- 真实 loopback HTTP 测试覆盖查询参数、counter rate 顺序、Cell ledger min/max、异常、缺失、非有限值、响应大小/行数边界。
- 相关容量回归通过，正式设计及只读 observer 文档同步。

## affected_paths

- load/agent-upload-soak/observe.py、test_observe.py、README.md。
- 正式设计、本 Task、catalog 自有行。

## required_context

- release-gitops、upstream-subtrees、cells AGENTS、Fleet README、argocd-ci-secrets 邻接。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@49b721 | 根边界 | 独立 Task 与证据 |
| docs/context/domains/release-gitops.md@49b721 | 路由 | 不混淆源码和云资格 |
| docs/context/project/upstream-subtrees.md@49b721 | 路由 | mono2 唯一写源 |
| docs/context/project/adjacency/argocd-ci-secrets.md@49b721 | 邻接 | 精确 qualification 入口 |
| minisandbox/infra/cells/AGENTS.md@49b721 | 最近服务入口 | 只读观察、原资格门禁 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@49b721 | Fleet 真源 | 不修改正在执行的发布 |
| minisandbox/engine/AGENTS.md@49b721 | 指标来源 | 精确分支定位，禁止全仓 workflow 扫描 |
| minisandbox/engine/packages/depot/src/metrics.rs@49b721 | Counter 语义 | bytes 仅成功活动、result 分类 |
| minisandbox/infra/cells/deploy/tencent/fleet/load/agent-upload-soak/test_observe.py@49b721 | 测试邻居 | 保留旧容量字段 |
| minisandbox/infra/cells/deploy/tencent/fleet/load/ten-thousand-active/run-on-builder.sh@49b721 | 实际消费者 | 只改变 observer，不重编 workerd |
| docs/context/tasks/TASK-TEMPLATE.md@49b721 | Task 契约 | 有界验收 |

## evidence

- A 实际 Bottomless passed：48/48 exact cold，cold wait 973275.74 ms；Engine HA passed。
- 中途 29 对象 hot 行暂时不变，compaction permit/queue 为零，reclaim retryable 累计 29；相关性不等于根因已证。
- Runtime 发布末尾 block 是收据命名与发现规则不一致，不能误报为数据路径失败。
- A 已通过 canonical governance/activation 恢复；原失败决策保留，未重复 rollout 或 fault。
- 新查询在真实 A Prometheus 执行：inv-d9dx4bg5gs SUCCESS0，42 行、15 信号、无 missing/warnings。
  FDB authoritative 的重复采样 min/max 同为 3676812044 字节；此时已结束 qualification，不能
  将零 reclaim rate 当作负载期间冷降性能。observer 源 hash 前缀 5ae8d25a，未更改 Runtime 镜像。

## risks

- 5 分钟 rate 是滑动窗口，不是本次 Actor cohort 的请求计数；不能用于证明外部 COS 请求次数。
- min/max 非物理存储计费；缺少 exporter freshness 时不能推断实时权威字节。

## validation

- 17 条 observer 回归通过，含真实 HTTP、恶意 scope、非有限值、时间戳与响应界限；
  15 条 ten-thousand-active verifier 回归通过。py_compile、diff、实际路径文档 impact 通过。
- 文档 validator errors/warnings 为空；根 Context 仍有既有治理债，不冒称全仓 green。

## decisions

- 合并查询减少既有八次串行 HTTP 的观测扰动，不加入无限并发或自动重试。
- 先保留完整观测语义，再按证据决定 Runtime 优化；本任务不改回收计划身份。
- subprocess 使用 PIPE/universal_newlines 保持 Python 3.6 标准库调用兼容；未声称所有 Python 版本都已实测。

## scan_scope

- observer、实际 consumer、Depot metrics 与 manager timer。

## scan_output

- manager normal reclaim 默认 600000 ms，并按分支稳定错峰为 50%～150%；只有 exact 成功回收可立即续下一有界批。
- 故障后的慢重排是独立待证机制，不在本任务凭相关性修改。

## handoff

- 只读观测实现及真实 Prometheus 查询验证完成；下一轮新的负载 trace 可联合容量和有效工作分析。
- B 的正式发布/资格使用原门禁串行运行，完整 Stateless/DO 目标仍未完成。
