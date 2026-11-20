# Markdown记忆与分片存储

2026-11-07：多 Harness 回归暴露并发首次初始化的快照竞争。MemoryFileStore 构造只准备根/值；MemoryFileAuthority 创建原文件事务参与者后，在其已有根写锁内调用 initialize，finally 释放。身份、projects.json 初始化不能越过正常写入锁，否则会改变另一事务的扫描指纹。没有第二套锁或冲突自动重试；外部真实改动仍需报错。确定性锁持有断言和双进程共享根回归见 memory-files.test.mjs。

继承[适配层](../AGENTS.md)及[根规则](../../../AGENTS.md)。用户本轮明确要求实现agent shard、多项目汇聚和Markdown文件权威；本指南先固定边界，行为进展见[文件记忆设计](../../../../../docs/architecture/personal-assistant.md)。

## 所有权

- MemoryFileStore：唯一文件路径、解析、规范化事实行、来源/遗忘旁车和范围根校验；profile.md与log/YYYY-MM.md为事实权威，不能用SQLite覆盖手改文件。
- MemoryFileTransaction：同步文件事务日志、原子rename、冲突检查、恢复与共享根短锁；SQLite提交标记只判断已提交/未提交，不能充当第二份事实权威。崩溃前后分别向前完成或恢复前像，检测到外部第三种内容时停下报冲突，不覆盖用户修改。
- MemoryFileAuthority：装配文件事务与SQLite可重建投影；保留旧key/revision/来源证据旁车，不把元数据当事实正文。只允许写当前agent自己的三个scope shard，其他agent只读。
- SQLite memory索引由专用adapter维护；领域MemoryService仍负责业务校验、CAS与遗忘，MemoryLearningService仍负责提议/复核/作业。不能从本目录调用模型或控制Work/Delivery。

## 布局与权限

显式memoryRoot按owner绑定。agents/<id>/memory是私有记忆；user-memory/agents/<id>是共享用户记忆；projects/<slug>/memory/agents/<id>是项目共享记忆；agents/<id>/projects.json保存成员资格。固定路径段，拒绝穿越、符号链接、错误格式与越界文件，读取/扫描有界；失败不能当空库后反向清空数据。

新profile默认scope=agent；旧profile缺省仍user，不静默改变归属。共享根需显式配置，同owner才可共享；本地owner标签不是平台认证。新项目通过显式create/join/leave进入记忆授权，不能因此获得资料根或Shell权限。原workspace项目保留material binding语义。

成员资格与项目身份固定为授权资源，leave/rejoin产生新grant，旧turn/Delegation不能自动扩大。prompt最多注入3项目，列出其他已加入项目，保留agentId/name来源与private > project > user优先规则，不把排序当语义冲突判定。

文件写入和SQLite不是一个物理事务。UoW参与者必须先保存文件前后像和SQL提交标记，写入后再提交SQL；任何中断保留可判别日志。事务内禁止异步/网络。读取时刷新文件投影，命令事务内使用同一已锁定视图，回滚不能泄漏事实或回执。

## 验证

test/memory-files.test.mjs覆盖真实手改Markdown、索引重建、迁移/重开、跨agent共享与写隔离、成员撤销/旧grant、三项目预算、文件失败/SQL失败/进程崩溃前后与路径/格式错误。实际CLI与Pi上下文验证不可只测render函数。原记忆/范围/学习/恢复测试继续回归。fixture通过不证明真实模型质量。

0.15强制退出回归补充：已证明ESRCH的旧锁清理可能耗尽250ms等待期限；清理后只立即尝试一次重新获取，避免可用锁误报busy。仍不清理未知/不完整元信息或活跃PID锁，不延长等待期限。定向时间推进复现及真实SIGKILL恢复见user-messages-lock日志。

bot-v1 的私有 shard 扁平在 profile/memory，拒绝 user/project/其他 writer 范围；旧布局保持原路径。恢复日志只可修改允许的记忆事实路径，不能覆盖 profile/引擎/身份。原生群查询不自动授予私有学习许可，见 ../../../../../docs/architecture/personal-assistant.md。
