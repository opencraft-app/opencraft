# 共享代码的大规模 Agent 负载

这个负载模型把代码面与 Agent 数据面分开：少量 immutable Version/Deployment
承载大量独立 Durable Object。每个 Object 有独立 ID 和 SQLite 状态，但不会
重复上传相同代码。

生产规模基线：

```sh
node runner.mjs \
  --endpoint http://PRIVATE_API:6688/v1 \
  --output /data/tmp/shared-agent-scale-RUN \
  --count 200000 --rate 20 --active 1000 --workers 16 \
  --warmup 1600 --warmup-rate 2 --warmup-settle-ms 120000 \
  --active-interval-ms 10000 --observe-after-ms 300000
```

- 只发布 `--workers` 个 Worker/Version/Deployment，Object 按确定性哈希分布。
- 以 `--rate` 创建 Object；`PUT` 成功后立即写入一条幂等初始状态，
  所以成功数代表“已可交互的持久 Agent”，而不只是 Registry 占位符。
- 前 `--active` 个 Object 按均匀节拍持续发送幂等 heartbeat；其他 Object
  不再访问，由生产 idle-sleep 策略自然休眠。
- 冷集群先以 `--warmup-rate` 渐进创建 `--warmup` 个真实 Object，在这一
  阶段临时保持它们活跃，使 HPA 有时间补足“1,000 长驻 + 30 秒新建窗口”
  的容量。容量稳定后只保留前 `--active` 个活跃，再测量 `--rate` 和
  3 秒就绪 SLO，不把云节点冷启动时间偷算成稳态 Agent 创建延迟。
- heartbeat 不会同时突发 1,000 个请求，而是在整个 interval 内均匀铺开。
- 所有可能重试的写入都携带稳定 operation ID；超时后重试不会重复产生
  Agent 副作用。低水位 warmup 允许 `create/initialize` 对明确的 429/503/504
  容量背压做最长 15 分钟的有界重试，并把对象数、次数、错误码和退避写入 receipt
  与 journal。这是要验证的云节点冷扩容窗口，不计入稳态三秒 SLO。
- warmup 以外的任何重试、warmup 的非容量错误或容量等待超时仍立即停止新工作并
  生成失败 receipt；正式 1,000 Object 稳态样本和全部 heartbeat 仍要求零重试。
- `passed` 要求 warmup 之后每个 Object 的“创建 + 首次持久状态写入”均在
  `--ready-slo-ms` 内完成；任何一次超时都会记录为 breach 并使最终 verdict 失败。
- 1000 个热对象不只要求各自至少成功一次；整个保持活跃窗口内任一
  heartbeat 失败或任何请求发生可恢复重试，也会使资格失败。
- Runner 在生成负载 receipt 前保留 Worker/Object，便于结束时核验持久对象与
  冷沉降；云上资格编排必须随后运行精确清理，不能把测试对象永久留在 Cell。

输出 `config.json`、`progress.json`、`events.ndjson` 和最终 `receipt.json`。
`progress.json` 每 15 秒原子更新，可用于长时间运行的外部观测。负载器不会
修改 HPA、MachineSet、Node admission 或休眠参数。
每条 `object_ready` journal 记录都包含绝对 UTC 时间以及独立的 `createMs`、
`initializeMs`，用于把三秒尾延迟精确对齐到中央 placement、Cell Actor 启动或
首次 SQLite 写入；`retry` 和 `error` 也包含绝对 UTC 时间，便于直接对齐服务端
日志。不得只凭总耗时猜测并放宽 SLO。

`activeDemand` 单独描述已有的单对象单在途 heartbeat 调度器，不改变请求节拍、
重试或资格判定。它用常数空间记录实际 timer 调用、访问槽、派发和三个互斥的
跳过原因（未就绪、已有在途、停止中）；`dispatched` 必须等于 `activeAttempts`。
这两者计数逻辑 heartbeat；`activeHttpAttempts` 另记实际调用 fetch 的尝试，包含
重试和已取消尝试，不代表服务端已收到请求。故障中的物理成本不能只看逻辑派发。
`idealTimerSlots` 是调度时钟按原有每 tick 向上取整规则计算的累计槽数，
`timerSlotDeficit` 暴露 timer 延迟而未访问的槽。它不是实际对已就绪对象发出的
请求数，正常 tick 边界可有一个 tick 的相位差；warmup 不应以此宣称目标吞吐。
同时报告名义对象频率与离散 timer 槽频率，目标转换按原阶段积分，停止 timer 后
排空在途请求的时间不再增加理想需求。`skippedInFlight` 暴露响应变慢后被抑制的
请求，不能由完成数或零失败推出目标到达率已满足；应在相同稳态窗口分别计算
派发率和成功率，并另用固定到达的性能门禁验证吞吐。这是诊断字段，不是新成功捷径。
正在运行的 immutable tools-120 负载没有这些新增字段，不得事后补造其计数。

清理只接受 immutable load receipt 和同目录 `config.json` 作为删除权威，不
扫描 Worker namespace。它支持 shared Agent 与旧的独立 upload-soak 身份，使用
SQLite 记录逐对象进度，崩溃后以幂等 DELETE 续跑：

```sh
python3 cleanup.py \
  --endpoint http://PRIVATE_API:6688/v1 \
  --receipt /data/tmp/shared-agent-scale-RUN/receipt.json \
  --manifest /data/tmp/shared-agent-scale-RUN/cleanup.sqlite \
  --output /data/tmp/shared-agent-scale-RUN/cleanup-receipt.json
```

批量清理历史资格目录时可用 `--root`；它只采纳 schema 为
`actor-shared-agent-scale/v1` 或 `actor-agent-upload-soak/v1` 的 receipt，并
校验 run ID、scheduled cardinality、config 哈希和确定性 Object ID。正式门禁
必须同时保留 load receipt、cleanup manifest 与 cleanup receipt。

```sh
node --test runner.test.mjs heartbeat-demand.test.mjs
```
