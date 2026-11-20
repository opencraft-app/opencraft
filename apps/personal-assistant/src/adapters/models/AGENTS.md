# 模型交换与fixture

2026-11-10 协议诊断：解码接受规则保持原样；StructuredOutputError 仅携带阶段、固定错误码和 schema 定义的字段路径。未知模型键必须遮蔽，不保存原输出/解析异常正文。诊断不拥有修复或默认填值权。真实复现和纠正反馈验证见 [管家协议诊断](../../../../../docs/architecture/personal-assistant.md)。

2026-11-07 扩展：[多 Harness](../../../../../docs/architecture/personal-assistant.md)。model-request 可注入结构化推理 transport，原 Pi completeSimple 仍为默认；Codex 原生适配位于 ../codex，仅返回同一批模型提议。structured-output.mjs 只定义线协议 schema、类型校验和 nullable 归一化，不拥有授权/业务验证。记忆提议、独立复核、摘要继续复用原提示词及原 owner。不得为切换模型复制一份业务服务。

当前 Codex 线协议按宿主 input.source.kind 区分用户命令与执行报告续接分支，schema 和解码采用同一输入；应用层仍复核权限、版本和实际接受条件。不能从用户正文猜测 source，不能把 JSON 有效当作规划质量通过。

2026-11-10 接待的原生输出使用有界平铺 nullable record，避免复杂对象 anyOf 的约束生成路径；它只是语法超集。decodeOutput 先校验 wire，再去除 null，最后按原 tagged union 检查命令/查询分支：跨分支非空字段、未知字段、缺少真正必填项仍拒绝。旧严格 wire 兼容读取，记忆/复核/摘要形状不变。不是从用户文字猜命令或放宽业务授权。真实模型发现及前后结果见[多工作协调](../../../../../docs/architecture/personal-assistant.md)对应记录，原生与安全边界测试见 test/codex-harness.test.mjs。

继承[适配层规则](../AGENTS.md)。ModelCatalog管理固定Pi provider/model选择；ReceptionModel产生结构化提议/查询；MemoryLearningModel分提议和独立复核；fixture文件只提供确定性协议分支。

模型只收序列化数据，不得获得app、repository、UoW、凭据值或命令owner。检查JSON形状、错误/aborted和取消；实际写入由application重新校验。内容中的指令不扩大范围，记忆复核不能引用助手输出自证事实。

真实服务只能使用当前明确配置/授权凭据，不读共享凭据补齐。日志只记必要元信息，不输出认证值。fixture通过只证明固定机制，不证明自然语言理解、来源判断、技能选择或长期质量。

0.9.0已按[运行保护说明](../../../../../docs/architecture/personal-assistant.md)接入用量观察和局部请求限制，统一金额预算不作为前置。本层报告实际可取得的usage及未知字段；统计不是账户扣账，不将maxTokens或查询轮次宣传为总费用上限。

主助理有限命令协议及后台结果回合已接入，见[续接约定](../../../../../docs/architecture/personal-assistant.md)。提示词/工具描述定义之后须核对实际装配入口和模型请求；定义存在不代表已注入。当前用户提议支持最多4项非嵌套命令及interval/calendar/once安排和更新，系统回合只支持continue/deliver/silent/blocked；真实模型适配器实际发送对应提示词。新类型须同时接入协议解析、应用校验和真实服务调用。fixture返回continue/deliver/silent只能证明协议，不证明模型会正确判断结果或通知价值。

验证：`node --test test/reception-queries.test.mjs test/memory-learning.test.mjs test/diagnostics.test.mjs`。真实验收用`npm run accept:real -- --directory NEW_DIR --owner LABEL --provider PROVIDER --model MODEL_ID`；执行前确认确有本人授权连接，禁止fixture冒充。

model-request.mjs复用completeSimple，传入timeoutMs/maxRetries，外层deadline覆盖不响应取消的交换。接待、记忆提议/复核分别记录宿主调用ID、耗时与回执usage；解析JSON失败也保留已返回用量。未知字段为null，错误保留provider详情。写入失败不能改成功回复或导致请求重跑；fixture直接协议分支不伪造真实服务调用记录。重试可能由provider内部执行，不把hostCalls当服务计费次数。

0.11.0提示词已实际接入calendar/once/routine.update、有限stopWhen/finishRoutine、scope与profile/log，以及memory.search/history.search。学习project范围来自snapshot.projectId，不可伪造。真实模型的日历推断、结束条件判断、记忆分类/召回效果仍未验收；fixture机制和提示词存在不证明理解正确。

0.12.0真实MemoryLearningModel改为create/update/remove、64项、500字符和sourceEvidenceIds；scope/project仍从宿主快照确定。现代fixture也走该协议。提议/验证两次独立调用，日期任务可引用clock调整已有事实，禁止无证据创建或推断计划已完成；这些语义依赖模型，不能以结构校验冒充质量通过。提议maxTokens=16384、复核1800，整体截止由runtime覆盖。旧key/value只保留应用层兼容恢复。

0.13主模型实际提示词接入project.create/join/leave、具名project记忆、memory.file.read和私有>项目>用户的来源优先规则；提炼默认snapshot.defaultScope，sharedMemories不能修改。Fixture memory.get使用实际返回物理key/revision，不能因新默认agent继续猜city版本0。真实模型的共享分类与冲突判断仍未验收。

0.14 ConversationContextModel只生成goals/constraints/decisions/openItems和sourceIds；不提交游标、权限或命令。production分支经modelRequest记录context-summary用量，maxTokens5000；runtime另限30秒。fixture仅抽取文本用于机制，不模拟正确的语义取舍。ReceptionModel实际提示词消费workingContext、当前更正优先、gap与history.read；真实模型保真度未验证。

0.15 ReceptionModel实际提示词接入SendMessage边界：kind send或系统deliver.message，attachments.list真实ID、replyTo、local:main，以及发送不等于工作完成。fixture仅新增[choice]时ask_user携带固定选项，用真实Pi验证挂起/恢复；不宣称语言理解质量。没有给worker安装可绕开主助理的发送工具。

## 显式兼容端点（独立评测副本）

openai-compatible.mjs 复用 Pi 的 Chat Completions API。端点、模型 ID 和 thinking 设置由本机显式配置；密钥仅通过 OPENCRAFT_EVAL_API_KEY 进程变量提供，不进 profile。HTTPS 或 loopback HTTP，不接受 URL 内凭据/query/hash。客户端上下文/输出上限是本地 cap，不伪称远端规格；单次观察的价格未知为 null。验证见 evaluation/openai-compatible.test.mjs 和 当前模型适配器的回归测试。

2026-11-09：后台模型由 runtime 的 backgroundCatalog/backgroundOptions 注入，MemoryLearningModel 与 ConversationContextModel 继续原协议。不要在通用 modelRequest 内偷偷按模型名切路由、提示词加“不要思考”来冒充提供方开关，或放宽用户证据校验以提升通过率。

2026-11-09：memory-model-contract 统一提炼/复核的“未来有用”口径，profile 与有时效的 log 都可保留。它仅投影模型输入，不拥有快照/CAS/授权/证据；不把兼容 memories、内部版本或不可引用助手 ID 发给模型。共享来源标签和旧提议恢复保留。见 ../../../../../docs/architecture/personal-assistant.md。

0.17：增加 Goal/计划/依赖重做/有序工作补充的有限提议，模型不能直接写 Goal/Work 或提交 owner-attested。系统报告只可在 deliver 内原子携带所属 Goal 的计划扩展或 model-reviewed。新增 nullable 字段兼容缺省的旧分支响应；仍按闭合 tagged union 校验真实必填、未知字段和跨分支权限，不猜命令。

2026-11-10 后续修复：上述平铺 wire 保留为 flat-v1 兼容；Codex 默认改为 selected-v2，两步选择/填参从原 contract 派生分支，把条件必填表达为生成 schema 必填。无自然语言路由或版本填补，具体机制见[接待协议](../../../../../docs/architecture/personal-assistant.md)。短任务的内部执行步骤使用一个 delegate；显式长期或独立依赖交付物才建 Goal。报告优先用有界 goalContext，不能把 candidate 当已接受结果。

2026-11-10：amend 的 output/requirements/checks 在 selected-v2 和 flat-v1 共用 contract 中均必填且非 null；定向路由最多一个动作。完整替换删除旧条件、局部修改显式携带有效条件，语义仍由模型判断，不在 decoder 猜补。批次影响校验归 ReceptionService，不在 adapter 操纵业务状态。
