# B Cell：共享 Version 的 Agent 基数验收（进行中）

## 已验证与未验证

- `actor-bj-b01` 已运行三副本 Workers API。运行时 c380 的正式镜像为
  `rivet-runtime@sha256:9d336be146de3946fb9e63936f27ca710fc84846f92558352c6cf902b6da4505`。
- 用一份 immutable Worker Version、目标 10,000 个持久 Object 的真实 `/v1` Job
  `shared-version-10k-v5r2` 完成了代码 prepare，但第一批 512 个请求在第约 127 个
  附近开始出现 `actor_wake_retries_exceeded`；当时仅有四个各 32 slot 的 Host。
- 19 个 Ready Host 下，`v5r4` 的首批 256 个仍有 17 个 3 秒
  `actor_ready_timeout`；18 个 Ready Host、客户端并发降至 8 时，`v5r5` 在第约
  46 个附近仍有 4 个同类超时。故障时 HPA 报告的平均活跃 Actor 不到每 Host 三个。
  计算槽位不是唯一瓶颈；Engine 同时报告 `depot_db_manager` FDB transaction retry
  耗尽与 3–6 秒的 durable signal lag。该结果**不构成** 10,000 Object 通过证据。
- 源码提交 `3865174b591a5f5121d795d7353899468d68ea7c` 移除了每个 Actor
  休眠时强制触发的 `hot+cold+reclaim+final_settle`，恢复 Depot 的周期性、有界冷降所有权。
  `cargo check -p pegboard`、`cargo test -p pegboard --lib --no-run`、Rust format 和
  Python syntax 检查通过。
- 使用 c380 校验过的静态 workerd/FDB stage、离线 vendor 和经完整 source manifest
  核验的 21 文件 delta，构建并验证了候选镜像
  `rivet-runtime@sha256:4ae8147ed1f651ad539a190857dcaa2aaa88c976b3803f0c6202d6996d23bae0`。
  候选镜像**尚未发布到 B Cell**，因此尚无修复后的云上性能结论。

## 完成门禁

1. 将候选镜像加入完整 image inventory，通过 `release-runtime.sh` 事务发布，而非
   直接修改 Deployment/StatefulSet；保留 release receipt、Engine HA 与冷降资格。
2. 只用一个 Version、独立 run ID，执行 10,000 个 Object 的创建、休眠、唤醒、
   持久状态验证和逐对象删除，保留 manifest、创建/删除 receipt 与错误分布。
3. 对 sleep 时段及写静默约两分钟后的 Engine signal lag、FDB txn retry、COS PUT、
   FDB hot debt 做时间序列对照。证明周期冷降仍可恢复且不饿死前台创建。
4. 另立突发创建测试验证 admission/重试；不把按速率整形的基数测试说成
   “20 Agent/s 满足 3 秒 SLA”。HTTP `retryable=true` 不等于无副作用，客户端
   只能对稳定 Object ID 的 PUT 及带 expected 值的幂等状态转移做有界重试。
5. 对失败的旧 run ID 按确定性 Object ID 有界清理；不得扫删整个 namespace。
