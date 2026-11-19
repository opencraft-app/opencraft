# 独立 runner 验证记录

当前0.8.0/schema11状态：见文末及 [架构与所有权](docs/architecture.md)。下面保留第一轮记录。

日期：2026-11-02。提出人：当前会话用户，身份未确认。原话：「好，先独立文件夹验证。无界面runner」。执行目录：`/data/labs/opencraft-superapp-runner-20261102`。本轮没有修改、合入或部署 Join；没有重启 Core/router。

## 实现结果

实现了无界面 CLI + 本地 Unix socket runner。领域 SQLite 保存输入、工作 revision、执行绑定、记忆、安排/触发实例、结果、投递与事件；每项工作使用一个真实 Pi durable SQLite 会话，模型回合和工具恢复由 Pi 负责。依赖固定为 Pi AI/Durable/Chord 1.3.0、proper-lockfile 4.1.2，传递依赖见 package-lock.json。

可运行命令和已实现范围见 [README](README.md)。默认 fixture 明确标注，不进行模型或服务网络请求。

## 实际验证

| 验证                 | 结果                                                                                                               | 证据                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| JavaScript 语法检查  | 11 个模块通过；不是类型检查                                                                                        | `npm run check`                                    |
| 领域与运行测试       | **24 / 24 通过**，约 39.8 秒                                                                                       | [test-run-final.log](test-run-final.log)           |
| 强制终止恢复         | 子进程在本地产物已写、Pi 工具结果未提交时 SIGKILL；恢复后原产物 mtime 不变、只有一条原生输入、工具重放核对已有文件 | runner.test.mjs 的 SIGKILL 场景                    |
| Pi 接收/绑定窗口     | Pi 已持久接收但领域 binding 未保存时退出86；重启按同一 requestId 找回，保持一条输入                                | pi-admitted-before-binding 场景                    |
| Result/Delivery 窗口 | 结果与投递意图事务提交后退出86；恢复继续投递，不重做执行                                                           | result-saved-before-delivery 场景                  |
| 投递/回执窗口        | mailbox 写入后、领域回执提交前退出86；恢复核对同一 deliveryId，只有一个文件                                        | mailbox-written-before-receipt 场景                |
| 并发与归属           | 后台上限2，控制请求在执行期间可响应；第二个 runner 无法抢占同一活跃 profile                                        | 运行测试                                           |
| 演示                 | 记忆→提交→修改原工作→结果→重启→重复输入→有限安排；保留2份本地交付                                                  | [evidence/demo.json](evidence/demo.json)           |
| CLI 冒烟             | 实际 CLI 初始化、启动、中文参数、记忆、提交、查询、重复输入；工作完成                                              | [evidence/cli-smoke.json](evidence/cli-smoke.json) |
| 真实模型适配装配     | DeepSeek / Anthropic 的固定版本 provider 目录和所选模型可解析；没有请求模型                                        | 本地 modelsFor 离线装配探针                        |

测试还覆盖：输入 ID 冲突拒绝、命令事务回滚、修改时旧 revision 失效、取消不伪造结果、记忆更正/删除 CAS、快照固定、安排漏跑合并/不重叠/有限次数/到期/暂停、正常关闭与立即关闭接续、投递失败后只重试消息。

首次运行 21 项中 16 通过、5 项失败；失败均发生于恢复断言的辅助读取函数，缺少 Pi scanEntries 必需的 conversationId。修正辅助查询，并补充3项检查后，完整24项通过。原失败记录保留 [test-run.log](test-run.log)，未隐藏或把首轮报告改成成功。

## 仍然没有证明的部分

- 未验证真实模型的意图识别、长任务效果、错误恢复策略或费用；没有自然语言接待路由。
- 交付目标是本地持久 mailbox，accepted 表示文件已可靠保存；不表示外部 IM 接受或用户已读。
- 当前两个工具只读取本工作上下文、发布本地笔记；没有任意 Shell、OpenCraft 连接、外部副作用或真实渠道验证。
- 显式记忆基于 key/revision，未做自动提炼、语义冲突消解和全历史遗忘。全局 memory epoch 的失效范围较粗，旧工作会受阻并要求修订。
- 安排只支持固定间隔和绝对毫秒时间；暂停/到期及有限次数已经验证，cron/时区、来源订阅与认证失败自动暂停尚未实现。
- 只保证本机单 runner 的受控状态归属；不是分布式多写入、跨 Host 迁移或外部服务 exactly-once。
- 未与 OpenCraft Actor/Tasks/Thread/schedules 的实际 owner 整合。当前 Store 是隔离实验适配，不能直接当作上线所需的第二套业务库。

演示及测试进程均已正常退出或按测试预期被终止，没有安装常驻系统服务。演示 profile 和结果留在 profiles/，供后续查看和重启。

## 第二轮：领域、目录和类所有权（2026-11-02）

已完成真实分层和写入归属收敛，加入主会话接待、结构化模型建议、会话范围校验、稳定工作关联、原聊天结果回传及只读文件资料源。实现范围与延后项见 [迭代记录](docs/iterations/0002-ownership.md)。

- **39 / 39 完整回归通过**，约43.3秒：[最终报告](evidence/phase2-tests-final.log)。
- 51个 JavaScript 模块语法检查通过；静态边界测试检查应用/领域依赖方向及 repository 写入 owner。
- [主聊天演示](evidence/assistant-demo.json) 经实际 CLI 运行，7项断言通过；实际文件读取和本地产物已保留，主聊天和工作执行会话分别持久化。
- model-mode 接待适配的实际 Pi 调用契约与非法 JSON 拒绝已用 faux provider 验证：[契约报告](evidence/reception-provider-contract.json)。未请求真实模型。
- 独立 SQLite 升级至 schema2，迁移测试确认旧输入去重键、工作和记忆保留；旧委托不继承新增资料读取权限。
- 演示正常退出，不存在本轮安装的常驻服务。

当前仍是原型。模型质量、通用完成判断、人工 Interaction、自动记忆、真实 IM、平台内置装配、Temporal 与长期运行均没有因此被证明。此前第一轮“只有两个工具/没有接待”的描述只适用于第一轮；当前配置资料源后可安装两个额外的只读工具，真实模型接待质量仍未验收。

## 第三轮：日常个人工作目标与持久问答（2026-11-02）

本轮目标和范围见 [product.md](docs/product.md)，实现记录见 [0003-personal-assistant.md](docs/iterations/0003-personal-assistant.md)。独立包版本0.3.0，private=true，仅用于标识本地迭代。

| 验证         | 实际结果                                                                              | 证据                                                                                              |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 完整回归     | **55 / 55 通过**，约116.8秒                                                           | [完整日志](evidence/phase3-tests-first-full.log)                                                  |
| 语法与格式   | 60个 JavaScript 模块语法通过；src/bin/test/scripts/docs 格式检查通过；不是类型检查    | [语法](evidence/phase3-check.log)、[格式](evidence/phase3-format-check.log)                       |
| 个人工作闭环 | fixture 模式14项自动断言通过，使用真实 Pi、本地资料/产物/交付；重启后答复原工作       | [演示日志](evidence/phase3-personal-demo-first.log)，新 profile 路径和完整 evidence.json 在日志中 |
| 新 CLI       | 实际 init/run/submit/interaction-list/answer/work/doctor 完成；回答中文原文与版本保留 | [CLI证据](evidence/phase3-interaction-cli.json)                                                   |
| 模型配置诊断 | 实际固定 Pi DeepSeek 目录离线解析；无真实模型请求；不输出凭据值                       | diagnostics.test.mjs                                                                              |
| 真实验收入口 | 拒绝 fixture；真实模式场景入口已实现，**未运行真实模型验收**                          | scripts/accept-personal-assistant.mjs                                                             |
| 迁移与权限   | schema1/2→3 保留旧工作、输入、记忆和委托；旧 grant 不自动获得 ask_user                | ownership.test.mjs                                                                                |

新增回归覆盖：问题等待释放唯一工作槽和 Harness、另一个事项可完成、回答后保持原 Submission/Conversation/Execution、一条原生输入、重复回答去重及第二份回答拒绝、进程重启保留问题、修改/取消后过期答案拒绝、拒绝后 blocked 可修订继续、多个问题需全部答复、等待时其他工具被阻止、问题已提交但尚未挂起时进程退出恢复、主聊天问题和答复关联、会话外问题拒绝、显式记忆更正/遗忘/重新记住，以及过期记忆建议不能覆盖新值或发成功回执。

本轮中间失败保留：[首次问答测试](evidence/phase3-interaction-first.log) 误读 runtime 字段；[第二次](evidence/phase3-interaction-second.log) 断言的拒绝文案匹配不准；[聚焦检查](evidence/phase3-focused.log) 使用了固定 Pi 目录不存在的模型 ID。修正后第一次完整55项通过；没有覆盖失败报告。第二轮基线清单和日志另保存为 evidence/phase2-baseline-before-interaction.json 与 phase2-baseline-tests.log。

未使用真实模型/第三方服务凭据，未集成或部署 Join、未重启 Core/router。演示的 runner 均关闭，未安装常驻服务。当前 development：真实自然语言/资料质量、连续日常使用、token/费用/步骤预算、认证/接管、细粒度记忆、外部渠道和平台装配仍需后续证据或实现。

## 第四轮：完成标准、执行依据与评估（2026-11-02）

用户确认后续开发顺序；本轮先实现完成标准的本地可核验部分。版本0.4.0/private=true，仅标识独立迭代；完整对象边界见 [0004-completion-contract.md](docs/iterations/0004-completion-contract.md)，后续未实现项见 [roadmap.md](docs/roadmap.md)。

- **67 / 67完整回归通过**，约57.94秒：[完整日志](evidence/phase4-tests-full.log)。其中新增12项完成契约/依据/迁移/Pi恢复检查，既有问答、记忆、接待、资料权限、SIGKILL及崩溃窗口继续通过。
- 64个JavaScript模块语法检查通过：[记录](evidence/phase4-check.log)。不是类型检查。
- src/bin/test/scripts/docs格式检查通过：[记录](evidence/phase4-format-check.log)。
- 实际CLI初始化新profile及资料根，提交带完成条件的工作、查询真实源/笔记依据、确认检查通过及semanticReview=unverified；另提交缺失原文条件的工作，确认blocked且没有成功Result/Delivery。6项断言通过，进程已关闭：[CLI证据](evidence/phase4-cli.json)。模型为fixture，没有真实模型请求。
- 初次领域回归17/18通过，唯一失败是旧测试残留schema3预期，保留 [失败日志](evidence/phase4-domain-initial.log)；修正后聚焦30/30通过：[日志](evidence/phase4-focused.log)。没有覆盖原失败证据。
- 第三轮源码已在修改前封存evidence/phase3-source-before-completion.tar.gz，第三轮验证清单及报告保留。当前schema4迁移不回填历史依据，不改变旧snapshot；旧工作明确修订后采用新标准。

当前程序可证明同执行的笔记发布、指定资料读取/哈希和原文包含，以及本地交付接受。语义要求记录为未验证；不以字符串检查证明总结准确或业务目标真正满足。尚未实现本轮路线图后续的接待查询port、独立回应/通知策略、预算、技能和自动证据记忆。没有Join集成/部署或Core/router重启。

## 第五轮：高内聚、低耦合的有界接待查询（2026-11-02）

用户要求「功能模块要高内聚低耦合」。本轮分离context/query/planner，增加SELECT-only读取port和ScopePolicy只读权限facet，原业务owner继续提交写入。版本0.5.0/private=true；见 [迭代记录](docs/iterations/0005-reception-queries.md)。

- **87 / 87最终完整回归通过**，约63.40秒：[最终日志](evidence/phase5-tests-final.log)。新增20项查询/结构/权限/恢复回归，既有67项继续通过。
- 71个JavaScript模块语法检查通过：[记录](evidence/phase5-check-final.log)；不是类型检查。src/bin/test/scripts/docs格式检查通过：[记录](evidence/phase5-format-check.log)。
- 实际CLI新建独立profile和资料目录，列资料、主接待读取真实文件及核对哈希、查询进度、查询记忆版本后经原MemoryService保存偏好。6项断言通过，未创建工作/产物，演示runner已关闭：[CLI证据](evidence/phase5-cli.json)。模型为fixture，没有真实模型服务请求。
- 20项新增测试包括：query模块不导入命令/adapter/runtime、不持有app/r/uow；读取适配器只含SELECT且连接私有；真实六类查询不增加SQLite total_changes；会话外工作/owner/伪造参数拒绝；资料分块、哈希、路径/链接/绑定；旧消息不能直接或经委托间接扩权；schema4→5不回填授权；工作分页；记忆墓碑；1000条后续消息之后仍定位原输入；次数/返回量限制；查询后的CAS；轻读不生成工作；失败保留host trace；查询后退出恢复时重读新资料且只提交一份回复；实际model-mode适配器使用Pi faux provider的查询往返及非法JSON拒绝。
- 早期19项既有接待/问答检查通过：[记录](evidence/phase5-existing-with-query-loop.log)。36项聚焦检查通过：[记录](evidence/phase5-query-focused.log)。第一轮完整86项通过后，进一步收敛权限到ScopePolicy只读facet，并新增策略撤销测试，最终87项通过；两份全量日志分别保留，没有将前一轮冒充最终源码结果。
- 第四轮源码在修改前封存evidence/phase4-source-before-queries.tar.gz，历史验证与失败证据保留。当前schema5仅新增接待query_scope_json与历史索引，保留旧输入、工作、条件和执行快照。

当前只证明有界机制和已测场景。真实模型语言质量、全部提示注入防护、完整执行费用/墙钟预算、独立回应/通知策略、技能、自动证据记忆与平台装配仍未验证或实现。没有Join集成/部署或Core/router重启。

## 第六轮回应与通知（2026-11-02）

版本0.6.0，schema仍为5。全量94/94通过（约71秒），其中新增回应测试7项；语法检查72模块，格式检查通过。日志：evidence/phase6-tests-full.log、phase6-responses-final.log、phase6-check.log、phase6-format-check.log。

覆盖延迟接话、快回复不打扰、接话后仍须回答、重开去重、工作分版本进度、旧失败抑制、例行/无关联工作静默及失败状态与通知原子回滚。保留前轮交付崩溃恢复验收。没有调用真实模型服务、外部IM或操作Join；可配置静默、通知条件和批量合并尚未实现。

## 六项助理能力交付（0.7.0 / schema10，2026-11-02）

技能、自动证据记忆、事件触发、选择/合并通知、无人关注保护、分型用户等待均接入独立runner。完整需求对应表见docs/superapp-capabilities.md。

最终全量131/131通过，约84.31秒，evidence/capabilities-tests-final-ports.log。语法检查90模块，evidence/capabilities-check-final.log；格式通过，evidence/capabilities-format-check-final.log。schema10与窄port额外7项实查通过，evidence/capabilities-ports-audit.json。第一轮同范围131/131通过也保留于capabilities-tests-final.log；收窄依赖后重新全量运行，没有用旧绿灯代替新源码验收。

新增覆盖真实CLI装配、Pi技能工具/三种等待、文件变更/删除触发、主接待类型查询、安全输入提交后进程退出恢复、密文存储和秘密不入核心/原生记录、用户更正/遗忘保护、提议重开、批量回滚、快照重提议、通知合并/抑制、暂停/恢复以及旧schema迁移。模型适配器两阶段提议/复核使用受控响应测试，未调用真实模型服务或远程认证、未修改Join。

失败记录保留：phase7-skills-initial/second（错误预期/路径/辅助导入）；phase9-events-initial/second（SQL占位数与测试时钟/异步准备）、phase9-events-focused与phase9-tests-full（中间语法错误）；phase11-interventions-initial/second（CLI shebang和普通answer分型漏检）；final-capabilities-focused及focused-second（接待读模型未投影kind、测试遗漏completed导入）。以上均已修复并由最终全量覆盖，不删日志或伪称初次通过。

本轮没有对真实模型质量、语义通知判断、远程事件连接器、具体OAuth服务或长期无人值守作通过结论。所有测试profile及其子进程由测试清理，额外schema审计profile也已删除。

## 模块分治文档（2026-11-02，代码仍为0.7.0）

新增21个目录AGENTS，加上根规则共22份；docs/module-map.md提供owner/入口/接口/验证/共享接缝导航，roadmap列P0与后续。仅修改文档，核对原90个.mjs、schema.sql和两个依赖清单共93文件哈希未变；当前无新增.mjs。检查目录覆盖、本地链接和格式，具体计数与文件哈希见evidence/module-map-validation.json。

本轮没有重跑131项业务测试；旧结论与固定源码归档保持。额外通过隔离profile故障注入复现pump共用catch的阶段饥饿风险，见module-map-pump-diagnosis.json，标为已知未修复缺口，不冒充新功能通过。自建runner已关闭、临时profile已删除，未触碰Join或真实凭据。

## 主助理续接（0.8.0 / schema11，2026-11-03）

最终全量164/164通过，约103.51秒，日志[evidence/continuation-tests-release.log](evidence/continuation-tests-release.log)；新增专项33/33通过，日志evidence/continuation-focused-final.log。语法检查92模块（不是类型检查）和格式检查通过，见continuation-check.log、continuation-format-check.log、continuation-root-format-check.log。逐文件源码哈希、归档及链接/目录核对见[evidence/continuation-validation.json](evidence/continuation-validation.json)。

已覆盖报告持久化与系统turn、主助理继续/交付/静默/阻塞、原话和最新修正快照、最多4项命令原子批量、安排命令真实owner/CLI、纯文本无笔记、报告分页/范围、重复与迟到结果、取消/修改、两处真实进程崩溃、不重复Pi输入/产物/通知、续接计数跨重开、已保存失败只重试结算、schema1/2/3/4/10迁移，以及pump阶段故障隔离。原131项机制均继续全量回归。

源码归档evidence/superapp-continuation-0.8.0-source.tar.gz与旧0.7.0归档分开保留。未新增依赖，模型为fixture或受控响应，未调用真实模型服务、发送远程IM、接外部OAuth或部署Join。统一持久预算和长期无人值守仍未完成。详细边界见[续接说明](docs/assistant-continuation.md)与[迭代记录](docs/iterations/0013-continuation.md)。

## 运行保护与用量（0.9.0 / schema12，2026-11-03）

用户要求按Grokbot同级保护推进。实现持久Execution步骤检查、原生Pi中止、每次活跃运行超时、接待/学习截止、有限模型重试和只读usage查询；新增UsageService模块与AGENTS，未引入金额额度系统。细节见[0014记录](docs/iterations/0014-run-guardrails.md)。

最终全量183/183通过，约106.63秒：[完整日志](evidence/guardrails-tests-full-first.log)。其中19项新增保护专项涵盖真实Pi超限后无额外模型产物、已有产物保留、新revision、用户等待后恢复、只读原生usage不唤醒任务、重复采样不重复累计、未知与fixture分组、schema11迁移、真实CLI、迟到提议拒绝、复核超时保留提议和统计写入失败不重跑模型。100个模块语法检查通过（非类型检查），格式检查通过；记录为guardrails-check-final.log、guardrails-format-check-final.log和guardrails-root-format-final.log。

扩展personal-scenario实际运行17项断言通过：[演示日志](evidence/guardrails-personal-demo.log)。模型为fixture、Pi/文件/SQLite/socket真实；保留源、对话、产物、事件与usage，runner已停止。真实模型服务未调用，质量继续为未验证。

失败日志保留：guardrails-focused-first.log为12/14（只读Harness缺registry）；修复后second14/14、third聚焦40/40通过。focused-final18/19中唯一失败为新quota测试的未定义workId引用，修正后最终全量183/183通过。旧0.8.0源码、验证与失败证据不覆盖；本轮固定归档为evidence/superapp-guardrails-0.9.0-source.tar.gz，逐文件哈希、导航/链接、依赖对比与演示路径见[新验证清单](evidence/guardrails-validation.json)。

没有Join集成/部署、Core/router操作、真实IM/OAuth或公共发布。当前仍development，真实模型质量、实际业务连接和长期数据运维仍待验收；统一金额预占/扣账已退出当前完成标准。

## 执行接口与分模块验收（0.10.0 / schema12，2026-11-03）

用户采纳工具接口收窄与场景拆分。本轮将PiExecutionAdapter/assistant-tools对完整app的依赖改为原owner窄port，工具固定原工作与快照；业务所有权、事务、权限检查和Pi恢复不变。scripts/scenarios分别实现memory/work/automations/skills，支持单选、逐项断言/复查与failed/not_run/not_selected记录；context只管理临时进程和采证。详见[0015记录](docs/iterations/0015-module-boundaries.md)。

最终全量193/193通过，约115.82秒：[日志](evidence/module-boundaries-tests-full.log)。新增专项10/10、原相关聚焦33/33均通过；新增覆盖四个CLI场景独立运行、工作绑定与取消校验、非法选择提前拒绝、途中失败仍采证/关闭与未跑项保留、缺少显式模型凭据不发请求。故障路径测试的非零退出是预期，不伪称实际调用成功。

最终组合fixture演示25项断言全部通过，所有quality仍unverified：[日志](evidence/module-boundaries-demo-final.log)。本地Pi/文件/SQLite/socket实际运行，没有调用真实模型服务、远端认证、IM或Join。108模块语法（非类型）与格式检查、链接/目录覆盖、依赖和schema未变、源码归档逐文件哈希及演示关闭状态见[独立验证清单](evidence/module-boundaries-validation.json)。

版本0.10.0/private=true，schema仍12，不需要新增迁移。原0.9.0归档、记录和历史迭代不覆盖；本轮源码封存为evidence/superapp-module-boundaries-0.10.0-source.tar.gz。ReceptionService/WorkCoordinator和同步本地Vault等剩余接缝保持如实记录，未把本轮范围称为全仓完全解耦或成熟产品验收。

## 持续安排与长期上下文（0.11.0 / schema13，2026-11-03）

用户要求先学习Grokbot并补持续安排/长期上下文，不等待真实模型测试。本轮实现显式时区calendar/once、原ID更新与有限stopWhen/父报告结束；个人/当前授权项目和profile/log分层、默认有界召回、文字搜索及历史原文检索。保持原Routine/Memory/Conversation/Work等owner，Pi经原窄port读取，不引入新依赖或通用工作流/知识库。见[实现说明](docs/long-running-assistant.md)与[0016记录](docs/iterations/0016-long-running-assistant.md)。

最终全量204/204通过，约137.83秒：[最终日志](evidence/continuity-tests-final.log)。新增专项11/11通过，含实际Pi调用recall_memory/search_history、日历/DST、一次性/重开、原ID更新/CAS、条件结束与交付接受、项目隔离、自动记忆来源/显式保护、原文只读、schema12迁移与真实CLI。既有四模块fixture演示25项断言通过：[演示日志](evidence/continuity-personal-demo.log)。114模块语法（非类型）和格式检查、链接/目录覆盖、依赖对比与固定源码哈希见[本轮清单](evidence/continuity-validation.json)。

保留中间失败：原相关首轮41/43因memory窄facet漏注入recall；修正后domain/memory-learning19/19。新增首轮7/10、第二轮9/10因测试误读既有query/CLI回执封装，修正后11/11。首轮全量203/204为默认只读工具白名单旧预期；更新后release回归203/204出现一次SIGKILL恢复socket超时。未放宽超时，单独真实崩溃重跑1/1通过，见continuity-crash-recheck.log，再次最终全量204/204通过。记录主机load约39，但不据此断言超时根因已证实或根治；完整失败日志保留。

schema13不重建memory/provenance或改写旧快照，只补日历字段和memory_detail；旧记忆默认user/profile，未知更新时间0，不伪造历史。固定归档为evidence/superapp-continuity-0.11.0-source.tar.gz，旧0.10.0及历史归档保留。未调用真实模型服务、外部IM/认证或操作Join，质量仍development/unverified。条件完成为model-reported，文字搜索不是语义检索；完整cron、复杂流程、episode摘要、向量召回与远端接入仍未完成。

## Grokbot记忆整理（0.12.0 / schema14，2026-11-03）

本轮按用户“紧跟、近乎复刻”要求补核心记忆整理链路：内容事实/去重/遗忘墓碑、create/update/remove与独立复核、15秒/12轮合并、512快照/指纹/CAS、90秒整次截止与三次重试、小时轮询/每日日期复查，以及真正进入接待/执行的profile/recent。原Memory/学习owner与UoW保留。旧来源不明条目的现代协议保护范围被新证据纠正规则替代；explicit/forget保护仍在，旧key提议可恢复。细节和差异见[对照](docs/grok-memory-parity.md)、[0017记录](docs/iterations/0017-memory-parity.md)。

最终固定代码全量227/227通过，约135.25秒：[最终日志](evidence/memory-parity-tests-release.log)。本轮23项专项包含现代增改删/内容遗忘/重开/去重/legacy纠正、15秒12轮、clock边界、64/500/512、总截止与迟到拒绝、否决三次/恢复复核、实际上下文注入/截断、note及schema13迁移。新增首轮13/14因测试证据归属写错被正确拒绝，修正测试后扩充专项+原记忆28/28，随后补齐导入旧记忆立即复查、遗忘更新移除旧事实、历史大段记忆界限与显式key更正保护，最终23项进全量；首轮223/223及第二轮226/226均保留；原相关40/40和记忆10/10也通过。原日志全部保留，没有放宽超时或引用校验。

四模块CLI fixture演示25项断言通过：[最终日志](evidence/memory-parity-personal-demo-release.log)，自动学习实际经现代synthesis协议；Pi/SQLite/文件/socket真实，模型为fixture，quality均unverified，演示进程已退出。116模块语法（非类型）和格式检查通过；链接/24份AGENTS覆盖、依赖未变、旧历史/归档未改、当前源码冻结与逐文件哈希见[清单](evidence/memory-parity-validation.json)。

schema14新增记忆墓碑/复查/学习控制与任务批次字段，不改写旧快照/日期/提议；旧遗忘内容已为空时不补造跨key保护。固定源码为evidence/superapp-memory-parity-0.12.0-source.tar.gz，旧0.11归档保留。仍SQLite单助理/当前授权项目，未复刻agent shard、多项目汇聚和Markdown文件权威；未调用真实模型/远程服务，未操作Join，development状态保留。

## 文件权威、分片与多项目（0.13.0 / schema15，2026-11-03）

用户要求把上一轮agent shard、多项目汇聚和Markdown文件权威研究、写AGENTS并实现。本轮已落地私有agent/共享user/项目分片、单写者限制与来源、显式成员/原grant/最多3项目注入、文件事实+旁车权威、SQLite可重建索引与可恢复文件事务；新默认agent、旧user不改归属。主助理/CLI/Pi实际接通，迁移保留旧key/revision/日期/来源/快照并有完整原始备份。见[设计与实际边界](docs/memory-files-and-shards.md)、[0018记录](docs/iterations/0018-memory-files.md)。

最终固定代码全量250/250通过，约212.92秒：[日志](evidence/memory-files-tests-release.log)；新增23/23通过，包含真实Pi读文件、CLI/自然项目协议、两助理读写范围、项目旧grant撤销/重入、三项目注入、手改/重建、schema14备份/迁移、失败/嵌套事务、进程提交前后/另一agent恢复、第三方冲突、路径/元数据/符号链接、并发初始化，以及自动共享不打断当前工作。最终测试开始/结束代码哈希相同。

四模块CLI fixture演示25项断言通过：[日志](evidence/memory-files-personal-demo-release.log)，quality仍unverified，进程已退出。123模块语法（非类型）及格式检查通过；25份AGENTS、链接、依赖未变、历史与旧0.12归档保持、当前源码归档/逐文件哈希见[清单](evidence/memory-files-validation.json)。首轮全量238/242、迁移27/28、共享装配2/32等中间失败及修正均保留在0018和独立日志，未用旧绿灯覆盖当前源码。

没有真实模型/远程服务、Join操作、远端Git或发布。本地文件/SQL协调不是跨媒介物理原子或跨机/断电承诺；未知锁或外部冲突保留现场。当前仍development，真实模型质量、平台内置映射与一致备份运维后续单独验收。

## 主会话长期工作上下文（0.14.0 / schema16，2026-11-04）

已实现四组有引用的滚动工作摘要、消息内覆盖游标、父版本CAS、生成输入/尝试持久化、失败gap与有限重试、原文分页查证，以及接待/报告/新委托实际注入。原文历史、个人事实记忆、工作与等待权威不变。见[说明](docs/conversation-working-context.md)和[0019](docs/iterations/0019-working-context.md)。

固定代码全量269/269，约185.19秒：[日志](evidence/working-context-tests-first.log)；新增19项和查询/续接相关共72/72：[日志](evidence/working-context-focused.log)。包含真实Pi snapshot、CLI/socket、两个真实进程崩溃窗口、Unicode完整分段、原文/范围/旧锚点、回滚与过期提议拒绝、有限重试/超时/关闭以及schema15升级。测试期间代码哈希未变。

129模块语法（非类型）与格式通过；四模块CLI fixture演示25项断言通过，schema16实际产生ready摘要，退出无残留socket/锁，quality仍unverified。26份AGENTS、链接/模块owner覆盖、旧历史/依赖保持、固定源码归档和逐文件哈希见[清单](evidence/working-context-validation.json)。首轮27项26通过（旧schema期望）及新专项15项12通过（测试身份/协议封装）失败记录保留；修正后全量通过。

当前仍独立lab的同步SQLite适配，不是Join网络主线程接入方案。未调用真实模型/IM/远程业务服务，未操作Join/Core/router、远端Git或发布。真实长期摘要保真、语义取舍和更正质量仍需单独验收。

## 用户交互与SendMessage（0.15.0 / schema17，2026-11-04）

主助理send与原报告deliver.message接入统一用户消息出口；原文+payload/outbox同事务、稳定ID、五次失败/显式retry、原消息引用、真实附件字节、Interaction选择/安全等待、revision失效撤回、通知附件合并、本地渠道接受均已实现。Work完成仍沿原Completion/Result/local-mailbox契约；accepted不是用户已读。详见[设计](docs/user-messages.md)与[0020](docs/iterations/0020-user-messages.md)。

最终固定源码全量288/288，约201.83秒：[日志](evidence/user-messages-tests-stable.log)；新增消息18项+记忆锁回归1项，原269项继续通过。包含真实Pi选择/CLI同submission、主助理受控附件查询/最终交付、SQL原子性、权限/旧卡/旧revision、复制字节/篡改、慢transport控制连接、失效消息/有限失败不饿死、schema16与真实进程写文件/回执恢复。源码在最终全量期间未变。

136模块语法（不是类型检查）及格式通过；四模块CLI fixture演示25断言通过，用户消息已接受文件与附件哈希另核对，进程退出无socket/锁残留。27份AGENTS、链接/目录owner、依赖/历史不变与固定源码哈希见[清单](evidence/user-messages-validation.json)。原版本列表遗漏、夹具命令ID/新阶段缺失、prepare静态守卫冲突、真实SIGKILL busy及确定性锁期限复现等失败全部保留于0020和日志；修复保持未知/活跃锁保护。

当前只配置local:main，无新增UI、Slack/飞书实际连接或已读回执。主助理普通澄清仍为文字，选择卡绑定原工作Interaction。未借共享认证或调用真实外部服务、真实模型，未修改/部署Join。内置接入必须映射原生消息权威/账号/目的地并使用Worker/独立进程端口；本lab同步SQLite/文件I/O不直接进入Join网络主线程。
