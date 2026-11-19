# 用户消息与投递

继承[应用层](../AGENTS.md)。MessageService唯一写入用户可见消息的不可变payload、outbox状态与渠道接受回执。ConversationHistory独占原文；Interaction独占问题/选择/安全介入；Work/Outcome独占工作完成与原结果投递。

- 生产方先走原owner校验，再经History的同一UoW保存可见原文及消息引用，调用本模块record。模型只能提议text/attachment，不可伪造interaction、渠道、身份、回执或任意文件路径。
- `resolve`只接附件describe、原消息/原Interaction只读facet。消息ID来自canonical消息身份。相同ID不同body拒绝；正文以本表为准，历史只保存回退文字与messageId。
- pending按会话保持顺序；重试仅重投同一payload，不重新执行或生成。accepted仅表示配置渠道接受，不表示用户已读。旧问题失效时撤回尚未发送的卡，已发卡通过原Interaction状态展示失效。
- 当前只配置local:main；不把用户给的channel字符串当授权。附件只能引用当前profile不可变附件库，发送时复核字节；不读取模型指定路径/URL。
- 选择、拒绝、凭据继续走原Interaction/Vault；本模块不建立第二份等待答案或凭据状态。新worker继续向主助理报告，不安装绕过原交付链的SendMessage工具。

验证：user-messages专项及原接待/问答/结果/通知/进程恢复；模型/真实渠道质量分开。独立runner不部署Join，当前本地同步存储不直接用于Join网络主线程。

最多5次失败转failed并让后续pending继续；message-retry只重置原消息投递，不重新生成。

多会话 resolve/record/read/reply 使用 inConversation 的不可变 ID 视图；pending 中每行使用自己的 conversation_id 检查原文和 Interaction。客户端选择不改变既存 outbox 的目的地。
