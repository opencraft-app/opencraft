# Personal assistant runtime

用户于 2026-11-02 要求「先独立文件夹验证。无界面runner」。原独立实验于 2026-11-10 按用户要求合入内部发行版，现由本 workspace 维护；来源见 SOURCE.json。

- 本目录拥有助理运行时、记忆与工作账本；平台申领和代理权限归共享 Core。桌面与 headless 通过同一 Host 端口调用。遵守仓库根 AGENTS.md，源码集成不代表部署或自动启动。
- 复用固定版本 Pi durable；执行与工具 checkpoint 归 Pi，本地领域 Store 只保存委托和业务事实。
- 2026-11-07 用户明确扩展为多 Harness：主助理推理可选 Pi/Codex，见[多 Harness](docs/multi-harness.md)。用户随后明确授权 Codex 持久委托，已独立适配，见[持久委托](docs/codex-durable-execution.md)。原生 checkpoint 仍归对应引擎；引擎固定于 Execution 创建，不静默迁移。
- 默认 fixture 无网络。不得借用共享机器的模型或服务凭据；真实模型和外部服务验证分别记录。
- 保留失败记录；测试通过不等于真实模型、IM 或平台接入已验证。
- 不引入网页、WorkBuddy 文档 SDK、Lucide 或多 Bot 管理作为本轮前置。

## 当前导航（0.17.0 / schema20）

先读[模块分治地图](docs/module-map.md)和[src入口](src/AGENTS.md)，再读目标目录AGENTS。已有模块目录都有职责、owner、接口、禁止越界和验证入口；尚平铺的核心文件组见[application地图](src/application/AGENTS.md)。新增真实模块目录同批补AGENTS，不为规则建立空模块。

当前六项新增能力与边界以[能力台账](docs/superapp-capabilities.md)为准，后续优先项以[roadmap](docs/roadmap.md)为准。下面按轮次保留的条款需要结合其后的明确扩展理解，不能把早期缺口当成当前状态。owner指代码职责，不识别发言人或执行者身份。

已纳入内部源码；交付遵循仓库内部发行版流程。变更仅文档时核对本地链接、模块覆盖和格式即可；历史131项结论保留；当前测试以continuity独立验证记录为准，module-boundaries记录保留，guardrails记录保留，continuation与更早记录保留。

## 主助理连续处理的跨模块约定（2026-11-03）

用户要求更新AGENTS分治地图，承接Grokbot衔接机制研究。统一约定见[主助理续接边界](docs/assistant-continuation.md)，各目录只补自己的职责。0.8.0已实现报告驱动的主助理回合、有限批量命令、安排命令、原请求快照和显式文本结果契约；真实模型质量仍未验收。

- 模型通过有限业务命令提议使用能力，由原owner校验提交；不持有服务对象或数据库。AGENTS是开发导航，不会自动进入业务模型提示词。
- 委托快照应带原请求锚点、相关背景、目标和成功标准；不依赖子执行者自动继承父对话，也不默认复制完整历史。
- 执行结束、结果通过检查、交付接受、工作完成分别记实。默认新工作仍要求note_published；明确completion.output=text时不自动加笔记条件，其他显式检查继续执行。旧快照不改写。
- 后台结果经ExecutionLedger的不可变报告和ReceptionService的持久系统turn回到原主助理，由接待用例协调继续、交付或静默。Work、Execution、Completion、Outcome、Notification继续各有owner；不建立接管全部状态的manager。
- 迟到/重复结果、取消/修改、quietOrigin和崩溃恢复沿原身份与revision校验；runtime只唤醒，不在内存队列保存唯一待办事实。静默不等于用户收到结果。

## 第二轮目录与所有权约束

用户随后要求「建模 文件夹和类 所有权边界」「逐步丰满」。实际 owner 与数据目录见 docs/architecture.md。

- domain 不依赖 I/O；application 不导入具体 adapter、Pi 或 runtime。
- 事项变更归 WorkService；执行绑定经 ExecutionLedger，结果/投递经 OutcomeLedger；主历史经 ConversationHistory，输入经 InputInbox。新增能力先说明状态 owner 和事务，再实现。
- 接待模型只提建议，不持有 repository、凭据或业务写入权；应用校验会话归属、revision 和原委托。
- runtime 只持有临时调度资源和装配，不新建第二份业务状态；Pi 仍独占原生执行 checkpoint。
- 文件资料根由配置明确绑定，旧委托不自动继承新根。不得为方便测试开放任意路径/命令。
- 根目录旧文件只是第一轮兼容导出；新实现放入拥有该职责的层。保留旧数据迁移与恢复测试。

## 第三轮个人助理边界

- 首版产品目标及退出原型所需证据见 docs/product.md；真实模型未验收时保留 development 状态。
- 问题/答案经 InteractionLedger 唯一写入，InteractionService 协调同一 UoW 的 work/history/input 变化。绑定原 work/revision/native call，修改/取消退役旧问题。
- 等待通过 Pi 原生挂起释放执行资源；不得用常驻 Promise 或自建工具任务库冒充持久等待。回答回执不代表已经处理完成。
- 对话记忆建议经 MemoryService CAS 提交；遗忘后的版本保留，不能用新版本0覆盖。真实模型验收入口拒绝 fixture，离线 doctor 不宣称服务/质量已验证。

## 第四轮完成标准

- 当前目标/条件归WorkService + CompletionContract；CompletionLedger独占执行依据与评估写入，CompletionService只收集可信I/O回执并执行检查。
- 默认笔记工作必须发布真实笔记；0.8.0扩展允许显式文本契约。通过相应检查后才能创建成功Result/Delivery；本地接受后才completed。语义要求未验证时保持semanticReview=unverified，不以字面/来源检查代替内容质量结论。
- 修改产生新工作版本，旧证据不能满足新版本；失败评估应持久保存。旧数据迁移保留原条件和执行快照，不伪造历史依据。完整后续顺序见docs/roadmap.md。

## 第五轮模块内聚与耦合约束

用户于2026-11-02明确要求「功能模块要高内聚低耦合」。新增能力按职责与所有权分模块，依赖通过窄port注入；不为抽象建立空类，不把新能力堆进runner或给模型整个应用对象。

- application/reception 的context、query、planner分别负责上下文、只读查询和规划交换。query/planner不得导入命令owner、具体adapter/runtime或持有r/uow/app；查询读取port只能SELECT。
- ScopePolicy拥有接收范围与当前binding检查；query只接收其只读facet。接待委托工作也沿用原资料范围，不能绕过只读grant间接扩权。
- 查询记录是观察，不代替命令CAS。trace由host产生，ReceptionService随成功或失败提交；模型提供的trace不能当依据。
- 查询数、返回量和初始上下文必须有界，并标记分页/截断。局部协议限制不冒充已实现的完整执行费用/时间预算。

## 第六轮回应与通知

- 优先复用原 reception 状态、ConversationHistory 稳定消息身份与 Outcome 交付链路；不增加重复的回应任务账本。
- 接话和进度不能完成输入或工作；执行失败通知与 blocked 状态同事务。最终结果仅沿原交付接受链路结算。
- 例行任务默认静默，不自动关联主会话；第九轮明确配置always/changed时，经通知owner关联并选择结果通知。新增进度/失败提示不能绕过来源策略；本地历史与mailbox接受不冒充外部IM投递或用户已读。

## 第七轮技能

- SkillService独占技能安装、启用、不可变内容版本与加载回执。模型只获得list/load窄接口，不得安装、启用或从技能正文扩张工具/资源授权。
- 执行沿原ExecutionLedger快照固定技能摘要版本；旧执行不自动获得新技能，新版本内容不能替换已捕获版本。停用阻止后续读取，不能宣称清除了Pi已有上下文。

## 第八轮证据记忆

- 学习任务归MemoryLearningService；记忆值与来源归原MemoryService。模型只提议和独立复核，不能直写。引用只接受原用户证据ID。
- 用户显式设置与遗忘墓碑禁止自动覆盖。0.12.0依本轮近乎复刻Grokbot要求，来源不明旧条目允许凭新用户证据修正/移除，替代此前一律保护范围；旧key协议保留历史校验。epoch冲突整批旧提议作废并有界重做；批量应用、来源、epoch和任务结算同事务。提议持久化后恢复仅重做复核。

## 第九至十一轮扩展边界

- 事件规则/匹配/源基线归EventTriggerService；工作创建经WorkService并保存子输入收据与原资料binding。事件payload不授予权限。
- 后台结果通知归NotificationService；原Result/Delivery接受仍归Outcome。quietOrigin持久化，抑制通知不重跑工作、不伪称用户已读。主历史和通知sent状态同事务。
- AttentionService独占关注信号，RoutineService独占安排暂停/恢复。模型查询不算用户活动，不自动恢复已暂停任务。
- 分型等待继续经InteractionLedger和Pi原生挂起。敏感值只由本地Vault适配器加密保存，核心只得引用describe facet，不进聊天、InputInbox或原生checkpoint；owner-provided授权不冒充远端认证，人工报告不冒充工具验证。
- 自动学习用全局epoch防冲突，遇新快照有界重新提议；新执行的显式变更屏障保留用户更正/遗忘的立即失效语义，自动提炼本身不阻断已有普通工作。旧执行快照不改写。

## 续接实现约束（0.8.0）

- execution_report由ExecutionLedger独占写入，与系统reception turn和awaiting_review同事务。模型回合在事务外；continue/deliver/silent/blocked由ReceptionService校验并经原owner结算。
- 单个用户输入最多4项非嵌套命令，整批原子提交；系统结果只允许一个续接决策。原话和相关背景随执行固定，修正保留初始请求和最新指示。
- 自动续接最多3次，父回合失败最多3次后保留报告并阻塞；显式用户修改可重新推进。这些是局部上限，不代表统一预算已实现。
- quiet静默不刷新关注、不创造交付回执；合格结果仍经本地mailbox接受后结算。系统结果不进入用户事实记忆。
- pump按阶段记录错误和退避，其他阶段继续。真实模型、远程IM和长期无人值守仍需单独验证；当前不部署Join。

## 当前投入边界：对标Grokbot（2026-11-03）

用户明确「能有对标grokbot级别的也就行了」。当前成本控制按[运行保护目标](docs/runtime-guardrails.md)推进：有限回合/重试、并发与取消、上下文界限、用量可见性和无人关注保护。对标依据为已核查的非官方重建源码，不宣称官方产品已完整复现。

此前roadmap把统一持久Budget/Usage、金额预占/扣账与跨路径额度列为P0，本条覆盖该投入优先级；这些不是当前完成或退出原型的前置。不为此建立通用预算框架或空owner。0.9.0已补显式执行保护与用量查询，实际边界见下节；真实模型质量仍待验证。未来确有独立额度需求时再明确owner与恢复语义。

## 运行保护实现约定（0.9.0 / schema12）

- RunPolicy定义局部上限；ExecutionService协调、ExecutionLedger独占持久步数/最后运行观察。默认每Execution最多128个模型生成步骤，同generation恢复/重试不重复计步；工作新revision重新计步，不冒充provider调用次数。
- PiRunGuard在原生请求前检查步数，先原生abort再终止；默认单次活跃运行10分钟，用户等待/挂起停止计时，重启或恢复开始新次运行。不是累计整个工作墙钟预算，已发生的I/O不回滚。
- 接待/记忆学习请求默认2分钟截止，迟到提议不能提交；Pi模型超时复用原生配置，provider与durable每层最多2次重试，不承诺整个工作总共只请求3次。
- UsageService只拥有观察快照和有界查询，Pi持有原生usage。重复采样覆盖累计值；直接模型调用保存回执、失败未知。fixture/model分组，目录价格估算不是账单。统计失败不能重跑模型或覆盖已成功结果。
- 旧schema11迁移不回填统计。新增usage目录有自己的AGENTS；不引入金额预占/扣账，也不改变其他生命周期owner。具体默认值、配置、查询和已验证范围见[运行保护说明](docs/runtime-guardrails.md)。

## 执行接口与场景分治（0.10.0）

用户于2026-11-03采纳“工具接口收窄＋真实模型验收场景拆分”。只在独立runner执行，不扩展为Join交付或远端连接授权。

- Pi adapter与assistant-tools不再接收app。runtime/execution-ports.mjs只在装配处投影实际方法；ExecutionHostPort保留快照/原生绑定/计步/观察，WorkToolPort绑定原work与snapshot，只提供动作检查、上下文、依据、等待、技能读取和审计。
- 原Work/Execution/Completion/Interaction/Skill/Usage各owner与事务不变；工具仍在真实I/O前检查范围、revision和显式记忆屏障。窄接口是依赖约束，不是第三方JS安全沙箱。
- scripts/scenarios按memory、work、automations、skills分开，经公开协议运行；context只管理临时进程和采证，catalog只做有限选择。可以单选场景，以全新profile独立复现。
- 每个场景保存passed/failed/not_run/not_selected、独立断言与质量复查项；失败保留证据并关闭runner。自动断言不自动把quality设为通过，无人关注长周期、敏感介入等未跑范围另列。
- 新增目录同批有AGENTS；当前23个子目录指南加根规则共24份。没有额外引入manager、消息总线或新数据库模型。ReceptionService职责拆分、远端Vault事务边界仍属于后续具体工作。

## 持续安排与长期上下文（0.11.0）

用户要求学习Grokbot优先补这两块，不以真实模型验收为开发前置。日历/一次性/更新/有限条件盯办沿Routine owner；用户/项目、profile/log记忆沿Memory owner，原文沿ConversationHistory。实现与未完成边界见[持续助理说明](docs/long-running-assistant.md)。

- calendar时区显式、星期/小时/分钟列表有界；once单次。旧interval保持原行为，历史快照不改写。停机合并一次，DST重复当地时间槽去重。
- stopWhen须有期限/次数。当前合格报告的父决策可finishRoutine，只有对应条件安排能停止；标记model-reported，不伪造宿主语义/远端证据。截止停止不会自动产生截止通知，需要另一个明确once指令。
- 项目范围由原资源grant和当前binding确定；scope/kind不是模型自授权限。自动学习恢复不得切到新项目，显式记忆/墓碑保护保留。
- 新召回与历史查询只读且有数量/文本界限，文字搜索不能称语义检索。Pi新工具只进入新Delegation，继续使用窄port。schema13不伪造旧数据日期/项目归属。
- 仍独立开发，不部署Join。没有完整cron、跨Agent共享记忆、episode摘要、向量检索或真实模型质量通过结论。

## Grokbot记忆整理对齐（0.12.0）

用户要求记忆紧跟、近乎复刻Grokbot。本轮对齐恢复源码的新版 synthesis 主链路，详细对照与有意差异见[记忆行为对照](docs/grok-memory-parity.md)。固定引用仍是非官方恢复源码，不宣称线上官方产品已复现。

- 事实与来源/内容墓碑/epoch/复查时间归MemoryService；证据合并、提议、复核、重试/终态归MemoryLearningService；不增加万能memory manager。
- 现代模型协议为create/update/remove，64项、500字符、512事实快照；15秒/12轮合并、90秒整次截止、三次有限重试、小时轮询/每日日期复查。fixture显式加速，不改变生产缺省。
- legacy可凭新用户证据修正，explicit不可自动改；显式遗忘按同范围规范化内容阻止跨key自动复活，自动remove不等于用户forget。不是语义遗忘，也不删除原文历史。
- profile/recent实际进入新执行快照和接待上下文；SQLite仍唯一权威。没有agent shard/跨agent与多项目汇聚、Markdown文件权威或旧episode并行提取路径，不把这些说成已有。
- schema14保留旧提议与快照；旧遗忘内容已为空时不能补造墓碑。真实模型质量继续unverified，独立目录不部署Join。

## 文件权威与共享分片（本轮用户要求，2026-11-03）

用户明确要求上一轮列出的agent shard、多项目汇聚、Markdown文件权威全部研究、写AGENTS并实现。本条替代0.12中“SQLite为记忆事实唯一权威”及“只支持当前项目”的范围；旧历史保留，其他业务仍由SQLite与原owner负责。新约定见[文件记忆设计](docs/memory-files-and-shards.md)和[存储owner](src/adapters/memory/AGENTS.md)。

事实以Markdown为准，SQLite只做记忆可重建索引与业务作业/回执。文件与SQLite需有可恢复提交/回滚日志，不伪装物理原子。共享每个shard只允许本agent写，跨agent读带来源；项目必须显式成员资格与原grant校验。新默认agent、旧默认user，迁移不改旧归属/日期/快照。通用任意Shell、多Bot管理、Join集成仍不在本轮范围。

0.13/schema15已实现文件权威/agent-user-project shard/成员授权及最多3项目注入，原“尚未实现”条款是0.12历史范围，不再限制本轮。当前状态与真实差异以memory-files-and-shards.md及本轮验证为准。源恢复代码factory/返回形状的缺口未照抄；新实现须验证实际接待/Pi/CLI装配。读取仅刷新索引，不从缓存恢复正式文件；外部第三种内容、未知锁不自动覆盖。

## 主会话长期工作上下文（2026-11-04）

用户要求「主会话的长期工作上下文 搞定实现吧」。0.14由[conversation-context](src/application/conversation-context/AGENTS.md)拥有派生摘要、原文覆盖游标和生成恢复；ConversationHistory仍独占原文，Work/Interaction仍独占当前状态。具体设计与边界见[说明](docs/conversation-working-context.md)。

新接待前最多一批有界摘要；结构分目标/约束/决定/未完事项，引用真实消息并保留角色。原文分段支持长消息内游标；旧输入/系统报告不用未来摘要。失败不前移覆盖，gap明示，三次耗尽后可context-retry；摘要不改变工作、授权或长期事实记忆。模型调用在UoW外，有截止/关闭/迟到保护；成功checkpoint不可变，新委托固定当前workingContext，旧快照不改写。AGENTS不会进入业务模型上下文，真实质量仍需独立验收。

本轮只改独立实验目录，不是Join环境源码；新增Join网络主线程禁阻塞规则不授权本轮部署，也不把本实验的同步SQLite当平台接入方案。将来平台adapter必须经Worker/独立进程异步端口，不能直接搬同步Store到Join主线程。

## 用户交互与SendMessage边界（2026-11-04）

用户要求继续做完整用户交互与交付，并询问SendMessage如何接入。0.15先在独立runner完成[消息内核](src/application/messages/AGENTS.md)及本地渠道，设计见[说明](docs/user-messages.md)。主助理send/deliver.message走统一出口；worker仍向主助理报告。History拥有可见原文，MessageService拥有payload/outbox/回执，Interaction/Vault拥有选择与安全等待，Outcome拥有原工作结果/本地mailbox契约；不能用发进度消息完成工作。

消息与canonical历史引用同事务，重试稳定ID/原payload，五次失败保留failed并让后续消息继续；显式message-retry仅重投。附件只读当前profile不可变文件ID，实际复制时核对哈希；模型不能导入路径/URL或选择未配置的channel。原工作revision失效/卡片过期时撤回尚未发出的绑定消息，已接受渠道效果不回滚。accepted不等于用户已读。

本轮没有UI或真实外部IM/OAuth；只配置local:main。工作完成仍按原Result/本地mailbox契约，新消息通知的回执单列，不偷偷改变旧快照。主助理普通clarify仍为文字，选择卡复用工作绑定的Interaction；平台内置映射另经异步隔离端口，不将lab同步SQLite/文件I/O搬进Join主线程。

## Codex 持久委托扩展（2026-11-07）

本文此前 Pi 专属条款仅约束 Pi 路径；Codex 使用原生持久线程及有界宿主边界收据，不保留等待用户的 Promise，也不冒充 Pi 逐工具 checkpoint。共用工具归 adapters/work-tools，原业务 owner 与事务不变。升级前私有 SQLite 备份、混合引擎、真实进程崩溃与旧 Pi 完整回归是本轮验证范围；不部署 Join。

2026-11-09 用户明确后台整理改用混元4并关闭思考。可选 harnesses.backgroundCodex 只覆盖记忆提炼/复核与工作摘要，主聊/委托仍按各自配置和原绑定。reasoningEffort=none 须在真实原生 HTTP 请求验证；具体边界见 [后台模型](docs/background-models.md)。没有授权部署 Join。

## 长期目标与连续执行（0.17 / schema20，2026-11-10）

用户授权建模、明确所有权并实现，契约见 [协调所有权](docs/coordination-ownership.md)。GoalService 拥有计划/DAG/验收事实，不接管 Work 状态。WorkService 独占有效执行引用；ExecutionLedger 拥有后继执行和有序指令持久化；普通继续保持要求 revision，写权另检查 executionId。Codex 同原生根续接、同要求步数累积；原自动续接最多3次指自动连续次数，显式用户补充可重置连续次数但不重置步数。依赖消费当前有效 Result，失效传递，显式 rebase 经 WorkService 改版，不改旧快照。模型目标复核与用户确认分开。真实模型质量/跨机调度/Join 集成未验收，仍只改独立 lab。
