# 六项持续目标与验收台账

2026-11-10 新增 0.17/schema20 [长期目标与连续执行](coordination-ownership.md)：有界 DAG、优先级、同要求原生会话续接、有序补充、依赖失效与显式重做，保留原业务 owner。它扩展了此前仅只读概览的范围；实际验证见[本轮记录](coordination-validation.md)。仍为独立 lab，未部署 Join。

2026-11-10 增补：[多工作协调](work-coordination.md)提供会话关联工作的全量状态计数、有界注意力列表、可分页检索和捕获版本的定向跟进。复用原账本；不包含用户优先级、依赖调度或通用运行中线程追加消息。机制证据见 `test/work-coordination.test.mjs`；真实模型验收单独留证，不以本表旧测试数字代表当前总数。

用户要求高内聚低耦合实现以下六项，并明确不要过度设计。六项功能基于0.7.0/schema10完成；0.8.0增加[主助理续接](assistant-continuation.md)，0.9.0/schema12补齐[局部运行保护与用量](runtime-guardrails.md)，本表保留六项验收归属。不是Join部署源码，不宣称真实模型质量或外部服务已经验收。

| 能力                   | 实际实现                                                                                                         | 直接验收证据                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 技能按需加载           | 本地内容插件包安装、默认停用/显式启用、摘要目录、Pi工具按需正文、不可变版本和读取回执、旧执行/撤销隔离           | skills.test.mjs 6项，包含真实CLI和Pi工具；[用法](iterations/0007-skills.md)                                                                                                         |
| 自动证据记忆           | 主交互提交时持久捕获原证据、提议、原用户引用检查、独立复核、原子批量写入；显式/遗忘保护、冲突重提议、持久重试    | memory-learning.test.mjs 10项；含生产模型适配器两阶段协议测试、故障回滚、提议重开、自动学习不打断工作；[边界](iterations/0008-evidence-memory.md)                                   |
| 事件触发助理           | 显式规则与匹配、真实文件变化/删除源、本地事件入口、持久基线与发生去重、原范围子委托和真实执行                    | event-notifications.test.mjs内实际文件/CLI、跨重启变化、A→B循环、payload重放冲突、换根/路径隔离；[用法](iterations/0009-events-notifications.md)                                    |
| 有选择地通知           | quiet来源持久化，always/never/changed，完全相同结果抑制、完成结果合并、原始mailbox独立交付、去重与事务恢复       | event-notifications.test.mjs内选择/合并/重开/事务失败/重复接受用例；该文件共9项；[边界](iterations/0009-events-notifications.md)                                                    |
| 无人关注时暂停例行任务 | 持久活动/查看/通知/触发计数，先提醒后暂停；用户返回、暂缓和显式恢复；模型查询不刷新关注                          | attention.test.mjs 4项，推进应用时钟、跨重开、暂停失败回滚；[用法](iterations/0010-attention.md)                                                                                    |
| 不同用户等待           | 普通问答、认证凭据、安全输入、人工操作报告；Pi原生挂起/恢复、分型完成、期限/拒绝/取消/修改隔离、本地加密凭据引用 | interventions.test.mjs 8项，包含Pi三种等待、提交后崩溃与CLI恢复、主接待引导、秘密不入业务库/原生记录；原interaction.test.mjs 12项继续通过；[用法](iterations/0011-interventions.md) |

## 整体验证

最终全量131/131通过，日志evidence/capabilities-tests-final-ports.log；语法检查90模块（不是类型检查），格式通过。额外窄port和schema实查见evidence/capabilities-ports-audit.json；逐项核查与当前源码哈希见evidence/capabilities-validation.json。

实现保留原owner：WorkService变更工作，MemoryService写记忆，InteractionLedger写等待，OutcomeLedger结算Result/Delivery，ConversationHistory写主历史，Pi独占原生执行与工具checkpoint。新增服务按技能、证据学习、事件、通知、关注分职责，跨模块注入所需窄方法；没有引入新依赖、远程工作流引擎或通用插件运行框架。

## 验证范围

真实Pi、本地SQLite/文件/socket、CLI和进程恢复已跑；模型响应来自fixture或受控模型替身。未借用共享凭据、调用真实模型服务、验证语言理解质量或长期运行，也未部署Join。

内容插件不执行任意第三方JS，不包含远程技能市场；事件不包含Slack/飞书远程订阅；changed按文本精确比较，不是语义重要性判断。自动遗忘保护按key，不能证明跨key语义遗忘。授权回执表示用户提供了匹配凭据，不等于远端OAuth/认证成功；人工报告不等于工具验证外部效果。凭据消费的具体服务工具未接入。执行总费用/步骤预算仍属后续路线，不在本次六项目标中。

0.10.0/schema12进一步收窄执行工具接口，并按能力拆分验收场景，见[0015记录](iterations/0015-module-boundaries.md)。四个场景只覆盖各自列出的自动断言；无人关注长周期与敏感介入等仍需单独证据，不能用场景目录数量代替完整质量验收。

0.11.0/schema13补入日历/once/有限条件盯办、个人/项目与profile/log分层、文字召回和历史原文搜索，见[持续助理说明](long-running-assistant.md)。六项旧验收归属保留，新增能力另见本轮记录；真实模型语义质量仍未验证。

0.12.0/schema14进一步对齐Grokbot新版核心整理，见[记忆对照](grok-memory-parity.md)：新增同范围内容墓碑防跨key同文复活，自动增改删/独立复核、证据合并与日期复查；替代上述旧按key保护范围，但不声称跨表述语义遗忘。agent shard/多项目汇聚和Markdown权威尚未复刻，真实模型质量未验收。

0.13/schema15进一步落实文件权威、agent/user/project shard、来源汇聚和显式项目成员授权，实际进入接待/Pi/CLI。SQLite事实表作为可重建索引；文件与SQL经可恢复日志协调。见[文件记忆](memory-files-and-shards.md)，旧条目保留轮次语义，当前新增不代表真实模型/IM已验收。
