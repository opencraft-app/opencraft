---
id: task-checkpoint-lightvela-multi-bot-profile-2026-09-11
type: task
scope: 多 Bot 套餐数量权益实现的续接状态与验证证据。
triggers: ["multi bot checkpoint", "Bot quota verification", "quota resume"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-09-lightvela-multi-bot-profile.md
status: active
reviewed_at: 2026-09-11
review_due: 2026-12-10
revision: 1.0.0
precedence: task
derived: false
---

## stage
FE-AI Native `multi-bot-plan-quota` verify 阶段；业务实现、PRD 和本次范围门禁已完成，下一道门禁是写入验证报告并等待用户决定是否归档。

## verified
- CTL 新增独立 `bot_quota_per_agent` Bundle/Pass contract，migration 对 Launch/Launch AI 写 5、Cruise/Cruise AI 写 10，缺失配置保守按 1。
- CTL 创建路径从有效 Pass 读取权益，并用目标 Agent `$HERMES_HOME/.lightvela/profile-create.lock` 串行 Profile 计数与创建。
- 新增 CTL 聚焦测试已通过：quota 校验、Pass/Bundle 响应、运行时锁并发创建和错误码映射。
- PRD 已从 `origin/master` 取回后更新，保留入口默认隐藏、Profile 真源和删除规则。
- 前端 3 个聚焦文件共 27 个测试通过；`pnpm check` 通过，TypeScript 为 0 个新增诊断；国内站 `pnpm build:cn` 通过并生成 96 个静态页面。
- 文档校验、临时 Git index 下的 change-impact 校验和完整变更集 `git diff --check` 通过。

## unverified
- 未在真实已部署 Agent 上验证 5/10 套餐切换与公网创建行为；本次没有发布授权。
- 全仓 `validate_context --build-catalog` 和 context 单测仍被分支已有的旧 Task Pack schema、历史明文疑似项及英文段落失败阻断；本次两个 Task 文档已补齐 schema，聚焦文档校验与 change-impact 均通过。

## discard
- Vitest 默认 `localhost` 因本机 DNS 解析失败；改用 `--api.host 127.0.0.1` 后聚焦测试通过，不再重复无效参数组合。
- CTL 全包直接测试会命中仓库既有 SQLite CGO/rootless Docker 环境问题；继续使用聚焦测试和全包编译覆盖。

## restore
- 工作树：`/Users/pablozhong/codex/lightvela-multi-bot-profile`，分支 `feature/multi-bot-profile-0909-domestic`。
- FE-AI change：`.workflow/native/changes/multi-bot-plan-quota/brief.md`，phase=`verify`，revision=`3`。
- 主要改动：`ctl/migrations/000031_*`、Bundle/Pass transport 和 logic、`ctl/pkg/instance/bots.go`、前端 Pass/Agent context、PRD 与正式运行时设计文档。

## requirement_ids / requirement_refs / requirement_excerpt
- `requirement_ids`：`multi-bot-plan-quota`。
- `requirement_refs`：`wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`、`.workflow/native/changes/multi-bot-plan-quota/brief.md`。
- `requirement_excerpt`：Launch/Launch AI 每个 Agent 最多 5 个 Bot，Cruise/Cruise AI 最多 10 个，主 Bot 计入数量。

## interface_refs / data_structure_refs
- `interface_refs`：Bundle 导入/修改接口、用户 Bundle/Pass 响应、`POST /v1/instances/{instance_id}/bots`。
- `data_structure_refs`：`bundle.bot_quota_per_agent`、`BundleDetail`、`PassDetail`、前端 `Pass.bot_quota_per_agent`。

## history_context
- `current_design_refs`：`docs/engineering/domains/agent-gateway-runtime.md`、`ctl/pkg/logic/bundle/design.md`。
- `relevant_evolution`：套餐 Bot 上限从待定变更为 Launch 系列 5、Cruise 系列 10，并与 `agent_quota` 解耦。
- `superseded_refs`：旧 PRD 中“一期是否设置每实例 Bot 数量上限”的待确认项已失效。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/subscription-entitlements.md@2.0.0` | 套餐权益边界 | 保持 Bundle 为权益真源 |
| `docs/context/project/services/ctl.md@2.1.0` | CTL 服务边界 | 约束实例创建的权威校验 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端相邻约束 | 覆盖类型、i18n 与测试 |

## next_action
- 通过 FE-AI Native verify 门禁写入报告并进入待归档状态；未经用户明确要求不归档、不提交、不推送、不创建 MR。
