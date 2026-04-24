# 营销 / 落地模块 (Marketing)

## 概述

营销模块覆盖 Lightclaw 的官网体验：**落地页、更新日志、OpenClaw 创建向导、
订阅支付、账户中心、订单列表、控制台主设置页**。是产品的对外门面和付费转化主阵地。

## 页面 / 路由

### 营销域主路径（`MarketingAuthGuard`）

| 路由 | 组件 | 职责 |
|------|------|------|
| `/`                    | `LandingPage`          | 官网首页（品牌落地） |
| `/changelog`           | `ChangelogPage`        | 更新日志（不需登录） |
| `/dashboard/create`    | `CreateOpenClawPage`   | 创建 OpenClaw 向导 |
| `/subscribe`           | `SubscribePage`        | 套餐选择 + 支付下单（50KB / 1446 行） |
| `/dashboard/setup`     | `OpenClawSetupPage`    | OpenClaw 初始化设置 |
| `/dashboard/success`   | `OpenClawSuccessPage`  | 创建成功落地 |
| `/dashboard/settings`  | `OpenClawSettingsPage` | 控制台主设置（125KB / 2929 行，业务核心） |
| `/account`             | `AccountPage`          | 个人中心（41KB / 1084 行，含实名认证入口） |
| `/account/orders`      | `AccountOrdersPage`    | 订单列表（14KB） |
| `/dashboard`（裸路径） | `<Navigate>`           | 兜底跳 `/dashboard/settings` |

### 旧路径兼容重定向（客户端 `<Navigate>`，保留观察窗口期）

历史上 `OpenClaw` 页面曾挂在 `/create-openclaw` / `/openclaw/*` / `/console/*` 下，
后重构到 `/dashboard/*`。为避免老书签 / 外链 404，保留客户端兼容：

- `/create-openclaw`   → `/dashboard/create`
- `/openclaw/setup`    → `/dashboard/setup`
- `/openclaw/success`  → `/dashboard/success`
- `/openclaw/settings` → `/dashboard/settings`
- `/console/{create|setup|success|settings}` → `/dashboard/{...}`

稳定一段时间后（预计 1~2 个版本）可集中清理。

### 认证域（`MarketingLayout` + `AuthRouteGuard`）

| 路由 | 组件 | 说明 |
|------|------|------|
| `/auth/sign-in`         | `SignInPage`   | 手机号 + 验证码登录 |
| `/auth/sign-up`         | `SignUpPage`   | 注册（当前已收敛到 sign-in） |
| `/auth/invite`          | `InvitePage`   | 邀请码校验 |
| `/auth/sign-up-code`    | `<Navigate>`   | → `/auth/sign-in` |
| `/auth/forgot-password` | `<Navigate>`   | → `/auth/sign-in` |

`AuthRouteGuard` 职责：已登录用户访问 `/auth/*` 时跳回首页 `/`，未登录放行。

### AppShell 域（`AppAccessGuard` + `AppShellLayout`）

控制台内页，使用左侧栏 + 顶栏的完整壳体布局：

| 路由 | 组件 | 文件 |
|------|------|------|
| `/settings/account`     | `AccountProfilePage` | `src/pages/app/account-profile-page.tsx` |
| `/bots/:id/workspace`   | `WorkspacePage`      | `src/pages/app/workspace-page.tsx` |
| `/bots/:id/settings`    | `SettingsPage`       | `src/pages/app/settings-page.tsx`（调用 `getSettingsSnapshot`） |
| `/bots/:id/terminal`    | `BotTerminalPage`    | `src/pages/app/bot-terminal-page.tsx` |
| `/*`（AppShell 内兜底） | `<Navigate>`         | → `/dashboard/settings` |

### 已登录用户域（`AuthenticatedGuard` + `PlanGuard`）

| 路由 | 组件 | 守卫链 | 职责 |
|------|------|--------|------|
| `/plans/select` | `PlanSelectPage` | `MarketingLayout` → `AuthenticatedGuard` → `PlanGuard` | 首次登录必须先选套餐 |

### 内部调试

| 路由 | 组件 |
|------|------|
| `/internal/style-lab` | `StyleLabPage` |

### 路由守卫矩阵

`src/router/guards.tsx` 导出 5 个守卫：

| 守卫 | 职责 | 使用位置 |
|------|------|---------|
| `MarketingAuthGuard`  | 未登录触发登录弹窗，已登录放行 | `/dashboard/*` / `/account/*` / `/subscribe` |
| `AuthRouteGuard`      | 已登录访问 `/auth/*` 跳首页 | `/auth/*` |
| `AuthenticatedGuard`  | 通用登录校验，供子守卫复用 | `/plans/select` 前链 |
| `PlanGuard`           | 首次登录必须先选套餐的时序控制 | `/plans/select` |
| `AppAccessGuard`      | AppShell 域准入；**当前等价 `AuthenticatedGuard`，预留订阅 / 权限扩展位** | `/bots/:id/*` / `/settings/account` / `/internal/style-lab` |


## 核心组件

### Landing 页分区组件 (`pages/marketing/landing/`)

| 组件 | 职责 |
|------|------|
| `hero-section.tsx` | 首屏（灯泡动效、"一分钟搞定，真的不难"标语） |
| `what-it-does-section.tsx` | 产品能做什么 |
| `how-easy-section.tsx` | 一分钟接入演示 |
| `where-to-use-section.tsx` | 使用场景 |
| `why-trust-section.tsx` | 为什么信赖 |
| `cta-footer-section.tsx` | 页脚 CTA |
| `landing-navbar.tsx` | 导航栏（含登录入口） |
| `particle-grid-canvas.tsx` | 粒子背景 Canvas |
| `starfield-canvas.tsx` | 星空背景 Canvas |
| `constants.ts` | Landing 页共享常量（文案、配色、时长） |

### OpenClaw 向导/设置页

- `create-openclaw-page.tsx` — 创建向导（类型选择、基础信息）
- `openclaw-setup-page.tsx` — 初始化设置（渠道绑定、部署参数）
- `openclaw-success-page.tsx` — 创建成功后的信息展示
- `openclaw-settings-page.tsx` — **最大页面（125KB / 2929 行）**，承载：
  - Bot 基础设置 / 版本管理
  - 通道配置（QQ、微信、企业微信等）
  - 工具（Tools）与知识库绑定
  - 审计日志
  - 灰度/回滚
- `openclaw-console-helpers.ts` — 控制台辅助函数
- `openclaw-tat-adapter.ts` — 与 TAT（腾讯自动化工具）适配器

### 订阅与账户

- `subscribe-page.tsx` — 套餐选择卡片 + 支付流程（50KB / 1446 行，详见 `plan.md`）
- `account-page.tsx` — 个人资料 / 订阅 / 权益 / 安全中心 / 实名认证入口（41KB / 1084 行）。实名状态以 `user.realnameVerified` 派生，认证弹窗 `VerifyIdentityModal` 调用 `AuthRepository.verifyRealname`；弹窗关闭**仅限右上角 X**（遮罩 / 容器点击不再关闭，避免误触）
- `account-orders-page.tsx` — 订单列表（筛选、查看支付凭证、14KB）
- `changelog-page.tsx` — 更新日志（Markdown 渲染）

## 数据流

- **领域上下文**：`OpenClawProvider`（`contexts/openclaw-context.tsx`），管理当前
  OpenClaw 实例状态与创建向导流程数据。
- **会话上下文**：`SessionProvider` 提供 `user` / `currentSubscription`，决定
  `MarketingAuthGuard` 是否放行。
- **API**：以 `BotRepository` 为主，组合 `PlanRepository` / `AuthRepository`。

### 营销分支（`src/pages/marketing/*`）真实 API 依赖

- **创建向导** `create-openclaw-page.tsx`：`listSoulTemplates()`
- **OpenClaw 上下文** `contexts/openclaw-context.tsx`：`createBot({name, soulTemplateId})`
- **`openclaw-settings-page.tsx`**（控制台主设置页，细颗粒 API 聚合）：
  - 微信登录（SSE 流）：`createWeixinLoginSession` / `getWeixinLoginSession` /
    `cancelWeixinLoginSession` / `subscribeWeixinLoginSessionEvents`
  - QQ 通道：`configureQQChannel`
  - 终端：`getTerminalSession`
  - 其它：`getBotBornCard` / `renameBot`
- **订阅与账户**：`PlanRepository`（套餐 / 订阅）、`AuthRepository`（资料、实名认证 `verifyRealname`）

### AppShell 分支（`src/pages/app/*`）真实 API 依赖

- **`/bots/:id/settings`（`settings-page.tsx`）**：
  `getSettingsSnapshot(botId, mode?)` → 返回 bot / versions / tools / knowledge /
  auditEvents / billing 的聚合快照（接口定义见 `repositories/types.ts`）
- **`/bots/:id/workspace`（`workspace-page.tsx`）**：`getWorkspaceSnapshot` /
  `sendWorkspaceMessage`
- **`/bots/:id/terminal`（`bot-terminal-page.tsx`）**：`getTerminalSession` /
  `execDebugCommand`

> 注意：`getSettingsSnapshot` **不在** `openclaw-settings-page.tsx` 使用；历史 spec 曾
> 将其归入营销分支，已在 `2026-04-23-spec-drift-fix-marketing-routes` 变更中更正。

## 业务规则

1. **登录门禁**：所有 OpenClaw 相关页面（create/setup/success/settings/account）
   进入前必须登录（MarketingAuthGuard）。未登录用户触发登录弹窗，登录后回到原页面。
2. **布局差异**：
   - 官网 Landing / changelog 使用品牌全屏布局（含 Hero 动效、粒子背景）
   - 认证页使用 `MarketingLayout`（简化页头 + 聚焦表单）
   - 控制台页使用 `AppShellLayout`（含侧边栏、顶部 Bar、面包屑）
3. **动效规范**：
   - Landing 灯泡入场做旋转上升，**到位后改为纯浮动**（不再使用雪碧图帧动画）
   - 粒子/星空背景 Canvas 组件按需启用，注意性能（低端设备降级）
4. **文案统一由 `landing/constants.ts` 管理**，不在组件内硬编码大段中文，便于后续 i18n。
5. **SEO**：Landing 使用 BrowserRouter 而非 Hash，需要配合后端/Cloudflare 返回
   index.html 做 SPA 兜底。
6. **响应式断点**：营销模块统一采用 Tailwind 默认断点
   - `default`（< 768px）：移动端单列堆叠布局，内边距 `px-4`，CTA 按钮 `w-full`
   - `md`（≥ 768px）：平板双列或多列，内边距 `px-6`
   - `lg`（≥ 1024px）：桌面完整布局（原设计稿），内边距 `px-10` / `px-[80px]`
   所有 section 必须在默认断点下提供可用的移动体验，禁止出现横向溢出。
7. **Landing Navbar 移动端**：
   - 未登录移动端：右上角显示"登录"小按钮 + 汉堡；"立即创建"CTA 下沉到汉堡面板内
   - 已登录移动端：右上角显示 Avatar + 汉堡
   - `<UserAvatarMenu />` 在任何时刻**只挂载一份**（通过 `useIsDesktop()` 按
     断点挂载），避免 `document.mousedown` 监听重复注册。
8. **前端临时 Feature Flag（源码常量模式）**：当某个功能依赖不稳定的后端 / 外部
   依赖时，必须提供「一行切换」的总开关：
   - **位置**：放在对应模块文件顶部，不走 `.env`、也不走远程 FF 服务
   - **命名**：全大写 `XXX_ENABLED`
   - **注释**：必须写明下线策略、关闭时 state 为何保留、上线时回切方式
   - **实现**：所有相关 JSX 用 `{FLAG && (...)}` 包裹；默认关闭 → 相关 DOM 完全
     不渲染、Modal 不挂载，避免用户路径触达
   避免跨环境漂移与基础设施成本；**功能稳定上线后必须清理常量与相关判定**，
   保持源码整洁（例：实名认证 `REALNAME_ENABLED` 已在上线后移除）。
9. **静态资源 URL 约定**：
   - 所有 `public` 根相对路径必须通过 `assetUrl(path)`（`src/lib/asset-url.ts`）包装
   - CDN 基址 `CDN_BASE` **硬编码**在源码常量中，**不通过环境变量配置**
   - 所有环境（dev / prod）统一走 CDN；切换 CDN 需修改常量并发版
   - 绝对 URL（`http(s)://` / `//`）与 `data:` URI 直接 passthrough，不二次拼接

## 测试覆盖

- `landing-page.test.tsx` — Landing 基础渲染
- `landing-page.integration.test.tsx` — 集成测试（含动效 mock）
- `openclaw-console-helpers.test.ts` — 控制台辅助函数
- `marketing-header-actions.test.tsx` — 营销头部动作
- `login-modal.test.tsx` — 跨页面登录弹窗

## 已知技术债

- `openclaw-settings-page.tsx` 单文件 125KB、2929 行，已远超健康阈值，后续需拆分
  子模块（通道配置 / 工具 / 知识库 / 审计等各自独立）。
- `account-page.tsx` 41KB / 1084 行，偏大（含实名认证入口），
  后续应拆分「账号信息 / 订阅 / 权益 / 安全中心 / 实名认证」为独立子组件；
  `VerifyIdentityModal` + 错误码映射函数 `mapErrorMessage` 应优先抽离为独立文件。
- Landing 页大量中文文案硬编码，未来做国际站时需要集中抽取。
- `src/lib/asset-url.ts` 的 `isUsingCdn` 恒为 `true`，保留为向后兼容导出，
  可后续批量 grep 清理调用方 import。
- 实名认证身份证号仅做正则粗校验（`^\d{17}[\dXx]$`），未实现 ISO 7064 MOD 11-2
  校验位算法；用户输错一位会被后端 `realname_mismatch` 拒回，体验上可优化
  （补 `utils.isValidIdCardNo()`：位数 + 校验位 + 地区码），不影响正确性。
