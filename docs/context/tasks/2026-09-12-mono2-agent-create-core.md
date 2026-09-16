---
id: mono2-agent-create-core
type: task
scope: Extract stable Bot creation decisions from mono2 Web into the shared LightVela Agent Core.
triggers: ["Bot creation", "clone intent", "Running instance", "additional Bot"]
owner: frontend
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/agent-settings-page.tsx
  - frontend/src/repositories/http-repositories.ts
  - shared/lightvela-agent-core/src/bot-creation.ts
status: retired
reviewed_at: 2026-09-12
review_due: 2026-10-12
revision: 1.0.0
precedence: task
derived: false
---

# mono2 Agent creation core

## goal
让共享业务内核统一决定首台实例、额外 Bot 的 Running 实例选择，以及 blank、clone-current、clone-main 的克隆意图，并让 mono2 Web 成为首个消费者。

## non_goals
- 不改变 CTL/Hermes HTTP endpoint、请求字段、鉴权、权益判断或服务端校验。
- 不把 React、路由、翻译、网络请求或缓存移入共享内核。
- 不接入 OpenCraft 新的创建界面，不提交、不发布。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-12-agent-create-core`：统一首台实例、额外 Bot、Running 实例选择和 clone intent。

## interface_refs / data_structure_refs
- `Repositories.bots.createBot`：保持现有输入和返回接口。
- CTL `POST /api/v1/instances`：没有可复用 Running 实例或站点不支持嵌套 Bot 时创建首台实例。
- Hermes `POST /bots`：国内站存在 Running 实例时创建额外 Bot。
- 不变量：Deleted/Creating/Paused 等非 Running 实例不得承载额外 Bot；服务端继续是最终权威。

## history_context
- `current_design_refs`：`docs/engineering/domains/agent-gateway-runtime.md`、`shared/lightvela-agent-core/README.md`。
- `relevant_evolution`：mono2 Web 现有仓库适配器已经区分创建实例与 Hermes Bot，本轮只提炼决定，不重写传输。
- `superseded_refs`：无。

## acceptance
- 红测先证明共享内核尚未提供创建决策。
- 首次创建输出 `create-instance`，保留 Soul 模板。
- 国内站候选为 Deleted + Running 时选择 Running 实例创建额外 Bot。
- 只有 Creating 等非 Running 候选时仍创建实例。
- 国际站即使存在 Running 候选仍创建实例。
- clone-current、clone-main 解析成明确 source Bot；source 缺失时返回可判定失败。
- mono2 Web 通过共享内核执行决定，现有 HTTP 请求契约测试保持通过。

## affected_paths
- `shared/lightvela-agent-core/`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/repositories/http-repositories.ts`
- `frontend/src/features/agent-management/__tests__/`
- `frontend/src/repositories/__tests__/http-repositories.test.ts`
- `docs/engineering/domains/agent-gateway-runtime.md`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/`

## required_context
- Repository root、frontend、shared core、OpenCraft 边界说明。
- Agent/gateway/runtime Domain 与 frontend runtime adjacency。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库硬边界 | Task Pack、验证与 Git 权限 |
| `frontend/AGENTS.md@working-tree` | Web 消费者边界 | 保持页面、仓库适配器职责 |
| `shared/lightvela-agent-core/AGENTS.md@working-tree` | 共享内核约束 | 禁止 React、网络和 UI 依赖 |
| `opencraft/AGENTS.md@working-tree` | 生成闭包边界 | 只通过同步脚本更新 vendored 文件 |
| `docs/engineering/domains/agent-gateway-runtime.md@working-tree` | 当前设计 | 对齐 identity、lifecycle 与 repository adapter |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 邻接检查 | 保持 runtime contract 与消费者测试 |
| `frontend/src/repositories/__tests__/http-repositories.test.ts@working-tree` | 精确历史行为 | 锁定 Running 选择和请求 body |

## evidence
- RED：共享导出缺失时 `agent-core-create.test.ts` 7/7 失败。
- GREEN：核心/仓库定向测试 76 passed、1 skipped；页面受影响守卫 1 passed；global 区域 67 passed、5 skipped。
- `shared/lightvela-agent-core` strict TypeScript 通过；frontend type baseline 为 174 current、276 baseline、0 new。
- frontend `check` 与生产 `build` 通过。
- OpenCraft `check:mono2-agent-console` 验证 127 文件无漂移；完整 `gate` 通过，包含 boundaries、全部 workspace typecheck/tests、Web、Expo Web 与 iOS bundle。
- 精确 change-impact 检查通过；正式 Agent runtime domain 已同步。
- 仓库 Context unittest 26 项中 4 项失败，均来自任务开始前已存在的历史 Task Pack 元数据、中文优先/体积约束和已有扫描项；本 Task Pack contract 有效。

## risks
- 错选缓存中的首个实例会把 `/bots` 发往 Deleted/Creating 实例；以 lifecycle 归一化和候选顺序测试缓解。
- 共享层扩张为传输层会耦合 Web；通过纯输入输出类型和依赖边界测试缓解。
- 生成闭包漂移；通过官方 sync/check 脚本缓解。

## validation
- 共享内核定向 Vitest 红绿测试。
- frontend 仓库请求契约测试与 Agent 管理定向测试。
- frontend type/check/build 门禁。
- OpenCraft upstream sync/check 与受影响门禁。
- context/change-impact/diff 门禁。

## decisions
- `bot-creation.ts` 只输出创建计划和克隆意图；页面负责提示，仓库负责 HTTP body 与缓存刷新。
- Running 判断复用共享 lifecycle 归一化；不使用实例计数或缓存第一项作为 readiness。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/repositories/http-repositories.ts`
- `frontend/src/repositories/__tests__/http-repositories.test.ts`
- `shared/lightvela-agent-core/src/`

## scan_output
- 有界精确搜索确认 clone intent 位于页面，创建目标选择位于 HTTP repository，现有测试覆盖 Deleted + Running 与创建实例回退。

## handoff
- retired：共享创建决策、mono2 Web 首个消费、OpenCraft 生成闭包同步与门禁均完成；未提交、未发布。
