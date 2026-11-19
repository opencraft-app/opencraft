# 第四轮：完成标准与执行依据

日期：2026-11-02。提出人身份未确认。用户确认继续开发顺序：「先补工作完成标准、接待查询能力、回应与通知策略、执行预算，再推进技能和证据记忆。」本轮先完成第一项的本地可核验切片，其他项见 [roadmap.md](../roadmap.md)，不声明全部完成。

仍在独立runner目录，不集成/部署Join，不调用真实模型或共享凭据。

## 对象与写入归属

- `CompletionContract` 是纯领域规则，记录目标、语义要求、程序检查和交付等级。WorkService经WorkItem拥有当前contract；修改目标产生新revision，不跨版本复用依据。
- `CompletionLedger` 独占执行依据和评估记录写入；`CompletionService` 收集可信I/O适配链路的回执并执行检查，不调用模型或直接文件I/O。
- ExecutionLedger继续独占业务执行绑定和不可变快照；Pi仍独占原生执行/工具checkpoint。新增依据是业务完成事实，不是第二套工具任务账本。
- OutcomeService协调同一事务中的评估、Result/Delivery、工作状态、事件与主历史；最终交付仍经现有OutcomeLedger和真实本地mailbox接受。

## 实际行为

新工作默认必须发布一份非空不可变笔记；可以显式加`material_read`（相对路径、可选SHA256）和`note_contains`（原文字面包含）检查。用户/模型不能用checks空列表或origin=legacy关闭默认笔记要求，也不能另设当前不支持的交付渠道。

Pi工具在真实读取/发布成功后经CompletionService保存依据，绑定executionId。笔记回执包含实际内容SHA256和字面条件匹配；不允许从最终模型回复补填依据。对外协议没有提交依据或“标记完成”命令。

模型结束后，OutcomeService保存不可变评估。检查失败则保存失败详情、进入blocked、向关联主会话追加失败说明，不产生成功Result/Delivery。通过检查后先进入awaiting_delivery，原信箱接受后才completed。语义要求始终明确为semanticReview=unverified，字面包含与内容正确不是同一个结论。

amend省略completion时保留原条件并更新目标；显式提供时替换附加条件，默认笔记条件继续保留。历史评估与执行快照保留原目标/条件。证据重放核对相同身份与内容，不重复登记。

schema3→4新增work.completion_json、completion_evidence和completion_assessment。旧工作保持legacy原条件，不回填虚假依据或改变已保存执行快照；旧工作明确修订后使用当前标准。schema1/2仍顺序迁移。

## 验证与剩余范围

新增12项检查覆盖：默认条件不能关闭、模型空声明无产物不能完成、字面检查读取真实产物而非最终回复、源哈希/执行归属、版本修订不复用旧依据、回执不可变与幂等、对外协议不能伪造依据、旧数据迁移、真实Pi读取/发布及失败阻塞、修改后恢复、结果提交崩溃窗口后只重试交付，以及模型提议字段校验。

首次领域回归17/18通过，一处旧测试期望schema3而当前已是4；保留evidence/phase4-domain-initial.log，修正后聚焦30/30通过。完整回归及演示结果见根VALIDATION.md第四轮。

本轮没有通用语义评审、独立接待查询工具、回应/通知策略、预算、技能、自动证据记忆或真实模型效果验收。I/O依据表示当时确已读取/发布，并不承诺操作者之后删除或修改文件也能持续可读；这是本地单owner数据目录，未实现对抗文件篡改的全程证明。
