# 0015：执行接口与能力验收分治（0.10.0 / schema12）

2026-11-03用户要求「还有啥要搞的 注意 要分治的好」，随后明确「采纳，开搞吧」。提出人身份未确认。本轮落实优先项：收窄执行工具接口、拆分可独立运行的验收场景。只修改独立runner；不涉及Join部署、实际服务认证或公共发布。

## 执行接口

runtime/execution-ports.mjs投影既有服务的方法，自己不拥有业务状态。PiExecutionAdapter接收ExecutionHostPort、toolsFor、recordUsage/report；assistant-tools只接收绑定原work/revision/snapshot的WorkToolPort。工具没有Work、Memory、Skill、Interaction等整个服务对象、repository或凭据接口。

读取资料/发布产物仍由具体I/O adapter执行，动作前继续检查授权、revision与显式记忆epoch，真实回执经Completion owner登记。等待callId、技能固定版本、原生requestId/绑定、Pi checkpoint、Usage采样和原生命周期都没有迁移。接口冻结约束误用，不是第三方代码沙箱。

本轮没有把工作协调器或接待服务全部重构：WorkCoordinator仍协调原用例，ReceptionService仍包含用户命令与后台报告提交；本地Vault.describe仍在同步事务内。相关后续边界在[地图](../module-map.md)保留，不能把两个接口收窄说成全仓完全解耦。

## 验收模块

| 模块        | 实际检查                                                       | 未证明的质量                           |
| ----------- | -------------------------------------------------------------- | -------------------------------------- |
| memory      | 显式保存/纠正/遗忘，自动提炼的学习事件与原用户锚点             | 值的语义准确、跨key遗忘                |
| work        | 问题持久化/重启、取消/修订、原执行恢复、来源笔记、父报告与用量 | 问题是否必要、总结是否可用             |
| automations | 有限安排、明确秒数的自然语言配置、本地事件去重、结果通知       | 日历理解、远程源、语义新颖性与实际已读 |
| skills      | 实际加载已安装固定版本、读取来源依据                           | 自主选择能力和技能是否改善内容         |

context只管理临时runner、公开协议调用、ID前缀和采证；catalog只定义有限模块与选择。personal-scenario负责新建隔离目录、编排、保存逐模块状态/断言/review。支持--scenario单选/逗号多选，默认四项；未知/空/重复选择在建目录前拒绝。失败保留当前failed、后续not_run、未选择not_selected并关闭runner；诊断/关闭错误也保存且非零退出。每项quality保留unverified。

每个场景在全新profile中独立运行验证；同一profile全部运行也实际通过。无人关注长周期、敏感介入等在coverage明确标未跑，没有为了绿灯借用受控时钟或模拟OAuth当成真实验收。

## 验证

- 最终全量 **193/193** 通过，约115.82秒：[全量日志](../../evidence/module-boundaries-tests-full.log)。原183项含真实Pi、等待/取消/修订、进程崩溃和投递恢复均保留。
- 新增分治专项 **10/10** 通过：[专项日志](../../evidence/module-boundaries-new-tests-first.log)。包括Pi依赖守卫、绑定原工作的窄接口、四项CLI分别运行、非法选择提前拒绝、途中失败留证并停止后续，以及无真实模型凭据时未调用服务。
- 接口改造首轮原guardrails/skills/interventions **33/33** 通过：[聚焦日志](../../evidence/module-boundaries-focused-first.log)。没有通过扩大工具权限或放弃恢复断言完成重构。
- 最终四模块组合的fixture演示 **25项断言全部通过**：[演示日志](../../evidence/module-boundaries-demo-final.log)。原材料、历史、事件、usage与逐模块状态保留在新profile/evidence.json，路径及独立副本见[验证清单](../../evidence/module-boundaries-validation.json)。runner已关闭。
- 语法检查、格式、本地链接/目录覆盖、依赖和schema对比、固定源码归档逐文件哈希见验证清单。语法检查不是类型检查；新功能没有新增依赖或数据迁移，schema仍为12。

本轮执行的测试没有出现失败；故障路径测试中的非零退出是预期断言。旧0.9.0与更早归档、实际失败记录不覆盖。本轮独立源码归档为evidence/superapp-module-boundaries-0.10.0-source.tar.gz。

真实模型服务与人工质量复查未运行；缺少显式授权模型连接，没有借用共享凭据。实际业务工具、远程IM/认证、长期数据维护仍按[路线](../roadmap.md)推进。
