# Pi原生执行与工具桥接

继承[适配层规则](../AGENTS.md)。PiExecutionAdapter负责Harness、原会话/Submission、工具装配与取消/关闭；Pi durable独占原生回合、工具任务和checkpoint。

用稳定execution/requestId重连，不因本地绑定缺口新建第二次输入。业务ExecutionLedger仅保存引用/观察。普通停止挂起原Harness，取消/修改中止旧revision；等待先提交Interaction再关闭Harness释放槽，不建自己的工具任务表。

0.10.0起PiExecutionAdapter和assistant-tools.mjs只接收窄port；skill-tools/intervention-tools继续只收所需函数。app仅出现在runtime装配投影内，不能重新传回adapter或工具。每次实际动作走ScopePolicy与工作版本检查；内容/技能/凭据引用不授予新工具权限。

敏感等待只返回引用/元信息，不能把秘密写进工具结果或checkpoint；owner-provided/owner-reported不是远端成功证明。调用publish_note前保留显式记忆屏障，旧快照保持兼容。

按[续接约定](../../../docs/assistant-continuation.md)，新执行只使用宿主提供的快照；原请求/相关背景已随新执行保存，后续扩充时保留原来源、版本与授权，不隐式读取整段主历史。执行者向宿主报告结果/失败/等待，不接管主助理的通知判断或用户交付。原生回合结束不是Work完成依据；当前默认笔记或显式文本要求均由CompletionContract检查，adapter不能自行跳过。

验证：`node --test test/runner.test.mjs test/interaction.test.mjs test/interventions.test.mjs test/skills.test.mjs test/completion.test.mjs`。涉及checkpoint或绑定必须保留真实Pi进程退出/恢复证据，不能只用业务mock。

## 0.9.0运行保护与观察

run-guard.mjs仅持有本次timer、原生abort句柄和暂停耗时，持久步数通过ExecutionService.modelStep提交。beforeRequest按原生generation taskId计步，beforeTool检查停止状态。固定Pi1.3.0普通钩子抛错会被报告后忽略；超限必须触发原生abort并等TaskRuntime.signal中止，不能只throw。signal在该版本实际TaskRuntime存在，升级Pi时须复查真实请求次数和中止行为。

默认每Execution128步、单次活跃运行10分钟、模型请求2分钟，每层重试最多2次。等待与挂起暂停本次timer；恢复/重开计时重新开始，Execution步数保留，新revision重新计数。停止不会撤销已发布产物或保证任意第三方工具可被强杀。

每2秒采样Harness.usage，关闭后native-usage.mjs以paused Harness读取最终计数，不submit、不恢复执行。UsageService覆盖累计观察，checkpoint和工具用量仍由Pi保存。采样失败交给健康诊断，不重跑执行或伪造0。原生统计可能不含provider未上报字段或重试，目录价格不是账单。专项见test/guardrails.test.mjs，包含真实Pi中止、恰好一次模型产物、挂起后只读采样与用量跨重开。

## 0.10.0接口分治

构造器的executions是ExecutionHostPort，不能创建/取消工作或提交结果；toolsFor返回绑定原work/snapshot的WorkToolPort。recordUsage/report是必要观察回调。assistant-tools不直接访问Work、Memory、Completion、Interaction、Skill服务对象；各调用仍由原owner检查和写入。

资料读取/产物发布继续留在I/O adapter；先assertAction，取得真实回执再登记完成依据与审计。等待的callId、技能版本、显式记忆epoch和native requestId保持原身份。不得为收窄接口把权限检查移除、把回执当成完成，或在port创建第二份状态。实际类型语义见ports/contracts.mjs。验证新增test/module-boundaries.test.mjs，加原Pi/等待/技能/恢复回归。

memory-tools.mjs只装配recall_memory/search_history读能力；WorkToolPort固定旧snapshot的资源，原Delegation若没有新工具则不安装。memory结果按profile/近期选择并标截断，history仅已关联会话。返回原文不能授予指令或写入权，工具不直接拿MemoryService/ConversationRepository。真实Pi调用新工具见test/continuity.test.mjs。

0.12.0新Execution快照增加memoryContext.profile/recent，沿现有JSON输入实际传入Pi；原窄召回/历史工具不扩权。旧快照不补写，不接管记忆提炼或Pi compaction状态。

0.13 read_memory_file实际读取已授权profile/月度log；通过原WorkToolPort绑定原资源，agent私有禁止读取另一agent。只在新Delegation声明能力时安装，不给旧执行扩工具。Pi实际调用/回执和project上下文见memory-files测试，不开放任意Read/Shell。

0.15 ask_user可带1..6个choices及allowCustom，仍调用原Interaction并原生挂起；答案回放仍用原callId/submission。publish_note结果带宿主附件ID，来自真实不可变笔记，不能为工具增加任意文件/渠道访问。新实际CLI选择值恢复同一Pi submission见user-messages专项。

0.16 四类工具改为 work-tools 共用描述和实际动作；本目录包装 defineTool 和 Pi 的挂起/恢复 API。Pi 不接管 Codex 旧执行；activeSessionCount 仅观察当前资源。
