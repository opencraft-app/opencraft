# 一体化消息 Composer 设计规格

## 1. 目标

本轮将 VelaChat Web 的消息输入区收敛为接近 Codex 的一体化 Composer：编辑区、附件、引用、快捷操作和发送按钮属于同一个连续表面，不再呈现为“输入框加一条工具栏”的拼装结构。

采用已确认的 A 方案：桌面默认高度约 112px，随内容增长至约 220px，超过后仅编辑区域内部滚动。桌面继续与消息流共享 860px 内容轴；紧凑 Web 与 Native 继续全宽。

本轮目标：

- 建立单一圆角材质面，移除编辑区与 footer 之间的分隔线。
- 让空白、短文本、多行文本、引用、附件、@ 建议和错误状态保持稳定布局。
- 把布局外壳控件化，业务状态、编辑器实现和平台材质分开。
- 首先交付 Web 视觉与交互，同时保留 Native 替换材质和编辑器实现的明确边界。
- 沿用现有 Composer 文档、草稿、附件、提及和提交协议，不引入 HeroUI 或其他 UI 依赖。

本轮不实现：

- 模型、推理强度、权限、语音、工作树等 Codex 专属业务控件。
- 新附件协议、上传协议、富文本协议或消息发送 API。
- Native 的最终视觉精修；Native 只保证共享结构和契约不被 Web 实现锁死。
- Composer 之外的聊天导航、消息卡片或 Thread 布局重做。

## 2. 参考实现结论

### 2.1 velalink

`velalink` 的成熟实现采用以下职责边界：

```text
ConversationComposer
  ├─ ComposerStage               最大宽度与浮层锚点
  ├─ VelaMaterialSurface         Web / Native 材质边界
  ├─ VelaComposerEditor          Web / Native 编辑器边界
  ├─ attachments                 输入内容的一部分
  └─ toolbar                     无分隔线的底部操作区
```

提交命令、Composer 文档和建议状态分别位于独立的纯逻辑模块。Web 编辑器直接使用 Lexical；Native 通过 DOM 容器桥接，但对上层暴露相同的 `document / snapshot / requestSubmit / replaceDocument` 契约。

VelaChat 已经具备相同的 `ComposerEditor.web.tsx` / `ComposerEditor.native.tsx` 边界，因此本轮不替换编辑器，只补齐 Stage、Surface 和内部 slot 的控件层次。

### 2.2 Codex App

当前桌面应用 ASAR 中的 Composer 使用单一 `composer-surface-chrome`，关键规律是：

- Surface 是纵向 flex 容器，编辑区和 footer 不各自绘制边框。
- 多行态拥有统一的大圆角和内部滚动；单行态才退化为胶囊形。
- 附件的圆角由外壳圆角减去内缩量得到，视觉上与外壳同心。
- Footer 使用 grid / flex slot，而不是把所有按钮堆进一个无语义数组。
- Footer 通过容器宽度隐藏次要文字，不依赖全局窗口宽度。
- 点击 Surface 内的非交互空白会把焦点送回编辑器。

本轮只采用这些通用结构和交互原则，不复制 Codex 的私有业务、埋点、状态库或具体类名。

## 3. 组件边界

### 3.1 MessageComposer

`MessageComposer` 继续持有产品状态和行为：

- 外部草稿同步与本地快照。
- 附件数量、大小校验和错误信息。
- @ 触发器、候选过滤与键盘选择。
- 引用信息。
- 发送去重、清空与 `onSend`。

它不再直接拥有桌面材质、边框、阴影和 footer 布局细节。

### 3.2 ComposerStage

新增共享的 `ComposerStage`，负责：

- `width: 100%`。
- 桌面 `maxWidth: composerDesktopMaxWidth` 并居中。
- compact / native 全宽。
- 为 @ 建议层提供唯一的 `position: relative` 与层级锚点。
- 保存现有 `message-composer` 测试入口。

`MessageComposer` 不再在多个 style 分支里重复计算宽度。

### 3.3 ComposerMaterialSurface

新增平台可替换的 `ComposerMaterialSurface` 契约：

```ts
interface ComposerMaterialSurfaceProps {
  children: ReactNode;
  disabled?: boolean;
  onPressBackground?(): void;
  surfaceMode: "desktop" | "compact" | "native";
  testID?: string;
}
```

- Web 实现负责圆角、边框、背景、轻阴影、hover / focus-within 反馈，以及点击非交互空白后聚焦编辑器。
- Native 实现先使用等价的 React Native View / Pressable 材质和现有 semantic tokens；后续可独立增加原生阴影、键盘避让或触觉反馈。
- 两端不得复制草稿、附件、提及或提交逻辑。

### 3.4 Surface 内部 slot

Surface 内部顺序固定为：

```text
Quote slot（可选）
Attachment slot（可选）
Editor slot（可增长）
Error slot（可选）
Footer slot（稳定贴底）
```

Footer 内部使用三个语义区域：

```text
leading actions | expanding space / future controls | primary action
```

首轮 leading actions 为文件、图片、@；primary action 为发送。未来增加语音、权限或模型控件时只能进入对应 slot，不允许再次在 Surface 外添加第二条工具栏。

## 4. 视觉与尺寸

### 4.1 桌面静止态

- 最大宽度沿用 `conversationWorkspace.composerDesktopMaxWidth = 860`。
- 文本为空时，完整 Surface 最小高度为 112px 左右。
- 圆角采用 Composer 专用 recipe，目标 22–24px；不把全局 section 圆角放大。
- 边框使用 `borderControl` 的 1px 克制描边。
- 背景使用 `paneSurface`；阴影使用现有 `floatingControl` 的低层级语义，禁止强浮层阴影。
- 外部保留现有 16px 水平和约 12px 垂直留白，与消息内容轴对齐。

### 4.2 编辑区增长

- 编辑器背景透明，外壳独占背景和边框。
- 空白 / 单行时编辑区域约 56–64px，给 placeholder 足够呼吸空间。
- 文本增长时 Surface 总高度平滑增长，文本态上限约 220px。
- 到达上限后，只有编辑器内容滚动；footer、发送按钮和附件操作保持可见。
- 计算以 footer 实际最小高度为基准，避免把“220px”分别硬编码进 Surface 和 Editor。
- 引用或附件存在时，它们占用独立 slot；编辑器仍遵守自己的最小高度，整个 Composer 由会话可用高度约束，不挤压按钮触达面积。

### 4.3 Footer

- 删除 `borderTopWidth`，用空间和对齐形成层次。
- footer 最小高度沿用密度 token：指针设备约 40px，触屏约 52px。
- 左侧图标按钮默认透明，只在 hover / pressed / selected 时出现语义底色。
- 发送按钮保持圆形主操作，指针端约 32px，触屏端使用现有可触达尺寸。
- 禁用发送按钮保持可辨但不抢眼；只有存在文本或附件时进入主色。
- footer 自己形成容器查询边界；窄宽度时优先隐藏未来的文字标签，再压缩间距，绝不隐藏发送按钮。

### 4.4 引用、附件、错误和建议层

- 引用块位于 Surface 顶部内侧，使用轻微内嵌表面和左侧语义强调，不另画完整外框。
- 附件卡片与外壳保持同心圆角：卡片圆角小于 Surface 圆角，间距固定为 8px。
- 错误文案放在 editor 与 footer 之间，保留危险色并避免推动浮层锚点到错误位置。
- @ 建议层仍浮在 Surface 上方，由 Stage 锚定；其 bottom offset 根据 Composer 当前布局计算，不再只假设静止最小高度。
- 建议层打开时，@ 按钮进入 selected 状态；关闭后立即恢复。

## 5. 交互与状态

- 点击 Surface 内非按钮、非附件、非建议项的空白区域，聚焦 `ComposerEditor`。
- `Enter` / 组合输入 / @ 候选键盘行为继续由编辑器处理，本轮不改变快捷键合同。
- 发送中继续由 `submitPending` 阻止重复提交；发送按钮不得因为异步回调而触发两次。
- 附件、图片和 @ 操作在 `disabled` 时不可触发，并保留可访问名称。
- 发送失败的现有上层行为不变；本轮只处理 Composer 本地校验错误的稳定位置。
- 动效仅用于 hover、focus、pressed 和高度变化；遵守 reduced-motion，不做弹跳或装饰性位移。

## 6. Token 收敛

在 `conversationWorkspace` recipe 下新增或改名为明确用途的 token：

- `composerDesktopMinHeight`：桌面静止态完整高度，约 112。
- `composerDesktopMaxHeight`：纯文本增长后的完整高度，约 220。
- `composerEditorMinHeight`：由静止态减去 footer 与内边距得到。
- `composerEditorMaxHeight`：由最大态减去 footer 与内边距得到。
- `composerSurfaceRadius`：Composer 专用 22–24px 圆角。
- `composerAttachmentInset`：附件与外壳的同心内缩，8px。

保留 `composerDesktopMaxWidth`、`composerToolbarMinHeight` 和现有密度分叉。废弃含义模糊、同时被当作编辑器和完整 Surface 高度使用的 token；迁移测试后再删除，禁止保留两套相互覆盖的魔法数字。

## 7. 响应式与 Native 边界

- `surfaceMode` 继续由父级显式传入；Composer 不根据全局 `window.width` 猜测 Thread 或主舞台。
- desktop：860px 居中、完整圆角、轻阴影、112–220px 自适应。
- compact Web：全宽、一体化结构不变；允许减小圆角和外边距，触达尺寸不减。
- native：复用 slot 顺序、状态合同和 semantic tokens；材质与编辑器通过 `.native.tsx` 独立实现。
- Thread 侧栏使用 compact，不因桌面大窗口误套 860px 桌面尺寸。
- 任何 Web 专属 DOM 属性、focus-within 或容器查询必须留在 `.web.tsx`，不得进入共享业务组件。

## 8. 测试策略

按 TDD 增加以下回归：

- desktop Surface 使用共享 860px 内容轴、Composer 专用圆角和约 112px 静止高度。
- compact / native 仍为全宽，并使用同一个 slot 顺序。
- footer 无顶部分隔线，leading actions 与 primary action 都位于同一 Surface。
- 空文本、单行和多行分别落在 editor 最小高度、增长态和最大高度；超过上限时 Editor 内部滚动。
- 点击 Surface 非交互空白会聚焦编辑器，点击附件按钮、移除按钮或发送按钮不会被焦点转发吞掉。
- 文件、图片、@、引用、附件移除、发送、禁用和本地错误行为保持通过。
- @ 建议层由 Stage 锚定，键盘接受、上下移动和 Escape 关闭保持通过。
- Web / Native 模块导出同一 `ComposerMaterialSurfaceProps` 契约。
- token usage 与 style lint 更新后，不出现直接颜色、重复尺寸或废弃 token。

完成后运行 Composer 单测、客户端完整 Jest、TypeScript 检查、Web export 和静态交付检查，并在 dep 以桌面宽屏、窄侧栏和紧凑视口实际复查。

## 9. 完成标准

- 用户第一眼看到的是一个完整输入控件，不再是被横线切开的编辑器和工具栏。
- 桌面空白态约 112px，多行文本增长至约 220px 后内部滚动。
- 所有现有输入能力位于一个 Surface 内，且发送按钮始终稳定可达。
- `MessageComposer` 业务逻辑与 Web 材质实现分离，Native 可替换实现而无需复制状态机。
- 不新增 UI 框架依赖，不改变消息协议和后端接口。
- 自动化测试、构建和 dep 实际页面验证全部通过。
