# 入站协议

继承[上层规则](../AGENTS.md)。local-protocol.mjs只验证请求envelope；权限、revision和业务状态在application处理，socket连接归local adapter。

新增op须同步AssistantApplication.dispatch、需要的CLI映射及实际socket测试。输入ID重放/冲突由InputInbox决定，不能在协议层另存接收账本。

不要把本地owner标签当成平台认证，不允许模型通过params声明actor、tools或扩大资源。敏感等待仅接收凭据引用，原值由专用本地适配器处理。

验证：`node --test test/runner.test.mjs test/interventions.test.mjs`；仅涉及envelope时按实际受影响路径选择验证，不另加UI或新传输协议。

0.13新增memory.project.create/join/leave/list、memory.locations与memory.file.read；仍由application校验成员、范围、revision/输入身份。params.agentId仅能选择授权共享只读shard，不能改当前写入身份。

0.14 conversation.context只读显示checkpoint/覆盖游标/错误；conversation.context.retry走InputInbox幂等重置当前父版本的耗尽摘要，不重做工作、不刷新关注。history.read仅是接待只读模型查询，不开放任意跨会话消息读取。

0.15 message.send/get/respond/retry、messages.list、attachments.list接到原owner。send只收message封套，respond只收messageId/revision/value或reject，秘密仍走原专用输入路径。respond复用原Interaction并在同事务追加真实用户选项原文，入站去重沿InputInbox。选择/凭据/手工介入不能混用。

conversation.create/list 为公开生命周期接口；conversationId 是显式寻址而非身份授权。say/history/context/messages/overview 按该 ID 校验，省略时兼容 main。create 仅接受空 params 和稳定请求 ID，不把 /new 当聊天内容；CLI conversation-new/conversations 只映射协议。

`thread.command` 是托管 Bot 的平台命令入口，只收 `argv`；Host 用当前 Bot 凭据路由。
CLI `thread --profile-dir DIR ...` 转同一 socket，不解析或执行 shell。`start` 是独立平台会话，
不替换本地 `conversation.create` 或原 Agent `spawn`。语义与边界见 ../../docs/platform-threads.md。
