# SQLite事务、迁移与投影

继承[适配层规则](../AGENTS.md)。SqliteUnitOfWork独占物理连接、同步事务和savepoint；schema.sql是原始schema，后续版本迁移在database.mjs。当前user_version=20。

repositories.mjs按业务资源分Repository；这些是存取实现，不是新的业务决策owner。应用层通过所属服务/ledger写入，不能从runtime或模型直接跑SQL。ReceptionReadModel使用私有连接且只暴露SELECT投影，不能泄漏driver或命令方法。

新增字段/表须维护旧profile、旧执行快照和回放语义；不能更改旧快照或补造证据。先定状态owner和事务，再加迁移。同步事务拒绝Promise，不能在事务里等待网络/模型/Pi，文件发布应先取得实际回执。当前敏感等待的Vault.describe是同步本地校验，不能直接改成在事务内等待远程Vault。未来远端适配需要显式提交/对账设计。

共享database.mjs与repositories.mjs由涉及的变更顺序整合；只改所属资源，不覆盖其他模块迁移。不要手改真实用户库来绕过用例。

验证：`node --test test/ownership.test.mjs test/completion.test.mjs test/reception-queries.test.mjs`，并跑新增表所属业务的恢复/回滚测试。改共享迁移执行`npm test`。数据清理/索引/备份尚需单独设计，不把删除数据库当升级。

第11版新增execution_report、execution.request_json、reception系统来源/重试、delivery独立回应文本/静默标记和routine原资源范围；旧报告不补造、旧快照不改写。消费状态在reception，不以event日志游标或内存Map代替。测试包含schema1/2/3/4/10迁移与报告/主回合崩溃恢复，见`test/continuation.test.mjs`及原升级测试。

第12版新增execution.guard_json和usage_observation。guard只由ExecutionLedger写入，观察只由UsageService写入；直接调用按宿主ID去重，Pi累计值按work/bucket/mode覆盖，聚合用SQL而非把全部记录读进内存。分页不截断总计，未知项单列。旧数据不补造usage或步数；schema11专门迁移验证见test/guardrails.test.mjs。

第13版新增routine.schedule_json/last_scheduled_at/stop_when和memory_detail。原memory/provenance主表不重建，旧事实默认user/profile，updatedAt=0表示未知，不回填历史日期。metadata写入仍经MemoryService；memory-read.mjs统一删除/作用域过滤，history-read.mjs统一原文SELECT与游标。Query port不泄漏driver；旧schema夹具移除本轮新增字段后再执行历史升级，不能假装旧库已含新列。

第14版新增memory_tombstone、memory_refresh、memory_learning_control和memory_learning的batch_ids_json/temporal/today。事实/墓碑/复查时间由MemoryService写，任务/控制由MemoryLearningService写；两者在原UoW协作。原值为空的旧遗忘不伪造内容；原提议/日期/执行快照保留。promptMemories共享SELECT，个人50/15、当前项目25/10、近期4000字符；主助理还受总contextBytes约束。专项test/memory-parity.test.mjs。

本轮用户明确转为Markdown记忆事实权威；此前本模块“事实保存在memory表”的当前范围退役，memory/detail/provenance作为可重建投影，其他业务表仍权威。SqliteMemoryIndex只负责文件投影与事务提交标记，不可在文件缺失/解析失败时倒灌SQL正文。读取端口仍不暴露业务命令；记忆读前的索引刷新由装配适配器完成，属于缓存维护，不能修改工作/输入/交付。共享文件事务的回滚/崩溃必须单独验证。

0.13/schema15新增memory_shard（writer/来源路径索引）、memory_file_state（文件/缓存版本）与memory_file_commit（文件事务判别收据）。SqliteMemoryIndex是唯一索引重建实现；memory_file_grants只是授权观察缓存。SqliteReceptionReadModel仍私有连接且SELECT-only；装配前置的memory refresh属于可重建缓存维护，不暴露写命令。旧schema夹具必须移除新表和文件权威目录，不能用schema15目录伪装旧库。真实迁移备份/日期/来源和文件恢复入口见memory-files测试。

0.14/schema16增加conversation_context表与frontier索引。SqliteConversationContext只实现该owner的checkpoint存取/有界原文分段，原文不改写。source_json持久保存生成输入，summary_json成功后不可变；父版本CAS在应用同UoW校验。offset按JS UTF-16字符，SQL取单个有界原消息后用slice，不能混用SQLite Unicode码点造成emoji漏字。SELECT-only ReceptionReadModel增加historyMessage，原文查询限原锚点；历史schema夹具移除新表，schema15迁移单独验证。独立runner仍为同步本地UoW，不能直接装入Join网络主线程。

0.15/schema17新增user_message（canonical消息ID外键、唯一payload、state/attempts/next_at/receipt）和delivery/notification.user_message_json。History写原文并调用MessageService在同UoW写消息；旧原文不回填或重发。Result/mailbox仍由Outcome owner结算，通知附件在原选择/合并路径保存。历史夹具移除新表/列，schema16升级专测。read projections增加问题metadata_json仅供choices；SQL读口仍SELECT-only。

0.16/schema18 为 execution 增加固定 harness（旧行默认 pi），增加有界 execution_native_receipt 边界收据。升级前私有 VACUUM INTO 备份，不改旧 snapshot 或原生存储；旧 schema 夹具删除未来表/列。

2026-11-09：memory-read 以参数化条件执行 literal/全部词匹配，保留旧 literal；listMemoryFiles 只 SELECT 当前授权索引，私有 writer 与项目 grant 继续过滤。无需迁移、向量库或新事实副本；匹配空 tombstone 值不能当成任意词命中。

2026-11-09：内部recall可接当前用户text，按最多24个词面重合排序，限量返回；与显式literal/terms搜索分开且不改变其AND语义。沿传入view过滤可见项目，初始3项目选择归接待query owner；不新增索引、写入或向量依赖。

2026-11-09 用户授权BM25实验：SqliteMemoryIndex在原连接创建TEMP FTS5缓存及TEMP触发器，索引key与正文的统一词元；开连接时重建，更新/删除随原事务回滚。不迁移main schema，不改Markdown权威或显式literal/terms语义。内部text召回以OR候选＋BM25排序，scope过滤在LIMIT之前；FTS5不可用时初始化报错，不静默返回空结果。

0.17/schema19-20：execution 解除旧(work_id,revision)唯一键，增加 attempt/predecessor_id/session_root，Work 增加有效执行引用；新增 work_directive、goal、goal_work、work_dependency、execution_dependency。旧ID、快照、报告及外键保留，检查 foreign_key_check；不把旧 Work 伪造为 Goal。新 Goal 查询分页且不暴露资源 grants，SELECT-only。升级前备份改为 schemaN-before-coordination.sqlite，历史夹具用 legacyCoordinationFixture 恢复真实旧表布局。
