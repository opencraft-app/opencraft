# 代码与 Contract 规则

本页承接根 [AGENTS.md](../../AGENTS.md) 中的代码级约束；存储生命周期细节见 [sqlite-lifecycle](../architecture/server/sqlite-lifecycle.md)，按组件的库、版本与跨组件升级规则见其[第 0 节](../architecture/server/sqlite-lifecycle.md#0-按组件的数据库升级总览)。

## 网络主线程不得阻塞

- 承载连接、路由和消息分发的主事件循环不得执行阻塞 IO，或直接调用 SQLite 等具有阻塞风险的同步原生库。文件、数据库、锁等待、迁移及恢复操作交给有明确生命周期的 Worker/独立进程，主线程通过异步端口等待；`async` 包装、Promise/microtask 或 `setImmediate` 不会把同步调用移出主线程。
- 周期观察和消息热路径消费内存投影；不变状态不得反复写库或刷新持久时间戳。需要持久化的状态转换仍须保序、可靠提交；依赖提交的通知/确认不得提前发布。Worker 失败不得退回主线程执行同步 IO。
- 验证同时覆盖：主线程 SQL/阻塞 IO 调用守卫、存储锁等待期间连接/定时器继续运行、提交顺序、失败与重启恢复、关闭前排空。存量同步路径须如实登记并逐项迁移，不能因写入本规则就宣称全链路已无阻塞，也不能把存量路径当新增实现的豁免。登记与守卫为 `config/main-thread-sync-io.json` 和 `scripts/check/check-main-thread-sync-io.mjs`（`check:boundaries`）：从各网络进程入口沿 import 求主线程可达代码，统计同步文件/进程/SQLite 调用及以字面量传给 `prepare`/`exec` 的 SQL 语句，只许减少；新增网络进程须登记入口。迁移 SQLite/同步文件持有者复用 `@opencraft/worker-owner`（FIFO 调用、致命错误隔离、关闭前排空、无主线程回退），网络线程读内存投影、异步等待写入。

- 在系统边界解析并校验未知数据，内部传递已收窄类型；一次性类型留在调用方，只有真实跨包 contract 才进入 `packages/`。
- Optional/nullable 字段必须表示真实缺失。默认值只在 authority 边界填充；声明但忽略的 capability、route、command 或 wire 字段必须删除或端到端实现。
- 协议变化必须同时检查声明、生成类型、Host/provider adapter、持久化/恢复、失败语义和兼容测试。共享 TypeScript 能编译不等于已部署 Host 兼容。
- 内建 UI Preferences 统一消费 `UiPreferencesRuntime`；插件的个人本地呈现偏好可消费可选 `api.localPreferences`，由平台隔离产品/插件/账号与激活生命周期、插件持有 schema；不代替业务文档 CAS 或共享账号 authority。React 不直接选择 localStorage、IndexedDB、SQLite 或远端存储。scope、adapter、CAS 和正式 key 以 [UI preference authority](../architecture/platform/storage-and-preferences.md#ui-preference-authority) 为准。
- Desktop 路径必须消费 [Directory identity charter](../architecture/identity/product-identity.md#directory-identity-charter) 的唯一 resolver：生产数据根必须使用核心产品规范名称，旧产品目录只允许作为显式配置的幂等迁移输入；Main/Daemon/DSH 显式使用 runtime cwd，Thread workspace cwd 必须来自 Project/Thread，禁止回退 `process.cwd()`。
- Hermes 的 Console 适配源码和生成工具属于下游产品，不是独立核心的安装或默认检查依赖。下游产品工作区持有机械生成层；不得直接编辑，须修改其前端真源后运行该产品的同步及只读漂移检查，连同 `UPSTREAM.json` 提交。详见 [历史与消费契约](../history/upstream-history.md)。
- Server 六类核心数据由 `@opencraft/storage-node` 持有统一连接、Drizzle schema 和明文 SQL；新增迁移运行 `npm run generate:storage`，检查 `npm run check:storage` 和 `npm run test:sqlite-node`。领域 repository 借用 owner 连接；`server/legacy.ts` 中已发布旧库 SQL/name/hash 不可改写。Headless 与离线账号/权限管理工具走同一存储入口，不再写六个旧文件。
- SQLite 表结构变更只在该库 owner 的 migrations 列表追加连续 version N+1；不得改写已发布迁移的 SQL 原文、名称或版本。生命周期与恢复契约见 [sqlite-lifecycle](../architecture/server/sqlite-lifecycle.md)。
- OpenCraft 自有 SQLite 的新增运行时 `CREATE TABLE` / `ALTER TABLE` 只由迁移执行；业务初始化与恢复不得另建表或按列探测补结构。测试 fixture 与下述保留的上游镜像不作为升级 authority。
- 所有 OpenCraft 自有 SQLite 库必须经 `openManagedDatabase` 打开并暴露 outcome；owner 负责独占生命周期、关闭和处置摘要，不得吞掉迁移失败后继续宣称 ready。
- 改表必须有从上一版本结构升级并保留业务数据的测试，以及已记录 checksum 不一致时拒绝打开的测试；空库测试不能替代升级测试。
- hypernode 的 `initializeSchema` 保持与 executions 基线一致，OpenCraft 不得依赖构造器建表或升级；改表同时维护 executions 基线迁移与初始化声明的一致性，运行 `tests/execution/dsh-execution-authority.test.ts` 指纹等价测试。已发布基线仍不可改写，后续版本追加迁移并让等价测试覆盖完整迁移链。

## 边界数据、协议与存储


