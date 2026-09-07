# Codex ChatUI 滚动与恢复行为克隆审计

日期：2026-08-30  
目标：克隆 Codex Desktop ChatUI 的**可观察行为**；不复制其内部架构、压缩符号或文件命名。

## 结论

浏览器实现已经从“普通正向滚动列表 + 近似恢复”改成 Codex 的完整行为模型：倒置滚动坐标、独立的用户/系统滚动判定、Turn 级虚拟化、布局事务补偿、首帧恢复、流式 follow 状态机、新 Turn 放置动画、response spacer、Composer 高度补偿和分页历史装载均由同一套语义规则驱动。

这不是样式仿制。以下常量、状态转移、时序和边界条件均来自固定的原版恢复快照，并被写成平台无关的 TypeScript 核心；Web 适配器执行原版 DOM 行为，Expo 适配器只转换坐标、测量和动画执行端。

## 固定的原版证据

审计基线已固定到 `reference://codex/.runtime/partition-r1343-lifecycle-direct-import-v1`，较早的 r257/r312/r1329 不再作为行为权威。

| 原版模块 | 负责行为 | SHA-256 |
| --- | --- | --- |
| [thread-scroll-layout-xQ2_L08y.js](reference://codex/.runtime/partition-r1343-lifecycle-direct-import-v1/lazy/app-initial/thread-scroll-layout-xQ2_L08y.js) | 倒置滚动容器、输入来源、布局保持、Footer、历史装载 | `5f646eaaa0190189ee5d7120bb31466fdb86e49e8817d2e6002aa9111f83f190` |
| [open-sources-side-panel-tab-CfgjOF5O.js](reference://codex/.runtime/partition-r1343-lifecycle-direct-import-v1/lazy/app-initial/open-sources-side-panel-tab-CfgjOF5O.js) | `VirtualizedTurnList`、测量事务、恢复窗口、目标滚动 | `962c30d218119e93fc2585e3020885f2d370c449443d98e78509ad3e6c90af96` |
| [local-conversation-thread-CShhuS2f.js](reference://codex/.runtime/partition-r1343-lifecycle-direct-import-v1/lazy/app-initial/local-conversation-thread-CShhuS2f.js) | follow reducer、新 Turn placement、response spacer、持久化恢复 | `543f6739a018c55aa166032071f172c6bdf408175ac9566e6aae0f1e51d8935b` |
| [thread-virtualizer-D5BSbZuA.js](reference://codex/.runtime/partition-r1343-lifecycle-direct-import-v1/lazy/app-initial/thread-virtualizer-D5BSbZuA.js) | 虚拟窗口原语 | `c38373408eecfddc6b44f74a73167c02fa6ad228f214a740a78c9561b951e419` |
| [local-conversation-thread-turn-entries-BNYVWqua.js](reference://codex/.runtime/partition-r1343-lifecycle-direct-import-v1/lazy/app-initial/local-conversation-thread-turn-entries-BNYVWqua.js) | Turn entry 边界 | `4ea5f4f5560ff963d13643b8e70402f6718b75edf89fb43b6174ece8975b40e9` |
| [thread-scroll-controller-context-value-B_r__Jnq.js](reference://codex/.runtime/partition-r1343-lifecycle-direct-import-v1/lazy/app-initial/thread-scroll-controller-context-value-B_r__Jnq.js) | imperative scroll controller contract | `15d47c460c9d6b460a53529db6939c25f368b15317aae4d14bfc7329ae16da0b` |
| [local-conversation-turn-CaFyDx7G.js](reference://codex/.runtime/partition-r1343-lifecycle-direct-import-v1/lazy/app-initial/local-conversation-turn-CaFyDx7G.js) | Turn 分片、commentary/final answer、Activity 编排 | `2352867e2ad7f97246bda32959532f428ff22345a6da02e251719c468e2770d3` |
| [subagent-activity-chip-group-CC185tmV.js](reference://codex/.runtime/partition-r1343-lifecycle-direct-import-v1/lazy/app-initial/subagent-activity-chip-group-CC185tmV.js) | Agent Activity 折叠真值表 | `e5a9da5c6cd608d865eefbcf9356dcb16e54c1974a752c7718c1d5c616fd64fa` |

相关 source map 已检查：r1343 chunk 留有 `sourceMappingURL`，但对应 `.map` 不在产物中。因此分析依据是恢复树中的实际运行代码、模块闭包、独立 VM 执行与真实浏览器交叉验证，不是假定存在的上游 TypeScript。

## 原版模型

### 1. 滚动坐标和事件归因

Web 容器使用 `flex-direction: column-reverse`。浏览器中的 `scrollTop` 为负数，而业务层唯一坐标为：

```text
distanceFromBottom = max(0, -scrollTop)
```

它不是普通列表的 `scrollHeight - clientHeight - scrollTop`。这个选择让“尾部追加内容”和“保持离底距离”成为稳定原语。

原版不把每个 `scroll` 事件都当作用户操作。wheel、键盘、触摸和 scrollbar pointer 先生成一个带时间的方向样本；随后只有当物理距离变化方向与样本一致，且样本没有超过 1000ms，才广播 user-scroll。程序写入、内容重排和恢复产生的是 system-scroll。

这一区分直接控制流式回复是否继续跟随。把 system-scroll 错判为用户滚动，会随机退出 follow；把用户滚动错判为 system-scroll，则会出现“怎么也拉不住”的抢滚动。

### 2. 布局保持事务

内容高度即将变化时，原版保存 `{distanceFromBottom, scrollHeight, wheelDelta}`，在下一帧读取新高度并写回距离。等待期间发生的 wheel delta 会累积进事务；如果浏览器提前发出 scroll，则先同步结算事务，再做用户/系统判定。

因此历史插入、代码块展开、图片加载、工具卡高度变化都不会造成视口跳动，同时用户在那一帧里的滚轮意图也不会丢失。

### 3. Turn 级虚拟化

虚拟化单位是 Turn，不是 message/item：

- 未测量 Turn 高度：280px
- Turn 间距：12px
- overscan：上下各 2 个 Turn
- 未知视口回退：800px
- 顶部 inset：10px
- 初始高度表和窗口范围可恢复
- 内容 ready 要经过两次 `requestAnimationFrame`
- ResizeObserver 的一批高度变化作为一个事务处理
- 普通高度变化用稳定 entry-key 锚点补偿
- latest Turn 在 follow 中走直接尾随快路径

原版 `scrollToKey` 可由调用方提供 Turn 内后代 resolver，并按真实 DOM rect 定位；但 resolver 返回空时会静默退化到 Turn 顶部，这会把 hydrate 与精确定位错误地拆成两次点击。OpenCraft 不复制该缺陷：`positionTarget` 只接受稳定 `targetKey`，平台适配器负责解析和测量；精确目标未出现时保持 pending，取消返回 `cancelled`，目标不属于布局返回 `unavailable`，只有完成真实定位才返回 `positioned`。前一请求由 AbortSignal 明确取消，而不是被当作成功完成。

导航 Rail 还有一个 hydration 拓扑不变量：非权威 hydration 只能补充 label、item key 和 loaded 状态，不能增加、删除或重排 marker；只有 Prompt Index 的权威 mutation 可以改变拓扑。Codex V3 只有轻量 Turn index，因此退化为“一 Turn 一 marker”；完整 V4 Prompt Index 才拥有 item 级 marker。这样首击 hydrate 不会让垂直居中的 Rail 改变高度，也不会使静止指针在第二次点击时命中另一个语义目标。

导航定位自身也是一个测量事务。数据层的 projection commit 只证明目标已经进入 Replica，不证明 React 已经提交对应 DOM；Web virtualizer 必须保持请求 pending，让目标 Turn 离屏挂载，读取真实 Turn/Item 几何，再执行唯一一次最终滚动。280px fallback 只可用于窗口枚举，不能作为 `positioned` 的成功条件。Top 对齐必须把 viewport 高度和顶部 inset 纳入同一个 inverted-distance 公式。Codex 原实现首次 reveal 后直接返回、再次点击才走 `scrollIntoView`，这会形成两条不同的定位路径；OpenCraft 明确不保留这个缺陷。

完整事务为 `awaiting-projection → awaiting-render → measured → scrolling → settled`。Prepared Target 携带 Anchor identity、generation、per-target version 和 minimum Timeline revision：同 epoch 的无关追加不会取消它，目标替换或删除则会。Web 到达 minimum revision 后仍无法解析 Turn/Item 必须返回 `unavailable`，不得无限等待；source/thread 切换、下一次导航以及 wheel、touch、keyboard、pointer takeover 必须返回 `cancelled`。`smooth` 只有在平台滚动距离真实收敛后才能返回 `positioned`。Replica storage entity id 与语义 Anchor id 是两种身份，V4 Prompt Index 只按后者服务 UI，重复语义身份必须 fail closed。

布局还必须保持以下 DOM 不变量：scroll container 为 `column-reverse` 且关闭 `overflow-anchor`；surface 是覆盖视口的纵向 flex；content 是可增长的纵向 flex；virtualizer spacer 为固定总高度的 `relative shrink-0`；window 是以 `margin-top` 定位的纵向 flex。任一层丢失 `min-width: 0` 都会让长命令或错误文本撑宽布局，在浏览器中表现为横向溢出或错误测量。

ResizeObserver 回调不是“测到一个高度就 setState 一次”。一批记录必须同时产生新高度表、新全树 layout、新 viewport window 和唯一滚动决策。latest Turn 单项变化且 window 不变时，先同步写 spacer DOM 高度再提交 React；其他路径用 `flushSync`。这保证浏览器布局、React 状态和补偿距离不会短暂属于三个不同版本。

### 4. 恢复顺序

恢复不是只写一次 scroll offset：

1. 用持久化高度表和 Turn 窗口同步构造首屏。
2. 初始 `distance <= 24px` 归一为精确底部 `0`。
3. DOM 测量后重试目标距离，直到物理误差不超过 24px。
4. 两帧后才把内容标记为 ready，避免错误首帧闪现。
5. 仅在 conversation unmount 时保存高度窗口和 follow 状态，避免渲染过程中写入半完成快照。
6. 如果保存位置仍落在临时 response spacer 内，则恢复语义归一为真实内容底部，而不是恢复到一个下一次不存在的空白区域。

恢复实现是显式 `pending | settled` 状态机。`pending` 期间测量到视口下方高度变化会移动目标；进入 follow ownership、用户 wheel/key/touch/pointer 接管、没有目标或达到 24px 容差后永久 `settled`。这条“永久”约束防止后续 layout effect 在用户已经开始阅读后再次偷走视口。

### 5. 流式回复与最新 Turn 放置

原版 follow 状态不是布尔值，而是四态：

| 状态 | 语义 |
| --- | --- |
| `static` | 保持阅读位置，不跟随最新输出 |
| `prework_watch` | 观察 prework 是否开始溢出 |
| `prework_follow` | 只跟随 prework 输出 |
| `user_follow` | 用户明确位于底部，持续跟随最新输出 |

发送前会捕获 placement 快照。扣除已有 response spacer 后，离底不超过 300px 才把新 Turn 放到阅读区；否则保留原位置，避免用户正在读旧内容时被强行拉回。

可放置时，底部插入 response spacer：

```text
available = viewportHeight - composerPadding
maxSpacer = max(0, min(available * 2/3, available - 240))
```

latest Turn offset 与 spacer 使用 Motion `type: spring, bounce: 0, duration: 0.5` 进入；IntersectionObserver 以 0.01 为步长观察 spacer，用户阅读和窗口变化时只允许它缩小。Motion 的固定版本证据为 `12.38.0`。

### 6. Composer 与历史边界

- Footer padding 是实测 Composer 高度 `+16px`。
- 用户不在底部、且没有动画或显式禁止补偿时，Composer 高度差会加到离底距离，内容视觉位置不动。
- 距顶部 `<=64px` 时加载更早历史，并在仍不足一屏时重复请求，直到越过阈值、后端返回 stop 或高度不再变化。
- wheel `deltaMode=line` 乘 16；`page` 乘视口高度。
- touch 垂直位移超过 8px 才建立方向；横向手势不参与。

### 7. Agent Activity 渲染语义

`commentary`、reasoning、command、patch、tool 和 subagent 属于 Agent Activity；`final_answer` 是独立 assistant content。最终答复之后出现的活动保持原始顺序，但作为 post-assistant slice 展开显示，不被前面的 Activity 吞掉。

Frame 不拥有 Activity 或 Thinking。协议投影为了保留来源和交互边界，可以在同一个 Turn 中产生多个 assistant Frame；呈现层必须先把完整 Turn 折叠成一个稳定的 assistant surface，再生成 Activity、final answer 与瞬态 placeholder。Web 和 Expo 都不得从单个 Frame 的复制状态自行推导 live chrome。只有虚拟列表中的最新 Turn 能拥有 Thinking，pending interaction 则由 Composer-owned request surface 接管等待状态。

原版的折叠谓词已经逐布尔值恢复：只有“最终答复已开始、Turn 未取消、存在可渲染活动”同时成立时才允许折叠。允许折叠后，`forceExpanded` 优先；否则持久化用户选择优先；没有用户选择时，`preventAutoCollapse` 决定是否保持展开。Activity 尚在工作但没有 final answer 时不是“默认展开的可折叠区”，而是**根本不允许折叠**。

Activity 展开采用原版可见时序：`opacity 0 → 1`、`translateY(-8px) → 0`、220ms、`[0.33, 1, 0.68, 1]`；reduced motion 为 120ms。折叠选择以稳定 Activity ID 随 conversation restore snapshot 保存，虚拟列表卸载/重挂不会丢失。

## 差距与处理结果

| 行为面 | 本轮前的风险/差距 | 当前实现 |
| --- | --- | --- |
| 坐标系 | 正向列表容易在尾部追加时漂移 | Web 使用原版倒置物理模型；共享核心只暴露离底距离 |
| user/system scroll | 单纯依赖 `onScroll` 会把程序滚动当用户滚动 | wheel/key/touch/pointer 方向采样 + 1000ms 归因窗口 |
| 高度变化 | 单个测量后立即修 offset，会有连续跳动 | 批量测量、稳定 key 锚点和 next-frame 布局事务 |
| 历史 prepend | 新 entries 配旧 viewport 索引会把窗口渲染到视口外，长会话表现为白屏 | 与原版一致，在 render 内用旧窗口首个 Turn key 同步重定位新窗口 |
| 输入打断布局事务 | keyboard/pointer 接管后仍可能被下一帧拉回 | 与原版一致清掉 pending preservation；wheel 保留并累加 delta |
| wheel preservation | 不可变 snapshot 更换对象后，预约帧误判事务已取消 | 预约帧读取当前 pending snapshot，保留 wheel 累积量 |
| 滚到底尾帧 | cubic 动画在 24px 内仍多跑一帧 | 进入物理 24px 阈值立即归零并结束动画 |
| 恢复 | 单 offset 恢复会先闪错窗口，且未测量高度导致偏移 | 高度表 + 窗口 + 距离 + follow 状态，双 rAF ready，误差重试 |
| 恢复被用户接管 | 首屏测量可在用户滚动后再次执行旧 restore | 用户滚动永久完成本轮 restore；恢复的 latest Turn 高度偏差大于 24px 时更新目标后重试 |
| latest Turn | “永远吸底”或“从不吸底”都不符合原版 | 四态 reducer、300px placement 判断、用户拉离即降级 |
| 流式增长 | 普通 anchor 补偿与 follow 相互打架 | latest Turn active 时关闭普通锚点路径，走 follow 快路 |
| response spacer | 无 spacer 时新回复贴底，阅读重心不稳定 | 原版高度公式、Motion spring、交叉观察与只缩不涨 |
| spacer 观察降级 | 仅依赖 IntersectionObserver 会漏过部分到底状态 | 同时按每次 scroll 的 overflow 规则更新到底判定 |
| 单 Turn 渲染异常 | 一条损坏历史可冒泡到应用级错误边界并整页白屏 | 每个 Turn 独立 reset-key error boundary，可局部重试 |
| Composer resize | 输入框长高会覆盖或推动正文 | 实测 Footer +16；按原条件补偿离底距离 |
| 历史分页 | 单次触顶加载可能仍不足一屏 | `<=64px` 循环装载和根/首子节点变化复检 |
| Resume 竞态 | painted cache 首屏可能在权威 Resume 前误触分页 | `authoritative` 成为 `hasOlder/loadOlder` 的硬门；缓存可画但不可提前读历史 |
| 定位 Turn 内 item | 只能定位 Turn 外框 | 支持 descendant rect 和 pending request 完成语义 |
| Expo | 普通 RN offset 与 Web 规则分叉 | 共用状态机/数学/快照；适配器只转换 RN 正向 offset |

## 当前源码对应关系

| 原版职责 | 我们的实现 |
| --- | --- |
| 滚动常量、归一化、Footer 和输入方向 | [scroll.ts](/vela/packages/timeline-virtualizer/src/scroll.ts:3) |
| imperative scroll、260ms cubic、布局事务 | [scroll-controller.ts](/vela/packages/timeline-virtualizer/src/scroll-controller.ts:39) |
| follow reducer、placement、spacer、恢复归一 | [follow.ts](/vela/packages/timeline-virtualizer/src/follow.ts:65) |
| Turn 布局、窗口、锚点、目标几何 | [virtualizer.ts](/vela/packages/timeline-virtualizer/src/virtualizer.ts:1) |
| ResizeObserver 原子测量事务 | [measurement.ts](/vela/packages/timeline-virtualizer/src/measurement.ts:1) |
| pending/settled 恢复状态机 | [restoration.ts](/vela/packages/timeline-virtualizer/src/restoration.ts:1) |
| commentary/final answer 与 Agent Activity | [agent-activity.ts](/vela/packages/chat-core/src/agent-activity.ts:1) |
| Web DOM 事件、观察器、Motion 和保存时序 | [conversation.tsx](/vela/apps/workbench-web/src/components/conversation.tsx:251) |
| 单 Turn 错误隔离 | [turn-render-error-boundary.tsx](/vela/apps/workbench-web/src/components/turn-render-error-boundary.tsx:1) |
| 倒置容器和 sticky Composer | [app.scss](/vela/apps/workbench-web/src/styles/app.scss:745) |
| 发送前 placement 接线 | [app.tsx](/vela/apps/workbench-web/src/app.tsx:141) |
| Expo ScrollView 坐标/测量适配 | [workbench-conversation.tsx](/vela/apps/workbench-expo/src/components/workbench-conversation.tsx:233) |
| Expo Composer overlay 与共享 API | [workbench-frame.shared.tsx](/vela/apps/workbench-expo/src/components/workbench-frame.shared.tsx:1) |

命名有意语义化，例如 `TurnScrollController`、`TurnFollowState`，没有复制恢复产物里的短符号。React 组件层级也按 OpenCraft 的包边界组织；克隆边界是输入、状态转移、时序、滚动位置和可见动画，而不是 Codex 内部依赖图。

## 可执行验收契约

逻辑测试覆盖：

- 24/64/300px 三个临界值及上下边界
- wheel line/page 归一、键盘、touch 阈值与方向过期
- next-frame 布局保持、等待期间 wheel 累积、提前 scroll 同步结算
- 直接 imperative scroll 取消旧事务，并采用平台实际 clamp 后的距离
- Footer resize 的补偿允许/禁止条件
- 虚拟窗口、重复 key、测量事务、稳定 anchor 和后代目标
- 2000 条历史 prepend 时，在 viewport state 提交前同步保持原 Turn render window
- 四态 follow 的完整转移
- placement、response spacer 上限和恢复归一
- 会话切换后的快照 round-trip
- Agent Activity 折叠真值表、post-assistant 顺序和披露状态持久化
- painted cache 到 authoritative Resume 之间不会提前触发历史分页

此外，[外部行为差分器](/data/wbwell/fixtures/codex-chat-behavior/README.md:1) 不导入 Codex 应用或 OpenCraft 应用：它从固定 r1343 chunk 中按函数边界抽取原实现，在独立 `node:vm` 中执行；另一侧把 OpenCraft TypeScript 内存转译为 JavaScript 后放入另一套 VM。当前固定 seed 共比较 41,706 个结果，覆盖 19 个行为族和 4 条完整 scroll-controller 时序，包括 Agent Activity 的完整折叠真值表；报告为 [codex-chat-behavior-diff.json](/data/wbwell/reports/codex-chat-behavior-diff.json:1)。原版五个 VM 输入 chunk 的 SHA-256 被固定，任一来源漂移会在执行前失败。

浏览器验收还要求：无运行时异常、Composer 高度变化不跳、流式时用户可拉离、重新点底部继续 follow、旧历史插入不跳、新 Turn 在阈值外不抢位置。当前真实 9988 长会话门在 0、1000、5000、15000、30000、44000px 六个离底位置均命中可见 Turn，挂载窗口保持 3～7 行；Activity 展开和 15000px 阅读位置跨路由恢复后保持不变。

## 平台说明

Web 是原版运行环境，因此可直接复现负 `scrollTop`、DOM rect、ResizeObserver、IntersectionObserver 和原版 Motion spring。Expo/iOS 共用全部状态机、常量、恢复快照和虚拟化数学；`ScrollView` 使用正向 native offset，最终通过适配器换算成同一离底坐标。Native item 级定位由 measurement registry 把稳定 `targetKey` 映射为局部 geometry；能力尚未安装时必须返回 `unavailable`，不能假装 Turn 顶部就是目标，也不能把 DOM 接口泄漏进共享核心。

这一区别是平台能力映射，不是另建一套滚动策略。任何后续改动必须先进入共享行为测试，再分别通过 Web 与 Expo 构建门。
