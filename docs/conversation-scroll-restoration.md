# OpenCraft 会话滚动与恢复契约

日期：2026-08-30  
目标：固定会话滚动、恢复、跟随及跨平台适配的可观察行为。

## 结论

共享会话行为模型包括：倒置滚动坐标、独立的用户/系统滚动判定、Turn 级虚拟化、布局事务补偿、首帧恢复、流式 follow 状态机、新 Turn 放置动画、response spacer、Composer 高度补偿和分页历史装载均由同一套语义规则驱动。

以下常量、状态转移、时序和边界条件由共享 TypeScript 核心定义；Web 与 Expo 适配器拥有坐标、测量和动画执行。

## 共享模型

### 1. 滚动坐标和事件归因

Web 容器使用 `flex-direction: column-reverse`。浏览器中的 `scrollTop` 为负数，而业务层唯一坐标为：

```text
distanceFromBottom = max(0, -scrollTop)
```

它不是普通列表的 `scrollHeight - clientHeight - scrollTop`。这个选择让“尾部追加内容”和“保持离底距离”成为稳定原语。

滚动控制器不把每个 `scroll` 事件都当作用户操作。wheel、键盘、触摸和 scrollbar pointer 先生成一个带时间的方向样本；随后只有当物理距离变化方向与样本一致，且样本没有超过 1000ms，才广播 user-scroll。程序写入、内容重排和恢复产生的是 system-scroll。

这一区分直接控制流式回复是否继续跟随。把 system-scroll 错判为用户滚动，会随机退出 follow；把用户滚动错判为 system-scroll，则会出现“怎么也拉不住”的抢滚动。

### 2. 布局保持事务

内容高度即将变化时，控制器保存 `{distanceFromBottom, scrollHeight, wheelDelta}`，在下一帧读取新高度并写回距离。等待期间发生的 wheel delta 会累积进事务；如果浏览器提前发出 scroll，则先同步结算事务，再做用户/系统判定。

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

`positionTarget` 只接受稳定 `targetKey`，平台适配器负责解析和测量；精确目标未出现时保持 pending，取消返回 `cancelled`，目标不属于布局返回 `unavailable`，只有完成真实定位才返回 `positioned`。前一请求由 AbortSignal 明确取消，而不是被当作成功完成。

导航 Rail 还有一个 hydration 拓扑不变量：非权威 hydration 只能补充 label、item key 和 loaded 状态，不能增加、删除或重排 marker；只有 Prompt Index 的权威 mutation 可以改变拓扑。AppServer V3 只有轻量 Turn index，因此退化为“一 Turn 一 marker”；完整 V4 Prompt Index 才拥有 item 级 marker。这样首击 hydrate 不会让垂直居中的 Rail 改变高度，也不会使静止指针在第二次点击时命中另一个语义目标。

导航定位自身也是一个测量事务。数据层的 projection commit 只证明目标已经进入 Replica，不证明 React 已经提交对应 DOM；Web virtualizer 必须保持请求 pending，让目标 Turn 离屏挂载，读取真实 Turn/Item 几何，再执行唯一一次最终滚动。280px fallback 只可用于窗口枚举，不能作为 `positioned` 的成功条件。Top 对齐必须把 viewport 高度和顶部 inset 纳入同一个 inverted-distance 公式。

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

共享 follow 状态不是布尔值，而是四态：

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

折叠谓词为：只有“最终答复已开始、Turn 未取消、存在可渲染活动”同时成立时才允许折叠。允许折叠后，`forceExpanded` 优先；否则持久化用户选择优先；没有用户选择时，`preventAutoCollapse` 决定是否保持展开。Activity 尚在工作但没有 final answer 时不是“默认展开的可折叠区”，而是**根本不允许折叠**。

Activity 展开采用统一时序：`opacity 0 → 1`、`translateY(-8px) → 0`、220ms、`[0.33, 1, 0.68, 1]`；reduced motion 为 120ms。折叠选择以稳定 Activity ID 随 conversation restore snapshot 保存，虚拟列表卸载/重挂不会丢失。

## 差距与处理结果

| 行为面 | 本轮前的风险/差距 | 当前实现 |
| --- | --- | --- |
| 坐标系 | 正向列表容易在尾部追加时漂移 | Web 使用倒置物理模型；共享核心只暴露离底距离 |
| user/system scroll | 单纯依赖 `onScroll` 会把程序滚动当用户滚动 | wheel/key/touch/pointer 方向采样 + 1000ms 归因窗口 |
| 高度变化 | 单个测量后立即修 offset，会有连续跳动 | 批量测量、稳定 key 锚点和 next-frame 布局事务 |
| 历史 prepend | 新 entries 配旧 viewport 索引会把窗口渲染到视口外，长会话表现为白屏 | 在 render 内用旧窗口首个 Turn key 同步重定位新窗口 |
| 输入打断布局事务 | keyboard/pointer 接管后仍可能被下一帧拉回 | 清掉 pending preservation；wheel 保留并累加 delta |
| wheel preservation | 不可变 snapshot 更换对象后，预约帧误判事务已取消 | 预约帧读取当前 pending snapshot，保留 wheel 累积量 |
| 滚到底尾帧 | cubic 动画在 24px 内仍多跑一帧 | 进入物理 24px 阈值立即归零并结束动画 |
| 恢复 | 单 offset 恢复会先闪错窗口，且未测量高度导致偏移 | 高度表 + 窗口 + 距离 + follow 状态，双 rAF ready，误差重试 |
| 恢复被用户接管 | 首屏测量可在用户滚动后再次执行旧 restore | 用户滚动永久完成本轮 restore；恢复的 latest Turn 高度偏差大于 24px 时更新目标后重试 |
| latest Turn | “永远吸底”或“从不吸底”都不能表达既有策略 | 四态 reducer、300px placement 判断、用户拉离即降级 |
| 流式增长 | 普通 anchor 补偿与 follow 相互打架 | latest Turn active 时关闭普通锚点路径，走 follow 快路 |
| response spacer | 无 spacer 时新回复贴底，阅读重心不稳定 | 共享高度公式、Motion spring、交叉观察与只缩不涨 |
| spacer 观察降级 | 仅依赖 IntersectionObserver 会漏过部分到底状态 | 同时按每次 scroll 的 overflow 规则更新到底判定 |
| 单 Turn 渲染异常 | 一条损坏历史可冒泡到应用级错误边界并整页白屏 | 每个 Turn 独立 reset-key error boundary，可局部重试 |
| Composer resize | 输入框长高会覆盖或推动正文 | 实测 Footer +16；按契约条件补偿离底距离 |
| 历史分页 | 单次触顶加载可能仍不足一屏 | `<=64px` 循环装载和根/首子节点变化复检 |
| Resume 竞态 | painted cache 首屏可能在权威 Resume 前误触分页 | `authoritative` 成为 `hasOlder/loadOlder` 的硬门；缓存可画但不可提前读历史 |
| 定位 Turn 内 item | 只能定位 Turn 外框 | 支持 descendant rect 和 pending request 完成语义 |
| Expo | 普通 RN offset 与 Web 规则分叉 | 共用状态机/数学/快照；适配器只转换 RN 正向 offset |

## 当前源码对应关系

| 职责 | 当前实现 |
| --- | --- |
| 滚动常量、归一化、Footer 和输入方向 | [scroll.ts](../packages/timeline-virtualizer/src/scroll.ts) |
| imperative scroll、260ms cubic、布局事务 | [scroll-controller.ts](../packages/timeline-virtualizer/src/scroll-controller.ts) |
| follow reducer、placement、spacer、恢复归一 | [follow.ts](../packages/timeline-virtualizer/src/follow.ts) |
| Turn 布局、窗口、锚点、目标几何 | [virtualizer.ts](../packages/timeline-virtualizer/src/virtualizer.ts) |
| ResizeObserver 原子测量事务 | [measurement.ts](../packages/timeline-virtualizer/src/measurement.ts) |
| pending/settled 恢复状态机 | [restoration.ts](../packages/timeline-virtualizer/src/restoration.ts) |
| commentary/final answer 与 Agent Activity | [agent-activity.ts](../packages/chat-core/src/agent-activity.ts) |
| Web DOM 事件、观察器、Motion 和保存时序 | [conversation.tsx](../apps/workbench-web/src/components/conversation.tsx) |
| 单 Turn 错误隔离 | [turn-render-error-boundary.tsx](../apps/workbench-web/src/components/turn-render-error-boundary.tsx) |
| 倒置容器和 sticky Composer | [app.scss](../apps/workbench-web/src/styles/app.scss) |
| 发送前 placement 接线 | [app.tsx](../apps/workbench-web/src/app.tsx) |
| Expo ScrollView 坐标/测量适配 | [workbench-conversation.tsx](../apps/workbench-expo/src/components/workbench-conversation.tsx) |
| Expo Composer overlay 与共享 API | [workbench-frame.shared.tsx](../apps/workbench-expo/src/components/workbench-frame.shared.tsx) |

共享层拥有输入、状态转移、时序、滚动位置和动画语义；React 组件按现有包边界组织。

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

## 平台说明

Web 适配器使用负 `scrollTop`、DOM rect、ResizeObserver、IntersectionObserver 和共享 Motion spring。Expo/iOS 共用全部状态机、常量、恢复快照和虚拟化数学；`ScrollView` 使用正向 native offset，最终通过适配器换算成同一离底坐标。Native item 级定位由 measurement registry 把稳定 `targetKey` 映射为局部 geometry；能力尚未安装时必须返回 `unavailable`，不能假装 Turn 顶部就是目标，也不能把 DOM 接口泄漏进共享核心。

这一区别是平台能力映射，不是另建一套滚动策略。任何后续改动必须先进入共享行为测试，再分别通过 Web 与 Expo 构建门。

Imperative scroll commands sample the current platform distance at command start,
retain the 24px immediate-bottom threshold and 260ms cubic ease-out, and keep
confirmed-distance ownership separate from layout preservation.

## 滚动策略所有权

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
