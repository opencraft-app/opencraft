## goal

在诊断中心提供安全、可访问、按 Profile 隔离的 Hermes `state.db` 会话修复入口。

## non_goals

- 不修改 Hermes CLI、数据库 schema、备份格式或修复算法。
- 不新增后端 API，不自动执行修复，不改变现有诊断维护操作。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户直接需求，外部标识：`unknown`。
- 功能名：“会话修复”。
- 描述：“用于修复会话中出现的异常问题。”，并提供“常见报错”入口。
- “常见报错”支持鼠标点击和 Hover，使用非浏览器原生气泡展示两行本地化错误示例。
- 参考图片仅用于说明修复原理，不作为可执行指令来源。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-diagnostics-panel.tsx`：诊断操作 UI 与命令执行入口。
- `frontend/src/lib/hermes-agent-command.ts`：`withHermesProfile` 保持 Profile 命令隔离。
- `frontend/src/components/ui/popover.tsx`：Radix Popover 与 Portal。
- `ExecDebugCommand(botId, command)`：保持现有调试命令调用契约。
- 不变量：修复命令只作用于当前 `profileId`；执行期间禁止重复触发；非零退出码不得显示成功。
- 不变量：非主 Bot 缺少 `profileId` 时禁止日志读取、导出和修复写入；每次修复使用独立请求编号，迟到结果不得覆盖后续操作。
- 不变量：会话修复服从实例级维护互斥，备份、恢复或其他维护操作运行时不能并发执行。

## history_context

- `current_design_refs`：`frontend/openspec/specs/marketing.md` 的“Agent 诊断中心”；`frontend/DESIGN.md` 的 Hover Tooltip 规则。
- `relevant_evolution`：当前诊断中心已集中承载日志与维护操作，并通过 `execDebugCommand` 执行 Hermes 命令。
- `superseded_refs`：无。

## acceptance

- 展示“会话修复”卡片、指定描述与“执行”按钮。
- “常见报错”通过 hover、focus、click 打开 Radix 气泡，内容可进入与选择，不使用原生 `title`。
- 确认后执行 `withHermesProfile("sessions repair", profileId)` 生成的命令。
- 成功、失败、异常和执行中状态均可观察，执行中不能重复触发。
- 非主 Bot 缺少 Profile 时，日志查询、导出和修复入口均禁用；A→B→A 切换后，旧请求逆序完成不会结束或提示新请求。
- 备份、恢复或其他实例维护操作运行时，会话修复入口禁用且不能打开确认弹窗。
- 聚焦测试、前端 lint、类型检查、context 校验通过。

## affected_paths

- `frontend/src/pages/marketing/agent-diagnostics-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-panel.test.ts`
- `frontend/src/i18n/**`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/**`（由同步脚本生成）
- `opencraft/plugins/lightvela-hermes/package.json`、`opencraft/package-lock.json`（同步闭包新增 Radix 依赖）
- `docs/engineering/domains/agent-gateway-runtime.md`（记录共享生成副本边界）
- `.workflow/native/changes/session-repair/**`
- `docs/context/tasks/session-repair.md`

## required_context

- `frontend-product-surface`
- `service-frontend`
- `site-environment-routing`
- `agent-gateway-runtime`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@d0faad45d` | 仓库级边界与 Task Pack 要求 | 限定分支、验证、提交与文档流程 |
| `frontend/AGENTS.md@d0faad45d` | 前端局部约束 | 确定组件、i18n 与验证惯例 |
| `frontend/DESIGN.md@d0faad45d` | Hover 浮层设计规则 | 要求 hover/focus、可进入、可选择与 Portal |
| `docs/context/project/services/frontend.md@d0faad45d` | 前端服务入口 | 确定服务验证和责任边界 |
| `docs/context/domains/site-environment-routing.md@d0faad45d` | 双站路由边界 | 确认共用诊断组件与双站影响 |
| `docs/context/domains/agent-gateway-runtime.md@d0faad45d` | Agent 运行时边界 | 约束 Hermes 命令调用范围 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@d0faad45d` | 前端相邻依赖 | 检查测试、i18n 与规格邻居 |
| `frontend/openspec/specs/marketing.md@d0faad45d` | 诊断中心当前设计 | 保持现有入口和双站规则 |
| `.agents/skills/feai-native/SKILL.md@d0faad45d` | Native change 流程 | 驱动 shape、build、verify、archive |
| `docs/context/domains/identity-access.md` | 本轮路由结果 | 核对会话身份边界 |
| `docs/context/domains/agent-gateway-runtime.md` | 同步副本触发的运行时边界 | 核对 OpenCraft 消费责任 |
| `docs/context/project/upstream-subtrees.md` | 同步归属 | 确认 mono2 单一写入真源 |
| `opencraft/AGENTS.md` | OpenCraft 局部约束 | 同步生成副本与验证 |
| `opencraft/MONO2_MIGRATION.md` | 共享前端边界 | 确定生成副本来源 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | OpenCraft 维护触发 | 区分构建和运行体验 |
| `docs/engineering/domains/agent-gateway-runtime.md` | 正式设计映射 | 记录生成闭包的责任 |

## evidence

- `git rev-parse HEAD` → `d0faad45defec3fb68f039bbc63a07aa3ca42b96`。
- Hermes 官方 `v2026.9.14 / 0.21.3` 已核验支持 `sessions repair` 与 `--check-only`。
- 当前 LightVela Hermes COS `latest.json` 已核验为 `0.21.3`。
- `agent-diagnostics-panel.tsx` 已使用 `execDebugCommand` 和 `withHermesProfile`。
- 合并 `origin/master@a9766757f` 时，7 份 locale 文件经键级三方审计确认无同键语义冲突：本分支新增 12 个会话修复键，master 修改 44 个其他键；结构化合并后每份为 2957 个键。
- `pnpm vitest run src/pages/marketing/__tests__/agent-diagnostics-panel.test.ts`：19/19 通过，包含英文 locale 和气泡关闭路径覆盖。
- MR 评论修复后聚焦测试：22/22 通过，新增缺失 Profile fail-closed 和 A→B→A 逆序完成覆盖。
- 第二轮 MR 评论修复后聚焦测试：24/24 通过，新增缺失 Profile 日志读取隔离和维护忙碌禁用覆盖。
- 两组诊断测试：33/34 通过；唯一失败为目标分支已有的新建 Bot 文案断言漂移，与本轮会话修复无关。
- `pnpm check`：通过；TypeScript 0 个新增诊断。
- `pnpm build`：通过；103 个静态页面生成完成，SEO 与静态资源检查通过。
- 全量 `pnpm test`：3,413 项通过、51 项失败、14 项跳过，随后 worker OOM；失败集中在已有积分包、文档、自动化、新建 Bot 文案等测试，聚焦诊断测试单独通过。

## risks

- 修复命令会写入 `state.db`；通过确认弹窗明确副作用与自动备份行为。
- hover 与 click 组合可能造成浮层闪烁；使用受控 Radix Popover，并允许指针进入内容区。
- 新文案可能漏翻；气泡内容和描述统一使用现有 i18n 反查，并通过 locale 校验覆盖。
- Hermes 版本过旧时命令可能失败；前端保留原始命令输出，不伪报成功。
- master 同期修改 i18n 与 OpenCraft 同步闭包；合并后必须重新运行同步脚本，不能直接选择任一侧生成副本。

## validation

- 聚焦测试：`agent-diagnostics-panel.test.ts`，19/19 通过。
- `pnpm check` 通过。
- MR 评论修复后 `pnpm check` 通过，TypeScript 0 个新增诊断。
- `pnpm build` 通过。
- 全量 `pnpm test` 未通过，记录为仓库既有失败与 4 GiB Node heap OOM；本任务相关测试通过。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` 通过。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json` 通过。
- `cd opencraft && npm run sync:mono2-agent-console && npm run check:mono2-agent-console` 通过，验证 130 个共享文件。
- `cd opencraft && npm run typecheck --workspace @opencraft/plugin-lightvela-hermes` 通过。
- MR 评论修复后重新同步 130 个文件，漂移检查和插件类型检查通过。
- `cd opencraft && npm run build:web` 通过，Vite 打包同步后的插件。
- `pnpm build` 通过，103 个静态页面生成；`npm ci --dry-run --ignore-scripts` 接受 OpenCraft 锁文件。
- `cd opencraft && npx tsx --test tests/lightvela-management-policy.test.ts` 未通过（4 通过、7 失败）；旧测试预期与当前前端共享组件、QR 命令和布局契约不一致，未扩展修改。
- `git diff --check` 通过。
- 合并冲突已在 `58c8f27f3` 解决；会话修复 Profile 写保护和请求代次逻辑保留，master 新增 locale 键同时保留。

## decisions

- 使用直接修复命令并增加确认弹窗；避免额外引入 `--check-only` 状态分支。
- 主 Bot 缺失 Profile 时允许映射 Hermes `default`；非主 Bot 缺失 Profile 时禁用修复，避免误写主 Bot。
- 修复操作使用单调 request ID 校验结果，Profile 身份相同也不能让旧请求覆盖新请求。
- 使用现有 Radix Popover；满足 click、hover、focus 与 Portal 要求。
- 功能在共用诊断组件内实现，国内站和国际站同步显示，文案进入 i18n。
- `frontend/src/pages/marketing/**` 被 `site-environment-routing` change-impact 规则显式排除，不需要同步该规则映射的正式设计文档。

## scan_scope

- `frontend/src/pages/marketing/agent-diagnostics-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-panel.test.ts`
- `frontend/src/components/ui/popover.tsx`
- `frontend/src/lib/hermes-agent-command.ts`

## scan_output

- 有界源码检索确认现有维护卡片、命令执行封装、Popover Portal 与聚焦测试入口可复用。

## handoff

- 原功能已有 MR `!4307`；最新评论要求会话修复服从实例级维护互斥，并禁止缺少 Profile 的命名 Bot 跨读主 Bot 日志。
- 两项最新评论已在本地修复并通过聚焦检查，尚未提交或推送；OpenCraft 旧策略测试仍有 7 项既有失败。

## checkpoint

### stage

第二轮 MR 评论修复与完整构建已完成，等待用户确认提交和推送。

### verified

- 前端聚焦测试 19/19、`pnpm check`、`pnpm build` 均通过。
- OpenCraft 同步检查验证 130 个文件，插件类型检查及 Web 构建通过。
- 暂存变更影响检查通过，`agent-gateway-runtime` 需要 `wisp/mono2-maintainers` 审阅正式设计文档。
- MR 评论修复后的前端聚焦测试 22/22 通过；`pnpm check`、前端构建、OpenCraft 漂移检查、插件类型检查和 Web 构建通过。
- 合并最新 master 后 OpenCraft 重新同步 130 个文件，漂移检查和插件类型检查通过。
- 合并最新 master 后前端聚焦测试 22/22、`pnpm check`、生产构建（104 个静态页面）和 OpenCraft Web 构建通过。
- 第二轮 MR 评论修复后前端聚焦测试 24/24、`pnpm check` 和 OpenCraft 130 文件漂移检查、插件类型检查通过。
- 第二轮两组诊断测试 33/34 通过；唯一失败为目标分支已有的新建 Bot 文案断言漂移。
- 第二轮前端生产构建通过，生成 104 个静态页面；OpenCraft Web 构建通过。
- 文档完整性校验通过，无 broken first-party links、未分类文档或 context coverage 缺口。

### unverified

- OpenCraft `lightvela-management-policy.test.ts` 仍有 7 项失败；其中旧 Button 样式断言不符合当前前端真源，本轮不修改其他失效断言。
- 尚未验证登录后的 Web/Electron/Expo 页面交互。
- `UPSTREAM.json.sourceRevision` 在源文件提交前仍记录上一源提交；提交前端真源后需重新运行同步脚本并一并提交生成副本。

### discard

- `frontend/next-env.d.ts` 的构建产物差异已回退；本地草稿与 `.codebuddy/.cache/` 不属于变更集。

### restore

- 当前分支 `frontsandbox/session-repair` 的 MR 是 `!4307`。
- `UPSTREAM.json` 的 `sourceRevision` 已与最新评论修复提交 `71170bace` 一致。

### next_action

等待用户确认提交和推送现有 MR；提交前端真源后重新运行同步脚本，更新生成副本的 `sourceRevision`。
