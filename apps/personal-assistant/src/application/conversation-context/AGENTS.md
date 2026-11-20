# 主会话长期工作上下文

继承[应用层规则](../AGENTS.md)。ContextService 是主会话派生 checkpoint、覆盖游标、生成尝试和重试状态的唯一 owner。它不写 ConversationHistory、Memory、Work、Interaction、Reception 或 Pi checkpoint。

- `capture/begin/commit/failed` 只在原 UoW 中读写自己的 checkpoint；模型调用由 runtime 在事务外完成。`view/status` 只读。`retry` 仅重置失败生成，不重跑工作。
- 输入由真实 conversation/message 锚点确定，尾部保留20条。旧用户回合/旧系统报告不可使用未来摘要。模型只有序列化的旧摘要和原文分段，不能拿 repository 或任意会话 ID。
- 旧历史每次最多16段/16000 UTF-16字符，单段4000字符；游标支持消息内offset，不能裁掉长消息后假称已覆盖。每次接待最多一批；不足8条且不满字符批次时等待合并。积压用gap明示，不声称全量召回。
- 摘要四组各最多8项，每项400字符、1..4个真实引用，总JSON最多24000 UTF-8字节。模型不能提交游标、source role、权限或业务状态。引用验证只证明出处，语义仍unverified；当前用户更正和实时业务状态优先。
- checkpoint原输入持久保存；成功摘要不覆盖。父版本CAS、原文分段复核和摘要提交同事务。生成失败不前移游标，三次尝试后failed；关闭/崩溃不构成业务取消，context-retry允许显式重试。
- 不删除原文，不写个人事实记忆，不把摘要当完成/用户授权依据。遗忘个人事实不等于删除历史；本模块不声称语义删除或秘密清理。

真实装配：ReceptionCoordinator → ConversationContextCoordinator → 本模块；ContextBuilder只接`view`，ReceptionService将当前工作上下文固定到新委托request。SQLite adapter持有存储，模型adapter只交换JSON。

验证：`node --test test/conversation-context.test.mjs`；迁移/装配变更还跑全量。保留失败、进程崩溃与真实Pi上下文证据。真实模型摘要质量未验收。独立运行时不隐式部署平台服务；既有同步 SQLite 不直接用于平台网络主线程。

多会话通过 forConversation 绑定同一 owner 的不可变 ID 视图；capture/view 使用 turn、begin/commit/failed 使用 job 原会话，归属由 History 窄校验 port 验证。禁止把运行中的摘要重定向到客户端新选择。
