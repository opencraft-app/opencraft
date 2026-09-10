---
id: task-main-bot-agent-delete
type: task
scope: 主 Bot 条件式实例删除与新建入口发布约束。
triggers:
  - main bot deletion
owner: pablozhong
authority: primary
source_of_truth:
  - ctl/main/api/server.go
  - frontend/src/pages/marketing/agent-settings-page.tsx
status: active
reviewed_at: 2026-09-10
review_due: 2026-12-10
revision: 1.0.0
precedence: task
derived: false
---

## goal
恢复主 Bot 的删除入口，并确保该动作只在实例内没有其他 Bot 时销毁整个 Agent 实例。

## non_goals
- 不支持更换主 Bot、提升命名 Profile 或删除 Hermes `default` Profile。
- 不改变订阅、配额释放、自动销毁或国际站实例删除流程。
- 不合并 MR 或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户确认：删除主 Bot 等同于删除整个 Agent，但必须先删除同实例内的其他 Bot。
- 用户追加：更新 PRD，新起分支提交 MR，已有 Agent 的新建 Bot 入口继续隐藏。

## interface_refs / data_structure_refs
- `DELETE /v1/instances/{instance_id}`：现有 Agent 实例销毁接口。
- `GET /v1/instances/{instance_id}/bots`：实例内 Bot/Profile 列表真源。
- `Bot.instanceId`、`Bot.isDefault`：前端判断主 Bot 与同实例兄弟 Bot 的依据。

## history_context
- `current_design_refs`：`docs/engineering/domains/agent-gateway-runtime.md`、`docs/context/tasks/2026-09-09-lightvela-multi-bot-profile.md`。
- `relevant_evolution`：多 Bot 改造前，页面垃圾桶调用实例销毁接口；改造后默认 Bot 被整体禁用。
- `superseded_refs`：默认 Bot 永久不提供任何删除入口的前端行为。

## acceptance
- 普通 Bot 继续只删除自身 Profile。
- 主 Bot 仅在同实例没有其他 Bot 时可删除，并调用实例销毁接口。
- 主 Bot 存在其他 Bot 时入口禁用并提示先删除其他 Bot。
- CTL 对页面发起的条件式实例销毁重新检查 Bot 数量，避免陈旧页面状态误删。
- 删除确认弹窗明确区分删除 Bot 与删除整个 Agent。
- 已有 Agent 的新建 Bot 入口隐藏，无实例用户首次创建 Agent 保持可用。

## affected_paths
- `ctl/main/api/server.go`
- `ctl/main/api/server_test.go`
- `ctl/pkg/errcode/instance_bot.go`
- `frontend/src/repositories/http-repositories.ts`
- `frontend/src/repositories/__tests__/http-repositories.test.ts`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/i18n/generated/`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- frontend
- agent-gateway-runtime

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 前端局部规则 | 行为、测试和视觉验证边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端相邻约束 | 检查测试和 i18n 生成物 |
| `docs/context/tasks/2026-09-09-lightvela-multi-bot-profile.md` | 当前多 Bot 设计 | 保持 default/main 映射和无数据库设计 |
| `docs/engineering/domains/agent-gateway-runtime.md` | 运行时正式设计 | 同步主 Bot 删除契约 |
| `docs/context/flows/tapd-gongfeng-delivery.md` | 用户授权新分支与 MR | 提交、推送和远端状态核验 |
| `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md` | 原始 PRD | 同步删除规则、运行时真源和分批开放约束 |

## evidence
- Git 历史确认多 Bot 改造前 `destroyBot` 直接调用 `DELETE /v1/instances/{instance_id}`。
- 当前 Hermes 源码明确拒绝删除 `default` Profile，因此主 Bot 删除必须保持为实例销毁语义。
- CTL API 测试覆盖有其他 Bot 时返回 `INSTANCE_BOTS_REMAIN`，以及只剩主 Bot 时继续销毁实例。
- 前端测试覆盖普通 Bot 的 Profile 删除、主 Bot 的条件式实例删除，以及对应禁用和确认文案。

## risks
- 页面 Bot 列表可能陈旧；CTL 条件式删除在状态切换前重新读取 Profile 列表。
- 实例销毁也会删除主 Bot 的全部会话、配置、技能和记忆；确认弹窗必须明确提示。

## validation
- `cd ctl && CGO_ENABLED=0 go test ./main/api -count=1`：通过。
- `cd ctl && CGO_ENABLED=0 go test ./pkg/errcode -count=1`：通过。
- `cd frontend && pnpm exec vitest run --config vitest.config.ts src/repositories/__tests__/http-repositories.test.ts src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`：通过，88 passed、1 skipped。
- CTL Bot/Profile 定向测试通过；`./pkg/instance` 全量测试因本机缺少 Docker 无法完成。
- `cd frontend && pnpm check`：通过，0 个新增 TypeScript 诊断。
- `cd frontend && pnpm build:cn`：通过，96 个页面生成成功。
- `cd frontend && pnpm i18n:check && pnpm i18n:zh-hant:check && pnpm i18n:validate`：通过，仅保留既有翻译完整度警告。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过。
- Context audit 测试 33 项通过；全仓 Context 测试 26 项中 4 项失败，原因包含历史 Task Pack 元信息缺失和既有凭据扫描候选，本次不扩展整改范围。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file ...`：通过；站点路由映射仅提示、未阻断。
- 浏览器未执行真实 Agent 删除：当前预览账号没有可验证的多 Bot 状态，避免为验证制造或删除真实数据。

## decisions
- 不修改 Hermes default Profile 删除能力；主 Bot 删除映射为 Agent 实例销毁。
- 使用条件式实例删除参数约束页面操作，不影响系统级无条件销毁流程。

## scan_scope
- `frontend/src/{repositories,pages/marketing}`、`ctl/main/api`、`ctl/pkg/errcode`。

## scan_output
- 有界源码与 Git 历史检索完成，无独立产物。

## handoff
- 本地实现完成，分支 `codex/main-bot-delete-hide-create` 基于最新 `origin/master`；正在提交前验证，尚未合并或发布。

## checkpoint
- stage：实现与聚焦验证完成，准备提交 MR。
- verified：创建入口隐藏、删除语义和 60 字符名称限制的测试通过；国内站构建通过。
- unverified：真实实例销毁未执行；Docker 依赖的实例包全量测试待 CI 环境验证。
- discard：此前主 Bot 永久禁止删除的产品约定已被替代。
- restore：PRD 位于 `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`，当前分支包含此前已确认的表单和圆角调整。
- next_action：提交并推送当前分支，创建目标为 master 的 MR，核验远端 SHA 与 CI 状态。
