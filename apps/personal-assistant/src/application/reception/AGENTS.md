# 接待的上下文、查询与规划

2026-11-10：[多工作协调](../../../docs/work-coordination.md)在每次用户/报告唤醒注入会话关联工作的全量计数及最多6项未完注意力列表。分页/检索仍有界，不把首屏当全部。say 可捕获 targetWork/revision，提交从持久 turn 重读约束，限定回答/修改/取消同一目标；状态投影不授权静默 rebase。问题可按工作筛选，原等待类型/权限/CAS保留。无新增账本或调度 owner；验证 work-coordination.test.mjs。

继承[应用层规则](../AGENTS.md)。本目录不拥有业务写入；turn接收与结算在上层reception-service.mjs。

- ReceptionContextBuilder：以原消息ID为锚构建有限初始上下文；不能拿最新100条替代旧输入。
- ReceptionQueries：只读投影、会话/资料范围检查、分页/字节界限和host trace。
- ReceptionPlanner：模型与查询回合交换，只返回proposal/trace，不提交命令。

query/planner不得持有整个app、repository、UoW或命令owner，不导入adapter/runtime。读取port只可SELECT；资料只得reference/list/read，授权只得ScopePolicy只读facet。观察不是CAS授权，最终命令仍由ReceptionService重新校验。

所有读取量有界并明确截断/分页。问题投影保留kind和期限，安全输入不能降级成普通answer。模型自带trace不可信，失败也保存host产生的trace。

后台结果续接已按[统一约定](../../../docs/assistant-continuation.md)接入明确的系统事件来源：保留原会话、work/revision、执行和结果引用、quietOrigin以及用户是否等待的依据；不调用现有say入口冒充用户发言。上下文构建器只装入相关且有界的背景，planner只返回继续/交付/静默等有限提议，ReceptionService校验并调用原owner。静默须结算该事件的处理，不能伪造Delivery接受或用户活动。

主模型能否创建routine等能力以真实工具/协议装配为准；后端存在服务、目录有AGENTS或提示词提到工具，都不算能力已接入。当前支持单个有限proposal或最多4项非嵌套用户命令、interval/calendar/once安排创建/暂停/恢复/更新，以及系统结果回合和有限条件结束标记。calendar/时区自然语言质量未验收。

验证包含`test/continuation.test.mjs`的报告/事务/恢复场景。`node --test test/reception-queries.test.mjs test/reception.test.mjs test/responses.test.mjs test/interventions.test.mjs`。局部查询上限不代表已实现全局执行预算。

0.12.0seed增加只读memoryContext（profile/recent）；ContextBuilder先保留当前用户消息，必要时裁剪记忆并标truncated，仍遵守128000字节界限。不得把记忆内容当指令，或借新prompt扩大project授权；不在本模块实现提炼/墓碑写入。

0.13增加私有agent/共享user/最多3个具名project的有来源上下文、alsoMemberOf，以及memory.file.read只读查询。读port前的文件投影刷新在装配adapter，不在query持有写owner；原SQL adapter仍SELECT-only。ContextBuilder裁剪完整嵌套结构并标truncated。新project命令交原MemoryProjectService，不能从模型传入agent身份/根路径/任意grant。

0.14 ContextBuilder通过只读view注入workingContext并为recent messages附稳定id/seq；不自己生成/写摘要。context owner在模型规划之前由runtime协调，失败仍可接待，gap保留。history.read按当前用户/系统historyAnchor限制消息原文和分页；history.search同样限到该锚点，不能让旧输入查到未来消息。requestContext将workingContext固定到新委托，不改历史快照。语义冲突按模型处理，host引用检查不宣称语义正确。

0.15主模型可query attachments.list，再提议send的文字/附件引用；send不可混入batch、不可伪造interaction卡或channel。系统报告可deliver.message，保留原完成条件。查询只接附件list窄facet，结果不执行文件路径导入。问题投影带有限choices，用户标签可由Interaction唯一映射到原value。主助理普通clarify仍为文字，选择卡来自工作Interaction。

2026-11-09：memory.search 新增显式 literal/terms 模式，默认旧短语行为；memory.files.list 只读列出授权索引文档，搜索结果提供文件读取参数及事实内 offset。queryContracts 与组件 reader 共用 domain 定义，目录/命中不授予额外读权限；原分页、计数及字节上限继续有效。

2026-11-09 用户授权召回独立提交与复测：普通用户上下文将原当前输入传入seed；内部只读recall以有界词面重合挑选相关旧事实，不能使用答案选项、题型或gold。模型输入合并profile/recent/recall按key去重；原事实文件、完整prompt API与旧执行快照不改。严格terms搜索空结果只给显式缩词retryHint，不偷偷改变AND语义或代替模型发起不限次搜索。

2026-11-10：报告 seed 增加原 Goal 的有界只读 criteria/revision/分页工作/已接受证据；candidate 仍独立。失败报告规划重新读取持久 host trace 中的查询，遵守当前 grant 和原限额，不缓存旧响应或产生业务写入。每次查询后将 trace 交给 runtime，避免总截止丢失进度。详见[接待协议](../../../docs/reception-protocol.md)，回归 reception-recovery.test.mjs。

2026-11-10：系统报告上下文消费 acceptReport 捕获的 confirmedInputs / directives 宿主投影；不从报告正文猜用户答案，不把 pending 列表为空当作无答案。旧报告缺少投影时标 omitted；字段不授予工具或成为完成证据。投影 owner 见 ../../../docs/coordination-ownership.md。
