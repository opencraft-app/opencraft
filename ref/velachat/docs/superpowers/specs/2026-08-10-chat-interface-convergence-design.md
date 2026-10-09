# 聊天界面统一收敛设计规格

## 1. 目标

本轮提升 VelaChat Web 聊天界面的身份辨识、阅读秩序与输入体验，同时清理私聊和 Channel 在消息展示上的隐式分叉。目标不是重做聊天，而是在现有稳定消息能力上建立一套克制、专业、可复用的会话视觉系统。

采用已确认的 A「克制语义」方向：身份在需要时明确表达，成功状态不抢正文注意力，消息流与输入区共享同一内容轴。

本轮目标：

- Human、Agent 与当前用户在消息流中稳定可辨。
- 私聊与 Channel 使用同一套消息行、分组、操作和布局代码。
- 所有消息统一左对齐；当前用户发言不再移动到右侧。
- Channel 降低重复的“未读 / 已发送”噪音，私聊保留有意义的已读状态。
- 桌面输入区使用现有最大宽度 token，并与消息阅读轴对齐。
- 组件和纯逻辑保持平台无关，为 Native 复用同一接口留出边界。

本轮不实现：

- 新消息协议、服务端身份字段或腾讯 IM 自定义字段。
- 大屏右侧 Thread / 搜索上下文面板重构。
- 新头像上传、图片裁剪或在线状态协议。
- 全局导航、频道目录或管理页视觉重做。

## 2. 统一会话模型

私聊和 Channel 不再通过消息方向切换两套排版。`MessageList` 始终使用同一个左对齐消息行：头像、发送者、时间、正文、操作区和状态区保持相同 DOM / React Native 结构。

会话差异收敛为显式能力配置，而不是散落的字符串判断：

```ts
interface ConversationCapabilities {
  deliveryReceipt: "none" | "direct";
  threads: boolean;
  tasks: boolean;
}
```

- Channel：`deliveryReceipt: "none"`，可按现有权限支持 Thread 与转 Task。
- 私聊：`deliveryReceipt: "direct"`，不显示 Thread 与转 Task。
- Thread：复用相同消息列表与身份规则，成功状态按 Channel 语义静默。

Thread 的能力固定为 `deliveryReceipt: "none"`、`threads: false`、`tasks: false`，避免在 Thread 内再次创建嵌套 Thread 或把回复直接转成 Task。Thread 根消息与回复都通过同一个内部 `ConversationMessageRow` 渲染；根消息可以由 Thread 容器提供“回复的开头”辅助文案，但不得保留另一套头像、发送者和正文结构。

`direction` 只用于判断消息是否由当前用户发出，以及发送、上传、失败和已读状态；它不再参与左右布局。

## 3. 身份组件边界

新增聊天内部的共享身份模型与展示组件：

```ts
type MessageActorKind = "agent" | "human" | "self" | "unknown";

interface MessageActorIdentity {
  kind: MessageActorKind;
  label: string;
  senderId: string;
}
```

身份由展示层使用已有数据解析：

1. `senderId === currentImUserId` 时解析为 `self`，头像和名称显示“我”。
2. 在成员 / Agent 数据中匹配到 Agent 时解析为 `agent`。
3. 匹配到 Human 时解析为 `human`。
4. 数据尚未同步或无法匹配时解析为 `unknown`，保留原发送者名称并使用安全的普通成员降级样式。

不得向 `Message` 领域模型写入 UI 专用身份字段。`WorkspaceShell` 负责把 `currentImUserId` 和可用参与者传入 `MessageStage`，消息列表内部以纯函数建立按 `imUserId` 索引的身份目录。

`MessageIdentityMark` 作为独立的小组件负责头像视觉和无障碍标签：

- Self：稳定深色底，字标“我”。
- Agent：使用现有 Agent 语义色和 Bot 图标，发送者名称旁显示克制的 `Agent` 标签。
- Human：保留基于 `senderId` 的稳定色阶和首字字标，不显示冗余 `Human` 标签。
- Unknown：使用中性表面和首字字标，不冒充 Agent 或当前用户。

主消息流与 Thread 使用同一身份解析函数和身份组件，不复制判断逻辑。

## 4. 消息状态规则

消息状态由纯 `messageStatusPresentation` 策略计算。完整输入包括 `delivery`、`receiptPolicy`、`isGroupTail`、`indexPending` 和可用的重试能力；输出是可辨别联合类型，组件只负责渲染。优先级固定为：失败 > 上传中 / 发送中 > 等待收录 > 私聊组尾回执 > 隐藏。

消息状态按失败优先、成功克制的原则呈现：

- 上传中：始终显示进度。
- 发送中：始终显示“发送中”。
- 失败：始终显示原因和可用的重试操作。
- Channel / Thread 发送成功：不常驻显示“已发送”“未读”或“已读”。
- 私聊发送成功：只在连续消息组的最后一条显示“已读 / 未读 / 已发送”。
- Thread 消息已发送但 `indexPending` 时显示“等待收录”，并连接现有重新收录操作；它不被成功静默规则吞掉。

消息分组需要同时计算组首和组尾：组首控制头像与发送者元信息，组尾控制私聊成功回执。发送中或失败状态不受组尾限制，确保用户能定位具体失败消息。

状态选择由纯函数完成，组件只渲染其结果，避免在两处 JSX 中重复条件分支。Thread 将现有通用 `retryMessage` 作为发送失败重试入口传给消息列表，并保留独立的 `retryThreadReplyIndex` 处理等待收录；只有回调真实存在时才渲染对应重试按钮，禁止绑定空函数制造无效操作。

## 5. 布局与交互

### 5.1 消息流

- 私聊与 Channel 全部左对齐。
- 当前用户依靠“我”的身份标记区分，不使用气泡右移。
- 保留现有消息最大阅读宽度、日期分隔、五分钟分组、引用、附件、Reaction、撤回、Thread 和转 Task 行为。
- 操作按钮继续在指针设备 hover / focus 时出现，触屏端继续使用长按和显式更多按钮。

### 5.2 输入区

- 桌面 Web 外层仍占据会话舞台宽度，以维持稳定底部布局；消息列表内容容器和内部编辑表面共享现有 `conversationWorkspace.composerDesktopMaxWidth`，同时居中。头像列、正文起始位置与 Composer 左边缘由同一个内容框架约束，而不是分别计算 margin。
- 编辑表面恢复完整边框与圆角，和页面底栏形成视觉区分；聚焦、拖入附件、禁用与失败反馈沿用 semantic tokens。
- 父容器显式向消息流和 Composer 传入 `surfaceMode: "desktop" | "compact" | "native"`。组件不得再用全局 `window.width` 猜测自己位于主舞台还是 Thread 侧栏；只有 `desktop` 使用最大宽度，`compact` 与 `native` 始终全宽。桌面 Thread 侧栏也使用 `compact`，避免按整个窗口误判。
- 引用、附件、@ 建议层和工具栏继续挂载在同一个 Composer 内部，不另起私聊版本。

## 6. 数据流与错误降级

```text
Workspace state
  ├─ currentImUserId
  ├─ members / agents
  ├─ conversation kind
  └─ messages
          ↓
ConversationCapabilities + identity directory
          ↓
MessageList / ThreadPanel
  ├─ shared MessageIdentityMark
  ├─ shared grouping and delivery policy
  └─ shared left-aligned ConversationMessageRow
          ↓
MessageComposer
  ├─ desktop bounded surface
  └─ compact/native full-width surface
```

- 参与者目录缺失或迟到时，消息必须正常渲染为 `unknown`，不得阻塞历史消息或闪退。
- 当前用户 ID 缺失时，不根据 `direction` 伪造“我”的身份；保留发送者名称并使用普通降级样式。
- 失败和重试行为保持现有消息 ID 绑定，不因视觉分组合并状态。
- 会话切换继续关闭已打开的消息操作菜单，并保留现有滚动锚定与虚拟列表行为。

## 7. 测试策略

按 TDD 增加以下回归：

- 纯身份解析：self、agent、human、unknown，以及成员数据缺失。
- 当前用户显示“我”，Agent 显示 Bot 语义标记与 `Agent` 标签，Human 不出现冗余标签。
- 私聊和 Channel 的本人消息都保持左对齐，并共享同一个消息行结构。
- Channel / Thread 成功消息不显示常驻回执；发送中、上传中和失败仍显示。
- 私聊仅在消息组末条显示已读回执；组内失败消息仍独立显示失败状态。
- 以表驱动方式覆盖 `failed`、uploading / sending、Thread `indexPending`、私聊组尾回执与隐藏成功态；同时覆盖可重试和不可重试失败。
- 桌面消息容器和 Composer 同时使用 `composerDesktopMaxWidth`，并断言正文起始轴一致；紧凑视口保持 `maxWidth: "100%"`。
- 桌面 Thread 侧栏显式使用 `compact`，Native 大宽度显式使用 `native`，二者都不得套用桌面最大宽度。
- Thread 根消息和回复复用 `ConversationMessageRow`、身份入口和状态策略，且 `threads/tasks` 能力均关闭。
- 现有消息列表虚拟化、滚动锚定、操作菜单、附件、引用、Reaction、撤回与 Composer 草稿测试全部保持通过。

完成后运行客户端完整 Jest、TypeScript 检查、Web export 和静态交付检查，并在 dep 实际宽屏与紧凑视口复查。

## 8. 完成标准

- 私聊本人消息不再右对齐，和 Channel 使用同一左对齐消息行。
- 主消息流和 Thread 不再复制身份与状态判断。
- Agent、Human、当前用户和未知身份均有稳定、可访问的视觉语义。
- Channel 成功状态安静，失败状态明确；私聊回执只出现在有意义的位置。
- 桌面输入区与消息阅读轴一致，紧凑端无布局回退。
- 不改变消息协议和服务端接口；全部新增行为有自动化回归并通过完整验证。
