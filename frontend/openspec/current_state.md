# 项目当前状态（项目地图）

> 本文件是低频项目地图，供 AI 快速建立全局认知。**不写需求历史、上一个需求摘要或当前会话状态**——
> 当前需求状态由 `openspec/plan.md` + `.workflow/runtime/current-task.summary.md` 承载。
> 业务深度上下文（技术栈 / 路由 / 状态 / API / 组件）维护在 `openspec/config.yaml` 的 `context:` 段。

最后更新：2026-07-16（`/feai-init` 重新生成）

---

## 一、项目概览

- **项目**：Lightclaw（lightvela.com 国内站 / lightvela.ai 国际站）—— C 端 AI Agent SaaS
- **仓库**：`wisp/mono2`（Go 微服务 Monorepo，前端位于 `frontend/` 子目录）
- **默认分支**：`master`（国内 + 国际站合一，编译期 `isCN` / `isGlobal` 区分）
- **TAPD**：10132091
- **业务上下文真源**：`frontend/openspec/config.yaml`（`context:` 段，~270 行高保真上下文）

---

## 二、顶层结构（`frontend/`）

```
frontend/
├── src/
│   ├── app/                  # Next.js App Router 路由（.next.tsx）
│   │   ├── layout.next.tsx   # 根布局（HTML shell + metadata）
│   │   └── (site)/           # site 分组布局（SessionProvider / RepositoryProvider / 主题）
│   ├── pages/
│   │   ├── marketing/        # 营销域（落地/控制台/账户/订阅/agent-settings/hermes/buddy）
│   │   ├── app/              # AppShell 域（workspace/settings/terminal）
│   │   └── auth/             # 认证域
│   ├── next-site/            # Next App Router 与 src/pages 之间的 client island 桥接
│   ├── components/
│   │   ├── ui/               # 设计系统原子组件（21 个）
│   │   ├── domain/           # 业务领域组件（18 个）
│   │   └── site/             # 站点级组件（14 个）
│   ├── contexts/             # 4 个 Provider（session / openclaw / repository / runtime-config）
│   ├── repositories/         # Repository Pattern（http / fake / types / account-preview-states）
│   ├── lib/                  # 工具函数与客户端（region / skillhub-api / tssh / hermes-cron / seo / soul / tat 等）
│   ├── domain/               # 领域类型与套餐目录
│   ├── i18n/                 # 中文即 key 方案（index / t.ts / generated/*.json 禁改）
│   └── router/               # 路由守卫（guards.tsx）
├── public/                   # 静态资源
├── scripts/                  # 构建/i18n/部署脚本（含 deploy-cloudflare-pages / deploy-edgeone-pages）
├── openspec/                 # 业务规范（config.yaml / plan.md / specs/ / changes/archive/）
└── AGENTS.md                 # 前端子项目 AI 指引（薄入口）
```

---

## 三、核心模块索引

| 模块 | 入口 | spec | 备注 |
|------|------|------|------|
| 营销域（落地/控制台/账户/订阅） | `pages/marketing/` | `specs/marketing.md` | Agent 控制台主页已更名 `agent-settings-page.tsx`（232KB），spec 仍用旧名 `openclaw-settings-page.tsx`，**待同步** |
| 认证 | `pages/auth/` + `contexts/session-context.tsx` | `specs/auth.md` | 手机验证码 / OAuth / 邀请码 / 会话 |
| Bot 工作台 | `pages/app/workspace-page.tsx` | `specs/bot.md` | AppShell 域：workspace / settings / terminal |
| 套餐订阅 | `next-site/subscribe-page.tsx` | `specs/plan.md` | 套餐选择 / 支付 / 权益 |
| Buddy 伙伴系统 | `pages/marketing/openclaw-buddy-*.tsx` | `specs/buddy.md` | 抽卡 / 灵魂测试 / 卡片面板（65KB+） |
| Agent 桌面宿主 | `pages/marketing/agents-workbench/` | `specs/agents-workbench.md` | VelaWorkbenchDesktopHost + velad-* 桌面端 |
| Hermes 自动任务 | `pages/marketing/hermes-agent-automations-panel.tsx`（174KB） | （`specs/marketing.md` 已覆盖） | 复用 `lib/hermes-cron-client.ts`（70KB） |
| Hermes 专家包 | `pages/marketing/hermes-agent-experts-panel.tsx` | （`specs/marketing.md` 已覆盖） | SkillHub 技能包安装 |
| Hermes 技能面板 | `pages/marketing/hermes-agent-skills-panel.tsx` | （`specs/marketing.md` 已覆盖） | 学习技能 / 已安装技能管理 |
| 区域化 | `lib/region.ts` | （`config.yaml` 已覆盖） | `isCN` / `isGlobal` 编译期常量 |
| i18n | `i18n/` + `useT()` | （`config.yaml` 已覆盖） | 中文即 key + `pnpm i18n:check` 门禁 |

---

## 四、架构边界与约束

1. **路由方案**：Next.js App Router（`pageExtensions: ['next.tsx', 'next.ts']`）。`next-site/*` 是 client island 桥接层，复用 `src/pages/*` 页面组件。**不得再新增 `src/router/*` 作为应用入口**（URL 常量放 `lib/agent-routes.ts`）。
2. **状态管理**：纯 React Context + useReducer，无 Redux/Zustand。4 个 Provider：
   - `SessionProvider`（会话/用户/订阅，持久化 `lightclaw-ui-session-v1`）
   - `OpenClawProvider`（OpenClaw 实例 + 创建向导）
   - `RepositoryProvider`（依赖注入 http/fake 实现）
   - `RuntimeConfigContext`（运行时配置）
3. **API 层**：Repository Pattern。所有 API 经 `AuthRepository` / `PlanRepository` / `BotRepository` 接口访问，请求入口 `repositories/http-repositories.ts`，统一 `APIEnvelope<T>` 解包 + 401 广播 `AUTH_UNAUTHORIZED_EVENT`。
4. **区域化**：`isCN` / `isGlobal` 是编译期常量（`NEXT_PUBLIC_REGION` 注入，兼容 `VITE_REGION`），未命中分支被 Tree-shake。国内 vs 国际差异**必须**走编译期分支，不得用运行时 locale 判断。
5. **i18n**：业务侧调 `useT()`，参数直接写中文原文；`generated/*.json` 由 `pnpm i18n:extract` 自动生成，**禁止手改**。
6. **路径别名**：`@/*` → `src/*`、`@next-site/*` → `next-site/*`、`collections/*` → `.source/*`。
7. **SDK 依赖**：`@tencent/tea-sdk-lightclaw`（控制台内嵌），模型/通道/Coding Plan 等基础配置来自 SDK 的 `createLighthouseConfig`，宿主页面不得临时 patch。`velachat: file:../velalink` 是 subtree 依赖。
8. **质量门禁**：`pnpm check`（tsc）+ `pnpm test`（vitest）+ `pnpm i18n:check`。当前无 `lint` 脚本。

---

## 五、常用入口与关键链路

| 操作 | 命令 |
|------|------|
| 本地开发（真实国际站后端） | `NEXT_PUBLIC_AUTH_API_BASE_URL=https://lightclaw.tech pnpm dev -- -H 127.0.0.1 -p 5174` |
| 本地开发（国内站） | `pnpm dev:cn` |
| 本地开发（国际站） | `pnpm dev:global` |
| 静态检查 | `pnpm check` |
| 单测 | `pnpm test` |
| i18n 抽取 / 检查 | `pnpm i18n:extract` / `pnpm i18n:check` |
| 构建国内站 | `pnpm build:cn` |
| 构建国际站 | `pnpm build:global` |
| 部署国际站（CF） | `pnpm deploy:cf` |
| 部署国际站（EdgeOne） | `pnpm deploy:eo` |
| 分支预览 | 推 `frontsandbox/<name>` 分支自动构建双产物发布到 StaticPages |

---

## 六、已知技术债与 drift 待修

- `specs/marketing.md` 仍用旧名 `openclaw-settings-page.tsx`（125KB），实际已更名 `agent-settings-page.tsx`（232KB）—— spec 需同步重命名与体量更新（按 init 硬约束本次未覆盖，需单独变更）。
- `agent-settings-page.tsx` 单文件 232KB，远超健康阈值，需拆分通道配置 / 工具 / 知识库 / 审计 / 模型 / 技能等子模块。
- `account-page.tsx` 41KB / 1084 行，偏大，应拆分账号信息 / 订阅 / 权益 / 安全中心 / 实名认证。
- `lib/hermes-cron-client.ts` 70KB 单文件，是最大的 lib 文件。
- i18n `en-US.json` 需保证发布前 `pnpm i18n:check` 清单为空。

---

## 七、历史归档清单

历史变更归档位于 `openspec/changes/archive/`，按日期命名（如 `2026-07-14-scenario-task-installer.md`）。本文件不重复罗列，需要时直接读取该目录。
