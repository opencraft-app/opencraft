# Tahoe 控件系统统一收敛设计规格

## 1. 目标

本轮把 VelaChat 从“局部具有 macOS Tahoe 质感”收敛为一套完整、可复用、可跨 Web / Native 替换渲染实现的控件系统。Composer 继续作为材料、几何与交互质量基准；窗口导航、工具栏、表单、分段选择、菜单、弹层、反馈和空状态使用同一套语义边界，不再由页面临时拼接 `Pressable`、白色卡片和状态横幅。

采用已确认的基础控件先行方案，迁移顺序为：

1. 建立材料、按钮、选择、菜单、Dialog 和反馈语义。
2. 收敛 App Frame、Rail、Sidebar 与 Toolbar。
3. 迁移 Agents、Computers、Members、Tasks、Settings 管理页。
4. 统一弹层、错误、成功、空状态和 Compact 交互。
5. 把 Channel create/edit/member management 同步迁入同一套选择、Dialog 和反馈控件。
6. 保持 Web 优先交付，同时让 Native 只替换渲染层，不复制业务状态。

本轮不做：

- 在普通内容卡片和字段上滥用毛玻璃。
- 在 Web 页面伪造 macOS 交通灯；Electron / Native 宿主负责真实标题栏。
- 改变聊天、成员、任务、邀请、Computer 或 Agent 的后端协议。
- 引入 HeroUI 或另一套 UI 框架与现有 React Native / Unistyles 体系并存。

## 2. 设计原则

### 2.1 三层材料，而不是全站 Glass

界面只有三个材料层级。`layer` 是合成规则，`role` 是组件用途；两者不得混用：

- `navigation`：Rail、Sidebar、Compact navigation。允许连续半透明和背景模糊。
- `content`：消息、表单、设置列表、终端。使用稳定、不透明的内容面，保证阅读与性能。
- `overlay`：Popover、Menu、Dialog、Composer 等悬浮控件。允许更高不透明度、模糊、hairline 和受控阴影。

规范映射如下：

| Component role | Material layer | Backdrop owner | 规则 |
| --- | --- | --- | --- |
| `navigationChrome` | navigation | `PlatformFrame` 的单一外层 | Rail 与 Sidebar 是同一个 backdrop-filter 元素的内部区域，子区域只画 fill / separator |
| `compactNavigation` | navigation | Compact navigation 根节点 | 不与 desktop navigation 同时挂载 |
| `content` | content | 无 backdrop owner | 始终不透明，不使用 blur |
| `toolbar` | navigation 或 content | 无独立 backdrop | 继承所在 navigation/content surface，只画 separator |
| `popover` / `menu` | overlay | 各 active overlay 根节点 | 一个 overlay 只允许一个 backdrop-filter 元素 |
| `dialog` | overlay | Dialog panel | Backdrop scrim 不 blur，只有 panel 可使用 overlay material |
| `floatingControl` | overlay | 控件自身 | 适用于有限面积悬浮控件 |
| `composer` | overlay | Composer surface | `floatingControl` 的专用几何和 slot 组合，不是第四个 layer |

`content` 仍是 `SystemMaterialSurface` 的合法 role，用于统一 light/dark 和边框，但其实现永远不启用 backdrop filter。任何已位于 backdrop owner 内的子组件都不得再次创建 backdrop；开发态守卫会扫描 UI 页面中的 `backdropFilter`，只允许材料实现文件出现。

普通字段、列表行、设置 section 不得使用 overlay blur。Web 的 `backdrop-filter` 只能出现在材料组件内部，Native 的 blur / vibrancy 只能出现在平台实现内部。

### 2.2 控件按语义区分

“重要程度”不是业务页面可自由选择的控件轴。系统需要明确区分：

- Standard button：所有普通文字动作，包括创建、保存、继续、接受、重试和非危险确认；使用中性表面。
- Toolbar button：工具栏中的文字或图标操作，默认无边框或使用共享控制组。
- Destructive button：危险动作；Dialog 中只有确认危险动作进入强调色。
- Icon button：无文字的局部操作。
- Menu item：弹层列表动作，支持选中、危险、禁用和快捷键提示。
- Source-list row：导航与资源选择，使用无边框行和中性选中面。

所有控件共享 focus、disabled、hover、pressed、motion 和密度合同，但不强制共享外观。

### 2.3 精确几何

pointer 密度遵循 macOS 邻近尺寸：

- Push button：30px。
- Field：32px。
- Toolbar action：28px。
- 单行 source-list row：32px；双行资源行：44px。
- Popover / Dialog 圆角：14px；普通控件圆角：6–7px。

控件外框使用明确 `height` 和 `boxSizing: border-box`；不得再用 `minHeight + lineHeight + vertical padding` 偶然长出不同高度。touch 密度继续保留 44px 以上可触达面积，视觉图标尺寸和 hit target 分离。

## 3. 组件边界

### 3.1 SystemMaterialSurface

```ts
type SystemMaterialRole =
  | "navigationChrome"
  | "compactNavigation"
  | "content"
  | "toolbar"
  | "popover"
  | "dialog"
  | "floatingControl"
  | "composer";

interface SystemMaterialSurfaceProps {
  children: ReactNode;
  materialRole: SystemMaterialRole;
  testID?: string;
}
```

`materialRole` 只选择视觉材料，`variant` / `intent` 只选择控件外观；它们不得透传为 DOM/RN 的 `role`。`role`、`accessibilityRole` 和 `aria-*` 永远只表达无障碍语义。

共享文件只声明 props 和结构；`.web.tsx` 使用 translucent fill、`backdrop-filter`、Web 阴影和高对比度降级；`.native.tsx` 首轮使用稳定 semantic surface，后续可接平台 blur。业务页面不能直接设置 backdrop blur。

### 3.2 SystemButton 与 SystemIconButton

```ts
type SystemButtonVariant =
  | "standard"
  | "toolbar"
  | "destructive";

interface SystemButtonProps {
  accessibilityLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  label: string;
  nativeID?: string;
  onPress(): void;
  variant?: SystemButtonVariant;
  submit?: boolean;
}

interface SystemIconButtonProps {
  accessibilityLabel: string;
  busy?: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  onPress(): void;
  variant?: "toolbar" | "secondary" | "destructive";
}
```

普通文字按钮默认渲染为 `standard`。业务页面不得请求 filled accent 或 tonal accent；创建、保存、继续、接受、重试和普通确认均使用同一个中性模型。`destructive` 只表达危险后果，`toolbar` 只表达所处 chrome。强调蓝仅保留给选择态、进度、开关和 Composer 发送状态，不属于通用文字按钮 API。

Web 上 `submit=false` 默认渲染 `type="button"`，只有显式 `submit` 才是 `type="submit"`。`busy` 同时设置 `aria-busy`、禁止重复触发并保留原 label 尺寸；`disabled` 和 `busy` 均不能只靠 opacity 表达。Icon-only 永远要求 accessibility label。危险强调可用于不可逆页面动作，但默认使用安静 danger 外观；只有明确确认阶段才使用填充 danger。

### 3.2.1 控件几何与输入环境

所有控件从 App 根节点注入的 `ControlEnvironment` 取密度，组件不得自行调用 pointer media query：

```ts
interface ControlEnvironment {
  density: "pointer" | "touch";
  layoutMode: "phone" | "compact" | "wide";
  platform: "web" | "native";
}
```

控件不再暴露含义重叠的 regular/compact size；视觉尺寸完全由 `variant × density` 的几何表决定，layoutMode 只决定组合替换和排列，不改变单个控件高度。

Web：若 `any-pointer: coarse` 为真则使用 touch，否则 `pointer: fine` 使用 pointer；Native 默认 touch。密度在一次 App 会话中稳定，外接鼠标不会让已挂载控件跳高；桌面宿主可在启动时显式覆盖。视觉体积与布局 cell 分离，扩大 touch hit target 必须通过 44px cell 完成，禁止用可能与相邻控件重叠的无限 hitSlop。

| Role | Pointer visual/cell/hit | Touch visual/cell/hit | Icon | Gap | Pointer radius | Touch radius |
| --- | --- | --- | --- | --- | --- | --- |
| push button | 30 / 30 / 30 | 44 / 44 / 44 | 15 / 17 | 6 / 8 | 7 | 7 |
| toolbar text | 28 / 28 / 28 | 36 / 44 / 44 | 15 / 17 | 4 / 6 | 6 | 6 |
| icon button | 28 / 28 / 28 | 32 / 44 / 44 | 17 / 20 | 0 | 6 | circle |
| field | 32 / 32 / 32 | 44 / 48 / 48 | 15 / 17 | 6 / 8 | 7 | 7 |
| segmented item | 28 / 30 / 30 | 36 / 44 / 44 | 15 / 17 | 4 / 6 | 6 | 6 |
| source row, one line | 32 / 32 / 32 | 44 / 48 / 48 | 17 / 20 | 8 / 10 | 6 | 6 |
| source row, two lines | 44 / 44 / 44 | 52 / 60 / 60 | 17 / 20 | 8 / 10 | 6 | 6 |

表中斜线左/右分别为 pointer/touch icon 或 gap；相邻 44px cell 不重叠，最小视觉间隙可以为 0，但各自可点击布局框不得交叉。

### 3.3 SystemSegmentedControl

```ts
interface SystemSegmentedOption<T extends string> {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  value: T;
}

interface SystemSegmentedControlProps<T extends string> {
  accessibilityLabel: string;
  onChange(value: T): void;
  options: readonly SystemSegmentedOption<T>[];
  value: T;
}
```

控件绘制一个连续槽体和内部选中块，不再让每个选项拥有独立外框。Web 使用 `radiogroup` / `radio` 语义并支持左右方向键、Home、End；Native 使用相同 value / onChange 合同。Compact 容不下时由宿主显式选择 Picker/Menu，不在组件内部读取全局窗口宽度。

Segmented 状态机固定为：horizontal、单选、roving tab stop。有效且启用的当前值获得 `tabIndex=0`；值无效时开发态告警并让第一个启用项可聚焦但不擅自改 controlled value；全部禁用时无 tab stop。ArrowLeft / ArrowRight 移动焦点并立即选择，跳过禁用项且首尾循环；RTL 反转左右方向。Home / End 选择首/末启用项，Space / Enter 选择当前焦点项。初始 focus 优先当前选中项，否则首个启用项。Native group 使用 `radiogroup`，item 使用 `radio` 和 checked/disabled accessibility state。

可复用的 `AdaptiveSingleSelect` 接受同一 options/value/onChange，在宿主显式传入 `presentation="segmented" | "select"` 时选择呈现。三项以内、短 label 的互斥策略用 segmented；四项以上、动态数据或长 label 用 select。Agents 的 Runtime / 回复策略、Members 的角色、Channel 可见性和 Tasks 的固定二元策略用 segmented；Computer/Agent 动态绑定、时区和成员选择用 select。

现有 `SelectionGroup + SelectionButton` 保留一轮兼容，但新增调用必须使用 `SystemSegmentedControl`；旧调用迁移完成后删除兼容实现。

### 3.4 SystemMenu / Popover

跨平台 overlay API 只暴露受控状态和业务动作：

```ts
type OverlayCloseReason =
  | "escape"
  | "outside"
  | "selection"
  | "tab"
  | "cancel"
  | "action"
  | "nativeBack";

interface FocusableHandle { focus(): void }
interface OverlayTriggerProps {
  accessibilityControls: string;
  accessibilityExpanded: boolean;
  onPress(): void;
  ref: Ref<FocusableHandle>;
}
interface ControlledOverlayProps {
  onOpenChange(open: boolean, reason?: OverlayCloseReason): void;
  open: boolean;
  overlayId: string;
  renderTrigger(props: OverlayTriggerProps): ReactNode;
}
interface SystemActionMenuItem {
  checked?: boolean;
  disabled?: boolean;
  groupId?: string;
  id: string;
  intent?: "normal" | "destructive";
  label: string;
  selectionKind?: "radio" | "checkbox";
  shortcutLabel?: string;
}
interface SystemActionMenuProps extends ControlledOverlayProps {
  items: readonly SystemActionMenuItem[];
  onAction(id: string): void;
}
interface SystemSelectOption<T extends string> {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  value: T;
}
interface SystemSelectProps<T extends string> extends ControlledOverlayProps {
  accessibilityLabel: string;
  onChange(value: T): void;
  options: readonly SystemSelectOption<T>[];
  value: T | null;
}
interface SystemPopoverProps extends ControlledOverlayProps {
  accessibilityLabel: string;
  children: ReactNode;
  initialFocusId?: string;
}
```

React Aria collection objects、DOM refs、placement/collision objects、FocusScope 和 Portal 只存在于 `.web.tsx`；Native adapter 将相同 controlled state 映射到 Modal/Pressable/可访问列表，不把 DOM 类型带入共享 props。

任意内容浮层使用 `SystemPopover`；动作列表使用 `SystemActionMenu`；单选资源使用 `SystemSelect`。Web 统一使用已经安装的 `react-aria-components`，不得再新增第二套 overlay 行为。三者共享 overlay material，但语义不可互换：

- `aria-haspopup`、expanded 和 controls 关系。
- ArrowUp / ArrowDown / Home / End 导航。
- Escape 和点击外部关闭。
- 关闭后把焦点归还 trigger。
- Action Menu 使用 `menu/menuitem`；只有显式 checked group 才使用 `menuitemradio/menuitemcheckbox`。
- Resource chooser 使用 `listbox/option`，不冒充 action menu。
- Enter / Space 激活，typeahead 定位，方向键跳过 disabled；Tab 关闭浮层并让浏览器继续正常焦点顺序。
- 初始 focus：Action Menu 首个启用项；Select 当前选中项，否则首个启用项；任意 Popover 不主动改焦点，除非内容声明 autofocus target。
- Escape 关闭并归还 trigger；选择后关闭并归还 trigger；点击另一个可聚焦元素关闭时不得抢回焦点。trigger 已卸载时焦点回到最近仍挂载的 owning toolbar/dialog，找不到则回到 document body。
- placement 默认 `bottom start`，8px gap，允许 flip/shift；浮层边缘始终距离 viewport/safe area 至少 8px，最大高度为可用高度并内部滚动。

资源切换器和 Compact picker 使用 SystemSelect；账号菜单使用 SystemActionMenu；日期浮层使用 SystemPopover，不再使用 `ScrollView + Pressable[]` 冒充菜单。

### 3.5 SystemDialog

```ts
type DialogCloseReason = "escape" | "cancel" | "backdrop" | "action" | "nativeBack";
interface SystemDialogAction {
  disabled?: boolean;
  id: string;
  intent: "standard" | "destructive";
  kind: "cancel" | "action";
  label: string;
}
interface SystemDialogProps {
  actions: readonly SystemDialogAction[];
  atomicLock?: boolean;
  busy?: boolean;
  children?: ReactNode;
  description: string;
  dialogId: string;
  dismissOnBackdrop?: boolean;
  initialFocusId?: string;
  onAction(id: string): void;
  onOpenChange(open: false, reason: DialogCloseReason): void;
  open: boolean;
  title: string;
  urgency?: "normal" | "urgent";
}
```

Dialog 统一使用 `react-aria-components` 的 ModalOverlay / Modal / Dialog 作为 Web 行为底座，承担 backdrop、材料、标题、描述、操作和焦点生命周期：

- 打开时按以下顺序聚焦：显式 `initialFocusId` 对应的已挂载控件；首个非危险表单控件；`kind="cancel"` 的取消/关闭动作；首个非危险动作；Dialog panel。危险动作永远不会获得隐式初始焦点。触发 cancel action 固定发出 `reason="cancel"`，其余 action 发出 `reason="action"`。
- Tab 焦点留在 Dialog 内。
- Escape / onRequestClose 行为一致。
- 关闭后焦点归还原 trigger。
- 普通取消和普通确认都使用 standard；危险确认使用 destructive。
- 图片全屏预览继续是专用 viewer，不套普通设置 Dialog 外观。

Dialog panel 默认使用 `role="dialog"`；只有 `urgency="urgent"` 的系统级即时中断使用 `alertdialog`，普通删除确认仍是 dialog。title/description id 建立 accessible name/description；Modal 打开时背景 inert、锁定 document 滚动。默认允许 Escape 和取消按钮关闭，不允许 backdrop 点击关闭；非阻塞 preview 可显式 `dismissOnBackdrop`。`busy` 只禁用重复 action，仍允许 Escape/取消；只有显式 `atomicLock` 的原子提交可短暂锁定退出，最多 10 秒，超时必须转为可关闭失败态并显示重试/取消。嵌套 overlay 必须挂在 Dialog overlay provider 内，Escape 先关闭最上层 overlay。Android back 映射 `nativeBack`；iOS swipe dismissal 首轮关闭。opener 被删除时按 owning toolbar/dialog → body 顺序降级恢复焦点。

### 3.6 SystemFeedback

```ts
interface ProductError {
  code: ProductErrorCode;
  detail?: string;
  scope: string;
}
interface SystemFeedbackProps {
  action?: {
    accessibilityLabel?: string;
    label: string;
    onPress(): void;
  };
  error?: ProductError;
  kind: "field" | "inline" | "toast" | "blocking";
  message?: string;
  testID?: string;
}
```

反馈分为四类：

- `FieldMessage`：字段错误和提示。
- `InlineNotice`：与局部内容相关的轻量反馈。
- `Toast`：保存成功、复制成功等短暂结果。
- `BlockingBanner`：连接中断、全局权限或系统不可用。

接口错误先规范化为稳定的 `ProductErrorCode`，主文案说明用户影响与下一步，技术字符串只进入可展开详情：

| Code | 用户主文案 | 下一步 |
| --- | --- | --- |
| `network_unavailable` | 网络连接不可用 | 检查网络后重试 |
| `permission_denied` | 你没有执行此操作的权限 | 联系 Server 管理员 |
| `validation_failed` | 部分内容需要修改 | 聚焦第一个无效字段 |
| `resource_conflict` | 内容已发生变化 | 刷新后重新操作 |
| `provider_unavailable` | 服务暂时不可用 | 稍后重试 |
| `method_not_allowed` | 当前服务版本暂不支持此操作 | 刷新页面；仍失败则联系管理员 |
| `unknown` | 操作没有完成 | 重试或展开技术详情 |

HTTP status、后端稳定 error code 和已知 provider 字段进入纯 `normalizeProductError`；无法识别时必须回落 `unknown`，不得把 raw message 提升为主文案。文案集中在 `application/product-language.ts`，为未来 i18n 保持键值，不散落页面。

FieldMessage 要求 input 设置 `aria-invalid`，并通过 `aria-describedby` 关联 hint/error id；error 使用 polite live region，只有提交后阻断性摘要使用 alert。技术详情使用 disclosure button，默认折叠且不进入 live announcement。

Toast 默认 polite、5 秒、hover/focus 暂停，最多同时显示 3 个；第四条及以后进入 FIFO queue，单队列最多 20 条，溢出时丢弃最旧的未显示 non-danger Toast。相同 code + scope 在 2 秒内去重；当前 Toast 关闭后立即从队首补位。危险且需要立即处理的系统中断使用 assertive BlockingBanner，不进入 Toast 队列。行为测试必须覆盖第四条排队、补位、去重、暂停和队列溢出。

### 3.7 EmptyState

```ts
interface EmptyStateAction {
  accessibilityLabel?: string;
  label: string;
  onPress(): void;
}
interface SystemEmptyStateProps {
  description: string;
  kind: "list" | "canvas" | "onboarding";
  primaryAction?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  title: string;
}
```

空状态输入统一为 `kind`、title、description 和至多一个 primary / secondary action。状态决策如下：

| 数据状态 | kind | 对齐/图标 | 允许动作 |
| --- | --- | --- | --- |
| 首次零数据且用户可创建 | onboarding | content canvas 左对齐；feature icon 可选 | 一个创建 primary + 一个文档 secondary |
| 已有使用历史但当前零数据 | canvas | 左对齐；不使用装饰大图标 | 一个恢复/创建 secondary |
| 搜索/过滤无结果 | list | 列表内左对齐；search icon ≤ 17px | 清除筛选，不显示创建 primary |
| 无权限 | canvas | 左对齐；lock icon ≤ 17px | 返回或联系管理员 |
| loading | 不使用 EmptyState | skeleton/progress | 无 |
| failure | 不使用 EmptyState | InlineNotice/BlockingBanner | 重试或详情 |

- `list`：直接出现在资源列表，左对齐、小图标、轻操作。
- `canvas`：内容画布中的说明与行动，不绘制额外白卡。
- `onboarding`：首次使用时可以有更强指导，但仍保持信息密度。

默认不使用居中“大图标 + 标题 + 描述 + 蓝按钮”模板。搜索无结果属于 list 状态，不显示创建主 CTA。

### 3.8 Field、Tabs、SourceListRow 与日期控件

```ts
interface SystemTabOption<T extends string> {
  disabled?: boolean;
  label: string;
  panelId: string;
  value: T;
}
interface SystemTabsProps<T extends string> {
  accessibilityLabel: string;
  onChange(value: T): void;
  options: readonly SystemTabOption<T>[];
  value: T;
}
interface SystemSourceListRowBaseProps {
  accessibilityLabel: string;
  badge?: string;
  description?: string;
  disabled?: boolean;
  leading?: ReactNode;
  rowId: string;
  selected?: boolean;
  title: string;
  trailing?: ReactNode;
}
type SystemSourceListRowProps = SystemSourceListRowBaseProps & (
  | {kind: "link"; href: string; onPress?: never}
  | {kind: "button"; href?: never; onPress(): void}
  | {kind: "static"; href?: never; onPress?: never}
);
```

Tabs/SourceList 的 Web adapter 独占 DOM `tabIndex`、anchor、keyboard event 与 focus ref；Native 共享 value/selected/action state，并映射 accessibilityRole/state。

- `SystemField` 包装 label、hint、error id 与 input slot；现有 `ManagementTextInput` 成为 field chrome 的兼容实现，精确遵守几何表。多行 textarea 不固定高度，但共享 border/focus/invalid 语义。
- `SystemTabs` 使用 `tablist/tab/tabpanel`、roving tab stop，Arrow keys 只移动并激活 tab，Home/End 跳转，disabled 跳过；Tasks 的任务/提醒是首个迁移点。视觉使用 toolbar segmented，不再用浏览器下划线。
- `SystemSourceListRow` 是现有 `CollectionRow` 和会话目录行的共同底座，提供 selected、badge、description、leading/trailing slot 与 link/button 语义；页面不重复画 selection chrome。
- `LocalDateTimeInput.web.tsx` 已有 React Aria 日期行为并通过现有测试，本轮认证并迁移其 overlay 到 SystemPopover；共享 `LocalDateTimeInputProps` 继续是 Native 实现边界，Native 最终原生 picker 视觉属于后续增强，不是本轮完成条件。

## 4. 主题与平台状态

主题必须至少包含：

- `velaLight`
- `velaDark`

共享设置合同为：

```ts
interface AppearancePreferences {
  colorScheme: "system" | "light" | "dark";
  contrast: "system" | "normal" | "more";
  motion: "system" | "full" | "reduced";
  transparency: "system" | "full" | "reduced";
}
```

优先级固定为显式用户设置 > 宿主设置 > OS system preference > light/normal/full fallback；用户设置持久化在现有客户端持久层，Native 读取系统 color scheme、reduce motion 和 reduce transparency 等价能力。Web 响应 `prefers-color-scheme`、`prefers-contrast`、`prefers-reduced-motion`；浏览器没有标准 reduced-transparency 时由宿主 preference 决定。

材料组件额外响应：

- `prefers-reduced-transparency` 可用时使用更不透明填充；不支持时提供显式宿主配置接口。
- `prefers-contrast: more` 时加深 separator、control border 和 focus ring。
- `prefers-reduced-motion` 继续把反馈和 reveal 动画归零。

`forced-colors: active` 时关闭自定义 blur、阴影和透明 fill，使用 Canvas、CanvasText、ButtonFace、ButtonText、Highlight、HighlightText 与系统 outline。Reduced motion 移除 hover/selection/reveal 的 transition duration 和 transform/opacity entrance，但保留 spinner/progress 的非位移状态变化与文本状态。Reduced transparency 将所有 navigation/overlay fill 提升为不透明 surface，同时保持 separator 和层级。

深色主题不是反转颜色：navigation、content、overlay、separator、selection、field、status 和文本都必须有独立语义值。普通文本/表面至少 4.5:1，大号文字 3:1，图标/控件边界/焦点环与相邻颜色至少 3:1。自动化至少覆盖 `textPrimary/content`、`textMuted/content`、`textPrimary/navigation`、`textPrimary/overlay`、`actionPrimaryText/actionPrimarySurface`、所有 status text/status surface、field text/field surface、selection text/selection surface 和 focus/border 邻接组合。

## 5. 页面迁移

### 5.1 Shell 与导航

- Rail 和 Sidebar 共享 navigation material，保持一个连续层面。
- Source-list row 默认无边框；选中态使用低对比度面，品牌蓝只用于图标/文字强调。
- Toolbar 默认透明，icon actions 使用 toolbar role。
- 账号固定底部，账号 Popover 使用 SystemMenu / popover material。
- Web 不绘制交通灯；Electron / Native 可在宿主标题栏预留实际拖拽区。

### 5.2 管理页

- 删除“灰色 stage 上重复白卡”的默认组合。
- Detail 内容使用以下三个明确容器：
  - `InsetSettingsGroup`：不透明 content surface、7px 外圆角、1px hairline；内部只能是 rows，以 separator 分隔；禁止再嵌套 card。
  - `ContentCanvas`：透明/稳定 stage 上的连续内容轴，不画自身边框和阴影；表单通过 spacing 分组。
  - `InspectorGroup`：最多 320px 的辅助属性列或紧凑事实组；只允许一层 section，Compact 下移入 ContentCanvas。
- 属性展示使用带 separator 的 inset rows，不把每组元数据放进独立卡片。
- 创建/编辑表单保留稳定 content surface，字段严格使用 32px / 48px 密度尺寸。
- Agent、Computer、Member、Task 和 Settings 只能通过共享管理控件表达同类工作。

页面迁移清单：

| 页面 | Directory | Main content | 选择控件 | Empty/feedback |
| --- | --- | --- | --- | --- |
| Agents | SystemSourceList | ContentCanvas + InsetSettingsGroup | Runtime/策略 segmented；Computer select | onboarding/list + InlineNotice |
| Computers | SystemSourceList | ContentCanvas；终端独立 stable surface | 动态 Computer select | onboarding/list + BlockingBanner 仅连接故障 |
| Members | SystemSourceList | ContentCanvas + InsetSettingsGroup | 角色 segmented；成员 select | onboarding/list + InlineNotice |
| Tasks | SystemSourceList | ContentCanvas + SystemTabs | 二元策略 segmented；Agent/timezone select | canvas/list + InlineNotice |
| Settings | 无 directory | ContentCanvas + InsetSettingsGroup rows | 无 | FieldMessage + Toast |
| Channel manage | SystemSourceList/Select | SystemDialog + ContentCanvas | 可见性 segmented；成员 select | list + InlineNotice |

验收时每个管理页面最多有一个 ContentCanvas，InsetSettingsGroup 可以多个但互不嵌套；任何 group 内禁止出现另一张带完整 border/radius 的 section card。截图对比需要证明灰色 stage → 连续 content axis → inset rows 三层清晰，而不是以白卡数量建立层次。

### 5.3 Composer 与终端

- Composer 保持现有 floating control material，不把其 24px 圆角复制到普通控件。
- Terminal 内容保持暗色稳定面；只有外围 toolbar / popover 使用 Tahoe 材质。

### 5.4 Compact 与 Native

- Compact navigation 使用 touch 密度和 safe area；不简单缩小 desktop sidebar。
- 业务状态和组件 props 跨平台共享，Web DOM、React Aria、backdrop filter 留在 `.web` 实现。
- Native 首轮必须存在等价导出和可编译降级；最终平台 blur、SF Symbols 和 haptics 可在独立实现中增强。

本轮明确延期：Native 原生 blur/vibrancy、SF Symbols 桥、haptics 和 macOS/iOS 宿主标题栏。它们不得成为 Web 完成的隐含条件；本轮 Native 条件是共享 props、行为模型、touch 几何、语义 state、平台导出和 bundle/render smoke 全部通过。

## 6. 可访问性与交互

- 所有交互控件保持可见 `focus-visible`，自绘 field chrome 时禁止双重 focus ring。
- Tab 容器提供 `tablist`，选中 tab 与 panel 建立关系，并支持方向键。
- Segmented control、Menu、Dialog 不允许只依靠颜色表达状态。
- icon-only 控件必须有 accessibility label；tooltip 不能成为唯一名称来源。
- Field label 在 Web 必须与 input 形成程序化关联；Native 使用 accessibilityLabel。
- 错误使用 live region，但只有阻断性错误使用 assertive / alert。
- touch 命中区域不少于 44px；pointer 视觉尺寸不因此膨胀。

## 7. 性能与响应式

- 同一视口同时合成的 backdrop-filter DOM/native material element 硬上限为 3：一个 navigationChrome、一个 Composer/floatingControl slot、一个 active overlay slot。Rail + Sidebar 由同一个 navigation owner 计为 1；Toolbar 和 Dialog scrim 不计，因为它们禁止 backdrop filter。Composer 之外的 floatingControl 占用同一个 floating slot，不能与 Composer 同时 blur；nested React Aria overlay 可以独立定位，但第二层及以后必须使用不透明 overlay fill、不得再创建 backdrop-filter 元素。
- blur token 上限为 `saturate(180%) blur(20px)`；navigationChrome 覆盖宽度不得超过 384px，Composer 最大 860×240px，Popover/Menu/Select 最大 480×640px，Dialog panel 最大 520×720px。超出面积、reduced transparency、forced colors 或不支持 backdrop-filter 时使用不透明 fallback。
- Content surface 禁止 backdrop blur，避免长列表滚动时持续合成。
- Host layout contract 固定为 `<768 phone`、`768–959 compact`、`≥960 wide`；沿用现有 `managementSurfaceLayout` 和 `workspaceLayoutMode`，不得创建平行 breakpoint。组件级宽度变化优先使用明确宿主 mode 或容器查询；业务组件不得散落新的 viewport breakpoint。
- 菜单、Dialog 和日期控件必须处理小高度视口、滚动和安全区，不得溢出屏幕。

Compact 替换矩阵：desktop Sidebar → Compact picker；Toolbar 文字动作 → icon/menu；三项以内短选项保持 segmented，其他使用 SystemSelect；InspectorGroup → ContentCanvas 后置 section；Dialog 宽度为 viewport - 32px 且最大 520px；底部导航 padding 加 `safe-area-inset-bottom`。所有 overlay 边缘距 viewport/safe area 至少 8px。

真实性能验收在 MacBook Air M1、macOS Tahoe、Safari 26 与当前稳定 Chrome 上进行：宽屏聊天滚动 10 秒、打开账号菜单、打开日期 picker。Performance trace 中 steady-state scroll p95 frame time ≤18.2ms（约 55fps），无连续 3 帧超过 33ms；若不达标，按 overlay → Composer → navigation 顺序降级为不透明 fallback，而不是减少内容功能。

## 8. 测试策略

严格按 TDD 逐项推进：每个新控件先写会失败的行为/结构测试，再实现最小代码并回归全量。

### 8.1 契约测试

- 材料角色在 Web / Native 导出相同 props，业务源文件不得直接出现 backdrop blur。
- pointer field 实际 box metric 为 32px；button 为 30px；toolbar action 为 28px。
- dark theme 拥有与 light 相同的 semantic key，并满足核心文本/表面对比度。

### 8.2 行为测试

- Segmented control 支持点击、方向键、Home / End、禁用项跳过和语义状态。
- Menu 支持打开、键盘导航、Escape、外部关闭和焦点归还。
- Dialog 支持焦点锁定、Escape、取消、危险确认和焦点归还。
- Tabs 提供 tablist / tab / tabpanel 关系和键盘切换。
- Feedback 根据错误类型输出产品文案，技术详情不成为默认标题。
- EmptyState 的 list / canvas / onboarding 三种布局保持不同层次。

### 8.3 迁移回归

- Agents、Computers、Members、Tasks、Settings 不再直接拼接同类 selection、button、menu 或 feedback 控件。
- Shell、management sidebar 和 account popover 使用共享材料角色。
- 现有聊天、邀请、日期、Composer、终端与路由测试保持通过。
- style lint 禁止在页面添加新颜色、硬编码半径、blur 或重复控制尺寸。

### 8.4 兼容迁移与回滚

当前 runtime inventory 是 44 个 `ActionButton`、12 个 `IconActionButton`、3 个 `SelectionGroup`、3 个 `SelectionButton`、10 个 `ManagementChoiceField`、2 个 `ManagementTab`、3 个 `ManagementResourceSwitcher` 和 68 个直接 `Pressable`。直接 Pressable 并非全部错误：消息正文、图片 viewer backdrop 等专用手势允许保留，但必须进入 style-lint 例外清单并写明语义原因。

迁移分四个可回滚阶段：

1. 新增 System primitives、主题和行为测试，旧组件零视觉变化。
2. 旧 Action/Icon/Selection wrappers 映射新实现；用 legacy parity 测试锁住 label、disabled、busy、onPress、accessibility state、computed variant snapshot 和 Native export。所有普通文字动作统一映射为 standard，旧 primary/secondary/tonal 视觉入口不进入新 API。若出现回归，可单独回退 wrapper 映射，不回退 token/新控件。
3. 按 Shell → management → overlay/feedback 迁移调用点；开发构建对旧 import 输出一次 deprecation warning，测试环境静默。
4. `rg` 证明 runtime 旧调用为 0、全量 Web/Native 检查通过、dep 两轮验收无回退后，删除 wrapper 和 warning。删除前至少保留一个发布提交作为 rollback boundary。

旧 `ActionButton` / `IconActionButton` / `SelectionGroup` 只有满足以下条件才能删除：runtime import 和 JSX 使用均为 0；barrel 不再导出；legacy parity 测试已由 System primitive 测试覆盖；Web export、Native bundle、完整 Jest 与 TypeScript 通过；迁移前 commit hash 被记录在交付说明中。

### 8.5 测试能力边界

Jest 只验证纯状态机、props、语义属性、主题 key 和源码守卫，不声称验证浏览器几何、compositor 或 focus trap。真实浏览器使用 Playwright/现有 in-app browser 做 Chromium 与 Safari 手工验收；可自动化部分使用 axe-core。Native 至少执行 Expo iOS bundle/export 和 React Native renderer smoke，验证 `.native` extension 实际解析，而不是只导入共享 barrel。

严格 TDD 的证据保存在提交/PR 验证记录：每个新 primitive 记录对应测试最初因缺少行为而失败的命令和摘要，再记录 green 命令；不要求把临时失败提交推到主分支。

## 9. 验证与完成标准

自动化验证：

- 客户端完整 Jest，包含 pointer、touch 和 reduced-motion 模式。
- TypeScript `--noEmit`。
- Web export 和 SPA fallback 检查。
- 主题对比度、材料使用、直接 `Pressable` 例外和平台导出守卫。
- axe-core 对 Shell、每个管理页、Popover、Dialog 与日期 picker 零 serious/critical violation。
- Expo iOS bundle/export 和至少一个 Native renderer smoke。

实际页面验证矩阵：

- Safari 26 与稳定 Chrome，macOS Tahoe；1440×900 宽屏：聊天、Agents、Computers、Members、Tasks、Settings、邀请日期控件。
- Safari 26 与稳定 Chrome；900×720 compact、390×844 phone：底部导航、资源切换、表单和 Dialog。
- 键盘：Tab、Shift+Tab、方向键、Escape、Enter / Space。
- light / dark、减少动画、高对比度或透明度降级。
- VoiceOver：分别朗读 Sidebar 当前项、Segmented 当前值、Select 展开/选中、Dialog 标题/描述/取消、Field error、Toast。每项保存操作步骤与实际朗读摘要。
- 每个 viewport 保存迁移前/后截图；允许字体抗锯齿差异，布局边界、control height、group nesting 和 overlay placement 必须满足本规格，不用单纯像素零差异作门槛。

以下可枚举断言全部成立才算完成：

- Rail + Sidebar DOM 中只有一个 navigation backdrop owner；Toolbar 没有独立 blur。
- 44 个 ActionButton、12 个 IconActionButton、3 个 SelectionGroup、3 个 SelectionButton、10 个 ManagementChoiceField、2 个 ManagementTab、3 个 ManagementResourceSwitcher runtime import 与 JSX 使用全部为 0。
- pointer/touch 几何表、SystemButton/Segmented/Select/Dialog/Feedback/EmptyState 行为测试全部通过。
- Agents、Computers、Members、Tasks、Settings 与 Channel management 满足迁移清单，每个 group 无嵌套 card。
- light/dark semantic keys 同构，列出的 contrast pairs 全部达到阈值；forced-colors、reduced-motion/transparency 验收通过。
- keyboard 与 VoiceOver 清单逐项通过，axe 无 serious/critical violation。
- backdrop owner 数量与面积上限满足，真实浏览器 performance gate 通过或按规定启用不透明 fallback。
- Web 与 Native 共享业务 API，`.web/.native` 实际 extension resolution、Web export 和 Native bundle/render smoke 通过。
- 客户端完整 Jest、pointer/touch/reduced-motion、TypeScript、Web export、SPA fallback 全部通过。
- `dep` 指 `http://9.135.236.23` 的部署环境；部署新构建后，在上述浏览器/viewport 矩阵逐项验收并保存截图、操作记录和镜像 digest。

Style lint 扫描 `web/apps/client/src/ui/**/*.{ts,tsx}` 的 runtime 文件，AST/源码守卫禁止页面级 raw color、硬编码 control radius/height、`backdropFilter`、未登记 direct Pressable。允许清单仅包含材料实现、Composer 专用几何、图片 viewer backdrop 和经注释说明的专用手势；新增例外必须在测试快照中显式审核。
