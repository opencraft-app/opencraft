---
id: minisandbox-active-load-timeout-2026-10-02
type: task
scope: 对齐真实万级资格的 B Cell 活跃请求超时与安全收缩证据。
triggers: ["minisandbox active timeout", "B Cell indeterminate result", "strict active-load diagnosis"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/shared-agent-scale/runner.mjs
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

定位同一真实扩容任务中的活跃请求卡顿，保留原失败和清理事实后再选择产品修复。

## non_goals

- 不增加超时、允许稳态重试、提前重跑、手工缩容或并发现网变更。
- 不把成功的节点准入或 FDB 可用性当作业务请求正确性证明。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式 Stateless Workers/DO 设计 Phase 5：万级活跃、零重试、负载驱动扩容和安全缩回。

## interface_refs / data_structure_refs

- actor-shared-agent-scale/v1 与 actor-shared-agent-cleanup/v1。
- indeterminate_result 代表执行结果未知，不得对普通用户自动重放；测试 Agent 有稳定 operation ID。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：此前 f9e4 运行在8298 active失败，已限制 membership cohort；新 f564仍需独立资格。
- superseded_refs：此前成功的小规模或旧 Runtime 资格不覆盖本轮。

## acceptance

- 对齐绝对 UTC、Cell 和原始失败收据，精确清理与最终原任务安全收缩。
- 原因证据充分后才能提出修复；不能从 FDB health 推导吞吐或全部请求健康。

## affected_paths

- 正式设计、本 Task/catalog；当前不修改运行时。

## required_context

- release-gitops、upstream-subtrees、adjacency-argocd-ci-secrets。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@0eb0965b | 仓库约束 | 证据不能猜测 |
| docs/context/domains/release-gitops.md@0eb0965b | 线上边界 | 不并发发布 |
| docs/context/project/upstream-subtrees.md@0eb0965b | 单写源 | mono2 |
| docs/context/project/adjacency/argocd-ci-secrets.md@0eb0965b | 邻接 | 只使用配置凭据，不输出 |
| minisandbox/CLAUDE.md@0eb0965b | 实现约束 | 不靠放宽超时绕过 |
| minisandbox/infra/cells/AGENTS.md@0eb0965b | 高风险互斥 | 等待原任务缩回 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@0eb0965b | 资格边界 | 保留失败事实 |
| minisandbox/infra/cells/deploy/tencent/fleet/load/shared-agent-scale/README.md@820241a5 | 重试语义 | 幂等 fixture 不等于生产重放 |
| minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@820241a5 | 完整目标 | 仍未完成 Phase 5 |

## evidence

- 唯一原任务 inv-c9def3gxtj，run f56405fe9169424fb97d3c81b3da2704；仍在最终安全收缩阶段。
- load receipt 官方下载，摘要前缀151c16bb56db，完整SHA-256见正式设计：failed/request_retry，1517 Object、53574 成功 heartbeat、4 retries。
- retry journal 在09:20:41.717 UTC指向索引780/747/744/774，均 active/502/indeterminate_result。
- 只读 inv-e9df0800rn SUCCESS/0：C 三 API副本日志中四项均指向 B Engine10.162.0.2:6420，response header timeout；C image与UID不变。
- A/B Engine、Host无重启，FDB健康、可用、全复制，9/9 Pod。不能据此认定数据库延迟没有问题。
- cleanup receipt 官方下载，摘要前缀ce1b35b0af49，完整SHA-256见正式设计：passed，1517精确对象已删除、pending0；幂等清理单独有1次重试。
- 只读 inv-e9dew605u6 SUCCESS/0：A/B 48/45 Node均 Ready/admitted、无 pending，Host同样全 Ready；证明真实准入，不证明万级业务资格。
- 初次 Prometheus Guard查询漏 rivet_ 前缀，指标空，不能解释为健康；已按真实 Registry前缀修正诊断查询。
- 修正后的只读 inv-c9df2u0gh1 SUCCESS/0：09:18至09:21的13个样本，allocate p99约50ms、start p99最高453ms、ready-wait p99最高2.43s、proxy p99最高947ms，Engine CPU约1.56至2.20核且throttle0。分位数不能排除四项长尾，尚未确定卡顿位置。

## risks

- indeterminate 不代表没有副作用。只对 fixture operation ID明确幂等的请求做诊断重试。
- 删除后现场会改变，必须使用原绝对时间窗口和日志，而不是拿缩容后的空闲状态解释失败。

## validation

- 官方收据 hash/字段独立校验、只读 Kubernetes与原时间窗口、文档/Context门禁。

## decisions

- 不重提旧任务，不扩大超时，继续查 B 的 Guard/Host执行等待。

## scan_scope

- shared-agent-scale、Workers API fetch transport、Guard/Pegboard metrics、原任务非秘密身份字段。

## scan_output

- 精确 phase/status/code、时间、Cell、Pod重启与指标，无令牌或完整请求内容。

## handoff

- 原任务等待自然串行 drain 到 floor4，本地 wait97781续接。
- 完整目标 active；Router性能、百万 dormant 与其他正式设计门禁不能提前认定通过。
