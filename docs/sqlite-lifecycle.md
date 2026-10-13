# 跨端存储生命周期：SQLite 与 IndexedDB

状态：2026-10-13 已实现 OpenCraft 九个自有 Node SQLite 库的独立迁移账本、升级前备份与无账本旧库处置；Host 五库在 daemon 启动期打开，处置摘要进入健康检查。保留 node:sqlite，不引入 ORM，不提供自动恢复备份。客户端文档与插件内容迁移见 [插件持久化契约](plugin-persistence.md)，验证边界见第 7 节。

## 1. 设计结论

统一的是数据库生命周期和迁移纪律，不是把全部存储合成一个文件、所有读写搬进一个服务，或让 ORM 类型穿透协议。

- **权威数据**：保留既有文件路径和身份，按账本向前迁移；已知 checksum 不一致、历史缺失或未知新版拒绝打开。无账本旧库按内部开发阶段策略采纳或备份后移开，不能把移开重建称为无损升级。
- **副本/索引**：与权威数据分开；本轮没有新增 replica 清库或重建策略。
- **启动恢复和维护**：OAuth 未完成事务取消、执行 epoch fencing、过期清理由业务 owner 在库打开后执行，不属于 schema migration。

平台模块负责连接、物理迁移、备份和错误分类；进程负责独占 owner 与 ready；领域/插件负责文档格式与业务恢复。保留现有 repository 与 CAS，不建设 SQL diff、通用 ORM、跨库事务或任意脚本迁移框架。

## 2. 现有存储清单

以下九库均经 `openManagedDatabase` 打开并暴露 outcome。路径由可信平台/进程配置确定，Renderer/RPC 不提供任意数据库路径。

| 文件名 | Owner 进程与源码 | 数据目录 | 数据职责 |
|---|---|---|---|
| `opencraft-ui.sqlite` | Electron Main：[ui-preferences-store](../apps/workbench-electron/src/ui-preferences-store.ts) | Electron `userDataDirectory` | UI 偏好与 CAS |
| `opencraft-connectors.sqlite` | Electron Main：[connector-configuration-store](../apps/workbench-electron/src/connector-configuration-store.ts) | Electron `userDataDirectory` | 连接选择意图，不含凭据 |
| `opencraft-extensions.sqlite` | Electron Main：[document-storage/sqlite](../packages/document-storage/src/sqlite.ts) | Electron `userDataDirectory` | client-local 插件文档、设置与安装记录 |
| `opencraft-session-routing.sqlite` | daemon 内 Local Agent Host：[dsh-session-routing](../apps/local-agent-host/src/dsh-session-routing.ts) | Host `dataDirectory` | 逻辑/原生身份、generation、水位与 intent |
| `opencraft-threads.sqlite` | daemon 内 Local Agent Host：[thread-catalog](../apps/local-agent-host/src/thread-catalog.ts) | Host `dataDirectory` | 人工标题、归档、关系与配置 |
| `opencraft-executions.sqlite` | daemon 内 Local Agent Host：[dsh-execution-authority](../apps/local-agent-host/src/dsh-execution-authority.ts) | Host `dataDirectory` | epoch、执行日志、输入及队列 |
| `opencraft-host-documents.sqlite` | daemon 内 Local Agent Host：[document-storage/sqlite](../packages/document-storage/src/sqlite.ts) | Host `dataDirectory` | Host 通用文档；与 client-local 物理分离 |
| `opencraft-managed-connectors.sqlite` | daemon 内 Local Agent Host：[connector-host/store](../packages/connector-host/src/store.ts) | Host `dataDirectory` | 实例、凭据与 OAuth 事务 |
| `account-pool.sqlite` | 独立 codex-core：[account-pool-host/store](../packages/account-pool-host/src/store.ts)、[account service](../packages/account-pool-host/src/codex-account-service.ts) | codex-core `dataDirectory` | 账户元数据、亲和性与配额；secret 文件由同一 owner 管理 |

Electron Main 三库仍按消费入口懒打开。Host 五库统一由 [local-agent-storage](../apps/local-agent-host/src/storage/local-agent-storage.ts) 打开；未配置目录的嵌入/测试入口使用内存库，不提供持久 Host 文档能力。服务器 Host 目录为 `OPENCRAFT_EXECUTION_STATE/data`。account-pool 属于独立 [codex-core](codex-core.md)，不在 gateway/daemon 更新包的五库启动门禁或健康摘要内，升级路径独立。

Web preferences、Connector configuration 与插件文档继续使用各自 IndexedDB adapter；Web/Expo replica 保持原有平台语义。SQLite debug reader 是只读消费者，不建表、不迁移。DSH/Hermes 引擎私有存储、JSON 项目/模型配置不由本 runner 接管。类名中的 DSH 不改变 routing/executions 的 OpenCraft 所有权。

## 3. 参考证据与不能照搬的部分

- [Paseo](https://github.com/getpaseo/paseo) 固定研究版本 `3cc4ae28664493b2f1ad75a6a6ed1d318c76e944`：借鉴权威数据与 replica cache 分类、跨平台共享语义而非驱动、稳定迁移 ID 与失败重试。没有把其 cache 版本不一致就重建的方式用于有账本权威库。
- BB：借鉴迁移账本、不可变历史校验与破坏性处置前保留数据，不复制分支修复特例或引入 Drizzle。
- [Codex runtime migrations](https://github.com/openai/codex/blob/main/codex-rs/state/src/migrations.rs)：参考已知 checksum 校验；OpenCraft 当前严格拒绝未知新版，不沿用其新版记录容忍策略。
- WB：仅借鉴迁移状态/恢复提示的责任分层，没有据此声称 OpenCraft 已有全局升级 UI 或任意降级能力。

这些是设计参考，不是当前运行时验收证据；本轮未运行参考项目测试。OpenCraft 的事实以以下源码、测试和 smoke 为准。

## 4. 版本与兼容模型

每个物理库有独立 `schema_migrations(version, name, checksum, applied_at)` 账本；迁移列表版本从 1 连续递增，SQL 原文由共享模块计算 SHA-256，调用方不提供 checksum。已记录历史必须是当前源码列表的连续前缀，version、name、checksum 全部匹配；未知较高版本报 `newer-schema`，缺失/改写历史报 `history-mismatch`。没有程序版本到 schema 版本的映射，也没有第二份物理 schema 版本轴。

文档 payload 另有版本：[threads document](../apps/local-agent-host/src/thread-catalog.ts) 无 version 的旧记录按 v1 读取，写入显式 v1，拒绝未知新版；[extension records](../packages/document-storage/src/contract.ts) 的 `data_version` 对应文档 `version`，CAS 事务拒绝格式倒退。插件纯内容转换由 [document-migrations](../packages/extension-runtime/src/document-migrations.ts) 管理，不让插件改物理表。

程序 buildId、插件 packageVersion/SDK 兼容范围、SQL 账本、IndexedDB database.version、payloadVersion、revision/CAS、协议和引擎存储格式相互独立。

当前是内部开发阶段，不承诺 N-1 旧二进制兼容，不跑旧二进制回退门禁。无账本旧库在有限结构比较一致时采纳，否则先备份再移开重建；不提供逐库历史形态识别链。已有账本沿经验证的迁移链向前升级，拒绝不匹配历史。旧的无守卫二进制不能被新 metadata 阻止，代码回退不等于 schema 降级或数据恢复。

## 5. 打开与升级流程

### openManagedDatabase

[lifecycle](../packages/sqlite-node/src/lifecycle.ts) 的实际步骤是：

1. 校验连续迁移列表和正整数备份保留数；打开连接，设置 WAL、`busy_timeout=5000`，目录权限 0700、库文件 0600。`:memory:` 跳过文件操作与备份；`foreign_keys` 由业务 owner 设置。
2. 校验已有历史，计算有限结构指纹，区分空库、有账本库和非空无账本旧库。
3. 空库执行完整链；有账本且待升级的非空库/账本库先备份，再逐版本迁移；当前版本无需备份。
4. 无账本旧库在内存目标库执行完整迁移链并比较指纹。一致则先备份，在一个 `BEGIN IMMEDIATE` 事务中重新核对结构并写入全部账本，返回 `adopted`。不一致则先备份、关闭连接、移开旧文件、创建新库并执行迁移，返回 `moved-aside`。不一致的内存旧库无法移开，报 `unsupported-legacy`。
5. 再次校验历史，成功后清理超额备份；返回连接与 outcome。连接由调用方关闭；失败关闭当前连接并抛分类错误。

每个待应用版本在独立 `BEGIN IMMEDIATE` 事务内再次校验历史、执行 SQL 并写账本；失败回滚该版本，已提交版本保持有效。各库不是一个事务；后续库失败不撤回之前库的升级，重启时按各自账本续行。

指纹由 [migrations](../packages/sqlite-node/src/migrations.ts) 比较用户表集合、`PRAGMA table_info` 的 name/type/notnull/dflt_value/pk 和索引名；排除 `sqlite_*` 与账本表。它不校验索引定义、CHECK、外键、触发器或 STRICT，不是完整 schema diff。“一致”仅指这个有限比较。routing 无 intent 的旧库移开，有 intent 且结构一致的旧库采纳。

旧库及仍存在的同名 WAL/SHM 各自原子重命名为 `.legacy-<时间戳>`，文件保留、不自动清理。文件集合不是跨文件原子操作；rename 失败撤回本次已完成的 rename。调用方必须保证没有其他活跃连接。

### daemon 启动与 owner

[daemon main](../apps/opencraft-daemon/src/main.ts) 取得 Host 存储 owner 后，检查旧 IPC socket，打开全部五库，再监听 IPC；存储失败释放资源、拒绝监听，启动入口非零退出。DSH 引擎仍在首次创建 local Host transport 时懒启动。[Local Agent Host main](../apps/local-agent-host/src/main.ts) 消费已打开的存储，业务恢复与资源清理由 owner 执行；嵌入入口未传入 storage 时自行打开五库，独占责任仍在调用方。

[daemon-storage-owner](../apps/local-agent-host/src/storage/daemon-storage-owner.ts) 用短互斥串行化 claim/release，记录 PID 与随机 claim，活 PID 阻止第二个 daemon 接管；死 PID 可在互斥内替换。随机 claim 确保释放者只删除自己的记录。短互斥不跨越同步迁移，整个存储生命周期没有 heartbeat；不是凭锁文件存在或 heartbeat 超时推断旧 owner 已死，也不是 SQLite 自身的跨库锁。当前检查的是 PID 存活，不承诺 PID 重用身份识别。

[daemon/ready.storage](../packages/daemon-ipc/src/index.ts) 是可选的五库摘要：name、status、appliedVersion、可选 backupPath、movedAside；不传记录或连接。[daemon server](../apps/opencraft-daemon/src/server.ts) 在认证握手回传摘要，[gateway `/health`](../scripts/server-deployment/gateway.mjs) 经过 daemon IPC 与外部 core 健康检查后附带 `storage`。status 为 fresh / up-to-date / migrated / adopted / moved-aside，摘要表示本次打开处置，不是备份目录清单。存储失败不伪装 ready，更新器沿既有健康失败回退逻辑处置，`ok` 判定不变。

### 错误分类

[SqliteLifecycleErrorKind](../packages/sqlite-node/src/errors.ts) 有六类：

| kind | 当前含义 |
|---|---|
| `busy` | SQLite BUSY/LOCKED |
| `history-mismatch` | 列表不连续或已有 version/name/checksum 不匹配 |
| `newer-schema` | 库含当前源码未知的较高版本 |
| `unsupported-legacy` | 无法移开的不一致内存旧库 |
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

executions 中 hypernode 表 DDL 以 [DSH_EXECUTION_BASELINE](../apps/local-agent-host/src/dsh-execution-authority.ts) 为基线权威；[execution-authority](../apps/local-agent-host/src/hypernode/execution-authority.js) 与 [thread-queue](../apps/local-agent-host/src/hypernode/thread-queue.js) 的 `initializeSchema` 原文保留为上游镜像。当前构造器仍调用镜像中的 `CREATE ... IF NOT EXISTS`，在已完成基线迁移的库上为 no-op，不承担表结构升级。[check-dsh-source](../scripts/check-dsh-source.mjs) 核对参考源，[指纹等价测试](../tests/dsh-execution-authority.test.ts) 防止基线与镜像漂移。已发布 SQL 不改写，后续结构变化追加版本迁移；hypernode 变更还需同步基线与参考镜像，不能建立第二份升级 authority。

IndexedDB 使用原生升级事务，不运行 SQL runner；广播仅通知已提交 revision 失效，跨标签 CAS 仍由事务保证。浏览器没有桌面文件快照能力，不把 abort 回滚称为文件备份，不通过删库处理 VersionError。

## 7. 分阶段实施与证据门禁

### 已完成

- 九库接入共享生命周期；document-storage 保持原 v1 SQL/hash，extensions 与 host-documents 共用实现但账本各自独立；threads 增加 payload 版本守卫。
- Host 五库启动门禁、owner claim、认证 ready 摘要及 gateway 健康投影；OAuth 清理与 execution fencing 保留在业务 owner。
- [共享模块测试](../tests/sqlite-node.test.ts) 覆盖空库、旧库采纳/移开、多版本升级、重复打开、checksum/未知新版拒绝、事务回滚、WAL 备份与保留；各 store 测试验证原领域读写/CAS 和旧库处置。
- [Host storage 测试](../tests/local-agent-storage.test.ts)、[daemon 测试](../tests/opencraft-daemon.test.ts)、[更新器测试](../tests/server-deployment.test.mjs) 覆盖双启动、启动失败拒绝 ready、五库摘要与健康失败回退。
- [服务器 smoke](../scripts/smoke-server-updates.ts) 的本地证据位于 `.local/server-updates/proof.json`：routing 移开、threads/managed-connectors 采纳，备份/legacy 文件存在；升级/回退后五库 up-to-date，较新账本导致 daemon 拒绝。真实 npm、生产 SPA、打包 gateway/daemon 与 Codex CLI，推理为合成回环服务，systemd 为隔离进程重启替身；两版 release 均由当前源码打包。

### 明确未做

- Electron Main 三库仍懒打开，没有 UI 呈现生命周期处置结果；本轮不新增全局升级/恢复提示。
- Web 插件文档已有 blocked 错误与 versionchange 关闭；preferences/Connector configuration IndexedDB 的 blocked/versionchange 缺口未变，不声称所有 Web 库都有升级协调。
- 未跑 N-1 旧二进制回退，不承诺任意降级；不自动恢复备份，不提供恢复 UI、跨库原子升级或大规模在线回填框架。
- 未迁移真实用户数据库；未以本轮九库工作覆盖 Native adapter、所有远端 Host、历史所有 Electron origin 找回或新签名发行包验收。

历史设计与实施记录见 [任务计划](../design/sqlite-lifecycle/task_plan.md)、[进展](../design/sqlite-lifecycle/progress.md)。本分支尚未推送或发布，源码与 smoke 证据不代表线上部署已升级。
