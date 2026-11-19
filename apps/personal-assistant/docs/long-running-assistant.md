# 持续安排与长期上下文（0.11.0 / schema13）

用户2026-11-03要求「3和4 理论上不测试也可以补一波？你就学习一下grokbot 行吗？」。提出人未确认。本轮先推进独立runner的能力，不以真实模型/外部服务验收为开发前置；本地数据和调度回归仍保留。没有修改Join或访问共享模型凭据。

## 从Grokbot吸收了什么

参考固定0.18恢复源码a9f633e09d49a85829b8236331b9e21f7e612634，非官方重建/扩展，不能将全部行为当成官方产品已验证事实。

- automation.ts把routine定义成“保存的意图＋触发规则”，要求考虑用户时区/工作窗口，有限盯办有结束条件，变更沿原安排保留历史。停止条件多由模型执行指令，不是宿主已经验证的业务谓词。
- memory-service.ts的FileMemoryStore分别召回profile和近期log；UserMemoryStore/ProjectMemoryStore另有跨分片/项目聚合。本轮吸收层次与有界召回，没有照搬文件分片或引入多Agent共享权威。
- turn-memory.ts区分原用户证据的学习路径与旧episode摘要路径；不能把摘要当原始用户事实。我们保留证据提议/复核，补原文检索；本轮没有实现自动episode摘要或语义向量检索。

参考路径：`/data/research/opencraft-superapp-20261102/grokbot-018/source/host/automations/automation.ts`、`source/shared/automation-schedule.ts`、`source/host/extensions/memory/memory-service.ts`、`source/host/runner/turn-memory.ts`。只研究机制，实现留在当前owner内，不复制其源码。

## 持续安排

RoutineService仍独占定义与Occurrence。现有interval保持原语义，新增两种明确结构：

```json
{
  "kind": "calendar",
  "timeZone": "Asia/Shanghai",
  "weekdays": [1, 2, 3, 4, 5],
  "hours": [9, 14, 17],
  "minutes": [0]
}
```

```json
{ "kind": "once", "at": 1794000000000 }
```

calendar按当地星期/小时/分钟列表匹配，Sunday=0；日常、每周和工作窗口都用这一结构。时区必须显式提供；profile可配置timeZone供接待参考，旧profile默认为UTC，不猜宿主机器时区。一次性安排只产生一个工作；日历漏跑采用一次合并补偿，不回放停机期间每一个时点。春季不存在的当地时间跳过，秋季重复的同一当地时间槽只触发一次；持久last_scheduled_at保留跨重开身份。搜索上界8天，当前不实现月/年或完整cron语法。

routine.update以expectedRevision提交完整新定义，保留安排ID/历史/原资料范围，取消旧指令尚未完成的工作，旧报告不能结算新定义。paused安排更新后仍暂停；resume日历规则找下一个时点，不变成无条件立即执行。interval原有恢复行为保留。

短期条件盯办使用stopWhen加expiresAt/maxRuns，必须有限；到期沿原机制停止，不能保证到期本身产生额外提醒。需要截止时检查并提醒时，另建once安排，提示词明确该任务。在当前条件盯办的合格报告回到主助理后，deliver/silent决策可附finishRoutine:true：Routine owner核对原安排版本与stopWhen，将其置exhausted，当前交付仍按原链路接受。condition-observed记录verification=model-reported，不冒充远端工具验证或宿主语义判断。没有stopWhen的普通安排不能通过该标记被停止。

意图、stopWhen、计划时间与观察时间随工作保存，后续回合读取实际状态；不把新流程状态藏在提示词或runtime计时器里。quiet条件盯办也能产生持久父报告回合，原never通知策略仍可保持静默。事件截止补偿和复杂多阶段工作流仍待真实场景扩展。

## 记忆和历史召回

MemoryService继续唯一写入事实、来源、epoch和墓碑；没有新建独立可写知识库。新增metadata区分：

- scope=user：个人范围，旧数据沿用；scope=project：绑定当前授权materials根的稳定binding。相同逻辑key在个人和项目范围可共存。
- kind=profile：长期稳定事实；kind=log：近期/阶段记录。updatedAt是宿主写入时间，不能当成事实实际发生时间。学习证据另带原消息时间。

项目范围由宿主根据原资源grant和当前binding共同确定，模型不能传一个任意projectId扩权。切换资料根后，新上下文无法召回/修改旧项目事实；旧排队输入不能继承新项目范围。自动学习快照保存projectId，恢复/冲突重提议不切换为新项目。显式事实和遗忘墓碑继续禁止自动覆盖，来源仍引用原用户消息。

默认召回分别为稳定档案和近期记录留数量空间；模型可用memory.search/recall_memory做文字检索，避免只能读最初几条。返回数量、单项正文和上下文有界，截断如实标记；返回原key、版本、范围、更新观察和可得证据引用。检索当前是大小写归一的文字包含匹配，不是语义检索。默认档案/近期视图无翻页保证，带query时按key分页。

history.search/search_history检索主会话中更早的原消息，返回稳定消息ID、角色、时间、文本与游标；worker仅能读取与自己明确关联的会话。结果是历史数据，不授予新工具权限，旧回复不能当用户证据自动写入记忆。没有链接主会话的后台工作不开放主历史。

新执行快照使用有界召回；已经保存的旧快照不重写。新Pi工具通过0.10.0窄port接入，新增工具不会自动扩给旧Delegation。接待模型提示词已说明日历/一次性/更新/停止标记、记忆分层与按需原文查询；真实语言理解仍未验收。

## CLI

```bash
node bin/assistant.mjs init --profile ./profiles/me --owner local:me --workspace ./examples/materials --time-zone Asia/Shanghai
node bin/assistant.mjs routine-add --profile ./profiles/me --text '整理项目本周进展并发布笔记' --schedule '{"kind":"calendar","timeZone":"Asia/Shanghai","weekdays":[1,2,3,4,5],"hours":[9],"minutes":[0]}' --max-runs 5
node bin/assistant.mjs routine-update --profile ./profiles/me --routine ROUTINE_ID --revision 1 --definition '{"text":"新的工作指示","schedule":{"kind":"calendar","timeZone":"Asia/Shanghai","hours":[14],"minutes":[30]},"maxRuns":3}'
node bin/assistant.mjs memory-set --profile ./profiles/me --key milestone --value '本项目接口待验收' --scope project --memory-kind log
node bin/assistant.mjs memory-search --profile ./profiles/me --query 接口
node bin/assistant.mjs history-search --profile ./profiles/me --query 上次约定
```

CLI JSON封装和其他命令一致，结果在result字段。条件盯办可以经routine.update的definition或接待结构化提议设置stopWhen、expiresAt/maxRuns。

## 所有权与未完成范围

日历纯计算归domain/CalendarSchedule；定义/发生/停止归RoutineService，原Work/Execution/Outcome/Attention仍各守事实。分层事实归MemoryService，提议/复核任务归MemoryLearningService，原消息归ConversationHistory；SQL读写归SQLite adapter，runtime只装配窄facet和唤醒。

schema13只增加routine的schedule_json/last_scheduled_at/stop_when，以及memory_detail。原memory与provenance表、原快照/历史不改写；旧事实按user/profile读取，未知更新时间为0，不伪造项目归属和历史日期。新功能没有新增依赖。

仍缺完整cron/月年日历、远程事件截止补偿、复杂工作流、自主语义条件验证、共享项目身份、多Agent记忆聚合、episode摘要/压缩、向量召回和真实模型质量。本轮补足可直接使用的日历/条件盯办、分层记忆/原文检索，不能据此宣称与官方Grokbot完整等价。

## 后续0.12.0替代范围

本文保留0.11轮次事实。记忆后续已按用户要求补内容事实增改删、15秒/12轮合并、内容墓碑、独立复核和日期复查；现代legacy纠正替代此前一律冻结未知来源条目。新机制、默认值、真实限制与未实现的跨agent/多项目/文件权威见[记忆对照](grok-memory-parity.md)。日历与条件盯办仍沿本文原owner。

## 后续0.13.0文件权威与成员项目

本轮按用户最新要求补agent/user/project shard、Markdown权威和显式加入的多项目记忆。原workspace仍按materials binding；具名项目只授权记忆，不授予资料访问。旧“仅当前项目/SQLite为事实权威”范围被本次替代，迁移、原grant与恢复边界见[0.13实现](memory-files-and-shards.md)。
