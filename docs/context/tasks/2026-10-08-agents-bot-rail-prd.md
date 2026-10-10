---
id: agents-bot-rail-prd
type: task
scope: Dual-site Agents Bot rail PRD and interactive demo.
triggers: ["agents bot rail", "agents prd", "agents interaction prototype"]
owner: pablozhong
authority: primary
source_of_truth:
  - wiki/prd-docs/2026-10-08-agents-bot-rail.md
status: active
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

## goal
形成双站 `/agents` Bot 独立竖栏的可评审 PRD 与交互 Demo。

## non_goals
- 不改前端生产代码、运行时、GitOps 或云资源。
- 不调整「日常／探索」分组及 Bot 业务能力；本轮只在 `/agents` 移除总览与其两块推荐内容。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户于 2026-10-08 提供 Codex 与微信收藏截图，要求把多 Bot 切换放在最左窄竖栏，不再放在现有宽侧栏；确认双站同步、头像直接切换、保留其他导航，并认可状态／重启／删除留在当前 Bot 卡片、新增 Bot 放入竖栏。
- 用户最新反馈替代先前总览决策：移除总览，切换 Bot 默认进入新建会话；总览红框内账号权益收进左侧导航底部账户入口，产品动态和定时任务推荐从 `/agents` 移除。
- 产品草稿：`wiki/prd-docs/2026-10-08-agents-bot-rail.md`。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx`：`visibleBots`、`handleSelectBot`、`multiBotEnabled`、`canCreateAdditionalBot`、卡片与创建按钮。
- 保留 `?bot=`、既有分区深链、创建资格、确认和禁用规则；切换 Bot 时统一落到新建会话。
- 总览卡片当前调用 `onOpenChat` 创建目标 Bot 新会话；移除总览后要保留同等的新会话落点，并迁出总览独有的资料编辑／复制 Bot 操作。

## history_context
- current_design_refs：`wiki/prd-docs/2026-09-28-multi-bot-overview.md`、`wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`。
- relevant_evolution：当前 `origin/master` 为 `ca706fe27dbc5722f9bafeeeebac5d13fd627692`；宽侧栏使用「日常／探索」与可折叠布局。
- superseded_refs：早期把 Bot 选择器放在宽侧栏的产品描述仅用于对照，本 PRD 调整其位置，不改变数据能力。

## acceptance
- PRD 覆盖布局、状态、双站、移动端规则和可观察验收；Demo 可点击演示核心路径。
- 文件结构检查与 `git diff --check` 通过；修订版 PC 交互待用户核对。

## affected_paths
- `wiki/prd-docs/2026-10-08-agents-bot-rail.md`
- `wiki/prd-docs/demos/2026-10-08-agents-bot-rail.html`
- 本 Task Pack。

## required_context
- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
| --- | --- | --- |
| `AGENTS.md@ca706fe` | 仓库边界 | 只准备本地产品稿，未获 Git 写操作授权。 |
| `frontend/AGENTS.md@ca706fe` | 前端边界 | 识别实际 Next.js 页面与验证范围。 |
| `docs/context/project/services/frontend.md@ca706fe` | 服务 Pack | 双站前端职责。 |
| `docs/context/domains/site-environment-routing.md@ca706fe` | Domain Pack | 两站独立验收及原功能开关。 |
| `frontend/src/pages/marketing/agent-settings-page.tsx@ca706fe` | 现状源码 | Bot 切换、卡片与创建门禁。 |
| `frontend/src/styles.css@ca706fe` | 现状样式 | 桌面固定侧栏与移动抽屉。 |
| `wiki/prd-docs/2026-09-28-multi-bot-overview.md@ca706fe` | 相关产品方案 | 旧总览方案；本轮新反馈替代其页面保留决策。 |

## evidence
- 只读源码检查：当前选择器为卡片 `Popover`；新建按钮在 `multiBotEnabled` 下展示，受创建资格禁用；切换复用 `handleSelectBot` 并写入 `?bot=`。
- 总览源码检查：`AgentFleetOverview` 展示全部 Bot，卡片有新建对话、修改资料、复制和删除入口，并承载权益横幅、产品动态、定时任务推荐；移除时需迁走仍有价值的功能。
- `node --check` 通过；HTML 解析成功，PRD 的 Demo 链接指向存在的文件。
- 文档验证通过：`broken_first_party_links=0`、`warnings=[]`。
- 1280px 桌面与 390px 手机原型已浏览器核对：头像切换更新卡片／主区，配额模拟禁用新增，手机切换后抽屉关闭。
- 早期原型曾核对总览与保留「探索」路径；用户最新反馈已替代该交互。修订版浏览器已核对从「探索」切换 Bot 后进入目标 Bot 空白新会话，账户入口展开显示四类权益信息。
- 移动端头像条经用户确认；最新 `git diff --check` 通过，修订版 PC 原型待用户核对。

## risks
- 竖栏增加桌面导航占宽：以 1024px、1280px、1440px 核对布局；必要时设计评审调整宽度。
- 移动端横向列表在窄屏抽屉内可能溢出：研发验收覆盖 390px 及更窄视口。
- 切换时旧 Bot 数据闪现：沿用现有状态清理与分区兜底，研发验收逐项检查。

## validation
- 本次仅文档与独立 HTML Demo，运行 `git diff --check`、文档链接与 Demo 静态结构检查；生产前端代码未变更，不运行前端 check/test/build。

## decisions
- 用户确认双站同步、头像直接切换；最新反馈明确移除总览、Bot 切换落新会话、权益移至底部账户入口。
- 新建 Bot 在竖栏；状态、重启／修复、删除在当前 Bot 卡片。用户确认移动端在现有导航抽屉顶部使用横向头像条。
- 原总览中的产品动态和定时任务推荐随页面移除；修改资料／复制 Bot 迁入当前 Bot 卡片管理菜单；其他 Bot 配置分区保持原入口。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`、相关 PRD。

## scan_output
- 有界源码搜索输出已在本任务会话核对；无独立扫描产物。

## handoff
- 当前状态：根据用户新反馈修订 PRD 与 Demo，待用户确认新版 PC 原型；发布时序待评审。
- 下一步：核对交付范围与工蜂提交授权，再决定 TAPD 与 MR。
