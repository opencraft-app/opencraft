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

```sh
node --test runner.test.mjs
```

测试通过真实 loopback HTTP protocol double 验证独立上传、持久消息校验、保留
对象、输出目录互斥和显式失败，不能替代云端负载证据。
