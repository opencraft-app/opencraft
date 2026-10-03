# 独立代码上传与 Agent 持续负载

仅走公共 `/v1`，不依赖 namespace、runner 或 datacenter 配置。Node.js 22+，
无 npm 依赖，不编译或修改产品 runtime。

```sh
node runner.mjs \
  --endpoint http://PRIVATE_API:6688/v1 \
  --output /data/tmp/agent-upload-soak-RUN \
  --count 100000 --rate 20 --duration-ms 30000 --interval-ms 1000
```

- 每 50 ms 发起一个独立 Worker 的 Version 上传，每份源码携带不同 run/index，
  不将一次上传复用十万次。随后分别发布 Deployment、创建 Agent、调用第一条消息。
- 每个对象从第一条消息发起时开始交互 30 秒，目标每秒一条。请求顺序执行，不对
  有副作用的 HTTP 失败自动重试。迟到的交互槽明确计为 missed，不补发突发流量。
- 最后读持久状态，验证已获成功响应的消息没有丢失或重复。每次请求超时 15 秒。
- 不销毁 Worker/Agent，不调用 sleep，不 force reclaim，不改空闲休眠或 GC 参数。
  交互结束后保留对象，让生产策略自然休眠并沉降。代码缓存不是活跃 isolate 数。
- 十万次上传的理论发起时间为 5000 秒，最后一批仍需完成创建与交互。
  约 600 个交互对象不含创建中、空闲等待休眠、prepare/canary 或保留的实例。
- 发起节拍不随服务器响应自动降速。超过 4096 个未完成任务或发起迟到超过 1 秒
  停止新工作，并显式标为 load-generator backlog。连续 100 个创建失败、确认的
  状态错误或本地账本写入失败也会停止，防止无限堆积或制造云资源风暴。
- `scheduled`、`uploadAttempts`、`uploadsSucceeded`、`agentsReady`、`agentsCompleted`
  分开计数。失败不算成功；不保证有故障时仍完成十万个成功 Agent。

输出包含 `config.json`、15 秒一次原子更新的 `progress.json`、追加的
`agents.ndjson` 资源清单与最终 `receipt.json`。成功交互不逐条日志刷屏。
分位数是有界对数直方图的上界估计，max 为实际观测。3 秒就绪超标单独计数，
功能测试通过不意味着 3 秒 SLO、自然休眠或云扩容已证明。

同一输出目录拒绝再次运行，不自动重放不确定的请求。SIGTERM/SIGINT 停止发起并
取消在途调用，保留清单与最终状态；不要在发现原进程仍运行时重新发起一次。
输出目录和配置均位于 `/data`，不应保存到 Git。

## 扩容观察

从具有合法 VPC 连通性的 C builder 发起负载，记录 A/B 的 HPA desired/current、
runtime-host Ready/Pending、`np-runtime0` desired/Ready、admitted Node 数量和 UID、
Host RSS 与 active actor 指标。禁止为了制造扩容证明手改 replicas 或准入 label。

扩容证明需按时间关联完整链路：Actor 水位上升、HPA 增加 Pod、Pod Pending、
capacity controller 增加 MachineSet、TKE 创建新 Node、准入通过和 placement。
单纯 HPA desired 增长不算 Node 扩容通过。观察程序只有读权限。

`observe.py` 每 Cell 每次使用一个有界 Prometheus instant-vector 查询，保留既有八个容量与
压力字段，另在 `metricsSnapshot` 记录完整 query、请求时刻、样本时刻和有界诊断维度、
缺失指标与服务端 warnings。HTTP 超时五秒、响应最多 1 MiB/256 行，不重试，不访问 Actor
数据库，也不创建高基数指标。kubectl 读取仍有独立超时；一次 Prometheus 查询不等于整个
Kubernetes 快照原子一致或保证 15 秒采样周期。

后台诊断同时记录五分钟滑动窗口的完成 job、成功 bytes/objects 和活动 duration sum/count
的速率。先对原始 counter 做 `rate` 再聚合，允许 Prometheus 处理 Engine 重启；不能对副本
sum 的累计值直接作差。联合查看：

- `reclaim_fdb` 成功 bytes/s 是否追上权威 hot debt 增长。
- 相同 operation 的 succeeded/retryable/rejected 比例以及活动服务时间。
- permit/waiter 有余量时，是否仍存在计划重排、维护周期或保留策略等待。
- `coldStorageBytesMin/Max` 中同一 Cell 账本的副本采样分歧；它们不是不同副本的存储量，
不能相加。FDB 账本是平台逻辑 payload，不是 COS 账单或 FDB 物理磁盘大小。

新 Runtime 的九类显式准入活动另记录 `depotAdmissionSeconds/OutcomesPerSecond` 与
`depotExecutionSeconds/OutcomesPerSecond`，按固定 activity_name/result 聚合。
准入 `deferred` 不是执行失败；执行 `succeeded` 也不是有效 fold。旧 Runtime 缺少这些
指标时保留 missing，不回退到包含排队的旧 duration。`depotPlanningReadBytesPerSecond`
与 `depotPlanningTransactionAttempts/CompletionsPerSecond` 只选择 full refresh、active
observation 和 hot stage 三个固定 transaction；同窗可计算每个已完成 transaction 的
读取量及 attempt 倍数。它们不覆盖全部 workflow replay，也不代表业务写入放大倍数。
新维度的未知值、跨准入/执行结果和意外字段均失败关闭，不引入 Actor ID 或任意 transaction。

compaction 共享 lane 的执行时间须相加后与许可数比较，不能给每个活动各算一份许可。
完成 attempt 的服务时间只覆盖已执行、已结束的样本；既不是 offered demand，也不能
证明尚未结束任务的尾延迟。容量结论还须关联有效 bytes/objects、hot debt 趋势与前台 SLO。

`missingSignals` 与非有限样本不能当作零。活动计数不是 COS PUT/GET 次数，成功 bytes 也
不是用户写入总量；五分钟 rate 不是本次测试对象的独立计数。完成活动的平均服务时间不包含
未获许可者的最长等待。不能凭这个 trace 证明任务公平性、最长队龄或维护期限的根因。

```sh
node --test runner.test.mjs
python3 test_observe.py
```

测试通过真实 loopback HTTP protocol double 验证独立上传、持久消息校验、保留
对象、输出目录互斥和显式失败，不能替代云端负载证据。
