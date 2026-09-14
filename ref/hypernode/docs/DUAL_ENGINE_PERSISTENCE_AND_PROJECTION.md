# HyperNode 双引擎持久化与投影边界

状态：已实施的架构契约
适用范围：Codex app-server 后端、DeepSeek Harness（DSH）后端、Codex Desktop 外观

## 1. 结论

HyperNode 的稳定实体是协作 Thread，不是 Codex rollout、DSH Session、Runtime 进程或 Desktop 投影。

每个 Turn 在接纳时冻结一个不可变的 execution profile；Runtime 只是执行该 Turn 的一次性载体。系统以四个互不冒充的权威边界运行：

1. `CanonicalTimelineStore`：协作身份和引擎无关的用户可见事实；
2. `ExecutionAttemptJournal`：某个 Turn 是否被接纳、派发、真正开始和终止；
3. Engine-native ledger：Codex rollout 或 DSH Session SQLite；
4. AppServer projection：供 Desktop 消费、可以重建的读模型。

跨引擎继续不是恢复，而是迁移。任何层都不得为了“看起来能继续”反向使用另一层的投影伪造原生历史。

跨资源 mutation 也不能假装成一个 SQLite 事务。`thread/fork` 同时涉及 Thread catalog、
Workspace snapshot 和 canonical timeline，因此使用持久化 operation journal 驱动 saga，
而不是先做完三处修改再祈祷进程不崩溃。

## 2. 四个权威边界

### 2.1 Canonical timeline plane

持久化稳定 `threadId`、项目绑定、标题、视图、归档状态、协作消息和已提交的引擎绑定。历史采用 append-only 的 `epoch + seq` 事实账本；AppServer Turn/Item 是从该账本派生的读模型，而不是反向写回的真相。

- `threadId` 永久稳定；
- 用户、连接和 Runtime 都不是 Thread 身份的一部分；
- Thread 历史可被多个客户端读取，但同一个 execution epoch 只有一个执行权威；
- 标题、项目和归档等协作状态不依赖某个引擎进程存活。

### 2.2 ExecutionAttempt control plane

每个获准执行的 Turn 生成持久化 attempt，核心字段包括：

`executionId, threadId, epoch, requestId, executionProfile, runtimeId, nativeTurnId, state, bootId`

状态机为：

`admitted -> dispatching -> running -> completed | failed | interrupted`

其中：

- `turn/start` RPC 被接收只代表 `admitted/dispatching`，不代表引擎已经执行；
- 只有 Codex 的 `turn/started` 或 DSH 的原生 `turn/start` 能晋升为 `running`；
- 每个原生事件必须携带并校验对应 execution epoch；旧 Runtime 的迟到事件会被 fencing；
- 进程启动时，上一 boot 所有非终态 attempt 统一标记为 `orphaned`，绝不伪装成“仍在运行”；
- 控制平面只判定所有权和生命周期，不保存模型上下文。

### 2.3 Engine-native plane

| 引擎 | 唯一权威恢复源 | 禁止作为恢复源 |
| --- | --- | --- |
| Codex | 原生 rollout JSONL / Codex artifact generation | AppServer Turn/Item、DSH event |
| DSH | 官方 SessionPersistence SQLite + checkpoint policy | AppServer Turn/Item、Codex rollout、主进程兼容镜像 |

DSH 对外稳定的是由 Thread 派生的 logical session id；物理 Session 是可替换的 Runtime generation（`logical.gN`）。每个 generation 使用独立 SQLite 文件，旧文件保持不可变；附件 CAS 则按 logical session 隔离，绝不跟随 generation 或用户 HOME 改名。因此同一 Thread 被另一用户接管、Worker 正常重启或崩溃重启时，上下文和图片引用仍然可恢复。

每个终态 Turn 都在 flush 原生 ledger 后原子写入一个 surface checkpoint，记录当前模型可见表面、原生账本水位和来源 generation。冷启动只读取 checkpoint 之后的 ledger tail，将未闭合 Turn 收敛成 `interrupted`，再用 `checkpoint + tail` 创建新的物理 generation。checkpoint 是 ledger 的可丢弃加速投影，不是新的执行权威；缺失或不匹配时允许对当前 generation 做一次完整原生恢复并重建 checkpoint。

主进程的 `DshNativeSessionStore` 只登记当前原生 Session 的 descriptor（session id、header 和 provenance），不保存、解析或镜像 DSH events。旧版本的事件镜像表只属于离线回收对象，运行时不得访问。descriptor 写失败不能终止权威 DSH Runtime，也不能覆盖已经存在的官方 SQLite ledger。

### 2.4 AppServer projection plane

`thread/read`、`thread/list`、Turn、Item 和 delta 是面向 Desktop 的派生读模型：

- 可以缓存、分页、丢弃和重建；
- 必须保持 `item/started -> deltas -> item/completed` 生命周期；
- `turn/completed` 不能代替未完成 Item 的收口；
- 不能作为 Codex 或 DSH 的正常恢复输入；
- 协议抓包只进入独立 audit ledger。

canonical envelope 使用中立的事件类型、来源、顺序、关联 ID 和内容哈希；当前 `data`
字段保留 AppServer payload 是兼容实现细节。内部查询不得解析 payload JSON，长期可以在
不改变 envelope/cursor 的前提下替换为完全中立的 payload schema。

## 3. Runtime 与启动恢复

Runtime 是可丢弃执行载体，必须登记在持久化 `RuntimeRegistry`。启动恢复遵循：

1. 9988 可先监听并把新 Turn 标记为 `recovering`；
2. 只遍历 Registry 中真正启动过且尚未终止的 Runtime；
3. 按 `view/runtime epoch` 去重并 fencing，同一 view 只做一次容器级清理；
4. 历史 Thread 只做内存状态收敛，不触发 Docker 操作；
5. DSH Worker 下一次打开 logical Session 时读取 surface checkpoint 和原生 ledger tail，并创建新的物理 Runtime generation；
6. 崩溃 Turn 被明确补成 `interrupted`，下一条用户输入开始全新 Turn，不续接半个 Turn；
7. 原生 ledger 第一次没有 surface checkpoint 时只允许一次完整恢复，随后冷启动均走有界 tail。

历史 Thread 数量因此不会再放大成 Docker 清理次数。

### 3.1 Workspace fork 恢复

每次非 ephemeral fork 在任何 mutation 之前预分配目标 Thread/Workspace ID，并写入
`WorkspaceOperationJournal`：

`prepared -> threadCreated -> workspacePrepared -> timelinePrepared -> committed`

正常失败执行反向补偿；进程崩溃后，启动恢复只扫描 journal 中的非终态操作，删除该目标
Thread、Workspace、canonical prefix 和 workspace catalog record，再标记 `rolledBack`。
恢复既不遍历历史 Thread，也不把同一个 view 重复清理。ephemeral side chat 不复制
Workspace，但仍使用同一 journal 保证 Thread/timeline 不留半成品。

## 4. 引擎切换与迁移

一个 Turn 的 execution profile 一旦接纳不可修改。模型、Provider、凭据或引擎的变更只对下一 Turn 生效。

同引擎可以在 Turn 边界替换 Runtime；跨引擎必须进入显式迁移状态机：

`requested -> source-frozen -> checkpoint-created -> target-materialized -> committed`

迁移产物必须声明保真级别：

- `native`：同引擎原生账本，无损；
- `portable`：用户/助手消息、附件和必要状态的可移植 checkpoint；
- `lossy`：工具、压缩或 Provider opaque state 无法等价表达，必须提示用户。

普通 `turn/start` 发现请求引擎与绑定不同，返回 `engineMigrationRequired`；不得偷偷把 Desktop 投影翻译成目标引擎历史。

## 5. 已落地实现

- `ThreadExecutionJournal` 持久化 epoch 和 attempt，并在 boot 边界 orphan 旧的非终态执行；
- Codex 与 DSH 都以原生 Turn-start 事件晋升 `running`；
- DSH 使用官方 SQLite SessionPersistence 和 checkpoint policy；
- DSH logical session、物理 Runtime generation 和 AppServer Thread 身份已经分离；
- DSH generation DB 使用平台目录，附件 CAS 按 logical session 隔离，二者都不跟随 SSH 用户 HOME；
- Worker 正常退出、跨 HOME 重启和 SIGKILL 后均通过 surface checkpoint + 原生 ledger tail 恢复；
- 主进程只保存当前物理 generation 指针，不装载完整 DSH transcript；
- SIGKILL 留下的不完整 Turn 被修复为 `interrupted`，后续输入创建新 Turn；
- 旧的主进程 DSH snapshot/event store 已从运行时移除；当前 registry 只保存原生 ledger 指针；
- AppServer projection 继续服务 Desktop，但不再拥有引擎恢复权威。

## 6. 验收门禁

1. DSH 当前模型表面跨 Worker 重启无损恢复，物理 generation 必须递增；
2. 同一 Session 在不同 HOME/执行用户下仍恢复同一文本和图片附件；
3. Worker 被 SIGKILL 后，只重放 checkpoint 水位后的 tail；不完整 Turn 收敛为 `interrupted`，下一 Turn 可正常运行；
4. `turn/start` RPC response 不会提前把 attempt 标成 running；
5. Codex `turn/started` 与 DSH 原生 `turn/start` 都必须匹配当前 epoch；
6. 旧 boot 的非终态 attempt 变成 orphaned，不显示为仍在执行；
7. Codex rollout、DSH ledger、协作历史和 AppServer projection 互不读写冒充；
8. 全量 policy 单测、Go 单测、bundle 检查和 DSH smoke 全部通过。
9. fork 在每个 saga 阶段崩溃后均能幂等回滚，不能留下只有 Thread、只有 Workspace 或只有 timeline 的半成品。

## 7. 后续扩展

1. 实现显式 `MigrationService` 和 PortableCheckpoint schema；
2. 从 DSH 原生 ledger 重建 MCP、Web、图片、Subagent、Hooks、Compaction、Usage 等专属 AppServer Item；
3. 为 surface checkpoint 增加离线校验、后台重建和旧 generation 回收策略；
4. 为 protocol audit 与已归档 engine ledger 增加保留期和回收策略。
