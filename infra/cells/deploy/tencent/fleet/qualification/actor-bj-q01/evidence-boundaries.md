# q01 验收证据边界

本文件定义证据的解释方式，不是实时健康报告，也不能代替生产门禁。
当前状态以精确 invocation、终态 receipt、发布绑定和实时审计为准。

## 2026-09-08 当前发布与升级资格

当前线上 runtime digest 为
`sha256:48963636e53152411450013f423f75eba72d5a179089f9562f2bc3e356b41599`。
真实版本变化期间，`actor-bj-q01-user-transparent-upgrade-2c215678f593e9a2e311367becb396b7.json`
通过：32 个持久 DO Object、2930 次公共 `/v1` 请求、0 失败，p99 0.398 秒、最大
0.698 秒。完整 receipt SHA-256 为
`95cc1a21e56723a0ccb1d192164546a49be6c7f20772f7eb6d81080d08c5b8bf`，已进入集群不可变
缓存与北京 COS SHA 地址证据仓。

修复 compact v3 receipt 的 Hook 解析后，同版本 Argo 审计发布
`ad8a360eec6f073fde21b21b7f8025c4` 为 `Synced/Healthy/Succeeded`：1571 次公共请求
0 失败，p99 0.104 秒、最大 0.180 秒，runtime replica delta 为 0。完整 receipt SHA-256
为 `79d6b2f8044c7da9537578ccbd384d337fc4666d5a9d96350114396c29bf5141`，同样已独立归档。
第一份证明真实 runtime 演进期间的用户连续性；第二份证明修复后的 Argo/Hook/compact
evidence 状态机能终态收敛。32 是升级连续性样本，不是 Cell 容量上限或容量证明。

Guard 将 `actor_wake_retries_exceeded` 从不可重试的 400 修正为
`503 + Retry-After: 1 + x-rivet-error` 后，Argo release intent
`0d24ee6a2a6aa99bc7edb32b0753bace` 通过。Git desired-state commit 为
`96c64a3c509a65f2b79d3ccd090a68bf8804d809`，终态为
`Synced/Healthy/Succeeded`；32 个持久 DO Object 在真实 runtime 变化期间完成 3621 次
公共 `/v1` 请求，门禁失败为 0，p99 0.318 秒、最大 0.811 秒。完整 receipt
`actor-bj-q01-user-transparent-upgrade-0d24ee6a2a6aa99bc7edb32b0753bace.json`
的 SHA-256 为
`f5ede44492c32e0fae9e7fa4bbcf527f63fa73673c615ceca6f26fc892417e19`，已进入集群不可变
缓存并在北京 COS 精确回读验证。发布后 Engine 为 3/3 Ready，Host 因 HPA 门禁负载从
3 临时扩为 4/4 Ready，全部收敛到同一新 revision。该 receipt 证明本次协议修复可无感
演进，不把 256 Agent 档重新解释为容量通过。

## 2026-09-07 发布资格快照

当前 runtime digest 为
`sha256:233289903f92c9deff84b9816d63302ddc0786bb2bd1c425db8088ee40bd3032`。
以下三份 receipt 已同时进入集群不可变缓存与北京 COS SHA 地址证据仓：

- Agent arrival v4：`actor-bj-q01-agent-arrival-20260907T122919Z.json`，SHA-256
  `2f87ca3676204d89ba7510c3eada0f201d6e5b39282486fcd0a9145afb6cad22`。公共
  `/v1` DO API 的 100 Agent/s 突发 p50/p99/max 为
  0.926/1.517/1.800 秒；HPA、Host、Machine 从 3 扩到 6，再以三次精确 provider
  删除回到 3。
- Engine HA：`actor-bj-q01-engine-ha-20260907T125545Z-1a7168c3.json`，SHA-256
  `5b843aa952d44e2185d63f4fbdcd7979d563f8114a06e244b055e1c60ec23280`。10 个
  DO Object、1500 个公共 `/v1` 请求期间精确删除一个 Engine Pod，请求失败为 0。
- Bottomless production：
  `actor-bj-q01-bottomless-production-20260907T125656Z-dae7e4cc.json`，SHA-256
  `d9271259f0970fd195ac3a71537b081c5f43f77d4ad219827602f716f39b7a46`。48 个
  Agent、6240 次 checkpoint 后写入，生产 600 秒周期下约 639 秒完成 cold-only；
  cold read p95/p99/max 为 1.288/4.496/4.496 秒，恢复错误为 0。

最新 autonomy audit 的分数为 80，唯一失败项是 `dr_receipt_missing`。物理恢复
尚未创建 invocation：TAT 提交前云 API 返回 `AuthFailure.SecretIdNotFound`，因此
没有 DR 目标 FDB、PVC 或半完成 restore。恢复云操作凭据后，下一项是从已提升的
reviewed source 单次执行 `DR_EXECUTE=true physical-restore/run.sh`；Arrival、HA 和
Bottomless 不需要重跑。

## 创建与扩缩容

`actor-bj-q01-agent-arrival-20260907T031937Z.json` 已通过：先预热 80 个对象，
再以 100/s 的到达节奏提交 100 个对象（约 0.99 秒），随后验证计算容量
3→7→3 和逐台缩容。该轮 ready 最大约 1.18 秒。

它证明这次预热后的突发与扩缩容链路，不证明持续 100 Agent/s，
也不证明从零计算容量开始的冷创建能满足 3 秒。发布容量基线时必须同时注明
预热数、到达持续时间、活跃对象数、初始计算容量及分位延迟。

2026-09-08 将同一公共 DO 路径扩大到 256 个 Agent、100/s 到达，终态 receipt
`actor-bj-q01-agent-arrival-256-100ps-20260908.json` 明确失败，SHA-256 为
`43563ce263e8821cdb46e56b1c810c0778093c9e6b06fa0a11b27502b19418fc`。预热 80 个对象
正常，计算容量从 3 扩到 6，但 burst 的活跃对象峰值仅 96；随后一个对象在 ready 前
连续停止并耗尽 8 次 wake retry，公共 API 返回 `actor_wake_retries_exceeded`。失败清理按
exact manifest 删除全部 336 个对象，并通过逐台 drain 将 Host、MachineSet 恢复到 3/3。

该结果证明 q01 的 3-Host warm envelope 不能支持 256 个 Agent 在约 2.55 秒内全部可聊；
它不证明 FDB 数据丢失或扩缩容失控。云节点出生与 admission 需要分钟级时间，因此 `<3s`
突发承诺必须由突发前已经 Ready 的硬 slot 保障，不能依赖突发发生后才创建 CVM。当前可发布
基线仍是上述已通过的 100-object/100 Agent/s 短突发；256 档在增加经验证的 warm capacity
或引入明确的预测性预扩容前不得宣称通过。过载终态必须向用户暴露可重试的
`503 + Retry-After`，而不是不可重试的 400。该协议修复已随上述 runtime release 上线，
并由 Guard 单元测试和公共 `/v1` 无损发布门禁覆盖；它只修正过载语义，不增加 warm capacity，
因此 256 档仍保持失败结论。

## 冷存储恢复与自然沉降不能混称

`qualify_workerd_density.py` 在 `require_cold` 路径中会：

1. 给测试数据库设置 `cold_cache_retention_ms`（默认 1ms）。
2. 请求在线 checkpoint；休眠后再请求 bounded force reclaim。
3. 等待精确 checkpoint 目标进入 cold-only 状态，再同步唤醒并验证数据。

因此 `production-cell` 指运行配置与验收规模，不意味着没有测试策略覆盖。
即使 Engine 的 `RIVET_DEPOT_RECLAIM_INTERVAL_MS=600000`，也不能将这份结果
表述为“生产默认保留期下自然沉降”。Force reclaim 只唤醒正常有界规划器，
不能跳过发布证明、哈希、generation、历史保留或事务预算。

自然沉降时延需要另一份证据：记录实际生效的 StorageProfile/数据库策略，
不设置测试保留覆盖、不请求强制 checkpoint/reclaim，观测正常写入、休眠、
发布及回收。若保留期超过本次允许的测试时长，只能报告未验证；
不能缩短保留期后沿用“默认策略”的结论。长时间 soak 尚未获本阶段执行要求。

## 回收迟缓的诊断顺序

2026-09-07 的 `inv-j8c6qt088m` 已终止。原始回执
`actor-bj-q01-bottomless-production-20260907T035949Z.json` 的 SHA-256 为
`c662a3e033560aa2033324290740748184cb62eb6272fa27e342788eb4835f2a`，
258128 字节，已通过 COS 中转取回并校验，未改写原始回执。
独立 verifier 对 `production-cell` 返回 `verified=true`、`claim_eligible=false`：
48 个对象、6240 次写入、冷读 p99 5474.34ms，清理无错误。
冷态等待约 2781.82 秒，不能作为已完成回收性能优化的证据。

该 TAT 任务仍为 FAILED：数据面完成后，归档器发现生成端未写顶层 `cell`
而拒绝归档。因此后续 HA 链未启动，也不能把这份原始回执当成完整生产资格。
修复是在 `qualify-runtime.sh` 生成阶段写入 `cell` 和 `cell_namespace`，
保留原有应用 `namespace`；归档及恢复端的精确 Cell 校验不放宽。
本地取回不等于不可变证据桶归档成功。

- 先核对 `head_txid` 与 cold watermark；冷端未覆盖和热副本未删除是不同问题。
- 核对实际生效的缓存保留期、访问时间、历史 pin 和对象是否仍有活跃 owner。
- 检查 planner 的批次预算、scan cursor、任务结果及下一次唤醒期限。
- 一个有界批次完成，不等于整个数据库回收完成；也不能据此断言 COS 慢。
- 对精确 invocation 低频跟踪；观察超时不是任务失败，不重复启动验收。

## 升级和无人值守的开放条件

历史通过的 HA、升级或 DR receipt 不能自动替代当前发布的证据。必须通过各自
verifier 的发布绑定、时效和作用域检查。上线判断至少组合以下独立证据：

- 公共 `/v1` 上传、部署、ObjectRef 请求与持久化正确性。
- 负载驱动计算扩缩容和 FDB 扩缩容。
- 精确冷恢复及其实际策略；自然沉降另列已验证/未验证。
- Engine 故障、真实版本变更期间的请求/写入连续性。
- 独立物理恢复、证据持久归档及恢复。
- Argo CD desired-state → 发布 Hook → 失败保护 → 审计的云上闭环。

只有当前审计允许才开放 autonomy；不要通过删除缺失证据要求来消除 bootstrap block。
