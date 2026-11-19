# CLI入口

2026-11-10：overview 映射 work.overview 只读投影；say 的 --work/--revision 捕获定向约束，CLI 不猜目标或直接改数据库。真实 CLI + 重启/等待续接验证见 test/work-coordination.test.mjs，设计见 ../docs/work-coordination.md。

2026-11-07：init 支持 --assistant-harness pi|codex 和 --codex-config FILE.json，配置只含凭据文件引用；实际业务及原生进程仍由 runtime/adapter 装配。doctor 明确区分主助理、委托与未验证的端点兼容性。真实 CLI、密钥不进 argv、原生版本和进程回收验证见 test/codex-harness.test.mjs。

继承[根规则](../AGENTS.md)。assistant.mjs只做参数解析、明确的本地适配动作、socket调用和结构化输出；业务判断归application。

新增命令同步help、op/flag映射和实际CLI测试；不能只测直接Service调用。保持shebang首行，未知参数/业务失败如实退出。安全输入只用--secret-file与Vault引用，不把值放入argv、JSON输出或socket payload。

init/doctor不替用户猜模型账号，doctor凭据存在不等于远端可用。新profile与run明确分开；不借当前Join配置或改现网服务。

验证：`node --test test/diagnostics.test.mjs test/skills.test.mjs test/event-notifications.test.mjs test/interventions.test.mjs`；覆盖真实CLI并确认自己启动的runner已停止。

usage提供profile或--work的有界统计，--after-id/--limit分页；不发起模型请求、不更新活动/已读或运行工作。init三个运行保护flag直接映射profile.runPolicy并由领域校验；帮助与实际CLI验证见test/guardrails.test.mjs。

0.11.0支持routine-add --schedule JSON、routine-update --definition JSON、memory-set --scope/--memory-kind、memory-search/history-search --query，以及init --time-zone。只解析并传给原owner；JSON回执保持result封装。实际CLI覆盖见test/continuity.test.mjs，不在CLI实现日历推理或项目授权。

0.13 init可--memory-root ABSOLUTE_DIR/--memory-default-scope agent|user；project-create/join/leave/list、memory-locations、memory-file及memory-set --scope agent|user|project --project SLUG映射原协议。读取只接受profile/月度log，不在CLI做任意文件读写。实际socket/CLI与退出验收见memory-files专项。

0.14 context/context-retry映射conversation.context及conversation.context.retry；输出仍{inputId,result}。不在CLI装配摘要模型或直读SQLite；真实CLI验证在conversation-context专项。

0.15 attachment-import --file是用户明确指定的本地文件读取，写当前profile不可变附件库，不经过模型。message-send --message JSON、messages、message-get/retry --message-id、message-respond --revision --value或--reject、attachments映射本地协议；输出保留result封装。回答凭据请求仍用authorize/provide-secret --secret-file，不把值送message.respond。真实CLI和Pi同submission回归在user-messages专项。

conversation-new/conversations 映射 conversation.create/list；--conversation 为显式寻址，支持 say/conversation/context/messages/history-search/overview/goal-create。客户端保存选择，CLI 不写全局当前会话或清理记忆。实际 CLI 回归在 conversation-lifecycle。
