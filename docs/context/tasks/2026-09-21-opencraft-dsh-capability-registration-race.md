## goal

消除分发版首次任务启动时同一 DSH session 并发 capability 注册导致的偶发 HTTP 400，并保留安全诊断摘要。

## non_goals

- 不弱化 capability schema 校验、Thread owner、执行 admission 或连接器权限。
- 不把腾讯文档等连接器的完整工具目录注入 DSH。
- 不提交、推送、安装或发布。

## requirement_ids / requirement_refs / requirement_excerpt

- `USER-2026-09-21-DSH-CAPABILITY-400`：分发 App 在其他机器上偶发 `Could not start this task / DSH capability bridge request failed: 400`。

## interface_refs / data_structure_refs

- `DshCapabilityLink`：Host 到 engine plugin 的私有 HTTP bridge。
- `dsh-capability-plugin.mjs /register`：Agent scope 工具与派生 Skill 的唯一挂载事务。
- 不变量：同一 session 的 register/unregister/release mutation 必须串行；相同注册幂等返回。

## history_context

- `current_design_refs`：`opencraft/design/dsh-jit-history.md`、`opencraft/docs/chat-ui-architecture.md`。
- `relevant_evolution`：Workbench 只向 DSH 声明 8 个紧凑 capability；连接器工具目录由搜索/详情/handle 延迟加载。
- `superseded_refs`：裸 `DSH capability bridge request failed: 400` 不足以定位插件拒绝原因。

## acceptance

- 真实 DSH loader 对同一 session 两个并发、相同的完整 Workbench 注册都返回 200。
- 注册工具只出现一份，派生 Skill 只挂载一次，后续调用仍能完成。
- unregister/release 与 register 不并发破坏同一 session。
- 非 2xx 响应保留有界、单行插件错误摘要，不输出 token/request payload。

## affected_paths

- `opencraft/apps/local-agent-host/src/dsh-capability-plugin.mjs`
- `opencraft/apps/local-agent-host/src/dsh-capability-link.ts`
- `opencraft/scripts/smoke-dsh-capability-plugin.ts`
- `opencraft/design/invariants.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- 根与 OpenCraft `AGENTS.md`
- `opencraft-maintenance`、`trace`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | Host/引擎边界与真实验收 | 约束修复和证据 |
| `opencraft/apps/local-agent-host/src/dsh-capability-link.ts@working-tree` | HTTP 错误来源 | 定位裸 400 丢失正文 |
| `opencraft/apps/local-agent-host/src/dsh-capability-plugin.mjs@working-tree` | Engine 注册事务 | 定位 session 并发竞态 |
| `opencraft/apps/workbench-web/src/runtime/workbench-dynamic-tools.ts@working-tree` | 实际声明目录 | 排除完整 Connector schema 注入 |

## evidence

- 修复前真实 DSH loader 并发 smoke：状态 `[200, 400]`，插件错误为 `tool "open_in_vela" is already registered in this scope`。
- 修复后同一真实 loader、同一 session、完整 8 个 Workbench capability 的两个并发注册均返回 200；派生 Skill、模型 schema、真实 capability request/response 与 engine restart 链路继续通过。
- `tests/dsh-capability-broker.test.ts`：6/6，通过有界错误摘要且不回显响应中的请求 payload。
- `npm run test:dsh-bridge`：229/229 通过。
- Local Agent Host typecheck、平台边界、Electron 构建与文档校验：通过。
- 当前 `/Applications/OpenCraft.app` 的 plugin SHA-256 与源码修复前版本一致，DSH 均为 `0.1.1-rc.2`；说明旧分发包必须重新构建，源码修改不会热更新到对方机器。

## risks

- 只吞掉 400 会掩盖真实 schema/权限错误；修复必须串行化所有 session capability mutation，而不是忽略失败。
- 错误摘要不得包含 token、完整 payload 或凭据；只读取插件自身有界 `error` 字符串。

## validation

- `npx tsx scripts/smoke-dsh-capability-plugin.ts`
- `npm run test:dsh-bridge`
- Local Agent Host/Daemon typecheck、Electron build、分发资源哈希与隔离启动。

## decisions

- 串行化边界为 native session ID；不同 session 仍并行。
- 相同并发注册由后到请求在队列中观察首个结果并幂等返回。

## scan_scope

- Workbench dynamic-tool declaration、Host broker/link、engine plugin register/unregister、真实 loader smoke、安装包资源。

## scan_output

- Context Router 未匹配；记录查询 `OpenCraft local DSH capability bridge request failed HTTP 400 when starting task` 后执行有界精确搜索。

## handoff

- 当前状态：实现、真实 DSH 并发复现/验收、聚焦与完整 DSH 回归、类型/边界/构建完成。
- 阻塞项：尚未生成包含修复的新签名 DMG；对方机器仍在运行旧包。
