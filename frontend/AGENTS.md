# 📋 LightClaw Frontend - AI Agent 规范

> 本文档是 AI 助手在 `frontend/` 子项目中的行为规范和深度上下文。
> 仓库根目录另有一份 [`../AGENTS.md`](../AGENTS.md)，聚焦 monorepo 级别的流程约定（feai、TAPD、MR 等）；本文件聚焦前端子项目的**规范 + 架构 + 代码细节**。
>
> ⚠️ 本文件遵循 CodeBuddy `frontend-ai-dev-tools` 模板 v1.3.0 规范生成，并整合了项目原有的详细架构手册。
>
> 📐 配套规格文档见 [`./openspec/`](./openspec/)（auth / bot / marketing / plan）。

---

## 一、项目概述

| 字段          | 内容                                                                   |
| ------------- | ---------------------------------------------------------------------- |
| **项目名**    | LightClaw Frontend（`agent-platform-frontend`）                        |
| **技术栈**    | React 19（StrictMode + `createRoot`）+ TypeScript 5.9 + Vite 7         |
| **UI 组件库** | `@radix-ui/*` + shadcn 风格自封装 + `@tencent/tea-sdk-lightclaw`        |
| **样式方案**  | Tailwind CSS v4 + 设计 token + `class-variance-authority` + `tailwind-merge` |
| **路由**      | `react-router-dom` v7（`createBrowserRouter`，BrowserHistory，非 Hash） |
| **状态管理**  | React Context + `useReducer`（无 Redux/Zustand/MobX）                   |
| **HTTP 层**   | Repository Pattern 自定义 fetch 封装（非 axios），统一 `APIEnvelope<T>` |
| **国际化**    | `react-i18next` + 自研"中文即 key"方案（`src/i18n/`）                  |
| **测试**      | Vitest 4 + `@testing-library/react` + `@testing-library/user-event` + jsdom |
| **包管理**    | pnpm（与 `tea-sdk-lightclaw` monorepo 联动，workspace 形式）            |
| **仓库**      | `wisp/mono`（迁移后 `wisp/mono2/frontend/`）                           |
| **TAPD ID**   | `10132091`                                                             |
| **默认分支**  | `master`                                                               |
| **发布方式**  | Argo CD（`shprod`）为主 + Cloudflare Pages 静态托管（`pnpm deploy:cf`） |
| **区域部署**  | 国内站（`isCN`，`master`）+ 国际站（`isGlobal`，`feature/international-site`） |

---

## 二、常用命令

> 命令均在 `frontend/` 目录下通过 **pnpm** 执行。

```bash
# ── 安装依赖 ──
pnpm install

# ── 开发 ──
pnpm dev                 # 默认模式（VITE_REGION 由 .env 决定）
pnpm dev:cn              # 国内站模式（加载 .env.cn）
pnpm dev:global          # 国际站模式（加载 .env.global）
pnpm dev:local           # 使用本地 monorepo 版本的 @tencent/tea-sdk-lightclaw（旁路调试）

# ── 构建 ──
pnpm build               # 标准构建（tsc -b && vite build）
pnpm build:cn            # 国内站构建，产物到 dist-cn/
pnpm build:global        # 国际站构建，产物到 dist-global/
pnpm preview             # 本地预览 dist/

# ── 测试与类型 ──
pnpm test                # 运行 vitest（单次）
pnpm check               # tsc --noEmit 类型检查

# ── 国际化（i18n）──
pnpm i18n:extract        # 扫描 t("...") 调用，生成 i18n/generated/*.json
pnpm i18n:check          # 校验翻译完整性（CI 门禁可用）

# ── 部署 ──
pnpm deploy:cf           # 部署到 Cloudflare Pages
python3 scripts/build-release-image.py --service frontend --env shprod --tag <tag>
                         # 构建 Argo CD 正式发布镜像（在 monorepo 根目录执行）

# ── 代码质量 ──
# 本项目无独立 Prettier/ESLint 配置，依赖 tsconfig strict 规则：
#   strict + noUnusedLocals + noUnusedParameters + noUncheckedIndexedAccess
```

---

## 三、项目结构

```
frontend/
├── src/
│   ├── main.tsx                      # 入口（首行必须 import react-dom-compat polyfill）
│   ├── polyfills/
│   │   └── react-dom-compat.ts       # React 19 对 tea-component 的兼容补丁
│   ├── app/
│   │   └── app.tsx                   # Providers 组合 + RouterProvider
│   ├── router/
│   │   ├── index.tsx                 # createBrowserRouter 路由表
│   │   └── guards.tsx                # 路由守卫（Auth/Plan/AppAccess）
│   ├── layouts/
│   │   ├── marketing-layout.tsx      # 营销域布局
│   │   └── app-shell-layout.tsx      # 控制台 App Shell 布局
│   ├── pages/
│   │   ├── marketing/                # 营销域（landing / account / subscribe / openclaw-*）
│   │   │   └── landing/              # 首页各 section（数据驱动）
│   │   ├── auth/                     # 登录/邀请/OAuth 登录入口
│   │   └── app/                      # 控制台页面（workspace / settings / terminal）
│   ├── components/
│   │   ├── ui/                       # 设计系统原子组件
│   │   ├── domain/                   # 业务领域组件
│   │   └── site/                     # 站点级组件
│   ├── contexts/
│   │   ├── session-context.tsx       # SessionProvider
│   │   ├── openclaw-context.tsx      # OpenClawProvider
│   │   └── repository-context.tsx    # RepositoryProvider（依赖注入）
│   ├── repositories/
│   │   ├── types.ts                  # AuthRepository / PlanRepository / BotRepository 接口
│   │   ├── http-repositories.ts      # 生产 HTTP 实现
│   │   └── fake-repositories.ts      # Demo/测试假实现
│   ├── domain/
│   │   ├── types.ts                  # User / Bot / Plan / Pass / Bundle / AuditEvent ...
│   │   └── plan-catalog.ts           # 套餐目录常量
│   ├── services/
│   │   └── use-async-resource.ts     # 异步资源 Hook
│   ├── i18n/                         # ★ 国际化方案（"中文即 key"）
│   │   ├── index.ts                  # i18next 初始化 + 区域判定（isCN/isGlobal）
│   │   ├── t.ts                      # useT() / t() / zhToKey 运行时
│   │   └── generated/                # 由 `pnpm i18n:extract` 生成，勿手改 key
│   │       ├── zh-to-key.json
│   │       ├── zh-CN.json
│   │       └── en-US.json
│   ├── lib/
│   │   ├── auth-api-base.ts          # API base URL 解析（支持构建时烘焙）
│   │   ├── oauth.ts                  # OAuth 提供商定义与跳转
│   │   ├── avatar-image.ts           # 头像图片客户端压缩（200KB 内）
│   │   └── region.ts                 # isCN / isGlobal 区域判定
│   ├── theme/                        # 主题 token 与注入组件
│   ├── assets/                       # 字体与静态资源
│   ├── test/
│   │   └── setup.ts                  # Vitest 全局 setup
│   └── styles.css                    # Tailwind 入口 + 全局样式
├── scripts/
│   ├── i18n-extract.mjs              # i18n 提取器（正则扫描 t() 调用）
│   └── deploy-cloudflare-pages.mjs   # CF Pages 部署
├── k8s/                              # Argo CD source-facing（base + overlays/shprod）
├── openspec/                         # OpenSpec 规格（auth/bot/marketing/plan）
├── AGENTS.md                         # 本文件
├── package.json
├── tsconfig.app.json
└── vite.config.ts
```

---

## 四、代码风格

本项目**不依赖 Prettier/ESLint 配置文件**，由 TypeScript strict 模式 + 团队约定保障：

- **TypeScript strict**：`strict: true` + `noUnusedLocals` + `noUnusedParameters` + `noUncheckedIndexedAccess` + `noFallthroughCasesInSwitch`
- **禁止 `any`**：统一使用 `unknown` 或具体类型（monorepo 铁律）
- **JSX**：`react-jsx`（无需 `import React`）
- **模块格式**：ESM（`"type": "module"`），`moduleResolution: Bundler`
- **命名约定**：
  - 组件：`PascalCase.tsx`（如 `LoginModal.tsx`）
  - Hook：`use-*.ts`（kebab-case 文件名 + camelCase 导出）
  - 常量：`SCREAMING_SNAKE_CASE`
  - 工具/类型：`kebab-case.ts`
- **组件样式**：Tailwind utility class 优先，配合 `cn()`（`tailwind-merge`）与 CVA 多变体
- **国际化**：**所有用户可见中文文案必须走 `t("中文")`**，禁止新增硬编码中文（mock 数据除外）

> 💡 修改 CSS 时注意选择器优先级，`.landing-page span` 这类全局选择器会覆盖 Tailwind utility（如 `font-semibold`），改样式前先检查更高优先级规则。

---

## 五、测试约定

- **测试框架**：Vitest 4 + `@testing-library/react` + `@testing-library/user-event` + jsdom
- **测试文件命名**：`*.test.ts` / `*.test.tsx`（与被测文件**同目录**并列，非 `__tests__/` 子目录）
  - 区域专属测试：`*.global.test.tsx`（国际站场景）
- **全局 setup**：`src/test/setup.ts`
- **运行命令**：
  - 全量：`pnpm test`
  - 单文件：`pnpm test src/path/to/file.test.tsx`
  - 类型检查：`pnpm check`
- **断言规范**：
  - 禁止形式化断言（`expect(true).toBe(true)`）
  - Mock 必须符合真实业务场景，禁止 `name: 'test'` 此类占位
  - 必须覆盖空值/极值/异常等边界场景
- **区域差异测试**：使用 `vi.stubGlobal` 或 `vi.mock('@/lib/region')` 切换 `isCN`/`isGlobal`

---

## 六、路径别名

| 别名   | 实际路径  | 配置来源                  |
|--------|-----------|---------------------------|
| `@/*`  | `src/*`   | `tsconfig.app.json` paths |

---

## 七、核心命令速查（feai 工具链）

### 🚀 日常开发命令

| 命令            | 说明                                                         |
| --------------- | ------------------------------------------------------------ |
| `/feai-start`   | **启动开发流程** — 从需求分析到创建 MR 的完整链路            |
| `/feai-archive` | **归档沉淀** — 将开发成果沉淀到项目知识库                    |
| `/feai-init`    | **项目初始化** — AI 分析项目代码，生成 AGENTS.md 深度信息 + openspec 文档 |

**常用参数**：
- `--quick` — 快速修复模式（小 Bug、文案修改）
- `--full` — 完整流程模式（大型需求、新模块）
- `--yes` — 信任模式（减少确认交互）

> 📄 **详细说明**：[feai-start.md](../.codebuddy/commands/feai-start.md) | [feai-archive.md](../.codebuddy/commands/feai-archive.md) | [feai-init.md](../.codebuddy/commands/feai-init.md)

---

## 八、规范体系总览

项目接入 **Superpowers（按需调用技能）** + **OpenSpec 规范驱动开发系统**。

### 两大系统职责分工

| 系统               | 定位                   | 触发命令         |
| ------------------ | ---------------------- | ---------------- |
| **⚡ Superpowers** | 需求分析 & 驱动开发    | `/feai-start`    |
| **📐 OpenSpec**    | 规范沉淀 & 变更管理    | `/feai-archive`  |

### 规范文件清单

```
mono2/
├── .codebuddy/                     # monorepo 根级 CodeBuddy 配置（共用）
│   ├── skills/
│   │   ├── superpowers/            # Superpowers 原生 Skills
│   │   └── team-extensions/        # 团队扩展 Skills
│   ├── commands/                   # feai-start / feai-archive / feai-init
│   ├── frontend-ai-dev-tools/      # feai 工具链（模板/脚本/MCP）
│   └── project.local.json          # monorepo 本地配置
└── frontend/
    ├── AGENTS.md                   # ★ 本文件（前端 AI 行为规范 + 架构手册）
    └── openspec/                   # 前端规格文档
        ├── config.yaml             # 前端项目上下文配置（由 /feai-init 维护）
        ├── specs/                  # auth / bot / marketing / plan
        └── changes/                # 变更提案 / 归档
```

> 💡 **使用 feai 时，请在 `frontend/` 目录下执行 `/feai-init`、`/feai-start`** 等命令，否则 openspec 会被生成到 monorepo 根目录。

---

## 九、核心原则（P0 优先级）

### 不可违背原则

| 原则              | 说明                                                         |
| ----------------- | ------------------------------------------------------------ |
| 🔒 安全第一        | P0 优先级处理 XSS/注入/敏感信息，绝不妥协                    |
| 🔧 Lint 驱动质量   | 遵循项目 tsconfig strict 规则，代码修改后运行 `pnpm check` 确保通过 |
| ✅ 证据优于声明    | 验证后再宣布完成，"完成"声明必须有 `pnpm test` / `pnpm check` 等证据 |
| 🚫 禁止 `any`      | 使用 `unknown` 或具体类型替代（monorepo 铁律）                |
| 📐 i18n 必须       | 所有用户可见中文**必须**走 `t("...")`，提交前运行 `pnpm i18n:check` |
| 📂 只改 frontend   | 不同步修改 `frontend-ds/` 目录，除非用户明确要求              |
| 🔐 提交需确认      | 不自作主张 `git commit` / `git push`，必须征得用户确认        |

### 强烈推荐原则

| 原则                     | 说明                                                     |
| ------------------------ | -------------------------------------------------------- |
| 🧪 TDD 测试驱动           | 推荐先写测试再写代码；测试不通过不能合入                  |
| 📐 OpenSpec 双重角色      | 开发前提供项目上下文，开发后归档沉淀功能规范文档          |
| ⚡ Superpowers 分析需求   | 用 Superpowers 分析需求、驱动开发、交付代码                |
| 🌏 区域差异用编译期常量   | 通过 `isCN` / `isGlobal` 做区域分支，避免运行时判断          |
| 🧩 数据驱动 UI            | 首页卡片、Nav 菜单等采用数据数组驱动，便于按区域切换         |

---

## 十、流程保持协议（铁律）

### 阶段感知

通过 `/feai-start` 启动开发流程后，AI 必须在整个开发周期内保持以下意识：

1. **阶段追踪**：每次回复前，先判断当前处于哪个开发阶段（需求分析 / 开发实现 / 自检提交）
2. **流程连续性**：后续对话中的需求补充、澄清、变更，都在当前流程上下文中处理
3. **增量优先**：需求变更时，在已有成果基础上增量修改，而非推倒重来

### 质量门禁（不可跳过）

| 门禁               | 命令                  | 时机               |
| ------------------ | --------------------- | ------------------ |
| **类型检查**       | `pnpm check`          | 每次代码修改后     |
| **测试通过**       | `pnpm test`           | 提交前             |
| **i18n 翻译完整**  | `pnpm i18n:check`     | 涉及文案变更时     |
| **两种区域构建**   | `pnpm build:cn` + `pnpm build:global` | 发布前（可选） |

### FE-AI 标记（不可遗漏）

| 标记位置       | 格式                    | 说明                     |
| -------------- | ----------------------- | ------------------------ |
| Commit message | `[FE-AI] feat(xxx): ...` | 用于提效数据统计          |
| MR 标题        | `[FE-AI] feat: xxx`      | 用于提效数据统计          |
| MR 标签        | `FE-AI`                 | 用于提效数据统计          |
| TAPD 需求标签  | `FE-AI`                 | 自动添加，标记 AI 辅助开发 |

### 不可逆操作确认

以下操作无论是否开启信任模式，都**必须先展示内容，征得用户确认后才能执行**：

- `git commit` / `git push` — **必须先征得用户确认**（团队强制规则）
- `create_merge_request` — 展示 MR 信息
- 远端提交后需同步执行 `git pull`，避免本地与远端不一致

---

## 十一、开发流程概览

### 流程选择矩阵

| 模式 | 适用场景 | 执行阶段 |
|:----:|----------|----------|
| 🟢 **快速修复**（`--quick`） | 小 Bug、文案修改、样式调整 | 1 → 4 → 5 |
| 🟡 **标准开发**（默认） | 中等功能需求、组件开发 | 0 → 1 → 2 → 3 → 4 → 4B → 5 |
| 🔴 **完整流程**（`--full`） | 大型需求、新模块、跨页面功能 | 0 → 1 → 2 → 2B → 3 → 4 → 4B → 5 → 6 |

### 标准开发流程

```
📐 OpenSpec 上下文加载（frontend/openspec/）
        ↓
📋 获取 TAPD 需求 + 🏷️ 自动添加 FE-AI 标签
        ↓
🧠 苏格拉底式提问 → 生成需求确认文档
        ↓
⏸️ 等待用户确认
        ↓
💬 对话式需求澄清（如需要）
        ↓
🌿 创建开发分支（从 master 或 feature/international-site）
        ↓
📝 任务拆分 → 🧪 TDD（推荐） → 💻 代码实现 → 🌐 i18n 接入
        ↓
📦 代码提交（[FE-AI] 前缀）→ 🔗 关联 TAPD
        ↓
✅ 自检（pnpm check + pnpm test + pnpm i18n:check）→ 🔍 创建 MR（FE-AI 标签）
        ↓
📐 提示运行 /feai-archive 归档沉淀
```

### 动态项目配置

| 优先级 | 来源                                  | 说明                                                 |
|:------:|---------------------------------------|------------------------------------------------------|
| 1️⃣     | `../.codebuddy/project.local.json`    | 本地项目配置（monorepo 共用，不提交到仓库）           |
| 2️⃣     | 自动探测                              | 从 `git remote`（`wisp/mono`）/ `git branch` 获取     |
| 3️⃣     | TAPD 链接解析                         | 从用户输入的 TAPD 链接中解析 workspace_id            |
| 4️⃣     | 提示用户                              | 关键信息缺失且无法自动获取时，提示用户填写            |

### 信任模式（`--yes`）

| 确认点        | 默认模式     | 信任模式      |
| ------------- | ------------ | ------------- |
| 需求确认文档  | ⏸️ 必须确认   | ⏸️ 必须确认    |
| 分支创建      | ⏸️ 询问确认   | ✅ 自动执行    |
| TAPD 分支关联 | ⏸️ 询问确认   | ✅ 自动执行    |
| 代码提交      | ⏸️ 必须确认   | ⏸️ **必须确认** |
| 创建 MR       | ⏸️ 必须确认   | ⏸️ **必须确认** |

### MCP 错误恢复策略

| MCP 操作                         | 关键性 | 失败策略                             |
| -------------------------------- | :----: | ------------------------------------ |
| `stories_get` / `bugs_get`       | 🔴      | 阻塞，提示用户检查 ID 或 Token        |
| `stories_update`（添加标签）     | 🟡      | ⚠️ 警告后继续                         |
| `create_branch`                  | 🔴      | 阻塞，提示用户检查权限                |
| `add_git_branch_to_object`       | 🟡      | ⚠️ 警告后跳过                         |
| `create_merge_request`           | 🔴      | 阻塞，提示用户检查分支/权限           |

---

## 十二、对话式开发

### 需求澄清阶段

AI 生成需求确认文档后：

1. **主动提问**：对模糊的需求点提出具体问题，提供 2-3 个选项供用户选择
2. **增量更新**：根据用户反馈增量修改需求确认文档，而非重新生成
3. **对齐确认**：每轮澄清后，简要总结变更点

### 开发过程中的需求变更

1. **评估影响**：分析变更对已完成工作的影响范围
2. **增量调整**：在已有代码基础上增量修改
3. **同步更新**：同步更新需求确认文档和实现计划

### 对话式开发原则

| 原则         | 说明                                       |
| ------------ | ------------------------------------------ |
| 📝 增量优先   | 在已有成果基础上增量修改，避免重复劳动      |
| 🔄 及时同步   | 需求变更后及时同步文档和计划                |
| ⏸️ 适时确认   | 重大变更前暂停确认，小调整直接执行          |
| 🧠 上下文保持 | 保持对话上下文连贯，不丢失之前的讨论结论    |

---

## 十三、MCP 服务配置

### 已接入的 MCP 服务

| 服务             | 用途                                           |
| ---------------- | ---------------------------------------------- |
| **TAPD MCP**     | 需求获取、任务管理、分支关联（workspace `10132091`） |
| **Gongfeng MCP** | 分支管理、MR 创建、文件操作、CR 评审              |

> MCP Token 配置：`~/.codebuddy/mcp.json`（全局）或 `.codebuddy/mcp.json`（项目）。

---

## 十四、项目架构深度手册

### 14.1 发布与部署

- `frontend` 的目标正式发布模型是 **Argo CD**
- source-facing 真源：
  - `frontend/k8s/base`
  - `frontend/k8s/overlays/shprod`
- `shprod` deploy-facing skeleton：
  - `argocd/services/frontend/shprod/`
  - `argocd/apps/shprod/frontend.yaml`
- 镜像构建统一走：
  - `python3 scripts/build-release-image.py --service frontend --env shprod --tag <tag>`
- 另有 Cloudflare Pages 静态托管形态：`pnpm deploy:cf`

### 14.2 入口与初始化流程

入口文件：`frontend/src/main.tsx`

启动流程：
1. **首行** `import '@/polyfills/react-dom-compat'`（必须最早执行，为 tea-component 打补丁 `findDOMNode` / `render` / `unmountComponentAtNode`，兼容 React 19）
2. `import '@/styles.css'`（Tailwind 入口 + 全局样式）
3. `createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>)`
4. `<App/>` 组合 Providers：
   `RepositoryProvider → SessionProvider → OpenClawProvider → ThemeStyleInjector → RouterProvider`
5. `RouterProvider` 接管路由，根据 `router/index.tsx` 渲染对应页面

### 14.3 路由结构

路由方案：`createBrowserRouter`（BrowserHistory，非 Hash）
路由表：`frontend/src/router/index.tsx`
守卫：`frontend/src/router/guards.tsx`

**一级路由（根域，不套 MarketingLayout）**：
- `/`                     → `LandingPage`          官网首页
- `/changelog`            → `ChangelogPage`        更新日志

**营销域路由（`MarketingAuthGuard` 已登录校验）**：
- `/create-openclaw`      → `CreateOpenClawPage`
- `/subscribe`            → `SubscribePage`        套餐订阅/支付
- `/openclaw/setup`       → `OpenClawSetupPage`
- `/openclaw/success`     → `OpenClawSuccessPage`
- `/openclaw/settings`    → `OpenClawSettingsPage` 控制台主设置页（业务核心）
- `/account`              → `AccountPage`
- `/account/orders`       → `AccountOrdersPage`

**营销域认证路由（套 `MarketingLayout` + `AuthRouteGuard`）**：
- `/auth/sign-in`         → `SignInPage`           登录（国内手机+验证码 / 国际 OAuth）
- `/auth/sign-up`         → `SignUpPage`           注册（已收敛至 sign-in）
- `/auth/sign-up-code`    → 重定向 `/auth/sign-in`
- `/auth/invite`          → `InvitePage`           邀请码校验
- `/auth/forgot-password` → 重定向 `/auth/sign-in`

**需登录路由**：
- `/plans/select`         → `PlanSelectPage`       首次登录选择套餐（套 `PlanGuard`）

**控制台 App Shell（套 `AppAccessGuard` + `AppShellLayout`）**：
- `/settings/account`     → `AccountProfilePage`
- `/bots/:id/workspace`   → `WorkspacePage`
- `/bots/:id/settings`    → `SettingsPage`
- `/bots/:id/terminal`    → `BotTerminalPage`
- `/*`（兜底）            → 重定向 `/openclaw/settings`

**内部调试**：`/internal/style-lab` → `StyleLabPage`
**404 兜底**：`/*` → `NotFoundPage`

### 14.4 状态管理

- **`SessionProvider`**（`src/contexts/session-context.tsx`）
  - reducer 管理 `{ authReady, stage: anonymous|authenticated, user, currentSubscription, firstBotId, inviteValidation, verificationCooldownUntil }`
  - 动作：`signInWithCode` / `signUpWithCode` / `sendVerificationCode` / `uploadAvatar` / `updateProfile` / `deleteAccount` / `signOut` / `refreshSession`
  - LocalStorage key：`lightclaw-ui-session-v1`（仅 UI 态，非敏感）
  - 监听 `AUTH_UNAUTHORIZED_EVENT` 自动登出

- **`OpenClawProvider`**（`src/contexts/openclaw-context.tsx`）
  - 管理 OpenClaw 配置状态（创建向导、当前实例等）

- **`RepositoryProvider`**（`src/contexts/repository-context.tsx`）
  - 依赖注入层，运行时选择 http-repositories 或 fake-repositories
  - 通过 `useRepositories()` 暴露给业务层

### 14.5 API 请求层（Repository Pattern）

- 核心文件：`frontend/src/repositories/http-repositories.ts`
- 请求基址：`lib/auth-api-base.ts` 解析（支持构建时烘焙 `VITE_AUTH_API_BASE_URL`）
- 通用封装 `apiRequest` 统一处理：
  - 鉴权 Cookie / Session Token
  - 统一 `APIEnvelope<T>` 响应解包（`code` / `message` / `data`）
  - 401 自动广播 `AUTH_UNAUTHORIZED_EVENT` 触发登出
  - 网络/业务错误转换为 `Error` 抛出

**`AuthRepository`（认证/用户）**：
- `signInWithCode({phone, code, inviteCode?})`
- `sendVerificationCode(request)` （含冷却）
- `signUpWithCode({name, phone, code, inviteCode?})`
- `validateInviteCode(code)`、`prepareInviteCode(code)`、`activateInviteCode(code)`
- `getSession()`、`getProfile()`、`updateProfile()`
- `uploadAvatar(file)` （客户端压缩到 200KB）
- `deleteAccount()`
- `getOAuthStartUrl(provider)` — 第三方登录启动 URL（国际站 Google/GitHub）
- `signInAsGuest()`、`signOut()`

**`PlanRepository`（套餐/订阅）**：
- `getCurrentSubscription()`、`getPlanPreview()`、`updateSubscription(tier)`
- `listBundles()` — GET `/v1/bundles`
- `createPass(bundleId)` — POST `/v1/passes`
- `listMyPasses()` — GET `/v1/passes`

**`BotRepository`（Bot 全生命周期）**：
- `getDashboardSnapshot` / `getWorkspaceSnapshot` / `getSettingsSnapshot`
- `createBot` / `destroyBot` / `updateBotProfile`
- `sendWorkspaceMessage`
- `getTerminalSession` / `execDebugCommand`
- `getBotBornCard`
- `configureQQChannel` （国内）
- `createWeixinLoginSession` / `getWeixinLoginSession` / `cancelWeixinLoginSession` / `subscribeWeixinLoginSessionEvents`（SSE，国内）
- `listSoulTemplates`

### 14.6 公共组件

**ui 层 `src/components/ui/`（设计系统原子组件）**：
- `button` / `cta-button` / `card` / `glass-card` / `dialog` / `tabs` / `select`
- `input` / `textarea` / `label` / `scroll-area` / `badge` / `stat-tile`
- `ambient-glow` / `display-title` / `page-header` / `composer-panel` / `inset-panel`
- `state-panel` / `chat-bubble` / `control-shell`

**domain 层 `src/components/domain/`（业务领域组件）**：
- `plan-card` / `alert-card` / `bot-status-card` / `billing-summary-card`
- `audit-log-table` / `code-input` / `config-section` / `event-feed`
- `invite-status-card` / `release-item` / `scenario-switcher` / `setup-step-timeline`

**site 层 `src/components/site/`（站点级组件）**：
- `brand-mark` / `homepage-grammar` / `legal-footer`
- `login-modal` / `marketing-header-actions` / `user-avatar-menu`

### 14.7 自定义 Hooks

- `useRepositories()`                              注入数据层
- `useSession()` / `useSessionActions()`           会话 / 会话动作
- `useOpenClaw()`                                  OpenClaw 配置
- `useAsyncResource(fetcher, deps)`                异步资源（loading/error/data）
- `useGeneratedNickname()`                         随机昵称生成
- `useT()`                                         i18n 翻译 Hook

### 14.8 工具函数与领域模型

**`src/lib/`**：
- `auth-api-base.ts` — API base URL 解析
- `oauth.ts` — OAuth 提供商定义与跳转
- `avatar-image.ts` — 头像图片客户端压缩
- `region.ts` — `isCN` / `isGlobal` 区域判定

**`src/domain/`**：
- `types.ts` — `User` / `Bot` / `Plan` / `Pass` / `Bundle` / `AuditEvent` 等核心类型
- `plan-catalog.ts` — 套餐目录常量

### 14.9 区域差异（国内站 vs 国际站）

| 维度            | 国内站（`isCN`）              | 国际站（`isGlobal`）                |
| --------------- | ----------------------------- | ----------------------------------- |
| 构建命令        | `pnpm build:cn` → `dist-cn/`  | `pnpm build:global` → `dist-global/` |
| 环境变量        | `VITE_REGION=cn`              | `VITE_REGION=global`                |
| OAuth 登录      | QQ / 微信                     | Google / GitHub                     |
| 首页平台卡片    | QQ / 微信 / 飞书 / 钉钉        | Telegram / WhatsApp / Discord / Slack |
| 语言            | 中文（zh-CN）                 | 英文（en-US，`t()` 翻译）             |
| 分支            | `master`                      | `feature/international-site`        |
| 法律/备案信息   | 显示 ICP                      | 隐藏 ICP，显示条款/隐私              |

### 14.10 i18n 工作流

1. 新增文案时直接写 `t("中文")`（`useT()` Hook 或 `t()` 函数）
2. 运行 `pnpm i18n:extract` 生成 `src/i18n/generated/*.json`
3. 补齐 `en-US.json` 中的英文翻译（空字符串需填充）
4. 提交前运行 `pnpm i18n:check` 校验完整性
5. ⚠️ 禁止手改 `zh-to-key.json`（由脚本维护）

### 14.11 React 19 兼容

- `main.tsx` **首行必须**导入 `@/polyfills/react-dom-compat`，否则 tea-component 报错
- 使用 `createRoot` + `StrictMode`，不再使用 `ReactDOM.render`

### 14.12 规格文档（OpenSpec）

位于 [`./openspec/`](./openspec/)：

- `openspec/config.yaml`        前端项目上下文配置（由 `/feai-init` 维护）
- `openspec/specs/auth.md`      认证/登录规格
- `openspec/specs/bot.md`       Bot 相关规格
- `openspec/specs/marketing.md` 营销域规格
- `openspec/specs/plan.md`      套餐/订阅规格
- `openspec/changes/`           变更提案（开发中）/ 归档（已上线）

---

## 十五、参考链接

- [CodeBuddy frontend-ai-dev-tools](https://git.woa.com/lightcloud-fe/ai/frontend-ai-dev-tools) — AI 开发工具链
- [OpenSpec](https://github.com/openspec) — 规范驱动开发系统
- [Superpowers](https://github.com/obra/superpowers) — AI 开发工作流
- [TAPD](https://tapd.woa.com) — 需求管理（workspace `10132091`）
- [Gongfeng](https://git.woa.com/wisp/mono) — 代码仓库
