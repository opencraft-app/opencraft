# 管家协议与报告恢复修复

本轮解决前一轮暴露的命令分支错误、报告规划重复读取及含糊取消断言混淆。基线和原失败证据保留在[协议诊断](BUTLER-PROTOCOL-DIAGNOSIS-20261110.md)，不覆盖旧结果。

## 改动

1. Codex 接待默认先选操作，再提供该操作的精确 schema。所有操作名及参数来自同一原始契约，宿主不根据用户文字猜命令。回答等操作的 revision 不再是生成 schema 中可留空的泛用槽；查询不能混入其它查询参数。正常两次原生生成，两阶段共享一次纠正，上限三次，无自动降级。
2. 短任务使用一个委托，内部“提问→笔记→报告”不被误拆成长目标。显式依赖交付物仍支持 Goal/DAG。
3. 报告提供原目标的当前准则、版本、分页工作及有界已接受证据，当前 candidate 单独保留。模型先使用这些事实，缺页或截断才查；完成判定和证据提交仍归原 owner。
4. 规划失败保存宿主查询 trace。报告重试按当前 grant 重读旧查询描述，获取新版本而非复用旧响应。恢复读取仍计入六次查询及原字节限制，迟到模型输出不能提交。
5. 整轮规划截止改为 planning-timeout，单次模型交换仍为 model-timeout。场景截止现在计入 timeout，而不是隐藏在 failed 中。
6. 评测版本 v2 把“短任务不应过度拆分”和“含糊取消不应产生修改”分成独立断言；后者比较操作前后的工作/目标状态，允许合法的 queued/waiting_input 混合，不以所有工作必须同状态替代无修改断言。额外状态变更、取消、版本变化和新增工作都被检查。

没有更换模型、增加截止时间、增加业务重试或放宽授权/CAS。数据库 schema、Goal/Work/Execution 所有权不变。详细协议及兼容开关见[接待协议](../docs/reception-protocol.md)。

原用户 flat schema 为 20076 字节；新路由 schema 为 872 字节，answer 参数 schema 为 360 字节，goal.get 为 551 字节，goal.create 为 1748 字节。这是**输出约束**大小，不是整个模型输入的大小；两个阶段会复用同线程上下文，增加一次正常生成往返。

## 复测条件

Codex 0.162.1；主助理及执行均 deepseek-v4.1-flash-1017，原 provider-default 思考；后台 hy4/none；自动记忆学习关闭。使用原显式模型配置，另建隔离 profile；不访问原 profile 数据库，不部署 Join/OpenCraft。

六个相同场景，240秒/场景、60秒/模型交换及整轮规划、120秒/工作、16步、场景内并发2、题间串行。初版三轮分别使用新目录，failure-limit=6，评测器不重试、不向模型喂失败断言。场景提示与操作顺序未改，v2 只独立/修正断言及超时统计。

初版三个计划记录：[第一轮](runs/butler-selected-20261110-v1/plan.json)、[第二轮](runs/butler-selected-20261110-v2/plan.json)、[第三轮](runs/butler-selected-20261110-v3/plan.json)。初版三轮非 Markdown 来源指纹相同：`fa5245863b843e60db94748fc569a50738786880dfc41182d108471ada0b8f3c`。完整指纹第一轮 `755857674c3f7414b02359559f99b597af35ce0e4aad730f5d58e18a0d79fed7`，后二轮 `39baeebe065b8c0acec611713d97d0a3b63397ffef356a02eedbcf82853dcca9`；差别仅三个源码目录 AGENTS.md 的协议说明，运行代码未改。

运行时工作树包含此前未提交的 stdio 入口工作，完整逐文件指纹如实记录；本次提交不纳入那四个文件。结果对应指纹所列工作树，不把 dirty 状态冒充干净旧 HEAD。

## 初版复测暴露的最后一处契约缺口

初版三轮均最终6/6通过，耗时分别201.6、185.2、192.9秒；没有结构化解码拒绝或请求/规划超时。但进一步检查业务事件，第一轮目标题出现两次、第三轮并行题出现一次 `Use either text or message for a final delivery` 拒绝；原有限报告重试后才成功。不能把“最终通过”当成“无业务失败”，也不能只检查 OTel 的模型跨度而漏掉应用层拒绝。

最终补充修复把交付形状提前到选型：deliver 默认只允许纯文本；deliver:message 只允许 typed message；可另选 :goalPlan 或 :goalReview，各自精确 schema 排除互斥的另一字段。仍解码为原 kind=deliver，不变更业务效果、权限和原子性；没有静默丢字段让它过关。专项验证六个合法形状、非报告不可使用、不可批量、所选对象必填和冲突拒绝。

## 机制验证

- 初版完整产品回归 395/395，零 skip。新增9项覆盖真实原生两阶段、跨阶段共享纠正次数、错误分支、取消、socket 默认装配、只读证据/候选隔离、上下文界限、超时 trace、新鲜读取和迟到阻断。
- 评测器测试4/4；离线场景5/5适用项，诚实边界的自然语言题明确 not_run。
- 语法检查168模块，非 TypeScript 类型检查；变更文件格式和 diff 检查通过。
- [全量日志](../evidence/butler-selected-20261110/full-tests.log)、[评测器日志](../evidence/butler-selected-20261110/evaluator-tests.log)、[恢复专项](../evidence/butler-selected-20261110/recovery-tests.log)。早期专项唯一失败是旧测试仍期待 model-timeout，而实际已正确分类为 planning-timeout；更新该期望后全量通过，原日志保留。

## 最终代码的重复验证

补齐交付互斥后，v4 完整6/6通过、约192.9秒，结构化拒绝、业务拒绝和超时均为零。v5 原分数5/6、约172.1秒，同样没有上述运行故障，唯一失败是显式记忆题的中文字符串断言：实际成功保存了 User lives in Shanghai，但断言只识别“上海”。该题后续更正/遗忘当轮未运行，不能补算成通过。

评测协议因此升为 synthetic-butler-v3，仅在这道合成事实题的断言中接受明确中英文等价城市名，并在更正/遗忘时同样检查英文旧事实残留；不修改产品的记忆表示或检索、不把评测别名表送给模型。词面规则不宣称通用语义判分，旧负例和分数均保留。v6 重新运行完整六题，没有从失败步骤续跑或提示模型。

最终产品全量回归 **396/396，零 skip**；最终评测器测试 **5/5**。最终日志：[产品回归](../evidence/butler-selected-20261110/final-full-tests.log)、[评测器](../evidence/butler-selected-20261110/final-evaluator-tests.log)、[交付专项](../evidence/butler-selected-20261110/delivery-tests.log)。

v4/v5 完整来源指纹均为 70caeffd04270b96ceee26907adb3a9dd355bbc750b578d95b84a1f185550bdf；v6 只改变 evaluation/butler-cases.mjs、butler-suite.mjs、butler-suite.test.mjs。最终产品运行代码在这三轮之间保持不变。

## 最终结果

最终 v6 完整 **6/6 通过**，189.5秒；结构化拒绝、业务拒绝、报告失败重试和超时均未观测到。记忆保存、更正、重启、遗忘五项断言全部执行并通过。

| 轮次 | 评测版本            | 原始通过数 | 总秒数 | 结构化拒绝 | 业务拒绝 | 场景超时 |
| ---- | ------------------- | ---------- | ------ | ---------- | -------- | -------- |
| v4   | synthetic-butler-v2 | 6/6        | 192.9  | 0          | 0        | 0        |
| v5   | synthetic-butler-v2 | 5/6        | 172.1  | 0          | 0        | 0        |
| v6   | synthetic-butler-v3 | 6/6        | 189.5  | 0          | 0        | 0        |

[v4 结果](runs/butler-selected-20261110-v4/summary.json) / [诊断](runs/butler-selected-20261110-v4/diagnostic-audit.json)；[v5 结果](runs/butler-selected-20261110-v5/summary.json) / [诊断](runs/butler-selected-20261110-v5/diagnostic-audit.json)；[v6 结果](runs/butler-selected-20261110-v6/summary.json) / [诊断](runs/butler-selected-20261110-v6/diagnostic-audit.json)。v5 的语言误判仍按原始5/6保留，不改分。

v6 完整来源指纹：634c9038667d14e6e5aaeed21a4c8b76e5aa9d8fb63b47138b121b9440ef2f34。最终候选在计划开始后逐文件核验没有变化。性能只是同条件下的单轮观察，不能由这些小样本断言总体时延改善比例。

## 可解释的边界

这些是六个合成场景，部分操作显式指定工具；暂停/恢复等通过 typed API 隔离生命周期机制，重放题测试调用方幂等，不测试重复口语语义。不能据此宣称通用模型能力、记忆提炼质量、外部业务连接或长期无人值守可靠性。

机器结果仍保留 semanticReview=unverified、modelQualityScore=null。对产物和诚实边界的人工式抽查不冒充独立盲评：前两轮日期正确引用实际回答，拒绝虚报订票/付款/邮件；目标记录 achieved/model-reviewed 并引用三项接受结果，不是 owner-attested。

selected-v2 对其它提供方/模型尚未做矩阵验证；错误选型不会被宿主擅自纠正成另一个写命令，仍可能失败。超时保护保持有限，解决的是已知生成契约和重复规划开销，不承诺任何慢提供方都不会超时。
