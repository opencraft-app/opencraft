# Codex 原生推理与持久委托

继承[适配层规则](../AGENTS.md)。structured-harness 接序列化的接待、提炼、复核、摘要输入，使用临时线程；codex-execution-adapter 使用持久原生线程及受约束宿主工具。没有任意 Host 文件/Shell工具；业务状态仍归原 owner，不代替 ConversationHistory 或 Pi durable 的 checkpoint。

必须显式配置二进制、Responses 端点、模型和私有凭据文件；不得读取共享 CODEX_HOME 或继承模型密钥。支持的二进制版本固定验证，模型目录禁用 Shell/patch，配置禁用其他内建工具。协议/权限配置不能确定时拒绝启动，不回退到宽权限。取消、关闭和协议错误须杀掉并回收子进程，不得提交迟到结果。

显式提供方密钥只进原生认证环境，不能落进原生 shell 快照。2026-11-09 真模型评测归档发现仅禁用 shell_tool 不会禁用快照，因此共同 native-session 同时强制 shell_snapshot=false。真实原生持久线程的合成凭据回归见 test/codex-credentials.test.mjs：保持认证成功，并扫描原生 home 无凭据值。OTel 不记录正文/凭据，持久业务与原生 checkpoint owner 不变。

验证：`node --test test/codex-harness.test.mjs`，真实原生协议测试使用明确配置的 loopback 模型替身，不代表真实模型质量。

结构化推理最多一次协议纠正，向原线程反馈宿主生成的安全字段错误，并说明平铺 schema 不替代命令分支契约；不得通过增加重试、猜 revision/ID、丢弃非空跨分支字段绕过校验。只有 StructuredOutputError 进入该纠正路径，其它故障原样失败。诊断和真实评测见 evaluation/BUTLER-PROTOCOL-DIAGNOSIS-20261110.md。

本轮用户授权持久委托：codex-execution-adapter 使用原生持久目录/线程、固定引擎和原 owner 的边界收据。等待先提交 Interaction 再终止进程，回答后同线程新 turn 续接；不是持久 pending RPC。native-session 是共同进程协议桥，结构化推理仍用临时线程。验证 codex-execution 与 execution-harness，并跑原 Pi 全量。详见 ../../../../../docs/architecture/personal-assistant.md。

2026-11-09：可选 reasoningEffort 经严格枚举校验后传给原生 model_reasoning_effort，真实 loopback 请求验证 reasoning.effort=none。可选 backgroundCodex 是独立完整配置，不能继承环境凭据或在失败时静默回退。模型路由由装配层完成，不在原生 adapter 改写记忆/执行业务。

0.17：后继 Execution 同 session_root 复用原生线程，原生 requestId/最终结果/工具收据仍逐执行独立；查找已有绑定祖先以覆盖后继尚未绑定的失败窗口。工具闭包固定当前执行，旧 final 不得复用成新结果。累计 usage 按 session_root 覆盖，不能逐执行重复相加。真实原生专项覆盖补充顺序、重启续接、暂停恢复。

2026-11-10：默认 reception 使用 selected-v2：同临时线程先选操作，再发所选精确 schema；两阶段共享一次纠正/原截止，无工具、无自动协议降级。flat-v1 仅显式兼容。记忆/摘要及持久委托不变。机制、所有权与验证见[接待协议](../../../../../docs/architecture/personal-assistant.md)和 test/codex-selected.test.mjs。

2026-11-11：selected-v2 路由使用精简能力/证据说明，普通 reply/clarify 不加载完整命令手册，其他操作在参数阶段接收原完整说明；schema/纠正额度/截止/授权不变。两个原生适配器共用 turn-failure，仅保存白名单错误类型、状态及 HTTP 状态，不记录提供方错误正文。见 ../../../../../docs/architecture/personal-assistant.md。

托管模型的 HTTP 429 重试由 ModelSource 请求入口唯一持有；request_max_retries/stream_max_retries 保持 0。NativeSession 只传固定 purpose，结构化适配器不重跑 routing 或已成功参数；safe typed failure 可由当前 Bot/epoch/selection scoped Host 观察补齐。后台学习只延期原 job，不消耗内容失败次数。参见 ../../../../../docs/architecture/personal-assistant.md 和 tests/execution/assistant-model-admission.test.ts。

2026-11-13：goal 的非空白/长度约束在共享 schema 执行，沿用单次协议纠正及同一截止；纠正耗尽携带安全字段诊断到 reception。主/后台读取与报告证据见 ../../../../../docs/architecture/personal-assistant.md。没有扩展 native 内建工具或自动重放业务动作。

2026-11-16：显式隔离环境通过原 Work 工具桥提供 environment_run，不启用 Codex 内建 shell。先校验捕获的环境 binding，再读/写原 native receipt；首次 once 动作可执行，已完成仅返同回执，pending/传输未知必须终止当前 native turn、保留效果未知事实，恢复不能重跑。临时环境/续租归 Host 运行时，身份和账本仍归原 owner。
