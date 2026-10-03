---
id: task-automation-delivery-results-2026-09-30
type: task
scope: View and download recent automation results from the owning Bot/Profile.
triggers: ["scheduled task result", "cron output", "automation run result"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-30-automation-delivery-results.md
status: active
reviewed_at: 2026-10-03
review_due: 2026-11-02
revision: 1.1.0
precedence: task
derived: false
---

## goal
把 MR !4878 收窄为：在所属 Bot/Profile 的“最近执行”中按需查看、下载单次执行结果，双站按钮统一为“下载执行结果”。

## non_goals
- 不修改新建或编辑定时任务时的通知通道、本地投递逻辑及表单提示。
- 不修改 Hermes 调度器、聊天创建任务的投递规则或生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- [MR !4878](https://git.woa.com/wisp/mono2/-/merge_requests/4878)：保留最近执行结果读取，撤回同 MR 的本地投递表单改动。
- 用户 2026-10-03：国内站和国际站都把“下载 Markdown”改为描述动作的“下载执行结果”；MR 中其他功能改动不再需要。

## interface_refs / data_structure_refs
- `frontend/src/lib/hermes-cron-client.ts`：`HermesCronTarget`、`CronRunRecord.output_path`、`readCronRunOutput`。
- `frontend/src/pages/marketing/agent-automations-panel.tsx`：`RecentCronRunsPanel`、`RecentCronRunDetailModal`。
- 结果文件限定在当前 Profile 的 `cron/output/<job-id>/*.md`，最大 1 MiB。

## history_context
- `current_design_refs`：`frontend/openspec/specs/marketing.md` 的“最近执行”约束。
- `relevant_evolution`：MR 原含本地投递表单提示和文档说明；2026-10-03 用户要求撤回，仅保留结果查看能力。
- `superseded_refs`：本 Task Pack 原先记录的本地投递改动，现不再是本 MR 目标。

## acceptance
- 国内站和国际站的详情弹窗展示“查看执行结果”和“下载执行结果”；下载文件仍为 `.md`。
- 读取只访问当前 Bot/Profile 的结果文件；越界、符号链接逃逸、缺失和超过 1 MiB 均拒绝。
- MR 相对目标分支不再包含创建表单的本地投递提示、放宽校验及对应测试/文档/规格变化。
- 前端 lint、类型、聚焦测试及双站构建、OpenCraft 同步检查通过。

## affected_paths
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/lib/hermes-cron-client.ts`
- 相邻测试、`frontend/src/i18n/generated/`、双站定时任务文档、`frontend/openspec/specs/marketing.md`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/` 同步副本

## required_context
- `frontend-product-surface`、`service-frontend`、`site-environment-routing`、`tapd-gongfeng-delivery`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@current` | 前端门禁 | 检查 lint/type/test/build |
| `docs/context/project/services/frontend.md@2.1.0` | 前端与文档真源 | 双站和生成物边界 |
| `docs/context/domains/site-environment-routing.md@2.0.0` | 双站边界 | 分别验证国内与国际站 |
| `docs/context/flows/tapd-gongfeng-delivery.md@2.0.0` | MR 交付门禁 | 区分本地改动与远端状态 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | i18n 邻接 | 从源码重新生成字典并检查相邻测试 |
| `frontend/openspec/specs/marketing.md@current` | 产品规格 | 只保留结果查看约束 |
| `.agents/skills/gongfeng/SKILL.md@current` | 工蜂访问规则 | 只读鉴权与 MR 查询 |

## evidence
- 2026-10-03 工蜂只读查询：MR !4878 为 opened，源提交 `12f99a3c49b6d6758e61842545b36fd6e6059693`。
- 代码差异显示本地投递表单的新增行为仅为额外 `channelStatus === "ready"` 提交条件与提示块，已从工作树撤回。
- `pnpm i18n:extract` 已生成新按钮 key；各语言翻译已补齐，`pnpm i18n:zh-hant` 已运行。
- `npm --prefix opencraft run sync:mono2-agent-console`：同步 130 个嵌入文件。

## risks
- 下载以浏览器读取后的 Markdown 内容生成 `.md` 文件；真实用户 Bot 和线上环境尚未验证。
- MR 尚未由本轮更新；提交、推送和修改 MR 描述须按交付门禁另行确认。

## validation
- 聚焦 Vitest：3 文件，324/324 通过。
- `pnpm check` 与 `pnpm typecheck` 通过：TypeScript 基线 171，当前 166，新增 0。
- `pnpm build:cn` 与 `pnpm build:global` 均通过；文档校验无破损站内链接、未分类文档。
- OpenCraft 同步校验 130/130、插件 `typecheck` 和嵌入测试 155/155 通过。
- 全量 `pnpm test --maxWorkers=2` 出现模型配置、诊断面板等无关失败及多次 Node OOM 后停止；未得到全量通过结论。
- `pnpm lint` 无法运行：当前 `frontend/package.json` 无 `lint` 脚本且未安装 ESLint。
- 全量 `validate_context.py --build-catalog` 因大量既有 Task Pack schema/历史错误失败；所见错误未涉及本 Task Pack。

## decisions
- 保留“最近执行”文件读取和 1 MiB/目录校验；撤回与结果查看无关的本地投递改动。
- 按钮以用户动作命名；文件格式仍为 Markdown，必要时在文档中说明。

## scan_scope
- MR !4878 相对 `master@62c1bf91b` 的 33 个变更路径；源码搜索限于定时任务页面、客户端、文档与 i18n。

## scan_output
- MR 文件差异和本地 `git diff` 摘要，不保存完整扫描输出。

## handoff
- 本地改动及可运行门禁已完成；等待用户确认是否 commit、push 并更新 MR 描述。全量前端测试与全量 Context 校验未通过，限制已在验证记录中列出。

## stage
MR 范围已收窄，正在完成最终差异审核与交接。

## verified
- 聚焦 Vitest 324/324、`pnpm check`、`pnpm typecheck`、国内及国际站构建通过。
- OpenCraft 130 文件同步校验、插件类型检查和嵌入测试 155/155 通过。
- 文档校验无破损站内链接或未分类文档。

## unverified
- 真实用户 Bot 的文件读取和线上环境效果未验证。
- 全量前端测试在多个无关模块失败后出现 Node 内存耗尽，本轮已停止；完整全量通过状态未证实。
- 仓库当前没有可运行的 `pnpm lint` 脚本。
- 全量 Context 校验仍因历史 Task Pack schema 错误失败；本 Task Pack 未在所见错误中出现。

## discard
- 已撤回的本地投递表单提示及相应文档、规格、测试断言。
- 构建及 Context 校验产生的无关生成文件已恢复。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/automation-delivery-results/lightvela`，分支 `codex/automation-delivery-results`。
- MR !4878 当前远端源提交 `12f99a3c49b6d6758e61842545b36fd6e6059693`；本轮改动尚未 commit/push。

## next_action
- 核对最终 diff、更新本 Task Pack 的验证记录，再请用户明确确认 commit、push 和更新 MR 描述。
