---
id: cn-docs-batch-three-2026-09-28
type: task
scope: 国内站中文文档第三批现行功能口径校准。
triggers: ["cn docs", "国内站文档", "第三批文档"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/content/docs/
  - frontend/src/pages/marketing/
status: active
reviewed_at: 2026-09-28
review_due: 2026-12-28
revision: 1.0.0
precedence: task
derived: false
---

## goal
让国内站中文文档对技能管理、长期记忆、云存储入口、通道测试、定时任务、套餐与积分的说明与当前产品实现一致，并补足三篇对比页的选择依据。

## non_goals
- 不修改国际站文档、产品功能或发布配置。
- 不把某个时点的活动价格写成固定承诺。
- 不改变既有退款、到期保留和升配业务规则。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-09-28 在第三批文档复查后要求“修改吧”；本批优先修正复查发现的具体功能冲突与缺口。

## interface_refs / data_structure_refs
- `frontend/src/config/docs-sidebar.ts` 的 `CN_SIDEBAR`、`CN_SLUG_TO_FILE` 与 `frontend/scripts/sync-fumadocs-content.mjs` 的 `cnDocs`：保留当前国内站注册和 slug。
- `frontend/src/pages/marketing/agent-config/hooks/useChannelOperations.ts`：测试按钮只对已连接通道发送，返回成功仅代表发送命令被接受。
- `frontend/src/pages/marketing/agent-channel-panel.tsx`：测试提示要求用户在聊天软件中确认收到。
- `frontend/src/components/site/user-avatar-menu.tsx`：Agent 侧栏账号菜单包含云存储入口。
- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`：国内站 SkillHub 与已安装技能管理入口。
- `frontend/src/pages/marketing/agent-automations-panel.tsx`：三类定时任务和国内站五个通知通道。
- `frontend/src/lib/bot-quota.ts` 与生产订阅页：启航 / 巡游两系列、积分档位与 5 / 10 个 Bot 权益。
- `credit/AGENTS.md`：额外积分包的一次性资源性质、有效期和抵扣顺序。

## history_context
- current_design_refs: `docs/context/domains/site-environment-routing.md` 与 `frontend/AGENTS.md`。
- relevant_evolution: 第二批文档已合并至 `origin/master@939c01b03119530c22128205ba64ea73e6c7ca2a`，但 FAQ 和科普页保留旧技能口径。
- superseded_refs: FAQ 的“只能通过对话卸载技能”“清除记忆需要删除 Agent”、科普页的“面板安装即将推出”。

## acceptance
- FAQ 不再把删除聊天消息、长期记忆和整个 Agent 混为一谈；技能管理入口与操作指南一致。
- 云存储指南和配置总览指向实际账号菜单入口。
- 五篇国内通道指南及配置总览说明测试按钮、发送确认和真实收发验证的区别。
- 套餐、积分、概览、首次开通、FAQ 的订阅口径一致，准确说明额外积分包与 Bot 数。
- 三篇定时任务场景页与三篇对比页达到国内站 B 档质量标准。
- 源文档与 zh-cn 渲染产物一致；链接、注册、文档同步和前端相关门禁通过。

## affected_paths
- `frontend/src/content/docs/` 的国内站源文档、内容台账与本 Task Pack。

## required_context
- `site-environment-routing`、`subscription-entitlements`、`credit-service-detail`、`frontend/AGENTS.md`、`credit/AGENTS.md`、`frontend-runtime-openspec-i18n` 邻接卡。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@939c01b03` | 路由 must_read | 国内站区域边界 |
| `frontend/AGENTS.md@939c01b03` | 服务级规则 | 文档同步和前端门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@939c01b03` | 邻接卡 | 检查生成入口与测试邻居 |
| `docs/context/tasks/TASK-TEMPLATE.md@939c01b03` | Task Pack 模板 | 交接记录结构 |
| `frontend/scripts/sync-fumadocs-content.mjs@939c01b03` | 生成入口 | 核对 cnDocs 注册与渲染产物 |
| `docs/context/domains/subscription-entitlements.md@939c01b03` | 订阅路由 must_read | 套餐、积分权益边界 |
| `docs/context/project/services/credit.md@939c01b03` | 订阅路由 must_read | 模型积分服务与生命周期 |
| `credit/AGENTS.md@939c01b03` | 最近服务级规则 | 积分包与套餐积分区分 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md@939c01b03` | 检查点模板 | 阶段与验证交接 |

## evidence
- 2026-09-28 `git fetch origin master`：`HEAD` 和 `origin/master` 均为 `939c01b03119530c22128205ba64ea73e6c7ca2a`；工作树初始干净。
- FAQ 与技能指南、记忆指南的同题描述冲突；产品源码可定位测试按钮和云存储账号菜单。
- 2026-09-28 生产订阅页显示启航 / 巡游两系列，每系列两种积分选项，Bot 上限分别为 5 / 10；另外提供五档有效期 1 个月的积分包，要求有效套餐。本批文档不硬编码价格。
- Manus 官方 Cloud Browser / Cloud Computer 文档及 Hermes 官方安装 / 快速开始文档用于三篇对比页的第三方事实核验。

## risks
- 线上部署可能晚于源码合并；本地同步成功不表示生产站已更新。
- 测试按钮只确认命令发送状态，文档必须要求在聊天软件确认真实收发。
- 套餐活动、库存、价格会变化，文档引导至实时订阅和结算页面核对。

## validation
- `pnpm docs:sync`、文档链接与区域适配检查、`pnpm check`、`pnpm build:cn`、前端聚焦测试、文档 validator 和 changed-files change-impact 已通过。
- 全量 `pnpm test` 首次因本机 `localhost` DNS 失败；使用 `--api.host 127.0.0.1` 后出现多处未修改区域的既有失败并长时间未结束，已中断。聚焦的 38 项文档、图片、路由、自动化顺序测试全部通过；摘要测试仅余 16 篇未修改的国际站源稿缺少摘要。
- `validate_context --build-catalog` 和 Context 单测因仓库既有错误未通过；补齐检查点元数据后定向查询，本 Task Pack 与检查点均不在剩余 3704 条错误中。Context 单测 4 项失败，均未提到本任务文件。

## decisions
- 保留现有 slug 和目录结构；优先消除会引导错误操作的内容，再补足场景与对比页。

## scan_scope
- 国内站 FAQ、配置总览、技能、记忆、云存储、五篇通道指南、套餐、积分、三篇定时任务场景、三篇对比页、相关产品组件及同步注册。

## scan_output
- 有界 `rg` 与目标文件阅读；不内联完整扫描结果。

## handoff
- 国内站 22 份改动源文档均有对应 zh-cn 生成文件且摘要同步，`git diff --check` 通过。用户已于 2026-09-28 明确授权提交本批 MR；交付时须核对远端分支、MR 与 CI 即时状态。
