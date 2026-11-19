# 管家修改与续办契约修复

本轮修复上一轮发现的三个产品缺口：完整替换要求仍继承旧验收条件、同要求续办重新索取已回答日期、定向修改可能组合互相冲突的命令。沿 Work / Interaction / Execution / Reception 原有所有权实现，没有新增数据库迁移、平行工作流或模型重试策略。上一轮失败及自动假通过仍见 [扩展报告](BUTLER-EXTENDED-RESULTS-20261110.md)。

## 实现边界

- 模型 amend 必须提交完整 goal 与 completion（output、requirements、checks）；局部更正显式携带仍有效的条件，完全替换删除旧条件。selected-v2 与 flat-v1 共用结构约束，应用层再验证。底层 typed amend 省略契约的部分更新语义保留，goal.rebase 不丢原条件。
- 同 revision 续办保留普通已答事实，排除过期及 secret / authorization / handoff；新执行通过 confirmedInputs 取得有来源的有界投影。旧执行权限、完成证据和旧快照不迁移。改版、取消仍退役旧交互。
- 定向主模型路由最多一个动作；非定向 batch 在写入之前校验影响范围，拒绝修改要求后再操作旧问题，以及目标与成员的混改等非独立动作。独立批次仍原子提交。宿主失败诊断只保存命令种类、序号、错误类别，不落原始模型提案或答案。
- 首轮复测又暴露两侧上下文缺失，因此后续补齐：主助理复核捕获同一份 confirmedInputs；ExecutionLedger 累积投影同要求版本已提交的补充指令，交给后继执行和报告复核，不重写原提交回执。详见[所有权说明](../docs/coordination-ownership.md)。

## 首轮修复复测：4 passed / 2 failed / 0 timeout

保留 [v3 summary](runs/butler-contract-20261110-v3-extended/summary.json)、[plan](runs/butler-contract-20261110-v3-extended/plan.json)、[来源核验](runs/butler-contract-20261110-v3-extended/source-verification.json)。六题约 412 秒；源码哈希 `b9d058c6509c71e55a23504131ecd0ee5e028b1a8cc18123b623071b8311b9da`，运行中无变化。

通过：等待中替换要求、已完成工作续办、取消目标隔离、批量创建后只改一个工作。替换后的 completion 与产物不再带旧任务标记；定向修改没有出现 superseded 交互拒绝。

两项失败分别保留，不能改算通过：

1. **paused-instructions**：用户日期只询问一次，后继执行已采用日期和两条补充，工作完成。但父助理仅看到空 pendingInteractions、聊天搜索也没有 typed answer 原文，又安排核验；第三执行快照没有前一执行已提交的两条指令。`successor-keeps-instruction-order` 失败，后续断言未运行。产物人工复核含两条补充，仍然有显式上下文缺口。后续补丁针对这个缺口，不更改评测断言。[诊断](runs/butler-contract-20261110-v3-extended/paused-instructions-diagnostic.json)
2. **dependency-rebase**：版本失效、显式 rebase、新结果绑定和旧快照不可变全部通过。最终流程采用新日期 2026-12-19，同时说明“不使用此前被取代的 2026-12-18”。判卷要求全文不得出现旧日期，故 `new-date-in-consumer-artifact` 失败。人工读完整产物判定这是保守字符串判卷的假阴性；本轮没有为变绿放宽断言，也不据此声称自动语义评分完成。[原记录及产物](runs/butler-contract-20261110-v3-extended/dependency-rebase.json)

[诊断聚合](runs/butler-contract-20261110-v3-extended/diagnostic-audit.json)：未观察到 schema 拒绝、报告业务重试或错误 span。该统计不覆盖所有原生内部活动，不能推算完整调用数或成本。

## 最终候选复测

最终候选同一源码、同一次完整运行：**11 passed / 1 failed / 0 timeout / 0 not_run**，基础六题全通过，扩展六题五通过。全部 12 题约 428.3 秒。不是拼接历史成绩。[summary](runs/butler-contract-20261110-v4-all/summary.json)、[plan](runs/butler-contract-20261110-v4-all/plan.json)、[来源核验](runs/butler-contract-20261110-v4-all/source-verification.json)。

| 场景                  | 自动结果 | 耗时    |
| --------------------- | -------- | ------- |
| parallel-wait         | passed   | 51.7 秒 |
| ambiguous-cancel      | passed   | 29.7 秒 |
| goal-dependency       | passed   | 57.2 秒 |
| memory-correction     | passed   | 30.8 秒 |
| replay-recovery       | passed   | 10.8 秒 |
| honest-boundary       | passed   | 6.0 秒  |
| amend-waiting         | passed   | 38.1 秒 |
| paused-instructions   | passed   | 23.1 秒 |
| continue-completed    | passed   | 22.2 秒 |
| cancel-goal-isolation | passed   | 21.4 秒 |
| dependency-rebase     | failed   | 85.9 秒 |
| batch-target-amend    | passed   | 51.6 秒 |

修复目标的三个场景均通过。paused-instructions 本轮只问一次日期，两个执行尝试保留同一原生线程；第二份笔记同时包含日期、雨具和充电器。主助理直接复核交付，没有多余的日期核验续办。23.1 秒是这一题本轮观察，不是统计性能保证。

唯一自动失败仍是 dependency-rebase 的旧日期字符串禁用断言：完整产物标题及实际流程采用新日期，并明确旧日期已过期。版本、输入来源和旧快照断言通过。原分数保持 11/12，有限产物复核另记在 [artifact-review](runs/butler-contract-20261110-v4-all/artifact-review.json)，不能改报自动 12/12；后续判卷需要区分旧日期的使用与作废说明，而不是要求产品隐去更正来源。

[诊断](runs/butler-contract-20261110-v4-all/diagnostic-audit.json)未观察到 schema 拒绝、报告业务重试或错误 span；仍不代表全部原生活动和成本已覆盖。最终源码哈希为 `e778bf1f57abe8a5424b6d82714b04c62b7f5b342fd8c4e9738195a7e50615bd`，运行中没有文件变化。两轮均从 HEAD 52fd801 的 dirty 工作树运行，指纹包含已有四个 stdio 改动；本提交不纳入这些改动。完成后仅修正一处 AGENTS 文档相对路径，执行源码未改变。

## 工程验证

- [最终全量回归](runs/butler-contract-20261110-v4-all/full-tests.log)：407/407，0 skipped，包含真实本地 Pi/Codex 原生进程及受控模型端点测试。
- 新增 11 项契约回归；连同报告恢复专项 [14/14](runs/butler-contract-20261110-v4-all/contract-tests.log)。首轮补丁曾全量 404/404，补齐上下文后重新跑全量。
- [评测器测试](runs/butler-contract-20261110-v4-all/evaluator-tests.log)7/7；169 模块语法检查通过（不是 TypeScript 类型检查）。
- 这些受控测试验证机制，真实模型质量仅以前述独立运行证据为准。

## 控制变量与验证范围

主助理和持久执行均为 Codex 0.162.1 + deepseek-v4.1-flash-1017，provider-default 思考；后台配置 hy4/none，自动记忆学习关闭。沿用 240 秒场景、60 秒模型/整轮规划、120 秒工作、16 步、工作并发 2、题间串行、failure-limit=6。场景输入与 v4.1 评测断言不变，评测器不补答、不纠正重试；产品原有有限重试继续保留。

这是已知合成场景回归，不是盲测、第三方榜单或长期无人值守可靠性证明。modelQualityScore 保持 null；自动通过与有限人工产物复核分开。此次没有上线或重启 OpenCraft，也未纳入工作树已有的 stdio 接口改动。
