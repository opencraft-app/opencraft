# 自动证据学习任务

继承[应用层规则](../AGENTS.md)。MemoryLearningService拥有证据、快照、提议、重试和结算任务；记忆值与来源仍由上层MemoryService唯一写入。

依赖注入memory的learningSnapshot/captureSnapshot/snapshotCurrent/applySynthesis/reviewDue/reviewed facet及旧epoch/applyLearned兼容方法、任务repository和UoW。模型只收数据；提议和独立复核在事务外，由runtime协调。每项变更必须引用本任务原用户消息，助手文本不能自证事实。

显式设置和遗忘墓碑不能自动覆盖。0.12.0依用户最新要求，现代协议可凭新用户证据修正/移除legacy；此范围替代旧“一律保护来源不明”条款。旧key协议保留历史保护。提议先持久化；重启从复核继续。epoch冲突废弃旧提议、保留证据并有界重做，不用旧值覆盖用户新决定。批量值、provenance、epoch和任务完成同事务。

全局epoch用于学习CAS；新工作另用显式变更屏障，避免自动提炼中断普通执行。旧快照保持原检查含义。不要把按key墓碑描述成跨key语义遗忘，不把模型复核描述成已证明语义准确。

验证：`node --test test/memory-learning.test.mjs test/interaction.test.mjs test/runner.test.mjs`，重点引用/复核、回滚、冲突恢复、显式更正屏障。更强检索/语义遗忘是后续开发，当前不要增加假实现。

0.11.0增加用户/项目与profile/log层次，值/metadata仍由原MemoryService唯一写入。memory_detail不构成第二个可写知识库；项目ID来自被授权资料binding。captureSnapshot固定原消息资源范围，projectId随学习任务保存，rebase不能扩大到新项目。用户原话时间随证据传递；updatedAt只是宿主写入观察。新增文字召回/历史检索由原Memory/Conversation owner和SELECT-only adapter协作，非向量/语义检索，尚无episode摘要。

0.12.0主链路见[对照](../../../docs/grok-memory-parity.md)。capture持久保存有界证据，pending原子冻结同授权上下文最新12轮并标记merged/dropped；原ConversationHistory不删除。模型输出现代create/update/remove，验证引用、目标ID唯一性与64项上限；MemoryService再次检查内容墓碑和快照。整体90秒截止在runtime，不在事务里等模型。时间复查由本owner创建持久任务/next-poll控制，事实owner管理next-review；clock只能用于时间任务的已有事实。普通用户更正/遗忘仍有优先权。现代否决最多三次重新提议，传输失败保留已存提议供复核恢复；后者是相对恢复源码的有意差异。

内容墓碑只按规范化同文保护，不宣称语义遗忘。原文/旧证据和失败保留；过期project绑定不能扩大。当前单助理/当前项目，不建立64-agent调度池。新增验证入口test/memory-parity.test.mjs，schema14升级与事务/迟到/重开须保持。

本轮文件权威/分片扩展以根最新裁决和[设计](../../../docs/memory-files-and-shards.md)为准。MemoryService仍唯一业务规则owner；文件适配器拥有真正落盘与SQLite索引刷新，不能从模型越过MemoryService写文件。MemoryProjectService负责显式项目成员资格，通过inbox和同步文件端口提交；读取/学习范围固定原grant，leave/rejoin不扩给旧执行。自动提炼只修改本agent拥有的agent/user/project shard，其他来源为只读。新profile默认agent，旧profile保持user。详细实施检查见存储AGENTS，不能把计划写成已通过。

0.13已接MemoryProjectService，依赖只有project/projects文件窄端口、inbox和invalidate回调；MemoryService只得同步/项目只读列表/位置/受限read端口，没有项目写入或fs权限。snapshot.facts只含本agent可写事实，sharedMemories带来源且只读；现代动作可以指定已捕获的project。证据批次按原projectId+grant集合分组；rebase不能加入后来项目。文件与SQL通过可判别日志协调，不把跨媒介效果称物理原子。
