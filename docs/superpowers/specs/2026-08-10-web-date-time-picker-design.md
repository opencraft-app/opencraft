# Web 日期时间选择控件设计规格

## 1. 目标

本轮将 VelaChat Web 端当前依赖浏览器原生 `datetime-local` 的日期时间输入，升级为 Vela 自有视觉和交互的可复用日期时间选择控件。首个重点场景是创建成员邀请，同时保证一次性任务提醒可以复用基础控件，并为后续 iOS / Android 原生选择器保留稳定的平台边界。

核心目标：

- Web 使用紧凑锚定浮层，将期限预设、月历与时间选择放在同一层级。
- 控件保持受控、通用，不内置邀请业务文案、期限或默认值。
- 邀请场景提供 24 小时、7 天、30 天和自定义四种选择，并默认当前时间后 7 天。
- 日期运算、时区、键盘导航、焦点恢复和无障碍语义由成熟的无样式基础能力承载。
- 继续输出现有 `YYYY-MM-DDTHH:mm` 本地日期时间字符串，不改变业务层时区转换和平台 API 合约。

本轮不实现：

- iOS 或 Android 原生日期时间选择器。
- HeroUI React、HeroUI Native 或其他完整视觉组件库。
- 邀请接口不支持的永久有效邀请。
- 日期范围选择、秒级输入、自然语言日期解析或周期规则编辑。
- 全局表单模型重构。

## 2. 组件边界

### 2.1 稳定平台入口

`LocalDateTimeInput` 继续作为业务 UI 唯一依赖的平台入口：

- `local-date-time-input.web.tsx` 提供新的 Web 实现。
- `local-date-time-input.tsx` 继续作为 Native 实现入口，本轮行为保持不变。
- `ManagementDateTimeInput` 继续负责把管理后台字段样式、禁用态和错误态接到平台控件。
- 成员邀请与任务提醒不得直接 import Web 控件、DOM API 或 React Aria。

Web 与 Native 不再各自重复声明属性类型。新增
`local-date-time-input.types.ts` 作为共享契约，现有属性保持兼容，并增加可选的通用配置：

```ts
interface LocalDateTimePreset {
  id: string;
  label: string;
  value: string;
}

interface LocalDateTimeInputConfig {
  maxValue?: string;
  minValue?: string;
  minuteStep?: number;
  presets?: readonly LocalDateTimePreset[];
  timezone?: string;
}

interface LocalDateTimeInputProps extends LocalDateTimeInputConfig {
  accessibilityLabel: string;
  disabled?: boolean;
  onChangeText(value: string): void;
  placeholder?: string;
  style?: StyleProp<TextStyle>;
  value: string;
}
```

这些新增属性全部可选，因此 Native 可以先忽略增强配置而不破坏调用方。Native 后续接原生 picker 时沿用相同值协议和约束属性。Web、Native、`ManagementDateTimeInput` 与业务适配组件都从共享文件导入类型，禁止复制接口声明。

### 2.2 Web 内部拆分

Web 实现保持小组件和纯模型分离：

- `LocalDateTimeInput`：受控入口，管理打开状态、草稿值、提交和取消。
- `WebDateTimePopover`：浮层定位、焦点圈定、外部点击、Escape 和窄屏呈现。
- `WebCalendarGrid`：月份导航、星期表头、日期网格、禁用和选中状态。
- `WebTimeField`：小时、分钟与 `minuteStep` 约束。
- `local-date-time-model.ts`：解析、格式化、月份网格、范围判断、预设解析和取整等纯函数。

子组件保持内部实现，不从公共 `ui/index.ts` 导出。公共出口只保留 `LocalDateTimeInput`、`ManagementDateTimeInput` 及其必要类型，避免业务层依赖内部结构。

### 2.3 业务配置

控件内部不出现“邀请”“7 天默认”或“有效期需在 30 天内”等业务规则。新增内部业务适配组件 `InviteExpirationField`，集中连接成员邀请的 `PresentationField`、领域期限配置、`ManagementField` 与 `ManagementDateTimeInput`。邀请页面不直接拼装日期控件配置，通用 `PresentationField` 也不扩展日期专属属性，从而避免日期细节污染终端展示模型。

邀请表单会话负责：

- 用户开始创建邀请时捕获一次不可变的 `referenceNow`。同一次表单会话的默认值、最小值、最大值和全部预设都基于该时间，不在渲染或点击时重新读取时钟。
- 把受控值初始化为 `referenceNow` 后 7 天，并向下取整到 5 分钟。
- 传入 24 小时、7 天和 30 天预设，以及一个由控件提供的“自定义”入口。
- 最小值是 `referenceNow + 5 分钟` 后向上取整到 5 分钟；最大值是 `referenceNow + 30 天` 后向下取整到 5 分钟；传入 `minuteStep=5`。
- 继续保留提交前的领域校验，防止时钟推进或绕过 UI 造成非法请求。

`InviteExpirationField` 的期限配置由显式接收 `referenceNow` 的纯函数生成，便于确定性测试。取消或成功提交后清除本次会话基准；下一次创建邀请重新捕获。

一次性任务提醒复用基础日历与时间控件，但不自动继承邀请期限预设或 30 天上限。它必须把用户当前填写的 `reminderTimezone` 作为 `timezone` 传入，使墙钟值的显示与最终 `normalizeLocalDateTime(reminderSchedule, reminderTimezone)` 使用同一时区语义。

## 3. 依赖策略

不引入 HeroUI。Web 平台实现引入 `react-aria-components` 与 `@internationalized/date`：

- React Aria 提供无样式的日期字段、日历、浮层、对话区域、键盘导航、焦点管理和 ARIA 语义。
- `@internationalized/date` 负责无时区墙钟值、月份运算、跨月网格和夏令时相关转换。
- Vela 自己负责组件组合、状态策略、视觉令牌、尺寸、文案和响应式行为。

依赖只从 `.web.tsx` 或 Web 内部模块引入，不进入 Native bundle。不得复制 HeroUI 源码或引入 HeroUI provider、Tailwind / Uniwind 等配套体系。

## 4. 邀请交互

### 4.1 初始值与字段

- 用户进入“创建邀请”时，字段已经具有相对本次 `referenceNow` 计算的 7 天后有效值，提交按钮不因空日期而禁用。
- 字段显示本地化后的日期与时间，并在右侧显示当前设备时区的简短标签和日历图标。
- 不硬编码“北京时间”；邀请时区来自现有 `deviceTimezone()`，一次性提醒则来自提醒表单选择的 IANA 时区。
- 受控值仍是 `YYYY-MM-DDTHH:mm`，显示格式与提交格式分离。

### 4.2 打开与草稿

- 点击字段或在其聚焦时按 Enter / Space，打开锚定浮层。
- 打开时从当前受控值建立内部草稿；非法或空值使用当前时间后的最近合法 5 分钟作为浏览起点，但不静默写回。
- 选择预设、日期或时间只修改草稿。
- 点击“确认”后调用一次 `onChangeText` 并关闭。
- 点击外部、按 Escape 或显式取消时丢弃草稿，原受控值不变。
- 关闭后焦点回到触发字段。

### 4.3 预设

- 邀请场景显示 `24 小时`、`7 天`、`30 天`、`自定义`。
- 前三个预设相对本次表单会话不可变的 `referenceNow` 计算，并向下取整到 5 分钟；30 天预设因此与最大值完全一致，不会因用户稍后点击而越界。
- 当前草稿与某个预设计算结果一致时显示选中态；用户改动日历或时间后切换为“自定义”。
- “自定义”不生成值，只把焦点送到日历区域。
- 不提供“永久”，因为平台合约要求邀请有效期最多 30 天。

### 4.4 月历与时间

- 月历以周一为首日，使用中文短星期标签。
- 月份标题和前后月按钮位于同一行；不能导航到完全落在允许范围外的月份。
- 范围外日期显示禁用态且不可选择。
- 若边界落在某一天内，该日期仍可选，但时间字段只允许合法时刻。
- 小时使用 24 小时制，分钟按 `minuteStep` 递增；直接键盘输入后在失焦或确认时归一化。
- 当用户选择新日期导致原时间越界时，将草稿夹到该日最近的合法时间，并明确更新界面，不产生隐藏错误。

## 5. 布局与视觉

- 桌面 Web 使用约 360px 宽的锚定浮层，优先位于字段下方；可用空间不足时翻转或水平移位，不能被管理页容器裁剪。
- 预设为等宽紧凑按钮；日历网格保持 7 列；时间区与确认区由分隔线分组。
- 选中日期和主操作使用 Vela 主色；悬停、聚焦、禁用和错误态全部使用现有 semantic tokens。
- 控件继承管理字段圆角、字号和边框密度，不创造第二套表单视觉系统。
- 窄屏 Web 使用底部浮层，保留同一内容顺序和受控状态，不退回浏览器原生 `datetime-local`。
- 动效只用于 120–180ms 的淡入和轻微位移，并遵循 reduced-motion 设置。

## 6. 无障碍与键盘

- 触发字段暴露可访问名称、展开状态、当前值和错误关联。
- 浮层使用对话语义并具有可访问标题；打开后焦点进入当前选中日期或今天。
- 方向键按天或周移动，PageUp / PageDown 切月，Home / End 移动到周首 / 周尾，Enter / Space 选择日期。
- Tab 顺序依次覆盖预设、月份导航、日期网格、时间字段和底部操作，不允许焦点掉到浮层背后。
- Escape 关闭并取消草稿；确认或取消后均恢复触发器焦点。
- 禁用日期不进入可选状态；错误文本继续通过现有 `accessibilityRole="alert"` 暴露。

## 7. 数据流与错误处理

```text
邀请业务规则 / 提醒业务规则
        ↓ 通用配置与受控值
ManagementDateTimeInput
        ↓ 平台无关属性
LocalDateTimeInput
        ├─ Web: Vela 浮层 + React Aria + date model
        └─ Native: 当前输入实现，未来替换原生 picker
        ↓ YYYY-MM-DDTHH:mm
normalizeLocalDateTime(value, deviceTimezone())
        ↓ 带偏移 ISO 时间
现有业务校验与平台 API
```

- 控件只提交语法正确且位于可选范围内的本地日期时间。
- 外部传入非法值时，字段保留原始显示或占位信息，浮层使用安全浏览起点；控件不得在 mount 时擅自修正受控值。
- `minValue > maxValue`、无效时区或非法步长视为调用方配置错误；开发环境给出明确警告，生产环境降级为无范围增强而不是崩溃。
- 所有依赖当前时间的纯函数显式接收 `referenceNow` 或 `now`，组件模型与测试不得直接读取不可控制的 `Date.now()`。
- 页面保留现有领域校验，因此时钟在浮层打开期间推进、手工注入值或异步提交延迟仍会被阻止。

## 8. 测试与验收

### 8.1 纯模型测试

- 闰年、月首月末、跨年月份网格。
- 单一 `referenceNow` 下的最小值向上取整、默认值和最大值向下取整，以及 24 小时 / 7 天 / 30 天预设。
- 最小值、最大值和边界日的时间夹取。
- 空值、非法值与夏令时切换附近的本地时间。

### 8.2 Web 控件测试

- 受控值显示与现有 `onChangeText` 合约。
- 打开、确认、外部点击取消、Escape 取消和焦点恢复。
- 预设切换、自定义状态、月份导航和时间修改。
- 禁用态、错误样式、范围外日期与键盘导航。
- 宽屏锚定浮层和窄屏底部浮层的结构状态。

### 8.3 场景回归

- 邀请表单打开时默认 7 天，24 小时 / 7 天 / 30 天均能提交正确的带偏移 ISO 时间。
- 邀请仍拒绝 5 分钟内或 30 天后的值。
- 一次性任务提醒继续提交既有格式，且不显示邀请专属预设；设备时区与提醒所选时区不同时，界面和提交使用提醒所选时区解释同一墙钟值。
- Native 测试仍使用稳定的平台组件接口，不需要感知 Web 内部组件。
- 客户端完整 Jest、TypeScript、严格未使用检查、Web export 与凭证扫描通过。

## 9. 完成标准

- 邀请页不再呈现浏览器默认 `datetime-local` 控件。
- Web 日期时间选择器与批准的 A 方案一致，且邀请业务配置没有泄漏进通用控件。
- 同一基础控件可被一次性任务提醒复用。
- 平台边界清晰，Native 后续实现无需改业务页面和受控值协议。
- 所有新增行为具有自动化测试，完整前端验证通过。
