# 营销 / 落地模块 (Marketing)

## 概述

营销模块覆盖 Lightclaw 的官网体验：**落地页、更新日志、OpenClaw 创建向导、
订阅支付、账户中心、订单列表、Agent 控制台**。是产品的对外门面和付费转化主阵地。

## 页面 / 路由

### Next App Router 主路径

| 路由 | 组件 | 职责 |
|------|------|------|
| `/subscribe`           | `next-site/SubscribePage` | 套餐选择 + 支付下单（Next 静态导出 + client auth island） |

### 营销域主路径（`MarketingAuthGuard`）

| 路由 | 组件 | 职责 |
|------|------|------|
| `/`                    | `LandingPage`          | 官网首页（品牌落地） |
| `/changelog`           | `ChangelogPage`        | 更新日志（不需登录） |
| `/dashboard/create`    | `CreateOpenClawPage`   | 创建 OpenClaw 向导 |
| `/dashboard/setup`     | `OpenClawSetupPage`    | OpenClaw 初始化设置 |
| `/dashboard/success`   | `OpenClawSuccessPage`  | 创建成功落地 |
| `/agents`              | `OpenClawSettingsPage` | Agent 控制台（默认通道页，业务核心） |
| `/agents/:section`     | `OpenClawSettingsPage` | Agent 能力分区；支持 channels / models / skills / persona / automations / memory / achievements / files / chat / diagnostics；国际站直达 persona / chat 时回到 `/agents` |
| `/account`             | `AccountPage`          | 个人中心（41KB / 1084 行，含实名认证入口） |
| `/account/orders`      | `AccountOrdersPage`    | 订单列表（14KB） |
| `/dashboard`（裸路径） | `<Navigate>`           | 兼容跳 `/agents` |
| `/dashboard/settings`  | `<Navigate>`           | 兼容跳 `/agents` |

### 旧路径兼容重定向（客户端 `<Navigate>`，保留观察窗口期）

历史上 `OpenClaw` 页面曾挂在 `/create-openclaw` / `/openclaw/*` / `/console/*` 下，
后重构到 `/dashboard/*`。为避免老书签 / 外链 404，保留客户端兼容：

- `/create-openclaw`   → `/dashboard/create`
- `/openclaw/setup`    → `/dashboard/setup`
- `/openclaw/success`  → `/dashboard/success`
- `/openclaw/settings` → `/agents`
- `/console/settings` → `/agents`
- `/console/{create|setup|success}` → `/dashboard/{...}`

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
| `/*`（AppShell 内兜底） | `<Navigate>`         | → `/agents` |

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
| `where-to-use-section.tsx` | 使用场景；按 `isGlobal` 渲染不同平台卡片：国内站 QQ / 微信 / 飞书 / 企业微信，国际站 Telegram / WhatsApp / Discord / Slack |
| `why-trust-section.tsx` | 为什么信赖 |
| `cta-footer-section.tsx` | 页脚 CTA |
| `landing-navbar.tsx` | 导航栏（含登录入口、`<LanguageSwitcher>` 仅国际站挂载） |
| `particle-grid-canvas.tsx` | 粒子背景 Canvas |
| `constants.ts` | Landing 页共享常量（配色、时长、动效参数；**不再承载中文文案**，文案走 `useT()`） |

### OpenClaw 向导/设置页

- `create-openclaw-page.tsx` — 创建向导（类型选择、基础信息）
- `openclaw-setup-page.tsx` — 初始化设置（渠道绑定、部署参数）
- `openclaw-success-page.tsx` — 创建成功后的信息展示
- `openclaw-settings-page.tsx` — **最大页面（125KB / 2929 行）**，作为 `/agents` Agent 控制台承载：
  - Bot 基础设置 / 版本管理
  - 通道配置（QQ、微信、企业微信等）
  - 工具（Tools）与知识库绑定
  - 审计日志
  - 灰度/回滚
- `openclaw-console-helpers.ts` — 控制台辅助函数
- `openclaw-tat-adapter.ts` — 与 TAT（腾讯自动化工具）适配器

### 自动任务与场景任务内部实现

- `/agents/automations` 由 `hermes-agent-automations-panel.tsx` 承载，复用
  `lib/hermes-cron-client.ts` 管理普通自动任务模板、创建、编辑、暂停、恢复、删除和最近执行。
- `pages/marketing/scenario-tasks/` 保留场景配置、prompt/schedule builder、安装弹窗、启用确认弹窗和目标单测。
- **当前产品状态（2026-07-14 起）**：国内站与国际站均不渲染 `ScenarioTaskGrid`，也不提供场景任务的用户可达入口；现有普通自动任务能力不受影响。不得仅根据目录仍存在就推断场景卡片已经上线。
- 场景扫码实现调用 `acli gateway qr-url --platform <platform> --wait true`。由于命令会在扫码完成前持续运行，前端必须通过可取消的 SSE `debug/exec` 流式读取 stdout，在二维码 URL 出现后立即展示；关闭、刷新或重试时取消旧请求。
- 若未来重新开放场景入口，必须重新完成产品范围确认、双站验收、i18n 和浏览器回归，并同步更新本 Spec。

### Agent 诊断中心

- `agent-settings-page.tsx` 在 `/agents/diagnostics` 承载诊断中心。
- Agent 备份与恢复入口：
  - 国内站默认展示，维持既有诊断中心路径。
  - 国际站默认隐藏，不渲染备份 / 恢复面板，不挂载确认弹窗，不查询导出 / 导入状态，也不启动轮询。
  - 国际站仅在控制台执行 `show()`、令隐藏工具可见后展示，行为与“终端”“浏览器”等隐藏入口保持一致。
  - 该显隐规则只影响前端诊断入口，不改变后端 worker action、备份包格式或恢复流程。

### 订阅与账户

- `next-site/subscribe-page.tsx` — 套餐选择卡片 + 支付流程（50KB / 1446 行，详见 `plan.md`）
- `account-page.tsx` — 个人资料 / 订阅 / 权益 / 安全中心 / 实名认证入口（41KB / 1084 行）。实名状态以 `user.realnameVerified` 派生，认证弹窗 `VerifyIdentityModal` 调用 `AuthRepository.verifyRealname`；弹窗关闭**仅限右上角 X**（遮罩 / 容器点击不再关闭，避免误触）
- `account-orders-page.tsx` — 订单列表（筛选、查看支付凭证、14KB）
- `changelog-page.tsx` — 更新日志（数据驱动列表 + Figma 配图卡片）。文案与配图按 `isGlobal` 分叉：
  - 国内站：文案描述 QQ / 微信 / 飞书；配图 `assets/changelog/lightvela-launch.png`（中文 + 国内渠道图标）
  - 国际站：文案描述 Telegram / WhatsApp / Discord / Slack；配图 `lightvela-launch-en.png`（**始终使用英文版**，即使用户切回中文也不变，避免同站点出现国内渠道图标错位）

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
4. **i18n 与文案抽取**：业务文案不再硬编码，统一通过 `useT()`（`src/i18n/t.ts`）以中文原文作为 key 调用，由 `pnpm i18n:extract` 扫描生成 `src/i18n/generated/*.json` 字典；运行时反查 hash → 目标语言。`pnpm i18n:check` 作为 CI 门禁拦截缺失翻译。`landing/constants.ts` 只承载非文案常量（配色 / 时长 / 动效参数），文案出现在组件内 `t("…中文…")` 字面量调用处，便于 extract 脚本扫描。
5. **SEO**：公开站点使用 Next App Router + static export，深链刷新由静态托管规则
   指向对应目录的 `index.html`。SEO 元数据由 `src/lib/seo-data.ts` 统一维护，按
   `cn/global` region 输出不同 title suffix、description、keywords、OG/Twitter/
   canonical/robots 字段；`src/lib/seo-html.ts` 负责 dev/prerender HTML 注入。
   由于 `generate-static-site.mjs` 暂时维护了一份镜像数据，必须通过
   `src/lib/__tests__/seo-site-mirror.test.ts` 守护 prerender route 与运行时
   `getSeoMeta()` 一致。head 标签 upsert 必须支持任意属性顺序并去重重复
   `title/meta/link`，避免爬虫在多条同名 SEO 标签之间取错值。
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
   - `assetUrl(path)` 只归一化为站点根路径；Pages / EdgeOne 本身就是 CDN，不再额外拼接独立 COS CDN 域名
   - 随前端发布的静态资源必须进入站点构建产物，跟随 `pnpm build*` 的压缩与 WebP 后处理
   - 绝对 URL（`http(s)://` / `//`）与 `data:` URI 直接 passthrough，不二次拼接
10. **区域化（国内 / 国际站）编译期分支**：
    - `src/lib/region.ts` 暴露 `REGION` / `isCN` / `isGlobal` / `DEFAULT_LOCALE` 编译期常量，由 `NEXT_PUBLIC_REGION`（兼容读取 `VITE_REGION`）在 Next 构建期注入；未命中分支会被 Tree-shake，不会进入对侧站点 bundle。
    - 业务侧的「国内 vs 国际」差异**必须**走 `isCN` / `isGlobal` 编译期分支（如 OAuth 渠道、首页平台卡片、changelog 接入通道文案、法律页脚），**不得**通过运行时语言（locale）判断——否则会出现"国际站切回中文却显示国内渠道"的信息错位。
    - 双产物：`pnpm build:cn` / `pnpm build:global` 都生成 Next static export `out/`；发布脚本负责按 region 归档和发布。两份产物入口 HTML / JS / CSS 内容均不同，**不可共用**。
11. **语言切换器（`<LanguageSwitcher>`，`src/components/site/language-switcher.tsx`）**：
    - **仅国际站**（`isGlobal === true`）在 `LandingNavbar` 中挂载；国内站不渲染（编译期消除）。
    - 桌面端：右上角 `dropdown` 形态；移动端：汉堡面板底部 `inline` 形态。两种形态由 `useIsDesktop()` 按断点二选一挂载，避免重复事件监听。
    - 切换调用 `i18n.setLocale(locale)`，并持久化到 `localStorage.lw-locale`；下次进入站点优先读取该值，未命中则回落到 `region.DEFAULT_LOCALE`（cn → `zh-CN`，global → `en-US`）。
    - 切换语言**只影响文案**（`useT()` 的查表结果），**不影响** region 分支选择的图片 / 数据（如国际站 changelog 配图始终是英文版、平台卡片始终是国际四件套）。

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
- `src/lib/asset-url.ts` 的 `isUsingCdn` / `cdnBase` 仅保留为向后兼容导出，
  可后续批量 grep 清理调用方 import。
- i18n 字典目前只有 `zh-CN` / `en-US` 两份，`en-US.json` 由翻译流程产出，
  `pnpm i18n:check` 会列出未补 key；正式发布国际站前必须保证清单为空。
- 实名认证身份证号仅做正则粗校验（`^\d{17}[\dXx]$`），未实现 ISO 7064 MOD 11-2
  校验位算法；用户输错一位会被后端 `realname_mismatch` 拒回，体验上可优化
  （补 `utils.isValidIdCardNo()`：位数 + 校验位 + 地区码），不影响正确性。
