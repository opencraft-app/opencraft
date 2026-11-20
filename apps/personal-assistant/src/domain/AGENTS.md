# 领域规则

继承[上层规则](../AGENTS.md)。这里拥有纯计算规则，不拥有存储、模型、时钟调度或进程。

- Assistant/Delegation：稳定身份、原授权与资源binding；进程/Pi会话ID不是助理身份。
- WorkItem/CompletionContract：revision、生命周期（含awaiting_review）、修改/取消、默认笔记或显式文本的机器完成条件与语义要求；旧快照语义保留。
- ContinuationDecision：系统报告的continue/deliver/silent/blocked形状和自动续接次数上限，不接管事件存储或交付。
- Interaction：请求种类、原工作版本、期限和回答约束；普通answer不能完成敏感等待。
- MemoryEntry：CAS和遗忘墓碑；Routine：触发、到期和次数；Skill：内容定义/哈希；ReceptionQuery：查询形状与界限；NotificationPolicy：通知枚举/来源兼容。

通过参数提供观察时间；不读文件、数据库、网络、环境变量或全局运行器，不增加副作用。领域对象不能直接保存自己，写入交给application owner。修改旧数据兼容规则时保留原快照含义，不补造历史证据。

验证：在 apps/personal-assistant workspace 目录执行`node --test test/domain.test.mjs test/completion.test.mjs test/interventions.test.mjs`；依赖边界见`test/ownership.test.mjs`。领域改动通常还需跑受影响的用例测试。

RunPolicy拥有局部默认值、配置校验和RunLimitError；usage.mjs只标准化可观察计数/价格估算与未知项。纯规则不读取环境、provider或计时器，不建立财务额度。持久步数属于ExecutionLedger，统计快照属于UsageService，真实中止与回执读取由adapter负责。

CalendarSchedule纯计算显式时区的星期/小时/分钟列表与once时刻；传入anchor/lastAt，不能读取系统当前时间猜日程。8天有界搜索，DST重复slot只一次。memory-recall.mjs拥有scope/kind/key地址与查询界限；实际项目grant仍由ScopePolicy/MemoryService检查。Routine stopWhen要求期限/次数；条件满足由模型报告，纯规则不冒充语义验证。

MemorySynthesisPolicy与memory-synthesis.mjs拥有15秒/90秒/小时/每日默认值、500字符规范化、内容ID/墓碑ID和快照指纹；仍无I/O。内容ID包含scope/project，显式遗忘不是按语义匹配。

memory-spaces.mjs定义安全项目slug、只读可见范围、项目grant ID/binding和三项目排序；memoryKey增加agent及具名project地址。纯规则仍不读文件/SQL或自行加入项目。默认scope来自宿主profile；旧默认user保留。

conversation-context.mjs拥有默认有界策略和四组摘要/引用形状校验。只验证结构、来源集合和字节上限，不证明语义、授权或任务完成；canonical消息与角色由host提供。长消息游标归application，模型不能提交游标。

user-message.mjs验证有限消息类型、1..6选项、附件ID/replyTo/配置目的地；不做文件/网络I/O。Interaction可把真实选项value或唯一label映射为原value，allowCustom才允许额外值。send/deliver.message都是提议，不是完成或渠道回执。

2026-11-09：memoryLexicalTokens统一索引与查询的Unicode词切分/小写；memoryRecallTerms继续只对当前输入做6000字符/24词和停用词界限。BM25评分与索引生命周期归SQLite adapter，domain不持有I/O。

0.17：goal.mjs 验证有界计划、唯一 key、依赖引用和 DAG 无环、优先级/并发范围；不持有 Work 状态。系统 deliver 可携带受宿主成员校验的 goalPlan/goalReview；用户 goal.rebase/reopen 与目标 CAS 独立于 Work revision。
