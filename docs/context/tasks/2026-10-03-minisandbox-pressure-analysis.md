---
id: minisandbox-pressure-analysis-2026-10-03
type: task
scope: 从不可变容量 trace 生成有界、可复算且不冒充资格的后台压力分析。
triggers: ["minisandbox pressure analysis", "Depot work amplification model", "后台压力复算"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/ten-thousand-active/analyze_pressure.py
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: retired
reviewed_at: 2026-10-03
review_due: 2026-11-03
revision: 1.1.0
precedence: task
derived: false
---

## goal

把性能模型落实为只读离线分析：区分规划读成本、准入和执行、有效安全回收及观测 hot-debt
趋势；不可用指标保持 unknown，不能由 HTTP 成功或 CPU 空闲推断持续吞吐足够。

## non_goals

- 不修改正在运行的 strict10k、Runtime、云资源、负载参数或既有资格 verdict。
- 不新增网络查询、FDB 扫描或 Actor/数据库标签。
- 不把滚动五分钟 rate 积分称为精确区间事件总数，不把账本逻辑 bytes 称为 COS 账单 bytes。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户要求从建模设计解释性能劣化；正式设计 Phase 5 的成本、有效维护进度和观测边界。
- 原万级活跃、零普通请求 retry、三秒 post-warmup 创建门禁不改变。

## interface_refs / data_structure_refs

- `agent-upload-soak/observe.py` 的 `metricsSnapshot`：有界 instant vector、五分钟 rate、
  query timestamp、missingSignals 和 warnings；同一 Cell ledger 以 min/max 而非副本 sum 聚合。
- `depot/metrics.rs`：仅 succeeded 时更新 compaction bytes/items；batch gauge 不是队列。
  实际 guard 高于 metric HELP：cold upload/publish bytes 为计划 hot shard bytes、items 为 cold
  ref count；reclaim bytes/key count 为实际 FDB 清理输出。不得据此计算 COS 对象填充率。
- `ten-thousand-active/verify.py`：本分析不签发或覆写其资格收据。

## history_context

- `current_design_refs`：Stateless Workers、Durable Objects 与跨 Cell 内网寻址设计。
- `relevant_evolution`：Runtime 59 和 tools 120 已分别交付，新 run 55b55875 实际运行；
  旧失败 d3a16351 不能重标成功，旧 trace 缺新指标须保持 unknown。
- `superseded_refs`：不以旧包含排队的 activity duration 代替实际 execution。

## acceptance

- 流式读取，内存不随 trace 样本数增长，输入 SHA 与同一次字节读取绑定。
- 拒绝重复 Cell、逆序时间、重复 metric、身份变化、畸形标签和读取期间文件变化。
- 缺失、NaN/Inf、零 denominator 不生成零成本或无失败结论。
- 比率使用同一 snapshot 的 sum/count；账本保留 min/max 分歧与采样时刻。
- 输出显式为非资格分析，拒绝已有输出，不连接云或触发编译。
- schema v2 显式报告 byte/item 单位，区别计划 hot shard bytes、cold references 和 reclaimed FDB keys。
- 本地真实文件/子进程回归、fleet、documentation 和 change-impact 门禁通过。

## affected_paths

- `minisandbox/infra/cells/deploy/tencent/fleet/load/ten-thousand-active/`
- `minisandbox/infra/cells/deploy/tencent/fleet/verify-manifests.sh`
- 正式设计、本 Task 与 context catalog。

## required_context

- 根、minisandbox、infra/cells AGENTS；upstream-subtrees、release-gitops。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@e4490d46`、`minisandbox/AGENTS.md@e4490d46`、`minisandbox/infra/cells/AGENTS.md@e4490d46` | 源码/发布/凭证所有权 | 独立自身 revision；不重编 workerd或改变运行中的负载 |
| `docs/context/domains/release-gitops.md@e4490d46`、`docs/context/project/upstream-subtrees.md@e4490d46` | 路由真源 | mono2 唯一源码，工具分析不是 Runtime 发布 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@e4490d46`、`minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_monitor_bottomless.py@e4490d46` | 邻接与失败边界 | 原 invocation 不重发、失败不借用成功证据 |
| `minisandbox/infra/cells/deploy/tencent/fleet/load/agent-upload-soak/observe.py@e4490d46`、`minisandbox/infra/cells/deploy/tencent/fleet/load/agent-upload-soak/test_observe.py@e4490d46` | 实际 metrics 结构 | 单次有界读取，unknown 不补零，不 sum 账本 |
| `minisandbox/engine/packages/depot/src/metrics.rs@e4490d46`、`minisandbox/engine/packages/depot/src/workflows/db_reclaimer.rs@e4490d46`、`minisandbox/engine/packages/depot/src/workflows/db_cold_compacter.rs@e4490d46` | bytes/objects 成功语义 | publication、upload、reclaim 是不同成本口径 |
| `minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@e4490d46`、`minisandbox/infra/cells/deploy/tencent/fleet/load/ten-thousand-active/verify.py@e4490d46` | 完整目标与原资格 | 不缩小目标或放宽 verifier |
| `minisandbox/engine/packages/depot/src/compaction/types.rs@5f04c576`、`minisandbox/engine/packages/depot/src/compaction/shared.rs@5f04c576`、`minisandbox/engine/packages/depot/src/workflows/db_reclaimer.rs@5f04c576`、`minisandbox/engine/packages/depot/src/workflows/db_cold_compacter.rs@5f04c576` | 真实 live snapshot 与 metric HELP 的歧义 | 按实际 producer 修正诊断单位，不改 Runtime 指标或吞吐 |

## evidence

- `inv-c9eem5g41a` / `inv-c9eepm02uh` 只读证明原 systemd InvocationID 8ee84c21 仍运行。
  510 秒样本 983 ready、20,601 次 active success、普通 retry/失败零；7,137 次明确 warmup
  背压重试、最长 ready 227 秒。A/B 已自动增至 27/28 desired Host，未到万级。
- `inv-d9ef1agh1t` SUCCESS/0，03:39:01 UTC 同一 service 与 InvocationID：2,244 ready、
  121,935 次 active success，普通 retry/失败/身份漂移零；warmup 背压累计 7,166 次、
  576 对象、零 timeout，三秒 post-warmup 样本尚未开始。A/B Host desired 65/62、Ready
  57/57；下一只读采样不得早于 03:44:01 UTC。没有重启负载或 runtime rollout。
- 实际原失败 trace 189,670,807 bytes、SHA 前缀 `5869f78f`，窗口 20:00--20:25 UTC
  每 Cell 74 样本，身份完整。A/B authority slope 观察下界约 802,414/844,782 bytes/s，
  上界约 826,384/871,051 bytes/s；窗口末端 reclaim rate 真实零，规划新指标 unknown。
  这是旧压测的非资格诊断，不是首个 502 的因果证明。复算结果保留在
  `/data/tmp/minisandbox-strict10k-d3a16351-pressure-window-v1-final-20261003.json`。
- 新 run 55b55875 的固定前缀快照 `inv-e9efa7gbxk` SUCCESS/0：13,472,442 bytes，
  SHA 前缀 a11bd34a，官方 COS relay `inv-a9efamgh3u` / `inv-e9efan09pw` SUCCESS/0。
  本地原字节路径 `/data/tmp/minisandbox-strict10k-55b55875-pressure-capacity-034831-20261003.ndjson`。
  v2 复算的 03:35--03:48 每 Cell 44 样本、身份完整、无末端错误/warning；A/B authority
  增长约 202,882--211,353 / 202,603--216,007 bytes/s，末端 reclaim bytes/key rate 为零。
  A/B manager/compaction waiter 峰值 0/0 与 0/1；active observation 约 165 bytes/事务，
  full refresh 约 84,409/82,158 bytes/完成事务、attempt ratio 1.065/1.083。
  该低水位阶段与旧 9k 负载不同，不能作为受控性能收益对照或万级稳定性证明。
- 复算收据 `evidence/55b55875-pressure-early-20261003.json` 与本地 v2 JSON 同字节，
  SHA 前缀 f86945a8；明确 qualificationEvidence=false，不替代容量资格。
- 03:54:54 UTC `inv-a9efg70hhp` SUCCESS/0，同一 service/InvocationID：4,134 ready、
  4,117 proven、423,205 active success、116 in-flight，零普通失败/retry/身份漂移；
  warmup 背压未再增加，三秒 post-warmup 样本仍零。A/B Host desired 119/122、Ready
  108/111。下一 progress 观察不早于 03:59:54 UTC。

## risks

- 完成者均值不覆盖未执行任务年龄或总 offered demand；输出必须明确保留缺项。
- 滚动五分钟窗口和账本跨副本采样存在时间偏差；不可包装成精确需求、事件总量或 causal proof。

## validation

- 聚焦 analyzer 回归、既有 strict verifier/observer 回归、完整 fleet 和 context 门禁。
- analyzer 实际文件/CLI 16 项回归通过；完整 fleet `verify-manifests.sh` 原命令 exit 0。
  日志 `/data/tmp/minisandbox-pressure-analysis-fleet-20261003.log`。
- documentation 零 errors/warnings；audit 33 项通过。Context 26 项仍为原四项失败，
  失败名称与旧 baseline 一致；全仓历史诊断另按 Counter 比较，不能标成全部通过。
- v2 单位与 producer 契约 17 项通过，真实新 trace 复算成功；完整 fleet exit 0，
  日志 `/data/tmp/minisandbox-pressure-units-v2-fleet-20261003.log`。Audit 33 项再次通过。
- v2 documentation 零 errors/warnings；Context 4,942 个历史错误按归一化 Counter
  比较无新增或消失，原四项 unit failure 不标绿；audit discovery 未进行成熟度评定。

## decisions

- 复用已有 trace，固定维度，不追加在线采样或 Runtime 指标；首先固化可复算的分析边界。

## scan_scope

- fleet/load、正式 qualifier 和 depot metrics 的有界源码。

## scan_output

- `db_cold_uploader.rs` 的有界查询无该文件；实际 guard 位于 `db_cold_compacter.rs`。
- 本轮 `compaction.rs`、`compaction_protocol*.rs`、`compaction/planner.rs` 不存在；
  之后有界 file list 找到 `compaction/{mod,shared,types}.rs`，不继续猜测目录。

## handoff

- v2 单位工具、设计和真实低水位分析完成，属于诊断交付；完整目标继续由 10k durable pressure Task 跟踪。
  云上唯一活跃负载仍为 run 55b55875，不能声明万级通过。

## checkpoint

### stage

前一目标 turn 为 progress：A/B qualification 完成、唯一 strict10k 启动且证据已推 master。
本轮为 progress：完成 v2 单位修正、真实新快照复算、17 项回归与 fleet，未修改 Runtime。
当前维护队列小、authority 仍增长；v1 的 per-object 字段不能用于 COS 填充率。
唯一 service fresh 04:02:22 UTC 为 5,033 ready、628,461 success，普通 retry/失败零；
下一 progress 观察不早于 04:07:22 UTC。先完成 catalog/context 并推 master，不改在线策略。

### next_action

完成 catalog/context 与 master push。继续观察原 10k，结合高水位、hot debt 与真实
pin/retention 判断持续回收，不能由一小段零 reclaim 或低 waiter 指定根因；不并发启动另一个负载。
