# 接口契约

继承[上层规则](../AGENTS.md)。这里描述交换的语义，不装配对象、不实现I/O或保存状态。

contracts.mjs当前为JSDoc，并非完整类型系统，也未枚举全部注入facet。新增接口先确认调用点已有真实需要，再说明输入、回执等级、错误、取消、幂等身份和重启含义；同步/异步边界必须明确。

- ExecutionPort的挂起不等于取消；Pi仍拥有工具checkpoint。
- DeliveryPort的接受是具体渠道事实，不等于用户已读。
- ReceptionReadPort只读，不能暴露数据库句柄或命令接口。
- 本地UoW是同步事务，不能把repository改成Promise便宣称可远程/Temporal运行。

当前[结果续接](../../../../docs/architecture/personal-assistant.md)契约区分执行报告、业务检查、主助理决策和渠道回执；事件身份与work/revision/来源引用可重开校验。静默是一次处理决策，不是Delivery成功；执行恢复状态未知不能映射为成功或自动重试。按实际调用需要定义最小数据，不先建立通用编排框架。

修改契约时同步检查application调用方、adapter实现、runtime装配与相应集成测试；不只更新注释就宣称能力存在。`npm run check`仅做语法检查，不是类型检查。

运行保护和用量交换见contracts.mjs中的RunPolicy与UsageObservation注释。模型提议接口继续只返回数据；用量是host观测副通路，不授予模型业务写入能力。未知计数和目录估算不能转换成账户余额或已扣金额。

ExecutionHostPort和WorkToolPort描述0.10.0实际调用接口：前者只观察/绑定当前执行，后者在装配时固定work与snapshot。I/O仍在adapter，业务写入仍由原owner；同步回执不等于完成。新工具只增加真实需要的方法，不重新开放app/repository/Vault或泛化dispatch。

0.11.0WorkToolPort增加recallMemory/searchHistory，只读且绑定原工作资源/明确关联会话。ReceptionReadPort增加分层召回和history.search；数量/文本界限、stable IDs、文字匹配与未知语义准确必须保留。schema元信息在adapter，port不允许传任意projectId或conversationId选择别的范围。

0.12.0新增内部MemoryLearning facet只投影快照/提交/复查方法，不暴露repository或MemoryService整体；模型仍只收数据。ReceptionReadPort的prompt返回有界profile/recent；MemoryService.prompt按原resources解析唯一当前项目，不允许请求任意其他项目。

0.13事实文件port只提供实际的同步/只读项目/位置/受限read；项目owner另得project/projects两个方法，不能复用完整adapter对象。WorkToolPort新readMemoryFile(params)仍绑定原grant。文件索引刷新是宿主观察，不把SELECT只读应用接口变成业务命令；文件/SQL一致性由本地恢复协议承担，不宣称已能直接替换Temporal远程事务。

0.14增加ConversationContextModelPort.summarize(input,signal)：仅JSON提议，有界旧摘要/原文分段，不授予I/O。ContextView只读facet注入接待，持久状态归context owner；ReceptionReadPort.historyMessage按conversationId+anchorId读取真实原文分页，禁止模型选择会话/锚点。

0.15用户消息出口的实际port为transport.deliver(message,signal)→{messageId,channel,level:"accepted",remoteId}，保留同一消息ID供幂等重投/未知接受对账。附件facet只暴露describe/list，源路径导入仅本地显式CLI/真实笔记I/O适配器。MessageService只得canonical/Interaction/Work只读facet；payload、原文、问题、完成分别有owner，不能直接把lab同步端口当成平台网络线程接口。

0.17：执行身份含 workId/revision/executionId，原要求续接新增尝试、继承原生根。ExecutionHostPort.predecessor 只读返回同根已有绑定的前驱/祖先；不暴露续接创建权。Goal 查询只读、分页；GoalService 的 workPort 只含 create/read/amend/cancel，交付继续归原 Outcome。
