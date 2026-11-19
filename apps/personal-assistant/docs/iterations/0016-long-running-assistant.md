# 0016：学习Grokbot的持续安排与长期上下文（0.11.0 / schema13）

2026-11-03用户要求「3和4 理论上不测试也可以补一波？你就学习一下grokbot 行吗？」。提出人未确认。本轮直接补持续安排和长期上下文，不以真实模型/外部服务验收为开发前置。保留必要本地机制回归；仍独立runner，没有Join操作。

## 参考与实现

研究固定0.18恢复源码a9f633e09d49a85829b8236331b9e21f7e612634的automation意图/时区/有限盯办、FileMemoryStore的profile/log、UserMemoryStore/ProjectMemoryStore聚合与turn-memory证据/episode路径。恢复代码不等于官方完整产品，未运行原厂服务。机制与限制集中在[持续助理说明](../long-running-assistant.md)，实现未复制研究源码或增加依赖。

- CalendarSchedule支持显式时区的星期/小时/分钟列表、工作窗口和once；保留interval。日历挂起/重开、漏跑合并、DST缺失/重复时间槽有明确规则。Routine owner支持原ID更新、CAS、保留历史/资源并退役旧指令。
- stopWhen必须有限期/次数；合格报告的父决策可结束对应版本盯办，保留当前结果交付，记录model-reported。到期停止不等于截止通知，后者需要明确once任务；没有新增通用workflow状态机。
- Memory owner新增用户/当前授权项目与profile/log元信息，证据提议/复核保留原owner。项目绑定随学习快照保存，换资料根后不召回/改写旧项目事实，恢复/重提议不扩大范围；显式事实和遗忘墓碑继续保护。
- 档案/近期有界选择、文字查询和历史原文搜索接入接待及Pi窄port；worker只能查自己已关联的主会话，新工具不扩给旧Delegation。保留稳定消息/事实ID、角色、来源与截断信息；不把文字匹配称语义检索或把摘要冒充证据。
- schema13增加routine三个字段及memory_detail，保留旧memory/provenance/输入/快照。旧事实按user/profile、未知日期0读取，不伪造历史归属。profile.timeZone显式配置，旧profile默认UTC，不修改原文件。

## 验证与失败记录

新增11项专项通过，见[evidence/continuity-new-final.log](../../evidence/continuity-new-final.log)，包含真实Pi调用新记忆/原文工具，以及日历/DST、条件结束与接受交付、原ID更新、项目隔离、自动学习保护、原文只读、schema12升级和实际CLI。

首轮原相关43项为41通过/2失败：ExecutionService的窄memory facet漏注入recall，导致快照与工作推进失败；修复后原domain/memory-learning19/19通过。保留continuity-focused-first/second.log。新增专项first为7/10、second为9/10，均为测试误读既有query/CLI回执封装，修正.response.data/.result后11/11通过；原失败记录保留。

首轮全量204项为203/204，唯一失败是旧授权测试仍列六个默认工具，未纳入两项新的宿主只读工具；更新明确白名单后重跑最终全量。保留[首轮全量](../../evidence/continuity-tests-full.log)，后续release回归仍为203/204，一次SIGKILL后的本地socket请求超时，见[release日志](../../evidence/continuity-tests-release.log)。未改超时参数，单独重跑该真实崩溃场景通过，见[复查日志](../../evidence/continuity-crash-recheck.log)；当时主机load约39，但尚不能认定超时根因。再次全量的实际结果见[最终日志](../../evidence/continuity-tests-final.log)和[固定验证清单](../../evidence/continuity-validation.json)。没有放宽模型提供授权、改掉未知状态或关闭原恢复断言。

既有四模块fixture演示25项断言通过，见continuity-personal-demo.log；114模块语法检查（不是类型检查）、格式、链接/目录覆盖、依赖对比、源码归档哈希与演示停止状态见验证清单。独立归档evidence/superapp-continuity-0.11.0-source.tar.gz，旧0.10.0和历史记录保持。

## 剩余大项

完整cron/月年、外部事件截止补偿与复杂多阶段流程、共享项目/多Agent记忆、episode摘要/压缩与向量召回、真实模型语义质量尚未实现或验证。新增机制使当前CLI/无界面runner能表达更多持续委托并找回旧上下文，仍为development。
