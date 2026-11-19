# 文件权威、助理分片与多项目记忆

本轮用户要求「这些都看看具体怎么实现的写成agents.md 然后实现起来」。独立runner范围不变，不涉及Join。

## 已核对的Grokbot实现

参考本地非官方恢复/扩展源码a9f633e09d49a85829b8236331b9e21f7e612634。memory-service.ts中的FileMemoryStore使用profile.md、log/YYYY-MM.md和.dreaming的explicit/synthesized/tombstones/next-refresh-at。事实行是`- (YYYY-MM-DD) 内容`；ID按规范化内容产生。直接读文件，不把数据库正文当备用事实源。

UserMemoryStore遍历user-memory/agents，各shard注明agentId/agentName；ProjectMemoryStore先读当前agent的projects.json，再遍历所加入项目的agent shard。agent-state.ts写入默认agent，user/project只能写自身shard；project写入先要求项目存在、slug安全且已经加入。create已有项目相当于join，不覆写原项目说明。

project-membership.ts以原子rename维护projects.json。sand-memory.ts定义private > project > user的提示词优先级、来源标签、数量与字符预算；selectProjectMemoryBlocks先选有事实的项目，再按最近事实/slug排序，最多注入3个，其他仅列出成员项目。

恢复源码存在接缝缺失：host-runner-composition以可选方法查找createUserMemory/createProjectMemory，但检查到的MemoryService没有这两个factory；system-prompt-assembly的project返回形状/参数名也与ProjectMemoryStore定义不一致，另一个assembly入口传入null。不能据此宣称官方产品已运行这整条链路。本轮学习其明确的布局/所有权/聚合规则，并在自己的runner补上真实装配与验证，不照抄接口缺口。

## 当前裁决与对象边界

用户本次要求替代0.12“SQLite为记忆事实唯一权威”的范围：Markdown正式拥有事实，旁车保存来源/墓碑与旧key/revision等元信息；SQLite继续拥有业务任务/输入回执/学习状态，并提供可重建记忆索引。旧schema14和更早的事实只在首次启用时迁移一次，保留原归属、key、revision和未知时间，已有文件不被数据库覆盖。

MemoryService负责业务规则与事实CAS；MemoryLearningService只写本agent拥有的事实，其他agent共享记忆只作带来源的上下文，不得被自动提炼修改。MemoryProjectService负责显式项目创建/加入/退出，文件端口负责落盘；不建立多Bot管理器，不授予文件资料、网络或Shell。

具体文件适配器/事务责任先写入[AGENTS](../src/adapters/memory/AGENTS.md)。文件和SQLite通过可恢复日志协调，不声称跨媒介物理原子性；已确认SQL提交则完成文件后像，未提交恢复前像，外部冲突保留现场并报错。

## 目录布局

```text
memoryRoot/
  owner.json
  agents/<assistantId>/
    agent.json
    projects.json
    memory/profile.md
    memory/log/YYYY-MM.md
    memory/.dreaming/...
  user-memory/agents/<assistantId>/
    profile.md
    log/YYYY-MM.md
    .dreaming/...
  projects/<slug>/
    project.md
    identity.json
    memory/agents/<assistantId>/...
```

每个物理shard一个当前助理写入者；读取共享用户shard与已授权项目shard。原workspace项目仍按materials binding隔离，不能通过资料根变化自动扩权。项目加入生成授权binding，旧输入/执行只持有当时grant；撤销/重新加入不能唤活旧grant。

新profile默认agent，旧profile缺少配置时继续user。memoryRoot缺省属于当前profile，跨profile共享需显式指定相同根和同owner。项目记忆权限与资料访问权限分开，加入项目只授权该项目记忆。

## 实施与验收

按领域地址/授权→文件解析与事务→可重建索引/迁移→项目owner→实际接待/Pi/CLI装配的顺序实现。新增测试记录真实文件内容、来源、索引重建、成员变化、并发/恢复与注入；生产模型/官方服务质量另记，不能把机制fixture当线上复现。当前这份设计与指南先行，完成情况随实现和证据续录。

## 0.13.0 / schema15 实际落地

本节更新先行设计的实施状态。新增[文件存储模块](../src/adapters/memory/AGENTS.md)，没有新增多Bot管理器。三层记忆已装配进接待、新Execution快照和Pi：

- agent：当前助理私有目录，其他助理不建索引、不允许读取；新profile默认写这里。
- user：同owner、显式同memoryRoot下各助理的user shard汇聚，输出保留agentId/agentName；每个助理只能改自己的shard。
- project：create/join/leave形成持久成员资格。每次新加入有独立grant；只把原输入/执行持有且当前仍有效的项目读入，最多3个完整块，其余列为alsoMemberOf。项目身份改变、leave/rejoin都会使旧grant失效。加入项目不产生materials、网络或Shell权限。

原workspace项目仍用materials binding限定；资料根变动不能继承旧项目记忆。命名项目权限与资料访问分开。私有 > 项目 > 用户是提示词优先规则，项目/共享条目均按时间和来源呈现；没有宿主层的语义冲突判定，也不静默删除另一位助理的事实。

实际Grokbot路径是memory/agents，而其中一处提示词写成memory/by-agent；本实现采用实际路径。其恢复代码中synthesis目标来自agent store，共享store没有相同DreamingBridge。本实现保留0.12兼容能力：自动提炼可写本agent自己的已授权user/project shard，其他助理的事实只作为sharedMemories只读上下文；新profile默认agent。不是Grokbot磁盘格式或执行路径的逐字兼容实现。

### 类与窄接口

| owner/入口            | 负责                                                                      | 不负责                               |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| MemoryService         | 事实地址、CAS、内容去重/遗忘、可写来源、epoch/显式屏障、授权范围          | 模型请求、直接fs或SQL                |
| MemoryLearningService | 原grant下证据合并、提议/复核/重试、作业；批次按项目+grant集合分组         | 改其他agent shard、扩大旧授权        |
| MemoryProjectService  | 显式成员操作、inbox回执、变更屏障；只获project/projects端口               | 文件任意路径、资料授权、Work生命周期 |
| MemoryFileStore       | 三层路径、严格文件/元数据解析、旁车、保留人写的非事实Markdown、分片变更集 | 模型、接待、任务/交付决策            |
| MemoryFileTransaction | 短锁、文件前后像、提交判别、逐文件原子替换与冲突恢复                      | 分布式事务、模型调用                 |
| MemoryFileAuthority   | UoW参与者、迁移、文件观察与索引刷新；为调用方投影窄port                   | 业务命令和新的事实权威               |
| SqliteMemoryIndex     | 可重建索引、文件版本/授权hash缓存、事务提交收据                           | 把过时SQL正文倒灌到文件              |
| ScopePolicy           | 当前与原grant交集；项目成员不授予material工具                             | 自行加入项目、读写事实               |

### 文件事实与旁车

事实必须采用`- (YYYY-MM-DD) 内容`；profile.md是稳定事实，log/YYYY-MM.md是日期事实。新事实按500字符规范化；直接编辑文件后下一次读取会同步投影。没有按格式识别的段落仍保留，API写入不能丢弃这些人写内容。未知旧日期用0000-00-00表示，投影时间仍0。

.dreaming/explicit与synthesized使用内容SHA1前16位的空旁车；tombstones使用既有scope内容摘要的空文件，以保留0.12遗忘语义，未强行改写旧ID。.dreaming/records.json只保存key/revision/来源证据/日期与内容ID等元信息，不另存事实正文。旧模型事实ID继续保留scope限定SHA256，避免旧提议重开时引用失效，因此不能直接当Grokbot目录导入器。手工新写事实默认legacy；通过显式命令写入才有explicit来源。

单文件最多8MiB，一次观察最多64MiB/10000文件与10000条投影，目录列表也有界。路径穿越、符号链接、错误JSON/记录形状、未知恢复内容均失败关闭；不以“读取失败”伪装空库。只有固定profile/月度log可经memory.file.read/read_memory_file读取，不能用它访问旁车、profile凭据或任意路径。

### 文件与SQLite的协调

业务事务开始时持短锁、完成遗留恢复、观察文件并刷新索引。准备提交时，对文件版本做检查，持久保存前后像，在同一SQL事务记录提交ID，然后逐文件原子替换；SQL提交后清理日志。崩溃恢复以提交ID决定恢复前像还是完成后像；意料之外的第三种文件内容会报冲突并保留。嵌套savepoint还原自己的暂存变更，失败不会漏出项目加入或记忆写入。

其他助理自动提炼共享事实只刷新观察/上下文，不触发显式记忆屏障；当前助理手改文件、跨助理显式更正/遗忘、成员资格变化继续阻止旧执行使用失效上下文。现代synthesis检查自有事实指纹及显式屏障，其他shard自动积累不使其反复作废；旧持久提议保持兼容校验。

这不是一个跨媒介物理原子事务，也不是完整断电/跨机恢复承诺。当前验证是进程退出/崩溃、写入错误与外部冲突。根锁等待最多250ms；活跃竞争超时返回MEMORY_BUSY。无完整owner的锁、PID复用导致的不确定锁和第三种恢复内容需诊断，不能自动删锁/覆盖文件。没有后台清理未知日志或把冲突回灌旧库。

### 旧数据升级

schema15保留旧memory/detail/provenance为索引，新增memory_shard、memory_file_state、memory_file_commit；原学习/输入/工作仍权威。第一次启用在锁内真正生成文件，再写迁移状态，不能只记“已迁移”。原key/revision/归属/来源和未知日期保留；历史超长正文按现有500字符事实格式投影，完整原始SQL数据原子备份到profile/memory-migration-schema14.json。已有本agent文件时以文件为准，旧SQL仅备份，不反向覆盖。

新旧执行快照、原用户证据与学习提议不重写。旧缺少memoryDefaultScope的profile保持user；新init默认agent。已使用schema15后，恢复应使用本格式兼容程序和文件/业务库一致的备份，不能用旧0.12程序或旧SQL单独降级回灌。完整跨Pi/业务库/文件/Vault备份仍属于后续运维工作。

### 本机操作示例

```bash
node bin/assistant.mjs init --profile ./profiles/work --owner local:me --memory-root /absolute/shared-memory --memory-default-scope agent
node bin/assistant.mjs run --profile ./profiles/work
# 另一个终端；另一个助理用独立profile及相同显式root/owner
node bin/assistant.mjs project-create --profile ./profiles/work --project alpha --name Alpha
node bin/assistant.mjs memory-set --profile ./profiles/work --scope project --project alpha --key deadline --value 'Deadline is November 10'
node bin/assistant.mjs memory-file --profile ./profiles/work --scope project --project alpha --path profile.md
node bin/assistant.mjs project-leave --profile ./profiles/work --project alpha
node bin/assistant.mjs memory-locations --profile ./profiles/work
```

CLI支持project-join/project-list、memory-file的agent-id/offset/limit和scope。主助理结构化协议支持project.create/join/leave与具名project记忆；query支持memory.file.read；Pi只给新Delegation安装read_memory_file，原grant及工具守卫仍检查。上面的init仍默认fixture，不会自行读取共享模型凭据。

验证结果与失败记录见[0018迭代](iterations/0018-memory-files.md)及本轮独立清单；真实模型/IM/OpenCraft内置接入和长期运维仍单独验收。
