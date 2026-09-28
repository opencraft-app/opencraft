---
id: cn-docs-batch-two-2026-09-28
type: task
scope: 国内站中文文档第二批任务导航与现行产品入口校准。
triggers: ["cn docs", "国内站文档", "第二批文档"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/content/docs/
  - frontend/src/config/docs-sidebar.ts
status: active
reviewed_at: 2026-09-28
review_due: 2026-12-28
revision: 1.0.0
precedence: task
derived: false
---

## goal
从最新 master 完成国内站中文文档第二批：让用户按任务找到现有功能，并让关键指南与当前控制台入口、权限和恢复路径一致。

## non_goals
- 不调整国际站文档与产品功能开关。
- 场景、对比、Hermes 原理长文分层及套餐与 SEO 全面核对留给第三批。
- 不把源码或本地构建视为生产发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-09-28：同步云端 master 后继续下一批文档。
- `docs/context/tasks/2026-09-27-cn-docs-batch-one.md`：第二批按任务重组导航，核对 Bot、网页对话、技能、记忆、人设、云存储、诊断、实验功能，补足操作和失败恢复。

## interface_refs / data_structure_refs
- `frontend/src/config/docs-sidebar.ts` 的 `CN_SIDEBAR` 与 `CN_SLUG_TO_FILE`；`frontend/scripts/sync-fumadocs-content.mjs` 的 `cnDocs` 与 `CN_GROUP_ORDER`：同一页面的分组、顺序和 slug 必须一致。
- `frontend/src/lib/agent-routes.ts`：控制台私域页面 URL；`frontend/src/pages/marketing/agent-settings-page.tsx`：菜单与对话、Bot 创建权限。
- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`：国内技能安装、已安装与卸载入口。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md` 产品文档区域、Agent 创建引导与侧栏规则。
- relevant_evolution: MR !4679 的第一批修复已进 master；MR !4687 的国际公测说明清理已合并。当前基线 `origin/master@7b196ee3c84380767bca08a0d478531b063b87b1` 包含 !4687 合并提交。
- superseded_refs: 旧文档“3. 技能卡片”“只能通过对话删除技能”和网页对话可用于任意 Bot 的表述。

## acceptance
- 国内站任务导航有明确的开始、Bot/模型、通道/技能、自动化/资料、管理/排障与实验功能入口；原有 slug 不变且无孤儿页或重复入口。
- 网页对话说明主 Bot 边界；技能页与现行技能市场和删除操作一致；Bot 创建说明体现运行时开关和套餐限制；文件与 Labs 入口不误导。
- 网页对话、技能和 Bot 等重点操作页提供前置、步骤、验证与失败处理；源文件与 zh-cn 生成产物一致。
- 文档同步、聚焦测试、前端检查、国内站构建、文档与变更影响门禁通过。

## affected_paths
- `frontend/src/config/docs-sidebar.ts`、`frontend/scripts/sync-fumadocs-content.mjs`、`frontend/src/content/docs/` 国内站源文档与更新日期、正式设计和内容台账。

## required_context
- `site-environment-routing`；前端服务级 `AGENTS.md`；`frontend-runtime-openspec-i18n` 邻接卡。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@7b196ee3c` | 路由 must_read | 国内站区域边界 |
| `frontend/AGENTS.md@7b196ee3c` | 服务级规则 | 前端验证门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@7b196ee3c` | 邻接卡 | 检查路由、生成物与测试邻居 |
| `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts@7b196ee3c` | 测试邻居 | 对话和新增 Bot 入口约束 |
| `docs/engineering/domains/site-environment-routing.md@7b196ee3c` | 现行设计 | 文档区域与控制台入口 |
| `docs/context/tasks/TASK-TEMPLATE.md@7b196ee3c` | 模板 | 保持交接结构 |

## 页面到产品入口覆盖矩阵
| 文档 | 当前产品入口与约束 | 本批处理 |
|---|---|---|
| `configuration/bots-switching` | `/agents/overview` Bot 选择器；新增按钮受 `multiBotEnabled`、套餐额度和创建/删除状态约束 | 写明可用条件与验证 |
| `configuration/agent-chat` | `/agents/chat`，侧栏“对话”标签；常规入口只支持主 Bot | 重写操作、验证和失败处理 |
| `configuration/skill` | `/agents/skills` 的“技能 / 技能包 / 已安装”；国内搜索 SkillHub，已安装中可删除非系统技能 | 清理旧卡片与对话独占删除口径 |
| `configuration/personality` | `/agents/persona`，当前 Bot 的 Soul；新会话验证 | 入口与 Bot 作用域核对 |
| `configuration/memory` | `/agents/memory`，当前 Bot 的 `MEMORY.md` / `USER.md` 和额度 | 入口与作用域核对 |
| `configuration/files` | `/agents/files` 路由对应文件管理；当前侧栏任务组没有直接菜单项 | 用可点击路由替代不存在的菜单描述 |
| `configuration/diagnostics` | `/agents/diagnostics`，重置模型配置作用于当前 Bot 的 Profile | 保留先看日志再恢复的顺序 |
| `configuration/deepseek-harness` | `/agents/labs/deepseek-harness`，实验室 Beta | 单项 Beta 保留 |
| `configuration/workbench` | `/agents/websites`，实验室“我的工作台” Beta；配额由 capability 返回 | 删除硬编码套餐数量，按控制台用量核对 |

## evidence
- 工蜂 MR !4687 `merged`、检查 `success`，合并提交 `cd7b64cc`；已从远端抓取 master，并从 `origin/master@7b196ee3c` 创建干净的 `codex/cn-docs-batch-two`。
- 现行控制台源码和相邻测试已核对；47 个国内站 slug 在 sidebar、源注册与生成 meta 中唯一且一致，无孤儿页。
- `pnpm docs:sync`、`pnpm check`、`pnpm build:cn` 已通过；国内构建生成 48 个文档路由（含 `/docs` 根页）。
- 聚焦 Vitest 5 个文件 37/37 通过。现有自动化测试对 7 个语言的验证标题和西语页签用了旧名称，已将断言更新至 master 上实际文档标题；国际站文档内容未改。
- `validate_documentation.py --format json` 已通过，无断链或警告；staged change-impact 和最终差异检查待完成。

## risks
- 生产控制台可能落后于 master：文档采用稳定路由和可见条件，发布前需要真实登录态走查。
- 分组改动影响文档导航和生成 meta：同步后核对双注册与无孤儿页。

## validation
- `pnpm docs:sync`、聚焦文档测试、`pnpm check`、`pnpm build:cn`、文档 validator 和 staged change-impact。

## decisions
- 仅重组国内站任务导航，保留现有 slug 与长文分类；实验功能独立分组，避免混入排障。
- 在已有功能页修正事实，不新增重复 Bot/聊天页面。

## scan_scope
- 国内站文档源、sidebar 与同步注册、控制台导航及相邻测试。

## scan_output
- 有界 `rg` 与目标文件阅读；未保存完整扫描输出。

## handoff
- 国内站第二批内容和本地主要门禁已完成；等待 staged 变更影响检查及提交交付。
