# Findings

- 精确搜索发现 6 个 OpenCraft SQLite owner 类：UI preferences、Desktop connector configuration、Host connector database、thread catalog、session routing、execution authority；debug reader 是只读消费者，不是 owner。
- 名称含 DSH 不等于由引擎拥有：session routing 和 execution authority 是 OpenCraft 的会话/执行侧存储，需要纳入清单；DSH 自身数据库不纳入。
- ThreadCatalog 包含人工标题、归档、配置，不是可任意从引擎恢复的纯缓存。
- Session routing 包含 logical/native identity、generation 水位和待提交 intent，不可删库重建。
- 现有 routing constructor 根据列存在性添加 intent，是必须覆盖的至少两种历史 schema。
- ConnectorDatabase 的构造器还执行 pending OAuth 取消与 prune；必须与 schema migration 分开，不计为一次性版本迁移。
- 根 memory 快搜无迁移到 Drizzle 的相关事实；不依赖历史摘要决策。
- 已确认六个数据库物理名称与入口；Host databasePath 由 Host dataDirectory 解析，Main 两库由 Electron userDataDirectory 解析，不由 Renderer 传路径。
- execution DB 除 adapter 中两张表，还由 hypernode journal/queue 类自行建表。移交 DDL owner 必须显式处理，不能保留双重 schema 真源。
- Expo replica 是另一种异步驱动，且当前按 payload schema_version 不匹配清理单个缓存记录；先分辨可重建 replica 与唯一业务数据，不照搬到 Connector/ThreadCatalog。
- Drizzle 官方当前 node:sqlite 指南明确支持现有 DatabaseSync，但安装示例使用 @rc。正式依赖版本/运行时 migrator 必须先做能力门禁；本轮只查元数据，不安装。
- npm 元数据（2026-09-18）：drizzle-orm latest=0.45.2、drizzle-kit latest=0.31.10，rc 均为 1.0.0-rc.4；不能混用 RC 文档与旧稳定包 API。

## 检索/验证异常
无路由 pack 命中，已转有界精确搜索；首次组合读取输出部分截断，后续按文件/段补齐。

## 第一阶段实施事实
- 用户要求文件职责拆分、API 简单，并确认 Host 只供 API、Worker 由客户端插件自行创建；不建设 Host 插件系统。
- 最小公开接口为可空 storage.open(namespace, optionalOptions)，句柄只含 read/compareAndSet/subscribe；默认版本1空文档，限额含包装最多1MiB、深度32。不额外建 KV查询DSL/远端SQL。
- 平台端口、作用域生命周期、文档迁移、既有记录适配、SQLite/IPC、IndexedDB/legacy导入分别小文件；删除旧两套 IndexedDB 设置/安装写入适配，测试迁移至新适配。
- 真实Electron两次重启使用不同origin，真实模块插件通过SDK递增持久数据，安装记录由Main SQLite恢复；没有使用现有用户profile。
- 真实Chromium两标签覆盖CAS/广播、生产factory旧库导入、Cordis清理真实Worker、较新数据拒绝旧实例和原生versionchange关闭。
- 显式缺口：不枚举其他历史随机origin；没有签名新发行包；通用Host文档API、字段schemaVersion通用转换、其他既有数据库备份迁移未做。迁移checksum是制品声明校验，不是新打包器源码完整性证明。
- 过程错误：一次npm命令在仓库根导致workspace不存在，改为opencraft根；Electron NodeNext不能导入整个renderer式runtime barrel，改为纯persistence子入口；一处fixture版本1不合法，改1.0.0；Electron异步waitForFunction等待不足，改为外层IPC权威读取轮询；两个apply_patch上下文/同文件操作校验失败，拆分后成功，未盲重试。

## Host 文档实施事实
- document-storage 是新增仓内共享包，无第三方依赖；纯contract和/sqlite分入口。Electron原SQLite实现移入共享包，基线SQL/hash不变，不重写历史或跨库搬数据。
- Host API由新小模块处理，main仅装配。服务只接受已认证Host会话，沿用现有单用户token；logicalClientId不当作身份，拒绝principalId/path/SQL等未知参数。
- capabilities不打开数据库；没有已解析绝对dataDirectory则不提供能力，不新增homedir/cwd根猜测。读取、CAS、版本倒退保护和scope/revision通知独立于引擎持久化。
- SDK forHost固定client+connectionGeneration，只支持已初始化连接；本地存储可以缺席。停用只清理借用连接上的自身监听/请求，不关闭共享client，不隐式重连/重放/落本地。
- 初次gate失败点为Metro不解析纯包index.ts中的./contract.js；删去多余barrel，将包根直接导出contract.ts，Node子入口保持独立，Expo Web/iOS及完整gate重跑成功。
- 本轮没有部署真实远端Host、接真实账号或模型推理；实际Host+浏览器协议链路仅使用本地引擎握手替身，不以此冒充Hermes等其他Host已支持。
