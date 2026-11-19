# 管家契约同配置重复评测

2026-11-10，应用户要求对修复后的管家再跑完整 benchmark。本轮 **12 passed / 0 failed / 0 timeout / 0 not_run**，79 项自动断言通过，各场景耗时合计 **435.9 秒（约 7 分 16 秒）**。这是一次全新真实模型运行，各题独立 profile，没有拼接历史结果或失败重跑。[原始 summary](runs/butler-contract-20261110-v5-repeat/summary.json)、[plan](runs/butler-contract-20261110-v5-repeat/plan.json)。

## 与上一轮比较

执行代码、模型、题目、断言和预算均不变。上一轮自动 11/12，本轮 12/12；唯一变化是日期依赖题的产物措辞：上一轮正确使用新日期，同时说明旧日期作废，触发全文禁旧日期断言；本轮只写新日期。因此加分不能解释为产品能力提高，也不能覆盖上一轮的失败记录。[上一轮完整报告](BUTLER-CONTRACT-RESULTS-20261110.md)。

| 场景                  | 上一轮结果 / 耗时 | 本轮结果 / 耗时  |
| --------------------- | ----------------- | ---------------- |
| parallel-wait         | passed / 51.7 秒  | passed / 46.4 秒 |
| ambiguous-cancel      | passed / 29.7 秒  | passed / 29.1 秒 |
| goal-dependency       | passed / 57.2 秒  | passed / 60.3 秒 |
| memory-correction     | passed / 30.8 秒  | passed / 24.7 秒 |
| replay-recovery       | passed / 10.8 秒  | passed / 13.3 秒 |
| honest-boundary       | passed / 6.0 秒   | passed / 7.1 秒  |
| amend-waiting         | passed / 38.1 秒  | passed / 39.2 秒 |
| paused-instructions   | passed / 23.1 秒  | passed / 28.2 秒 |
| continue-completed    | passed / 22.2 秒  | passed / 22.0 秒 |
| cancel-goal-isolation | passed / 21.4 秒  | passed / 17.3 秒 |
| dependency-rebase     | failed / 85.9 秒  | passed / 93.1 秒 |
| batch-target-amend    | passed / 51.6 秒  | passed / 55.1 秒 |

上一轮合计 428.3 秒，本轮 435.9 秒，约增加 1.8%，属于本次观察，不能据两次样本建立性能保证。连续两轮同执行代码的 24 次场景运行中有 23 次自动通过、1 次保留的日期判卷假阴性、0 超时；只有 **12 种已知场景**，不能算作 24 种独立任务。

## 产物复核与实际能力

逐题读取回复、断言与本地产物，有限复核见 [artifact-review](runs/butler-contract-20261110-v5-repeat/artifact-review.json)。

- 等用户确认时能并行完成另一件事；不确定取消哪件时先澄清，不误取消。
- 指定工作换要求后，新契约和真实笔记一起改变；旧日期问题和旧回答不能污染新版。
- 暂停期间追加两条指令，重启续办后两条都写入新笔记；已交付工作继续补充保留原内容及旧证据。
- 取消一个目标不影响另一个；上游更正后，下游明确绑定新结果，旧快照没有重写。
- 显式记住、更正、忘记和请求重放恢复均通过。没有订票渠道时，实际回复明确未订票、未付款、未发邮件。

本轮未发现自动通过但产物违反上述具体要求的情形。仍有呈现问题：部分回执直接显示工作 ID，日期流程正文带内部依赖 ID、临时路径及哈希；面向用户的交付需要更简洁。此问题没有改成评分失败，也没有为了隐藏它改写产物。

## 稳定性与控制变量

[诊断聚合](runs/butler-contract-20261110-v5-repeat/diagnostic-audit.json)未观察到 schema 拒绝、报告业务拒绝或错误 span。该观测不覆盖全部原生内部请求，不能据此宣称零内部重试、计算完整调用数或费用。

- 主助理与持久执行：Codex 0.162.1 + deepseek-v4.1-flash-1017，provider-default 思考，原 tokenhub 端点；后台配置 hy4/none，自动记忆学习关闭。
- 每题 240 秒、模型/整轮规划 60 秒、工作 120 秒、16 步；工作并发 2、题间串行、failure-limit=6。评测器不重试、不提供失败纠正提示；产品原有限重试保留。
- 从 HEAD `3c9535fa00ca1c87e04295646edba55f85bf8391` 的 dirty 工作树运行，指纹包含已有四个 stdio 接口改动，本轮不修改或提交它们。与上一轮唯一指纹差异是 AGENTS 文档相对路径修正，执行代码一致。[对照记录](runs/butler-contract-20261110-v5-repeat/comparison-plan.json)。
- 源码哈希 `5bca9b2698c7ec27be4083a98da13d85e34483251873f404eaa112ed4ea5a24b`；[运行后来源核验](runs/butler-contract-20261110-v5-repeat/source-verification.json)无文件变化。本轮仅新增证据与报告，没有部署或重启 OpenCraft。

## 能支持什么结论

这轮证据支持：在受限本地工具范围内，管家已能协调多件事、追问、途中改要求、保持续办上下文，并在重启后守住工作身份与依赖关系。它有可重复的管家协调能力。

尚不支持“全面可靠的自主管家”或 SOTA：计划/DAG 由评测器提供，部分暂停、续办、取消和 rebase 使用 typed API；没有检验从含糊目标自主拆计划、跨目标抢占与优先级权衡、跨天无人值守、外部服务异常与真实投递。诚实题直接告知无渠道，自动学习关闭，不能代表全部安全或记忆能力。modelQualityScore 继续为 null，不把自动断言当成通用语义评分。

下一轮应冻结未见过的复合场景，重点测自然语言自主规划、途中插入紧急任务、跨日恢复，以及外部工具超时/部分成功后的真实收尾；这些比继续重复本组短笔记题更能检验管家能力。
