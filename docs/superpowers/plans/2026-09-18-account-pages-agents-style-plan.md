# 账号页与订单页 Agents 风格重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持账号、计费、实名、订单和权限行为不变的前提下，把 `/account` 与 `/account/orders` 的展示层统一为当前 Agents 页面使用的组件规范和交互细节。

**Architecture:** `account-page.tsx` 保留 Session、Repository、区域开关和业务状态，纯展示职责迁移到 `components/account/`。套餐读取与升级资格继续由现有 Hook 负责，展示组件通过明确的 props 和回调消费视图模型。订单页复用相同的页面标题、卡片、按钮、表格和 Dialog 原语。

**Tech Stack:** React 19、TypeScript、Vite/Next client route、Tailwind CSS、Radix UI、shadcn 风格组件、Vitest、Testing Library、现有 Session/Repository/计费 Hook。

## Global Constraints

- 不新增 `any`；新接口使用具体类型或 `unknown`。
- 不修改后端接口、Repository contract、套餐计算、实名门禁、订单状态、区域规则或权限模型。
- 页面卡片使用 `rounded-md`、浅边框和 `shadow-[0_10px_30px_rgba(15,23,42,0.04)]`，不引入渐变或额外视觉依赖。
- 首屏数据未完成时，主内容整体使用 `AgentPageLoadingState`；局部操作继续使用 `Spinner`。
- 图标按钮必须有 `aria-label`；删除账号和销毁套餐使用现有 `AlertDialog` 原语。
- 每个任务先补测试，再实施最小代码；提交前必须运行相关聚焦测试和 `git diff --check`。提交需要先展示 diff 并获得用户确认。
- 保持当前分支和工作区已有 Agent Console 改动，不重置、覆盖或混入无关文件。

---

### Task 1: 建立账户页面共享展示原语

**Files:**
- Create: `frontend/src/components/account/account-surface.tsx`
- Create: `frontend/src/components/account/index.ts`
- Create: `frontend/src/components/account/__tests__/account-surface.test.tsx`
- Reference: `frontend/src/components/ui/card.tsx`, `frontend/src/components/ui/button.tsx`, `frontend/src/components/ui/progress.tsx`, `frontend/DESIGN.md`

**Interfaces:**
- Produces `accountCardClass`、`accountCardHeaderClass`、`AccountSectionHeader`、`AccountInfoRow`、`AccountStatusBadge`、`AccountActionLink`。
- `AccountInfoRow` 接收 `{ label: ReactNode; value: ReactNode; description?: ReactNode; className?: string }`，只负责布局，不执行动作。
- `AccountStatusBadge` 接收 `{ tone: "neutral" | "success" | "warning" | "danger"; children: ReactNode }`。
- `AccountActionLink` 接收 `React.ComponentProps<typeof AppLink>` 兼容的站内链接 props，以及 `icon?: ReactNode`；按钮动作继续由页面传入。

- [ ] **Step 1: 写原语测试。**

  在 `account-surface.test.tsx` 中渲染标题、信息行、四种状态标签和操作链接，断言：
  - 卡片拥有 `rounded-md`、边框和 Agents 统一轻阴影类；
  - 信息行的 label/value 语义可见；
  - 状态标签使用 `data-tone` 区分四种 tone；
  - 操作链接保留 `aria-label` 和原始 href。

- [ ] **Step 2: 运行测试确认失败。**

  Run: `cd frontend && pnpm exec vitest run src/components/account/__tests__/account-surface.test.tsx --maxWorkers=1`

  Expected: FAIL，原因是账户展示原语尚未定义。

- [ ] **Step 3: 实现最小原语。**

  使用 `cn` 合并类名；`accountCardClass` 固定为 `rounded-md border border-black/[0.08] bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]`；`AccountStatusBadge` 只映射现有语义颜色，不新增全局 token；`AccountActionLink` 使用 `AppLink` 并提供 focus-visible ring。

- [ ] **Step 4: 运行测试确认通过。**

  Run: `cd frontend && pnpm exec vitest run src/components/account/__tests__/account-surface.test.tsx --maxWorkers=1`

  Expected: PASS，所有账户共享原语断言通过。

- [ ] **Step 5: 检查差异。**

  Run: `git diff --check -- frontend/src/components/account`

  Expected: 无输出。

### Task 2: 抽取账号页视图模型和资料/安全卡

**Files:**
- Create: `frontend/src/components/account/account-profile-card.tsx`
- Create: `frontend/src/components/account/account-security-card.tsx`
- Create: `frontend/src/components/account/__tests__/account-profile-card.test.tsx`
- Create: `frontend/src/components/account/__tests__/account-security-card.test.tsx`
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Reference: `frontend/src/domain/types.ts`, `frontend/src/lib/avatar-image.ts`, existing account page tests

**Interfaces:**
- `AccountProfileCardProps` 包含当前用户、展示头像、待审核头像/昵称状态、复制 ID 状态、编辑/上传/退出回调及对应 loading/error 文案。
- `AccountSecurityCardProps` 包含邮箱、手机号、实名认证状态、区域开关、绑定/修改/认证/重试回调和成功/失败提示。
- 两个组件只渲染 props，不调用 Session、Repository、runtime config 或导航 Hook。

- [ ] **Step 1: 为资料卡和安全卡补行为锁定测试。**

  测试覆盖头像审核标签、昵称编辑按钮、复制 ID、退出登录、邮箱去绑定/已验证、手机号绑定/修改、实名认证去认证/继续认证/重新同步以及错误提示。每个动作使用传入 mock 回调验证，不直接访问 Repository。

- [ ] **Step 2: 运行测试确认失败。**

  Run: `cd frontend && pnpm exec vitest run src/components/account/__tests__/account-profile-card.test.tsx src/components/account/__tests__/account-security-card.test.tsx --maxWorkers=1`

  Expected: FAIL，组件和 props 尚未定义。

- [ ] **Step 3: 抽取资料卡和安全卡。**

  从 `account-page.tsx` 移出对应 JSX，改用 `AccountInfoRow`、`AccountActionLink`、`Button` 和 `Spinner`。保留现有文案、审核状态、头像上传 input、复制 ID 状态和回调顺序。所有图标按钮补齐 `aria-label`。

- [ ] **Step 4: 在账号页接入组件。**

  `account-page.tsx` 继续持有 `isEditingName`、`editName`、上传/保存/复制/退出状态，把现有回调和派生值传给新组件；删除原资料和安全 JSX，暂不改变外层条件判断。

- [ ] **Step 5: 运行组件和既有账号测试。**

  Run: `cd frontend && pnpm exec vitest run src/components/account/__tests__/account-profile-card.test.tsx src/components/account/__tests__/account-security-card.test.tsx src/pages/marketing/__tests__/account-page-name-audit.test.tsx src/pages/marketing/__tests__/account-page-faceid.test.tsx --maxWorkers=1`

  Expected: 新增组件断言及昵称/头像/实名回归全部 PASS。

### Task 3: 抽取套餐视图模型并统一 Progress/状态卡

**Files:**
- Create: `frontend/src/lib/use-account-subscription-model.ts`
- Create: `frontend/src/components/account/account-subscription-card.tsx`
- Create: `frontend/src/components/account/__tests__/account-subscription-card.test.tsx`
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Reference: `frontend/src/lib/use-account-pass-summary.ts`, `frontend/src/lib/use-pass-upgrade.ts`, `frontend/src/lib/billing-flow.ts`, `frontend/src/lib/account-pass-summary.ts`

**Interfaces:**
- `useAccountSubscriptionModel(options)` 返回 `{ state, pass, displayName, validity, credits, passStatus, actions, dialogs, error }`。
- `AccountSubscriptionCardProps` 只接收上述视图模型的可序列化数据、按钮回调和 `subscribeHref`。
- `credits` 保留 `{ total, used, usedPercent } | null`；未知和错误状态不产生伪造百分比。

- [ ] **Step 1: 写套餐卡测试。**

  使用固定 Pass 构造 active、modifying、expired、isolated、无套餐、0 积分和 80%/95%/100% 使用率，断言套餐状态、日期、升级/续费/销毁入口、Progress 的 `aria-valuenow` 和空状态“立即创建”。

- [ ] **Step 2: 运行测试确认失败。**

  Run: `cd frontend && pnpm exec vitest run src/components/account/__tests__/account-subscription-card.test.tsx --maxWorkers=1`

  Expected: FAIL，套餐展示组件和视图模型尚未存在。

- [ ] **Step 3: 提取模型计算。**

  将当前 `SubscriptionSection` 中的套餐选择、有效期、积分颜色、续费/升级资格和删除条件移到 `use-account-subscription-model.ts`；继续调用现有 `useAccountPassSummary` 和 `usePassUpgrade`，不复制或修改 selector 规则。

- [ ] **Step 4: 实现纯展示套餐卡。**

  用 `Card`/共享账户原语包裹套餐内容，积分区改为 `Progress value={usedPercent}`，数字保留 `tabular-nums`；按钮使用 `Button` 或 `AppLink`；错误和过期/隔离提示就近显示；无套餐状态提供唯一“立即创建”动作。

- [ ] **Step 5: 接回账号页并迁移对话框开关。**

  `account-page.tsx` 通过模型接收 actions/dialogs，保持续费成功后 `refreshPasses` 再清理 fallback、删除套餐轮询后再清理 fallback 的顺序。移除旧 `SubscriptionSection` JSX，保留现有回调实现。

- [ ] **Step 6: 运行套餐和共享口径回归。**

  Run: `cd frontend && pnpm exec vitest run src/components/account/__tests__/account-subscription-card.test.tsx src/pages/marketing/__tests__/account-page-pass-summary.test.tsx src/pages/marketing/__tests__/account-page-renewal.global.test.tsx src/components/site/__tests__/sidebar-user-menu-controller.test.tsx --maxWorkers=1`

  Expected: 套餐卡、账号页和侧栏菜单的积分与升级 href 口径一致，全部 PASS。

### Task 4: 统一账号页首屏 loading、错误态和弹窗语义

**Files:**
- Create: `frontend/src/components/account/account-dialogs.tsx`
- Create: `frontend/src/components/account/__tests__/account-dialogs.test.tsx`
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Reference: `frontend/src/components/ui/dialog.tsx`, `frontend/src/components/ui/alert-dialog.tsx`, `frontend/src/components/agents/agent-state.tsx`, `frontend/src/components/agents/agent-loading-state.tsx`

**Interfaces:**
- `AccountDialogs` 接收受控 open 状态、关闭回调和现有业务 handler；不直接读取 Repository。
- 绑定邮箱、手机号、实名认证使用 `Dialog`；删除账号和销毁套餐使用 `AlertDialog`。
- 页面 loading gate 接收 `authReady`、`isSigningOut`、`subscriptionState` 和 `passesError`，错误态提供页面级 retry callback。

- [ ] **Step 1: 写 loading/error/dialog 语义测试。**

  测试 auth 未完成或套餐摘要为 loading 时只渲染一个 `AgentPageLoadingState`，页面标题、卡片和操作按钮不出现；错误状态渲染 `AgentState` 与重试按钮；删除账号和销毁套餐渲染 `role="alertdialog"` 并支持取消/确认焦点恢复。

- [ ] **Step 2: 运行测试确认失败。**

  Run: `cd frontend && pnpm exec vitest run src/components/account/__tests__/account-dialogs.test.tsx --maxWorkers=1`

  Expected: FAIL，新的整页 loading gate 和共享 Dialog 接入尚未完成。

- [ ] **Step 3: 迁移非破坏性弹窗。**

  将 `ChangePhoneModal` 和 `BindEmailModal` 的外壳迁移到 `DialogContent`，保留字段、校验、错误映射、计时器、成功回调和关闭限制。`VerifyIdentityModal` 已经使用 Radix Dialog 并包含分阶段实名流程，本任务保留其现有 Dialog 结构，只统一外层视觉 token。弹窗内容使用 `DialogHeader`、`DialogTitle`、`DialogDescription`，避免通过首行 margin 撑开标题间距。

- [ ] **Step 4: 迁移破坏性弹窗。**

  将 `DeleteAccountModal` 和 `PassDeleteModal` 接入 `AlertDialog`；确认按钮在异步处理期间禁用并显示 `Spinner`，销毁套餐的轮询和超时文案保持不变。

- [ ] **Step 5: 接入整页 loading/error gate。**

  认证未完成、退出中或套餐首屏摘要处于 loading 时，账号主内容返回 `AgentPageLoadingState title={t("正在加载账号")}`；套餐摘要失败返回 `AgentState` 和已有刷新动作。登录空态仍保留 LoginModal 和游客入口。

- [ ] **Step 6: 运行账号全量聚焦测试。**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/account-page-payment-visibility.test.ts src/pages/marketing/__tests__/account-page-pass-summary.test.tsx src/pages/marketing/__tests__/account-page-name-audit.test.tsx src/pages/marketing/__tests__/account-page-faceid.test.tsx src/pages/marketing/__tests__/account-page-renewal.global.test.tsx src/components/account/__tests__ --maxWorkers=1`

  Expected: 账号行为回归和新 Dialog/loading 测试全部 PASS。

### Task 5: 重构订单页并复用账户页面规范

**Files:**
- Create: `frontend/src/components/account/account-orders-table.tsx`
- Create: `frontend/src/components/account/invoice-dialog.tsx`
- Create: `frontend/src/components/account/__tests__/account-orders-table.test.tsx`
- Create: `frontend/src/components/account/__tests__/invoice-dialog.test.tsx`
- Create: `frontend/src/pages/marketing/__tests__/account-orders-page.test.tsx`
- Modify: `frontend/src/pages/marketing/account-orders-page.tsx`

**Interfaces:**
- `AccountOrdersTableProps` 接收 `orders: readonly OrderItem[]`、`currencyFormatter` 和分页展示信息；不读取 region 全局变量。
- `InvoiceDialogProps` 接收 `open`、`onOpenChange`；保留 personal/enterprise 字段校验和提交 loading。

- [ ] **Step 1: 写订单表格和发票 Dialog 测试。**

  测试桌面表格字段顺序、订单状态标签、国内/国际金额、总条数和分页禁用态；设置窄屏 viewport 后断言订单信息仍可读且没有横向滚动；测试发票个人/企业切换会清空互斥字段、非法表单禁用提交、提交中显示 Spinner。

- [ ] **Step 2: 运行测试确认失败。**

  Run: `cd frontend && pnpm exec vitest run src/components/account/__tests__/account-orders-table.test.tsx src/components/account/__tests__/invoice-dialog.test.tsx --maxWorkers=1`

  Expected: FAIL，展示组件尚未定义。

- [ ] **Step 3: 实现订单卡片和表格。**

  订单页使用 `ProductPageShell footer={null}`；标题使用 `DisplayTitle`；列表外壳使用共享账户卡片类；桌面表格保留当前列，窄屏渲染同一订单数据的堆叠行；按钮使用 `Button`/`AppLink`，不改变 `mockOrders` 数据形状或显示顺序。

- [ ] **Step 4: 实现发票 Dialog。**

  把现有 `InvoiceModal` 的状态迁移到 `invoice-dialog.tsx`，使用 `Dialog` 原语，保留输入校验、提交延迟、关闭回调和区域金额展示规则。

- [ ] **Step 5: 接回订单页并运行测试。**

  Run: `cd frontend && pnpm exec vitest run src/components/account/__tests__/account-orders-table.test.tsx src/components/account/__tests__/invoice-dialog.test.tsx src/pages/marketing/__tests__/account-orders-page.test.tsx --maxWorkers=1`

  Expected: 新增订单表格、发票 Dialog 和订单页集成测试全部 PASS。

### Task 6: 页面集成、视觉回归和质量门禁

**Files:**
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Modify: `frontend/src/pages/marketing/account-orders-page.tsx`
- Modify: account component tests created in Tasks 1-5

- [ ] **Step 1: 运行账号相关聚焦测试。**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/account-page-payment-visibility.test.ts src/pages/marketing/__tests__/account-page-pass-summary.test.tsx src/pages/marketing/__tests__/account-page-name-audit.test.tsx src/pages/marketing/__tests__/account-page-faceid.test.tsx src/pages/marketing/__tests__/account-page-renewal.global.test.tsx src/components/site/__tests__/sidebar-user-menu-controller.test.tsx src/components/account/__tests__ --maxWorkers=1`

  Expected: 所有账号页、订单页、账户菜单和新展示组件测试 PASS。

- [ ] **Step 2: 运行静态质量检查。**

  Run: `cd frontend && pnpm typecheck`

  Expected: typecheck 无新增错误；当前 `frontend/package.json` 没有 lint script，按仓库既有事实记录，不新增检查器或修改 lint 配置。

- [ ] **Step 3: 运行 i18n 和构建检查。**

  Run: `cd frontend && pnpm check && pnpm build`

  Expected: i18n、文档生成、类型基线和生产构建通过；若存在已有非阻断提示，记录其原始输出，不修改无关翻译或生成文件。

- [ ] **Step 4: 浏览器回归。**

  在本地预览中访问 `/account` 和 `/account/orders`，分别检查 1280px 桌面与 390px 窄屏：首屏 loading 居中且不混入局部内容；登录空态、已登录资料/套餐卡、积分 Progress、订单表格、发票 Dialog 和错误/空状态正常；页面根节点没有意外横向滚动条。

- [ ] **Step 5: 展示最终差异并等待提交确认。**

  Run: `git diff --stat && git diff --check && git status --short`

  Expected: 只包含本次账号页设计文档、账户展示组件、账号/订单页接入及对应测试；先向用户展示提交范围，再等待明确的 `git commit`/`git push` 授权。

## 执行备注

- 设计文档：`docs/superpowers/specs/2026-09-18-account-pages-agents-style-design.md`。
- 当前工作区已有 Agent Console 未提交改动，执行时必须按文件边界操作，不得使用 `git reset --hard`、`git checkout --` 或全量格式化。
- 若某个既有测试依赖旧 DOM 结构，只更新展示断言，不改变业务状态或 Repository mock 的语义。
