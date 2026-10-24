# 跨端存储生命周期：SQLite 与 IndexedDB

状态：2026-10-16 已实现十五类自有 Node SQLite 物理库的独立迁移账本、升级前备份与旧库处置；配置目录的 Local Agent 六库在启动期打开，Codex/SSH 的功能私有 owner 按实际使用生命周期打开，摘要进入健康检查。保留 node:sqlite，不引入 ORM，不提供自动恢复备份。客户端文档与插件内容迁移见 [插件持久化契约](plugin-persistence.md)，验证边界见第 7 节。

## 1. 设计结论

统一的是数据库生命周期和迁移纪律，不是把全部存储合成一个文件、所有读写搬进一个服务，或让 ORM 类型穿透协议。

- **权威数据**：保留既有文件路径和身份，按账本向前迁移；已知 checksum 不一致、历史缺失或未知新版拒绝打开。无账本旧库按 owner 的已知结构和既有拒绝契约采纳、原子转换或拒绝；原公共九库的内部开发阶段默认仍允许备份后移开，不能把移开重建称为无损升级。
- **副本/索引**：与权威数据分开；本轮没有新增 replica 清库或重建策略。
- **启动恢复和维护**：OAuth 未完成事务取消、执行 epoch fencing、过期清理由业务 owner 在库打开后执行，不属于 schema migration。

平台模块负责连接、物理迁移、备份和错误分类；进程负责独占 owner 与 ready；领域/插件负责文档格式与业务恢复。保留现有 repository 与 CAS，不建设 SQL diff、通用 ORM、跨库事务或任意脚本迁移框架。

## 2. 现有存储清单

以下十五类物理库均经 `openManagedDatabase` 打开并暴露 outcome。路径由可信平台/进程配置确定，Renderer/RPC 不提供任意数据库路径。

| 文件名 | Owner 进程与源码 | 数据目录 | 数据职责 |
|---|---|---|---|
| `im-posts.sqlite` | Headless IM composition：[ImPostReceipts](../plugins/im/src/post-receipts.ts) | IM data directory | Standalone native channel post claims/receipts; schema v1, hashes and official IDs only, interrupted claims become unknown without resend |
| `thread-identity.sqlite` | Headless Hub：[ThreadIdentityDatabase](../apps/opencraft-daemon/src/thread-identity-database.ts) / AppServerIdentityOverlay | Headless `thread-identities/opencraft-server` | DSH trusted sender/creator, fork origins and derived 企业身份 presence/completion; no native messages or execution state |
| `thread-read-receipts.sqlite` | Headless installation：[ThreadReadReceiptStore](../scripts/thread-read-receipt-store.ts) | Headless server data directory | Verified-account exact read receipts; existing document-store migrations/CAS, independent of selected Host |
| `opencraft-ui.sqlite` | Electron Main：[ui-preferences-store](../apps/workbench-electron/src/ui-preferences-store.ts) | Electron `userDataDirectory` | UI 偏好与 CAS |
| `opencraft-connectors.sqlite` | Electron Main：[connector-configuration-store](../apps/workbench-electron/src/connector-configuration-store.ts) | Electron `userDataDirectory` | 连接选择意图，不含凭据 |
| `opencraft-extensions.sqlite` | Electron Main：[document-storage/sqlite](../packages/document-storage/src/sqlite.ts) | Electron `userDataDirectory` | client-local 插件文档、设置与安装记录 |
| `opencraft-session-routing.sqlite` | daemon 内 Local Agent Host：[dsh-session-routing](../apps/local-agent-host/src/dsh-session-routing.ts) | Host `dataDirectory` | 逻辑/原生身份、generation、水位与 intent |
| `opencraft-threads.sqlite` | daemon 内 Local Agent Host：[thread-catalog](../apps/local-agent-host/src/thread-catalog.ts) | Host `dataDirectory` | 人工标题、归档、关系与配置 |
| `opencraft-executions.sqlite` | daemon 内 Local Agent Host：[dsh-execution-authority](../apps/local-agent-host/src/dsh-execution-authority.ts) | Host `dataDirectory` | epoch、执行日志、输入及队列 |
| `opencraft-host-documents.sqlite` | daemon 内 Local Agent Host：[document-storage/sqlite](../packages/document-storage/src/sqlite.ts) | Host `dataDirectory` | Host 通用文档；与 client-local 物理分离 |
| `opencraft-managed-connectors.sqlite` | daemon 内 Local Agent Host：[connector-host/store](../packages/connector-host/src/store.ts) | Host `dataDirectory` | 实例、凭据与 OAuth 事务 |
| `account-pool.sqlite` | 独立 codex-core：[account-pool-host/store](../packages/account-pool-host/src/store.ts)、[account service](../packages/account-pool-host/src/codex-account-service.ts) | codex-core `dataDirectory` | 账户元数据、亲和性与配额；secret 文件由同一 owner 管理 |
| `tasks.sqlite` | [TasksSqliteStore](../plugins/tasks/src/sqlite.ts)；Local Agent 启动 owner / Codex 功能私有 owner | 原 Host 目录；各实例各自独占，不跨目录合库 | Tasks、关联、revision/CAS；原 `tasks-rows` v1 SQL/hash 不变 |
| `opencraft-host-state.sqlite`（旧目录沿用 `codex-host-queue.sqlite`） | [OpenCraftHostStateDatabase](../apps/opencraft-daemon/src/opencraft-host-state-database.ts)；CodexEngineAdapter | 原 Codex 目录；SSH 为原 `ssh-servers/<binding hash>` 目录 | durable queue、message_senders、企业身份 presence/state/completion 与远端会话目录/同步水位共用一个迁移/连接/事务 owner |
| `opencraft-message-attachments.sqlite`（旧目录沿用 `codex-message-attachments.sqlite`） | [OpenCraftMessageAttachments](../apps/opencraft-daemon/src/opencraft-message-attachments.ts)；CodexEngineAdapter | 同上 | 已发送文件的 display metadata，不改变原生 mention 输入 |
| `connections.sqlite` | [SshConnectionStore](../apps/opencraft-daemon/src/ssh-connection-store.ts)；可选 SSH management owner | 原 `ssh` 私有目录 | 连接/CAS、host key 与加密 credential；原 `ssh-connections` v1 SQL/hash 不变，v2 保留旧 reader 的 `user_version=1` |


Electron Main 三库仍按消费入口懒打开。Local Agent 基础五库及配置目录时的 Tasks 统一由 [local-agent-storage](../apps/local-agent-host/src/storage/local-agent-storage.ts) 打开；未配置目录的嵌入/测试入口使用内存库，不提供持久 Host 文档能力。服务器 Host 目录为 `OPENCRAFT_EXECUTION_STATE/data`。account-pool 由所选 Codex owner 管理；独立 [codex-core](codex-core.md) 仍独立启动/升级，默认下游 Codex adapter 在连接时打开并报告 outcome，不被 Local Agent owner 二次打开。

Web preferences、Connector configuration 与插件文档继续使用各自 IndexedDB adapter；Web/Expo replica 保持原有平台语义。SQLite debug reader 是只读消费者，不建表、不迁移。DSH/Hermes/Codex 引擎私有存储、JSON 项目/模型配置不由本 runner 接管。`codex-thread-pins` 经原生 reserved section 协议操作，不是另一份本地自有 SQLite；Hermes pins 同样由远端协议 owner 持有。原生 `queue_1.sqlite` 只沿既有队列搬运语义读取/删除已确认导入记录，不接管其 schema；`.codex-writer.sqlite` 只承担 writer lock，排除于业务库清单。类名中的 DSH 不改变 routing/executions 的 OpenCraft 所有权。

### 两个 Host 自有文件的离线改名

新目录直接创建 `opencraft-host-state.sqlite` 和
`opencraft-message-attachments.sqlite`；既有目录默认原位读取旧名。
改名从源码 checkout 使用独立维护入口，对一个明确的本地数据目录执行：

```sh
npm run storage:move -- --data-dir /path/to/host-data
npm run storage:move -- --data-dir /path/to/host-data --apply
```

默认仅检查路径并输出计划，不打开 SQLite、不创建目录或锁文件。执行前停掉
该目录的所有 Host overlay owner，并停用自动重启；SSH binding 的本地 overlay
目录也须逐个处理。当前两个 owner 持有共享 SQLite lease，维护进程取独占 lease，
进程退出由内核释放。旧二进制不认识此 lease，工具无法证明空闲旧连接已经退出；
停掉所有旧 owner 是离线操作条件。原生账户 writer lock 不能替代此条件。

工具先拒绝双名称、非普通文件、未知硬链接及孤立 WAL/SHM/journal，再记录私有
维护日志。每个库通过 quick_check、WAL checkpoint 和独占事务检查，切到 DELETE
journal 后关闭连接，确认没有 sidecar，制作并校验 SHA-256 恢复副本。发布目标使用
不覆盖现有文件的硬链接再移除旧名；不支持硬链接的文件系统会失败并保留日志。
文件和日志按步骤 fsync；Windows 的 Node 不提供目录 fsync，不能据此承诺断电后的
目录持久性。两个独立库逐个完成，不构成跨库事务。

中断后重新执行相同方向的 `--apply`。活动日志
`.opencraft-owned-storage-move.json` 阻止当前 owner 打开；即使中断发生在链接与
移除旧名之间，也只在 inode、内容 hash 和恢复副本全部一致时续做。独立冲突文件、
修改后的源/目标/恢复副本及无效日志均拒绝继续，不能通过删日志来跳过检查。
成功后保留完成回执和 `.opencraft-storage-<id>-<index>.sqlite` 私有恢复副本。
日志只含固定文件身份、阶段和 hash，不含业务记录。

需要撤销名称切换时，先停掉 owner，再用
`--direction legacy --apply`。这会移动当前最新数据并另存恢复副本，绝不自动恢复旧
备份；只反向改文件名，不降级 schema，也不保证旧版本程序能读新版 schema。
迁移 SQL、账本、业务表和数据均不由此工具修改。代码交付不表示任何部署目录已经搬迁。

## 3. 存储边界

权威数据与可重建 replica cache 分开管理；cache 版本变化不授权重建权威库。
平台共享存储语义，驱动和迁移代码由各 owner 持有。迁移 ID、历史 checksum
不可改写；失败需可重试，破坏性处置前必须保留数据。未知新版仍严格拒绝打开。
这不表示存在全局升级 UI 或任意降级能力。运行时验收以当前源码、测试和 smoke 为准。

## 4. 版本与兼容模型

每个物理库有独立 `schema_migrations(version, name, checksum, applied_at)` 账本；迁移列表版本从 1 连续递增，SQL 原文由共享模块计算 SHA-256，调用方不提供 checksum。已记录历史必须是当前源码列表的连续前缀，version、name、checksum 全部匹配；未知较高版本报 `newer-schema`，缺失/改写历史报 `history-mismatch`。没有程序版本到 schema 版本的映射，也没有第二份物理 schema 版本轴。

文档 payload 另有版本：[threads document](../apps/local-agent-host/src/thread-catalog.ts) 无 version 的旧记录按 v1 读取，写入显式 v1，拒绝未知新版；[extension records](../packages/document-storage/src/contract.ts) 的 `data_version` 对应文档 `version`，CAS 事务拒绝格式倒退。插件纯内容转换由 [document-migrations](../packages/extension-runtime/src/document-migrations.ts) 管理，不让插件改物理表。

程序 buildId、插件 packageVersion/SDK 兼容范围、SQL 账本、IndexedDB database.version、payloadVersion、revision/CAS、协议和引擎存储格式相互独立。

当前是内部开发阶段，不承诺 N-1 旧二进制兼容，不跑旧二进制回退门禁。无账本旧库在有限结构比较一致时采纳，否则默认先备份再移开重建。AccountPool、session-routing、executions 与 managed-connectors owner 显式声明下述已知旧结构的兼容转换，未声明该能力的 owner 行为不变。已有账本沿经验证的迁移链向前升级，拒绝不匹配历史。旧的无守卫二进制不能被新 metadata 阻止，代码回退不等于 schema 降级或数据恢复。

### AccountPool 已知无账本旧结构

旧产品回迁保留既有 owner 已支持的数据升级：`pool_accounts` 的七列基线及按原顺序追加的五个 nullable 元数据列；已存在的 `pool_affinity`、`pool_active_account` 必须匹配原结构，`pool_quota` 可以是原六列或已追加 `limit_windows_json` 的七列。缺少辅助表允许由转换创建；额外表、列、索引或已知列定义不符不接纳。识别与转换由 [AccountPool owner](../packages/account-pool-host/src/store.ts) 提供，不是公共层放宽全部库的 schema 策略。

`openManagedDatabase` 的可选 `legacyMigration` 只处理没有账本且不匹配当前目标指纹的旧库；`accepts` 读取结构指纹和只读 schema objects（类型、名称、SQL），`migrate` 在写入前备份完成后执行。转换、最终目标指纹校验和既有版本账本登记在同一事务内原子提交，outcome 为 `migrated`；事务内重新核对识别时的结构与对象，防止转换前结构变化。失败回滚、保留备份并拒绝打开，不退回移开重建；重复打开为 `up-to-date`，不再转换。已匹配当前结构仍为 `adopted`，未知结构仍为 `moved-aside`。已有账本的 newer-schema/history-mismatch 校验在此入口之前执行，不允许 owner 转换绕过；已发布基线 SQL 与 checksum 不改。

[AccountPool 测试](../tests/identity/account-pool-host.test.ts) 保留原七列 fixture、账号和 ready 断言，并覆盖带辅助表/关联状态的旧库与重复打开；GitHub 移开用例改用真正未知结构。公共 [SQLite 测试](../tests/storage/sqlite-node.test.ts) 覆盖转换失败和最终结构不符的回滚、恢复点及已有账本拒绝。

### session-routing 已知无 intent 旧结构

[routing owner](../apps/local-agent-host/src/dsh-session-routing.ts) 只接受与原两表结构匹配的无账本旧库：可以缺 `dsh_pending_generations.intent`，或缺原构造器会创建的 generations/pending 表。通过同一 `legacyMigration` 创建缺表并补 nullable intent；已有对象必须与这两种旧 DDL 定义一致。generation 全部坐标和 pending 记录保留；旧 pending.intent 为 null，不合成 publication evidence，原 `reconcile` 仍拒绝不完整发布。备份、转换/结构校验/账本原子性与 AccountPool 相同，已发布 BASELINE/checksum 不变；未知对象、列、约束或索引仍移开。对应 [routing 测试](../tests/execution/dsh-session-routing.test.ts) 覆盖原映射、水位、pending、缺表、拒绝发布与重复打开；Host storage/daemon ready 投影已知旧 routing 的 `migrated` outcome，仍覆盖未知结构的 `moved-aside`。

### 本次五个 Host owner 的旧构造器核对

回迁对照固定导入前源码与旧 GitHub 树的旧构造器；相关旧实现一致，#31 改为托管打开。以下证明的是旧构造器支持这些输入，不推断历史发布产物曾产生缺对象库。

| Host owner | 原行为证据与本次结论 | 数据验证 |
|---|---|---|
| session-routing | 原 owner 用 IF NOT EXISTS 分别建两表，并按列探测补 intent；已声明上节转换 | 原映射/全部 generation 坐标、无 intent 与缺表 pending、重复打开、拒绝不完整发布 |
| executions | [DshExecutionAuthority](../apps/local-agent-host/src/dsh-execution-authority.ts) 原建两个输入表，HyperNode journal/queue initializeSchema 原文补其他表与三个索引；显式允许这些已知对象的缺失，不改镜像原文 | [execution 测试](../tests/execution/dsh-execution-authority.test.ts)：缺 queue-state 或 actor 索引仍保留消息 ID 投影、submission、未消费队列、仍存在的暂停状态、epoch 递增；previous-boot fencing 仍终结旧执行，重复打开不再转换 |
| managed-connectors | [ConnectorDatabase](../packages/connector-host/src/store.ts) 原 IF NOT EXISTS 建三表；显式补缺辅助表，已有表/约束必须合法，原重启取消 pending OAuth 仍执行 | [connector 测试](../tests/extensions/platform-connectors-host.test.ts)：缺 OAuth 表仍保留连接 revision/title、凭据与 OAuth 数据；缺 credentials 表只创建空表，不猜造秘密，保留已有 instance；未知索引/错误 FK 不接纳 |
| threads | 原单表，完整旧记录自动 adopted；空库 fresh 已覆盖，无其他有源码证据的缺对象变体需要转换 | [thread-catalog 测试](../tests/chat/thread-catalog.test.ts) 与独立旧构造器 fixture 证明记录保留；不加兼容回调 |
| host-documents | 原 extension_records 已有 v1 账本；未知库/缺表原本拒绝，不能当已知 legacy 放宽 | [SQLite 测试](../tests/storage/sqlite-node.test.ts) 覆盖原账本 up-to-date、文档保留与缺域表拒绝；不加兼容回调 |

`createMissingLegacyObjects` 只在 owner 显式给定上述旧 DDL 时提供 `legacyMigration`；逐个比较已有 schema object 的 type/name/SQL，只忽略引号外排版空白，保留 FK、STRICT、索引和其他约束定义。未知对象或定义不同不因另一个对象缺失而接纳。缺少的对象只按旧行为创建，不生成不存在的业务历史；该入口不扫描下游额外持久库，也不改变默认的未知库处置。

### 下游额外 owner 的兼容与目标校验

- OpenCraft Host state 的 queue、sender、企业身份 四张表属于同一个物理库；consumer 不再自行 CREATE。旧完整库 `adopted`，旧构造器支持的已知缺对象通过 `createMissingLegacyObjects` 备份后原子补齐；dispatching 恢复为 unknown 等队列恢复仍在业务 owner，不进入迁移。metadata plugin 只借用连接，不能升级或关闭它。
- attachments 沿用原表/索引和记录身份，允许原构造器支持的缺索引；不迁移或改写 attachment payload。
- Tasks 沿用已发布 v1 账本，拒绝非空无账本库；默认固定 Local Agent authority 预开，私有 Codex Tasks 仍在用户实际发现/使用功能时打开，capabilities 成功回执之前必须完成迁移。未使用它不创建第二份 Tasks 文件或阻止 Codex 连接。
- SSH 保留原 v1 SQL/name/hash、私有路径/key/密文，v2 只投影旧 reader 的 user_version。已有 v1 及新建后中断于 v1 的受证结构可重试；未知基线、新版/错误账本、失去 key 都拒绝，不替换 credentials。
- 新接入 owner 使用 `createSchemaValidator` 严格比对 sqlite_master 的 type/name/SQL（只忽略引号外排版与 IF NOT EXISTS）。有账本但丢表、约束或索引变更不能被 up-to-date 掩盖。最终 SQL、目标校验、最终账本记账位于同一迁移事务；legacy 转换同样在记账前校验。`legacyPolicy` 保持 Tasks/SSH 原拒绝无账本边界，state/attachments 只接纳有旧源码证据的已知结构，未知库保留原文件并拒绝；公共九库未启用该新策略，旧默认行为不改。
- [下游 fixtures](../tests/storage/downstream-sqlite-lifecycle.test.ts) 对照固定导入前源码，覆盖记录/关联/密文/CAS、重复打开、错误/新版历史、缺域对象、转换与 v2 失败回滚/恢复点。公共 runner 的无 owner 校验仍只提供下述有限指纹，不能声称所有历史库都做了 SQL 对象级检查。

## 5. 打开与升级流程

### openManagedDatabase

[lifecycle](../packages/sqlite-node/src/lifecycle.ts) 的实际步骤是：

1. 校验连续迁移列表和正整数备份保留数；打开连接，设置 WAL、`busy_timeout=5000`，目录权限 0700、库文件 0600。`:memory:` 跳过文件操作与备份；`foreign_keys` 由业务 owner 设置。
2. 校验已有历史，计算有限结构指纹，区分空库、有账本库和非空无账本旧库。
3. 空库执行完整链；有账本且待升级的非空库/账本库先备份，再逐版本迁移；当前版本无需备份。
4. 无账本旧库在内存目标库执行完整迁移链并比较指纹。一致则先备份，在一个 `BEGIN IMMEDIATE` 事务中重新核对结构并写入全部账本，返回 `adopted`。不一致但 owner 显式识别的已知旧结构按第 4 节兼容转换返回 `migrated`；否则先备份、关闭连接、移开旧文件、创建新库并执行迁移，返回 `moved-aside`。不一致且未被 owner 识别的内存旧库无法移开，报 `unsupported-legacy`。
5. 再次校验历史，成功后清理超额备份；返回连接与 outcome。连接由调用方关闭；失败关闭当前连接并抛分类错误。

每个待应用版本在独立 `BEGIN IMMEDIATE` 事务内再次校验历史、执行 SQL 并写账本；失败回滚该版本，已提交版本保持有效。各库不是一个事务；后续库失败不撤回之前库的升级，重启时按各自账本续行。

指纹由 [migrations](../packages/sqlite-node/src/migrations.ts) 比较用户表集合、`PRAGMA table_info` 的 name/type/notnull/dflt_value/pk 和索引名；排除 `sqlite_*` 与账本表。它不校验索引定义、CHECK、外键、触发器或 STRICT，不是完整 schema diff。“一致”仅指这个有限比较。routing 已知无 intent/缺已知对象的旧库按 owner 声明原子转换并保留 generation/pending；完整旧结构采纳，未知结构仍遵循原移开策略。

旧库及仍存在的同名 WAL/SHM 各自原子重命名为 `.legacy-<时间戳>`，文件保留、不自动清理。文件集合不是跨文件原子操作；rename 失败撤回本次已完成的 rename。调用方必须保证没有其他活跃连接。

### daemon 启动与 owner

[daemon main](../apps/opencraft-daemon/src/main.ts) 取得 Host 存储 owner 后，检查旧 IPC socket，打开 Local Agent 基础五库和配置目录的 Tasks，再监听 IPC；存储失败释放资源、拒绝监听，启动入口非零退出。DSH 引擎仍在首次创建 local Host transport 时懒启动。[Local Agent Host main](../apps/local-agent-host/src/main.ts) 消费已打开的存储，业务恢复与资源清理由 owner 执行；Node Host 入口未传入 storage 时自行打开对应配置库；浏览器嵌入不打开 Node SQLite，独占责任仍在调用方。

[daemon-storage-owner](../apps/local-agent-host/src/storage/daemon-storage-owner.ts) 用短互斥串行化 claim/release，记录 PID 与随机 claim，活 PID 阻止第二个 daemon 接管；死 PID 可在互斥内替换。随机 claim 确保释放者只删除自己的记录。短互斥不跨越同步迁移，整个存储生命周期没有 heartbeat；不是凭锁文件存在或 heartbeat 超时推断旧 owner 已死，也不是 SQLite 自身的跨库锁。当前检查的是 PID 存活，不承诺 PID 重用身份识别。

[daemon/ready.storage](../packages/daemon-ipc/src/index.ts) 是保留给旧客户端的可选五库摘要：name、status、appliedVersion、可选 backupPath、movedAside；不传记录或连接。新增可选 `daemon/ready.storageOutcomes` 携带完整、可扩展的 name 与可选 hostId；新客户端优先解析它，仍接纳省略该字段的旧五库消息。旧客户端继续读取原 `storage`，忽略新字段。[daemon server](../apps/opencraft-daemon/src/server.ts) 在认证握手回传处置结果，[gateway `/health`](../scripts/server-deployment/gateway.mjs) 经过 daemon IPC 与外部 core 健康检查后附带完整 `storage`；默认 Headless `/__opencraft_health.storage` 同样只列实际已打开的 owner。Codex 私有库打开失败不发布该 Host open，SSH 管理仅在配置/使用时打开；未使用的可选功能不降低默认 Host 的可用性。status 为 fresh / up-to-date / migrated / adopted / moved-aside，摘要表示本次打开处置，不是备份目录清单。存储失败不伪装 ready，更新器沿既有健康失败回退逻辑处置，`ok` 判定不变。

源码与Linux归档烟测验证HTTP成功、`ok`和`appServerConfigured`为真，以及干净启动已报告存储且没有`movedAside`。健康响应允许附加Host等诊断字段，不与历史二字段对象做整对象相等断言；后续AppServer/AppHost初始化、队列和项目等RPC仍需实际通过。

### 错误分类

[SqliteLifecycleErrorKind](../packages/sqlite-node/src/errors.ts) 有六类：

| kind | 当前含义 |
|---|---|
| `busy` | SQLite BUSY/LOCKED |
| `history-mismatch` | 列表不连续、已有 version/name/checksum 不匹配，或 owner 严格目标结构校验失败 |
| `newer-schema` | 库含当前源码未知的较高版本 |
| `unsupported-legacy` | 无法移开的不一致内存旧库，或 owner 转换未产出目标结构 |
| `io` | 文件/权限/磁盘等其余底层错误，以及非法保留数 |
| `migration-failed` | SQLite SQL/约束错误 |

错误保留 cause，不把任意 SQL 错误称为 corruption，不自动删库重试。Host 打开失败报告库身份与类别，不暴露记录/凭据；备份路径仅为运维元数据，不上传数据。

### 备份与恢复

[backup](../packages/sqlite-node/src/backup.ts) 用 `VACUUM INTO` 制作包含已提交 WAL 数据的一致快照，不复制正在写入的单个 `.sqlite`。快照与源库同目录，名称为 `<库文件名>.pre-v<N>-<ISO时间戳>.sqlite`，时间戳冒号替换为连字符，文件权限 0600。服务器位置为 `OPENCRAFT_EXECUTION_STATE/data/<库文件名>.pre-v<N>-<时间戳>.sqlite`。默认保留 3 份；只有本次处置成功才保留本次快照及最新的另外 2 份，不因时钟回拨删除本次恢复点；失败不清理既有备份。必需备份失败则不执行迁移。

更新/回退只切换代码，不自动恢复数据库；恢复旧备份会丢弃其后的写入。人工恢复应：

1. 停止对应全部 owner；服务器停止执行 unit 并确认 daemon 已退出，account-pool 另停 codex-core，Electron 退出该 profile 的应用。
2. 保留当前库及 sidecar 供排查，核对备份、目标库身份和拟启动代码的迁移历史；明确备份之后的数据损失范围。
3. 用选定备份覆盖库文件，删除目标库同名 `-wal` / `-shm`，保持私有权限；不要删除 `.legacy-*` 或其他库的 sidecar。
4. 启动 owner，核对 outcome、账本与业务数据；服务器核对 `/health.storage`。若代码仍需向前迁移，启动时仍会执行，不把恢复备份误称为自动降级。

## 6. 执行机制与文件拓扑

共享模块的五个实现文件，加一个公开出口：

| 文件 | 职责 |
|---|---|
| [connection.ts](../packages/sqlite-node/src/connection.ts) | node:sqlite 连接、权限与 PRAGMA |
| [lifecycle.ts](../packages/sqlite-node/src/lifecycle.ts) | openManagedDatabase 编排与 outcome |
| [migrations.ts](../packages/sqlite-node/src/migrations.ts) | 账本、原文 SHA-256、事务、历史校验与有限指纹 |
| [backup.ts](../packages/sqlite-node/src/backup.ts) | 快照、成功后保留清理与旧库移开 |
| [errors.ts](../packages/sqlite-node/src/errors.ts) | 六类错误 |
| [index.ts](../packages/sqlite-node/src/index.ts) | 最小公共 API |

迁移 SQL 是第 2 节各 owner 源码里的 TS 常量，随 Main/Daemon/core bundle 交付，没有独立 SQL 资产目录或 manifest。migrations 为 readonly 的 version/name/sql 列表；返回 database 与 outcome（status、appliedVersion、可选 backupPath、movedAsidePaths）。共享包不导入 Feature/React、账户服务或执行引擎；连接不跨 IPC。生产不动态 diff 数据库，不依赖仓库 cwd、不联网下载迁移。

executions 中 hypernode 表 DDL 以 [DSH_EXECUTION_BASELINE](../apps/local-agent-host/src/dsh-execution-authority.ts) 为基线权威；[execution-authority](../apps/local-agent-host/src/hypernode/execution-authority.js) 与 [thread-queue](../apps/local-agent-host/src/hypernode/thread-queue.js) 的 `initializeSchema` 保持与基线一致。当前构造器仍调用声明中的 `CREATE ... IF NOT EXISTS`，在已完成基线迁移的库上为 no-op，不承担表结构升级。[指纹等价测试](../tests/execution/dsh-execution-authority.test.ts) 防止基线与初始化声明漂移。已发布 SQL 不改写，后续结构变化追加版本迁移；hypernode 变更还需同步基线与初始化声明，不能建立第二份升级 authority。

IndexedDB 使用原生升级事务，不运行 SQL runner；广播仅通知已提交 revision 失效，跨标签 CAS 仍由事务保证。浏览器没有桌面文件快照能力，不把 abort 回滚称为文件备份，不通过删库处理 VersionError。

## 7. 分阶段实施与证据门禁

### 已完成

- 十三类物理库接入共享生命周期；document-storage 保持原 v1 SQL/hash，extensions 与 host-documents 共用实现但账本各自独立；threads 增加 payload 版本守卫。
- Local Agent 配置目录的六库启动门禁、owner claim、认证 ready 摘要及 gateway 健康投影；OAuth 清理与 execution fencing 保留在业务 owner。
- [共享模块测试](../tests/storage/sqlite-node.test.ts) 覆盖空库、旧库采纳/移开、多版本升级、重复打开、checksum/未知新版拒绝、事务回滚、WAL 备份与保留；各 store 测试验证原领域读写/CAS 和旧库处置。
- [Host storage 测试](../tests/storage/local-agent-storage.test.ts)、[daemon 测试](../tests/execution/opencraft-daemon.test.ts)、[更新器测试](../tests/server/server-deployment.test.mjs) 覆盖双启动、启动失败拒绝 ready、旧五库/新完整 owner 摘要与健康失败回退。
- 既有 [服务器 smoke](../scripts/smoke/server/smoke-server-updates.ts) 使用真实 npm、生产 SPA、打包 gateway/daemon 与 Codex CLI，推理为合成回环服务，systemd 为隔离重启替身。早期 routing 移开报告不再证明当前已知无 intent 的处理；当前原子转换与未知拒绝/移开由 owner fixtures 验证。本阶段不宣称重跑完整更新 gate 或真实局域网端到端。

### 明确未做

- Electron Main 三库仍懒打开，没有 UI 呈现生命周期处置结果；本轮不新增全局升级/恢复提示。
- Web 插件文档已有 blocked 错误与 versionchange 关闭；preferences/Connector configuration IndexedDB 的 blocked/versionchange 缺口未变，不声称所有 Web 库都有升级协调。
- 未跑 N-1 旧二进制回退，不承诺任意降级；不自动恢复备份，不提供恢复 UI、跨库原子升级或大规模在线回填框架。
- 未迁移真实用户数据库；未以本轮 Node 库工作覆盖 Native adapter、所有远端 Host、历史所有 Electron origin 找回或新签名发行包验收。

历史设计与实施记录见 [任务计划](../design/sqlite-lifecycle/task_plan.md)、[进展](../design/sqlite-lifecycle/progress.md)。本分支尚未推送或发布，源码与 smoke 证据不代表线上部署已升级。

### 受管 Headless 的历史 Codex Bot 数据保留

OpenCraftHostStateDatabase 的已发布 v1 保持原文，v2 追加 rooms/commands/message slots；
旧 Bot bridge 已删除，历史表不再由 Bot adapter 使用。v14 将三张历史表改为
`opencraft_bot_rooms`、`opencraft_bot_commands`、`opencraft_bot_message_slots`，
保留所有旧记录和已发布 v1–v13 SQL/账本。升级前副本保留旧结构，旧 managed reader
拒绝新版库；无版本守卫的旧 bridge 不得重开当前库并重建旧表。
已知旧结构仍在 owner 内有界转换并保留映射/receipt/消息 ID，
未知仍拒绝；回退接受性须用实际旧 reader 在隔离副本验证。来源与边界见
[受管 Headless](managed-headless.md#codex-原生会话与保留数据)。


受管站点首次受管迁移的SSH历史恢复：旧单体只接受v1账本，而正式owner已发布的v2仅维护
user_version。原未修改旧入口不能直接作为升级后的回退。固定历史恢复工具复用该owner
正式迁移清单，对固定来源的旧owner增加精确v2接受，原SQL/checksum/记录不变，未知仍拒绝；
生成物不入Git、不作为常规启动热patch。必须证明完整兼容旧入口接受新owner后的真实副本，
而非只证明某张库可读；见[受管Headless历史恢复](managed-headless.md#固定旧部署的历史恢复工具)。


## OpenCraft Host state v5：持久会话目录与参与关系完成状态

`OpenCraftHostStateDatabase` 在原 v1–v4 后追加 `durable-thread-catalog` v5；原迁移
SQL、名称与 checksum 保持。迁移新增 `codex_thread_catalog`（受控元数据、归档/删除
投影、观察时间与本地 revision）、`codex_catalog_sync`（分活动/归档的成功时间、
更新时间水位、完整扫描时间、同步/就绪/错误状态）及 `ioa_presence_sync`（已完成
原生历史校验的 Thread）。复用原物理库与已有 SSH binding namespace，不改路径。

目录是远端事实的派生索引，不保存 turns 或实现专属 extra；preview 截取最多512字符。
经过验证的员工身份仍来自已有 sender/creator 表，不能从远端操作系统账号或标题推断。
迁移 runner 在写入前备份；失败/校验错误拒绝打开并报告 outcome，不移开已记录库重建。
v4→v5 测试逐表核对队列、发送者、创建者、参与索引、来源关系及旧账本原样保留，
并覆盖重复打开、checksum 改写拒绝和恢复时目录/完成状态可读取。

程序回退不等于自动 schema 降级。按既有内部开发契约，旧 reader 可能拒绝 v5；
不得把迁移前整库覆盖回当前持续写入的数据。优先使用包含既有迁移链的修复版本。

## Hub DSH identity metadata v1

`ThreadIdentityDatabase` is a new owner opened only when Headless employee
verification is configured. Managed v1 creates the sender, origin, creator and
derived 企业身份 tables through migrations; plugin consumers only borrow its connection.
It uses strict schema validation and rejects unknown legacy files, newer versions
and changed checksum history without replacing data. Future changes append v2;
existing OpenCraft Host state v1–v5 migrations and all native DSH databases are untouched.

The Headless installation lock scopes the owner by stable Server; shutdown retires
proxy sessions, metadata work and the read-only native client before closing this
connection. Startup failure releases resources and refuses readiness. Health lists
`thread-identity`, `hostId: opencraft-server`, version and opening outcome.
[Unified identity tests](../tests/identity/unified-thread-identity.test.ts) cover fresh/reopen
ledger and data retention, checksum/newer-schema rejection, shared Codex/DSH
semantics, real WebSocket ingress and automatic Headless wiring across restart.
This new owner has no prior schema to upgrade; existing OpenCraft Host state upgrade fixtures
continue to validate v4→v5 preservation. Old DSH messages have no trusted employee
records and remain unknown; opening metadata never relabels them as the viewer.

### Codex 重置券元数据（2026-10-17）

AccountPool owner 的 v2 迁移只向 pool_accounts 追加可空重置券数量与确认时间，保留v1 SQL与校验和。已知无账本旧结构转换到同一目标；凭据、账号、亲和性和已有用量不重建。数量未知不写0；推理header观测不改券元数据。升级后不使用仅认识v1的旧owner打开v2库；回退优先前向修复或兼容迁移版本，不以旧备份覆盖后续业务数据。


## OpenCraft Host state v6: token metering foundations

The existing `OpenCraftHostStateDatabase` appends migration v6 without changing the
published v1–v5 SQL or checksums. Its connection and transaction owner also owns
usage coverage intervals, turns, accepted-input facts, versioned usage sources,
derived allocations and recovery checkpoints. The metering ledger borrows this
owner; it neither creates tables at request time nor closes the connection.
The exact previously accepted unledgered v5 schema remains an upgrade input;
unrecognized partial schemas and modified published histories remain rejected.

Counts are canonical decimal strings in storage and JSON, with BigInt arithmetic
in the projection. A source replacement, allocations and its replay checkpoint
commit together. Response facts and validated per-turn snapshots are alternative
sources, while thread cumulative totals are never directly counted as a turn.
The native rollout reader accepts only paths resolved inside trusted native
storage, replays complete bounded lines, and retains incomplete tails. Native
records without actual provider/model evidence retain unknown model identities.
The physical Host now observes accepted inputs before Renderer filtering and
replays native facts independently of visible clients. This wiring does not
by itself prove complete recovery or the full acceptance workload.


Native admission recovery decodes only `event_msg/item_completed` records whose
item is `UserMessage` and contains a stable `client_id`, with matching native
thread and turn IDs. This proves the accepted target, not the human identity or
input mode. A collector must join that ID to a trusted persisted submission
receipt; body text, copied authors and message ordering are not identity facts.
Rejected steer requests are not converted into accepted participants.


Recovery metadata appends v7: trusted submissions are captured independently of
native accepted-input IDs and their exact target turns, so an admission cannot
be inferred from a sender row or an unconsumed queue entry. A missing identity
keeps the entire known amount pending; a later trusted join rebuilds the same
projection. Trusted Host ingress records submissions before forwarding; native
ACKs and durable records supply accepted targets. Conflicting trusted identities
for one input ID persist ambiguity and hold the whole turn pending, including
after restart. Derived model buckets share this same database.

Native response counts, verified per-turn reports and replay progress use the
same synchronous transaction, after bounded file I/O has completed. A durable
terminal marker and a validated per-turn report are required by the native
settlement check. Missing response facts can fall back to the validated report;
complete response facts replace that report instead of adding to it. Rollout
references, safe gap categories and source observation times share the existing
Host owner. A changed source path or backward cursor requires reconciliation;
active gaps prevent a complete native settlement declaration.


Read-only statistics run in a bounded per-Host Worker against the already
migrated file. Its own read-only, query-only connection never creates a file,
migrates or writes usage. Each query uses a deferred SQLite snapshot, exact
BigInt reduction and signed cursors bound to filters, authority and revision.
The Host rechecks the current human/instance role after asynchronous reads and
immediately before delivery; stale logical clients receive no response. Worker
exit/timeout rejects queued reads and allows lazy recovery without affecting
model execution. Its handle is closed on worker shutdown. The shared migration
owner remains the only writer. Packaged Headless artifacts include the compiled
worker beside their entry point; source probes use the source loader explicitly.
Successful replay can repair persistent transient acquisition gaps after restart;
invalid/replaced-source evidence is not silently cleared by a later empty pass.


Native ephemeral counters append v8 without changing published v6/v7 SQL. Only
a physical native thread/start response proving an empty ephemeral thread may
establish a zero baseline. Durable epoch, per-turn baseline, cumulative values
and a broken marker prevent inherited/reset counters from becoming new usage.
The live collector retains only safe counts and correlation IDs in bounded
batches. Missing or failed facts break the lineage and remain partial; a new
Host never invents a baseline for an old ephemeral thread. Native terminal and
validated per-turn snapshots use the existing settlement rule. Usage survives
client disconnection and ephemeral native history removal.


Token usage v9 adds covering indexes and exact daily projections for the
Asia/Shanghai deployment scope. The ledger updates facts, allocations, source
cursors and day contributions in one transaction, using decimal strings and
BigInt arithmetic. Stored per-turn contributions allow corrections and frozen
turns to remove their prior contribution without scanning unrelated history.
Pre-existing facts rebuild in batches of at most 100 turns with a durable cursor;
queries use the authoritative bounded-detail/bulk path until rebuilding finishes.
Other timezones and thread/turn intersections retain the exact generic path.
The Host schedules rebuild batches between event-loop turns, retries storage
failures on its normal recovery tick and cancels work when closed. Day rows are
rebuildable derived data, never a second source of usage facts.


Token usage v10 appends immutable delivery-attempt metadata without changing
v6–v9: verified requester identity, actual dispatch mode, pending/accepted/rejected/
unknown outcome and a native target only when confirmed. An attempt outcome does
not itself admit a participant. Definitive rejection permits a later authorized
queue dispatch to change requester or mode; unknown delivery cannot justify that
conversion. Every attempt retains its original identity. Historical queue-author
receipts only fill unknown identities and never overwrite a verified dispatcher.
A new physical ledger marks surviving pending attempts unknown and records a
replayable acquisition gap. Native ACKs and durable admission facts retain their
separate authority; late reports still revise the original turn.

Owned title-generation jobs and capacity continuations declare system origin at
creation, without matching body text or ID prefixes. Title collection runs before
its presentation filter. A verified empty ephemeral title thread establishes its
counter baseline; the owned unsubscribe ACK retires only its in-memory registry
entry after preceding counter work, retaining persisted usage and provenance.


Token usage v11 adds rebuildable actor/day/model aggregates with per-turn reversible
contributions. The Host updates them in the same transaction as allocations, source
facts and recovery cursors, using exact decimal strings and BigInt arithmetic. A
person contributes one turn to the unfiltered row, even when that turn has several
models; a model-filtered row counts each matching turn once. Frozen turns preserve their acquired contribution and mark incomplete
coverage; they reject subsequent collection. The additive migration resets the existing bounded
projection cursor; existing day contributions are preserved and actor contributions
are built without counting day totals twice. Until backfill is complete, queries
use the exact detail path. No view or plugin owns or repairs these tables.


Token usage v12 repairs pre-v12 projections that omitted frozen turns. It resets
only affected scopes' bounded cursor and removes their frozen actor projection
markers, so the preserved authoritative buckets/allocations can rebuild day and
actor summaries without duplicate contributions. Queries include acquired frozen
usage and count those turns as incomplete, even after collection is re-enabled.
The admin-only `opencraft/token-usage/configure` method toggles this persisted
Host setting; closing the dashboard never changes collection. Invalid scope
fields and non-admin identities are rejected before any write.


Token collection telemetry is process-local and fixed-cardinality: committed
source insert/correction/dedup/exclusion counts, unique gap insertions, reconciliation
count, write/query failures, latest successful acquisition/reconciliation times,
and the most recent 256 write/query latencies. Effects are published after the
outer ledger transaction commits; rollback cannot report collected facts. These
counters never participate in usage arithmetic and reset at process start.
Read responses attach diagnostics only after rechecking the current administrator;
personal non-admin responses contain no diagnostics. No source IDs, prompt content
or credentials become metric labels. The optional Settings view exposes the
same bounded diagnostic snapshot with an explicit process-lifetime explanation.

### Rollout-derived token statistics

Headless now derives token counts and model buckets incrementally from the
server's Codex rollout files. Trusted server-confirmed initiation and successful
steer receipts remain the participation authority. Queries, pagination,
self/team authorization and `equal-turn-v1` allocation retain their existing
contract; the dashboard does not change. This supersedes the live-token-authority
and read-only-worker descriptions below for this Headless mode. Other engines
still do not acquire metering adapters.

One deployment query worker owns `token-usage-derived.sqlite`, a disposable
projection, and `token-usage-retained.sqlite`, a durable minimal source archive.
The latter retains only native timestamps, counters, session/turn/model/provider
routing metadata and a one-time numeric baseline of pre-cutover history. It
contains no prompts, messages, tool results, identity authentication payloads or
credentials. The archive and trusted participation database are **not** caches.
Their immutable migration histories remain validated normally. The derived
file has an explicit semantic/schema version; incompatible versions are closed
and discarded, then recreated through the managed migrations. This exception is
limited to that exact disposable file and never applies to accounts, receipts,
old metering data or retained source evidence. Deleting the derived file rebuilds
the same totals, model buckets and allocations from retained/native evidence and
confirmed receipts; wall-clock timestamps and snapshot revision numbers may differ.

The reader saves a byte cursor and file identity, consumes at most one MiB and
128 metadata events per batch, and retries incomplete tails. Counts and cursor
commit atomically to the source archive. Parser context, exact integer model
sums, allocations and archive position commit together in the projection.
Derived cache migration 4 adds a `(server_id, thread_id, ends_ms)` gap index.
It preserves the preceding cache schema and avoids repeatedly scanning all
retained-history gaps during large rebuilds and active-turn refresh.
Migration 5 coalesces retained-only history into one source incident per thread;
only the last retained turn recovering closes that incident. This avoids one
coverage registration per historical turn without changing counts or shares.
A late source error revises the current turn in that transaction and enqueues a
durable, 32-turn-per-batch refresh of affected historical projections. Coverage
changes, including enabled state with no active turns, advance the query revision.
Stable `token_usage_record` response IDs are the preferred count source, including
compaction responses omitted by native cumulative counters. Duplicate response
IDs are idempotent; conflicting counts remain partial. A turn without exact
response records may use verified `token_count` deltas instead. These sources
are alternatives and never added together. The cumulative thread counter detects
duplicates and discontinuities; first counter observations use last-response
counts rather than inherited cumulative history. Explicit native thread IDs
exclude inherited fork responses.
Provider comes from `session_meta`, model from `turn_context`; absent identities
remain unknown. No extra model call or write to a native rollout is introduced.

Only trusted metering threads are discovered. Relocated/archived rollouts may be
found by filename under the native home, then their native session identity is
verified. Removed/replaced sources never erase retained observations. Source availability is separate from usage
completeness: an archived terminal with verified counts, or a retained pre-cutover
settlement, keeps its settled allocation when the original file is missing.
Malformed/discontinuous count evidence still revokes completeness. Semantic
cache version 4 rebuilds older projections under this rule. Coverage
uses the existing partial/gap fields for missing files, retained-only history,
invalid/discontinuous counts and cache rebuilding. If a missing/invalid source
would reduce an already-known historical total, the retained pre-cutover
baseline preserves that total instead of presenting an unexplained zero.
No-rollout ephemeral history keeps its old numeric evidence with partial
coverage; new unavailable consumption remains missing, not fabricated zero.

After warm-up the worker checks idle sources every **1000 ms** and is notified
of active native events/confirmed participation. Running turns keep provisional
allocation. Acceptance uses the unchanged freshness p95 <=2 s / p99 <=5 s and
settlement <=5 s targets; the unchanged dashboard may add its next <=5 s refresh.
The one-second scheduling interval is a configuration value, not a claim that
these percentiles passed. Initial source import is reported as partial until
caught up. Query work remains isolated from model execution and retains the
1500 ms worker timeout and current bounded request queue.

Cutover uses a clean fixed application build. Before installation, take a
read-only online backup of the existing `token-usage.sqlite`, preserve both it
and `codex-host-queue.sqlite`, and compare each covered turn's old/new totals and
model buckets. Default Headless composition shares one derived query owner
across native `/appserver`, logical `/apphost` and the Codex adapter. The adapter
continues trusted submission/admission recovery and execution metadata, while
its rollout replay and ephemeral counter paths stop writing new token sources.
Participation replay uses its own `participation-rollout:` checkpoint; the old
Token cursor stays fixed so rollback can replay every skipped native response.
It never deletes the former sources. After deployment verify sourceRevision,
health, new source-archive progress, unchanged old token-source rows and query
results. Authenticated employee dashboard validation is separate evidence.

For rollback set `OPENCRAFT_TOKEN_USAGE_SOURCE=ledger` in the existing managed
Headless environment and restart through its normal installation transaction.
This restores the former collector/query composition and its normal native
replay, retaining participant facts written after cutover. Keep all three data
files; never restore an old database over newer participation, and never delete
the retained archive to roll back. Re-enabling derived mode can rebuild its
projection from the retained events and existing receipts. No schema downgrade,
forced Git update or change to account/queue ownership is required.

### Dedicated Token metering owner

Headless deployment reads are independent of the active execution engine. The
`opencraft-server` entry intercepts `opencraft/token-usage/query` on both the
`/apphost` multiplexed transport and the `/appserver` native WebSocket bridge
before DSH/Pi dispatch and uses the existing read-only query worker against the deployment's
Codex ledger and stable Codex server ID. It neither starts a Codex connection nor
opens, imports, migrates or writes the ledger. Missing/unreadable statistics stay
unavailable; this is not DSH/Pi collection support or an empty replacement store.
The trusted ingress authority is checked before and after the read; self/team,
cursor binding, current membership and client retirement retain their existing
semantics. Both ingress paths use the same query protocol session implementation;
the native bridge has one untagged client per socket and the multiplexed path
retains its logical-client identities. Non-query RPC and identity/MCP projection
remain on their original bridge path. Remote Host queries retain their original owner; no cross-node merge
is performed. Collection and configure remain with their existing writer owner.


`TokenUsageStateDatabase` owns `token-usage.sqlite` per physical Codex Host. Its
independent v1 migration contains the existing metering schema and an atomic
legacy-import receipt. Published Host v1–v12 migrations and their checksums stay
unchanged. Queue/identity remain in the selected Host-state file; only metering writes
and the read worker select the dedicated file, so a metering writer lock cannot
lock trusted sender admission.

Before starting collection, the new owner attaches the validated former file
read-only and copies all metering facts, allocations, projections, coverage and
recovery state in one destination transaction. It copies no queue, sender, body
or credential tables. Failure rolls back all copied rows and the receipt; retry
uses the same managed destination. The former tables remain an inactive recovery
source and are never updated by the new collector. Reopen verifies the recorded
legacy scope revisions, skips copying and preserves new data. If an old binary
has written a divergent legacy history after cutover, statistics fail closed and
both histories remain intact; no automatic downgrade or guessed merge is offered.
No account/session data is removed and no published migration is rewritten.

The Host reports both managed outcomes and closes the collector/read worker
before the dedicated owner. Opening/import failure makes statistics unavailable
without making execution unavailable. In-memory acquisition gaps also mark read
coverage partial when an unwritable store cannot persist its own fault. Replayed
native facts may clear only the existing replayable gap categories.


The dedicated `token-usage.sqlite` owner appends migration 2, `token-usage-thread-query-index`, to index `(server_id, thread_id, started_ms, turn_id)` for per-thread date queries. The published isolated v1 and former Host migrations retain their SQL/name/checksum. Managed upgrades back up v1, preserve facts/allocation/recovery state, validate the complete v2 schema, and reject historical checksum mismatch before creating the index; the inactive legacy import remains read-only. No runtime DDL or schema downgrade is introduced.

Generic metering tests, crash/replay fixtures and the synthetic benchmark/load
scripts use the dedicated owner and file. The real CLI usage probe also replays
into that owner. Tests of published Host migrations, legacy import and retained
queue data keep the former database path explicitly. Historical benchmark
results from the combined store do not establish dedicated-store performance;
regenerate synthetic data in a fresh benchmark directory before measuring it.

### Model identity backfill CLI

`scripts/backfill-token-usage-models.ts` targets an existing `token-usage.sqlite`
and an existing Server scope. Supply both explicitly; the tool has no deployment
directory or Server ID default:

```sh
npx tsx scripts/backfill-token-usage-models.ts \
  --data-dir /path/to/host-data --server-id server:example --dry-run
```

`OPENCRAFT_USAGE_DATA_DIR` and `OPENCRAFT_SERVER_ID` can supply these arguments.
The former `OPENCRAFT_CODEX_DATA_DIR` remains an explicit compatibility input.
Missing targets and unknown Server IDs fail without creating a database or scope.
The default preview uses a read-only connection and leaves pending delivery
attempts, model identities and schema untouched. `--dry-run` wins over `--apply`.

For an actual correction, stop the collector first and replace `--dry-run` with
`--apply`. Pending delivery attempts must be reconciled before applying. The tool
uses the dedicated metering owner and canonical ledger correction path; it does
not import or modify the former queue database. Existing native rollout formats,
published migrations and storage compatibility names remain unchanged.


### Owned live table names

Host-state v13 renames the live queue, catalog and catalog-sync tables to
`opencraft_host_queue`, `opencraft_thread_catalog` and `opencraft_catalog_sync`.
Message-attachment v2 uses `opencraft_message_attachments`. Their explicit indices
use the same prefix. OpenCraft owns these tables; native Codex protocols and
native queue import formats are unchanged. Storage diagnostics use
`opencraft-host-state` and `opencraft-message-attachments`, scoped by Host.

These are appended migrations. Published Host-state v1–v12 and attachment v1 SQL,
names and checksums remain unchanged. Host-state v14 separately renames dormant
Bot rooms, command receipts and message slots to `opencraft_bot_*` without
discarding any records; v13 SQL and history also remain unchanged. The
managed owner backs up the previous database, applies the rename transactionally,
validates the resulting schema, and preserves records and prior ledger entries.
Known unledgered upgrade inputs follow the same canonical result; unknown schemas
remain rejected. Failed migrations roll back, and checksum mismatches refuse
opening. Reopening the upgraded owner does not repeat the migration.

New stores use `opencraft-host-state.sqlite` and
`opencraft-message-attachments.sqlite`. For each owner, an existing
`codex-host-queue.sqlite` or `codex-message-attachments.sqlite` is an explicit
compatibility input: it stays at its original path, with its WAL/SHM/journal.
Opening never renames, copies, deletes or merges database files. The metering
import receives the Host owner's selected path instead of assuming the old name.
If both names exist, or either name has sidecars without its main file, opening
fails before creating or modifying a store. Operators must preserve all files
and resolve their identity under the existing stopped-owner recovery procedure;
there is no automatic preference, merge or repair. Path selection is not an
exclusive-writer lock and does not permit concurrent old/new owners.

Ordinary opening therefore retains existing physical names. The separate
[offline maintenance command](#两个-host-自有文件的离线改名) implements explicit
relocation with stopped-owner, conflict, interruption and reverse-name handling;
delivering the command does not run it on installed data. Never start an
older binary against a newly named store: it does not understand the new paths
and may create a separate empty legacy store. An older
managed binary rejects the new migration version. Code rollback therefore
requires the compatible owner or an explicit restoration of the pre-upgrade
backup under the [backup and recovery procedure](#备份与恢复), accounting for any
writes made after that backup; simply starting an older binary is not a data
rollback.

`tests/storage/owned-host-storage-names.test.ts` covers populated ledgered and unledgered
upgrades, preservation of every business table, old ledger/checksum retention,
pre-upgrade backup contents, repeat opening, failure after a partial rename,
retry, refusal by older readers, and both old and new checksum tampering.

`tests/storage/owned-database-path.test.ts` covers fresh and legacy path selection,
reopen/data preservation, refusal without writes when both stores exist or
sidecars are orphaned, unchanged active legacy WAL during path selection, and
metering import from both selected paths.
