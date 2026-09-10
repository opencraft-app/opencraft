# ChatUI 滚动策略选择与接管边界整改

日期：2026-09-08。参考：本地 r3562 快照，不推断运行中 Codex 的 Statsig 开关取值。

## 接线

本报告记录当时的自然模式选择；后续用户明确改选回答定位，当前决定见
[回答定位策略](codex-response-placement-selection.md)。以下为当时实现记录。

普通 Web 聊天显式选择 `scrollPolicy="natural"`。`Conversation` 也以此为默认值。
这是产品呈现策略，不从 provider、消息 phase 或 Turn 是否运行中推断。

对应原版 `wk` 的两条分支：

- 自然保持：直接挂载 `VirtualizedConversationTurns`，始终启用
  `preserveMeasuredTurnViewport`。不挂载回答定位组件，不创建 spacer/跟随状态，
  不消费发送定位快照，不注册最新回答补偿和 response restore 回调。
- 回答定位：单独挂载 `ResponsePositionedTurns`。该组件持有 follow reducer、
  最新回答身份、发送定位、MotionValue、spacer、回答恢复状态和测量响应；
  只有在这个分支中，运行中的 Turn 才关闭通用视口保持。

未新增第二套自然跟随状态机，没有将真实 final_answer 改成 commentary，
也没有添加定时强制滚底。

## 所有权

`Conversation` 保留共享的滚动布局、平台 owner、控制器、Composer、历史加载及导航。
控制器继续持有已确认距离；虚拟列表继续持有高度表、虚拟窗口和测量事务。
原有底层距离/测量算法没有重写。

初始距离由共享布局初始化；子回答策略不再重复初始化。父滚动容器的 ref 就绪
作为明确的宿主信号传给子策略，避免子 layout effect 先于祖先 ref 挂载时漏掉
首次 live mount。此信号不改变 Activity 身份，不增加第二条发送定位路径。

自然模式的发送 API 返回空定位快照；贴底按钮直接调用共享控制器。
回答定位模式才把这些操作委托给回答策略，并由该策略暂时关闭对应的 footer 补偿。
回答策略卸载只释放自身动效与 footer 禁用状态，不销毁平台 owner。

恢复时通用距离及虚拟列表 checkpoint 仍然共用；回答专属 `turnFollow` 只由回答
分支读取/产生。自然模式保存 `turnFollow: null`，不因存在旧回答状态而恢复该策略。

## 验证

- Web TypeScript 检查通过。
- LightVela Web 产品构建通过；产物只构建到本地，未发布。
- 虚拟列表、平台边界及用户消息呈现相关 105 个测试通过。
- Chromium 原版函数对照：自然模式 110 个事件检查点，稳定后距离、虚拟几何及
  阅读锚点与原版对应分支误差不超过 1px。涵盖：一个消息生成六篇 500 字正文、
  无操作贴底、真实滚轮上滚、点击可见贴底按钮、完成、Composer 变高/变矮，
  以及生成中恢复阅读位置/恢复底部。
- 自然模式最终运行中，正文增长检查点未测出帧差；唯一中间帧差异出现在点击
  贴底的动画阶段（最大 205px，稳定后 0px）。候选侧使用真实按钮点击，参考侧
  使用 API 调用，动画起始时刻未同步；这不是逐帧完全一致的验收结果。
- 回答定位对照：拆分后完整 141 点通过；宿主就绪处理补全后又跑了 34 点自然发送
  回归和独立 smoke。smoke 覆盖首次 live mount、连续发送一次消费、历史 DOM
  身份、spacer 复用、历史/最新回复增高、阅读恢复和超长 Turn 接管。
- smoke 出现 2 次短暂 ResizeObserver 通知告警，后续收敛，无空闲循环；没有声称
  消除了所有 ResizeObserver 告警。

对照运行抽取的原版控制器/虚拟列表/回答策略函数，行呈现使用共享 Vela renderer；
不是整个 Codex 应用的端到端复刻认证。未向生产会话发送测试消息，未部署。

主要文件：

- `apps/workbench-web/src/components/conversation.tsx`
- `apps/workbench-web/src/components/conversation/response-positioned-turns.tsx`
- `apps/workbench-web/src/components/conversation/virtualized-conversation-turns.tsx`
- `apps/workbench-web/src/app.tsx`
- `scripts/compare-codex-scroll.ts`

验证脚本环境：`CODEX_SCROLL_ESSAYS=1 CODEX_SCROLL_RENDERER=production
CODEX_SCROLL_REAL_CLOCK=1 CODEX_SCROLL_REFERENCE_POLICY=baseline` 配合
`npx tsx scripts/compare-codex-scroll.ts`；去掉最后一个变量验证回答定位分支。
另运行 `npx tsx scripts/smoke-conversation-scroll.ts`。
环境无默认 Chromium/Playwright 时需设置已有脚本支持的路径变量。
