# 前端关键实现记录

> 记录时间：2026-04-28  
> 作用范围：`frontend/` 子项目  
> 目标：沉淀当前前端核心架构、关键数据流、主要页面逻辑与后端/SDK 接入方式，便于后续维护和迭代。

## 1. 项目定位与技术栈

`frontend/` 是 Lightclaw/LightVela 的前端应用，承载官网、登录、订阅权益、Hermes 创建、Hermes 管理、模型/通道/技能配置、终端访问、账号管理等主链路。

核心技术栈：

- React 19：`createRoot` + `StrictMode`
- TypeScript 5.9：开启 `strict`、`noUnusedLocals`、`noUnusedParameters`、`noUncheckedIndexedAccess`
- Vite 7：构建与本地开发
- React Router 7：`createBrowserRouter` + 嵌套路由 + Guard
- Tailwind CSS v4：全局样式与设计 token
- Radix UI + shadcn 风格自封装基础组件
- Framer Motion：页面动效与弹窗动效
- `@tencent/tea-sdk-lightclaw`：设置页内模型、通道、技能卡片能力
- `@xterm/xterm` + `@xterm/addon-fit`：Web Terminal

关键脚本位于 `frontend/package.json`：

- `pnpm dev`：启动 Vite dev server
- `pnpm dev:local`：设置 `VITE_LOCAL_SDK=1`，本地联调 SDK 源码
- `pnpm build`：`tsc -b && vite build`
- `pnpm check`：类型检查
- `pnpm test`：Vitest 测试
- `pnpm deploy:cf`：Cloudflare Pages 部署脚本

## 2. 启动链路

入口链路：

1. `frontend/index.html`
2. `frontend/src/main.tsx`
3. `frontend/src/app/app.tsx`
4. `frontend/src/router/index.tsx`

`main.tsx` 第一行必须加载：

- `@/polyfills/react-dom-compat`

原因是 React 19 移除了 `findDOMNode`、`render`、`unmountComponentAtNode`，而老的 `tea-component`/SDK 生态仍可能依赖这些 API。项目通过运行时 polyfill 与 `vite.config.ts` 构建期注入做多层兼容。

`App` 的 Provider 顺序：

```tsx
<RepositoryProvider>
  <SessionProvider>
    <OpenClawProvider>
      <ThemeStyleInjector />
      <RouterProvider router={router} />
    </OpenClawProvider>
  </SessionProvider>
</RepositoryProvider>
```

含义：

1. `RepositoryProvider` 初始化数据访问层。
2. `SessionProvider` 基于 repository 恢复登录态。
3. `OpenClawProvider` 基于会话态维护 Hermes/Bot 与权益状态。
4. `ThemeStyleInjector` 注入主题变量。
5. `RouterProvider` 接管页面渲染。

## 3. 路由与访问守卫

路由定义文件：`frontend/src/router/index.tsx`  
守卫定义文件：`frontend/src/router/guards.tsx`

### 3.1 公开页

- `/`：`LandingPage`
- `/changelog`：`ChangelogPage`

### 3.2 登录后主链路

这组路由挂在 `MarketingAuthGuard` 下。`MarketingAuthGuard` 的行为：

- `authReady=false` 时：展示 `GuardLoading`（"正在恢复会话..."）
- 已登录：正常渲染子路由
- 未登录：**不做重定向**，而是就地渲染品牌化登录引导 UI——包含"请先登录"标题、`LoginModal` 弹窗入口、返回首页链接和法律声明

路由列表：

- `/dashboard/create`：创建 Hermes（`CreateOpenClawPage`）
- `/subscribe`：订阅/权益购买与创建实例（`SubscribePage`）
- `/dashboard/setup`：初始化设置流程（`OpenClawSetupPage`）
- `/dashboard/success`：创建成功页（`OpenClawSuccessPage`）
- `/agents`：Agent 控制台（`OpenClawSettingsPage`，默认通道页）
- `/agents/:section`：Agent 控制台分区（channels / models / skills / persona / automations / memory / achievements / files / chat；国际站直达 persona / chat 时回到 `/agents`）
- `/account`：账号信息页（`AccountPage`）
- `/account/orders`：订单/发票页（`AccountOrdersPage`）
- `/dashboard`：重定向到 `/agents`
- `/dashboard/settings`：重定向到 `/agents`

同时保留老路径兼容重定向：

- `/create-openclaw` -> `/dashboard/create`
- `/openclaw/setup` -> `/dashboard/setup`
- `/openclaw/success` -> `/dashboard/success`
- `/openclaw/settings` -> `/agents`
- `/console/create` -> `/dashboard/create`
- `/console/setup` -> `/dashboard/setup`
- `/console/success` -> `/dashboard/success`
- `/console/settings` -> `/agents`

### 3.3 认证页

认证页套 `MarketingLayout + AuthRouteGuard`。`AuthRouteGuard` 仅允许未登录用户访问，已登录用户重定向到 `/`。

- `/auth/sign-in`：OAuth/游客登录（`SignInPage`）
- `/auth/sign-up`：当前收敛到登录逻辑（`SignUpPage`）
- `/auth/invite`：邀请码校验（`InvitePage`）
- `/auth/sign-up-code`、`/auth/forgot-password`：重定向到 `/auth/sign-in`

同组还包含需要登录态的套餐选择路由，套 `AuthenticatedGuard + PlanGuard`：

- `/plans/select`：套餐选择（`PlanSelectPage`），仅当用户已登录且 `planConfirmed=false` 时可访问

### 3.4 App Shell 路由

App Shell 路由套 `AppAccessGuard + AppShellLayout`。

`AppAccessGuard` 当前实现与 `AuthenticatedGuard` 完全一致（要求登录态，未登录重定向 `/`），保留为独立守卫是为了后续扩展订阅/权限检查。

- `/settings/account`：账户设置（`AccountProfilePage`，开发中）
- `/bots/:id/workspace`：Bot 工作空间（`WorkspacePage`）
- `/bots/:id/settings`：Bot 运行设置（`SettingsPage`）
- `/bots/:id/terminal`：独立的真实 Web Terminal 页面（`BotTerminalPage`）
- `*`（catch-all）：重定向到 `/agents`

### 3.5 内部路由

- `/internal/style-lab`：内部样式实验室（`StyleLabPage`，开发中），套 `AppAccessGuard + AppShellLayout`

### 3.6 全局 fallback

- `*`（顶层 catch-all）：`NotFoundPage`——展示"页面不存在"

### 3.7 守卫组件汇总

| 守卫 | 行为 | 使用位置 |
|------|------|----------|
| `GuardLoading` | `authReady=false` 时展示"正在恢复会话..." | 所有守卫内部复用 |
| `AuthRouteGuard` | 仅允许未登录用户，已登录重定向 `/` | `/auth/*` |
| `AuthenticatedGuard` | 要求登录态，未登录重定向 `/` | `/plans/select` |
| `PlanGuard` | 要求登录且 `planConfirmed=false`，否则重定向 `/` | `/plans/select` |
| `MarketingAuthGuard` | 未登录时就地展示品牌化登录引导 UI | `/dashboard/*`, `/subscribe`, `/account/*` |
| `AppAccessGuard` | 当前等同 `AuthenticatedGuard`，预留权限扩展 | `/bots/*`, `/settings/*`, `/internal/*` |

## 4. 状态管理

当前没有 Redux/Zustand/MobX，主要用 React Context + hooks。

### 4.1 `SessionProvider`

文件：`frontend/src/contexts/session-context.tsx`

负责认证态、用户资料、订阅快照和少量 UI 会话态。

核心状态：

- `authReady`：是否完成会话恢复
- `stage`：`anonymous | authenticated`
- `user`：当前用户
- `currentSubscription`：旧订阅模型快照
- `firstBotId`：本地 UI 态
- `inviteValidation`：邀请码校验结果

派生属性：

- `isAuthenticated`：`stage === "authenticated" && user !== null`
- `planConfirmed`：`currentSubscription?.status === "active"`

本地存储：

- key：`lightclaw-ui-session-v1`
- 仅持久化 `firstBotId` 与 `inviteValidation`
- 不持久化敏感认证信息

主要动作：

| 动作 | 签名 | 说明 |
|------|------|------|
| `signInWithCode` | `({ phone, code?, inviteCode? }) => Promise` | 短信验证码登录 |
| `signInAsGuest` | `() => Promise` | 游客体验 |
| `signUpWithCode` | `({ name, phone, code?, inviteCode? }) => Promise` | 短信注册 |
| `validateInviteCode` | `(code) => Promise<InviteCodeValidation>` | 校验邀请码 |
| `activateInviteCode` | `(code) => Promise` | 激活/消费邀请码 |
| `selectPlan` | `(tier: PlanTier) => Promise` | 选择订阅层级 |
| `updateProfile` | `({ name }) => Promise` | 修改昵称 |
| `uploadAvatar` | `(file: File) => Promise` | 上传头像（压缩至 200KB 内） |
| `refreshProfile` | `() => Promise` | 刷新用户资料 |
| `deleteAccount` | `() => Promise` | 注销账号 |
| `setFirstBotId` | `(botId \| null) => void` | 同步设置首个 Bot ID |
| `signOut` | `() => Promise` | 登出 |

初始化时会调用：

- `repositories.auth.getSession()`

如果 HTTP 层收到 401，会触发：

- `AUTH_UNAUTHORIZED_EVENT`

`SessionProvider` 监听该事件并自动清理登录态。订阅数据在登录后异步加载，不阻塞登录流程。

### 4.2 `OpenClawProvider`

文件：`frontend/src/contexts/openclaw-context.tsx`

负责 Hermes/Bot、权益与订阅派生状态。

核心状态：

- `isLoggedIn`：由 `SessionProvider` 派生
- `isSubscribed`：有活跃权益
- `activePass`：当前活跃的 Pass 对象（含 `credit_total`/`credit_available`）
- `bots`：Bot 列表
- `botsLoading`：Bot 加载中标记
- `user`：派生的 `OpenClawUser` 对象

`OpenClawBot` 前端类型：

```ts
{
  id: string
  name: string
  personality: string
  personalityEmoji: string
  intro: string
  soulTemplateId?: string
  status: "running" | "paused" | "draft"
  createdAt: string
  connectedChannels: ("wechat" | "qq")[]
  installedSkills: string[]
}
```

`OpenClawUser.plan` 包含字段：`name`、`tier`（free/plus/pro）、`trialDays`、`aiCredits`、`usedCredits`、`totalRequests`、`maxBots`。Plan 数据优先从 `activePass` 获取，无则用 `defaultPlan` 兜底。

Bot status 映射：后端 `"Running"` → `"active"` → 前端 `"running"`，`"Paused"` → `"paused"`，其他 → `"draft"`。`Bot.template` → `personality`，`Bot.mission` → `intro`。

> 注意：Channel detection 相关代码当前已注释，等待 openclaw config 恢复后重新启用。

主要动作：

- `refreshPasses()`：拉取 `/v1/passes`，更新当前活跃权益
- `refreshBots()`：拉取 `/v1/instances`，更新 Hermes/Bot 列表
- `addBot()`：创建后端实例，并写入前端状态（含 personality/intro/status 草稿元数据）
- `updateBot()`：本地更新 Bot 状态（不调后端）
- `deleteBot()`：删除后端实例，并移除本地状态
- `logout()`：清理权益、Bot 状态并调用 session signOut

登录后只执行一次 bots 和 passes 拉取（`fetchedRef` 防重），退出登录后重置状态。

## 5. Repository 数据访问层

核心文件：

- `frontend/src/repositories/types.ts`
- `frontend/src/repositories/http-repositories.ts`
- `frontend/src/repositories/fake-repositories.ts`
- `frontend/src/lib/auth-api-base.ts`

页面不直接依赖 `fetch`，统一通过 repository 接口访问数据：

- `repositories.auth`
- `repositories.plans`
- `repositories.bots`

### 5.1 HTTP/Fake 模式选择

`createRepositories()` 会调用 `resolveConfiguredAuthApiBaseUrl()` 判断当前运行模式。

规则：

- `VITE_AUTH_API_BASE_URL=mock`：使用 fake repositories
- `VITE_AUTH_API_BASE_URL=local-proxy`：baseUrl 为 `""`，请求走当前域名
- `VITE_AUTH_API_BASE_URL=<url>`：使用真实 HTTP API
- 未配置时根据当前 hostname 推断 API 域名：
  - `localhost`/`127.0.0.1` → `https://lightclaw.tech`
  - `lightclaw.tech`/`www.lightclaw.tech`/`*.pages.dev` → `https://lightclaw.tech`
  - `preview.lightclaw.cn`/`lightclaw.cn` → `https://api.lightclaw.cn`
  - `lightclaw.site`/`www.lightclaw.site` → `https://api.lightclaw.site`
  - `lightvela.tencent.com`/`www.lightvela.tencent.com` → `https://api.lightvela.tencent.com`
  - 其他 → `null`（降级 fake）
- 返回 `null` 时降级 fake repositories

HTTP 模式会先展开 fake repository，再覆盖真实实现：

```ts
return {
  ...createFakeRepositories(),
  auth: createHttpAuthRepository(baseUrl),
  plans: createHttpPlanRepository(baseUrl),
  bots: createHttpBotRepository(baseUrl),
};
```

这样可以让未接真实后端的能力继续用 fake 兜底。

### 5.2 认证 token

HTTP 认证 token 存储在 localStorage：

- key：`lightclaw-auth-token-v1`

OAuth 回跳时，前端通过 `bootstrapStoredAuthTokenFromLocation()` 从 URL hash 中读取 `session_token`，写入本地 token 并清理 URL fragment。后端响应中如果包含 `session.sessionToken` 也会自动更新本地 token。

### 5.3 本地草稿缓存

Bot 草稿信息缓存到 localStorage：

- key：`lightclaw-http-bot-drafts-v1`
- 存储内容：每个 Bot 的 `name`、`template`、`mission`、`scenario`、`status`、`type`
- 用途：在 API 延迟或创建流程中保留用户编辑的元数据

### 5.4 Repository 接口方法

**AuthRepository：**

| 方法 | HTTP 端点 | 说明 |
|------|-----------|------|
| `signInWithCode` | `POST /auth/sms/verify` | 短信验证码登录 |
| `signUpWithCode` | `POST /auth/sms/verify` | 短信注册 |
| `signInAsGuest` | `POST /auth/guest` | 游客登录 |
| `getSession` | `GET /auth/session` | 恢复会话 |
| `getProfile` | `GET /auth/profile` | 获取用户资料 |
| `updateProfile` | `PUT /auth/profile` | 更新昵称 |
| `uploadAvatar` | `PUT /auth/profile/avatar` | 上传头像（multipart） |
| `deleteAccount` | `DELETE /auth/profile` | 注销账号 |
| `signOut` | `DELETE /auth/session` | 登出 |
| `getOAuthStartUrl` | `GET /auth/oauth/{provider}/start` | 获取 OAuth 跳转 URL |
| `prepareInviteCode` | `POST /auth/invite/prepare` | 准备邀请码 |
| `validateInviteCode` | `POST /auth/invite/validate` | 校验邀请码 |
| `activateInviteCode` | `POST /auth/invite/activate` | 激活邀请码 |
| `verifyRealname` | `POST /auth/realname/verify` | 实名认证 |

**PlanRepository：**

| 方法 | HTTP 端点 | 说明 |
|------|-----------|------|
| `getCurrentSubscription` | `GET /subscriptions/current` | 获取当前订阅 |
| `updateSubscription` | `POST /subscriptions/checkout` | 更新订阅（tier 映射：free/lite→plus/pro→max） |
| `getPlanPreview` | `GET /subscriptions/current` | 套餐预览 |
| `listBundles` | `GET /v1/bundles` | 获取套餐包列表 |
| `createPass` | `POST /v1/passes` | 创建权益 |
| `listMyPasses` | `GET /v1/passes` | 获取我的权益列表 |

**BotRepository：**

| 方法 | HTTP 端点 | 说明 |
|------|-----------|------|
| `getDashboardSnapshot` | `GET /v1/instances` | 获取 Bot 列表 |
| `createBot` | `POST /v1/instances` | 创建 Bot（timeout: 3600s） |
| `destroyBot` | `DELETE /v1/instances/{id}` | 删除 Bot |
| `renameBot` | `PUT /v1/instances/{id}` | 重命名 Bot |
| `updateBotProfile` | `PUT /v1/instances/{id}` | 更新 Bot 属性 |
| `getTerminalSession` | `POST /sandboxes/{sandboxId}/tat/session` | 获取终端会话 |
| `configureQQChannel` | `POST /v1/instances/{id}/channels/config` | 配置 QQ 通道 |
| `createWeixinLoginSession` | `POST /v1/instances/{id}/channels/weixin/login-sessions` | 创建微信登录会话 |
| `getWeixinLoginSession` | `GET /v1/instances/{id}/channels/weixin/login-sessions/{sid}` | 查询微信登录状态 |
| `cancelWeixinLoginSession` | `POST /v1/instances/{id}/channels/weixin/login-sessions/{sid}/cancel` | 取消微信登录 |
| `subscribeWeixinLoginSessionEvents` | `GET .../events`（SSE） | 订阅微信登录事件流 |
| `execDebugCommand` | `POST /v1/instances/{id}/debug/exec` | 执行调试命令 |
| `listSoulTemplates` | `GET /v1/soul-templates` | 获取灵魂模板列表 |

### 5.5 统一响应与错误处理

HTTP 层统一处理：

- 请求辅助函数：`request<T>`（自动 Bearer token + 401 广播）、`requestEnvelope<T>`（解包 data）、`requestMultipart<T>`（multipart 上传）
- envelope 解包：`code/message/data/request_id`
- 401 自动清 token 并广播 `AUTH_UNAUTHORIZED_EVENT`
- 后端错误转换为 `RepositoryError(message, status, code?, retryAfterSeconds?)`
- 部分业务错误保留 `code`，供页面做特殊处理，例如 `PASS_ALREADY_EXISTS`、邀请码相关错误
- SSE 事件解析：支持 `event:`/`data:` 行 + JSON 解析，keepalive 注释 `:` 被忽略

## 6. 核心业务页面

### 6.1 首页与登录

首页：`frontend/src/pages/marketing/landing-page.tsx`

首页由 landing 子组件组成：

- `LandingNavbar`
- `HeroSection`
- `WhatItDoesSection`
- `WhereToUseSection`
- `HowEasySection`
- `WhyTrustSection`
- `CTAFooterSection`

登录弹窗：`frontend/src/components/site/login-modal.tsx`

登录方式：

- QQ OAuth
- 微信 OAuth
- GitHub OAuth：默认隐藏，可通过控制台 `show_github_login()` 显示
- Google OAuth：主要在独立登录页展示
- 游客体验：`signInAsGuest()`

登录弹窗要求先勾选服务协议/隐私协议，再允许 OAuth 跳转。弹窗内还嵌套 `InviteCodeModal`，用于在需要时引导用户输入邀请码。

### 6.2 认证页面

文件：`frontend/src/pages/auth/`

#### 登录页（SignInPage）

文件：`frontend/src/pages/auth/sign-in-page.tsx`

提供完整 OAuth 登录 UI：

- QQ、微信、GitHub（条件显示）、Google
- 游客体验入口
- OAuth 跳转通过 `getOAuthStartUrl(provider)` 构建

#### 注册页（SignUpPage）

文件：`frontend/src/pages/auth/sign-up-page.tsx`

当前收敛为登录逻辑，无独立注册流程。

#### 邀请码页（InvitePage）

文件：`frontend/src/pages/auth/invite-page.tsx`

邀请码校验入口，校验通过后引导用户进入登录/注册流程。

#### OAuth 回调页（OAuthLoginEntryPage）

文件：`frontend/src/pages/auth/oauth-login-entry-page.tsx`

处理 OAuth 回调的中间页，从 URL fragment 中提取 `session_token`，完成 token 写入后跳转到应用主页。

### 6.3 创建 Hermes

页面：`frontend/src/pages/marketing/create-openclaw-page.tsx`

流程：

1. 输入 Hermes 昵称。
2. 选择 SOUL 模板。
3. 填写一句简介。
4. 通过 `repositories.bots.listSoulTemplates()` 拉远端模板。
5. 拉取失败则使用本地 fallback 模板。
6. 点击下一步跳转 `/subscribe`，并通过 router state 传递创建信息。

注意：当前 `SubscribePage` 创建实例时仍使用默认名称和默认模板，没有消费从创建页传来的 `botName/personality/intro/soulTemplateId`。这是后续需要修复的实现断点。

### 6.4 订阅与创建实例

页面：`frontend/src/pages/marketing/subscribe-page.tsx`

流程：

1. 加载套餐：`repositories.plans.listBundles()` -> `GET /v1/bundles`
2. 映射为前端 `PlanInfo`，每个套餐标注核心特性（AI 额度、agent 配额、通道数等）
3. 免费套餐跳过支付，直接执行创建
4. 未订阅时先创建权益：`repositories.plans.createPass(bundle_id)` -> `POST /v1/passes`
5. 如果后端返回 `PASS_ALREADY_EXISTS`，不视为失败，继续创建实例
6. 创建实例：`addBot()` -> `repositories.bots.createBot()` -> `POST /v1/instances`
7. 成功后跳转 `/agents?creating=true`
8. 设置页展示创建 loading 动画，结束后切到最新 Bot

邀请码相关错误会触发 `InviteCodeModal`，激活邀请码后自动继续之前的套餐流程。

页面内含 14 种错误码的用户友好提示映射（如 `PASS_ALREADY_EXISTS`、`INVITE_CODE_REQUIRED`、`RESOURCE_EXHAUSTED` 等）。

### 6.5 初始化设置页

页面：`frontend/src/pages/marketing/openclaw-setup-page.tsx`

两步向导流程：

**第一步：通道选择（Channel）**
- 微信通道：当前 Coming Soon 灰显不可选
- QQ 通道：需输入 App ID + App Secret
- 提交后模拟成功，进入第二步

**第二步：人设选择（Persona）**
- 三个预设人设：
  - 贾维斯（Jarvis）🤖 —— 冷静理性的全能AI管家
  - 露娜（Luna）🌙 —— 温柔体贴的月光精灵
  - 火花（Spark）🔥 —— 充满激情的创意伙伴
- 每个人设预装 3 个技能：日程管理、邮件撰写、ETL 数据管道
- 确认后展示安装进度条（120ms tick，约 6 秒完成），安装完成后弹出成功弹窗

导航：支持跳过 → 首页、返回 → 订阅页。当前通道认证和人设安装均为 mock 实现。

### 6.6 创建成功页

页面：`frontend/src/pages/marketing/openclaw-success-page.tsx`

核心功能：

- 彩屑动画：20 个粒子从顶部下落
- 成功消息：显示 "🎉 Hermes 创建成功！"
- 已创建 Agent 卡片：展示 Bot 头像、名称和继续配置提示
- 导航：`"管理我的智能体伙伴"` → `/agents`

### 6.7 Agent 控制台

页面：`frontend/src/pages/marketing/openclaw-settings-page.tsx`

这是当前前端最核心页面（约 2900 行），包含大量业务逻辑：

**Bot Tab 管理：**
- 多 Bot tab 切换，带动画指示器
- Bot 配额限制（基于订阅计划的 `maxBots`）
- "创建新 Bot" 按钮（导航到 `/subscribe`）

**Bot 信息展示与编辑：**
- 内联重命名（Enter 保存，Esc 取消）
- 状态指示器：🟢 运行中 / 🟠 已暂停 / ⚪ 未知
- 连接通道 badge、已安装技能 tag
- 基于 Bot ID 的确定性头像 hash

**创建中 Loading：**
- `CreatingLoadingView`：动画 Hermes 角色 + "正在给 Hermes Agent 喂咖啡，唤醒大脑中..."（约 6 秒持续时间）

**六大弹窗/对话框：**

1. **微信二维码弹窗**：SSE 事件流 + 智能降级轮询，复杂状态机（creating → starting → waiting_qr → scanned → success/failed/expired/timeout），重试逻辑（session 创建 40 次、轮询 30 次、3-5s 延迟），处理"已有活跃 session"冲突
2. **QQ 通道配置弹窗**：App ID + App Secret 表单，gateway 重启通知，外部文档链接
3. **终端弹窗（TerminalModal）**：XTerm.js 集成，BSON/JSON 帧解码，Base64 UTF-8 PTY 通信
4. **删除确认对话框**：需输入 Bot 名称匹配验证
5. **通道配置弹窗**：连接通道展示 + 嵌套微信 QR/QQ 表单

**SDK 集成（tea-sdk-lightclaw）：**
- `ModelCard`：添加/管理语言模型
- `ChannelCard`：配置通信通道
- `SkillCard`：安装 agent 技能
- `createLighthouseConfig` + `initI18n`（显式调用避免 tree-shaking 丢失文案）
- 功能标志：`gateway: true, channel: true, wecomChannel: true, weixinChannel: true, qrConfig: true, skills: true`
- 禁用腾讯云 provider：`supportsTencentCloudApi: false`，过滤掉 hunyuan、qcloud_lkeap、tencent_coding_plan、tencent_token_plan

### 6.8 账号页

页面：`frontend/src/pages/marketing/account-page.tsx`

能力：

- 未登录时展示登录/游客体验入口
- 展示当前用户头像、昵称、实名状态、订阅/权益状态
- 修改昵称：`updateProfile()`
- 上传头像：先压缩到 200KB 内，再 `uploadAvatar()`
- 实名认证：`auth.verifyRealname({ name, idCard })`
- 实名成功后调用 `refreshProfile()` 刷新 `user.realnameVerified`
- 注销账号：`deleteAccount()`

订阅展示优先级：

1. `OpenClawProvider.activePass`
2. `SessionProvider.currentSubscription`
3. 默认体验版展示

### 6.9 订单页

页面：`frontend/src/pages/marketing/account-orders-page.tsx`

当前订单数据为本地 mock：`mockOrders`。

能力：

- 展示订单列表
- 发票申请弹窗
- 发票字段简单校验

尚未接真实订单 API。

### 6.10 套餐选择页

页面：`frontend/src/pages/app/plan-select-page.tsx`

流程：

1. 调用 `repositories.plans.getPlanPreview()` 加载套餐预览
2. 三栏 `PlanCard` 展示（当前仅 free 可选，Plus/Max 标记 Coming Soon）
3. 左侧面板说明"为什么需要先选择套餐"
4. 选择后调用 `selectPlan(tier)` → 导航到 `/subscribe`

### 6.11 Changelog 页

页面：`frontend/src/pages/marketing/changelog-page.tsx`

- 数据驱动渲染，当前仅一条记录：LightVela 发布（2026-04-21）
- 左右双栏布局（140px 日期列 + 内容列）
- Framer Motion 交错动画（fadeInUp）
- 含静态配图（`/changelog/lightvela-launch.png`，710x360）

### 6.12 App Shell 内页面

**SettingsPage**（`frontend/src/pages/app/settings-page.tsx`）：

- Bot 运行设置页面
- QQ 通道配置表单（App ID + App Secret + 可选 QQ Account）
- 调用 `repositories.bots.configureQQChannel()`，支持 gateway 重启状态提示
- 展示 Bot ID 和沙箱信息

**WorkspacePage**（`frontend/src/pages/app/workspace-page.tsx`）：

- Bot 工作空间 shell
- 当前为轻量框架，预备接入消息流、日志流和运行态
- 导航按钮：进入终端、Bot 设置

**AccountProfilePage**（`frontend/src/pages/app/account-profile-page.tsx`）：

- 账户设置页，当前为占位页（开发中）

**StyleLabPage**（`frontend/src/pages/app/style-lab-page.tsx`）：

- 内部样式实验室，当前为占位页（开发中）

## 7. 通道接入实现

主要在 `OpenClawSettingsPage` 内。

### 7.1 微信通道

核心流程：

1. 创建微信登录会话：`repositories.bots.createWeixinLoginSession(bot.id)`
2. 获取 `sessionId`
3. 优先订阅 SSE：`repositories.bots.subscribeWeixinLoginSessionEvents(bot.id, sessionId, signal)`
4. SSE 收到 `qr_url` 后展示二维码
5. SSE 收到 `success` 后把 `wechat` 写入当前 Bot 的 `connectedChannels`
6. 如果 SSE 不可用或中断，降级轮询：`repositories.bots.getWeixinLoginSession(bot.id, sessionId)`
7. 弹窗关闭或组件卸载时取消未完成 session：`cancelWeixinLoginSession`

针对后端状态做了容错：

- 实例未就绪：轮询重试创建 session
- 已有活跃 session：尝试取消旧 session 后重试
- 终态：`success/failed/expired/cancelled/timeout`

### 7.2 QQ 通道

核心流程：

1. 用户输入 `appId/appSecret/account`
2. 调用 `repositories.bots.configureQQChannel(bot.id, { appId, appSecret, account })`
3. 成功后将 `qq` 写入 `connectedChannels`
4. 根据返回的 `gatewayRestarted` 展示不同提示

## 8. 终端实现

终端有两个入口：

- 独立页：`frontend/src/pages/app/bot-terminal-page.tsx`
- 设置页弹窗：`OpenClawSettingsPage` 内部 `TerminalModal`

核心流程：

1. 调用 `repositories.bots.getTerminalSession(botId)`。
2. 后端返回 TAT bootstrap 信息：`wsUrl/sessionId/ownerUin/appId/instanceId/region/sandboxId`。
3. 前端初始化 `xterm` 与 `FitAddon`。
4. 创建 WebSocket：`new WebSocket(bootstrap.wsUrl)`。
5. WebSocket open 后发送 `SessionAuth`。
6. 延迟发送 `PtyStart`。
7. 用户输入通过 `PtyInput` 发送，内容 Base64 编码。
8. 窗口 resize 时发送 `PtyResize`。
9. WebSocket message 支持 JSON 与 BSON 解码。
10. 收到 `PtyOutput` 后解码输出并写入 terminal。
11. 卸载时发送 `PtyStop` 并关闭 socket。

## 9. SDK 命令适配层

文件：`frontend/src/pages/marketing/openclaw-tat-adapter.ts`

背景：`@tencent/tea-sdk-lightclaw` 默认走腾讯云 TAT OpenAPI 执行命令，但 mono 当前实际后端入口是：

```text
POST /v1/instances/:botId/debug/exec
```

因此前端实现了 `createMonoDebugExecAdapter()`，把 SDK 的 TAT 语义桥接到 mono debug/exec。

关键约定：

- SDK 的 `InstanceIds[0]` 直接使用 `activeBot.id`
- 也就是说 SDK 认为的 `InstanceId` 在 mono 场景下就是业务 `botId`
- 后端负责从 `botId` 映射到底层 sandbox/cloud instance
- 前端不感知 `sandboxId/region` 等细节

适配器能力：

- `runCommand()`：记录 SDK 下发的 Base64 command，返回合成 `InvocationId`
- `getInvocationTask()`：真正执行命令，并返回 SDK 期望的 `TaskStatus/TaskResult.Output`
- 普通命令走同步 `POST /debug/exec`
- 带 `onProgress` 的命令走 SSE，实时推送 stdout chunk
- 输出统一转成 Base64，匹配 SDK 的 TAT 语义

设置页注入方式：

```ts
const sdkProductConfig = {
  ...createLighthouseConfig({
    agentType: "hermes",
    supportsTencentCloudApi: false,
  }),
  acliProduct: "lightvela", // lightvela 实例无公网 IP, SDK 据此屏蔽元宝通道
  runCommand: commandAdapter.runCommand,
  getInvocationTask: commandAdapter.getInvocationTask,
};
```

`supportedTencentCloudApi: false` 会让 SDK 过滤掉依赖腾讯云账号体系的 provider。

## 10. 样式与主题

核心文件：

- `frontend/src/styles.css`
- `frontend/src/theme/preset.ts`
- `frontend/src/theme/theme-style.tsx`

`styles.css` 负责：

- Tailwind v4 入口
- 全局 CSS variables
- 字体定义
- 全局 reset
- LightVela/Lightclaw 页面公共 class

`preset.ts` 定义主题变量，`ThemeStyleInjector` 在运行时把变量写入 `document.documentElement`，并设置：

```ts
document.documentElement.dataset.theme = "lightclaw";
```

## 11. 构建与 React 19 兼容

核心文件：

- `frontend/vite.config.ts`
- `frontend/src/polyfills/react-dom-compat.ts`

兼容策略分三层：

1. Vite/esbuild dev 预打包阶段注入 `findDOMNode` patch。
2. Vite transform 阶段二次注入。
3. `main.tsx` 第一行运行时兜底。
4. 生产构建还通过 Rollup `renderChunk` 对 entry chunk 注入 patch。

本地 SDK 联调：

- `VITE_LOCAL_SDK=1 pnpm dev`
- 或 `pnpm dev:local`

此时 Vite alias 会把 `@tencent/tea-sdk-lightclaw` 指向本地 SDK 源码，并 dedupe React，避免多 React 实例问题。

## 12. 组件体系

### 12.1 UI 基础组件（shadcn 风格）

目录：`frontend/src/components/ui/`

基于 Radix UI + Tailwind CSS 封装的无业务逻辑基础组件，支持组合式使用：

badge、button、card（Header/Title/Description/Content/Footer）、chat-bubble、composer-panel、cta-button、dialog、display-title、glass-card、input、label、page-header、scroll-area、select、stat-tile、state-panel、tabs、textarea、inset-panel、ambient-glow

### 12.2 业务组件（domain）

目录：`frontend/src/components/domain/`

| 组件 | 用途 |
|------|------|
| `alert-card` | 告警卡片，支持 critical/warning/info 级别 |
| `audit-log-table` | 审计日志表格（Actor/Action/Target/Time） |
| `billing-summary-card` | 费用指标卡片（当前/预估/预算） |
| `bot-status-card` | 运行态健康卡片（p95 延迟、吞吐、活跃会话、心跳） |
| `code-input` | 6 位验证码输入组件（隐藏 text input + 视觉网格） |
| `config-section` | 可复用的配置面板容器（标题、描述、图标、子内容） |
| `event-feed` | 审计事件时间线卡片 |
| `invite-status-card` | 邀请码状态 badge（idle/valid/invalid/expired/used） |
| `plan-card` | 套餐定价卡片，支持选中态和 Coming Soon badge |
| `release-item` | Bot 版本卡片，含回滚按钮 |
| `scenario-switcher` | live/empty/error 数据模式切换下拉 |
| `setup-step-timeline` | 设置进度时间线（"创建 Hermes" → "订阅"） |

### 12.3 站点组件（site）

目录：`frontend/src/components/site/`

| 组件 | 用途 |
|------|------|
| `brand-mark` | Logo/品牌标识链接 |
| `homepage-grammar` | 首页设计体系组件集（GrammarCanvas、GrammarHero、GrammarSection、GrammarPanel、GrammarMiniStat、GrammarPageIntro、GrammarSectionCard） |
| `legal-footer` | 页脚：版权、ICP 备案链接、隐私/条款链接 |
| `login-modal` | OAuth 登录弹窗（QQ/微信/GitHub）+ 协议勾选 + 邀请码弹窗 |
| `marketing-header-actions` | Header 按钮组：根据登录态展示登录/进入管理台/继续设置 |
| `user-avatar-menu` | 用户下拉菜单：用户信息、"我的 Bot"、"账号"、登出 |

## 13. 关键文件索引

入口与应用：

- `frontend/index.html`
- `frontend/src/main.tsx`
- `frontend/src/app/app.tsx`

路由与布局：

- `frontend/src/router/index.tsx`
- `frontend/src/router/guards.tsx`
- `frontend/src/layouts/marketing-layout.tsx`
- `frontend/src/layouts/app-shell-layout.tsx`

状态：

- `frontend/src/contexts/repository-context.tsx`
- `frontend/src/contexts/session-context.tsx`
- `frontend/src/contexts/openclaw-context.tsx`

数据层：

- `frontend/src/repositories/types.ts`
- `frontend/src/repositories/http-repositories.ts`
- `frontend/src/repositories/fake-repositories.ts`
- `frontend/src/lib/auth-api-base.ts`
- `frontend/src/lib/oauth.ts`

认证页面：

- `frontend/src/pages/auth/sign-in-page.tsx`
- `frontend/src/pages/auth/sign-up-page.tsx`
- `frontend/src/pages/auth/invite-page.tsx`
- `frontend/src/pages/auth/oauth-login-entry-page.tsx`

Marketing 页面：

- `frontend/src/pages/marketing/landing-page.tsx`
- `frontend/src/pages/marketing/create-openclaw-page.tsx`
- `frontend/src/pages/marketing/subscribe-page.tsx`
- `frontend/src/pages/marketing/openclaw-settings-page.tsx`
- `frontend/src/pages/marketing/openclaw-setup-page.tsx`
- `frontend/src/pages/marketing/openclaw-success-page.tsx`
- `frontend/src/pages/marketing/account-page.tsx`
- `frontend/src/pages/marketing/account-orders-page.tsx`
- `frontend/src/pages/marketing/changelog-page.tsx`

App Shell 页面：

- `frontend/src/pages/app/bot-terminal-page.tsx`
- `frontend/src/pages/app/plan-select-page.tsx`
- `frontend/src/pages/app/settings-page.tsx`
- `frontend/src/pages/app/workspace-page.tsx`
- `frontend/src/pages/app/account-profile-page.tsx`
- `frontend/src/pages/app/style-lab-page.tsx`

站点组件：

- `frontend/src/components/site/login-modal.tsx`
- `frontend/src/components/site/brand-mark.tsx`
- `frontend/src/components/site/homepage-grammar.tsx`
- `frontend/src/components/site/legal-footer.tsx`
- `frontend/src/components/site/marketing-header-actions.tsx`
- `frontend/src/components/site/user-avatar-menu.tsx`

SDK/终端/命令适配：

- `frontend/src/pages/marketing/openclaw-tat-adapter.ts`
- `frontend/src/pages/marketing/openclaw-console-helpers.ts`

样式与构建：

- `frontend/src/styles.css`
- `frontend/src/theme/preset.ts`
- `frontend/src/theme/theme-style.tsx`
- `frontend/src/polyfills/react-dom-compat.ts`
- `frontend/vite.config.ts`
