# 📋 LightClaw Frontend - AI Agent 规范

> 本文档是 AI 助手在 `frontend/` 子项目中的行为规范和深度上下文。
> 仓库根目录另有一份 [`../AGENTS.md`](../AGENTS.md)，聚焦 monorepo 级别的流程约定（feai、TAPD、MR 等）；本文件聚焦前端子项目的**规范 + 架构 + 代码细节**。
>
> ⚠️ 本文件遵循 CodeBuddy `frontend-ai-dev-tools` 模板 v1.3.0 规范生成，并整合了项目原有的详细架构手册。
>
> 📐 配套规格文档见 [`./openspec/`](./openspec/)（auth / bot / marketing / plan）。
>
> 🧭 改动**导出的**函数/组件/类型前，按根目录 [`../CLAUDE.md`](../CLAUDE.md) 的 GitNexus 要求：先跑 `gitnexus_impact({target: "<symbol>", direction: "upstream"})` 评估影响面；改完提交前再跑 `gitnexus_detect_changes()` 确认范围。仅改 JSX 内闭包函数、单文件内 helper、文案字面量时可跳过。

---

## 一、项目概述

| 字段 | 内容 |
|---|---|
| 项目名 | LightClaw Frontend（`agent-platform-frontend`） |
| 技术栈 | React 19（StrictMode + `createRoot`）+ TypeScript 5.9 + Vite 7 |
| UI / 样式 | `@radix-ui/*` + shadcn 自封装 + `@tencent/tea-sdk-lightclaw`；Tailwind v4 + CVA + `tailwind-merge` |
| 路由 / 状态 | `react-router-dom` v7（`createBrowserRouter`）；Context + `useReducer`（无 Redux） |
| HTTP | Repository Pattern 自定义 fetch，统一 `APIEnvelope<T>` |
| i18n | `react-i18next` + 自研"中文即 key"（`src/i18n/`） |
| 测试 | Vitest 4 + `@testing-library/react` + jsdom |
| 包管理 | pnpm（与 `tea-sdk-lightclaw` workspace 联动） |
| 默认分支 | `master`（国内站）；`feature/international-site`（国际站） |
| TAPD workspace | `10132091` |
| 发布 | Argo CD（`shprod`）主流 + Cloudflare Pages（`pnpm deploy:cf`） |

---

## 二、常用命令

```bash
# 开发
pnpm dev            # 默认（VITE_REGION 由 .env 决定）
pnpm dev:cn         # 国内站 / pnpm dev:global  国际站
pnpm dev:local      # 使用本地 monorepo 版 tea-sdk-lightclaw

# 构建
pnpm build          # 标准  / pnpm build:cn  / pnpm build:global

# 质量门禁（提交前必跑）
pnpm check          # tsc --noEmit 类型检查
pnpm test           # vitest 单次运行
pnpm i18n:extract   # 扫描 t() 生成 i18n/generated/*.json
pnpm i18n:check     # 校验翻译完整性（CI 门禁）

# 部署
pnpm deploy:cf                                                  # CF Pages
python3 scripts/build-release-image.py --service frontend --env shprod --tag <tag>  # Argo CD（monorepo 根执行）
```

> 无独立 Prettier/ESLint 配置，代码质量由 tsconfig strict 保障。

### 发布预览（EdgeOne Pages，agent 临时验证用）

Cloudflare Pages（`pnpm deploy:cf` / `https://lightclaw.pages.dev`）是跟 master 同步的官方预览，由 CI 合入后自动发布，**不接受 agent 临时推送**。

验证未合并分支用 **EdgeOne Pages** 预览（项目 `lightvela-preview` / ProjectId `pages-fqdz1kdlfvp1` / 域名 `https://lightvela-preview-hpthlnbc.edgeone.cool`）：

> ⚠️ **多人共享场景**：默认的 `lightvela-preview` project + production 环境会被多人同时使用，谁后部署谁覆盖。如果只是个人临时验证、且其他人**没有正在依赖**这个预览域名，可以直接走下面的 default 命令；如果在做评审 / 给别人发链接、或者已知有人在依赖，**请新建 dedicated preview project**（例如 `lightvela-preview-<你的名字>`）：把命令里的 `-n lightvela-preview` 换成 `-n lightvela-preview-pablo`，或设 `EDGEONE_PAGES_PROJECT_NAME=<dedicated-name>` 后再跑 `pnpm deploy:eo`。

```bash
cd frontend
# 国内站 → dist-cn/（shprod 部署）；国际站 → dist-global/（CF Pages + EdgeOne 预览）
# EdgeOne 预览只验国际站产物，因此清理 / 构建 / 部署都针对 dist-global
rm -rf dist-global                                                # 必做，防止上一分支残留产物
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build:global   # 产出 dist-global/
TOKEN=$(tr -d '[:space:]' < ~/.tencentcloud/edgeone_pages_token)  # 末尾空白会让 CLI 误判 "No API token provided"
npx --yes edgeone pages deploy dist-global -n lightvela-preview -e production -t "$TOKEN"
```

- ⚠️ **国内 / 国际产物目录不共用**：国内站 `dist-cn/`（`pnpm build:cn`），国际站 `dist-global/`（`pnpm build:global`）。切分支 / 切区域前务必 `rm -rf dist-cn dist-global` 清旧，避免把另一侧的残留发出去
- 若要预览国内站产物，替换为 `rm -rf dist-cn && pnpm build:cn && npx edgeone pages deploy dist-cn ...`
- Token 位置：`~/.tencentcloud/edgeone_pages_token`（0600，仅 pablozhong 授权范围内）
- `-e production` 是**测试项目自己的 production**，不是线上 `lightvela` 项目
- CLI 输出的 `EDGEONE_DEPLOY_URL` 带 `eo_token` 和 `eo_time` 两个 query，**必须完整保留**，缺一个就 401
- 完整流程和权限边界见 [`../codesign/edgeone-preview-operator.md`](../codesign/edgeone-preview-operator.md)

**发布后 bundle 指纹回验**（踩过坑，务必做）：

1. `curl <预览URL>/index.html` 拿到 `/assets/index-<hash>.js`
2. 本地 `ls dist-global/assets/index-*.js`（国内站则 `dist-cn/`）核对 hash 一致
3. 对得上再在浏览器肉眼验证；对不上说明产物目录没覆盖或被缓存，硬刷新 / 重发

**实名墙**：国内站 `/v1/instances/*` 写请求（POST/PUT/PATCH；DELETE 不拦）需要实名账号；未实名账号打开 settings 页时 `POST /v1/instances/{id}/debug/exec` 会在后台静默 403 `realname_required`。国际站 `isGlobal` 不展示实名入口，也不应被该实名墙拦截。

---

## 三、项目结构（关键目录）

```
frontend/src/
├── main.tsx                    # 入口，首行必须 import @/polyfills/react-dom-compat
├── polyfills/react-dom-compat.ts   # React 19 对 tea-component 的补丁
├── app/app.tsx                 # Providers 组合 + RouterProvider
├── router/{index,guards}.tsx   # 路由表 + Auth/Plan/AppAccess 守卫
├── layouts/                    # marketing-layout / app-shell-layout
├── pages/
│   ├── marketing/              # landing / account / subscribe / openclaw-*
│   ├── auth/                   # sign-in / invite / oauth
│   └── app/                    # workspace / settings / terminal
├── components/{ui,domain,site}/    # 三层组件：原子 / 业务 / 站点
├── contexts/                   # session / openclaw / repository
├── repositories/               # types.ts + http-repositories.ts + fake-repositories.ts
├── domain/                     # types.ts + plan-catalog.ts
├── services/use-async-resource.ts
├── i18n/                       # index.ts + t.ts + generated/（勿手改）
├── lib/                        # auth-api-base / oauth / avatar-image / region
├── theme/ · assets/ · test/setup.ts · styles.css
```

路径别名：`@/*` → `src/*`（`tsconfig.app.json`）。

---

## 四、核心原则（P0 铁律）

| 原则 | 说明 |
|---|---|
| 🔒 安全第一 | XSS / 注入 / 敏感信息 P0 处理 |
| 🚫 禁止 `any` | 用 `unknown` 或具体类型（monorepo 铁律） |
| 📐 i18n 必须 | 用户可见中文**必须**走 `t("...")`，提交前 `pnpm i18n:check` |
| 🔧 Lint 驱动 | 修改后必跑 `pnpm check` |
| ✅ 证据优于声明 | "完成"必须有 `pnpm test` / `pnpm check` 证据 |
| 📂 只改 frontend | 不动 `frontend-ds/`，除非用户明确要求 |
| 🔐 提交需确认 | 不自作主张 `git commit`/`push`，远端提交后须 `git pull` |
| 🌏 编译期区域分支 | 用 `isCN` / `isGlobal` 常量，避免运行时判断 |
| 🧩 数据驱动 UI | landing 卡片、Nav 等用数据数组驱动，便于区域切换 |

**FE-AI 标记**（不可遗漏）：Commit `[FE-AI] feat(xxx): ...` · MR 标题 `[FE-AI] feat: xxx` · MR 标签 `FE-AI` · TAPD 需求标签 `FE-AI`。

---

## 五、代码风格

- **TS strict**：`strict` + `noUnusedLocals` + `noUnusedParameters` + `noUncheckedIndexedAccess` + `noFallthroughCasesInSwitch`
- **JSX**：`react-jsx`（无需 `import React`）；**ESM**：`"type": "module"` + `moduleResolution: Bundler`
- **命名**：组件 `PascalCase.tsx`；Hook `use-*.ts`（kebab 文件名 + camelCase 导出）；常量 `SCREAMING_SNAKE_CASE`；工具/类型 `kebab-case.ts`
- **样式**：Tailwind utility 优先，配合 `cn()` 与 CVA 多变体

> ⚠️ 修改 CSS 前先确认选择器优先级。`.landing-page span` 这类全局选择器会覆盖 Tailwind utility（如 `font-semibold`）。

---

## 六、测试约定

- 文件命名 `*.test.ts` / `*.test.tsx`，**与被测文件同目录并列**（非 `__tests__/`）；国际站专属 `*.global.test.tsx`
- 全局 setup：`src/test/setup.ts`
- 运行：`pnpm test` / `pnpm test src/path/to/file.test.tsx` / `pnpm check`
- 断言规范：
  - 禁止形式化断言（`expect(true).toBe(true)`）
  - Mock 必须符合真实业务场景，禁止 `name: 'test'` 占位
  - 必须覆盖空值 / 极值 / 异常等边界
- 区域差异：`vi.mock('@/lib/region')` 或 `vi.stubGlobal` 切换 `isCN`/`isGlobal`

---

## 七、开发流程（feai 工具链）

| 命令 | 用途 |
|---|---|
| `/feai-start` | 启动开发：需求分析 → 实现 → MR（支持 `--quick` / `--full` / `--yes`） |
| `/feai-archive` | 归档沉淀到 openspec |
| `/feai-init` | 项目初始化，生成 AGENTS.md + openspec |

> 在 `frontend/` 目录执行，否则 openspec 会落到 monorepo 根。详细流程见 [`../.codebuddy/commands/feai-*.md`](../.codebuddy/commands/)。

**质量门禁**（提交前）：`pnpm check` → `pnpm test` → `pnpm i18n:check`，涉及多区域可选 `pnpm build:cn` + `pnpm build:global`。

**MCP 服务**：TAPD MCP（workspace `10132091`）+ Gongfeng MCP（分支 / MR / CR）。Token 配置 `~/.codebuddy/mcp.json`。

**不可逆操作**（即使 `--yes` 也需确认）：`git commit` / `git push` / `create_merge_request`。

---

## 八、架构速查

### 8.1 启动流程（`main.tsx`）

1. **首行** `import '@/polyfills/react-dom-compat'`（必须最早，打补丁 `findDOMNode` / `render` / `unmountComponentAtNode`，否则 tea-component 在 React 19 下报错）
2. `import '@/styles.css'`
3. `createRoot(...).render(<StrictMode><App/></StrictMode>)`
4. `<App/>` 组合：`RepositoryProvider → SessionProvider → OpenClawProvider → ThemeStyleInjector → RouterProvider`

### 8.2 路由（`router/index.tsx` + `router/guards.tsx`）

- **根域**（不套布局）：`/` `LandingPage` · `/changelog` `ChangelogPage`
- **营销域**（`MarketingAuthGuard`）：`/create-openclaw` · `/subscribe` · `/openclaw/{setup,success,settings}` · `/account{,/orders}`
- **认证**（`MarketingLayout + AuthRouteGuard`）：`/auth/sign-in` · `/auth/invite`；`/auth/{sign-up,sign-up-code,forgot-password}` 均重定向 `sign-in`
- **套餐选择**（`PlanGuard`）：`/plans/select`
- **控制台**（`AppAccessGuard + AppShellLayout`）：`/settings/account` · `/bots/:id/{workspace,settings,terminal}`
- 兜底：`/*` → `/openclaw/settings`；内部：`/internal/style-lab`；404：`NotFoundPage`

### 8.3 状态管理

- **`SessionProvider`**（`src/contexts/session-context.tsx`）：reducer 管理 `{ authReady, stage, user, currentSubscription, firstBotId, inviteValidation, verificationCooldownUntil }`；LocalStorage `lightclaw-ui-session-v1`（仅 UI 态）；监听 `AUTH_UNAUTHORIZED_EVENT` 自动登出
- **`OpenClawProvider`**：OpenClaw 配置状态（创建向导 / 当前实例）
- **`RepositoryProvider`**：依赖注入，运行时选 http/fake repositories，`useRepositories()` 暴露

### 8.4 Repository 层（`src/repositories/`）

- `types.ts` 定义接口，`http-repositories.ts` 生产实现，`fake-repositories.ts` Demo/测试
- 请求基址：`lib/auth-api-base.ts` 解析（支持烘焙 `VITE_AUTH_API_BASE_URL`）
- 通用封装 `apiRequest`：鉴权 Cookie / Session Token、`APIEnvelope<T>` 解包（`code`/`message`/`data`）、401 广播 `AUTH_UNAUTHORIZED_EVENT`、错误转 `Error`
- 三大 Repository：
  - **`AuthRepository`** — 手机验证码登录、OAuth 启动 URL、Session/Profile、头像压缩上传（200KB）、邀请码、游客登录、登出
  - **`PlanRepository`** — 订阅 / 套餐预览 / Bundles / Passes
  - **`BotRepository`** — Bot 全生命周期（创建 / 销毁 / 快照 / 消息）、Terminal 调试、QQ 通道（国内）、微信扫码登录 SSE（国内）、Soul 模板

### 8.5 组件 / Hook / Lib

- **组件三层**：`components/ui/`（原子：button / card / dialog / tabs / input / state-panel…）+ `components/domain/`（业务：plan-card / bot-status-card / audit-log-table…）+ `components/site/`（站点：brand-mark / login-modal / legal-footer…）
- **Hooks**：`useRepositories` / `useSession` / `useSessionActions` / `useOpenClaw` / `useAsyncResource(fetcher, deps)` / `useGeneratedNickname` / `useT`
- **`src/lib/`**：`auth-api-base` / `oauth` / `avatar-image`（客户端压缩 200KB 内）/ `region`（`isCN` / `isGlobal`）
- **`src/domain/types.ts`**：`User` / `Bot` / `Plan` / `Pass` / `Bundle` / `AuditEvent`

### 8.6 区域差异（国内 vs 国际）

| 维度 | `isCN`（国内） | `isGlobal`（国际） |
|---|---|---|
| 构建 | `pnpm build:cn` → `dist-cn/` | `pnpm build:global` → `dist-global/` |
| 环境变量 | `VITE_REGION=cn` | `VITE_REGION=global` |
| OAuth | QQ / 微信 | Google / GitHub |
| 首页平台卡片 | QQ / 微信 / 飞书 / 钉钉 | Telegram / WhatsApp / Discord / Slack |
| 语言 | 中文 zh-CN | 英文 en-US（`t()` 翻译） |
| 分支 | `master` | `feature/international-site` |
| 法律信息 | 显示 ICP | 隐藏 ICP，显示条款 / 隐私 |

---

## 九、i18n 规范（重点）

**工作流**：写 `t("中文")` → `pnpm i18n:extract` → 补 `en-US.json` 英文 → `pnpm i18n:check`。
⚠️ 禁止手改 `zh-to-key.json`（脚本维护）。

### 新增文案必查清单

所有**用户可见**中文必走 `t()`，不限于以下场景：

- JSX 文本节点：`<div>{t("中文")}</div>`
- 属性文案：`title` / `alt` / `placeholder` / `aria-label` / `aria-describedby`
- 弹窗消息：`toast.error(t("保存失败"))` / `window.confirm(t(...))` / `window.alert(t(...))`
- 异常：`throw new Error(t("验证码已过期"))`（或抛 code，UI 层转译）
- 动态：`document.title`、条件三元、枚举 label
- 非 React 模块：`import { t } from "@/i18n/t"` 命令式调用（**禁止** `useT()`，违反 Hook 规则）
- Mock 数据：真实渲染给用户（如 landing 卡片）必须走 `t()`；**仅**开发/测试桩可豁免

### 反模式（❌ 禁止）

```tsx
// ❌ 模板字符串拼接中文（extract 扫不到）
const msg = `共 ${count} 条记录`;
// ✅ i18next 插值
const msg = t("共 {{count}} 条记录", { count });

// ❌ 常量对象硬编码中文（不经 t()）
const STATUS_LABEL = { pending: "待处理", done: "已完成" };
// ✅ 存中文 key，渲染时 t()
const STATUS_KEY = { pending: "待处理", done: "已完成" } as const;
const label = t(STATUS_KEY[status]);

// ❌ 中文拼接作 key
t("欢迎，" + user.name);
// ✅ 占位符
t("欢迎，{{name}}", { name: user.name });
```

---

## 十、参考

- 规格文档：[`./openspec/`](./openspec/) — `config.yaml` + `specs/{auth,bot,marketing,plan}.md` + `changes/`
- feai 工具链：[lightcloud-fe/ai/frontend-ai-dev-tools](https://git.woa.com/lightcloud-fe/ai/frontend-ai-dev-tools)
- TAPD workspace：[10132091](https://tapd.woa.com)
- Gongfeng：[wisp/mono2](https://git.woa.com/wisp/mono2)
