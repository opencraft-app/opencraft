# DeepSeek Flash 实测记录（2026-11-07）

通过用户提供的 TokenHub 端点，已跑通独立助理原生记忆、摘要和接待链路。模型为 `deepseek-v4.1-flash-1017`，`thinking=disabled`。凭据仅由私有配置注入，不进入模型配置、源码或结果文件。本轮未部署 OpenCraft。

## 官方数据的小样本试跑

使用 [LongMemEval cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) 的 oracle 文件，各选一个类别中历史最短的问题以控制首次调用量。这是有偏的连通与行为试跑，不是随机抽样、完整长上下文测试或官方分数。标准答案和类别未传入助理；下面为人工核对，未运行官方 judge。

| 能力 | 标准答案 | 实际回答 | 人工核对 |
| --- | --- | --- | --- |
| 单会话事实回忆 | 跑鞋品牌 Nike | Nike | 符合 |
| 知识更新 | 与 Alex 见过两次 | 两次，计划中的下一次不计入 | 符合 |
| 时间推理 | 26 天前（含首尾可接受 27） | 今天／0 天 | 不符合 |
| 信息不足时拒答 | 未提父亲送的礼物 | 无父亲礼物信息，已知礼物来自姐姐 | 符合 |

四题均完成，没有把失败样本从分母移除；这里只能说四道短 oracle 题中三道符合，不能解释为 LongMemEval 准确率 75%。数据文件 SHA256：`821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`。

原始记录：[首题摘要](validation/tokenhub-20261107/first-summary.json)、[首题回答](validation/tokenhub-20261107/first-hypotheses.jsonl)、[其余三题摘要](validation/tokenhub-20261107/remaining-summary.json)、[其余三题回答](validation/tokenhub-20261107/remaining-hypotheses.jsonl)。

## 时间题的接入缺口

原始历史保留了 2022-03-09 的消息日期，提问时间为 2022-04-04；评测时钟正确。但接待上下文的近期消息投影仅提供角色和文本，没有消息日期，模型把历史中的相对时间理解成了当前时间。该事件也未被学习成长期事实。

在已停止的同一隔离 profile 上做只读对照：仅为原近期消息补充 canonical 时间戳，不提供答案或类别，不修改历史、不应用模型决定。回答变成了正确的 **26 天前**。这支持日期投影是本题的重要原因；不是完整时间推理修复或泛化证明，原始错误结果仍保留。

[时间投影对照](validation/tokenhub-20261107/time-projection-ablation.json)

## 超出近期窗口的更正回忆

另建合成用例：先记录居住 Kyoto，随后更正为 Sapporo，再插入 24 轮无关算术。共 26 个 session、52 条消息，城市信息已超出原生近期 20 条消息窗口。最终回答 Sapporo，并说明此前是 Kyoto。

该用例证明本次更正可通过原生记忆链路在窗口外被召回；它不是官方长对话质量分数。

[长对话摘要](validation/tokenhub-20261107/long-summary.json)、[回答](validation/tokenhub-20261107/long-hypotheses.jsonl)

## 自然语言记住、更正、遗忘

通过真实 LocalRunner 和 Unix socket 输入，依次要求记住测试城市、更正、遗忘，再询问：

- 记住 Kyoto：原生记忆 revision 1。
- 更正 Sapporo：revision 2，活跃事实已更新。
- 遗忘：revision 3，活跃列表为空，catalog 保留删除墓碑。
- 再询问：助理说明没有保存的城市，但仍从保留的聊天历史复述 Kyoto 和 Sapporo。

因此活跃记忆删除已生效；当前“遗忘”不等于历史擦除，也不能保证不再说出旧值。没有擅自删除历史或改变产品遗忘语义。

初版观测器误用只返回活跃行的 list 来检测墓碑，后来改为 owner 提供的 catalog，并核对持久化墓碑。原始观测和更正说明均保留：[当前报告](validation/tokenhub-20261107/lifecycle-report.json)、[原始观测](validation/tokenhub-20261107/lifecycle-original-observer.json)。

## 接入与验证边界

新增显式 OpenAI-compatible provider，复用原生 Pi 模型传输；配置要求明确端点、模型和私有凭据文件，不继承共享凭据。评测每题独立进程与 profile，保留原生学习验证和失败记录。未配置 TokenHub 价格，因此费用为未知，不将 SDK 占位零价格解释为免费。

provider、评测、诊断及 guardrails 按仓库串行方式验证 **31/31 通过**。此前并行执行时有一条既有计时保护测试超时，失败日志保留；串行复验通过。更早完整回归另有清理顺序失败，已在测试中调整 runner 关闭顺序并单独复验附件测试；没有宣称全部完整回归重新通过。详见 [离线验证记录](VALIDATION.md)、[本轮串行日志](validation/tokenhub-20261107/sequential-tests.log)、[并行失败记录](validation/tokenhub-20261107/initial-parallel-tests.log)。

后续值得优先处理的是：在原 owner 的上下文投影中保留消息时间；明确遗忘针对活跃事实还是也要求阻止历史复述；再用更大、预先固定的样本及官方 judge 评估。以上尚未作为产品修复发布。
