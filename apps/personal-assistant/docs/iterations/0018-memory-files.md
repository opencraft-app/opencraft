# 0018：文件权威、助理分片与多项目记忆（0.13.0 / schema15）

2026-11-03用户要求「这些都看看具体怎么实现的写成agents.md 然后实现起来」。提出人未确认。范围仍是独立无界面runner，不涉及Join/Core/router或远端Git/发布。

## 先研究和写规则

核对固定非官方恢复/扩展源码a9f633e09d49a85829b8236331b9e21f7e612634的FileMemoryStore、UserMemoryStore、ProjectMemoryStore、AgentProjectMembership、agent-state写入口、sand-memory排序/预算与host/system-prompt装配。找到factory缺失、参数/返回形状和目录名接缝，未据此宣称官方线上已跑通。详见[设计与实际边界](../memory-files-and-shards.md)。

先写[新模块AGENTS](../../src/adapters/memory/AGENTS.md)、应用记忆/SQLite规则和设计，再实现。用户本轮覆盖0.12“SQLite是事实唯一权威/只当前项目”的范围；历史条款保留且根规则关联替代。更新相关目录与总地图，目前25份AGENTS含根；不新建多Bot管理器。

## 实际实现

- Markdown profile/月度log拥有事实，旁车保存来源/墓碑/key/revision/原证据元信息；SQLite记忆表作为可重建投影。手改文件可读生效，SQL缓存不能回灌覆盖文件。原工作/学习作业/输入回执仍SQLite权威。
- agent/user/project分片，每位助理只写自己的shard，其他助理私有记忆不读；共享条目带agentId/name。新profile默认agent，旧缺省继续user；同owner需显式同memoryRoot才共享。
- MemoryProjectService拥有create/join/leave，原inbox提交；grant固定到原输入/Delegation，leave/rejoin不激活旧grant。最多3项目完整注入、其他仅列成员，私有>项目>共享用户的提示词优先级已接入；项目加入不授予materials/Shell。
- MemoryFileStore/FileTransaction/FileAuthority与SqliteMemoryIndex各有边界，命令经原MemoryService/MemoryLearningService；事实与项目owner分别只得实际需要的端口。短锁不跨模型/网络；文件与SQL用提交收据/前后像恢复，不伪装物理原子事务。
- 主助理项目协议、记忆具名project、只读文件query、CLI和新Pi read_memory_file实际接入。其他助理自动共享积累不触发显式屏障；更正/遗忘/成员撤销仍让旧上下文失效。学习批次固定原grant集合，其他shard只读。
- schema15迁移真正生成文件后才记录状态，保留key/revision/来源/未知日期/旧快照；历史超长正文以500字符规范化为事实，完整原始SQL数据原子备份。已有文件优先，不自动合并回灌过时SQL；旧程序不能降级新格式。

## 验证

最终固定代码全量 **250/250通过**，212921.860807毫秒：[完整日志](../../evidence/memory-files-tests-release.log)。原227项+新增23项；开始和结束逐文件校对代码哈希，无运行中修改。新增23/23通过，见[memory-files-new-release.log](../../evidence/memory-files-new-release.log)，包括真实Pi/CLI、两助理共享/私有/写隔离、三项目注入、撤销/重入旧grant、自然项目命令、索引重建、手改保留、失败/嵌套事务、提交前后真实进程退出、另一助理恢复、第三方冲突、路径/格式/符号链接、schema14迁移/备份、自动共享不打断工作和双进程初始化。

四模块CLI fixture演示 **25项断言通过**，见[最终演示](../../evidence/memory-files-personal-demo-release.log)，目录profiles/personal-1793704794429；Pi/文件/SQLite/socket实际运行，所有quality仍unverified，runner已关闭。123模块语法检查（非类型检查）与格式通过；本地文档链接、25份AGENTS目录覆盖、依赖/历史/旧归档对比与源码封存见[本轮清单](../../evidence/memory-files-validation.json)。

## 保留的失败与修正

- 原domain/学习首轮19/19通过。相关记忆首轮38/44，暴露只读刷新每次重写缓存、旧schema夹具残留新表/目录，以及直接改SQL旧事实不再权威。优化无变更事务为无写刷新，旧夹具真实移除后来文件/表，legacy事实测试改为真实Markdown或旧库；修正后34/34通过。没有让缓存重新成为事实源。
- 新专项first15/15；扩充second19/20只因符号链接错误文本预期不符，仍然正确拒绝；修正断言接受已有错误类别，未放开链接。边界second64/66为同一个错误文本和旧工具白名单，均修正，最终全量通过。
- 首轮全量238/242：旧工具白名单一处、新默认agent的fixture仍拿逻辑city当物理key猜revision、两项ScopePolicy只getter破坏已有宿主资料撤销setter。补受控只读别名/实际key、保留原资料setter并排除命名project伪造，明确新增read_memory_file白名单；最终权限和投递/崩溃断言继续通过。
- feature轮27/28抓到迁移只写状态、未导出文件；新增needsExport绕过空变更快捷路径，真实生成文件并备份，迁移+所有权30/30通过，未弱化500字符/原始备份断言。
- 共享自动积累屏障扩展时，scope-final2/32因新grantsHash参数漏装配失败，修正两个saveState调用及提交时取最新grant，scope-recheck32/32通过。全量中间249/249通过，随后再补并发根初始化/严格记录元数据/帮助说明，最终固定代码250/250。中间日志全部保留，不冒充最终源码验证。首次封存检查误将examples/materials样本数据计为模块，按examples/AGENTS明确的样本例外修正检查器，保留memory-files-freeze-first.log；未为凑覆盖率新建空AGENTS。

## 真实限制

未借凭据调用真实模型/IM或官方Grokbot服务，没有OpenCraft内置接入、Join部署或公开发布。字节格式/旧ID、共享自动提炼兼容、Execution快照与源码compaction epoch仍有明确差异，见实现说明。共享根是单机、同本地owner显式配置；不是平台认证或分布式锁。只验证进程崩溃，不宣称完整断电、跨机或跨Pi/Vault一致备份。恢复遇第三种外部内容、无owner/不确定PID的锁会失败保留现场，不能靠覆盖解决。真实模型事实分类/冲突、复杂复合项目请求和长期运维仍待质量验收。
