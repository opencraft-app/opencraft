---
id: mono2-agent-core-2026-09-12
type: task
scope: 从 mono2 Web 提炼中立 LightVela Agent 业务内核，并让 Web 成为首个消费者。
triggers: ["mono2 Agent core", "Bot identity refactor", "shared Agent management"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - shared/lightvela-agent-core/README.md
  - frontend/docs/README.md
status: retired
reviewed_at: 2026-09-12
review_due: 2026-12-12
revision: 1.0.0
precedence: task
derived: false
---

## goal
建立不依赖 renderer、transport、storage 和产品 UI 的共享 Agent core；首批统一
Bot/Instance/Profile 身份、生命周期归一化和确定性目录投影，mono2 Web 首先消费。

## non_goals
- 不改变创建、删除、计费、鉴权、CTL 或页面视觉行为。
- 不在首批把 OpenCraft 改成新的业务行为消费者，不提交、推送或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- AGENT-CORE-01：用户要求先从 mono2 Web 提炼稳定业务内核，让 Web 成为第一消费者。
- AGENT-CORE-02：共享位置必须能被 OpenCraft 后续作为 package 消费，不能永久放在 frontend 页面目录。
- requirement_refs：当前线程；外部 TAPD/Issue 为 unknown。

## interface_refs / data_structure_refs
- `BotIdentity`：明确 `instanceId`、`botId`、`profileId`、`isDefault`、legacy compatibility；Catalog key 使用三者长度编码组合，跨实例同名 Bot 不合并。
- `BotLifecycle`：唯一后端状态归一化。
- `BotCatalogEntry`：不可变、去重、确定排序并保留源记录。
- package 禁止 React、路由、i18n、浏览器存储、网络和埋点依赖。

## history_context
- current_design_refs：`docs/engineering/domains/agent-gateway-runtime.md` 多 Bot/Profile 规则；`frontend/docs/README.md` Web 边界。
- relevant_evolution：OpenCraft 通过 127 文件生成闭包复用 mono Agent Console；此前审计确认 UI 复用高但身份/Repository 契约不足。
- superseded_refs：页面内状态映射与 HTTP Repository 私有 scope object 仅作兼容入口，不再是新代码真源。

## acceptance
- 新 core strict typecheck；mono Web 新契约测试通过。
- Agent Context 和 CTL Bot Repository 消费共享身份/状态，无行为回归。
- 既有 Context/HTTP Repository 聚焦测试通过，frontend 类型基线 0 new。
- 生成闭包同步且 OpenCraft drift check/typecheck/gate 通过。

## affected_paths
- `shared/lightvela-agent-core/`
- `frontend/src/contexts/agent-context.tsx`
- `frontend/src/repositories/http-repositories.ts`
- `frontend/src/features/agent-management/__tests__/`
- OpenCraft 兼容依赖、生成副本与正式设计文档。

## required_context
- 根与 frontend/OpenCraft `AGENTS.md`、正式 Agent runtime 设计、OpenCraft migration 边界。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | monorepo 与验证边界 | Task Pack、正式设计与门禁 |
| `frontend/AGENTS.md` | Web TypeScript 与验证约束 | 无 any、保留后端权威 |
| `opencraft/AGENTS.md` | 生成闭包与独立 workspace | 同步副本、运行 gate |
| `opencraft/MONO2_MIGRATION.md` | frontend→OpenCraft 过渡边界 | package 是长期目标，生成层非真源 |
| `docs/engineering/domains/agent-gateway-runtime.md` | Bot/Profile 权威规则 | 身份模型不变量 |

## evidence
- RED：共享包不存在，契约测试以 `ERR_MODULE_NOT_FOUND` 失败。
- GREEN：新 core 5 项契约测试、1 项边界测试通过；最终直接相关套件 84 passed / 1 skipped。
- core strict typecheck 与 frontend 类型基线通过（174 current / 276 baseline / 0 new）。
- 生成闭包 127 文件同步与 check、LightVela plugin typecheck 通过。
- Next production build initially failed because Turbopack did not transpile the
  repository-local TS package; a config contract test reproduced it, then
  `transpilePackages` explicitly added `@lightvela/agent-core` and build passed.
- OpenCraft complete gate passed: 921 tests plus Web, Expo Web and iOS bundle.
- frontend `pnpm check` and production `pnpm build` passed.
- frontend full test run exposed unrelated current-worktree docs/i18n/source-assumption
  failures and one long-running worker, so it was interrupted. Directly affected
  suite rerun: 83 passed / 1 skipped; expanded nearby set: 123 passed / 1 skipped,
  with four out-of-scope failures in files unchanged by this slice (memory profile command expectation, two stale
  runtime-config mocks, missing generated i18n key).
- After `pnpm check` regenerated current docs, a second full run with four workers
  reduced visible failures to two unrelated assertions (plan pricing and renewal
  badge source style), then one pre-existing worker remained CPU-bound for more
  than 80 seconds and the run was interrupted. No affected suite failed.

## risks
- 两套独立 lockfile 必须只记录本地 package 必要变化。
- HTTP Repository 位于生成闭包内；首批需保留 OpenCraft package 解析兼容，不能产生第二份业务逻辑。
- legacy instance-shaped Bot 不猜测嵌套身份。

## validation
- core strict typecheck；mono core/Context/HTTP Repository 聚焦测试。
- frontend `pnpm typecheck`、`pnpm check`、`pnpm build`。
- OpenCraft generated drift check、plugin typecheck、完整 `npm run gate`。
- 文档、context、change-impact 与 diff 检查。

## decisions
- package 位于 mono2 中立 `shared/`，mono Web 先消费；OpenCraft 当前只为旧生成闭包解析依赖。
- 第一纵切不引入状态服务或修改 UI，先统一纯身份/状态/目录投影。

## scan_scope
- frontend AgentContext、BotRepository、AgentSettingsPage 与 OpenCraft Agent Console 生成闭包。

## scan_output
- 本轮 `/tmp/opencraft-bot-reuse-audit/` 保存只读评估过程；不作为产品真源。

## handoff
- 第一纵切完成，未提交、推送或发布。下一批为创建决策/用例，需用户后续指示。
