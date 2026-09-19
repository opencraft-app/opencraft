# 账号页与订单页 Agents 风格重构设计

## 目标

在不改变账号、计费、实名、订单和权限行为的前提下，重构 `/account` 与 `/account/orders` 的展示层，使其与当前 `/agents/*` 页面使用相同的组件规范、视觉 token、加载语义和响应式细节。

## 范围

### 包含

- `/account` 账号主页。
- `/account/orders` 订单历史页。
- 账号主页中的资料、账户安全、套餐权益、积分 Progress 和相关弹窗展示。
- 订单页的页面标题、订单表格、分页栏、发票弹窗展示。
- 两个页面的首屏 loading、错误态、空状态、响应式和无障碍语义。

### 不包含

- `/settings/account` 控制台账号资料页。
- Repository、后端接口、套餐计算、实名门禁、区域规则、订单状态和权限模型。
- Agent Console 的导航、Bot 选择、会话、浏览器、终端和 Workbench 逻辑。
- 已有业务文案和国际站/国内站功能开关，除非组件迁移需要保持同一文案调用方式。

## 现状问题

- `account-page.tsx` 同时承担页面状态、资料展示、套餐展示和多个弹窗视图，文件过大，展示职责交织。
- 账号页和订单页使用大量内联样式与独立卡片规则，与 Agents 设置页的 `rounded-md`、浅边框、轻阴影和 UI 原语没有统一。
- 账号页的认证 loading 使用局部骨架块；在套餐摘要尚未完成时，页面可能先显示资料区，再补充套餐区。
- 破坏性操作仍使用页面内自定义遮罩，缺少共享 AlertDialog 的统一语义和焦点行为。

## 设计方案

### 1. 业务控制层与展示层分离

保留 `account-page.tsx` 作为页面控制层，继续负责：

- Session/Auth Repository 调用。
- `useAccountPassSummary`、`usePassUpgrade`、`useOpenClaw` 的消费。
- 区域和功能开关判断。
- 头像、昵称、邮箱、手机号、实名认证和套餐操作的状态机。
- 弹窗开关、导航和成功/失败后的刷新。

新增账户展示组件，使用明确的 props 和回调接收数据：

- 资料卡：头像、昵称、账号 ID、退出登录。
- 账户安全卡：邮箱、手机号、实名认证状态和操作入口。
- 套餐卡：套餐名称、有效期、状态、积分 Progress、续费/升级/销毁入口。
- 订单表格：订单行、状态标签、金额、分页信息和发票入口。
- 账户弹窗：绑定邮箱、修改手机号、实名认证、删除账号和销毁套餐。

展示组件不直接调用 Repository，不推导权限，不决定套餐归属；页面控制层保留这些职责。

### 2. 页面和卡片规范

两个页面继续使用 `ProductPageShell`，保持 Agents 相关页面当前的无 Footer 行为。

页面使用现有 `agents-ui` 文字 token、`DisplayTitle`、`Card`、`Button`、`Progress`、`AgentState` 和 `AgentPageLoadingState`。卡片视觉采用：

- `rounded-md`。
- 白色背景。
- `border border-black/[0.08]` 或对应项目 token。
- `shadow-[0_10px_30px_rgba(15,23,42,0.04)]`。
- 同级卡片使用一致的内边距和分隔线。

页面标题使用清晰的标题/描述层级。资料、账户安全和套餐按稳定的信息顺序纵向排列。操作按钮优先使用项目原语，图标按钮必须提供 `aria-label`。

### 3. 套餐和积分展示

套餐卡继续使用当前套餐优先级和权益口径：`modifyingPass`、`activePass`、已确认的 fallback pass，最后回退到旧订阅信息。

积分区域使用现有 `Progress` 组件：

- 进度值来自 `credit_total` 与 `credit_available` 的现有计算。
- 数字作为辅助信息保留，使用 `tabular-nums`。
- 0%、正常使用、高使用率和已用尽状态沿用当前颜色判断。
- 未知、加载中或失败时不伪造百分比，不渲染错误的进度条。

### 4. 加载、错误和空状态

进入具体账号页时，认证状态或套餐摘要尚未完成，主内容区域整体显示居中的 `AgentPageLoadingState`。资料卡、套餐卡、操作按钮和订单表格不会在同一首屏同时出现局部 loading 和已加载内容。

已有页面进入稳定状态后的局部操作继续使用 `Spinner`，例如头像上传、续费、升级、销毁、绑定和重试。

请求失败使用就近 `AgentState` 错误态并提供重试动作。未订阅使用明确的空状态和“立即创建”入口。错误、空状态、过期、隔离和升级中均不伪装为正常套餐。

### 5. 订单页和弹窗

订单表格保留当前字段、金额区域判断、订单状态和发票交互。桌面端使用统一卡片外壳与紧凑表头；窄屏端将每条订单转换为可读的堆叠信息块，避免页面横向溢出。

发票弹窗继续保留个人/企业切换、字段校验、提交 loading 和关闭行为。删除账号、销毁套餐等不可逆操作迁移到项目已有 `AlertDialog` 语义，保留确认文案、回调、轮询和错误处理。

## 数据流和依赖边界

```text
AccountPage / AccountOrdersPage
  ├─ session / runtime config / repository hooks
  ├─ account summary + upgrade selectors
  └─ presentational account components
       ├─ cards / rows / badges / progress
       ├─ table / pagination
       └─ Dialog / AlertDialog views
```

展示组件只依赖类型、UI 原语和 `cn`；页面控制层依赖 Session、Repository、计费和区域逻辑。任何账号、套餐、实名和订单写操作仍从当前页面控制层触发。

## 验证方案

- 保留并运行账号页套餐摘要、续费/升级、实名、昵称审核、头像审核、邮箱/手机号绑定和支付方式可见性测试。
- 保留并运行侧栏账户菜单与账号页共享套餐摘要测试，确认 Progress 数值和升级入口口径一致。
- 新增展示层测试，覆盖卡片结构、整页 loading、错误/空状态、Progress ARIA、窄屏订单布局和 AlertDialog 语义。
- 运行 `pnpm lint`、`pnpm typecheck`、聚焦 Vitest 和 `pnpm build`。
- 在本地 `/account` 与 `/account/orders` 验证桌面和窄屏视图，检查控制台无新增错误和页面无意外滚动条。

## 风险与回滚

- 主要风险是拆分展示组件时改变现有条件渲染顺序，尤其是套餐 fallback、实名认证状态和异步刷新时序。通过保留控制层 Hook 和现有行为测试降低风险。
- 如果视觉迁移影响既有业务回归，可先回退展示组件接入，保留独立 UI 原语和测试，不回退计费、实名或订单逻辑。
- 不修改后端和生成文件，回滚范围限于页面展示组件、样式类和相关测试。
