# 冷存储物理账本与删除准入

`ColdStorageAccounting` 是 Cell 级持久事实，存放在 FDB 独立子空间。Grafana 只是观察
窗口，不能参与删除判定，也不能作为恢复事实。

## 账本语义

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `live_bytes/objects` | 当前水位 | 已由原子 publish marker 暴露给读路径的 immutable cold object |
| `retired_bytes/objects` | 当前水位 | 已从读路径移除、仍受恢复窗口或备份围栏保护的对象 |
| `delete_issued_bytes/objects` | 当前水位 | FDB 已持久化 exact-key 删除意图，但删除完成事务尚未提交 |
| `orphan_bytes/objects` | 当前水位/子集 | 未发布对象；进入删除后仍保持为 orphan，因而不能与前三类求和 |
| `deleted_bytes_total/objects_total` | 累计值 | 已完成 exact-key 删除协议的对象，不是 COS 账单差值 |
| `fdb_authoritative_bytes` | 当前逻辑水位 | Depot write-debt 覆盖的权威 FDB key/value payload |
| `fdb_cache_bytes` | 预留 | 尚未接入精确 hot-shard cache 分类，当前保持零 |
| `fdb_metadata_bytes` | 预留 | 尚未接入精确 metadata 分类，当前保持零 |

每个字段按 database branch 稳定散列到 64 个 little-endian `i64` FDB key，并使用 atomic
add。这样 publish、retire、delete issue、delete completion 与对应账本 delta 在同一事务中
提交，同时不会把整套 Cell 串行化到一个 key 热点。读取端一次 range scan 聚合为 Cell
水位；任何聚合负数都会 fail closed。

## 对象生命周期

```text
COS PUT
  -> FDB publish: live += object
  -> FDB retire: live -= object; retired += object
  -> FDB delete issue: retired -= object; delete_issued += object
  -> COS DELETE exact key
  -> FDB complete: delete_issued -= object; deleted_total += object
```

失败上传由 durable upload intent 拥有 exact key。进入清理时同时标记 `orphan` 与
`delete_issued`；完成后同时清零两个当前水位。整分支 GC 会先把 branch-local ref 转移到
branch-external tombstone，并携带 `size_bytes` 和 accounting state，因此清空分支 FDB 后仍能
精确重放。

COS 操作不能与 FDB transaction 原子提交。协议依靠 immutable exact key、持久状态机和
幂等 DELETE 覆盖以下窗口：

- PUT 成功但 publish 事务或响应丢失；
- delete issue 提交后 DELETE 失败；
- DELETE 成功但 completion 事务或响应丢失；
- 分支删除期间 Engine 重启。

## Grafana 聚合

每个 Engine 都会每 15 秒从 FDB 读取同一份 Cell 账本并暴露 Prometheus gauge。多个 Engine
副本的值相同，因此聚合必须使用：

```promql
max by (cell, class) (rivet_sqlite_cold_storage_accounting_bytes)
```

禁止使用 `sum by (cell, class)`，否则副本数会被错误地乘进存储量。

## 删除授权、receipt 与 inventory

物理删除不再由进程配置布尔值控制。FDB 中缺失 `ColdGcPolicy` 等价于关闭；修改必须带
`expected_revision` CAS。启用时 policy 会绑定当前 backup policy fingerprint，且要求存在
新鲜、匹配的 backup fence。恢复策略 rebind 后，旧 policy 立即失效。

```sh
engine depot cold-gc-policy-show
engine depot cold-gc-policy-set --expected-revision 0 --state enabled \
  --confirm-irreversible-exact-key-deletion
engine depot cold-gc-policy-set --expected-revision 1 --state disabled
```

`ColdGcPolicy` 同时持久化 grace period、单 Engine 删除并发、每批对象数、指数退避和
dry-run。正式默认值不能仅凭配置修改开启。先运行本地 `qualify-cold-gc.sh`，再复制并填写
`storage-profiles/cos-gc-qualification.example.json`，用一个独立 COS bucket 执行
`qualify-real-cos-cold-gc.sh`；两个 receipt 都通过后，才允许把正式 StorageProfile 的
`cold_gc.enabled` 改为 true。

grace period 采用单调安全语义：对象 tombstone 中保存创建时的 deadline；当前 policy
只能将该 deadline 延后，不能将既有对象的删除时间提前。因此延长 grace 会保护已经 retired
的对象，而缩短 grace 只影响之后新建且不受更长历史 deadline 约束的 tombstone。

`enabled=true,dry_run=true` 是合法的预演阶段：它验证备份绑定、grace 和待删选择，但仍禁止
发出物理 DELETE。只有 `enabled=true,dry_run=false` 同时成立时才进入真实删除。

每次完成删除时，Engine 在更新 `deleted_total` 的同一 FDB transaction 写 immutable receipt，
记录 exact key、对象身份、字节数、原因、policy revision、backup fingerprint、restore floor、
fence 有效期和 issue/complete 时间。上传失败产生的从未发布对象使用独立的
`unpublished_upload_cleanup` 授权原因，不冒充备份围栏删除。

```sh
engine depot cold-delete-receipt-show --object-key '<EXACT_KEY>'
```

只读 inventory 命令按 COS continuation token 分页，并将物理对象分类为
`live/retired/delete_issued/orphan/deleted_but_present/unknown/invalid_key/size_mismatch`：

```sh
engine depot cold-inventory-scan --page-limit 250
engine depot cold-inventory-scan --page-limit 250 --cursor '<NEXT_CURSOR>'
```

输出固定包含 `mutates_storage=false`。未知对象和 `deleted_but_present` 只报告，不自动删除；
inventory 结果不是 ownership proof，也不会直接修改物理账本。

## 尚未打开的生产闸门

代码具备 policy、receipt 和 read-only inventory，但生产 Cell 的 policy 仍必须保持缺省关闭，
直到以下条件全部完成：

1. 对生产 bucket 跑完无间断的完整 inventory，并保存每页 receipt；
2. 自然冷降、上传响应丢失、删除响应丢失、Engine 重启和 branch GC 故障矩阵通过；
3. 本地 `backup-restore-physical-e2e` 使用真实 FDB 工具完成物理删除、源盘销毁、最老支持
   版本精确恢复，并证明恢复版本不存在指向已删 exact key 的 live reference；
4. 使用独立北京 COS qualification `StorageProfile` 运行
   `qualify-real-cos-backup-restore.sh`，仅替换对象存储边界并保存通过 receipt；
5. 对 `unknown`、`deleted_but_present` 和账本/COS 字节差异建立人工处置流程。

COS LIST/inventory 只负责 reconciliation，不进入在线读路径或删除正确性证明。
自动 inventory 由 FDB 租约选出一个 Engine 执行，每 6 小时最多扫描 100,000 个对象，
每笔分类事务最多读取 50 个对象。租约只抑制重复 LIST/GET 成本，不授予删除权限；扫描超界
会暴露 `complete=0` 并关闭运营门禁。生产规模超过该界限后应接入 COS Inventory 清单文件，
而不是提高在线 LIST 频率。`max_delete_concurrency` 是单 Engine 上限，因此 Cell 理论上限仍为
该值乘以同时执行删除的 Engine 数；FDB 状态机和 policy revision recheck 继续保证 exact-key
安全性。

最新 inventory 摘要和最后一次完整扫描时间持久化在 FDB。成功写入摘要与释放执行租约属于
同一笔事务；provider 扫描失败时主动释放租约并在一分钟后重试。Engine 重启后从 FDB 恢复
指标和下次扫描时间，不能依赖进程内 Prometheus gauge 作为审计事实。
