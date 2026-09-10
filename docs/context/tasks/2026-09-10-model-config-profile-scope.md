---
id: model-config-profile-scope-task
type: task
scope: 修复多 Bot 模型配置页未按 Hermes Profile 隔离读写的问题。
triggers: ["multi-Bot model config", "模型配置 Profile 隔离", "Bot 切换模型"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-10-model-config-profile-scope.md
status: active
reviewed_at: 2026-09-10
review_due: 2026-09-17
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：模型配置 Profile 隔离

## goal
让模型配置页按当前 Bot 对应的 Hermes Profile 独立读取和保存配置，避免子 Bot 页面读写主 Bot 配置。

## non_goals
- 不改变空白 Bot 创建时由 Hermes 一次性种入模型配置的行为。
- 不改变模型配置 UI、Provider 目录或后端 debug/exec 接口。
- 不合并 MR 或执行部署。

## requirement_ids / requirement_refs / requirement_excerpt
- `LV-MULTIBOT-MODEL-SCOPE`：用户确认修复切换 Bot 后模型配置仍显示主 Bot 数据的问题。

## interface_refs / data_structure_refs
- `TeaSdkInstanceInfo.ProfileId`：当前 Bot 对应的 Hermes Profile ID。
- `AgentModelConfigPanel -> useModelConfig -> createHermesModelConfigClient -> buildHermesModelConfigCommand`：模型配置命令链路。
- 主 Bot 使用 Hermes 根目录；命名 Profile 使用 `${HERMES_HOME}/profiles/<profileId>`。

## history_context
- `current_design_refs`：`frontend/openspec/changes/2026-09-03-configured-model-provider-switch-design.md`。
- `relevant_evolution`：多 Bot 页面已向 Skills、Cron 等能力传递 `profileId`，模型配置链路尚未接入。
- `superseded_refs`：无。

## acceptance
- 设置页明确把当前 `ProfileId` 传给模型配置面板。
- 主 Bot 模型命令继续读写 Hermes 根目录。
- 命名 Profile 模型命令读写 `profiles/<profileId>`，同时继续从根目录启动 Hermes Python。
- 切换 `profileId` 会重新创建 client 并重新加载配置。
- 聚焦测试、前端检查和 diff 检查通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-model-config/`
- `frontend/src/pages/marketing/__tests__/agent-settings-sdk-boundary.test.ts`
- `docs/context/tasks/2026-09-10-model-config-profile-scope.md`

## required_context
- 未命中 Domain Pack；按路由器要求执行有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库边界 | 确认 Task Pack、验证与提交权限 |
| `frontend/AGENTS.md@working-tree` | 前端服务规则 | 确认测试和类型约束 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端服务上下文 | 确认前端验证边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 邻接卡 | 检查相邻实现与测试 |
| `frontend/openspec/changes/2026-09-03-configured-model-provider-switch-design.md@working-tree` | 当前模型配置设计 | 保持既有面板与 debug/exec 链路 |

## evidence
- `validate_context.py --route "frontend multi-Bot model configuration profile scope selected Bot"`：无匹配，要求有界精确搜索。
- 精确搜索确认模型面板只接收 `InstanceId`，命令 helper 固定读取根 `HERMES_HOME`。
- 新增回归断言在实现前按预期失败：设置页未传 `ProfileId`、Profile 切换未重载、命令未设置 Profile 数据根。
- 实现后聚焦回归 10/10 通过，命令作用域测试 1/1 通过。
- 模型配置目录回归 163 passed / 1 skipped / 1 failed；失败项为旧版 Hermes fallback 投影用例，单独重跑仍失败，与本次 Profile 路径无关。
- `pnpm check` 通过；TypeScript 174 current / 276 baseline / 0 new / 102 resolved。
- `git diff --check` 通过。仓库未安装 `eslint` 命令，无法执行独立 ESLint。
- `validate_documentation.py` 通过；context catalog 对本 Task Pack 无告警，但全仓仍被既有无 frontmatter Task Pack 和历史疑似凭据告警阻断。

## risks
- 错误拼接 Profile 路径可能导致配置不可读；复用已有 shell quoting helper，并用命令断言覆盖主/子 Profile。
- 切换 Bot 后复用旧 client 可能显示旧数据；把 `profileId` 纳入 client memo 依赖并补 rerender 测试。

## validation
- 模型配置 client/hook 与设置页边界聚焦 Vitest。
- 模型配置目录回归。
- `pnpm check`。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`（若有 staged 变更）。
- `git diff --check`。

## decisions
- 复用 `getHermesProfileRootCommand`，不新增后端字段或重复路径算法。
- `profileId` 默认 `main`，保留其它调用方和现有测试兼容性。

## scan_scope
- `frontend/src/pages/marketing/agent-model-config/`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/lib/hermes-*-client.ts`

## scan_output
- 模型配置页面缺失 Profile 作用域；Skills/Cron 已有可复用模式。

## handoff
- 已完成实现与聚焦验证；用户已授权与此前 Bot 下拉框样式改动一并追加到 MR !3848，不合并、不部署。
