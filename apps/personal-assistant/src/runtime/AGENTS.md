# 装配、临时调度与关闭

2026-11-07：LocalRunner 按显式 harnesses.assistant 装配 Pi 或 Codex 结构化推理；执行保持每个 Execution 捕获的引擎与原生 checkpoint。assistantHarness 仅拥有临时原生进程，协调器停止并等待后关闭 Harness，再关 UoW/释放锁。fixture 执行不代表 Codex 主助理也是 fixture；doctor 分别报告。协议及范围见[多 Harness](../../../../docs/architecture/personal-assistant.md)。

继承[上层规则](../AGENTS.md)。create-local-domain.mjs组合具体repository/UoW、权限与窄facet；LocalRunner拥有profile锁、socket、timer、临时任务和关闭顺序。

Work/Reception/MemoryLearning Coordinator与DeliveryDispatcher只协调正在运行的请求/句柄；持久业务事实从服务查询。不能在内存Map创建第二份工作状态、等待答案、来源游标或通知账本。后台任务按既有服务状态恢复，不能因为Map丢失重跑未知动作。

关闭先停止入站和新调度，再取消/挂起实际请求，等待句柄结算，最后关闭UoW、释放锁。普通关闭不变成业务取消；不操作其他 profile 或平台服务。故障注入只在明确测试环境选择。

新增模块装配应注入实际所需方法，不把app传给模型；Pi与工具桥接已在0.10.0收窄；WorkCoordinator等仍有原用例协调依赖，不能宣称全runtime已完全隔离。当前按[运行保护目标](../../../../docs/architecture/personal-assistant.md)实施局部deadline、取消和并发，缺口如实记录；不在runtime增加统一金额账本。将来确需跨重启累计的业务限制时，不能依赖内存计数。

后台结果回流见[续接实现](../../../../docs/architecture/personal-assistant.md)：runtime从业务owner取得可处理事件，串行调度同一主助理回合，不能直接把worker文本当成最终用户消息。持久接收/去重/结算归application；临时Map丢失后应可查询恢复，不盲目重跑效果未知的工作。调度要有界并给用户输入机会，失败不能饿死其他阶段；pump现已按阶段隔离并有界退避，phaseErrors显示当前阶段故障；主回合串行，连续3个用户回合后为等待的系统结果保留一次机会。

报告保存后/父提议提交前的进程崩溃验证见`test/continuation.test.mjs`。

验证：`node --test test/runner.test.mjs test/reception.test.mjs test/interventions.test.mjs test/event-notifications.test.mjs`。改跨模块装配/关闭顺序执行`npm test`，保留锁、SIGKILL、绑定缺口和交付恢复证据。

0.9.0已注入profile.runPolicy并装配UsageService。ReceptionCoordinator对整个plan设截止，MemoryLearningCoordinator对提议/复核各自设截止；不响应abort的模型也不能持有槽或让迟到提议提交。保存后的学习提议复用，复核失败不重做提议。worker计步归ExecutionLedger，活跃timer归PiRunGuard，等待/关闭暂停timer。用量写入失败记录healthError，不重试已完成模型调用。验证见test/guardrails.test.mjs；这些限制不是全局金额预算。

execution-ports.mjs只将已有owner投影为Pi实际需要的方法，不拥有业务状态、授权策略或跨owner事务。toolsFor闭包固定work/revision/snapshot，工具不能通过传入另一个workId改绑；没有安装技能、提交工作、取消工作、接受交付或读取凭据能力。Object.freeze防止误改接口，不是权限隔离沙箱；真实工具调用仍须走assertAction。装配修改须保留实际Pi/崩溃回归，见test/module-boundaries.test.mjs。

0.11.0仅在原ExecutionHost/WorkTool投影增加召回读方法，资料范围取固定snapshot。timeZone由显式profile配置传给接待，默认UTC。调度仍调用RoutineService.tick；不得为日历另建持久内存队列，或用当前workspace扩大旧任务的项目记忆范围。

0.12.0由MemoryLearningService拥有持久debounce批次/日期作业，runtime仅调用queueTemporal/pending并协调。提议+复核整次共用默认90秒截止，覆盖此前仅每步2分钟规则的记忆范围；runPolicy更短时取较短值。deadline后/关闭后不得提交迟到提议，finally释放槽；恢复已存提议只重做验证。

0.13装配MemoryFileAuthority为原UoW参与者、SqliteMemoryIndex为可重建索引；memory文件端口按事实/成员owner再收窄。ScopePolicy只接只读当前成员资源provider；execution-ports固定原Delegation资源后提供readMemoryFile。刷新函数只维护缓存与观察屏障，不向query暴露命令。root锁仅覆盖同步观察/文件替换/SQL提交，不跨模型网络请求。

0.14 ReceptionCoordinator在原串行turn处理内先调用ConversationContextCoordinator，一次最多一批、最长min(30秒,modelTimeoutMs)。无额外常驻队列/业务Map；捕获/重试状态归context service。独立截止失败后继续规划，关闭或父signal取消则禁止迟到提交。摘要提交与最终接待提交之间崩溃可复用已存checkpoint；fault点context-proposed-before-commit/context-saved-before-reception有真实进程验证。主线程SQLite仅为独立lab旧适配器，平台接入须通过异步隔离端口。

0.15 MessageDispatcher是独立pump阶段，只持一个临时在途句柄；MessageService查询持久outbox并按会话顺序取首项。单次15秒截止、关闭中止等待，重试保持原ID；超时不把未知接受当失败无副作用。最多5次后failed不饿死后续，CLI显式retry。LocalMessageDelivery只配local:main；未来外部adapter还需目的地身份/权限绑定和幂等/未知效果对账，不是只改channel字符串。旧Result/local-mailbox阶段与用户消息阶段分别记实。

0.16 execution-router 按持久 Execution.harness 懒装配 Pi/Codex，仅持临时 adapter/Promise；配置失配在开始工作前失败，不回退引擎。execution-ports 同时供两者使用。关闭即使某资源报错也须尝试全部收尾并释放 DB/锁。

本地 OTel：LocalRunner 在 profile 锁内装配 telemetry，注入协调器/模型/原生桥；先结束活跃业务和原生进程，再 shutdown 观测、关库和释放锁。不注册全局 provider，不从外部 OTLP 环境变量外发。stage span 的正常返回不是工作成功；导出失败只反映在 status.telemetry，不新增业务重试。见 ../../../../docs/architecture/personal-assistant.md。

2026-11-09：LocalRunner 可单独装配 backgroundCodex，供原 MemoryLearningModel（提议+复核）与 ConversationContextModel；接待/持久执行配置不变。不存在 override 时保持原行为。关闭须在停止所有协调器后回收主/后台两个 Harness，再关观测和数据库，不引入第二份后台作业状态。

0.17：WorkCoordinator 按 WorkService 的 active_execution_id 和 GoalService 就绪投影调度，临时槽绑定 revision+executionId。目标暂停中止原生运行但不结算业务错误；恢复从持久事实处理已保存报告/原线程。Goal 优先级、等待加权及并发限制由应用层给出，不在 runtime 保留第二份计划。

Bot Host 装配可注入 platformChannelPort；bot-authority.mjs 在 UoW 外刷新固定绑定租约，epoch 变化退休当前 runner。进程锁后 claim writer，UoW/工具/交付前 fencing；未知远端效果不重新生成消息 ID。不要把租约或本机 profile 当作原生群权限。见 ../../../../docs/architecture/personal-assistant.md。

托管模型选择：Core personal_assistants 持有 provider/model 引用与 CAS revision；Host 注入既有模型仓库，只通过私有 IPC 解析凭据。LocalRunner 在 profile 锁和 Bot 授权后投影 managedHarnesses，不把 profile.json 当第二个选择真源。已绑定原生执行保留原 provider/model/thread；切模不清理 engines/。验证见 tests/identity/personal-assistant-model.test.ts、test/codex-credentials.test.mjs 与 test/codex-execution.test.mjs。

2026-11-11：接待五秒固定回执退役，状态由应用 status.reception 读取原表；Host Worker/父进程只投影并限制观察有效期，不能靠心跳或 queued 数推断工作完成。未知状态不补造 idle。详情见 ../../../../docs/architecture/personal-assistant.md。

2026-11-12：个人助理托管已从 Worker 改为独立 Node 进程。CLI serve 与打包 assistant-server 共用 assistant-session 和 stdio 协议；Host 仍拥有授权/模型桥与进程回收。见 ../../../../docs/architecture/personal-assistant.md。旧 Worker 入口删除，EOF/停止不删除持久 profile。

平台 Thread 委托：托管 Host 只开放 `threads/command`，不开放 Human 配置写入或任意 shell。
LocalRunner 的 `thread.command` / CLI 与 Work `thread_command` 共用 argv 后端；Work ID 由工具端口绑定，
不可从模型选择。Desktop Daemon/Headless 复用同一平台服务。详见 ../../../../docs/architecture/personal-assistant.md。

2026-11-16：sandbox-environment-provider 仅持临时进程/租约句柄，唯一分配器仍为 createSandboxPool/createSandbox。Bot brain/记忆/模型网关留本机；环境 binding 按启动 incarnation 捕获，不写 profile、不让旧委托获得新环境。私有父子 RPC 不接受模型指定 workId/callId；原工具 port 闭包固定身份。授权变化、暂停、租约丢失停止执行；未知效果不能自动重放，未知创建/销毁保留容量并给安全 correlation 诊断。当前工作区临时、仅 Codex，不能宣称透明断线续跑或跨重启文件持久化。配置、验证与限制见根 docs/architecture/identity/managed-bots.md。
