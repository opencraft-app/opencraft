# 第六轮：回应与通知的最小闭环

2026-11-02，提出人未确认。用户要求「好的，搞起来。不太需要过度设计」。仍在独立无界面 runner，不集成或部署 Join。

本轮复用 reception 的 queued/running/settled/blocked 状态和 ConversationHistory，不新增回应任务表、通知引擎或第二份完成账本。

- 接待输入超过5秒还未处理完时，发送一次 acknowledgement；快速回复不额外接话。排队和正在推理的输入都覆盖。恢复后由原 pending 输入继续驱动；接话不修改状态，也不抵消答案。
- running 工作超过30秒发送一次 progress，按工作版本去重。只陈述仍在处理，不估计百分比，不调用模型。重启重新进入 running 时计时从本次启动开始；已发送进度不会重复。
- ExecutionService.blocked 在同一事务中写工作/执行状态和原会话 execution-blocked 通知。旧版本、取消、已完成的执行失败不产生通知。通知不复制原始异常，详细错误仍在工作详情。
- 最终结果继续沿原有 OutcomeLedger → mailbox accepted → ConversationHistory.result；接话、进度不产生 Result/Delivery，也不将工作置为 completed。
- 消息身份按输入ID或工作ID/版本/种类稳定生成，由原历史唯一约束去重，跨重启保留。不会因通知失败重跑已完成模型工作。
- 未关联主会话的直接工作不自动发主会话通知。例行任务不会自动关联主会话；新增进度和执行失败提示也显式忽略 routine 来源，结果仍保留在 mailbox。

所有权：ReceptionService 负责何时接话，ExecutionService 负责进度/执行失败时机，ConversationHistory 唯一写主历史，runtime 只按既有 tick 调用。没有引入新依赖或 schema 迁移，仍为 schema5。

边界：这是本地会话记录和本地文件接受等级，不代表外部IM投递/用户已读。尚无可配置免打扰时段、关注条件、跨事件批量合并，或对例行结果是否值得推送的语义判断。进度只提示一次，不承诺定期心跳。仍未做真实模型服务或长期运行验收。

验证：新增 responses.test.mjs 覆盖接待慢/快/失败、真实runner忙时接话、重开去重、分版本进度、旧失败抑制、routine/未关联工作静默、失败状态与通知事务回滚。原有完成、提问、交付崩溃恢复测试继续运行。
