# HyperNode canonical timeline 与 AppServer 兼容边界

状态：已实施的架构契约

## 1. 结论

HyperNode 内部只维护一条引擎无关的 canonical fact timeline。Codex 和
DeepSeek Harness（DSH）是事实生产者；Codex AppServer 是对外兼容协议和读模型，
不是内部持久化格式。

现有 AppServer 名称保持不变。Paseo 风格的一致性语义用于加强内部账本和自研客户端，
不把 `thread/read`、`turn/started` 或 `item/completed` 重命名成另一套业务词汇。

```text
Codex rollout ─┐
               ├─ engine adapter ─ canonical facts (epoch, seq, eventId)
DSH session  ──┘                         │
                                         ├─ AppServer Turn/Item projection
                                         ├─ thread/timeline/list
                                         └─ hypernode/sync/v1/read
```

## 2. 唯一事实与派生物

canonical entry 的规范化 envelope 固定包含：

- `threadId`：永久稳定的协作 Thread 身份；
- `epoch`：该 timeline generation 的身份；
- `seq`：epoch 内严格递增的位置；
- `id`：用于至少一次投递下的幂等去重；
- `type`：如 `turn.started`、`item.completed`、`turn.completed`；
- `turnId/itemId`：业务关联；
- `source`：Codex、DSH 或 HyperNode synthetic producer；
- `schemaVersion/eventType/occurredAtMs`：可查询的版本和时间字段；
- `sourceEngine/sourceKind`：生产者身份；
- `payloadHash`：递归稳定序列化后的内容哈希；
- `itemType/searchRole/searchText`：投影和搜索所需的有界索引字段；
- `data`：当前兼容层仍使用的 AppServer 语义负载。

`data` 只是 v2 的兼容 payload，不是数据库查询接口。查询、分页、搜索、去重和
fencing 必须使用规范化列。大于 64 KiB 的字符串不直接复制进每条 event，而是写入
按 SHA-256 寻址的 blob 表；event 保存引用，读取时透明水合，reset/delete 后回收无引用
blob。相同 `eventId` 只在内容哈希完全一致时视为幂等重投，内容不同必须报冲突。

以下内容均为可重建投影，不得作为引擎恢复输入：

- `thread.turns`；
- `thread/read`、`thread/resume` 的响应；
- `thread/turns/list`、`thread/items/list` 的分页结果；
- Desktop 的乐观状态和 UI 卡片；
- presentation pacer 切出的文本帧。

实时 delta 只服务当前连接。持久化以 `item/completed` 的完整 Item 为权威，避免把
provider chunk 和 16ms 展示切片复制进 SQLite。崩溃中的半个 Turn 由 engine-native
ledger 和 execution journal 收敛为 `interrupted`，不能靠不完整展示帧恢复。

## 3. 对外协议

### 3.1 标准 AppServer 客户端

完整支持当前分页恢复主路径：

- `thread/resume`；
- `thread/turns/list`；
- `thread/items/list`；
- `thread/read` 仅作为兼容读取，不再承担完整历史主路径。

当 `initialize.params.capabilities.experimentalApi=true` 时，提供
`thread/timeline/list`。返回保持 Codex 当前协议形状：

```text
{ data, nextCursor, activeRealtimeSessionAtPageStart }
```

`data` 使用 `item`、`realtime`、`turnStarted`、`turnCompleted` 条目，按最新位置优先
分页。每项同时保留 `seqStart/seqEnd/sourceSeqRanges/collapsed`，使一个 UI Item 对应的
多个源事实仍可审计、精确 fork 和稳定重放。这里的 cursor 是 AppServer opaque cursor；
Desktop 不需要理解内部 epoch。SQLite 实现先按规范化索引选取当前页，再水合该页，
禁止为了返回一页而读取整个 Thread。

### 3.2 自研客户端

声明 `initialize.params.capabilities["hypernode.sync.v1"]=true` 后，可以调用：

```text
hypernode/sync/v1/read
```

该接口显式返回 `epoch`、`seq`、`reset`、`staleCursor`、`gap`、窗口水位以及前后
cursor。旧 epoch 的 cursor 不会被猜测解释；客户端收到 `reset` 后必须抛弃局部状态并
从新 epoch 重建。

因此两种客户端并不争夺两套历史：它们只是从同一事实账本读取不同兼容外观。

## 4. 写入与生命周期不变量

每个工作单元必须保持：

```text
turn.started
  item.started
  item.completed
turn.completed | failed | interrupted
```

- `item.completed` 是 Item 的权威最终状态；
- `turn.completed` 不能替未闭合 Item 收尾；
- 一个 Turn 的 execution profile 在接纳后不可变；
- Codex 与 DSH 的迟到事件必须先经过 runtime/execution epoch fencing；
- 同一稳定 `eventId` 的重复投递只追加一次；
- 标题、项目、租约等协作事实与引擎 Runtime 身份正交。

canonical 持久化失败不能阻塞已经生成的 Desktop 通知；失败必须写入独立 failure
ledger 供诊断和补偿。反过来，投影发送成功也不能伪装 canonical 落盘成功。

retention 只允许推进到已经提交的 `turn.completed` 边界。cursor 落在被回收区时必须
明确返回 gap/reset；`thread/fork` 只接受 canonical 中存在的精确 Turn 边界，绝不复制
尚未提交的尾部。

## 5. 存量迁移

运行时代码不创建、读取或写入旧 transcript 表，也不包含旧 transcript 的解析器、
lazy fallback、snapshot 特例或兼容分支。
一次性脚本读取旧 `do_thread_catalog_turns`，直接展开为标准 canonical facts：

```text
turn.started -> item.completed* -> turn.completed
```

预演不会创建表或写数据库：

```bash
npm run migrate:canonical-timeline -- --dry-run
```

正式迁移：

```bash
npm run migrate:canonical-timeline
```

脚本按 Thread 幂等：已有非空 canonical head 的 legacy transcript 会跳过；已存在的旧版
canonical rows 则原地升级规范化 envelope、哈希与 blob 引用。来源表不会删除，便于迁移
验收和人工回滚。迁移完成并切换新版本后，旧表只属于离线审计/回收范围，不能再被主程序
读取。

schema 版本由单行 meta 记录管理。运行时只会在全新数据库创建 v2；如果检测到已有旧
canonical 表而 meta 不是 v2，会拒绝启动并要求执行一次性迁移。运行时禁止 ALTER、
backfill 或偷偷维护兼容分支。

`thread/fork` 同样只截取并复制 canonical fact 前缀，不复制 `thread.turns` UI 投影。
旧 transcript 格式的任何知识只允许存在于上述离线脚本中。

## 6. 验收门禁

1. 新 Turn 只能由 canonical facts 重建，删除旧 transcript 读取路径后测试仍通过；
2. 显式 `eventId` 重投不会增加 `seq`；
3. stale epoch 返回 `reset`，不会静默续接；
4. AppServer timeline 使用当前官方形状和稳定的 latest-first cursor；
5. `--dry-run` 对数据库零写入；迁移重复运行不重复导入；
6. Codex 与 DSH 都投影到同一公共 Thread，而不互相读取对方原生 ledger；
7. 全量 policy 测试和 bundle 构建通过。
8. SQLite timeline/search 的门禁证明单页读取不会调用全量 `entries()`；
9. 64 KiB blob、重复 event 冲突、精确 fork、retention gap 和 persistence failure 均有回归用例。

## 7. 两层协议无法合并的唯一部分

AppServer 的实验 timeline 目前没有对 Desktop 暴露 Paseo 式 `epoch/gap/reset` 字段。
为了严格兼容，不能擅自把这些字段塞进官方响应。它们只出现在
`hypernode/sync/v1/read`；两层共享存储和顺序，不共享 wire shape。这是兼容边界，
不是双主或重复建模。
