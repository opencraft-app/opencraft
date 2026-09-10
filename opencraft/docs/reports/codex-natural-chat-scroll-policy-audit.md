# Codex 自然聊天滚动：策略选择与所有权复核

日期：2026-09-08。参考快照：`/data/mia/.runtime/lifecycle-authority-dead-contract-r3562`。

## 结论

此前把 r3562 的 `oO` response-placement 分支当成唯一聊天滚动策略，结论不完整。
原版通过 Statsig gate `1579719221` 选择两条不同路径。关闭开关时，原版已有
“自然发送、无需点击、正文增长时保持贴底”的路径；当前 Vela 始终挂载 response
策略，且运行中关闭虚拟列表的默认视口保持。这是策略选择/所有权层面的缺口。

源码证明存在两条路径；没有读取用户正在运行的 Codex 实例的 gate 值，不能宣称
其中一条是所有账户的默认配置或最新发行版的唯一行为。

## 原版调用链

以下函数均在 `lazy/app-initial/local-conversation-thread-CShhuS2f.js` 中：

1. `_k`：`W = gr('1579719221') && true`。`gr` 是 `Qh` 的导入别名。
   `features/shared/codex-micro-onboarding-component.ts:51` 的 `Qh` 从 Statsig
   `gateSignal` 读取开关，不是本地固定常量。
2. `_k` 把 W 作为 `isScrollToTopEnabled` 传给 `wk` 和 Composer。
3. `wk` 根据 `isScrollToTopEnabled` 选择：
   - true：`oO`，创建 response spacer、follow state 和新回答定位。
   - false：直接 `Um`（虚拟列表），`preserveMeasuredTurnViewport: true`。
4. false 路径没有挂载 `oO`，不消费它的 follow reducer，也不保留其 latestTurn
   restore state；`_k` 保存快照时同样用 W 决定是否保存 latestTurn 策略状态。
5. true 路径实际调用 `oO` 时 `synchronouslyMeasureLatestTurnUpdates: false`。
   原对照 fixture 写成了 true，本次改为默认 false，并保留显式环境开关用于历史对照。

## 两种模式的所有权

| 模式 | 活跃回复期间的视口决策者 | 内容增长时的行为 |
| --- | --- | --- |
| 自然贴底（gate false） | 虚拟列表测量事务 | 更新前已在底部，则把更新后的距离保持为 0；否则补偿阅读锚点 |
| 新回答定位（gate true） | response policy；虚拟列表不执行普通活跃 Turn 保持 | 根据 static / prework_watch / prework_follow / user_follow 决定 |

自然模式并不需要先生成一个 `user_follow` 状态。它由底层测量事务保留贴底。
`open-sources-side-panel-tab-CfgjOF5O.js` 的 `Ie` / `nt` 使用滚动控制器保存的距离：
`preserveMeasuredTurnViewport && Ge(distance, padding)` 成立时，输出距离为 0。
`Ge` 的阈值为无 response padding 时 24px，有 padding 时 0px。
不在底部时则补偿锚点下方增高，而不是把用户拉回最新内容。

因此关键不变量不是“正文增高后检查 DOM 还在不在底部”，而是测量事务要保留
变化前的贴底/阅读位置；内容变化本身不等于用户表达了离开底部的意图。

## response 模式为何停在开头

`OD` 的 `latest_turn_placed` 重置为 static。`prework_watch` 只在 prework 内容溢出时
自动转为 prework_follow；进入 final_answer 时，只有已经 prework_follow 才转为
user_follow，否则为 static。final_answer 自身变长不会自动取得跟随。

这解释了局部测试的 static，但不能据此否定用户所说的 Codex 自然聊天跟随：
自然模式走的是另一条分支。

## Vela 的缺口

`apps/workbench-web/src/components/conversation.tsx`：

- 提交定位调用 `latest_turn_placed`，挂载 spacer 和 response follow policy。
- 始终给虚拟列表传 `preserveMeasuredTurnViewport={!isLatestTurnInProgress}`。
- 没有对应的自然模式策略选择；“Turn 在运行”被当成了关闭普通视口保持的充分条件。

`packages/timeline-virtualizer/src/measurement.ts:180` 已经具备自然贴底所需的
`atBottom ? 0 : compensatedDistance`，并不是底层没有这项能力。
问题是其所有权在活跃 Turn 期间被无条件交给了 response policy。

不能仅把 preserve 改成 true，同时继续执行 response 定位、spacer 和补偿。
那会让父策略与子虚拟列表同时写滚动位置。需要由明确的呈现策略决定唯一执行者。
协议提供 Turn/Item 事实，不应由 Hermes 专属逻辑代替界面选择滚动策略。

## 无头验证

沿用抽取的原版函数体、正式 Vela Markdown renderer，真实 Chromium 时钟。
同一 Turn、同一个 assistant item，逐步增长到六篇 500 字正文（含标题共 3,078 字）。
初始化在底部；发送后没有按钮点击、滚轮或触控操作。

| 检查点 | 原版 gate-false 路径距离底部 | Vela 当前 response 路径 |
| --- | ---: | ---: |
| 首个 100 字 | 0px | 71px |
| 1,000 字 | 0px | 541px |
| 2,000 字 | 0px | 1,063px |
| 3,078 字，仍在生成 | 0px | 1,629px |
| 完成 | 0px | 1,667px |

原版 baseline 没有 response spacer；Vela 此例为 348px。数值依赖测试几何，
用于证明分支行为差异，不是对生产截图的像素测量。

命令（从 `/vela` 运行，按环境提供 Playwright/Chromium 路径）：

```sh
CODEX_SCROLL_ESSAYS=1 CODEX_SCROLL_RENDERER=production CODEX_SCROLL_REAL_CLOCK=1 CODEX_SCROLL_NATURAL_ONLY=1 CODEX_SCROLL_REFERENCE_POLICY=baseline npx tsx scripts/compare-codex-scroll.ts
```

该比较故意选择不同策略，不作 parity 断言。它运行原版滚动/虚拟列表函数，使用共享
Vela 行渲染，不是整个 Codex 应用，也没有向生产会话发送测试请求。

## 次要语义差异，不应混作滚动修复

Hermes bridge 的 `ensureAssistant` / `appendAssistant` 发出 `phase: null`。
原版 `AD` 和 Vela 滚动分类都将非 commentary 的非空正文视为 final_answer。
而 worked-for 的显示结束条件要求显式 final_answer，所以“Working for”仍显示
不能证明滚动策略仍处于 prework；原版的两种判定本身也不同。
不能为了触发 prework_follow 而把真正正文伪装成 commentary。

此外 Vela 分类额外要求正文非空，原版 AD 对空 agentMessage 已判 final_answer；
这需要另行收敛，但不是本次自然模式缺失的主要解释。

## 整改方向（本次仅审计，未实施）

1. 把自然贴底与新回答定位作为互斥的 viewport policy，不能靠两个同时运行的控制器抢写。
2. 自然聊天由现有虚拟列表保持底部/阅读锚点；不创建 response spacer，不按提交清除跟随。
3. 如保留回答开头定位，则按原版 response 模式独立接管，恢复数据也按策略隔离。
4. 验收必须包含未操作的自然长正文、主动上滚、滚回底部、完成、Composer 高度变化；
   不能再只验证点击按钮后的 user_follow。

## 进一步核对：核心是持续跟踪哪个目标

不能把本次问题简化为开关名称或没有注册 ResizeObserver。已沿原版实体观察链核对：

1. `Ie` 的 `ot` 创建同一个 ResizeObserver，区分 `turn` 与
   `latest-turn-follow-content` 两类元素。
2. Turn 高度进入批量测量 `Z(t)`；指定跟随内容的变化更新元素高度表，再由 `Be()`
   汇总高度和文档顺序最后一个元素的边界。内容变化不要求新增 Turn/消息。
3. 测量事务更新高度表、虚拟总高度和渲染窗口，再执行 `De(transaction)`。
   自然模式在测量前的受控距离处于底部时输出目标 0；阅读模式按增高量补偿锚点。
4. response 模式的 `oO` 接收最新 Turn 高度/跟随内容通知。user_follow 时滚到 0；
   static 时使用 `lO` 补偿增高量以固定阅读位置。static 不是“什么也不做”。

Vela 也在持续收到测量；复测记录如下：

| 正文字数 | Vela 累计最新 Turn 测量通知 | Vela 正文开头 y | Vela 距底部 | 原版自然路径距底部 |
| --- | ---: | ---: | ---: | ---: |
| 100 | 6 | 225px | 71px | 0px |
| 1,000 | 24 | 225px | 541px | 0px |
| 2,000 | 44 | 225px | 1,063px | 0px |
| 3,078 | 66 | 225px | 1,629px | 0px |

这些通知计数只来自候选侧的平台 owner，未把原版未注入的计数当作零通知。
Vela 的 mode 始终为 static：它追踪了增长，却维持了与用户意图不符的开头锚点。
`handleLatestTurnMeasurement` 中 static 被 `isViewportPreservingTurnFollowMode`
接纳，然后执行 `compensateHeightDelta`。与此同时，底层自然贴底决策被
`preserveMeasuredTurnViewport={!isLatestTurnInProgress}` 关闭。

应明确区分三个目标：底部跟踪、用户阅读锚点、新回答定位。生成状态和内容尺寸是
输入事实，不能自动取代跟踪目标的所有权；也不能把“正文变长后离底变远”反过来
当作用户主动退出跟随的证据。策略需选择一个目标，测量层负责持续执行它。
