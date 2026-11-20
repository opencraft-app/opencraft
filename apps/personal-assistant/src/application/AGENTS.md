# 应用层与业务owner

2026-11-10：[多工作协调](../../../../docs/architecture/personal-assistant.md)复用本层 Work/Execution/Interaction/Outcome。ReceptionService 在原 query_scope_json 捕获定向 work/revision，结算时从持久 turn 重读；错误目标/旧版本不写状态，批量命令仍原子提交。AssistantApplication 的 work.overview 仅调用会话范围的只读投影，不建立第二份待办、用户优先级或依赖调度器。验证 test/work-coordination.test.mjs。

继承[上层规则](../AGENTS.md)。本层协调用例和同步事务；不导入具体adapter、Pi、文件、网络或runtime。模型调用、网络或异步I/O不放进UoW。当前Interaction.resolve在同步事务内调用本地Vault.describe校验引用，这是已有本地耦合点，见总地图；不能直接替换成异步远程调用。

## 已有子模块

| 目录                                                   | owner与职责                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| [reception](reception/AGENTS.md)                       | 上下文、只读查询、模型规划；最终写入仍归本目录ReceptionService |
| [conversation-context](conversation-context/AGENTS.md) | 主会话长期工作摘要、覆盖游标和恢复；不写原文/事实记忆          |
| [messages](messages/AGENTS.md)                         | 用户消息payload/outbox/渠道回执；原文和问题仍归原owner         |
| [skills](skills/AGENTS.md)                             | 技能内容版本、启用和加载回执                                   |
| [memory](memory/AGENTS.md)                             | 证据学习任务与提议；记忆值仍归本目录MemoryService              |
| [automations](automations/AGENTS.md)                   | 事件规则/匹配与关注状态；安排定义仍归本目录RoutineService      |
| [usage](usage/AGENTS.md)                               | 用量观察与有界查询，不拥有工作状态或金额账本                   |

## 仍平铺的核心文件组

| 文件组                                           | 唯一写入owner       | 允许的协作                                       |
| ------------------------------------------------ | ------------------- | ------------------------------------------------ |
| input-inbox.mjs                                  | InputInbox          | 接收、去重、payload冲突和命令回执同事务          |
| work-service.mjs                                 | WorkService         | 其他服务调用它变更目标、revision和状态           |
| execution-service.mjs / execution-ledger.mjs     | ExecutionLedger     | Service协调快照、绑定和动作前检查；不复制Pi任务  |
| completion-service.mjs / completion-ledger.mjs   | CompletionLedger    | Service登记可信I/O依据并评估，不接受模型自证完成 |
| outcome-service.mjs / outcome-ledger.mjs         | OutcomeLedger       | Service协调Result/Delivery与完成；接受可重放     |
| conversation-history.mjs                         | ConversationHistory | 所有可见主历史和工作关联通过它写入               |
| reception-service.mjs                            | ReceptionService    | 接收/结算turn，调用其他owner提交最终建议         |
| interaction-service.mjs / interaction-ledger.mjs | InteractionLedger   | Service协调问答/分型等待与工作恢复               |
| memory-service.mjs                               | MemoryService       | 显式/自动记忆值、来源、epoch与遗忘               |
| routine-service.mjs                              | RoutineService      | 安排定义、Occurrence、暂停和恢复                 |
| notification-service.mjs                         | NotificationService | 选择、排队、合并通知；不结算执行或交付           |
| scope-policy.mjs                                 | ScopePolicy         | 原授权、资料binding、接待范围与观察资格          |
| assistant-application.mjs                        | 装配/dispatch入口   | 组合注入依赖，不追加领域状态机                   |

这些是现有文件组，不是假装已经独立成文件夹。需要拆目录时随真实功能变更迁移并保留兼容入口，不能同时复制两套实现。

## 协作约束

只获取实际需要的窄方法；不把整个app/r/uow传给只读查询或模型。跨对象状态需要同一UoW时由用例服务协调，各ledger仍是各自表的唯一业务写入入口。repository的具体SQL实现归adapters/sqlite。

先修改所属owner；调用方通过接口接入。涉及共享装配文件或跨owner事务时在变更说明列出影响，顺序整合，不相互覆盖。此处的owner指类/职责，不指开发者身份，不新增人工审批。

0.9.0已按[运行保护说明](../../../../docs/architecture/personal-assistant.md)接入局部上限与用量可见性，不建立统一Budget框架。adapter报告可取得的实际用量，runtime实施截止/取消；以后若有独立业务额度，再明确owner，不能把业务扣账塞进WorkCoordinator计数器。

## 后台结果续接的协作约定（0.8.0）

按[续接边界](../../../../docs/architecture/personal-assistant.md)开发：ExecutionService/ExecutionLedger记录不可变报告、请求快照和执行观察，CompletionService/CompletionLedger保存完成依据，OutcomeService/OutcomeLedger处理结果与交付，WorkService独占工作状态。ReceptionService接收系统来源的结果事件并协调决策，模型不能直接提交事务；NotificationService继续负责通知选择与去重。

生产方在所属业务事务内持久记录事件；ReceptionService拥有该事件对应turn的接收、去重与结算。优先复用现有事件/接待状态，只有缺少消费事实时才加最小字段或记录；不复制Pi原生任务表。当前采用ExecutionLedger.recordReport与ReceptionService.acceptReport在同一UoW提交；reception行保存消费状态，events仍是审计日志，不独立承担可靠队列。

主助理判断继续/交付/静默不绕过原完成契约、ScopePolicy、revision和Delivery回执。系统结果不伪装成用户输入，不触发用户活动或直接成为用户事实记忆。新增模型命令逐项调用现有owner，不在planner复制Routine、Work或Memory状态机。

批量用户命令最多4项、系统报告只允许单个续接决策；整批命令/回执和turn同事务。自动续接3次、主回合失败3次的限制保存在业务状态，不能在runtime重启后重置。

验证入口：`test/ownership.test.mjs`覆盖依赖/写入边界；再按[总地图](../../../../docs/architecture/personal-assistant.md)选择业务测试。改共享装配、迁移或恢复语义时执行`npm test`。

ExecutionService.modelStep在同步UoW检查当前revision并通过ExecutionLedger.guard保存步骤；超限状态先提交再抛错，不能让事务回滚抹掉限制原因。同generation taskId恢复/重试不重复计步。observeRun只保存最后一次活跃运行观察，不宣称全工作累计时长。UsageService只获得repository、readWork/readExecutions窄facet，不能更改Work或交付。

0.11.0把持续跟进与分层召回扩展到原owner，没有新增workflow/knowledge万能服务。RoutineService保存日历/once/停止条件并保留原资源与版本，MemoryService保存元信息与作用域，ConversationHistory查原文。ReceptionService只校验结构化更新和父决策，通过原owner提交；finishRoutine和结果结算同UoW，失败回滚。具体规则见docs/long-running-assistant.md，验证test/continuity.test.mjs。

0.12.0记忆整理沿原MemoryService/MemoryLearningService分治。事实/内容墓碑与任务批次分开拥有，通过窄facet及原UoW原子提交；legacy保护的变更以根AGENTS最新条款为准。ReceptionContextBuilder在既有总字节界限内裁剪新增profile/recent并标truncated；ExecutionService只为新快照固定memoryContext。

0.13事实以Markdown为准，MemoryService仍拥有业务规则/epoch，MemoryProjectService只管显式成员命令。项目加入只授予记忆，不增加material工具；ScopePolicy资源getter合并当前成员grant，旧基线resources setter仅调整资料资源。project.create/join/leave也经ReceptionService原inbox/外层UoW提交；系统报告不能调用这些用户命令。

0.15 History.append在原UoW提交canonical文字+消息引用与MessageService.record；payload/outbox只由MessageService写入。普通回复、接话/进度、问题、结果、通知都经过此出口。Interaction仍唯一写问题/答案；选择值/唯一标签映射在原Interaction校验。Outcome仍结算原Result/local-mailbox，用户消息渠道回执独立，不改变旧完成契约。主模型send单独决策，系统deliver.message仍先过原Completion与父回合检查；附件元信息不授予工具/资源。

0.16 ExecutionService 的原生边界收据只协调固定 Execution 的意图/结果与等待对账，不接管原生任务图；固定引擎归 ExecutionLedger。bound 可先绑定未接受输入的线程，admitted 后才记 input.delivered，重复接受不重复发事件。

0.17：GoalService 是目标/计划边/消费证据/复核的 owner，通过窄 workPort 创建、改版和取消工作；WorkService 独占 active_execution_id，ExecutionLedger 写执行尝试及指令生命周期。执行和父回合均须检查同 revision 下的执行移交，不能把迟到失败应用到新执行。暂停/依赖失效同时门控执行、工具、结果；显式 rebase 重做下游契约，不偷偷改快照。Outcome 不发出已失效的待交付结果。见 ../../../../docs/architecture/personal-assistant.md。

2026-11-10：模型 amend 要求完整替换契约，typed Work 部分更新语义保留。同版本 continue 只保留普通已答事实；InteractionService 有界投影 confirmedInputs，ExecutionService 只写后继新快照。ReceptionService 在批次写入前验证动作独立性，错误仅存宿主操作类型/序号，不存原提案。详见 docs/coordination-ownership.md 与 test/work-revision-contract.test.mjs。

续办复核补充：ExecutionLedger.contextDirectives 有界投影同 revision 已提交及当前已调度的补充，不改原提交回执。ReceptionService.acceptReport 捕获 InteractionService 的普通答案和 ExecutionLedger 的指令投影，报告 ContextBuilder 只消费 source。执行端与复核端使用同一语义，原生状态仍不归这两个投影拥有。

2026-11-10：ConversationHistory 拥有 conversation.create/list 与 assistant 归属校验，InputInbox 原事务去重；客户端显式携带 conversationId，不建立全局当前会话。Reception、摘要、Message、工作报告按输入/请求原会话投影；Goal 扩展继承原成员目的地。Memory 作用域不随会话改变；省略 ID 继续旧 main。自动化默认目的地不改。见 ../../../../docs/architecture/personal-assistant.md，专项 conversation-lifecycle，装配改动跑全量。
