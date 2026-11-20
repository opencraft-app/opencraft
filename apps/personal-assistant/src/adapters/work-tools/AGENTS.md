# 共用的受约束工作工具

继承[适配层](../AGENTS.md)。此目录只拥有宿主工具描述、JSON Schema 和既有窄 port 的调用，复用实际资料/产物 I/O，不拥有工作、记忆、Interaction 或原生任务状态。

工具定义与 Pi/Codex Harness 解耦；Type 仅用固定依赖的 JSON Schema builder。引擎负责参数校验、调用身份、挂起和原生回执；业务权限和版本仍由 ports.assertAction / 原 owner 校验。suspend(interaction) 是引擎回调：Pi 原生关闭，Codex 持久记录等待后终止本次进程释放槽，不在本目录创建等待用户的 Promise。

除显式环境工具外，工具为可重放读取或具有固定业务身份的本地动作。新增非幂等工具不得沿用安全重放声明，必须先定义未知结果对账与权限边界。机密值不能进入工具输出；专用介入只返回引用/元信息。

验证原 Pi 的 runner/interaction/interventions/skills/completion 和 Codex execution 专项，修改公共定义需运行全量回归。

2026-11-09：recall_memory 的 match=terms 是显式全部词匹配，旧 literal 不变。list_memory_files 只进入新捕获的 Delegation，经原 assertAction 和 captured resources；旧快照不自动获得新工具。返回 document 参数仍由原 read_memory_file 再校验。

2026-11-10：共用执行指令区分 confirmedInputs 普通用户答案与新执行必须取得的工具效果/完成证据。投影和时效归 InteractionService，快照归 ExecutionService；本目录不检索/迁移/重写答案，不能复用敏感介入作为新授权。

2026-11-13：platform_read 仅在新 Delegation 捕获 platform.reads 且 Host port 已装配时暴露。工具固定当前 Work，参数不能指定 owner/权限；读取结果及分页来自平台，证据经 CompletionService 保存，旧快照不扩权。见 ../../../../../docs/architecture/personal-assistant.md。

2026-11-16：environment_run 仅在安装方配置的隔离环境和新 Delegation 捕获 execution.environment 时装配，固定 Work/环境 binding，不能访问 Host Shell 或继承 Host 凭据。它是 replay: once 的非幂等动作；未知效果保留原 native receipt 并停止回合，不能自动换 call ID 重跑。当前仅 Codex 路径支持，Pi/旧本机 profile 不增权。见根 docs/managed-bots.md 和 tests/identity/assistant-environment-roundtrip.test.ts。
