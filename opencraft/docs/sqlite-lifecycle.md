# 跨端存储生命周期：SQLite 与 IndexedDB

状态：2026-09-18 第一阶段 client-local 插件文档与设置/安装适配已实现；其余规则仍待逐库落实。保留 node:sqlite、不引入 ORM，没有迁移真实用户数据库。[插件持久化契约](plugin-persistence.md)记录实际能力及未覆盖范围。

当前新增 `opencraft-extensions.sqlite`：版本1基线 SQL/hash 随代码交付，`schema_migrations` 与建表在事务中提交，拒绝未知旧结构和较新/冲突历史。既有其他 SQLite 库尚未全部接入，也没有通用备份/恢复入口。Web 对应实现有原生升级事务、持久 CAS、versionchange 关闭及明确 blocked 错误；尚未新增专门的全局升级提示 UI。

## 1. 设计结论

统一的是数据库生命周期和迁移纪律，不是把全部存储合成一个文件、所有读写搬进一个服务，或让 ORM 类型穿透协议。

- **不可丢的权威数据**：保留文件路径和身份，显式版本迁移；遇到未知结构或失败停止对应服务，不自动清空。
- **可重建的副本/索引**：先证明存在完整重建来源及离线影响，才允许按缓存版本失效重建。
- **启动恢复和维护**：OAuth 未完成事务取消、执行 epoch fencing、过期清理不属于 schema migration；数据库就绪且独占 owner 成立后，由业务 owner 执行。

平台适配器负责物理 schema 升级、事务、路径权限、owner 生命周期、备份和错误投影；领域/插件负责内容格式转换。SQLite 保留现有驱动与 repository，不为升级需求全面改写查询。不建设 SQL diff、通用 ORM、跨数据库事务或可执行任意脚本的迁移框架。

## 2. 现有存储清单

以下是源码事实，不是拟合并的数据库清单。Main 路径由 Electron userDataDirectory 确定，Host 路径由 Host dataDirectory 确定；Renderer 不提供任意路径。

| 数据库/存储 | Owner | 数据性质与升级策略 |
|---|---|---|
| `opencraft-ui.sqlite` | Electron Main / UI preference repository | 用户偏好；虽可恢复默认值，也不得静默丢弃；保留 CAS |
| `opencraft-connectors.sqlite` | Electron Main / Connector configuration repository | 连接选择意图，不含凭据；必须迁移保留 |
| `opencraft-managed-connectors.sqlite` | Host / Connector repository | 实例、凭据、OAuth 事务；按文件最严格策略保护，不当缓存 |
| `opencraft-threads.sqlite` | Host / Thread catalog | 人工标题、归档、关系、配置；不能由引擎历史完整重建 |
| `opencraft-session-routing.sqlite` | Host / session routing | 逻辑/原生身份、generation、水位和待提交 intent；不可清空 |
| `opencraft-executions.sqlite` | Host / execution authority | epoch、执行日志、待发送输入及队列；不可盲目重建或重放 |
| Expo replica SQLite | Native replica adapter | 独立异步驱动的副本存储；需证明每类内容均可重建后才清缓存 |
| Web preferences / Connector configuration IndexedDB | Web 平台适配器 | 客户端本地设置/选择；不能因升级而当作可重建缓存清空 |
| Web replica IndexedDB | Web replica adapter | 与 Native replica 相同的重建语义，不与唯一数据混存 |
| SQLite debug reader | Electron Main 只读消费者 | 不建表、不迁移，不扩大到凭据库 |
| DSH / Hermes 内部存储 | 对应引擎 | 不由 OpenCraft migration runner 接管 |

`DSH` 出现在类名里不改变所有权：`DshSessionRouting` 和 `DshExecutionAuthority` 是 OpenCraft 的持久化策略。后者调用的 journal/queue 当前也自行建表，迁移时必须收归同一个 execution DB schema owner；不改 `ref/`，不保留两份 DDL 真源。

首批同时验证一个 SQLite owner 和对应 Web IndexedDB 适配；已有六个 Node SQLite owner 分批迁移。Expo 纳入契约测试计划，不在未做 Native 验收时声称已接通。现有 JSON 项目/模型配置和引擎存储不顺带迁移，Web 保持 IndexedDB，不换成 SQLite WASM。

## 3. 参考证据与不能照搬的部分

### Paseo

用户授权克隆的 [官方仓库](https://github.com/getpaseo/paseo) 位于 `ref/paseo`，固定审阅提交 `3cc4ae28664493b2f1ad75a6a6ed1d318c76e944`。未安装依赖、运行参考脚本或提交参考目录。

- [SQLite row store](../../ref/paseo/packages/app/src/runtime/replica-cache/row-store-sqlite.ts) 在 `meta.schema_version` 不等时，事务内重建 rows 并更新版本；这是 replica cache，不是唯一历史库的升级样板。
- [Native adapter](../../ref/paseo/packages/app/src/runtime/replica-cache/row-store.native.ts) 使用 Expo SQLite；[Web adapter](../../ref/paseo/packages/app/src/runtime/replica-cache/row-store.web.ts) 使用 IndexedDB。二者共享存储语义和 [contract tests](../../ref/paseo/packages/app/src/runtime/replica-cache/row-store.contract.ts)，不共享物理驱动。
- [AgentStorage](../../ref/paseo/packages/server/src/server/agent/agent-storage.ts) 的权威元数据使用每 Agent JSON、校验和按 ID 串行原子写入；不能称 Paseo 是 Drizzle 迁移的先例。原子 rename 也不自动构成断电耐久性或跨进程锁保证。
- [设置迁移](../../ref/paseo/packages/app/src/hooks/use-settings/migrations.ts) 使用稳定 migration ID，先写数据再写标记，并保留未知 migration ID。[测试](../../ref/paseo/packages/app/src/hooks/use-settings/migrations.test.ts)覆盖数据失败不写标记、标记失败可重试、迁移后用户选择不被再次覆盖。SQLite 有事务，应让数据与账本同事务提交，不机械复制两次 KV 写入。
- [workspaceId 回填](../../ref/paseo/packages/server/src/server/migrations/backfill-workspace-id.migration.ts)仅补缺失字段，有明确兼容期注释；业务回填属于领域 owner，不是通用 SQL runner 的 if/else。

本轮读了相邻测试，未执行 Paseo 测试；不宣称其桌面/Native 实机行为已验收。未在所查生产存储入口发现通用 SQL 迁移账本、升级前备份或任意降级承诺。

### BB / Codex / WB

- BB：参考 `ref/bb/packages/db/src/{migrate,migration-history}.ts`，借鉴迁移账本、已发布历史校验和破坏性清理前保留数据；不复制其大量分支修复特例。
- Codex：本地 `ref/codex` 是 Renderer。补查官方 [runtime migrations](https://raw.githubusercontent.com/openai/codex/main/codex-rs/state/src/migrations.rs)的未知新版记录容忍及已知 checksum 校验；不能由此承诺任意 destructive migration 可降级。
- WB：`ref/wb` 只证明历史迁移状态/完成通知和恢复提示消费，不证明后端 SQL runner。借鉴长任务不堵启动和明确数据损失提示，不照搬静默修复唯一数据的策略。

## 4. 版本与兼容模型

分别管理：程序 buildId；插件版本与 SDK 兼容范围；数据库身份/文件世代；SQL migration history / IndexedDB database.version；JSON payload format；revision/CAS；AppServer 协议及引擎存储格式。任意两者不能借用同一个 version。

首轮不改文件名，不建立程序版本与 schema 版本的对应关系。领域 repository 隐藏驱动类型，RPC/DTO、CAS、线程身份契约保持不变；SQL 版本与 IndexedDB 版本不必同号。

兼容规则先保守：新程序可沿已验证旧库链向前升级；已知迁移 checksum 不一致或存在未知/缺失历史时拒绝写入。未来只有具备旧二进制读写回归证据的 additive 变化，才可单独开放较新 schema 访问。暂不设计一个没有真实消费者的动态兼容能力语言。

**已发布的不带守卫旧客户端无法被新 metadata 阻止。** 过渡期必须保持旧表/字段及语义兼容，避免位置式 `INSERT ... VALUES` 因加列破坏；破坏性升级留待所有受支持 owner 已接入守卫之后。备份旧 `.app` 不等于数据库降级能力，也不能自动恢复旧 DB 覆盖升级后的新记录。

JSON payload 由领域 codec 负责前向迁移；遇到未知较新格式禁止将默认值写回。业务设置迁移不得在每次启动重置用户后来修改的选择。数据修正仍随不可变迁移资产交付，不能靠随时间变化的默认值、网络请求或模型调用决定结果。

## 5. 打开与升级流程

`定位 owner → 确认独占生命周期 → 只读识别/计划 → 必需备份 → 事务迁移与账本 → 校验 → 业务恢复 → ready`

- 同一物理文件只有一个业务写入 owner；Main 管 Main 两库，Host 管 Host 四库。不同 profile/Host 不通过相同文件名共享所有权。
- 锁与 `busy_timeout` 有界。数据库事务不等于整个进程生命周期锁，也不保护多个独立数据库的一致性。接入现有 Daemon 所有权，验证双启动竞争、旧进程仍存活和崩溃后恢复；不凭 PID 文件存在与否判断可抢锁，不持 SQL 写事务跨网络/用户等待。
- 检查和执行之间必须重新验证计划，不能在锁外读版本后无条件应用。SQL migrator 在受控连接上执行，不叠加嵌套 BEGIN。
- 小型 schema 变化在 ready 前执行。大规模可重建回填用独立 job ID、checkpoint、幂等批次、取消与状态；完成 schema 迁移不冒充回填完成。
- 启动恢复只在真实 owner 上运行一次。另一个读者打开库不能取消在运行 owner 的 OAuth，也不能 fence 仍在执行的任务。
- 失败区分 busy、权限/磁盘、历史不匹配、结构不支持和损坏；不把任意 SQL 错误当 corruption，不循环自动删库重试。必要时保留 Shell 并将对应 Host/功能投影为不可用，不伪装 ready。

### 无版本旧库的首次接管

空库走完整基线；已有库按有界结构指纹识别已知历史变体（表/列/约束/索引/STRICT 等实际语义），不只看某表是否存在。至少覆盖 routing 的无 intent / 有 intent 变体，以及 execution journal/queue 的完整表集。

先备份，校验并补齐已知差异，再建立基线账本；不得对未知旧库直接盖“已迁移”标记，也不得重跑 CREATE TABLE 覆盖已有数据。新库与旧库接管后必须达到同一目标 schema；接管测试必须证明旧记录、CAS 和身份不变。

### 备份与恢复

首次接管和之后变更权威 schema 前制作一致性备份，优先使用经验证的 SQLite backup API；不复制正在写入的单个 `.sqlite` 丢下 WAL。备份目录/文件继承私有权限，记录非敏感数据库身份、迁移前后摘要和校验信息；不得上传或把凭据内容写入日志。

有备份要求却无法完成时不执行迁移。备份保留至少本次升级前有效恢复点；清理不能发生在升级成功确认前。恢复只在所有 owner 停止后显式执行，说明会丢弃哪些备份后的数据；库损坏和版本不兼容不是同一个恢复分支。临时 OAuth 内容不因恢复旧备份自动复活。

## 6. 执行机制与文件拓扑

本期不引入 Drizzle 或其他 ORM，也不更换 node:sqlite。SQL 采用 BB 插件 helper 同等边界的小型执行模块：不可变、有序 SQL 资产，`schema_migrations(version, name, checksum, applied_at)` 单一账本，受控事务执行与严格历史检查。实现前可用成熟兼容工具替代执行细节，但必须满足同一 contract，不能为工具切换驱动或增加第二本账；工具选择不改变公共 SDK。

这是有意保留的有限平台代码，不宣称“零自研”：不做语句生成/解析、依赖 DAG、自动 down migration 或在线重建规划。SQLite 用事务；IndexedDB 用原生版本升级事务，不强迫两者运行同一 SQL runner。

Web 适配器必须处理 `upgradeneeded`、`blocked`、`versionchange` 和较旧版本打开新库的失败；旧连接收到版本变化后停止新操作、等待正在提交的事务收敛、关闭连接并提示刷新，保留页面草稿，不能自动重载丢输入。阻塞有可观察状态，不永远转菊花，不自动删除库。物理升级事务内不等待网络或任意异步任务。广播只通知已提交 revision 失效，不替代跨标签事务/CAS。

Web 没有桌面文件备份能力，不伪装一致：原生升级事务负责 abort 回滚；不兼容的破坏性变更若需要独立可恢复副本，先实现并验证浏览器适用的保留方案，否则阻止该迁移发布。客户端回滚也不能通过删库“修复” VersionError。

拟议拓扑（不是新增现存文件）：

```text
packages/sqlite-node/src/
  connection.ts           Node 驱动、文件权限和关闭
  lifecycle.ts            open/migrate/ready 编排，不含业务表
  migrations.ts           小型 SQL 执行、单一账本及历史校验
  backup.ts               一致性备份及恢复前置
  errors.ts               非敏感错误分类
<各数据库 owner>/storage/<domain>/
  migrations/            该库唯一的不可变 SQL schema 历史与 manifest
  legacy-baseline.ts      有界旧库识别，仅首次接管使用
  repository.ts           领域 codec、查询与 CAS
```

共享包禁止导入 Feature/React、账户服务、DSH/Hermes；领域层禁止把连接对象传过 IPC。SQL 留在 repository、迁移、诊断和必要低层 adapter 中，不是插件修改核心表的后门。Web 升级代码共置于对应 IndexedDB adapter；共享的是语义/测试而不是数据库操作类型。一个物理库的 schema/migration 集合只有一个 owner。

开发时提交可审阅 SQL，已发布文件不修改；分支合并必须检查排序/冲突/校验和。生产启动只运行随制品携带的不可变迁移，不动态 diff/对齐用户数据库，不依赖本机仓库 cwd、不联网下载迁移。SQL 资产/manifest 必须进入 Main/Daemon 对应 bundle 或 resources，并有发行包检查。

## 7. 分阶段实施与证据门禁

1. **基础契约验证**：验证现有 DatabaseSync、同步事务、STRICT/foreign key、SQL 账本与 IndexedDB 升级、打包后资产可用。不得切换驱动或自动安装 ORM。
2. **双后端纵向试点**：Connector configuration 的 Main SQLite 与 Web IndexedDB，完整旧库升级、CAS、错误和各平台恢复策略；同一语义 suite，分别做真实 Electron 与浏览器多标签验证。
3. **凭据库**：Host Connector 接入，验证 secret 不回读/泄露、OAuth 恢复与 schema migration 分离。
4. **其他权威库**：UI preferences、thread catalog、routing、execution，保留领域语义；移除分散初始化 DDL。队列、epoch、native identity 在切换前后不变。
5. **插件接入与交付验收**：依照插件持久化契约接入现有扩展运行时，测试重载撤销、命名空间和 payload 升级；实际打包应用用合成旧 profile 升级，重启、读取、写入，多进程/多标签竞争和升级失败不得只以单元测试替代。

必测：空库、无账本各历史形态、跨多版本、重复启动、迁移中断回滚、提交后应答丢失、checksum/缺失资产、磁盘不足/权限、双启动、较新 DB 被旧客户端打开、保留未知 payload、跨库部分升级后的重试、真实打包路径，以及用户升级后新写入不被自动回滚覆盖。

本轮只核对源码/测试与设计文档，不宣称以上门禁已执行。设计过程和后续实施状态见 [任务计划](../design/sqlite-lifecycle/task_plan.md)。
