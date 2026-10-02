# 北京 Cell 规模化资格门

状态：**harness 已落地，云上结果尚未生成；不得据此开放 production placement**

本资格只允许在 `ap-beijing` 的专用 `actor-bj-*` Cell 执行。笔记本只做代码、单测和远程
编排，不运行 1M/2K/4K 负载。每个脚本都应读取云主机上的 `/etc/actor/cell-id`；不要通过
伪造本地文件绕过执行地点闸门。

## 1. 固定物理布局

- FDB：独占 Cell 的 6 台 CVM，三 AZ `2/2/2`；此形状只做当前资格，最终复合故障目标仍是
  `3/3/3`。
- runtime：三 AZ 各一台。`runtime-1` 运行 Engine + workerd，`runtime-2/3` 运行
  workerd-only，通过 VPC 私网连接 primary Engine。
- 调度：至少两个 runner pool name；资格流量按 pool round-robin。通过条件同时要求至少两个
  **实际 workerd host registry** 出现 Actor，不能只看配置里存在两个名字。
- COS：cold 与 FDB backup 是两个新建、普通、非 multi-AZ bucket；从创建起保持
  `NeverEnabled`，不允许 `Enabled` 或 `Suspended`。

Terraform 的 `moved` block 保留原 `runtime-1`，只新增北京 7/8 区 runtime CVM。先审阅
`terraform plan`，不得接受任何 FDB/CBS/COS destroy 或 replace。

三个 host 使用同一组已校验 release artifacts。primary 安装时设置
`RUNTIME_ROLE=engine-and-workerd RUNNER_POOL_NAME=workerd-a`；另外两台设置
`RUNTIME_ROLE=workerd-only`、私网 `ENGINE_ENDPOINT/ENGINE_HEALTH_URL`，并分别加入
`workerd-a`/`workerd-b`。installer 会在 workerd-only host 上禁用本地 Engine；pool init 不再
依赖本地 Engine unit。当前跨主机连接仍由 VPC/security-group 边界保护，Engine API 的正式
认证与 TLS 是独立的 production security gate，不能把 `dev` token 当成安全控制。

## 2. COS 无版本迁移门

旧的 versioned/multi-AZ bucket 不能原地变成 `NeverEnabled`。本项目尚未上线，因此不做兼容
分支：创建 `*-nv1-*` 空 bucket，停止旧 Cell 写入，用新 bucket 和空测试 FDB 重新资格；旧
bucket 在 exact inventory、备份恢复和 retention 证明完成前保持只读，不把它 import 到新
Terraform resource address。

在北京 runtime 上用环境/实例角色提供 COS 凭据，然后执行：

```sh
python3 ../verify_cos_no_versioning.py \
  --cell-id actor-bj-b01 \
  --execution-site-file /etc/actor/cell-id \
  --cold-bucket actor-depot-cold-prod-bj-b01-nv1-1388575217 \
  --backup-bucket actor-fdb-backup-prod-bj-b01-nv1-1388575217 \
  --output /var/log/actor-qualification/cos-no-versioning.json
```

空 versioning response 才表示 `NeverEnabled`；`Enabled` 和 `Suspended` 都 fail closed。脚本也
验证北京 location 与默认 SSE-COS AES256。普通非 multi-AZ 属性由新建 Terraform resource
和禁止 import 的资源合同保证。Terraform Provider 1.83.11 会把 false 更新实现成
`Suspended`，且 Read 无法区分 `Suspended` 与 `NeverEnabled`，所以 HCL 刻意不声明
`versioning_enable`；上面的远端空 document 收据才是准入证据，Terraform state/output 不是。

## 3. 1M dormant Actor 与真实 FDB footprint

只能使用真实 idempotent Actor API。Actor key 的 SHA-256 shard 位于递增 ordinal 前面；本地
SQLite manifest 是唯一清理清单，禁止 list namespace 后批量删除。

在空 Cell、Engine 全停时先取 baseline。离线命令只初始化 UDB/FDB，不启动 Gasoline worker，
因此消除了“扫描接口需要 Engine 活着、Engine heartbeat 又会修改 Gasoline key”的矛盾：

```sh
systemctl stop actor-rivet-engine.service
python3 ../qualify_fdb_footprint.py \
  --engine-bin /opt/actor/rivet-workerd/current/bin/rivet-engine \
  --config /etc/actor/rivet-workerd/config.jsonc \
  --cell-id actor-bj-b01 --execution-site-file /etc/actor/cell-id \
  --output /var/log/actor-qualification/fdb-footprint-baseline.json
systemctl start actor-rivet-engine.service
```

仍在空 Cell 时记录 FDB application range baseline。它的 verdict 是 `baseline`，不是资格通过：

```sh
python3 ../qualify_fdb_distribution.py \
  --cell-id actor-bj-b01 --execution-site-file /etc/actor/cell-id \
  --cluster-file /etc/actor/rivet-workerd/fdb.cluster --location-only \
  --output /var/log/actor-qualification/fdb-location-baseline.json
```

创建、打开一次并 sleep 1M Actor；10K probe 在完整 1M 基数存在时分别测 dormant reopen、
new create 和 exact delete p99：

```sh
python3 ../qualify_dormant_actors.py populate \
  --cell-id actor-bj-b01 --execution-site-file /etc/actor/cell-id \
  --runner-name workerd-a --runner-name workerd-b \
  --target-actors 1000000 --probe-actors 10000 \
  --manifest /var/lib/actor-qualification/dormant-1m.sqlite
python3 ../qualify_dormant_actors.py probe \
  --cell-id actor-bj-b01 --execution-site-file /etc/actor/cell-id \
  --runner-name workerd-a --runner-name workerd-b \
  --target-actors 1000000 --probe-actors 10000 \
  --manifest /var/lib/actor-qualification/dormant-1m.sqlite \
  --output /var/log/actor-qualification/dormant-1m.json
```

再次 clean stop Engine，执行两个完整的有界分页 pass，并计算 application/Depot/Gasoline 的
keys、raw bytes、delta 和 per-Actor 固定成本：

```sh
systemctl stop actor-rivet-engine.service
python3 ../qualify_fdb_footprint.py \
  --engine-bin /opt/actor/rivet-workerd/current/bin/rivet-engine \
  --config /etc/actor/rivet-workerd/config.jsonc \
  --cell-id actor-bj-b01 --execution-site-file /etc/actor/cell-id \
  --baseline /var/log/actor-qualification/fdb-footprint-baseline.json \
  --actor-count 1000000 \
  --output /var/log/actor-qualification/fdb-footprint-1m.json
systemctl start actor-rivet-engine.service
```

每个 FDB transaction 最多 1000 rows；完整计量是 O(keys)，但不会形成一个超大事务。两个
pass 的 totals 与 transcript hash 必须完全相同。逻辑 key/value bytes 不包含 FDB 三副本、
Redwood/B-tree、mutation log 或文件系统放大，不能拿它直接算磁盘采购量。

随后用 exact manifest 删除全部 1M Actor；真实 2xx delete 与“远端已删、本地 manifest 尚未
提交”的幂等 404 分开计数，404 不进入 delete p99。删除后等待 maintenance drain，再停
Engine 做第三次稳定 footprint；它衡量 Gasoline history/tombstone 和 Depot metadata 的残留，
不能只看 Actor API 已经 404 就宣称容量回收完成：

```sh
python3 ../qualify_dormant_actors.py cleanup \
  --cell-id actor-bj-b01 --execution-site-file /etc/actor/cell-id \
  --runner-name workerd-a --runner-name workerd-b \
  --target-actors 1000000 --probe-actors 10000 \
  --manifest /var/lib/actor-qualification/dormant-1m.sqlite \
  --output /var/log/actor-qualification/dormant-1m-cleanup.json
systemctl stop actor-rivet-engine.service
python3 ../qualify_fdb_footprint.py \
  --engine-bin /opt/actor/rivet-workerd/current/bin/rivet-engine \
  --config /etc/actor/rivet-workerd/config.jsonc \
  --cell-id actor-bj-b01 --execution-site-file /etc/actor/cell-id \
  --baseline /var/log/actor-qualification/fdb-footprint-baseline.json \
  --actor-count 1000000 \
  --output /var/log/actor-qualification/fdb-footprint-post-delete.json
systemctl start actor-rivet-engine.service
```

首次北京结果需要同时冻结 active footprint 和 post-delete residual 的 keys/bytes/Actor 上限；
后续 release 超限即关闭 placement，不能用“GC 将来可能会跑”豁免。

## 4. Bottomless、冷读 SLO 与恢复风暴

在北京云内资格执行机上使用新 release 运行 runtime gate；不能沿用 2026-08-16 的历史冷读
收据，也不能从笔记本网络测产品 SLO：

```sh
QUALIFICATION_RECEIPT=/var/log/actor-qualification/bottomless-cold-recovery.json \
  ./runtime/qualify-runtime.sh
```

默认只把 1 个 Actor 填充到 12 MiB，其余 95 个保持小库，因此这是一项快速 release gate，
不是容量压盘。通过条件必须同时成立：

- api-peer 对 exact branch 报告 `logical_storage_limit_bytes=null`，至少一个资格库的逻辑尺寸
  必须超过 12 MiB FDB 瞬时写债上限（不只是超过 10 MiB 目标），而当前写债已回落且不超过
  12 MiB admission；这才直接证明写债水线不是逻辑库容量上限；
- 首次 online checkpoint 返回冻结的 target watermark 后，96 个 Actor 仍全部接受真实写入；
  最终 checkpoint 处理期间仍全部可读。checkpoint 只切分 hot tail，不能关闭 Actor admission；
- 先证明 96 个 Actor 仍在线且 ownership 精确，再 sleep 并等待 host/bridge registry 回到基线；
  释放 runtime-local hot-shard pin 后，96 个 exact branch 的 cold watermark 必须覆盖 head，
  cold ref/publish/PITR 均存在且 staged/hot SHARD 均为零；资格脚本不调用 COS `LIST`；
- 同步 wake 的 p95 不超过 10 秒、p99 不超过 20 秒、max 不超过 30 秒，所有 generation
  严格前进且 SQL 值/12 MiB payload 精确不变；
- 三个 host 的 16-running/64-waiting gate 必须分别产生正 queued delta，peak 不能越过各自
  in-flight/queue 上限；完成后 in-flight/queued 为零，reject/timeout delta 为零，且三个 host
  的 admission 配置完全一致；
- 收据保留 exact Actor manifest hash、Bottomless state、分阶段 latency、每 host admission 计数
  和 cleanup 后 `0/0` registry；验收前后的 Engine/host runtime digest、manifest hash 和 3+3
  Pod UID 必须完全相同，期间发生任何 rollout 都使回执失效。

脚本完成后必须再通过 fail-closed 收据审核；只有 `production-qualification` 会返回
`claim_eligible=true`：

```sh
python3 runtime/verify_bottomless_receipt.py \
  --profile production \
  /var/log/actor-qualification/bottomless-cold-recovery.json
```

`e2e-fast` 即使完全通过也只能返回开发证据，不能用于正式 Bottomless 宣传或 Cell 准入。

超过 10 MiB 只证明逻辑容量与 FDB 瞬时写债解耦。正式的长期成本/容量曲线必须另做更大库、
持续增量、冷热命中率和 COS 请求费用测试；不得把 12 MiB 快速 gate 宣称为最大已测容量。
达到 12 MiB 瞬时写债安全线时，VFS 必须在同一个 head fence 内透明重试并把压力表现为写延迟；
不得把 `write_backpressure` 作为 SQLite 错误暴露给 Actor，也不得靠停服等待沉降。

## 5. 2K/4K active 与 RSS 收敛

三台 runtime 分别连接两个 pool；host stats 只监听 loopback，通过预先建立的 SSH/TAT tunnel
提供给 harness。先 2K、再 4K，每档至少 8 个完整 cycle，前两个作为 allocator/cache warmup：

```sh
python3 ../qualify_rss_cycles.py \
  --cell-id actor-bj-b01 --execution-site-file /etc/actor/cell-id \
  --actors 2000 --runner-name workerd-a --runner-name workerd-b \
  --host-stats b6=http://127.0.0.1:28081/v1/sqlite/stats,WORKERD_B6_TOKEN \
  --host-stats b7=http://127.0.0.1:28082/v1/sqlite/stats,WORKERD_B7_TOKEN \
  --host-stats b8=http://127.0.0.1:28083/v1/sqlite/stats,WORKERD_B8_TOKEN \
  --min-active-hosts 3 \
  --process engine="$(pgrep -xo rivet-engine)" \
  --process workerd="$(pgrep -xo workerd)" \
  --process envoy="$(pgrep -xo rivet-workerd-host)" \
  --output-dir /var/log/actor-qualification/rss-2k-cycles \
  --output /var/log/actor-qualification/rss-2k.json
```

把 `--actors` 改为 `4000` 重跑。primary 证明 Engine 与本机 runtime；随后在另外两台 runtime
各跑同样周期以证明各自 workerd/Envoy RSS。每轮必须完成 active → registry baseline(cold)
→ wake 且 generation 前进 → exact delete → registry baseline。判定使用 warmup 后 retained RSS
的线性斜率与 plateau span，并保留 `/proc/status`、`smaps_rollup`、cgroup-v2 分解。一次从
91 MiB 涨到 422 MiB 不能直接叫泄漏；连续周期不收敛才 fail。

active、cold、wake、delete 四个边界还会用 4K 上限的 exact registry lookup 逐 Actor、逐
generation 对账；同一 generation 落在两个 host、host/bridge registry 不一致、或 aggregate
计数恰好相等但成员发生置换，都会 fail。不能只靠三个 host 的总计数证明隔离正确。

## 6. FDB range/hotspot 与 maintenance drain

在 2K/4K 持续读写期间并行运行：

```sh
python3 ../qualify_fdb_distribution.py \
  --cell-id actor-bj-b01 --execution-site-file /etc/actor/cell-id \
  --cluster-file /etc/actor/rivet-workerd/fdb.cluster \
  --baseline-location /var/log/actor-qualification/fdb-location-baseline.json \
  --output /var/log/actor-qualification/fdb-distribution-4k.json
```

它读取完整 application key range 的 `getlocation`，要求相对空 Cell baseline 至少新增 16 个
ranges、最终至少 32 ranges、6 个 storage server、3 个 unique teams，range ownership 最大
share 不超过 35%；同时要求 input/read/mutation 三类 storage-role 指标都出现非零负载，并
逐样本检查最大 share。idle cluster 或预先手工 split 后没有继续增长都不能通过热点证明。

maintenance drain 使用四类可分治的 durable index：hot dirty branch、64-shard hot job、
64-shard cold publish job、分片 GC due queue；reconciliation 只扫每个 live Envoy 自己的精确
prefix。永久性的 `CMPC/root`、publish/coverage 元数据不是 backlog，绝不能要求整个 CMPC
分区为零。future-retained GC rows 受 7 天 recovery window 保护，也不应为了图表归零而删除。

```sh
python3 ../qualify_backlog_drain.py \
  --pool-name workerd-a --pool-name workerd-b --min-envoys 3 \
  --interval-seconds 1 --drain-timeout-seconds 3600 \
  --output /var/log/actor-qualification/backlog-drain.json \
  -- python3 ../qualify_workerd_density.py ...
```

故障场景必须真的制造并观察全部 lane（默认不会跳过 GC）：持续 commit 跨过 hot threshold；
允许 hot stage 与 COS publish 堆积；断开一个 Envoy 后发 durable lifecycle command 再恢复；
删除 exact manifest 中的 Actor 形成 branch GC。7 天 production recovery window 下的 cold GC
不能靠等待几分钟伪造为 due：要么提前 7 天预置本次 exact manifest，要么在另一套空资格 Cell
用相同 release、显式短窗口做 due-queue 执行测试，并把 production Cell 的 future-retained
收据并列保存。输入停止后，hot dirty/job、cold publish、due GC 和 reconciliation 连续三个
sample 为零才通过；future-retained cold GC 单独记录，不计作 due backlog。

## 7. 收据与开放条件

收据必须包含 release SHA、Cell ID、FDB cluster identity hash、COS bucket 名、命令 argv hash、
manifest hash 和起止时间。任何脚本 `passed` 只表示自身不变量成立，不自动批准产品 p99 SLO。
create/open/delete p99 的具体上线预算需要在跑出北京分布后冻结；超过冻结预算必须关闭新
placement。

installer 会写 `/etc/actor/rivet-workerd/release.json`。上面各节的命令只是 child payload；
正式执行时去掉 child 自己的 `--output`，统一放在 receipt runner 的 `--` 后面：

```sh
python3 ../run_qualification_receipt.py \
  --cell-id actor-bj-b01 --execution-site-file /etc/actor/cell-id \
  --release-manifest /etc/actor/rivet-workerd/release.json \
  --cluster-file /etc/actor/rivet-workerd/fdb.cluster \
  --cold-bucket actor-depot-cold-prod-bj-b01-nv1-1388575217 \
  --backup-bucket actor-fdb-backup-prod-bj-b01-nv1-1388575217 \
  --cos-verification-receipt /var/log/actor-qualification/cos-no-versioning.json \
  --output /var/log/actor-qualification/SEALED-RECEIPT.json \
  -- python3 ../qualify_fdb_distribution.py ...
```

runner 只保存 argv SHA-256，不复制可能含敏感值的参数；它把 child 的 passed JSON、三个
artifact SHA、完整 FDB cluster-file SHA（不泄露 cluster secret）、两个 exact bucket 以及
COS NeverEnabled 收据 SHA 绑定成一个自校验 envelope。没有这个 envelope 的裸 JSON 只能算
调试输出，不能用于开放 placement。

workerd-only host 不复制 FDB cluster secret；它运行本机 RSS gate 时改用 primary sealed receipt
中的 `--cluster-identity-sha256 <64-hex>`，不得为了收据把 `fdb.cluster` 分发到计算节点。

本轮只有代码和离线单测结果，尚无上述北京云收据。没有新的有效北京访问凭据/委托前，
不得把这些 gate 在状态表里改成“已通过”。
