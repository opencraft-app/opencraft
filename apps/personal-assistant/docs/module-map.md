# 模块分治地图

2026-11-10 新增 0.17/schema20 [长期目标与连续执行](coordination-ownership.md)：有界 DAG、优先级、同要求原生会话续接、有序补充、依赖失效与显式重做，保留原业务 owner。它扩展了此前仅只读概览的范围；实际验证见[本轮记录](coordination-validation.md)。仍为独立 lab，未部署 Join。

当前：独立无界面runner 0.17.0 / schema20。2026-11-02用户要求按模块放AGENTS.md，便于分治。owner在这里指代码职责，不是人员身份。已有业务能力与验收范围见[六项台账](superapp-capabilities.md)，后续开发见[路线](roadmap.md)。

2026-11-10：[多工作协调](work-coordination.md)复用原接待查询/提议和 Work/Interaction/Execution/Outcome；增加只读概览及定向输入约束，没有新状态 owner 或数据库迁移。

## 从哪里进入

先读[根AGENTS](../AGENTS.md)，再读[源码入口](../src/AGENTS.md)和目标目录AGENTS。规则逐层继承；子目录补充本模块约束，不解除根目录的范围、数据和凭据约束。新增真实模块文件夹时同批增加AGENTS；样本数据、历史迭代、临时profile不机械生成文件。

| 分治单元   | 地图/入口                                                                 | 自己负责                               | 不接管                          |
| ---------- | ------------------------------------------------------------------------- | -------------------------------------- | ------------------------------- |
| 领域       | [domain](../src/domain/AGENTS.md)                                         | 身份、版本、纯规则、授权值对象         | 数据库、模型、调度              |
| 核心用例   | [application](../src/application/AGENTS.md)                               | 各owner写入及跨对象事务                | 具体I/O、原生checkpoint         |
| 接待       | [reception](../src/application/reception/AGENTS.md)                       | context/query/planner                  | 最终命令提交、任意路径          |
| 工作上下文 | [conversation-context](../src/application/conversation-context/AGENTS.md) | 主会话派生摘要、覆盖游标、重试         | 原文/事实记忆、业务状态、Pi压缩 |
| 用户消息   | [messages](../src/application/messages/AGENTS.md)                         | 用户消息/有界重投/渠道接受             | 工作完成、问题状态、凭据、原文  |
| 技能       | [skills](../src/application/skills/AGENTS.md)                             | 安装、启用、版本、加载回执             | 新工具授权、第三方代码运行      |
| 证据学习   | [memory](../src/application/memory/AGENTS.md)                             | 原证据、提议、复核任务、恢复           | 直接改记忆值                    |
| 事件与关注 | [automations](../src/application/automations/AGENTS.md)                   | 规则/发生/基线，活动/提醒状态          | Work生命周期、安排状态          |
| 用量观察   | [usage](../src/application/usage/AGENTS.md)                               | 模型回执、Pi累计快照与有界查询         | 扣账、工作生命周期              |
| 接口语义   | [ports](../src/ports/AGENTS.md)                                           | 输入、回执、取消/恢复契约              | 假实现、存储句柄                |
| 入站请求   | [interfaces](../src/interfaces/AGENTS.md)                                 | envelope                               | actor授权、业务CAS              |
| I/O导航    | [adapters](../src/adapters/AGENTS.md)                                     | 适配器选择和边界                       | 独立业务状态机                  |
| 持久化     | [sqlite](../src/adapters/sqlite/AGENTS.md)                                | UoW、迁移、repository、只读投影        | 模型/I/O事务、业务决策          |
| 原生执行   | [pi](../src/adapters/pi/AGENTS.md)                                        | Harness、工具、checkpoint恢复桥接      | 第二份原生任务账本              |
| Codex 原生 | [codex](../src/adapters/codex/AGENTS.md)                                  | 隔离原生进程、结构化推理、持久线程续接 | 业务状态、第二份原生任务图      |
| 模型交换   | [models](../src/adapters/models/AGENTS.md)                                | provider、JSON提议/复核、fixture       | 业务写入、凭据外泄              |
| 文件能力   | [filesystem](../src/adapters/filesystem/AGENTS.md)                        | 资料、产物、mailbox、变化源            | 任意根、源权限、主历史          |
| 本机能力   | [local](../src/adapters/local/AGENTS.md)                                  | profile、socket、Vault                 | 平台认证、远端认证成功结论      |
| 运行装配   | [runtime](../src/runtime/AGENTS.md)                                       | 临时请求、句柄、锁、关闭               | 持久业务事实                    |
| CLI        | [bin](../bin/AGENTS.md)                                                   | 参数、帮助、输出、专用安全输入         | 业务分支、命令去重账本          |
| 能力场景   | [scenarios](../scripts/scenarios/AGENTS.md)                               | 按能力的输入、断言与复查项             | 产品状态、真实模型质量结论      |
| 验收脚本   | [scripts](../scripts/AGENTS.md)                                           | 隔离场景、演示、采证                   | 隐藏凭据、质量通过开关          |
| 测试       | [test](../test/AGENTS.md)                                                 | 行为、边界、恢复证据                   | 共享profile、模型质量推断       |
| 设计文档   | [docs](AGENTS.md)                                                         | 当前地图、计划、历史事实               | 用旧轮次覆盖当前状态            |
| 样本       | [examples](../examples/AGENTS.md)                                         | 合成资料与可安装内容包                 | 真实秘密、业务权威              |

src本身也有入口AGENTS；共23份子目录AGENTS，加上根规则共24份构成导航。工作、执行、交付、等待、通知等核心文件仍平铺在application，其文件组归属在该目录AGENTS列出；没有为了地图复制或搬动实现。

## 核心状态找谁

| 需要修改的事实             | 唯一业务owner         | 接入方式                                  |
| -------------------------- | --------------------- | ----------------------------------------- |
| 收到输入/稳定回执          | InputInbox            | 同一UoW接收回调                           |
| 工作目标/revision/状态     | WorkService           | submit/amend/cancel及受控生命周期方法     |
| 快照、不可变报告、原生绑定 | ExecutionLedger       | ExecutionService协调                      |
| 完成依据/评估              | CompletionLedger      | CompletionService收集可信I/O回执          |
| Result/Delivery            | OutcomeLedger         | OutcomeService协调接受与完成              |
| 用户可见历史/关联          | ConversationHistory   | append/link/result/batch等实际需要的facet |
| 接待turn状态               | ReceptionService      | 模型只提议，Service提交                   |
| 分型等待/答案              | InteractionLedger     | InteractionService协调与原Pi调用恢复      |
| 记忆值/来源/epoch          | MemoryService         | 显式CAS或学习批量apply                    |
| 证据学习任务               | MemoryLearningService | capture/proposed/finish，模型不直写       |
| 技能内容/启用/加载         | SkillService          | 操作者安装/启用，模型只list/load          |
| 安排/Occurrence            | RoutineService        | tick、pause、resume                       |
| 事件/规则/基线             | EventTriggerService   | emit/observe，create窄port请求新工作      |
| 通知队列                   | NotificationService   | Outcome回执后选择/合并                    |
| 关注水位/提醒              | AttentionService      | 用户活动/查看/计数与评估                  |
| 执行步数/最后运行观察      | ExecutionLedger       | ExecutionService检查、原生adapter报告     |
| 用量观察快照/查询          | UsageService          | adapter提供实际回执，累计采样覆盖         |
| 原生模型/工具checkpoint    | Pi durable            | adapter桥接，不另存任务副本               |
| 凭据原值                   | LocalCredentialVault  | 本地安全通路，核心只得describe引用        |

## 分开工作时的接缝

- 共享装配：assistant-application.mjs、runtime/create-local-domain.mjs、runtime/local-runner.mjs。模块先给出实际需要的窄方法，装配处顺序整合。
- 共享数据：sqlite/database.mjs、repositories.mjs。每项新状态先说明业务owner、原子提交范围和旧profile迁移；不跨模块直接改表。
- 共享入口：bin/assistant.mjs、AssistantApplication.dispatch。新增命令同步帮助、参数、回执与实际CLI验收。
- 共享权限：ScopePolicy和原Delegation。模型、内容插件、事件payload、凭据引用都不能自行增加授权。
- 共享验证：test/helpers.mjs、ownership测试、VALIDATION.md。新增独立测试文件通常可分开推进；修改共享helper前列出调用方。

地图负责指路，代码中的接口和测试负责约束；静态检查当前只覆盖部分owner，不能以存在AGENTS就宣称耦合已自动消除。此地图不自动启动多agent，也不增加用户审批或Join交付门槛。

## 主助理续接：跨模块共同边界

2026-11-03承接Grokbot研究更新。详细当前事实、后续约定与验收场景见[assistant-continuation.md](assistant-continuation.md)；0.8.0已接通以下本地机制，真实模型质量仍待验证。

| 接缝               | 发起/事实owner                                 | 接收/执行职责                                     | 当前实现/边界                                               |
| ------------------ | ---------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| 主助理调用能力     | 原Work/Routine/Memory等服务                    | ReceptionService校验模型命令，planner只提议       | 已接入有限批量命令及安排创建/暂停/恢复；不是任意服务调用    |
| 委托背景           | Reception的原请求锚点与ExecutionLedger快照     | context builder选相关背景，Pi adapter使用固定快照 | 已保存原请求、最新修正和有界背景；旧快照保持原样            |
| 执行结束与业务完成 | Execution、Completion、Outcome、Work各守其状态 | 通过原服务检查和事务协作                          | 默认笔记；显式text契约可无笔记。报告先持久，再由主助理决策  |
| 完成结果回到主助理 | 生产方持久事件，ReceptionService持久接收/结算  | runtime唤醒，planner提议，原owner执行与通知       | 持久报告与系统turn同事务；串行主回合判断继续/交付/静默/阻塞 |

AGENTS联盟是开发导航与职责约定，不是运行时多agent系统，也不是业务模型自动读取的提示词。后续实现不增加万能manager；变更一处接缝要同步核对双方AGENTS、协议/装配、实际行为与恢复证据。

## 已知接缝：继续开发前须看

- PiExecutionAdapter及assistant-tools接收完整app的问题已在0.10.0解决：runtime/execution-ports.mjs投影ExecutionHostPort与绑定work/snapshot的WorkToolPort。原状态owner不变；WorkCoordinator仍承担原用例协调，不能宣称全runtime依赖已收窄。
- Interaction.resolve当前在同步UoW内调用本地Vault.describe读取/校验引用；核心仅拿元信息，但调用仍包含本地I/O。远程Vault或OAuth接入必须先改提交/复核边界，不能直接把方法改async。
- contracts.mjs是局部JSDoc，ownership静态检查覆盖部分直接写入规则。新增owner和新port仍需真实调用/权限/恢复测试。
- LocalRunner.pump原阶段异常跳过后续路径已在0.8.0修复为按阶段隔离与退避；旧复现证据保留，当前行为见continuation测试。

## 开发一项能力的最短路径

1. 找到状态owner；无新持久事实就复用现有状态，不先建空类/空文件夹。
2. 在目标模块补用例/规则，明确对外窄方法、失败和重试语义。
3. 需要真实I/O时再补adapter；需要装配时改共享composition root。
4. 验证实际正向行为与适用的权限、幂等、取消/修改、原子回滚和重开；如实区分fixture/真实模型/外部服务。
5. 同批更新所属AGENTS、当前能力摘要与验证记录；旧归档固定不改写。

## 运行保护投入边界（2026-11-03）

按用户“对标grokbot级别即可”的最新要求，跨模块保护以[运行保护目标](runtime-guardrails.md)为准。维持原owner与失败/恢复边界；有限执行控制、用量统计与业务金额扣账分开，不为统一预算新建空类或空模块。

## 下一批接缝的分治顺序（2026-11-03）

本轮已处理执行工具接口和验收场景拆分，见[0015记录](iterations/0015-module-boundaries.md)。后续按真实需求分开：

| 工作             | 实现owner/位置                                           | 必须保留的接缝                                                          |
| ---------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| 真实模型质量复查 | scripts/scenarios各能力模块                              | 固定输入、原证据、产物与usage；结果问题回到对应产品模块修复             |
| 实际业务工具     | 具体服务adapter，ScopePolicy/Execution/Outcome各守原状态 | 远端身份、授权、实际回执、未知效果对账与原请求恢复                      |
| 接待职责继续细化 | application/reception与ReceptionService                  | 命令处理/报告处理可独立模块，接收/去重/结算事务仍由ReceptionService协调 |
| 远端Vault        | 凭据adapter与InteractionService                          | 事务外验证、提交时复核；当前本地describe仍在同步事务内，不能直接改async |
| 长期运行与备份   | 存储适配器、runtime诊断                                  | 业务/Pi/产物/Vault密钥一致性；不把备份引入模型工具                      |

不按表提前建立空目录；实施时先定义实际接口、唯一状态owner和独立验收证据。

## 0.11.0持续安排与记忆分治

实现见[持续助理](long-running-assistant.md)：domain/CalendarSchedule负责显式日历纯计算，RoutineService独占定义/发生/停止；MemoryService独占用户/项目与profile/log值和元信息，MemoryLearningService独占证据提议/复核；ConversationHistory独占原文，SQLite提供统一只读检索。Pi仅通过已有窄port读取。没有新建空的Workflow/Knowledge模块；23份子目录导航仍覆盖实际模块。

## 0.12.0记忆整理分治

MemorySynthesisPolicy：纯规则；MemoryService：事实/来源/内容墓碑/epoch/复查时间；MemoryLearningService：有界证据批次/提议/重试/日期作业；MemoryLearningCoordinator：临时请求/整体截止；memory-read：共享SELECT prompt；原ContextBuilder/ExecutionService：总界限与新快照注入。没有新增万能owner或第二存储权威。入口见[记忆AGENTS](../src/application/memory/AGENTS.md)，详细[对照](grok-memory-parity.md)。

## 0.13.0文件权威与多项目分治

新增[文件记忆适配器](../src/adapters/memory/AGENTS.md)：FileStore拥有事实文件/旁车与路径，FileTransaction拥有恢复日志/短锁，FileAuthority协调原UoW和SqliteMemoryIndex投影。MemoryService保留事实规则，MemoryProjectService只管显式成员命令；原LearningService、ScopePolicy和上下文/执行/CLI各改自己的接口，不增加万能协调者。当前新增一个真实代码目录，25份AGENTS含根。详情见[所有权和实际接入](memory-files-and-shards.md)。

0.16.0：execution-router 按持久 Execution.harness 路由；work-tools 复用同一批真实工具，Pi/Codex 各自拥有原生恢复。schema18 边界收据不替代 checkpoint。见[Codex 持久委托](codex-durable-execution.md)。

本地观测：[telemetry](../src/adapters/telemetry/AGENTS.md) 拥有官方 OTel SDK 及有界本地 OTLP JSON 导出，runtime/评测拥有生命周期；不接管原业务日志/用量账本。见[本地 OTel](local-telemetry.md)。

多会话生命周期见 [conversation-lifecycle](conversation-lifecycle.md)：History 持有身份，客户端持有选择，Reception/Context/Message/Work 绑定原 ID；Memory 仍跨会话。没有新增 manager、运行时会话状态或表迁移。

2026-11-10：[Bot 资源与持久目录](bot-resources.md)增加显式 bot-v1 profile、固定分配绑定、单写入者 fencing 及原生群查询端口。独立 lab 既有布局保留；平台注册、自动分配和共享来源学习仍待接入，未发布。

## 独立进程边界

`runtime/assistant-server.mjs` 拥有 stdio 进程入口和退出信号；`runtime/assistant-session.mjs` 组合原 runner、托管消息摄取与观察；`adapters/local/stdio-peer.mjs` 仅拥有双向有界帧与临时请求。`host-supervisor.mjs` 通过相同协议启动子进程并桥接平台授权，没有第二份业务命令/记忆/工作账本。详见 [协议](stdio-runtime.md)。
