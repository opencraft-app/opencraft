---
id: agents-loading-performance-2026-09-14
type: task
scope: Optimize initial loading for the Agent management route.
triggers: ["/agents loading", "Agent page performance", "MR delivery"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-14-agents-loading-performance.md
status: active
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

## goal
缩短 `/agents` 首次打开与刷新时的等待，避免重复权益请求和非当前页面代码阻塞首屏。

## non_goals
- 不修改后端、鉴权协议、计费规则、Bot 配额或生产部署。
- 不重做 Agent 页面视觉布局。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户反馈：`/agents` 页面打开后加载偏慢；确认修复并提交新的 MR。

## interface_refs / data_structure_refs
- `frontend/next-site/agents-page-client.tsx`：Agent 路由鉴权边界。
- `frontend/src/contexts/agent-context.tsx`：登录后 Bot 与 Pass 的初始刷新所有权。
- `frontend/src/pages/marketing/agent-settings-page.tsx`：设置页加载与面板渲染边界。
- 保持现有 API、配额和错误恢复交互不变。

## history_context
- `current_design_refs`：`docs/context/flows/tapd-gongfeng-delivery.md`、`docs/context/flows/change-delivery.md`。
- `relevant_evolution`：Agent 页面已使用分面板 lazy loading，但路由客户端和四个面板仍为静态导入；设置页挂载还会重复触发一次 Pass 刷新。
- `superseded_refs`：无。

## acceptance
- 未通过鉴权时不加载 Agent 设置页与工作台主包。
- 登录后初始 Pass 刷新只由 `AgentProvider` 发起一次。
- 已有 Bot 时，Pass 加载不替换整个设置页；无 Bot 时仍等待 Pass 解析后再展示创建状态。
- 通过聚焦测试、前端 `pnpm check`、构建和浏览器回归。

## affected_paths
- `frontend/next-site/agents-page-client.tsx`
- `frontend/next-site/__tests__/agents-page-loading-boundary.test.ts`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-settings-loading.ts`
- `frontend/src/pages/marketing/__tests__/agent-settings-loading.test.ts`
- `docs/context/tasks/2026-09-14-agents-loading-performance.md`

## required_context
- Pack：`tapd-gongfeng-delivery`
- 前端服务规则：`frontend/AGENTS.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@ff5035276` | 仓库硬边界 | 约束 worktree、验证和 MR 交付 |
| `frontend/AGENTS.md@ff5035276` | 前端服务规则 | 确定测试与 `pnpm check` 门禁 |
| `docs/context/flows/tapd-gongfeng-delivery.md@ff5035276` | 路由器 must_read | 约束需求到 MR 的证据链 |
| `docs/context/flows/change-delivery.md@ff5035276` | 交付流程 | 区分源码、MR、合并和发布状态 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@ff5035276` | 前端邻接卡 | 检查测试、构建、i18n 邻居 |

## evidence
- 基线源码确认：路由客户端静态导入完整 Agent 页面；设置页和 `AgentProvider` 同时触发 `refreshPasses`。
- 聚焦回归：5 个文件、41 项 Vitest 通过。
- 前端门禁：`pnpm check` 通过，0 个新增 TypeScript 诊断。
- 构建：`pnpm build:cn`、`pnpm build:global` 通过。
- 同 SHA 生产静态构建对比（全新浏览器上下文，各 5 次）：首屏脚本传输量 5,556,714 B 降至 4,065,129 B（-26.8%）；window load 均值 129.8 ms 降至 80.8 ms（-37.8%）；通道内容可见均值 1911.6 ms 降至 1868.8 ms。
- 浏览器验证：国内/国际 Channels 页面及国际 Models、Skills、Automations 页面均返回 200、内容完整、无框架错误覆盖层。
- 全量 Vitest 在本机出现 master 基线既有失败并长时间不退出；已在同 SHA detached worktree 复现代表性失败，未将其计作本改动通过。

## risks
- lazy 边界可能造成短暂空白：使用现有 `AgentsRouteLoading` 作为设置页加载占位。
- Pass 未解析时误开放创建：配额仍维持 fail-closed，且无 Bot 状态继续等待 Pass 解析。
- 回滚：回退本任务单一提交即可恢复原加载行为。

## validation
- 聚焦 Vitest。
- `pnpm check`。
- 国内站与国际站 Next 构建或等价门禁。
- 浏览器验证 `/agents` 加载布局与请求数量。
- `validate_change_impact.py --repo . --staged`。

## decisions
- 仅拆分路由与非当前面板加载，不调整 Session 鉴权请求链，避免扩大跨页面影响。
- 初始 Pass 刷新归 `AgentProvider` 所有，设置页只在明确重试或业务动作后刷新。

## scan_scope
- `frontend/next-site/`
- `frontend/src/pages/marketing/`
- `frontend/src/contexts/agent-context.tsx`

## scan_output
- Graphify 查询 `agent agents page loading settings session refresh import route` 用于复核依赖边界。

## handoff
- 状态：实现与本地验证完成，待提交并创建新 MR。
- 阻塞项：无。
