# 生产级无人值守就绪审计（Autonomy Audit）

本目录是“让集群在腾讯云供应资源可用条件下持续证明可自愈、并把性能抖动在 Prometheus 上可归因”的执行层。

真实 Argo CD 静态 GitOps 与动态自治控制器的字段所有权见
[`static-release-plane.md`](./static-release-plane.md)。静态发布面不能接管容量字段。
用户可见升级、回滚与数据格式演进遵循
[`user-transparent-upgrade.md`](./user-transparent-upgrade.md)；Argo CD Sync/Pod Ready
不能替代公共 `/v1` Durable Object 连续流量门禁。

## 目标

- 把 **可运行性** 与 **可观测归因** 绑定为一条证据链：
  1. K8s/Operator/FDB/备份健康态；
  2. Prometheus 告警与趋势（含 72h 预警）；
  3. 关键工作流的不可变 receipt（Bottomless、Engine HA、DR）。
- 产出 `autonomy-audit-<cell>-*.json` 作为自动化控制决策入口；失败时先保留证据、再人工修复。

## 执行方式

### 一次性运行

```sh
cd /path/to/rivet/infra/cells/deploy/tencent/fleet/operations
./run-autonomy-audit.sh --once
```

### 持续无人值守（5 分钟采样）

```sh
./run-autonomy-audit.sh \
  --interval-seconds 300 \
  --max-failures 0
```

说明：

- `--once`：只跑一轮并退出。
- `--strict`：将 warning 也视作 failed（适合生产自动化闸道）。
- `--interval-seconds`：采样周期（生产建议 300~900）。
- `--max-failures`：连续失败后退出；`0` 表示不主动停止。

环境变量可覆盖运行上下文：

- `CELL`, `CELL_NAMESPACE`
- `KUBECONFIG_PATH`
- `PROM_NAMESPACE`, `PROM_SERVICE`
- `ENGINE_METRICS_SERVICE`, `RUNTIME_METRICS_SERVICE`
- `CLUSTER_PREFIX`（默认继承 `CELL`；仅工作负载名称前缀不同时覆盖）
- `RUNTIME_RECEIPTS_DIR`, `DR_RECEIPTS_DIR`, `AUTONOMY_AUDIT_RECEIPT_DIR`

`assert-autonomy-control.sh` 将 `AUTONOMY_CONTROL_CELL`（默认继承
`RIVET_CELL_NAME` 或 `CELL`）和 `AUTONOMY_CONTROL_NAMESPACE`（默认继承
`RIVET_CELL_NAMESPACE` 或 `CELL_NAMESPACE`）视为安全边界。同一目录存放多个 Cell
的 decision 时只选择当前 Cell/namespace 的最新文件；显式传入的
`AUTONOMY_CONTROL_FILE` 也必须匹配，不能用另一个 Cell 的 `allow` 放行当前操作。

## 证据链定义（单次审计要么通过要么告警）

1. **K8s/FDB/备份门**
   - FDB available / healthy / fullReplication / reconcileAligned
   - `foundationdbbackup` running + restorable
   - Engine、runtime 的目标副本与 ready、副本数恢复
   - Engine/runtime 与 FDB 三个 zone 分散

2. **Prometheus 门**
   - 查询所有 `ALERTS{alertstate="firing"}`（Actor 命名空间）；
   - 核验 `engine_targets >= 3`、`runtime_targets >= 3`；
   - 采样关键吞吐与容量趋势（backlog、headroom、队列利用率、内存增长等）。

3. **Receipt 门**
   - 最近一次 `-bottomless-production-*.json` 必须可读取、未过期、`verify_bottomless_receipt.py` 通过；
   - 最近一次 `-engine-ha-*.json` 通过且未过期；
   - 至少有一份 DR receipt（如有 DR 试跑）可追溯。

4. **最终判定**
   - 任何 failure 列表非空 => `verdict=failed`；
   - 无 failure 但有 warning => `verdict=warning`；`--strict` 下转为 `failed`。

## 告警归因（快速应对矩阵）

| 告警根类 | 典型告警 | 定位动作 |
|---|---|---|
| foundationdb | `ActorFDB*` | 优先查看 FoundationDB cluster/broadcast/backup 状态与 Operator reconcile 流程；确认 full-replication 与可恢复性。 |
| backup | `ActorFDBBackup*` | 检查 backup agents、restoreability、lag、备份路径网络。 |
| storage | `ActorFDBStorage*`, `ActorCBSAttachmentReferencesMissingNode`, `ActorFDBWriteDebtBackpressure` | 检查 FDB 存储 KV headroom 与 CBS 附着/脱挂状态；评估写入放行与缩限策略。 |
| workerd | `ActorWorkerd*` | 查看请求队列/拒绝/超时指标，必要时临时限流到 runtime；确认单 Pod 重启后指标恢复。 |
| engine | `ActorEngine*` | 确认 Engine 指标 target/副本/跨 AZ 均衡；避免在未完成拓扑恢复时再次 rollout。 |
| runtime | `ActorRuntime*`, `ActorContainer*` | 关注 Pod 就绪、zone 分布、重启与 OOM，避免把故障归因到应用层。 |
| cold_tier | `ActorColdTier*`, `ActorCompaction*`, publish/reclaim 指标 | 关注 backlog、publish/reclaim throughput、失败率、p95/停滞，结合 capacity 预测门判断是否应降噪（write debt/cold 并发/节流）。 |

## 与无人值守运行方式的关系

- `autonomy_audit.py` 仅产出证据，不做主动变更；
- 自动化调度只应依据 `verdict=passed` 放行高风险动作，`warning` 或 `failed` 仅进入“降级/排障”路径；
- 所有关键动作（Rollout、Qualification、灾备演练）仍须独立 workflow 和人机确认（或安全策略中的预定义控制器）。

### 控制化解读（可以直接喂给编排器）

每轮审计会产出两份文件：

- `autonomy-audit-<cell>-*.json`：采集证据
- `autonomy-control-<cell>-*.json`：`run-autonomy-governance.sh` 通过策略得出的控制结论

每份 control 收据必须同时记录 `source_receipt` 和
`source_receipt_sha256`。所有受保护动作在解释 allow/degrade/block 之前都会重新读取并
校验源 audit 的精确字节；本地路径被替换、丢失或 hash 不匹配时一律视为 invalid。
因此 control 不是一个脱离证据链的可复制布尔开关。

Audit 输出使用严格 JSON。非有限诊断值采用字符串 `"+Inf"`、`"-Inf"`、`"NaN"`，
不输出非标准数字 token `Infinity`/`NaN`，也不把未知值填成零。阈值判定仍使用编码前的
内部数值；Prometheus scalar 的 NaN 不计为有效样本，全为空时保留 `value=null` 并触发
既有缺指标门禁。平稳增长下的无限 ETA 不表示缺指标。有限值收据保持原编码字节。
control 的 SHA 始终绑定实际写出的 audit 字节；既有原始证据不可重新编码或改 hash。
本地回归入口为 `python3 -m unittest discover -s . -p 'test_audit_json.py'`，覆盖真实
HTTP collector、真实 evaluator CLI 与已归档原生收据，不要求重建 runtime 镜像。

严格 audit 生成 `allow` 后，由唯一入口发布当前 release 的资格并开放 Cell：

```sh
CELL=actor-bj-q01 \
CELL_NAMESPACE=actor-fdb-cell-system \
KUBECONFIG_PATH=/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig \
  ./publish-qualified-release.sh /var/lib/actor/autonomy/decisions/autonomy-control-actor-bj-q01-<timestamp>.json
```

该入口持有全局高风险操作锁，复核 control→audit SHA 链、实时 Engine/Host
release binding 和动态 Host 容量稳定性，先创建不可变证据 ConfigMap，再原子更新
reporter 的资格环境；只有观察到 release-bound `RivetCellReport` 后才以 Cell UID 和
resourceVersion CAS 将 `desiredState` 改为 `Ready`。任一步失败都不会绕过
`readyForPlacement` 门禁。最终 receipt 还会重新读取并绑定 Cell UID、当前 generation、
status observedGeneration 与 profile digest，并采用同目录硬链接原子发布；因此 Cell 在
开放与落盘之间被替换或状态变旧时不会留下伪通过证据。

文件名必须包含 Cell ID；否则多个 Cell 在同一秒运行时会覆盖彼此的证据。消费端仍会校验
JSON 内的 `cell` 和 `namespace`，文件名隔离与内容绑定缺一不可。

建议控制器按 `control` 字段执行：

| control | 意义 | 默认处理 |
|---|---|---|
| `allow` | 证据合规 | 允许 rollout/qualification/扩缩容/DR 演练按计划执行 |
| `degrade` | 部分性能或偶发告警 | 暂停“放大类”动作（如新增 Actor 归属、扩缩容、非紧急发布）；优先做限流与归因 |
| `block` | 基线失稳 | 阻断高风险动作；触发人工处置流程；保留 receipt 证据 |

当出现 `prometheus_critical_alerts*`、`fdb_not_in_three_zones`、`backup_restorable=false`、`engine_targets<3`、`runtime_targets<3` 等信号时，进入 `block`。

### 一次性闭环验证建议

## 后续建议（下一步打通闭环）

- 把 `run-autonomy-audit.sh --strict --interval-seconds 300 --max-failures 0` 部署为 systemd 持续任务；
- 直接执行：

  ```sh
  cd /opt/rivet/cells/operations
  ./run-autonomy-audit.sh --interval-seconds 300 --strict --max-failures 0
  ```

  或安装严格绑定单个 Cell 的 systemd 审计。安装器不再带任何默认 Cell；
  `CELL`、kubeconfig 和资格模式必须显式给出，避免新环境静默继续审计退役 Cell：

  ```sh
  CELL=actor-bj-q01 \
  KUBECONFIG_PATH=/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig \
  AUTONOMY_REVIEWED_SOURCE_LINK=/var/lib/actor-build/deploy/actor-bj-q01-current \
  AUTONOMY_QUALIFICATION_MODE=autoscaling-cell \
  RUNTIME_RECEIPTS_DIR=/data/actor-qualification/receipts \
  DR_RECEIPTS_DIR=/data/actor-qualification/receipts \
  ./install-autonomy-systemd.sh
  ```

  安装器必须从该链接当前指向的审核树执行。服务每次启动只解析一次原子发布链接，
  捕获不可变物理树后再执行同一树中的治理脚本、策略和 verifier；发布并发发生时，
  本次审计完整使用旧树或新树，不会混用两版。audit receipt 与由它派生的 control
  receipt 都记录同一个 source revision、完整 manifest SHA-256 和物理 target；collector
  或 policy evaluator 失败时生成的 fail-closed receipt 也保留该身份。安装会立即同步运行一次 audit，并要求
  生成一份 Cell/namespace 精确匹配的新 control receipt 后才返回成功。
  unit 不再包含 `actor-bj-k01` fallback，也不会在 env 文件缺失时悄悄启动。
  安装本身也持有 fleet operation lock，不能与 Bottomless、Engine HA、DR 或 rollout 并行。

- 将 `run-autonomy-audit.sh`/`run-autonomy-governance.sh` 的输出接入统一日志（例如 Loki/ES）；
  使用控制决策文件中的 `matched_rules` 做“谁拦了动作”的归因追踪。
- 新增告警触发器（与 `autonomy-policy.json` 对齐）：
  - 首次出现 `prometheus_critical_alerts_exist` 时，立刻提权为 `failed`；
  - 单 cell 连续 3 次 `warning` 可触发“放量减速”动作（降写入、限速或封网降级）。
- 保持 Prometheus 告警与该审计接收同一处证据目录（便于审计追溯）。

## 一次性无人值守闭环（推荐顺序）

在每次高风险动作前后，建议按这个顺序执行：

1. 先做独立证据采样与控制判定

```sh
cd /path/to/rivet/infra/cells/deploy/tencent/fleet/operations
./run-autonomy-governance.sh \
  --receipt-dir /var/lib/actor/autonomy/receipts \
  --policy ./autonomy-policy.json
```

2. 读取本次控制决策并断言可执行

```sh
AUTONOMY_CONTROL_FILE=/var/lib/actor/autonomy/decisions/$(ls -1t /var/lib/actor/autonomy/decisions/autonomy-control-* | head -n 1) \
  ./assert-autonomy-control.sh
```

3. 放行清单：
- `allow`：进入 rollout/qualification/扩缩容/主被动 DR 节点级演练
- `degrade`：允许只读演练、告警归因、容量降压，但暂停无界限扩张
- `block`：禁止一切高风险动作，触发人工修复

4. 动作完成后补跑一次 `run-autonomy-audit.sh --once --strict --receipt <新路径>`，并保存 receipt 与 control 文件与 rollout/qualification 一起归档。

```sh
mkdir -p /var/lib/actor/autonomy/audit-rounds
./run-autonomy-audit.sh --once --strict --receipt /var/lib/actor/autonomy/audit-rounds/after-release-$(date -u +%Y%m%dT%H%M%SZ).json
```

## 受控动作周期（推荐给编排器）

不要把“先读一次 allow 文件，再启动长操作”当作互斥。以前的短命检查进程会在实际
rollout 开始前释放锁，两个工作流仍可能交叉。统一使用：

```sh
./run-autonomy-ops-cycle.sh \
  --state-dir /var/lib/actor/autonomy \
  --action ../runtime/qualify-engine-ha.sh
```

它在同一把 `flock` 下执行 `pre-audit -> policy -> action -> post-audit`，生成一个
`autonomy-ops-cycle.json`。默认没有 `--action`，因此是只读审计。传入 action 时：

- 仅接受仓库 `fleet/` 下可执行文件；不记录 action 参数或日志正文，避免把 Secret 写入 receipt；
- pre-control 必须为 `allow`；`degrade`/`block` 只生成证据并拒绝动作；
- 现有 rollout、Bottomless、Engine HA、autoscaling 与两类 DR 入口也会自动进入同一把锁；
- action 完成后，post-control 仍必须 `allow`，否则周期失败并保留完整现场。

当前 release 的验证 receipt 缺失或过期时，普通高风险动作仍为 `block`。只有
`runtime.qualify`、`runtime.engine-ha` 和两类 DR qualification 可在
`AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1` 下恢复证据，而且 control receipt 必须满足：
失败项**全部**是 `latest_*_receipt_*`/`dr_receipt_*`，没有 warning、没有实时健康失败。
这不是通用 bypass；rollout、扩缩容和任意真实退化仍不可放行。
首次资格验证允许一个更窄的引导态：仅 Runtime、Engine HA、FDB autoscaling、修复性
controller release 与 DR
证据恢复 workflow 可在 FDB
`ObserveOnly`、9/9/9 目标完全一致、卷 GC 仍为 `ObserveOnly` 且保留期不少于 30 天时生成
缺失证据。控制器会读取并绑定 control 的 source audit；任何其他 failure/warning、状态不一致
或 source audit 不可读仍然阻断。通过 FDB 9→12→9 云门禁后才可把 profile 提升为
`Automatic`。

自动扩缩容 Cell 使用显式的
`AUTONOMY_QUALIFICATION_MODE=autoscaling-cell`。该模式要求同一 Cell 的：

- `production-cell` Bottomless receipt；
- 带 immutable release binding 的 100 Agent/s arrival、Host/node 扩容及串行 drain receipt；
- 同一 runtime image 的 Engine HA receipt；
- 通过官方 verifier 的 FDB 9→12→9 receipt；
- 通过独立 verifier、目标 runtime 与当前 release 精确一致的公共 `/v1` 用户无感升级 receipt；

跨 receipt 只比较 runtime image digest 与 manifest hash；Pod UID 只在一次
qualification 内部要求前后完全一致。否则 Engine HA 按设计替换 Pod 后会错误地使
Bottomless 证据失效。DR 还必须绑定当前 source FDB UID；同名重建不能继承旧
恢复资格。每类 qualification 的最新终态尝试（成功或失败）是权威结果，最新失败
不会回退使用更老的成功 receipt。缺少任何一项仍然 fail closed。

新 Cell 首次开放 placement 使用显式的
`AUTONOMY_QUALIFICATION_MODE=initial-cell`。它要求与当前 immutable release 绑定的
`production-cell` Bottomless 和 Cell-scoped Engine HA，并继续执行
同一套 FDB、备份、三可用区、Runtime、Prometheus 与静态 release 现场检查；但不会要求
一个尚未接收用户流量的新 Cell 已经存在 100 Agent/s、FDB 9→12→9、用户无感升级和语义
失败回滚的历史 receipt。首次审计通过后仍必须由 operator 显式执行 qualification
publication CAS，不会自动把 Cell 改为 `Ready`。`autoscaling-cell` 仍是已开放 Cell 的持续
运营资格，不可用 `initial-cell` 替代。

物理恢复不再属于 `initial-cell` 或 `autoscaling-cell` 的 admission
门禁。它保留为存储格式、备份实现或恢复实现发生变化时由 operator 显式触发的独立
DR 演练；缺失、陈旧或失败的物理恢复 receipt 不阻塞 Cell placement。

持续 systemd 任务仍只做“审计与策略生成”，不自动猜测一个变更动作。实际扩缩容由
RivetCell/FDB Operator 的已审核策略驱动；需要执行计划性高风险脚本时由上述周期显式传入。

## 指标覆盖门

严格审计不仅检查 Prometheus target 数，还检查低基数的 cold-tier 归因族是否真的可查询：
queue、backlog objects/bytes、jobs、objects、bytes、duration、phase duration，以及 FDB
headroom、runtime queue、RSS 预测。缺失会形成
`prometheus_attribution_metrics_missing=...`；在 `--strict` 模式下它阻断高风险动作，
而不是把“没有数据”误判为“性能很好”。
