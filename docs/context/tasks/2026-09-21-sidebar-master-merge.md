---
id: task-sidebar-master-merge-20260921
type: task
scope: 合并 master 并保留侧栏账户命中区域与 Agent 组件样式。
triggers: ["master merge", "sidebar merge", "冲突解决"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/components/site/sidebar-user-menu.tsx
  - frontend/src/pages/marketing/agent-settings-page.tsx
  - opencraft/scripts/sync-mono2-agent-console.mjs
status: active
reviewed_at: 2026-09-22
review_due: 2026-12-22
revision: 1.1.0
precedence: task
derived: false
---

## goal
将 `origin/master` 合入 `frontsandbox/agents-sidebar-account-hit-area`，保留该分支的 Agent/Account/Radix 组件样式与侧栏账号命中区域，并吸收 master 的菜单与近期业务修复。

## non_goals
- 不修改其他 worktree 的 DevCloud 改动；不发布或部署。
- 未经确认不提交、推送或创建 MR。

## requirement_ids / requirement_refs / requirement_excerpt
- 本会话用户指示：组件样式主要以 ours 为主，菜单变化以 master 为主；整体处理冲突以准备 MR。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx`、`account-page.tsx` 及 Agent Console 页面；OpenCraft 的 `sync-mono2-agent-console.mjs` 负责投影。
- 生成目录 `opencraft/plugins/lightvela-hermes/src/upstream/mono2/` 只通过同步脚本写入。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`、`docs/engineering/domains/agent-gateway-runtime.md`、`opencraft/MONO2_MIGRATION.md`。
- relevant_evolution: 本分支原提交为 `eb9f39d95`，合入时 master 基线为 `440379e9c`；按当前 `origin/master` 复算得到 26 个冲突路径。
- superseded_refs: 无。

## acceptance
- 消除全部冲突，保留双方独有的业务行为及本分支 UI；聚焦测试、前端与 OpenCraft 门禁通过。
- `git diff --check`、上下文及 change-impact 门禁通过；记录无法验证项。

## affected_paths
- `frontend/src/pages/marketing/`、`frontend/src/components/site/`、`frontend/src/i18n/generated/`、`opencraft/scripts/`、`opencraft/plugins/lightvela-hermes/`、`opencraft/package-lock.json`。

## required_context
- site-environment-routing、agent-gateway-runtime、frontend、opencraft、upstream-subtrees。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@HEAD`、`frontend/AGENTS.md@HEAD`、`opencraft/AGENTS.md@HEAD` | 仓库与服务规则 | 提交权限、生成边界、验证 |
| `docs/context/domains/site-environment-routing.md@HEAD`、`docs/context/domains/agent-gateway-runtime.md@HEAD` | 路由 must_read | 站点与 Agent 行为 |
| `docs/context/project/services/frontend.md@HEAD`、`docs/context/project/services/opencraft.md@HEAD`、`docs/context/project/upstream-subtrees.md@HEAD` | 路由 must_read | 服务及同步边界 |
| `frontend/openspec/plan.md@HEAD`、`opencraft/MONO2_MIGRATION.md@HEAD`、`docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 近期计划和邻接 | 测试、i18n 生成 |
| `docs/engineering/domains/site-environment-routing.md@HEAD`、`docs/engineering/domains/agent-gateway-runtime.md@HEAD` | 正式设计 | 国际站与共享 Agent Console 约束 |

## evidence
- `git diff --name-only --diff-filter=U` 与 `git ls-files -u` 均为空；26 个冲突路径已逐一处理。
- 合并头为 `origin/master` 的 `440379e9c749dfd193f913045e48cc8e2ccf0009`，当前索引包含双方合并结果。
- `opencraft/npm run check:mono2-agent-console`：162 个 Agent Console 投影文件通过同步检查；本次诊断视图变更已重新同步。
- `frontend/pnpm check`：i18n、文档、MDX 与 TypeScript 检查通过；独立 `pnpm exec tsc --noEmit --pretty false --incremental false` 通过。侧栏聚焦测试 2 个文件、47 项通过。
- OpenCraft 新增 5 个测试已接入 `test:extensions`；新增测试 27/27 通过，完整 `test:extensions` 206/206 通过。
- `npm run sync:mono2-agent-console` / `check:mono2-agent-console`：162 个文件同步并通过检查。

## risks
- 选取整个文件可能丢弃另一侧独有的行为；逐处检查后配套测试。
- 生成副本可能漂移；从 frontend 真源重新同步并检查。

## validation
- `cd frontend && pnpm check`; 聚焦 Vitest；OpenCraft `npm run check:mono2-agent-console` 与 `npm run test:extensions` 通过。全量 `frontend/pnpm test` 仍需在完整依赖环境中重跑并记录 master 基线。
- `cd opencraft && npm run check:mono2-agent-console && npm run gate`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 用户确认：样式、组件结构 ours；菜单与近期业务 master。

## scan_scope
- 上述冲突文件和相邻测试、同步脚本。

## scan_output
- 有界 `git diff --name-only --diff-filter=U`，41 项；未保存大范围扫描。

## handoff
- 合并提交 `022d988b7` 已创建；当前修复改动尚未提交、push、MR。

## checkpoint
### stage
- 合并冲突已解决；sidebar 入口恢复为 controller 分层并保持 click-only，AI 套餐模型入口已接入 controller。
### verified
- 目标 worktree 为独立分支；`MERGE_HEAD` 指向 `440379e9c`；未解决冲突为 0。
- 用户原有未暂存改动仍保留：侧栏账号菜单、账号积分模型；本次生成副本已按真源同步并纳入索引。Task Pack 已纳入本次合并索引。
- 前端检查、TypeScript、聚焦测试、OpenCraft 投影检查已通过；change-impact 需在本次正式设计文档更新后重跑。
### unverified
- 全量 `frontend/pnpm test` 未通过，存在既有/生成内容失败、Vitest worker 超时及 Node OOM；不能以此宣称全量测试通过。
- 未进行真实登录、远端 Host/模型链路、全量 frontend `pnpm test` 或部署验证。
### discard
- 旧扫描结果；以本次索引和源码为准。
### restore
- 目标路径与分支见本文 goal/history；生成层只能同步。
### next_action
- 先暂存并提交当前修复与文档改动；之后按用户授权 push 并更新 target 为 `master` 的 MR。
