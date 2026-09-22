## goal
修复 OpenCraft 冷恢复会话因 DSH Agent 尚未激活而把动态工具延迟挂载误判为 `0/N` 注册失败，同时保证首次执行前必须完成精确的 N/N 工具注册。

## non_goals
- 不在恢复历史时提前激活 DSH Agent。
- 不把缺失、部分注册或执行前 deferred 降级为可执行状态。
- 不修改用户会话数据，不重启或替换当前安装应用。
- 不改变共享 AppServer 动态工具 wire schema。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户提供安装版截图：会话恢复显示 `Could not restore this conversation` / `DSH registered 0 of 4 dynamic tools`。

## interface_refs / data_structure_refs
- `runtime/capabilities/register`：Renderer 声明与 Host 会话绑定边界。
- `DshCapabilityRegistrationResult { registered, deferred? }`：Engine 挂载回执。
- `thread/resume`：只读恢复，不激活 Agent。
- `turn/start`：执行准入；提示进入 DSH 前必须精确注册全部能力。

## history_context
- `current_design_refs`：`opencraft/docs/dsh-appserver-boundaries.md`、`opencraft/docs/platform-architecture.md`。
- `relevant_evolution`：JIT history 将显示恢复与 Agent 激活分开；动态工具严格计数随后把合法 deferred 回执当成恢复失败。
- `superseded_refs`：无。

## acceptance
- 冷 `thread/resume` 后的 `runtime/capabilities/register` 可返回 `{registered: 0, deferred: true}`，Workbench 仍完成历史恢复。
- 部分注册（例如 2/4）继续失败。
- `turn/start` 在提交 prompt 前激活 Agent，并严格要求 4/4；deferred 或部分注册均拒绝执行。
- 新 Thread/Fork 的已激活路径继续严格注册。
- DSH/AppServer/Workbench 聚焦测试、类型检查和边界检查通过。

## affected_paths
- `opencraft/apps/local-agent-host/src/dsh-capability-link.ts`
- `opencraft/apps/local-agent-host/src/dsh-appserver-adapter.ts`
- `opencraft/apps/local-agent-host/src/main.ts`
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- 对应测试与正式设计。

## required_context
- mono2 根与 OpenCraft `AGENTS.md`。
- `opencraft-maintenance` Skill 与验证清单。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | OpenCraft 状态所有权和实机证据边界 | 区分显示恢复与执行准入 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | Host/会话验证入口 | 选择 DSH/AppServer 聚焦门禁 |
| `opencraft/apps/local-agent-host/src/dsh-capability-plugin.mjs@working-tree` | Engine 回执真源 | 确认无 Agent 时合法返回 deferred |
| `opencraft/apps/local-agent-host/src/main.ts@working-tree` | Host 注册和 turn 路由 | 放置执行前严格挂载门 |
| `opencraft/packages/workbench-runtime/src/appserver-runtime.ts@working-tree` | Workbench hydrate owner | 允许显示阶段 deferred |
| `/Applications/OpenCraft.app/...@installed` | 当前安装包与进程证据 | 证明插件存在、hash 匹配且 Daemon 参数正确 |

## evidence
- 安装包只读核验：capability plugin、Daemon 与 DSH executable 均存在；安装包插件与源码 SHA-256 一致；运行中 Daemon 参数包含绝对 `--dsh-capability-plugin`，DSH patch 指向同一文件。排除漏打包和旧 Daemon 猜测。
- 代码链路确认：冷 `thread/resume` 使用 `describe` 保持 Agent 未加载；插件此时按设计返回 `{registered: 0, deferred: true}`，旧 Host/Workbench 严格验证误报恢复失败。
- 聚焦测试 23/23、Local Agent Host/Workbench Runtime typecheck、platform boundaries 与 `git diff --check` 通过。
- `npm run smoke:model-capabilities` 使用真实 DSH loader 和隔离合成模型通过：冷恢复取得 deferred 回执，首次 Turn 激活后工具精确挂载并进入模型 schema；无用户数据或付费推理。
- 一键 `npm run package:electron:mac:arm64:preview` 完成 release 构建、原生依赖裁剪、ad-hoc hardened-runtime 签名和 ZIP；App 深度/严格签名与 ZIP 完整性通过，ZIP SHA-256 为 `86c70e5451be71ac5d21c734d9b066556322de17debafe7cb4ae010b9b1acf4d`。
- 打包后的 capability plugin 与本轮源码 hash 一致；独立临时 profile 启动 Preview，CDP readiness 通过后仅关闭该临时进程。未替换 `/Applications`。

## risks
- 过度放宽 deferred 会让模型在无工具时执行：只在 display hydration 接受，`turn/start` 仍严格。
- 重复 resume：DSH engine resume 对已加载 session 幂等，执行前预激活不建立第二 owner。
- 并发 Turn：Thread lifecycle 串行化同一 Thread 请求，执行 authority 继续拥有 admission。

## validation
- `npx tsx --test tests/dsh-capability-broker.test.ts tests/chat-workbench-reconnect-policy.test.ts tests/local-agent-host.test.ts`
- `npm run typecheck --workspace @opencraft/local-agent-host`
- `npm run typecheck --workspace @opencraft/workbench-runtime`
- `npm run check:boundaries`
- 实际 DSH capability plugin smoke（隔离临时目录，不读取用户会话）。

## decisions
- deferred 表示声明已绑定到会话但 Engine 尚未因只读恢复而激活，不等于部分注册。
- 执行准入由 Host 在 `turn/start` 之前完成 Agent activation + exact registration。
- 不通过历史恢复隐式激活 Agent。

## scan_scope
- Local Agent Host capability link/broker/plugin、DSH adapter、Workbench hydration 与对应测试。

## scan_output
- Context Router 无匹配 Pack；完成有界精确搜索。

## handoff
- 源码修复、正式设计、聚焦测试与真实 DSH 隔离 smoke 已完成。
- 新预览产物位于 `opencraft/apps/workbench-electron/release/preview/`；当前 `/Applications/OpenCraft.app` 仍是旧构建，未重启、替换或现场修改。
