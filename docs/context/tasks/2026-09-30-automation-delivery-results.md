---
id: task-automation-delivery-results-2026-09-30
type: task
scope: Web scheduled-task delivery visibility and run-result access.
triggers: ["scheduled task delivery", "cron output", "automation run result"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-30-automation-delivery-results.md
status: active
reviewed_at: 2026-10-01
review_due: 2026-11-01
revision: 1.0.0
precedence: task
derived: false
---

## goal
让定时任务的本地投递状态清楚可见，并让用户从所属 Bot 的最近执行记录取回 Markdown 结果。

## non_goals
- 不改 Hermes 上游调度器或自动改写现有任务的投递目标。
- 不跨 Bot 或 Profile 读取文件，不执行发布或生产操作。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户反馈截图（2026-09-30）：第三个 Bot 的任务使用 `deliver: local`，用户未在聊天收到结果，无法从主 Bot 取回该 Bot 的本地文件。
- 用户本轮确认“改吧，新起一个分支”；创建入口仍未知，不能假定所有任务都有可用 `origin`。

## interface_refs / data_structure_refs
- `frontend/src/lib/hermes-cron-client.ts` 的 `HermesCronTarget`、`CronRunRecord.output_path` 与 `execCommand`。
- `frontend/src/pages/marketing/agent-automations-panel.tsx` 的任务表单、任务卡、最近执行详情。
- 结果读取必须绑定当前 Bot/Profile，只允许读取该 Profile 的 `cron/output/<job-id>/*.md`。

## history_context
- `current_design_refs`：`frontend/openspec/specs/marketing.md`、`frontend/openspec/plan.md` 的定时任务创建和通知确认约束。
- `relevant_evolution`：当前网页手动创建默认选中已连接通道；固定通知任务要求至少一个通知通道。Hermes 的 `origin` 依赖真实聊天创建上下文。
- `superseded_refs`：无。

## acceptance
- 未选通知通道的创建操作必须明确确认“仅本地保存”，现有 `local` 任务有可见提示和设置通知入口。
- 最近执行可查看和下载当前 Bot/Profile 的 Markdown 结果；路径越界、缺失、过大时拒绝读取并提示。
- 相关组件、命令构造、中文和国际站文案测试通过。

## affected_paths
- `frontend/src/lib/hermes-cron-client.ts` 及测试。
- `frontend/src/pages/marketing/agent-automations-panel.tsx` 及测试、i18n 资源。
- 定时任务产品文档和本 Task Pack。

## required_context
- `agent-gateway-runtime` 与 `frontend-product-surface`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@2.0.0` | Agent 与网关归属 | 保持读结果与任务变更在所属实例内 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端服务边界 | 双站和 i18n 验证 |
| `frontend/AGENTS.md@current` | 服务规则 | 前端测试与类型门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 相邻实现 | 检查测试和翻译生成链路 |
| `frontend/openspec/specs/marketing.md@current` | 当前产品规格 | 保留任务与最近执行的页面职责 |
| `docs/context/flows/tapd-gongfeng-delivery.md@2.0.0` | MR 交付门禁 | 核对目标分支、提交与 CI 状态 |
| `docs/context/project/upstream-subtrees.md@2.2.0` | OpenCraft 真源边界 | 仅从 mono2 前端源码生成兼容副本 |
| `opencraft/AGENTS.md@current` 与 `opencraft/MONO2_MIGRATION.md@current` | 生成物约束 | 使用官方同步和漂移校验命令 |

## evidence
- 初始隔离工作树基于 `master@efe04e16e`，分支 `codex/automation-delivery-results`。
- 网页创建任务已有“默认选中已连接通道”逻辑；固定通知任务已要求选择通道。无通道时新建需要明确确认本地保存，现有本地任务展示状态和设置通知入口。
- 最近执行从所属 Bot/Profile 的 `cron/output/<job-id>/*.md` 按需读取；路径越界、符号链接逃逸、缺失和超过 1 MiB 的结果均拒绝读取。
- 国内及国际站现有定时任务文档已同步说明本地保存和从最近执行查看、下载 Markdown；国际站通知任务文档中与当前实现冲突的无通道描述已修正。
- MR !4878 的 CI 在 OpenCraft guard 因 `i18n/generated/en-US.json` 生成副本漂移失败。分支合并 `origin/master@558470e16` 后，官方脚本同步 130 个文件；实际变更限于 11 个生成文件，其中包括 `UPSTREAM.json`。

## risks
- 旧任务的 `origin` 可能没有创建时会话；不自动把 `local` 改为 `origin`。
- 执行内容可能较大；读取限定目录和 1 MiB 大小，超出后显示不能在此查看或下载的提示。
- 聊天创建任务由 Hermes 上游处理，本次网页改动不能改变其默认投递决策；需要上游单独确认。

## validation
- 聚焦 Vitest：`hermes-cron-client.test.ts`、`agent-automations-panel.test.ts` 和 global 对应测试合并复跑，326/326 通过。
- `pnpm check` 通过：i18n 提取/结构/繁体转换、文档同步/MDX、TypeScript 基线 0 个新增诊断。现存 i18n 告警 47 个。
- `validate_documentation.py --repo . --format json` 通过，无破损一方链接。
- `validate_context.py --build-catalog` 失败于大量既有 Task Pack schema/历史错误；本 Task Pack 完善 frontmatter 后不在错误列表中。仓库级 Context 单测同样受既有 Context 契约失败影响。
- `git diff --cached --check` 与 `validate_change_impact.py --repo . --staged` 通过，changed-path 无匹配高风险规则。
- 合并 master 后，`npm --prefix opencraft run check:mono2-agent-console` 验证 130 个文件，OpenCraft 插件类型检查及 `test:embedded-ci` 155 项测试通过。
- 合并 master 后，`pnpm check`、定时任务聚焦 Vitest 326 项以及国内站和国际站构建均通过。

## decisions
- 优先补齐结果可达性和本地投递显性反馈；聊天创建路径由 Hermes 上游持有，未确认入口前不修改上游运行时。

## scan_scope
- `frontend/src/lib/hermes-cron-client.ts` 与 `frontend/src/pages/marketing/agent-automations-panel.tsx` 的定时任务链路。

## scan_output
- 精确搜索记录在本轮工具输出中。

## handoff
- MR !4878 已存在，用户授权修复 CI 并继续推送；完成生成物检查和远端核验后交接。未授权合并或发布。

## stage
CI 漂移修复已在隔离分支完成，等待最后验证和推送。

## verified
- 隔离分支只含本次改动；国内与国际站聚焦测试 326/326、前端检查、文档检查和 changed-path 门禁已有通过证据。
- 全量 Context 门禁的历史错误仍存在；本 Task Pack 不在错误列表中。
- 已合并 `origin/master@558470e16`；官方同步后的 OpenCraft 130 文件校验通过。

## unverified
- 真实用户 Bot 的执行结果读取、聊天创建任务的 `origin` 行为和线上环境未验证。
- 真实用户 Bot 和线上发布状态未验证。

## discard
- 国际站测试原来的 `platforms` 状态模拟已由当前 `channels` 结构替代。
- 国际站文档原来的“通知任务无通道仍可保存”描述已由真实表单约束替代。

## restore
- 工作树 `/Users/pablozhong/.codex/worktrees/automation-delivery-results/lightvela`，分支 `codex/automation-delivery-results`；根 checkout 的既有脏改动未碰。
- 本任务前端验证入口为 `pnpm check` 和三个聚焦 Vitest 文件。

## next_action
提交生成副本和本记录，推送 MR 分支并核对远端 SHA、CI 状态。
