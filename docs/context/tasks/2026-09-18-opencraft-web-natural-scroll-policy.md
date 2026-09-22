---
id: task-2026-09-18-opencraft-web-natural-scroll-policy
type: task
status: handoff
created_at: 2026-09-18
owner: skipzhang
---

# opencraft Web 主聊天滚动策略切回 natural 贴底

## goal

排查"工具调用 ChatUI 高光滚动不对"的体感问题，确认根因并把 Web 主聊天入口
滚动策略切回 Codex 自然贴底（natural）分支，保证切换不引入移植偏差。

## non_goals

- 不修改 follow reducer、virtualizer、测量事务或 response-placement 分支实现。
- 不切换 Expo native（`NativeResponsePositionedTurns` 保持现状）。
- 不处理快边界 spacer 保留差异与 follow 路径 windowZoom 因子（潜在项，另立任务）。
- 不做 GitOps 发布或生产变更。

## requirement_refs

- 用户直接反馈（本会话）：工具调用高光滚动"还是有点问题"，方向选择"评估切回 natural 贴底策略"。

## interface_refs

- `opencraft/apps/workbench-web/src/components/conversation.tsx`：`ConversationScrollPolicy = "natural" | "response-placement"`，两分支互斥，policy 必填。
- `opencraft/packages/timeline-virtualizer/src/follow.ts`：四态 follow reducer 与 24/300px 阈值（本任务只读）。

## history_context

- `current_design_refs`: `opencraft/docs/reports/codex-natural-chat-scroll-policy-audit.md`、`codex-response-placement-selection.md`、`conversation-scroll-six-essays-r3562.md`。
- `relevant_evolution`: 2026-09-08 曾明确选择 response-placement 并以测试 pin 固化；本次按新证据逆转。
- `superseded_refs`: 本次切换后 `codex-response-placement-selection.md` 的主入口选择部分。

## affected_paths

- `opencraft/apps/workbench-web/src/app.tsx`（switch 由用户侧工作树落盘，本任务复核+验证）
- `opencraft/tests/workbench-timeline-host.test.ts`（pin 同步翻转，用户侧工作树）
- `opencraft/docs/reports/web-natural-scroll-policy-switch.md`（本任务新增）
- `opencraft/scripts/compare-codex-scroll.ts`（未改动，本任务复跑）

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@HEAD` | 局部入口规则 | 只读调查边界与验证清单 |
| `opencraft/packages/timeline-virtualizer/src/follow.ts@HEAD` | follow 状态机真源 | 与 ref/codex 原版对照 |
| `opencraft/apps/workbench-web/src/components/conversation/response-positioned-turns.tsx@HEAD` | watch→follow 判定 | 确认移植一致性 |
| `opencraft/apps/workbench-web/src/components/conversation.tsx@HEAD` | 策略分支接线 | natural 分支完整性评估 |
| `opencraft/apps/workbench-web/src/app.tsx@worktree` | 主入口策略选择 | 确认切换落盘 |
| `opencraft/docs/reports/codex-natural-chat-scroll-policy-audit.md@HEAD` | 既有审计结论 | 复跑对照的证据基线 |
| `ref/codex/lazy/app-initial/local-conversation-thread-CShhuS2f.js@HEAD` | 原版 follow/spacer 实现 | 逐函数对照 |
| `ref/codex/editor/visualization-wide-block-class-07643.ts@HEAD` | 原版表格样式类映射 | 处理表格超宽问题问询 |

## evidence

- run1b：response-placement 分支 vs r3562 原版同分支，production renderer + 真实时钟，143 个事件边界 1px 内一致（含 submit/completion 边界）。
- run2：natural 分支 vs r3562 原版自然路径，34 个事件边界 1px 内一致。
- 漂移表（贴底提交、无输入、正文增长）：response 37→1727px（static），natural 全程 0px。
- `tsx --test tests/workbench-timeline-host.test.ts tests/chat-web-follow-measurement.test.ts`：62 通过。
- `npm run typecheck --workspace @opencraft/workbench-web`：通过。

## risks

- response-placement 分支失去生产入口覆盖（fixture/smoke 仍覆盖分支本身）。
- 跨端差异：native 仍为 response 定位语义。
- 真实登录/模型/Host 流式链路未验证；发布另行走 GitOps。
- **新发现（与本次切换无关，待 owner 处理）**：`scripts/smoke-conversation-scroll.ts`
  的 `?submissions` 段在当前 HEAD 确定性失败于
  "answer and completion preserve history's reading position"（`completed.top` 与
  `placed.top` 差 ≥2px，重跑复现两次）。该段 fixture 直接以 response-placement
  挂载 Conversation，conversation 相关源码在工作树未修改（mtime Sep 11/14），
  与本次入口切换无关；同场景下 run1b 显示 Vela 与原版 1px 内一致，指向 smoke
  硬编码期望与 HEAD response 分支行为的偏差（候选回归源：`604883eeb` converge
  desktop workbench runtime 或 Sep 14 conversation.tsx 变更）或环境时钟敏感性。
  复现：`OPENCRAFT_PLAYWRIGHT_MODULE=… OPENCRAFT_CHROMIUM_EXECUTABLE=… npx tsx scripts/smoke-conversation-scroll.ts`。

## validation

- 已执行：聚焦测试、web typecheck、双分支 headless 对照。
- 可选补验：`npm run test:workbench:unit`、真实客户端会话验收（需要登录态与模型）。

## decisions

- 切回 natural：用户 2026-09-18 拍板；证据表明症状源于策略语义而非实现缺陷。
- 分支保留互斥基线，不删除 response-placement。

## handoff

- 工作树含并行改动（archived conversations、connector launcher），合入时注意拆分。
- 滚动策略切换当前未提交；如需提交/MR，按 P0 边界先取得用户确认。
