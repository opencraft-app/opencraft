# /subscribe 季付询价与下单放开

**Goal:** 放开订阅页“季付”付费时长，让用户切换季付后按 `time_span=3&time_unit=m` 重新询价，并在下单时以 `period=3,time_unit=m` 创建订单。

**Scope:** 仅调整 `/subscribe` 订阅页前端交互、展示文案和 i18n 资源；不修改后端接口、套餐配置、支付桥接页、实名/邀请/已订阅锁定规则或 AI 增强版“敬请期待”策略。

## 任务清单

- [x] 1. 放开季付时长并修正展示/确认链路。
  - 角色：Developer + Reviewer
  - 影响文件：`frontend/next-site/subscribe-page.tsx`、`frontend/src/i18n/generated/*.json`
  - 验收方式：季付按钮不再 disabled；点击季付后已登录付费态调用 `/v1/bundles?time_span=3&time_unit=m` 询价；确认订单展示 `3个月`；支付下单继续通过现有 `createPassOrder` 传 `period=3,time_unit=m`；月付链路保持 `1个月` 与 `/ 月`；`pnpm i18n:check`、`pnpm check`、`git diff --check` 通过。

## 规划门禁

- 规模：S；执行模式：single_agent。
- 不新增依赖、路由、后端接口或公共数据模型。
- 既有询价/下单 repository 契约已支持 `time_span/time_unit` 与 `period/time_unit`，本次只解除 UI 禁用并修正用户可见周期文案。
- 规划门禁结论：通过。

---

# 中国站首页站点切换入口

**Goal:** 在中国站首页挂载国际站现网已有的站点切换器，保持国际站实现与行为不变。

## 任务清单

- [x] 1. 在中国站首页显示既有站点切换器并完成双站回归验证。
  - 角色：Developer + Reviewer
  - 影响文件：`frontend/src/components/site/language-switcher.tsx`、`frontend/src/components/site/__tests__/language-switcher.test.tsx`、`frontend/src/pages/marketing/landing-page.tsx`、`frontend/next-site/public-pages.tsx`、`frontend/src/components/site/public-site-header.tsx`、`frontend/next-site/public-header-auth-island.tsx`
  - 验收方式：中国站首页显示与国际站现网一致的 36px 浅灰胶囊切换器，下拉依次展示 `中国站 / 国际站 - 中文 / 国际站 - English` 并标记中国站为当前项；跨站点选择在新浏览器窗口打开；国际站原有 `Intl - English / Intl - 中文 / China Site` 文案与顺序不变；入口位于 Create Now 左侧，宽屏下三个操作整体向右微移；1024px 起保留完整顶部导航且不重叠，更窄时收起；相关测试、类型检查与 `git diff --check` 通过。

## 规划门禁

- 规模：S；执行模式：single_agent。
- 仅挂载和调整既有站点切换组件的页头布局，不新增依赖、接口或页面，不重写国际站切换逻辑。
- 规划门禁结论：通过。

---

# 实名认证流程体验优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变配色、认证接口和业务状态机的前提下，把实名认证三阶段弹窗改造成稳定、流畅、可访问的产品化向导，并提供本地可见预览。

**Architecture:** 保留 `VerifyIdentityModal` 现有 API 调用、轮询与阶段状态，抽取无副作用的 `RealnameStepper` 展示组件，集中重构弹窗壳体和各阶段视图。弹窗改用现有 Radix Dialog primitive，阶段切换只动画 opacity/transform；错误就近关联但继续复用现有错误码映射。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS 4、Radix Dialog、Framer Motion、Vitest、Testing Library。

## Global Constraints

- 不修改现有黑白灰配色、后端接口、错误码、轮询频率、实名准入规则和国际站行为。
- 不新增依赖，不存储姓名、身份证号或核身地址。
- 遮罩点击不关闭；支持 Esc、焦点锁定和关闭后焦点恢复。
- 动效只使用 opacity/transform，不超过 200ms，并尊重 reduced motion。
- 成功仍以刷新后的 `user.realnameVerified` 为唯一真源。

---

### Task 1: 锁定向导结构与可访问性契约

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/account-page-faceid.test.tsx`
- Create: `frontend/src/pages/marketing/realname-stepper.tsx`
- Create: `frontend/src/pages/marketing/__tests__/realname-stepper.test.tsx`

**Interfaces:**
- Produces: `RealnameStepper({ stage, includePhoneStep, labels })`
- Consumes: `stage: "identity" | "face" | "phone" | "shadow"`

- [x] **Step 1: 为步骤轨道写失败测试**

```tsx
render(<RealnameStepper stage="face" includePhoneStep labels={labels} />);
expect(screen.getByText("身份信息").closest("li")).toHaveAttribute("data-state", "complete");
expect(screen.getByText("人脸核身").closest("li")).toHaveAttribute("aria-current", "step");
```

- [x] **Step 2: 为 Dialog 行为和静态证件类型写失败测试**

```tsx
expect(screen.getByRole("dialog", { name: "实名认证" })).toBeInTheDocument();
expect(screen.queryByRole("combobox", { name: "证件类型" })).not.toBeInTheDocument();
await userEvent.keyboard("{Escape}");
expect(screen.queryByRole("dialog", { name: "实名认证" })).not.toBeInTheDocument();
```

- [x] **Step 3: 运行测试并确认仅因新契约未实现而失败**

Run:
`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/realname-stepper.test.tsx src/pages/marketing/__tests__/account-page-faceid.test.tsx`

Expected: 新步骤组件不存在，现有手写弹窗没有 dialog 语义。

- [x] **Step 4: 实现最小步骤组件**

使用有序列表、弹性连接线、`data-state` 和 `aria-current="step"`；完成态显示 Check，连接线不写固定像素宽度。

- [x] **Step 5: 运行步骤组件测试**

Run:
`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/realname-stepper.test.tsx`

Expected: PASS。

### Task 2: 重构实名弹窗壳体与三个阶段

**Files:**
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/account-page-faceid.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `RealnameStepper`
- Preserves: `VerifyIdentityModal` props、Repository 方法和 `applyAttemptState`

- [x] **Step 1: 把手写 fixed overlay 替换为受控 Radix Dialog**

```tsx
<Dialog open onOpenChange={(open) => {
  if (!open) onClose();
}}>
  <DialogContent onPointerDownOutside={(event) => event.preventDefault()}>
    <DialogTitle>{verified ? t("修改实名认证") : t("实名认证")}</DialogTitle>
  </DialogContent>
</Dialog>
```

- [x] **Step 2: 实现稳定的头部、阶段画布和响应式操作区**

头部合并标题与步骤轨道；画布使用 `AnimatePresence mode="wait"` 和不超过 0.18 秒的 opacity/y 动效；桌面按钮右对齐，移动端占满。

- [x] **Step 3: 重排身份信息阶段**

证件类型改为普通静态信息行；保留姓名、身份证输入和隐私同意；为字段补稳定 id、`aria-invalid`、`aria-describedby` 和 `autoComplete`。

- [x] **Step 4: 重排人脸阶段**

桌面端使用二维码与步骤说明的单层布局；移动端直接打开刷脸页面；等待、过期、失败状态占用同一状态区域，保留现有轮询和重启动作。

- [x] **Step 5: 重排手机与 Shadow 阶段**

手机号、验证码和发送按钮使用统一高度；验证码错误就近展示；Shadow 使用 `role="status"`，自动同步时不渲染空白 footer。

- [x] **Step 6: 运行完整 FaceID 目标测试**

Run:
`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/realname-stepper.test.tsx src/pages/marketing/__tests__/account-page-faceid.test.tsx`

Expected: PASS，现有桌面二维码、移动端直开、轮询、过期、手机号和最终成功行为无回归。

### Task 3: 静态检查与本地视觉验收

**Files:**
- Modify: `frontend/DESIGN.md`
- Modify: `frontend/openspec/plan.md`

**Interfaces:**
- Consumes: 完成后的实名向导
- Produces: 可复用的多阶段 Dialog 设计规则与本地预览证据

- [x] **Step 1: 记录多阶段 Dialog 规则**

补充稳定壳体、自适应步骤轨道、桌面紧凑操作区、移动端全宽按钮以及仅动画 opacity/transform 的规范。

- [x] **Step 2: 运行质量门禁**

Run:
`pnpm check && pnpm i18n:check`

Expected: 两条命令 exit 0。

- [x] **Step 3: 运行差异检查**

Run:
`git diff --check`

Expected: exit 0，无空白错误。

- [x] **Step 4: 启动国内站本地预览**

Run:
`NEXT_PUBLIC_REGION=cn VITE_REGION=cn NEXT_PUBLIC_AUTH_API_BASE_URL=https://lightclaw.tech VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm exec next dev --webpack -H 127.0.0.1 -p 3300`

Expected: `http://127.0.0.1:3300/account` 使用真实后端接口并可访问。

- [x] **Step 5: 浏览器验收**

验证身份页、二维码页、手机号页、Shadow/错误状态和 390px 移动端；确认无横向溢出、无大面积布局跳动、控制台无新增错误。

### Task 4: 收敛实名错误为无容器行内校验

**Files:**
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/account-page-faceid.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

**Interfaces:**
- Produces: 按 `RepositoryError.code` 分类的字段错误对象，包含 `code`、用户标题、解决建议和关联字段。
- Preserves: 现有 Repository 调用、提交状态、阶段推进和后端错误码。

- [x] **Step 1: 写失败测试**

断言 `phone_in_use` 显示“该手机号暂不可使用”和解决建议，不显示技术错误码；断言 `realname_mismatch` 显示“身份信息未通过核验”，关联字段均具备 `aria-invalid` 和 `aria-describedby`。

- [x] **Step 2: 运行测试确认失败原因**

Run:
`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/account-page-faceid.test.tsx --reporter=dot`

Expected: FAIL，当前错误仍是弹窗底部裸红字且 `phone_in_use` 回退到后端原始 message。

- [x] **Step 3: 实现最小错误分类与行内视图**

使用无背景、无边框、无圆角的图标 + 标题 + 次级说明结构；输入框只增加轻微错误描边。修改相关字段时清除对应错误，未归类错误保留在阶段底部。

- [x] **Step 4: 生成翻译并运行质量门禁**

Run:
`pnpm i18n:extract && pnpm i18n:check && pnpm check && pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/realname-stepper.test.tsx src/pages/marketing/__tests__/account-page-faceid.test.tsx --reporter=dot && git diff --check`

Expected: 全部 exit 0。

- [x] **Step 5: 在 3300 真实接口页面回验**

确认手机号占用和姓名证件不一致均集中显示在阶段底部、技术码隐藏、修改字段后提示消失，且错误出现不会破坏移动端布局。

### Task 5: 固定表单底部错误槽

**Files:**
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/account-page-faceid.test.tsx`

**Interfaces:**
- Produces: 身份信息、手机验证等阶段共用的固定高度底部错误槽。
- Preserves: 输入框错误描边、`aria-describedby`、错误清除逻辑和错误文案。

- [x] **Step 1: 写失败测试**

断言提交前错误槽已经存在且预留固定高度；错误出现后复用同一错误槽，并位于协议或当前阶段最后一个输入控件之后。

- [x] **Step 2: 运行测试确认失败**

Run:
`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/account-page-faceid.test.tsx --reporter=dot`

Expected: FAIL，当前错误插入字段与协议之间，且无固定高度错误槽。

- [x] **Step 3: 将错误统一移动到底部槽**

删除字段之间的错误节点，在阶段内容末尾永久渲染桌面端 `min-h-[52px]`、移动端 `min-h-[72px]` 的错误槽；错误与轮询异常复用该位置，不动画高度。

- [x] **Step 4: 运行聚焦测试与质量门禁**

Run:
`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/realname-stepper.test.tsx src/pages/marketing/__tests__/account-page-faceid.test.tsx --reporter=dot && pnpm i18n:check && pnpm check && git diff --check`

Expected: 全部 exit 0。

### Task 6: 复用操作栏安全说明区域承载错误

**Files:**
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/account-page-faceid.test.tsx`

**Interfaces:**
- Produces: 操作栏左侧稳定反馈区域，无错误时显示安全说明，有错误时原位替换。
- Removes: 表单内容区永久占位的空白错误槽。

- [x] **Step 1: 写失败测试**

断言无错误时反馈区域显示安全说明；错误出现后复用同一节点展示错误且安全说明消失；反馈区域位于表单之后、主按钮之前。

- [x] **Step 2: 运行测试确认失败**

Run:
`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/account-page-faceid.test.tsx --reporter=dot`

Expected: FAIL，当前实现仍渲染空白错误槽，操作栏安全说明不会被错误替换。

- [x] **Step 3: 实现操作栏反馈区域**

删除内容区错误槽，将错误和轮询异常移动到操作栏左侧；无错误时显示原有安全说明。FaceID Shadow 阶段继续在既有状态区原位展示异常。

- [x] **Step 4: 运行聚焦测试与质量门禁**

Run:
`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/realname-stepper.test.tsx src/pages/marketing/__tests__/account-page-faceid.test.tsx --reporter=dot && pnpm i18n:check && pnpm check && git diff --check`

Expected: 全部 exit 0。

### Task 7: 移除表单阶段固定高度留白

**Files:**
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/account-page-faceid.test.tsx`

**Interfaces:**
- Produces: 身份信息和手机验证阶段按内容自然撑高。
- Preserves: 人脸二维码、等待、失败和同步状态所需的最小高度。

- [x] **Step 1: 写失败测试**

断言身份信息和手机验证的阶段内容容器不再带 `min-h-[248px]`。

- [x] **Step 2: 运行测试确认失败**

Run:
`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/account-page-faceid.test.tsx --reporter=dot`

Expected: FAIL，当前阶段外层仍统一设置固定最小高度。

- [x] **Step 3: 删除外层固定最小高度**

移除阶段外层 `min-h-[248px]`；人脸与 Shadow 子视图现有 `min-h-[248px]` 保持不变。

- [x] **Step 4: 运行聚焦测试与质量门禁**

Run:
`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/realname-stepper.test.tsx src/pages/marketing/__tests__/account-page-faceid.test.tsx --reporter=dot && pnpm i18n:check && pnpm check && git diff --check`

Expected: 全部 exit 0。

### Task 8: 处理实名向导 AI 评审意见

**Files:**
- Modify: `frontend/src/pages/marketing/realname-stepper.tsx`
- Modify: `frontend/src/pages/marketing/account-page.tsx`

**Interfaces:**
- Produces: 阶段值与错误字段值的单一常量来源。
- Preserves: 实名阶段状态机、错误映射、布局与交互行为。

- [x] **Step 1: 统一阶段与错误字段常量**

使用 `as const` 元组派生步骤类型，使用 `REALNAME_ERROR_FIELD` 对象派生错误字段类型，消除重复魔法字符串。

- [x] **Step 2: 替换新增 UI 中的硬编码颜色**

使用项目已有的 `--danger`、`--text-primary`、`--text-secondary`、`--text-tertiary`、`--surface-muted` 和 `--border-strong`，不引入评审建议中不存在的变量。

- [x] **Step 3: 运行聚焦测试与质量门禁**

Run:
`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/realname-stepper.test.tsx src/pages/marketing/__tests__/account-page-faceid.test.tsx --reporter=dot && pnpm i18n:check && pnpm check && git diff --check`

Expected: 全部 exit 0。

### Task 9: 恢复实名控件可见对比度

**Files:**
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/theme/preset.ts`
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/account-page-faceid.test.tsx`

**Interfaces:**
- Produces: `--realname-control-border` 与 `--realname-control-muted` 可覆盖主题变量。
- Preserves: 评审修复中的常量类型安全与无硬编码颜色约束。

- [x] **Step 1: 写失败测试**

断言身份证类型栏使用实名专用弱背景 token，姓名与身份证输入框使用实名专用边框 token。

- [x] **Step 2: 恢复原设计对比度**

在根主题与 LightVela preset 中定义实名控件 token，恢复 `#F2F4F8` 弱背景和 `#E9ECF1` 边框，并替换错误的通用 token 引用。

- [x] **Step 3: 运行聚焦测试与质量门禁**

Run:
`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/realname-stepper.test.tsx src/pages/marketing/__tests__/account-page-faceid.test.tsx --reporter=dot && pnpm i18n:check && pnpm check && git diff --check`

Expected: 全部 exit 0。

## 规划门禁

- 规模：M；执行模式：single_agent。
- 已确认现有 Radix Dialog、Framer Motion、二维码和测试能力足够，无需 capability 或新依赖。
- 已覆盖 loading、错误、过期、恢复、两步/三步和移动端边界。
- 明确排除接口、配色、轮询、实名规则、国际站与身份证校验算法变更。
- 规划门禁结论：通过，可进入实现。

---

# 精选技能轮播按钮位置调整

---

# 2026-07-16 Hermes Agent 今晚升级公告

**Goal:** 基于最新 master 更新首页 Hermes Agent 升级公告，让国内站和国际站今晚继续展示升级窗口提醒。

**Scope:** 仅更新首页公告条、对应中英文 i18n 字典和本计划；不调整公告视觉结构、路由、登录态、后端接口或转付费公告逻辑。

## 任务清单

- [x] 1. 将 Hermes Agent 升级公告切换到 2026-07-16 22:00 至 2026-07-17 02:00。
  - 角色：Developer
  - 影响文件：`frontend/src/components/site/maintenance-announcement-banner.tsx`、`frontend/src/i18n/generated/*.json`
  - 验收方式：国内站文案使用北京时间，国际站文案使用新加坡时间；公告 ID 更新，避免复用上一次关闭记忆；过期时间为 UTC 2026-07-16 18:00。
- [x] 2. 完成双站基础验证。
  - 角色：Reviewer
  - 验收方式：`pnpm i18n:check`、`pnpm check`、`NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm check`、关联 Vitest、`git diff --check` 通过。

---

# 当前执行计划：清理 Agent 创建完成后的 URL creating 参数

> 分支：`frontsandbox/fix-agents-creating-query`
> 规模：S
> 范围：修复开通 Pass 后创建参数未清理，以及 Agent 功能 Tab 继承创建参数后无法正常跳转的问题。

## 任务清单

- [x] 1. 定位 `/agents` 创建中 URL 参数的写入、轮询和实例成功识别链路。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/agent-settings-page.tsx` 及相关测试。
  - 验收方式：明确 `creating` / `plan` 参数为何未在实例就绪后清理。
  - 结果：订阅页创建实例后写入 `creating` 和未消费的 `plan`；Agent 功能 Tab 又无条件继承 `location.search`，导致 section 页面重新进入创建流程并被终态跳转拉回 `/agents`。
- [x] 2. 收敛创建参数和 Agent section 路由契约，并补充针对性回归测试。
  - 角色：Developer + Reviewer
  - 影响文件：`frontend/next-site/subscribe-page.tsx`、`frontend/src/lib/agent-routes.ts`、`frontend/src/lib/__tests__/agent-routes.test.ts`、`frontend/src/pages/marketing/agent-settings-page.tsx`
  - 验收方式：创建入口只携带 `creating`；实例进入终态后 replace 回 `/agents`；功能 Tab 不继承创建参数；目标测试与 `pnpm check` 通过。
  - 结果：套餐页改用统一的 `getAgentCreatingPath`，不再传递无消费方的 `plan`；创建终态保持回 `/agents` 的产品语义；Agent section URL 改用显式白名单，当前不透传任何 query；16 条相关测试、`pnpm check` 与 `git diff --check` 通过。

## 验收重点

- 不影响创建中等待页展示。
- 不影响刷新恢复时从已有 provisioning 实例回写 `creating` 参数。
- 清理 URL 使用 replace，避免浏览器历史栈多出一条创建中 URL。
- 功能 Tab 不得继承 `creating` 或其他未声明的查询参数。

---

# 2026 年 7 月 Changelog：自动任务稳定调用技能

**Goal:** 在国内站与国际站 Changelog 中新增一条 2026 年 7 月动态，说明自动任务可显式选择需要调用的技能，并用真实中英文界面截图展示该能力。

**Scope:** 仅更新 Changelog 数据、对应中英文截图、国际化字典和聚焦回归测试；不修改自动任务、Skill 选择器或 Hermes Cron 的既有功能逻辑。

## 任务清单

- [x] 1. 新增中英文 Changelog 动态与地区化截图。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/changelog-page.tsx`、`frontend/public/assets/changelog/automation-skill-invocation*.png`
  - 验收方式：2026 年 7 月在国内站和国际站均展示“自动任务支持调用技能”动态；国内站使用中文截图，国际站使用英文截图，国际站切换中文后仍保持国际版图片。
  - 结果：新增 820×282 的中英文真实界面素材；国内站加载中文图，国际站英文与中文模式均加载英文图。
- [x] 2. 补充回归测试、国际化资源并完成双站验证。
  - 角色：Reviewer
  - 影响文件：`frontend/src/pages/marketing/__tests__/channel-copy.test.tsx`、`frontend/src/i18n/generated/*.json`
  - 验收方式：目标 Vitest、`pnpm check`、`pnpm i18n:check`、`git diff --check` 通过；本地 `/changelog` 中英文展示与图片均可见。
  - 结果：聚焦测试、TypeScript 检查、i18n 一致性和 diff 检查均通过；浏览器已验证国内站中文、国际站英文及国际站中文三种展示。

## 规划门禁

- 规模：S；执行模式：single_agent。
- 现有 Changelog 已采用 `isGlobal` 选择地区图片、`useT()` 维护中英文文案，沿用同一模式。
- 不新增依赖、路由、组件或 API；不改变已有 2026-07 技能包条目的国内站范围。
- 能力声明：使用真实本地产品界面截图与聚焦浏览器 smoke。
- 规划门禁结论：通过。

---

# 自动任务调用 Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` and `superpowers:verification-before-completion` to execute this plan task-by-task. The approved `/feai-start` orchestration for this M-sized change is `single_agent`, so implementation stays in the current agent lane.

**Goal:** 让用户在 LightVela 自动任务的创建、编辑和详情中安全地绑定零个或一个当前 Agent 已安装的 Hermes Skill。

**Architecture:** 抽取无 React 依赖的 Hermes 已安装 Skill 共享模块，自动任务面板独立维护加载状态，并通过聚焦的选择器组件呈现搜索和异常状态。创建继续使用现有 `CreateCronJobInput.skills`；编辑新增可测试的三态命令构造，明确区分保持、替换与清空。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS、lucide-react、Hermes CLI、Vitest 4、Testing Library、现有中文即 key i18n。

---

## 0. 执行约束

- 需求规模：M。
- 角色：`single_agent`（实现、测试和验证由同一执行者完成）。
- 需求来源：已确认 PRD《自动任务支持调用 Skill》及 `frontend/openspec/proposal.md`。
- 不新增依赖、路由、后端接口、SDK 改动或数据库迁移。
- 严格 TDD：每个行为先写失败测试、确认失败原因，再写最小实现。
- 项目要求 commit/push/MR 前必须展示内容并取得用户确认；因此不在每个小任务后自动提交，最终统一进入显式提交确认门禁。
- 任何实现不得修改 `frontend/openspec/changes/` 中的历史归档。

## 1. 文件职责图

| 文件 | 动作 | 单一职责 |
| --- | --- | --- |
| `frontend/src/lib/hermes-skills-client.ts` | Create | 已安装 Skill 命令、解析、去重、展示名和加载 helper。 |
| `frontend/src/lib/__tests__/hermes-skills-client.test.ts` | Create | 共享 Skill helper 的纯函数与加载行为测试。 |
| `frontend/src/pages/marketing/hermes-agent-experts-panel.tsx` | Modify | 删除页面内重复 helper，改为 import 共享模块。 |
| `frontend/src/pages/marketing/__tests__/hermes-agent-experts-panel.test.tsx` | Modify | 移除已迁移的 helper 单测/import，保留专家包行为覆盖。 |
| `frontend/src/lib/hermes-cron-client.ts` | Modify | 增加 `buildEditCommand` 和 Skill patch 三态语义。 |
| `frontend/src/lib/__tests__/hermes-cron-client.test.ts` | Modify | 覆盖 create/edit 的有 Skill、无 Skill、替换、清空和 shell quoting。 |
| `frontend/src/pages/marketing/automation-skill-picker.tsx` | Create | 自定义单选、搜索、加载/空/失败/不可用状态和详情摘要。 |
| `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx` | Create | 选择器和详情摘要的 Testing Library 测试。 |
| `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx` | Modify | Skill 状态加载、表单接线、提交校验、创建/编辑映射、详情字段。 |
| `frontend/src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts` | Modify | 表单映射、失效策略和多 Skill 保持的纯逻辑测试。 |
| `frontend/src/i18n/generated/zh-CN.json` | Generate | 新中文文案字典。 |
| `frontend/src/i18n/generated/en-US.json` | Generate/Modify | 新英文翻译。 |
| `frontend/src/i18n/generated/zh-to-key.json` | Generate | 中文 key 到 hash 的映射。 |

## 2. 验收映射

| PRD 验收项 | 对应任务 |
| --- | --- |
| 1、2：可选单选、已安装列表、搜索 | Task 1、Task 3 |
| 3、4：创建时写一个 slug / 未选择保持旧行为 | Task 2、Task 4 |
| 5、6：编辑回显、更换、移除、未改保持 | Task 2、Task 4 |
| 7、8：详情与不可用状态 | Task 3、Task 5 |
| 9：空态和失败不阻断普通任务 | Task 3、Task 4 |
| 10：历史任务兼容 | Task 2、Task 4、Task 7 |
| 11、12：双站与中英文 | Task 6、Task 7 |
| 13：隐私 | Task 4、Task 7 |

### Task 1: 抽取共享的已安装 Skill 客户端

**角色：** single_agent / implementation

**Files:**
- Create: `frontend/src/lib/hermes-skills-client.ts`
- Create: `frontend/src/lib/__tests__/hermes-skills-client.test.ts`
- Modify: `frontend/src/pages/marketing/hermes-agent-experts-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/hermes-agent-experts-panel.test.tsx`

**验收方式：** 新共享测试通过；专家包测试继续通过；自动任务页面无需 import 专家包页面。

- [x] **Step 1: 先写共享 helper 的失败测试**

覆盖以下契约：

```ts
expect(buildInstalledSkillsListCommand()).toContain("hermes_cli.main skills list");
expect(parseInstalledSkillSlugs(jsonOutput)).toEqual(["market-data", "backtest-engine"]);
expect(parseInstalledSkillSlugs(tableOutput)).toEqual(["cody"]);
expect(parseInstalledSkillSlugs(" alpha \nalpha\nbeta\n")).toEqual(["alpha", "beta"]);
expect(formatInstalledSkillDisplayName("finance-news")).toBe("Finance News");
expect(matchesInstalledSkillSearch("finance-news", "Finance News", "news")).toBe(true);
```

- [x] **Step 2: 运行测试并确认因模块不存在而失败**

Run:

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts src/lib/__tests__/hermes-skills-client.test.ts
```

Expected: FAIL，原因是 `@/lib/hermes-skills-client` 尚不存在，而不是测试环境错误。

- [x] **Step 3: 实现最小共享模块**

模块至少导出：

```ts
export const buildInstalledSkillsListCommand: () => string;
export const getUniqueSkillSlugs: (slugs: string[]) => string[];
export const parseInstalledSkillSlugs: (output: string) => string[];
export const formatInstalledSkillDisplayName: (slug: string) => string;
export const matchesInstalledSkillSearch: (slug: string, displayName: string, query: string) => boolean;
export const listInstalledSkillSlugs: (botId: string) => Promise<string[]>;
```

`listInstalledSkillSlugs` 调用现有 `execCommand`，只返回解析后的 slug；不吞掉错误，由调用方决定 UI 状态。

- [x] **Step 4: 让专家包页面改用共享 helper**

删除页面内的命令常量、去重和 parser 实现；保留专家包专属的安装、重试和 SkillHub 数据逻辑。把 parser 纯单测迁移到新测试文件，专家包组件测试继续从真实共享模块运行。

- [x] **Step 5: 运行共享和专家包测试**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts \
  src/lib/__tests__/hermes-skills-client.test.ts \
  src/pages/marketing/__tests__/hermes-agent-experts-panel.test.tsx
```

Expected: 两个测试文件全部 PASS。

### Task 2: 扩展 Hermes Cron 编辑命令的 Skill 三态

**角色：** single_agent / implementation

**Files:**
- Modify: `frontend/src/lib/hermes-cron-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-cron-client.test.ts`

**验收方式：** 纯命令测试证明 create/edit 在保持、替换、清空时生成正确 CLI，特殊字符被安全 quote。

- [x] **Step 1: 写 `buildEditCommand` 的失败测试**

```ts
expect(buildEditCommand("job-1", { name: "daily" }))
  .toBe("hermes cron edit 'job-1' --name 'daily'");
expect(buildEditCommand("job-1", { skills: ["report's-helper"] }))
  .toBe("hermes cron edit 'job-1' --skill 'report'\\''s-helper'");
expect(buildEditCommand("job-1", { skills: [] }))
  .toBe("hermes cron edit 'job-1' --clear-skills");
expect(buildEditCommand("job-1", {})).not.toContain("skill");
```

同时补充 `buildCreateCommand` 的单 Skill 断言。

- [x] **Step 2: 运行目标测试并确认失败**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts src/lib/__tests__/hermes-cron-client.test.ts
```

Expected: FAIL，原因是 `buildEditCommand` / `skills` patch 尚未实现。

- [x] **Step 3: 实现明确的 patch 类型和纯命令构造**

```ts
export interface EditCronJobPatch {
  schedule?: string;
  prompt?: string;
  name?: string;
  deliver?: string;
  script?: string;
  skills?: string[];
}
```

规则：`undefined` 不输出；空数组输出一次 `--clear-skills`；非空数组对每个值输出 `--skill`。UI 虽只传一个值，客户端保持 Hermes 官方 repeated flag 兼容性。

- [x] **Step 4: 让 `editCronJob` 只执行 `buildEditCommand`**

保持 `execCommand` 错误模型不变，不新增网络层和异常包装。

- [x] **Step 5: 运行 Cron 客户端测试**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts src/lib/__tests__/hermes-cron-client.test.ts
```

Expected: 全部 PASS，原有解析、测试运行和有效期脚本测试无回归。

### Task 3: 实现可搜索的单 Skill 选择器

**角色：** single_agent / implementation

**Files:**
- Create: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Create: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`

**验收方式：** Testing Library 覆盖默认提示、搜索、选择、loading、空态、失败重试、不可用绑定、不显示清空项与辅助提示，以及 ARIA。

- [x] **Step 1: 先写组件失败测试**

测试 props 契约：

```ts
interface AutomationSkillPickerProps {
  value: string;
  loadState: InstalledSkillLoadState;
  onChange: (slug: string) => void;
  onRetry: () => void;
}
```

至少验证：

- 初始 trigger 显示灰色未选择提示；
- 输入 `news` 只保留 `finance-news`；
- 选择后 `onChange("finance-news")`；
- 下拉只展示已安装 Skill，不提供“不调用 Skill”选项；
- error 显示重试且调用 `onRetry`；
- ready 空数组显示前往 `/agents/skills`；
- value 不在 ready 列表时仍显示 slug 和“不可用”；
- 存在非交互环境提示；
- trigger 有 `aria-expanded`，搜索输入有可访问名称。

- [x] **Step 2: 运行组件测试并确认失败**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/automation-skill-picker.test.tsx
```

Expected: FAIL，原因是组件不存在。

- [x] **Step 3: 实现最小无依赖自定义下拉**

使用 React state、Tailwind 和现有 lucide 图标；不引入 Command/Popover 新依赖。组件关闭后清空搜索词，使用共享格式化和匹配 helper，保存值始终是传入 options 的真实 slug。

- [x] **Step 4: 增加详情摘要组件或纯展示 helper**

同文件导出 `AutomationSkillBindingSummary`，根据 `value + loadState` 渲染可用、不可用、确认中或暂无法确认状态，供详情弹窗复用并测试。

- [x] **Step 5: 运行组件测试**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/automation-skill-picker.test.tsx
```

Expected: 全部 PASS。

### Task 4: 接入自动任务加载、创建与编辑

**角色：** single_agent / implementation

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts`

**验收方式：** 纯 helper 测试证明 create/edit 映射正确，表单中选择器位置正确，加载失败不改变 `canSubmit` 的普通任务路径。

- [x] **Step 1: 写表单映射和提交策略的失败测试**

计划导出并测试小型纯函数，避免通过巨大页面 DOM 间接验证命令：

```ts
expect(toCreateCronSkills("")).toBeUndefined();
expect(toCreateCronSkills("finance-news")).toEqual(["finance-news"]);
expect(toEditCronSkills(["finance-news"], "finance-news")).toBeUndefined();
expect(toEditCronSkills(["finance-news"], "market-data")).toEqual(["market-data"]);
expect(toEditCronSkills(["finance-news"], "")).toEqual([]);
expect(toEditCronSkills(["first", "second"], "first")).toBeUndefined();
```

再覆盖提交验证：新选择被 ready 列表确认缺失时拒绝；原本已不可用且未修改时允许保持；error 状态下无 Skill 的普通任务允许提交。

- [x] **Step 2: 运行现有自动任务测试并确认新增断言失败**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts
```

Expected: FAIL，原因是映射 helper 尚不存在。

- [x] **Step 3: 在 `HermesAgentAutomationsPanel` 增加独立 Skill 加载状态**

- `botId` 变化时调用 `listInstalledSkillSlugs`；
- 状态为 idle/loading/ready/error；
- 提供 `refreshInstalledSkills` 给选择器重试和提交前校验；
- 失败不复用自动任务 `listError`，不阻断 Cron job 列表；
- 所有创建入口（空白、模板）和编辑入口共享同一状态。

- [x] **Step 4: 把选择器接入 `AutomationFormModal`**

- 位置严格在任务说明后、生效时间段前；
- state 初始值为 `initialJob?.skills[0] ?? ""`；
- create 调用增加 `skills: toCreateCronSkills(selectedSkill)`；
- edit 只有 `toEditCronSkills(...) !== undefined` 时写 `patch.skills`；
- 新建/变更选择在提交前验证，确认已卸载时保留表单并显示错误；
- Skill load error 不进入 `canSubmit`，因此未选择 Skill 的任务仍可提交。

- [x] **Step 5: 检查隐私边界**

确认现有 `automation_create_btn` 和 `AUTOMATION_CREATE_SUCCESS` 埋点仍只携带 `bot_id` 等非敏感字段；不新增 prompt、slug、Skill 内容或自定义名称参数。

- [x] **Step 6: 运行自动任务与 Cron 测试**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts \
  src/lib/__tests__/hermes-cron-client.test.ts
```

Expected: 全部 PASS。

### Task 5: 接入任务详情的绑定状态

**角色：** single_agent / implementation

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`

**验收方式：** 详情摘要测试覆盖未绑定、可用、不可用、loading 和 error；详情弹窗实际使用同一共享状态。

- [x] **Step 1: 先补充详情摘要失败测试**

```ts
renderSummary({ value: "", status: "ready", slugs: [] });
expect(screen.getByText("不调用 Skill")).toBeInTheDocument();

renderSummary({ value: "finance-news", status: "ready", slugs: [] });
expect(screen.getByText("不可用")).toBeInTheDocument();
```

并分别断言 ready 命中、loading、error 文案。

- [x] **Step 2: 在详情弹窗增加“调用 Skill”字段**

使用 `job.skills[0] ?? ""` 和面板级 `loadState` 渲染 `AutomationSkillBindingSummary`。不得在详情打开/关闭时修改 job 或自动清空绑定。

- [x] **Step 3: 运行组件和自动任务测试**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/automation-skill-picker.test.tsx \
  src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts
```

Expected: 全部 PASS。

### Task 6: 完成中英文国际化

**角色：** single_agent / implementation

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Generate: `frontend/src/i18n/generated/zh-CN.json`
- Generate/Modify: `frontend/src/i18n/generated/en-US.json`
- Generate: `frontend/src/i18n/generated/zh-to-key.json`

**验收方式：** 新文案全部使用 `t()`；英文值人工校对；`pnpm i18n:check` 通过。

- [x] **Step 1: 汇总新增中文 key**

至少包含：调用技能、请选择自动任务需要调用的技能、搜索已安装的技能、暂无已安装 Skill、前往技能管理、加载失败、重试、不可用、状态确认中、暂无法确认、Skill 已不可用的保存错误。

- [x] **Step 2: 运行提取脚本**

```bash
cd frontend && pnpm i18n:extract
```

Expected: 三个 generated 字典按代码 key 更新。

- [x] **Step 3: 补齐并校对英文翻译**

英文使用产品语义，不机械直译；`Skill`、slug、Hermes 等专有名词保持一致。不得手工修改 hash key。

- [x] **Step 4: 运行 i18n 门禁**

```bash
cd frontend && pnpm i18n:check
```

Expected: PASS，无缺失、过期或未翻译 key。

### Task 7: 完整验证、浏览器验收与提交准备

**角色：** single_agent / verification

**Files:**
- Verify all files listed above
- Update progress only: `frontend/openspec/plan.md`

**验收方式：** 目标测试、全量类型检查、i18n、CN/global 可见验证全部通过；diff 无越界；提交前再次取得用户确认。

- [x] **Step 1: 运行目标测试集**

```bash
cd frontend && pnpm exec vitest run --config vitest.config.ts \
  src/lib/__tests__/hermes-skills-client.test.ts \
  src/lib/__tests__/hermes-cron-client.test.ts \
  src/pages/marketing/__tests__/automation-skill-picker.test.tsx \
  src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts \
  src/pages/marketing/__tests__/hermes-agent-experts-panel.test.tsx
```

Expected: 5 个测试文件全部 PASS。

- [x] **Step 2: 运行静态和国际化门禁**

```bash
cd frontend && pnpm check
cd frontend && pnpm i18n:check
```

Expected: 两条命令 exit 0。

- [x] **Step 3: 国内站浏览器验证**

在 CN 配置下验证：

- 创建默认未选择 Skill；
- 搜索并选择一个已安装 Skill；
- 创建结果详情显示绑定；
- 编辑保持和更换；
- 空列表和加载失败仍可创建普通任务；
- 已卸载绑定显示不可用且不自动清空；
- 页面无控制台错误。

- [x] **Step 4: 国际站浏览器验证**

在 global 配置下重复创建、编辑、详情、移除、空态、错误态和不可用态，确认英文文案与既有国际站通知渠道布局无冲突。

- [x] **Step 5: 回归历史和外部任务**

- 历史 `skills: []` 任务仍可查看、编辑和测试运行；
- 外部多 Skill job 未修改 Skill 字段时不生成任何 Skill flag；
- test run 继续携带 `job.skills`；
- 无 Skill create 命令与改动前一致。

- [x] **Step 6: 检查最终 diff 和计划完成度**

```bash
git diff --check
git status --short
git diff --stat
```

确认没有 `.codebuddy/.cache`、token、任务说明全文、无关格式化或归档历史混入提交范围，并把完成的 plan checkbox 更新为 `[x]`。

- [x] **Step 7: 展示提交内容并等待显式确认**

向用户展示拟提交文件、测试结果、剩余风险和 Lore commit message。只有用户确认后才执行 `git add` / `git commit`；push 和 MR 仍需各自遵守项目确认门禁。

建议 commit intent：

```text
让自动任务能够复用已安装 Skill

Constraint: 复用 Hermes Cron 现有 Skill 协议，不新增后端或 SDK 依赖
Rejected: 直接依赖专家包页面 | 避免页面间耦合
Confidence: high
Scope-risk: moderate
Directive: 保持 undefined=不修改、[]=清空的 Skill 编辑语义
Tested: 待实现后填写
Not-tested: 待实现后填写
```

### Task 8: 修复 Skill 下拉点击外部不收起

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`

- [x] 点击选择器外部区域时关闭下拉并清空搜索词，选择器内部交互保持不变。
- [x] 新增回归测试，并通过自动任务 Skill 目标测试集 179/179 与 `pnpm check`。

### Task 9: 优化 Skill 字段中文文案与默认提示

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 将字段标题统一为“调用技能”。
- [x] 未选择技能时展示灰色提示“请选择自动任务需要调用的技能”。
- [x] 自动任务 Skill 目标测试集 179/179、`pnpm check` 与 `pnpm i18n:check` 通过。

### Task 10: 精简 Skill 下拉选项与辅助提示

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/openspec/proposal.md`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 下拉列表不再展示“不调用 Skill”选项。
- [x] 删除选择器下方的无人值守执行提示文案。
- [x] 自动任务 Skill 目标测试集 178/178、`pnpm check` 与 `pnpm i18n:check` 通过。

### Task 11: 优化 Skill 选择器提示与单行布局

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/openspec/proposal.md`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 默认提示改为“请选择自动任务需要调用的技能”。
- [x] 搜索提示改为“搜索已安装的技能”。
- [x] 下拉中的 Skill 展示名称与 slug 改为同一行展示，并在空间不足时截断。
- [x] 自动任务 Skill 目标测试集 178/178、`pnpm check` 与 `pnpm i18n:check` 通过。

### Task 12: 选择 Skill 后生成推荐任务说明

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/src/lib/skillhub-api.ts`（仅在现有详情接口不足时）

- [x] 选择 Skill 且任务说明为空时，根据 SkillHub 的 Skill 说明生成并填入推荐任务说明。
- [x] 用户已经输入任务说明时不自动覆盖；更换 Skill 也保留用户内容。
- [x] Skill 详情加载失败时不阻断选择与普通任务创建，并保持任务说明不变。
- [x] 补充自动生成、保护已有内容和失败降级测试；目标测试集 5 个文件 185/185、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。

### Task 13: 为已选择 Skill 增加快捷清除入口

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 已选择 Skill 时，右侧下拉图标区域 hover 或键盘聚焦后切换为叉号。
- [x] 点击叉号清空 Skill 选择、关闭下拉并清空搜索，不触发展开操作。
- [x] 未选择 Skill 时继续显示普通下拉箭头，选择器主体交互保持不变。
- [x] 清除按钮提供中英文可访问名称；目标测试集 5 个文件 186/186、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。

### Task 14: 跟踪系统提示词来源并联动 Skill 选择

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/openspec/proposal.md`
- Modify: `frontend/openspec/spec.md`

- [x] 弹窗内记录最后一次系统生成的完整提示词，不写入任务数据或后端。
- [x] 清除 Skill 时同步清空未修改的系统提示词；用户编辑、模板和历史任务说明继续保留。
- [x] 切换 Skill 时替换未修改的系统提示词；用户一旦编辑便停止自动覆盖。
- [x] 补充清除、切换和用户编辑保护测试；目标测试集 5 个文件 189/189、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。

### Task 15: 补充 Skill 默认提示的运行方式说明

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`
- Modify: `frontend/openspec/proposal.md`
- Modify: `frontend/openspec/spec.md`

- [x] 未选择 Skill 时，默认提示展示“选择你希望 Agent 稳定调用的技能”。
- [x] 提示继续使用现有灰色占位样式和单行截断，不改变选择器交互。
- [x] 选择器组件测试 16/16、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。

### Task 16: 统一名称和 Skill 选择框圆角

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`

- [x] 名称输入框和 Skill 选择框使用与任务说明一致的 `rounded-md` 圆角。
- [x] 下拉菜单容器和现有选择、清除交互保持不变。
- [x] 选择器组件测试 17/17 通过。

### Task 17: 移除选择 Skill 后自动生成任务说明

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts`
- Modify: `frontend/openspec/proposal.md`
- Modify: `frontend/openspec/spec.md`
- Modify: `wiki/prd-docs/2026-07-14-automation-skill-invocation.md`

- [x] 选择、切换或清除 Skill 时，任务说明始终保持用户当前填写内容，不再自动生成、替换或清空。
- [x] 删除 SkillHub 提示词读取、兜底生成及系统提示词来源跟踪代码。
- [x] 保留 Skill 选择、清除、创建和编辑提交行为，并补充回归测试。
- [x] 同步更新 PRD、OpenSpec 和当前状态；目标测试集 5 个文件 183/183、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。

### Task 18: 为“调用技能”补充稳定性说明 Tooltip

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`
- Modify: `frontend/openspec/spec.md`
- Modify: `wiki/prd-docs/2026-07-14-automation-skill-invocation.md`

- [x] 在“调用技能”后增加帮助图标，Tooltip 文案为“在此处选择技能后，Agent 会在执行任务前加载该技能，相比仅在任务说明中通过提示词要求调用技能更加稳定。”
- [x] Tooltip 沿用项目白底轻边框样式，并同时支持鼠标 hover 与键盘 focus。
- [x] 帮助按钮提供可访问名称，并通过 `aria-describedby` 关联 Tooltip。
- [x] 目标测试集 5 个文件 184/184、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。

### Task 19: 调整调用 Skill 稳定性提示文案

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`
- Modify: `frontend/openspec/spec.md`
- Modify: `wiki/prd-docs/2026-07-14-automation-skill-invocation.md`

- [x] Tooltip 精确调整为“在此处选择技能后，Agent 会在执行任务前加载该技能，相比仅在任务说明中通过提示词要求调用技能更加稳定。”
- [x] 保持帮助图标、hover、键盘 focus 与可访问性行为不变。
- [x] 选择器组件测试 15/15、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。

### Task 20: 补充任务说明占位示例

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 任务说明占位文案调整为“请用提示词的形式描述需要执行的任务，比如：提醒我喝水，或者使用 xxx 技能帮我执行任务等”。
- [x] 仅补充手工提示词示例，不改变 Skill 选择与任务说明相互独立的行为。
- [x] 选择器组件测试 15/15、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。

### Task 21: 修复弹窗内 Tooltip 被裁剪

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- Modify: `frontend/DESIGN.md`

- [x] 将“调用技能”Tooltip 通过 Portal 渲染到 `document.body`，使用 fixed 定位脱离弹窗滚动容器的 overflow 裁剪边界。
- [x] 保留鼠标 hover、键盘 focus、Tooltip 文案选择复制和 `aria-describedby` 关联能力。
- [x] 在 `DESIGN.md` 固化规则：滚动/裁剪容器内的 Tooltip 必须 Portal 化，不能用提高 z-index 规避 overflow clipping。
- [x] 选择器组件测试 15/15、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。

### Task 22: 收紧 Skill 下拉菜单高度与纵向间距

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`

- [x] 将 Skill 列表最大高度从 16rem 收紧到 12rem，减少展开菜单的整体占用空间。
- [x] 收紧搜索区、列表内边距和选项上下间距，保持字体、单行展示、搜索与选择逻辑不变。
- [x] 选择器组件测试 15/15、`pnpm check` 与 `git diff --check` 通过。

### Task 23: 统一 Skills 分类卡与 Featured 信息排版

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`

- [x] 国内站与国际站分类卡描述最多展示一行，溢出时显示省略号。
- [x] Featured 卡片底部名称与描述字号和分类卡保持一致。
- [x] Skills 目标测试、`pnpm check` 与 `git diff --check` 通过。

### Task 24: 统一技能包搜索框并稳定来源下拉布局

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/styles.css`

- [x] 国内站与国际站技能包搜索框使用和 Skills 搜索框相同的圆角。
- [x] 国内站与国际站来源下拉展开和关闭时不再引起页面横向位移。
- [x] Skills 目标测试、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。

### Task 25: 刷新后保持精选与分类技能的已安装状态

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`

- [x] 持久化前端成功安装后获得的完整技能身份，刷新后继续显示已安装状态。
- [x] 兼容国内站已安装列表返回 `id/rawId` 的数据形态。
- [x] Skills 目标测试、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。

### Task 26: 统一国内外技能搜索框圆角

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/hermes-agent-experts-panel.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/pages/marketing/__tests__/hermes-agent-experts-panel.test.tsx`

- [x] Skills 与 Skill Packages 搜索框使用同一个共享样式类和 `12px` 圆角。
- [x] 国内站、国际站及 SDK 备用搜索框保持一致。
- [x] Skills 目标测试、`pnpm check` 与 `git diff --check` 通过。

### Task 27: 统一技能搜索框内部间距

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/styles.css`

- [x] Skills 与 Skill Packages 搜索图标和文字的左右内边距保持一致。
- [x] 国内站与国际站共用同一套内部间距。
- [x] Skills 目标测试、`pnpm check` 与 `git diff --check` 通过。
### Task 28: 修正模型切换保护记录的展示语义

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/hermes-cron-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-cron-client.test.ts`
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/hermes-agent-automations-panel.test.ts`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 识别 Hermes 因全局 provider/model 漂移而跳过推理的执行结果，不把原始 RuntimeError 当作任务名称展示。
- [x] 最近执行记录继续展示原自动任务名称，状态显示“未执行”，原因显示“模型切换导致任务未执行”。
- [x] 其他成功、失败与普通跳过记录的解析和展示逻辑保持不变。
- [x] 先补失败测试复现线上输出，再以最小实现修复；目标测试、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。

### Task 29: 补齐详情中的调用技能语义

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/hermes-cron-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-cron-client.test.ts`
- Modify: `frontend/src/pages/marketing/automation-skill-picker.tsx`
- Modify: `frontend/src/pages/marketing/hermes-agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/*.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 自动任务详情未显式绑定技能时展示“未配置”，不再表述为“不调用 Skill”。
- [x] 最近执行详情增加“调用技能”字段，并展示执行任务显式绑定的技能或“未配置”。
- [x] 当前任务和已归档的历史任务元数据均保留技能绑定信息，避免单次任务清理后详情字段丢失。
- [x] 不改变任务说明中的提示词行为，也不推断提示词是否会自行调用技能。
- [x] 目标测试 4 个文件 154/154、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过，并完成本地页面验证。

## 3. 规划门禁结论

- [x] 已确认需求范围、排除项和 13 条验收标准。
- [x] 已识别规模为 M，执行模式为 single_agent。
- [x] 已读取 P0 上下文、前端规范、设计规范和现有 OpenSpec。
- [x] 已确认现有 Hermes create/list/test-run 能力，缺口集中在共享查询、edit flags 和 UI。
- [x] 已选择主要方案并记录两个备选方案与取舍。
- [x] 已覆盖 loading、空态、错误态、不可用态和历史兼容。
- [x] 已确认不需要额外 capability 或重型依赖。
- [x] plan 含具体角色、文件、测试命令、验收方式和 checkbox。
- [x] 不在范围内的修改已明确排除。
- [x] **规划门禁结论：通过，待用户确认后进入实现。**

## 增量修复：移除已选人设展示

- [x] 移除人设页底部的“已选人设”状态标签，并将面板文件重命名为 `hermes-agent-buddy-panel.tsx`。
  - 角色：Developer + Reviewer
  - 影响文件：`frontend/src/pages/marketing/hermes-agent-buddy-panel.tsx`、`frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`、`frontend/openspec/specs/buddy.md`
  - 验收方式：国内站和国际站均不再渲染“已选人设”；旧文件名无残留引用；已注入卡片状态、选中和注入交互保持不变；目标测试和类型检查通过。

### Task 30: 合并 Hermes 原生技能并支持搜索结果批量安装

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/auth-api-base.ts`
- Modify: `frontend/src/lib/__tests__/auth-api-base.test.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Create: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] `lightvela.ai` 在未配置显式环境变量时解析到 `https://api.lightvela.ai`，且保留恰好 3 行生产代码增量。
- [x] 国内站和国际站的已安装列表把 registry 安装结果与 Hermes 原生技能结果合并；原生技能显示 `Hermes` 来源且不错误调用 registry 卸载命令。
- [x] 已安装标签页保持不变，内容统一改成单列列表。
- [x] 搜索结果中的未安装技能在 `+` 左侧提供可访问的方形选择按钮；已安装技能不可选择。
- [x] 来源按钮右侧显示“批量下载 / Batch Install”；无选择时禁用，选中一项或多项时启用。
- [x] 批量安装按选择顺序串行执行，结束后仅刷新一次已安装列表；成功项清除选择，失败项保留并显示成功/失败汇总。
- [x] 先补失败测试，再实现最小代码；运行 auth/registry 目标测试、`pnpm i18n:extract`、`pnpm i18n:check`、`pnpm check` 与 `git diff --check`。

### Task 31: 下移搜索结果展开按钮并更新国内站说明

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/src/pages/marketing/hermes-agent-skills-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/hermes-agent-skills-panel.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 国内站与国际站的“查看全部 / 收起全部”从搜索结果标题右侧移动到结果列表底部，并使用次级按钮样式。
- [x] 国内站 Skills 说明改为“为智能体安装技能。支持 SkillHub 技能市场，安装后可在对话中自动调用。”，国际站说明保持不变。
- [x] 先补失败测试，再运行 Skills 目标测试、`pnpm i18n:extract`、`pnpm i18n:check`、`pnpm check` 与 `git diff --check`。

### Task 32: 扩展全页面批量安装、来源链接与真实卸载

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/hermes-skills-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-skills-client.test.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/src/pages/marketing/hermes-agent-skills-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/hermes-agent-skills-panel.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 先补失败测试：国内站和国际站的精选与所有分类卡片显示可访问的方形批量选择按钮，并与搜索结果共用顶部批量下载状态和按选择顺序执行的安装队列。
- [x] 让批量选择覆盖搜索、精选和分类的统一技能身份；已安装技能不可选择，单项或批量安装成功后清除对应选择。
- [x] 国内站已安装的 SkillHub 技能图标链接到 `https://skillhub.cn/skills/<slug>`；优先显示已知 SkillHub 图标，缺失时使用默认图标；国际站和 Hermes 原生技能不添加该图标链接。
- [x] 国内站和国际站的所有已安装技能显示垃圾桶；registry 技能调用原有卸载命令，Hermes 原生技能仅在 slug 通过严格校验后真实删除 `~/.hermes/skills/<slug>`，成功后刷新列表。
- [x] 把来源说明从外层描述行移到“技能 / 技能包 / 已安装”标签线正上方最右侧，移除按钮外框；国内站显示“技能来源于 SkillHub”，国际站显示“技能来源于 Skills.sh 与 ClawHub”，各市场名为独立外链并支持中英文。
- [x] 运行受影响 Vitest、`pnpm i18n:extract`、`pnpm i18n:check`、`pnpm check` 与 `git diff --check`；检查交互控件的可访问名称、键盘焦点和禁用状态。

### Task 33: 收紧技能安装反馈与列表头布局

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 国内站和国际站的中文单项安装成功 Toast 从“下载成功”改为“安装成功”。
- [x] 已安装列表不再展示 SkillHub、Skills.sh、ClawHub 或 Hermes 来源标签，保留合并、去重和删除行为。
- [x] 来源说明与技能标签共用同一条底部横线，并在最右侧贴近横线上方展示。
- [x] 批量下载按钮使用更宽的固定宽度，选中数量变化时按钮宽度保持不变。
- [x] 先补失败测试，再运行受影响 Vitest、`pnpm i18n:extract`、`pnpm i18n:check`、`pnpm check` 与 `git diff --check`。

### Task 34: 修复嵌套 Hermes 技能卸载并收紧批量按钮

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/hermes-skills-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-skills-client.test.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`

- [x] Hermes 原生技能卸载支持 `~/.hermes/skills/<category>/<slug>` 等嵌套目录，并只删除同名且包含 `SKILL.md` 的目录。
- [x] 原生技能目录已不存在时卸载保持幂等成功，不再显示 `EXIT STATUS 1`。
- [x] 批量下载按钮与来源选择器使用相同的 12px 圆角，固定宽度从 `w-36` 缩为 `w-32`。
- [x] 先补失败测试，再运行受影响 Vitest、`pnpm i18n:check`、`pnpm check` 与 `git diff --check`。

### Task 35: 已安装扁平列表与批量卸载

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`
- Modify: `frontend/openspec/specs/marketing.md`

- [x] 在 `skill-registries.test.ts` 先补失败测试：`uninstallSkillsSequentially(dataLayer, skills)` 按输入顺序调用 `uninstall`，收集 `succeeded` 与带原错误消息的 `failed`，单项抛错不阻断后续技能。
- [x] 在 `SkillsDemoPanel.test.tsx` 先补双站失败测试：已安装列表使用统一外框和 `divide-y` 扁平行；每行的“选择批量卸载 <name>”按钮位于“删除技能 <name>”左侧；标题行最右侧批量按钮默认禁用，选择两项后显示 `(2)` 并启用。
- [x] 补双站批量卸载失败测试：点击批量按钮只打开一次确认；确认后按选择顺序卸载，成功项清除、失败项保留、列表只刷新一次；执行期间选择按钮和垃圾桶禁用。
- [x] 运行 `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx --reporter=dot`，确认失败点仅来自尚未实现的 helper、扁平列表、选择控件和批量行为。
- [x] 在 `skill-registries.ts` 新增导出的 `BatchUninstallResult` 与 `uninstallSkillsSequentially(dataLayer: Pick<SkillsDataLayer, "uninstall">, skills: InstalledSkill[])`，使用顺序 `for...of` 并把返回 `ok: false` 与异常都记录为失败。
- [x] 在 `SkillsDemoPanel.tsx` 增加 `selectedInstalledSkillIds`、`batchUninstalling` 与批量确认状态；刷新列表时按 `registry + rawId` 清理失效选择，单项和批量卸载共用现有真实数据层。
- [x] 把 `InstalledSkillCard` 收敛为扁平 `InstalledSkillRow`：父 `ul` 使用统一 `border-y divide-y`，行本身无独立边框和圆角；操作区依次渲染方形选择按钮和红色垃圾桶。
- [x] 把已安装标题改为左右工具栏；非空列表右侧固定显示“批量卸载 / Batch Uninstall”，无选择或执行中禁用，选中时显示稳定宽度的数量；确认弹窗按单项/批量分别显示技能名或选中数量。
- [x] 批量确认后调用 `uninstallSkillsSequentially`，仅在全部命令完成后刷新一次；成功 identity 从选择中删除，失败 identity 保留；全成功显示“批量卸载成功，共 {{count}} 个”，部分失败显示“批量卸载完成：成功 {{success}} 个，失败 {{failed}} 个”。
- [x] 运行目标 Vitest 转绿；执行 `pnpm i18n:extract` 并补齐英文 `Batch Uninstall`、批量确认和结果 Toast，再运行 `pnpm i18n:check`、`pnpm check` 与 `git diff --check`。

### Task 36: 对齐批量卸载宽度并移除已安装图标

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`

- [x] 国内站与国际站的“批量卸载 / Batch Uninstall”使用与“批量下载 / Batch Install”相同的固定 `w-32` 宽度，选中数量变化时不改变宽度。
- [x] 已安装列表不再渲染技能图标及其 SkillHub 图标链接，仅保留技能信息、批量选择和删除操作。
- [x] 校验国际站英文为 `Batch Uninstall`，并运行目标 Vitest、`pnpm i18n:check`、`pnpm check` 与 `git diff --check`。

### Task 37: 合并 SkillHub 市场别名与 Hermes 原生技能

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`

- [ ] 用 Whistle 真实页面暴露的字段形态补失败测试：SkillHub 原生名称仅出现在 `display_name/displayName` 时，`quant-backtest-strategy` / `onequant-backtest` 与 `valuation-analysis` / `股票价值投资分析 (valuation-analysis)` 各自仍只合并成一条。
- [ ] SkillHub 已安装解析保留市场 `rawId` 用于身份、安装状态与卸载，并把同一 ACLI 记录的 `name`、`display_name`、`displayName` 保存为精确别名集合；Hermes slug 唯一命中任一别名时优先保留 SkillHub 行。
- [ ] 保持原生独有技能继续展示；没有任一明确别名精确匹配时不合并，禁止模糊或静态 slug 映射。
- [ ] 在 Whistle 当前已安装页面复核两个重复案例各只显示一条，再运行目标 Vitest、`pnpm i18n:check`、`pnpm check` 与 `git diff --check`。
## 增量修复：统一诊断中心备份卡片阴影

- [x] 将“Agent 备份与恢复”外层卡片阴影与同页“最近日志”卡片保持一致。
  - 角色：Developer + Reviewer
  - 影响文件：`frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/DESIGN.md`
  - 验收方式：仅调整外层阴影，不改变卡片布局、交互、边框或业务逻辑；在设计规范中记录卡片阴影值与适用边界；`pnpm check` 与 `git diff --check` 通过。

### Task 38: 合并国际站跨来源重复技能并修复 Hermes 删除工作目录

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Modify: `frontend/src/lib/hermes-skills-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-skills-client.test.ts`

- [x] 先补失败测试复现同一 `okx-sentiment-tracker` 同时出现在 ClawHub、skills.sh 和 Hermes 清单时被渲染为三条。
- [x] 仅在跨 registry 的 slug 唯一对应时合并 ClawHub 与 skills.sh 记录；保留 skills.sh 完整 ID 作为可卸载主身份，同 registry 内同 slug 的不同完整 ID 继续分开。
- [x] 让合并后的唯一 registry 记录继续吸收同 slug 的 Hermes 记录，国际站 My Skills 最终只显示一条。
- [x] Hermes 删除命令先进入 `$HOME`，避免远端执行用户从不可访问的 `/root` 启动时 `find` 无法恢复初始工作目录。
- [x] 运行 registry/Hermes 目标 Vitest、`pnpm i18n:check`、`pnpm check` 与 `git diff --check`。

### Task 39: 对齐旧版 SDK 的已安装技能结构化列表

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 参考旧版 `tea-sdk-lightclaw` 的已安装技能列表，将当前扁平行改为带表头的结构化列表，展示技能名称、真实安装来源、版本和删除操作；跨来源技能显示全部真实 registry，Hermes 仅在没有 registry 来源时单独显示。
- [x] 增加已安装技能名称搜索和安装来源筛选，筛选后标题显示命中数量；无匹配结果时提供清除筛选入口，不改变单项卸载流程。
- [x] 保持移动端可读布局、键盘焦点和图标按钮可访问名称；先补目标测试，再运行 i18n、类型检查、目标 Vitest、浏览器回验与 `git diff --check`。

### Task 40: 恢复已安装技能的原生来源语义

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/hermes-skills-client.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: related tests and generated i18n files

- [x] 保留 Hermes 清单的 `Source` 字段，不再用内部 `hermes` 归并标记充当用户可见来源。
- [x] 保留旧版 SDK 来源语义并优化文案：`local` 显示“本地安装”、`builtin` 显示“系统预置”；Hermes 能枚举到但未匹配预置或市场安装记录的技能显示“其他”，市场来源继续显示对应 registry。
- [x] 将表头精简为“名称 / 来源 / 版本”，来源筛选同步新语义，并完成目标测试、类型检查、i18n 检查和浏览器回验。

### Task 41: 用 Hermes bundled manifest 补全系统预置来源

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/hermes-skills-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-skills-client.test.ts`

- [x] 扩展 Hermes 已安装技能命令，在列表成功后读取当前 profile 的 `~/.hermes/skills/.bundled_manifest`。
- [x] 解析 manifest 的 `name:hash` 记录，仅为缺少来源且命中 manifest 的技能补充 `builtin`，不覆盖 CLI 已明确返回的来源。
- [x] 验证 `architecture-diagram` 展示为“系统预置”，并运行目标 Vitest、类型检查与 `git diff --check`。

### Task 42: 统一国内站搜索结果来源

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: related tests and `lv-sitepage-skills` product rules

- [x] 国内站从 SkillHub API 获取的搜索结果统一展示为 SkillHub，不再按接口 `source` 区分 ClawHub。
- [x] 国内站来源筛选仅保留“所有来源 / SkillHub”；国际站继续保留 skills.sh / ClawHub 区分。
- [x] 保持国内站安装命令继续使用 `acli skills install`，不影响国际站 registry 命令。

### Task 43: 按站点收敛搜索来源筛选

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 国内站隐藏搜索来源选择控件，搜索结果默认且唯一使用 SkillHub。
- [x] 国际站继续提供“所有来源 / skills.sh / ClawHub”筛选，不改变两套 ACLI 搜索命令。
- [x] 更新目标测试并完成类型检查、i18n 检查、国内站浏览器回验与 `git diff --check`；Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 44: 已安装技能增加分类列

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/hermes-skills-client.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: related tests, generated i18n, design and Skills page rules

- [x] 从 Hermes 原生 `skills list` 的 `Category` 列和 SkillHub 已安装列表的 `category` 字段保留分类，不根据名称或 slug 猜测分类。
- [x] 已安装技能表格在名称后增加“分类”列；缺少分类时显示“未分类”，移动端保持可读布局。
- [x] 名称列继续优先显示展示名，仅当展示名与 slug 不同时在第二行补充 slug；完成解析测试、组件测试、类型检查、i18n、浏览器回验与 `git diff --check`；Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 45: 兼容 Hermes Rich 表格分类表头

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/hermes-skills-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-skills-client.test.ts`

- [x] 用当前实例真实输出补测试：Rich 表头使用 `┃`、数据行使用 `│` 时，仍能读取 `Name / Category / Source`。
- [x] 兼容两种竖线边框，不改变 JSON、普通表格、manifest 来源补全或纯文本降级逻辑。
- [x] 验证已安装页面恢复 Hermes 分类，并完成类型检查、i18n 与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 46: 对齐国内站技能页顶部说明

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-skills-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/hermes-agent-skills-panel.test.tsx`

- [x] 国内站技能页顶部说明改为“为你的智能体安装技能（Skill），安装后 Agent 执行任务时可自动调用”。
- [x] 国际站现有 ClawHub / skills.sh 说明保持不变，不新增 i18n 文案。
- [x] 完成组件测试、类型检查、i18n 检查、浏览器回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 47: 批量安装仅限搜索结果

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 搜索结果继续支持勾选和批量安装，批量选择状态只接受当前搜索结果中的技能。
- [x] 精选与固定分类卡片移除批量选择框，保留详情和单个安装入口；批量执行期间继续锁定安装控件。
- [x] 更新组件测试和 Skills 页面规则，并完成类型检查、i18n、浏览器回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 48: 对齐技能来源外链样式

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/DESIGN.md`

- [x] 国内站“技能来源于 SkillHub”外链复用技能包详情页样式：蓝色文字、hover 下划线和外链箭头。
- [x] 保持来源文案、链接地址、位置和国际站样式不变，并补充组件断言与设计规范。
- [x] 完成类型检查、i18n、浏览器回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 49: 对齐 SDK 搜索结果批量安装工具栏

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`
- Modify: related generated i18n files

- [x] 搜索框右侧不再常驻批量安装按钮；无搜索或无可安装搜索结果时不展示批量安装工具栏。
- [x] 有可安装搜索结果时，在“搜索结果”标题右侧展示“已选 n / m”和“批量安装 (n)”，并保留现有执行与忙碌保护。
- [x] 更新组件测试和 Skills 页面规则，并完成类型检查、i18n、浏览器回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 50: 精简国内站技能来源文案

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 国内站来源文案由“技能来源于 SkillHub”改为“源自 SkillHub”，保留 SkillHub 外链样式、箭头和 URL。
- [x] 国际站“技能来源于 Skills.sh 与 ClawHub”保持不变。
- [x] 更新组件测试和 Skills 页面规则，并完成类型检查、i18n、浏览器回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 51: 对齐 SDK 技能来源位置与点击范围

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 将技能来源说明从标签分隔线右侧移动到搜索框所在行的最右侧。
- [x] 国内站“源自 SkillHub”整段使用统一蓝色链接样式并可点击，保留外链箭头与 URL。
- [x] 国际站来源文案和链接语义保持不变，完成类型检查、i18n、浏览器回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 52: 明确搜索结果排序文案

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`
- Modify: related generated i18n files

- [x] 将搜索结果排序项“热门 / 名称”改为“按热度 / 按名称”。
- [x] 保持下载量、安装量和名称排序逻辑不变，并完成类型检查、i18n、浏览器回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 53: 对齐 SDK 搜索结果列表布局

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 将搜索结果从双列独立卡片改为 SDK 风格的单列列表容器和分隔行。
- [x] 每行保留批量选择、技能图标、名称、slug、简介、来源、热门状态和安装状态；保持现有搜索、排序、12 条预览与展开逻辑不变。
- [x] 完成类型检查、i18n、国内站浏览器回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 54: 精简搜索结果列表信息

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 搜索结果列表行移除技能图标、来源徽标和热门标记。
- [x] 保留名称、slug、简介、批量选择和安装状态，且不影响精选与分类卡片的信息展示。
- [x] 完成类型检查、i18n、国内站浏览器回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 55: 增加搜索结果行内失败与重试

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`
- Modify: related generated i18n files

- [x] 单项和批量安装失败后，在对应搜索结果行显示“失败”或“已跳过”状态。
- [x] 失败与跳过状态提供“重试”，重试复用现有单项安装流程并在成功后恢复已安装状态。
- [x] 保留现有 Toast、批量顺序和忙碌保护，完成类型检查、i18n、浏览器基础回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动，未通过真实安装人为制造失败状态。

### Task 56: 精简批量安装按钮文案

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`
- Modify: related generated i18n files

- [x] 搜索结果右上角按钮由“批量安装 (n)”改为“安装 (n)”，保留“已选 n / m”。
- [x] 批量执行逻辑、选择范围和忙碌保护不变，完成类型检查、i18n、浏览器回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 57: 增加批量安装实时进度

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`
- Modify: related generated i18n files

- [x] 批量开始时选中行显示“等待中”，当前行显示“安装中”，标题下显示“正在安装 (i/n)：技能名称”。
- [x] 单项重试时显示“重试中”，成功后恢复“已安装”；失败或跳过时继续提供重试入口。
- [x] 保留“安装 (n)”、完成 Toast、顺序执行和忙碌保护，完成类型检查、i18n、浏览器基础回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动，未通过真实安装人为制造进度状态。

### Task 58: 精简搜索结果安装按钮

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 搜索结果右上角按钮只显示“安装”，移除按钮内的已选数量 `(n)`。
- [x] 去掉按钮的固定最小宽度，使按钮按“安装”文案自然收紧；保留左侧“已选 n / m”。
- [x] 保持批量安装、进度和忙碌保护逻辑不变，完成类型检查、i18n、浏览器回验与 `git diff --check`；目标 Vitest 因本机 `localhost` DNS 的 `ENOTFOUND` 未能启动。

### Task 59: 放大搜索结果安装按钮宽度

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 将搜索结果右上角“安装”按钮的水平内边距从 `px-3` 调整为 `px-6`，宽度扩大约 50%。
- [x] 保持按钮高度、文案、已选统计和批量安装逻辑不变。
- [x] 完成类型检查、i18n、浏览器回验与 `git diff --check`；目标 Vitest 仍受本机 `localhost` DNS 的 `ENOTFOUND` 阻塞。

### Task 60: 优化 Skills 搜索与批量安装可靠性

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Modify: `frontend/src/pages/marketing/hermes-agent-experts-panel.tsx`
- Modify: `frontend/src/repositories/types.ts`
- Modify: `frontend/src/repositories/http-repositories.ts`
- Modify: `frontend/src/repositories/__tests__/http-repositories.test.ts`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 批量安装期间冻结页签、搜索、来源、排序和全部安装/选择入口，并在事件处理函数内保留忙碌态保护，避免执行任务与页面选择快照不一致。
- [x] 收紧安装成功状态解析，避免把 `install_failed` / `not_installed` 误判为成功；已安装刷新失败时保留现有列表，成功后校准本地已安装记忆。
- [x] 为实例技能命令增加超时保护；批量安装支持取消剩余任务、标记跳过项并在离开页面前提示。
- [x] 搜索请求支持取消过期 HTTP 请求，按来源展示搜索失败或部分失败状态，并提供明确的“重试”入口，不再把请求失败伪装成无结果。
- [x] 目标 Vitest 3 个文件共 100 条用例通过；`pnpm i18n:check`、`pnpm check`、浏览器搜索回验和 `git diff --check` 均通过。测试运行通过临时 DNS hook 把本机缺失的 `localhost` 解析映射到 `127.0.0.1`，该临时文件未保留在工作区。

### Task 61: 放大搜索结果安装按钮字号

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 将搜索结果右上角“安装”按钮字号从 `text-xs` 调整为 `text-sm`，保持 `h-9 px-6`、文案和交互逻辑不变。
- [x] 目标 Vitest 30 条用例通过；`pnpm i18n:check`、`pnpm check`、浏览器计算样式回验和 `git diff --check` 均通过。按钮实测字号为 14px，高度保持 36px。

### Task 62: 移动国内站 SkillHub 来源链接

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 国内站移除搜索框右侧“源自 SkillHub”链接，把它放到搜索结果列表底部右侧；国际站来源说明位置保持不变。
- [x] 底部使用三列布局保持“查看更多 / 收起”整体居中，来源链接与按钮统一为 32px 高。
- [x] 目标 Vitest 30 条用例通过；`pnpm check`、`pnpm i18n:check`、浏览器位置与尺寸回验和 `git diff --check` 均通过。浏览器实测两个控件 y 坐标一致、高度均为 32px。

### Task 63: 优化已安装技能列表可靠性与可用性

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/hermes-skills-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-skills-client.test.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`
- Modify: related generated i18n files

- [x] 已安装列表按 Agent 隔离并防止过期请求回写；加载失败显示可重试错误，同一 Agent 才允许保留上一份成功数据。
- [x] registry 列表部分失败时明确标记来源不可用并禁止不确定记录卸载；不同 registry 仅短 slug 相同的技能不再合并。
- [x] 卸载后重新读取权威列表确认目标消失；系统预置技能不可删除，卸载状态解析不再接受模糊失败值。
- [x] 恢复分类筛选和 10 条分页，保留并展示 Hermes 的异常状态；目标 Vitest 80 条、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。
- [ ] 浏览器可见回验：本轮 Browser 被本地 URL 安全策略拦截，已保留 `http://127.0.0.1:5174/agents/skills/` 预览供人工刷新验证。

### Task 64: 恢复技能包视图并收紧安装状态与请求开销

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-experts-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/hermes-agent-experts-panel.test.tsx`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 恢复技能包列表 / 卡片视图切换与本地偏好记忆，首次默认列表视图；保留新版国际化、分类和紧凑卡片能力。
- [x] Hermes 已安装技能查询成功后以实际技能集合校准技能包状态，清理已缺少组成技能的缓存记录。
- [x] 取消无条件全量详情与逐技能预取，移除与全量加载模式冲突的失效分页 / 无限滚动状态。
- [x] 为技能包安装、自升级和已安装查询增加有限超时；目标 Vitest 41 条、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 均通过。

### Task 65: 固定已安装来源筛选顺序

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 将已安装来源筛选固定为“全部来源 / SkillHub / 系统预置 / 本地安装”优先，其他实际来源继续排在后面。
- [x] 初版按 Hermes 原生列表的 `Source=local` 展示“本地安装”；后续由 Task 66 按真实目录进一步修正。
- [x] 完成目标测试、类型、i18n、浏览器和 diff 校验。

### Task 66: 按 Hermes 技能目录修正“其他”来源

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/hermes-skills-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-skills-client.test.ts`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] Hermes 已安装查询同时回传 `$HOME/.hermes/skills/` 下的实际技能目录；非 bundled 技能位于该目录时归为“其他”。
- [x] 保留 SkillHub 和 bundled manifest 的更高来源优先级；不在 Hermes 目录中的 `Source=local` 仍显示“本地安装”。
- [x] 完成目标测试、类型、i18n、浏览器和 diff 校验。

### Task 67: 已安装列表默认展示 slug

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`
- Modify: generated i18n files

- [x] 初版将已安装列表名称列收敛为只展示技能 slug；后续按用户澄清由 Task 68 恢复为名称与 slug 始终两行。
- [x] 表头由“名称”调整为“名称/Slug”，保持搜索和删除交互不变。
- [x] 完成目标测试、类型、i18n、浏览器和 diff 校验。

### Task 68: 已安装名称与 slug 始终展示两行

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- Modify: `frontend/DESIGN.md`
- Modify: `.agents/skills/lv-sitepage-skills/SKILL.md`

- [x] 已安装列表名称列第一行显示名称、第二行显示 slug；两者相同时也保留两行。
- [x] 表头继续使用“名称/Slug”，搜索、筛选和删除交互保持不变。
- [x] 完成目标测试、类型、i18n、浏览器和 diff 校验。

### Task 69: 修复 Skills 搜索与 Agent 状态边界

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-experts-panel.tsx`
- Modify: `frontend/src/pages/marketing/hermes-agent-skills-panel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Modify: related Vitest files

- [x] 国际站技能包关键词搜索不再回填未命中的预置技能包。
- [x] 已安装记忆按真实来源识别，跨 registry 的同 slug 技能不互相污染安装状态。
- [x] 切换 Agent 时重置技能与技能包页面操作状态，旧 Agent 的异步任务不回写新 Agent 界面。
- [x] 批量安装期间禁用搜索失败提示中的“重试”，事件处理函数同时增加忙碌状态保护。
- [x] 目标 Vitest 93 条、`pnpm check`、`pnpm i18n:check`、浏览器三页签回验和 `git diff --check` 均通过；浏览器控制台无错误。

### Task 70: 处理已安装技能来源与删除命令 CR

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/hermes-skills-client.ts`
- Modify: `frontend/src/lib/__tests__/hermes-skills-client.test.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`

- [x] 多市场同 slug 时保留各市场独立记录，不再额外展示无法确定归属的 Hermes 镜像记录。
- [x] Hermes 删除命令在 `rm` 失败时立即返回失败，并继续保留删除后的存在性校验。
- [x] Hermes 来源文案使用映射表，保持 builtin / local / other / clawhub 及未知来源回退行为。
- [x] 完成目标 Vitest、`pnpm check`、`pnpm i18n:check` 和 `git diff --check`。
- [x] 提交并推送现有 MR。

### Task 71: 简化人设生效提示

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/hermes-agent-buddy-panel.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 人设注入成功弹窗将 Hermes 名称改为 Hermes Agent，并移除 `/approve` 步骤。
- [x] 新提示同步到中英文 i18n 字典，旧文案不再被引用。
- [x] `pnpm check`、`pnpm i18n:check` 和 `git diff --check` 通过。

### Task 72: 统一 Agent 控制台 Hermes Agent 称呼

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `/agents` 路由可达页面中的用户可见文案与对应测试
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 逐页检查 `/agents` 导航下全部页面，将作为 Agent 主体或品牌出现的单独 `Hermes` 统一为 `Hermes Agent`；实例默认名称和公共侧栏保留“我的Hermes”。
- [x] 保留 `Hermes CLI`、`Hermes /learn`、`Hermes WebUI` 等官方技术名称，以及代码标识、命令和后端原始 key。
- [x] 同步中英文 i18n 字典，更新受影响测试，并确认目标源码不再包含遗漏的用户可见单独 `Hermes`。
- [x] 目标测试、`pnpm check`、`pnpm i18n:check`、浏览器烟测和 `git diff --check` 通过。

### Task 73: 统一产品文档 Hermes Agent 称呼

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/content/docs/**/*.md`

- [x] 检查国内站、国际站中文和国际站英文文档，将作为产品或 Agent 主体出现的单独 `Hermes` 统一为 `Hermes Agent`。
- [x] 保留 `Hermes CLI`、命令、路径、配置键、代码示例等技术专名和机器可读内容。
- [x] 校验三套文档的路由映射、链接与图片引用，并完成文档同步、项目检查、浏览器烟测和 `git diff --check`。

### Task 74: 统一前端 Agent 代码文件名

**角色：** single_agent / mechanical rename + verification

**Files:**
- Rename: `frontend/**/*{openclaw,hermes-agent}*.{ts,tsx}` → 对应 `*agent*.{ts,tsx}`
- Modify: 引用上述模块的 `frontend/**/*.{ts,tsx}` import / export / mock 路径

- [x] 将 `frontend/` 下 34 个代码文件名中的 `openclaw` 或 `hermes-agent` 统一收敛为 `agent`。
- [x] 仅同步必要的模块路径引用，不修改 `OpenClaw*` 代码标识、API 字段、路由或普通业务文案。
- [x] 确认旧代码文件名与旧模块路径无残留；49 个 TypeScript 文件通过调用关系等价检查，14 个测试文件共 252 条通过，`pnpm check` 和 `git diff --check` 通过；两个账号页测试文件的 17 条既有失败已确认与 `origin/master` 基线一致。

### Task 75: 模型切换时同步自动任务推理配置

**角色：** single_agent / implementation + verification

**目标：** 用户切换 Hermes Agent 默认模型时，先识别会因 provider/model 漂移保护而受影响的自动任务；由用户明确选择仅切换聊天模型，或在切换成功后把这些任务显式绑定到新的默认 provider/model。

**Files:**
- Modify: `frontend/src/pages/marketing/agent-tat-adapter.ts`
- Create: `frontend/src/pages/marketing/agent-model-switch-automation-sync.tsx`
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Modify/Create: related Vitest files
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 用失败测试覆盖模型切换命令识别、仅筛选未完整 pin 且需要推理的任务、用户两种选择，以及同步部分失败反馈。
- [x] 在 SDK 命令适配器加入局部命令生命周期钩子；只拦截 `acli model switch`，不改变通道、技能和其他模型命令。
- [x] 模型切换前展示明确选择；模型切换成功后，通过 Hermes 官方 `cronjob(action="update")` 逐任务补齐未 pin 的 provider/model，保留任务原有显式绑定。
- [x] 检查失败时不静默切换；同步部分失败时保留已成功的模型切换和任务更新，并就近反馈成功/失败数量。
- [x] 完成目标 Vitest、`pnpm check`、`pnpm i18n:check`、浏览器页面烟测和 `git diff --check`。
- [x] 按本地预览反馈优化模型切换弹窗标题、风险说明和三个操作按钮文案；目标测试、类型检查、i18n 检查与 `git diff --check` 均通过。
- [x] 中文界面将“当前套餐不支持所请求模型”的 Hermes 原始错误转换为用户可读中文，其他未知错误保留原文；目标测试、类型检查、i18n 检查与 `git diff --check` 均通过。
- [x] 修复同步时误把命名 provider 归一化为 `custom` 的问题；同步选择覆盖所有尚未匹配目标 provider/model 的推理任务，可修复旧逻辑误绑定并支持后续多次切换；70 条目标测试、类型检查、i18n 检查与 `git diff --check` 均通过。
- [x] 按本地预览反馈将模型切换提示拆成两段，并明确同步后的 Token 消耗方式；目标测试、类型检查、i18n 检查与 `git diff --check` 均通过。
- [x] 按最新确认文案精简模型切换风险与 Token 消耗说明；目标测试、类型检查、i18n 检查与 `git diff --check` 均通过。

### Task 76: 模型切换结果提示纵向排列

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/lib/toast.ts`
- Create: `frontend/src/lib/__tests__/toast.test.ts`

- [x] 宿主 Toast 与 SDK message 复用同一个顶部纵向容器，同时出现时按触发顺序排列并保留间距。
- [x] 完成目标 Vitest、`pnpm check`、`pnpm i18n:check` 和 `git diff --check`。

### Task 77: 排除已失效的自动任务

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-model-switch-automation-sync.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-model-switch-automation-sync.test.ts`

- [x] 暂停任务仍参与模型切换提示与同步；单次任务已执行或已过生效期的任务不再计入。
- [x] 完成目标 Vitest、`pnpm check`、`pnpm i18n:check` 和 `git diff --check`。

### Task 78: 关闭模型切换提示时终止流程

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/agent-model-switch-automation-sync.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-model-switch-automation-sync.test.ts`

- [x] 用户关闭自动任务更新提示时直接取消本次模型切换，不再误入自动任务检查失败降级弹窗。
- [x] 完成目标 Vitest、`pnpm check`、`pnpm i18n:check` 和 `git diff --check`。

### Task 79: 精简自动任务更新数量提示

**角色：** single_agent / copy update + verification

**Files:**
- Modify: `frontend/src/pages/marketing/agent-model-switch-automation-sync.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-model-switch-automation-sync.test.ts`
- Modify: `frontend/src/i18n/generated/*.json`

- [x] 将“检测到您已配置 x 个自动任务”改为“检测到 x 个自动任务需要更新”，保留动态数量。
- [x] 完成目标 Vitest、`pnpm check`、`pnpm i18n:check` 和 `git diff --check`。

### Task 80: 已过生效期任务继续同步模型

**角色：** single_agent / implementation + verification

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-model-switch-automation-sync.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-model-switch-automation-sync.test.ts`

- [x] 暂停及已过生效期的周期任务均计入模型更新提示与同步；仅已执行完的单次任务继续排除。
- [x] 完成目标 Vitest、`pnpm check`、`pnpm i18n:check` 和 `git diff --check`。
