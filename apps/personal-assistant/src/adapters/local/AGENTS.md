# 本机入口与凭据

2026-11-07：profile 验证可选 harnesses 配置但不重写旧配置，通用缺省 Pi；主助理与委托引擎均须由运行配置显式选择。Codex 配置仅接受显式二进制/Responses端点/modelId/私有凭据文件引用，不接受 apiKey 内容；实际读取与隔离原生进程归 codex adapter。委托支持原生持久线程，禁止默默转移旧 checkpoint。见 ../../../../../docs/architecture/personal-assistant.md。

继承[适配层规则](../AGENTS.md)。profile.mjs管理显式本地配置与目录权限；UnixSocketGateway管理连接/帧/关闭；LocalCredentialVault管理用户提供值的本地加密和引用。

profile中的owner label不是平台认证；持久身份须与领域meta匹配。workspace初始化规范化，旧binding不能自动扩大。控制入口只在明确profile内，socket/配置权限保留，不自动扩为公网服务。

Vault的put/read只留在受信任本地适配器，核心只注入describe；CLI专用--secret-file通路不得把原值放入请求、聊天、事件或Pi记录。引用检查种类、provider、owner绑定与期限；不把本地保存当远端认证成功。不要借共享机器凭据，用户原文件不由CLI擅自删除。

本地加密不抵御已控制本机账号者；备份/导出/清理必须另定密钥与数据契约。未知op/冲突重放的业务决策仍交application，不在socket建立第二个InputInbox。

验证：`node --test test/diagnostics.test.mjs test/interventions.test.mjs test/runner.test.mjs`；仅用合成凭据，错误日志不得回显秘密。

profile.runPolicy由纯RunPolicy校验，缺失时用默认值，load不改写旧配置。init支持--max-steps/--work-timeout-ms/--model-timeout-ms，maxRetries可显式写profile.json中的runPolicy；不得自动修改其他profile。request-deadline.mjs只提供临时AbortSignal与timer，不拥有业务状态；已中止调用不得访问模型，finally清理资源，迟到响应不能重新进入命令提交。专项见test/guardrails.test.mjs。

profile.timeZone显式IANA配置，缺失用UTC；load不改写原文件，不从主机时区或用户标签推测。CLI init可--time-zone；日历结构另经CalendarSchedule校验。修改资料根改变项目记忆binding，不能静默迁移归属或授权旧输入。

profile.memoryPolicy由MemorySynthesisPolicy严格校验，缺省enabled=true/debounce15000/deadline90000/poll3600000/refresh86400000毫秒；load不重写旧文件。不读取远端开关或共享认证。fixture场景显式debounce0，生产缺省不跟随测试加速。

0.13 init默认memoryDefaultScope=agent；load旧配置缺失时保持user，不重写文件。memoryRoot仅接受显式绝对路径，缺省profile/memory-space；同root需同owner，身份标签仍非平台认证。不能从环境或其他profile偷偷发现共享根。

bot-v1 使用 bot-profile.mjs 的可信 Host provisioning；目录不能授予平台身份。profile-layout.mjs 区分 engines 持久根与 executions 临时路径，旧布局必须原址续接。绑定/权限/备份边界见 ../../../../../docs/architecture/personal-assistant.md。

stdio-peer.mjs 提供受信任私有管道的有界 JSON-RPC 帧、超时及关闭；不推导身份、不重放业务请求。CLI serve 与平台托管复用此适配器。验证 test/stdio-server.test.mjs，协议见 ../../../../../docs/architecture/personal-assistant.md。
