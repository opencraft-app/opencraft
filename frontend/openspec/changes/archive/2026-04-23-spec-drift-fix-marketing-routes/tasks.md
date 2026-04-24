---
change: spec-drift-fix-marketing-routes
status: completed
archived_at: 2026-04-23
---

# 任务清单：Marketing 主 Spec 路由与数据流漂移修复

## 审计与取证
- [x] 通读 `specs/marketing.md` 最新版，列出所有可能漂移的声明
- [x] 通读 `src/router/index.tsx`，确认当前真实路由结构（`/dashboard/*` + AppShell 子树）
- [x] grep `MarketingAuthGuard` / `AppAccessGuard` / `AuthRouteGuard` / `AuthenticatedGuard` / `PlanGuard`，整理守卫矩阵
- [x] grep `getSettingsSnapshot`，确认真实调用方为 `src/pages/app/settings-page.tsx`
- [x] grep `createBot` / `listSoulTemplates` / `configureQQChannel` / `createWeixinLoginSession`，核对 BotRepository API 清单
- [x] `wc -l` 统计 `openclaw-settings-page.tsx` / `subscribe-page.tsx` / `account-page.tsx` 行数
- [x] 核实 `login-modal.test.tsx` / `marketing-header-actions.test.tsx` / `landing-page.integration.test.tsx` 真实存在
- [x] 通读 `openspec/config.yaml`，确认其「路由结构」小节与 marketing spec 同步失真

## 修复 `specs/marketing.md`
- [x] 「页面 / 路由」节整体重写：
  - [x] 营销域主路径表改为 `/dashboard/*` 体系
  - [x] 新增「旧路径兼容重定向」子表（`/openclaw/*`、`/console/*`、`/create-openclaw`）
  - [x] 新增「认证域（AuthRouteGuard）」子表
  - [x] 新增「AppShell 域（AppAccessGuard + AppShellLayout）」子表，覆盖 `/bots/:id/*`、`/settings/account`
  - [x] 新增「已登录用户可访问（PlanGuard）」：`/plans/select`
  - [x] 新增「内部调试」：`/internal/style-lab`
  - [x] 补 `/dashboard` 裸路径 Navigate 兜底条目
- [x] 扩展「路由守卫」描述，由单一 `MarketingAuthGuard` 扩展为 5 守卫矩阵，注明 `AppAccessGuard` 等价 `AuthenticatedGuard` 但预留扩展位
- [x] 重写「数据流」节：
  - [x] `getSettingsSnapshot(botId)` 归属更正为 AppShell 的 `settings-page.tsx`
  - [x] `openclaw-settings-page.tsx` 补列真实 API 依赖清单（微信登录 / QQ / 终端 / 出生卡等）
- [x] 刷新文件体量数据：
  - [x] `subscribe-page.tsx` 49KB → 50KB（1446 行）
  - [x] `openclaw-settings-page.tsx` 统一为 "125KB / 2929 行"
- [x] 保持业务规则 #1~#9 不变（这些条目均已对齐最新代码）

## 修复 `openspec/config.yaml`
- [x] `context.路由结构` 小节按 `/dashboard/*` 体系重写
- [x] 新增 AppShell 域 / 认证域 / 已登录域 / 内部调试 四个子分组
- [x] 新增旧路径兼容重定向说明
- [x] `/account` 大小：34KB → 41KB
- [x] 补 `/dashboard` 裸路径兜底条目
- [x] 新增「路由守卫矩阵」表格，列出五守卫职责
- [x] 核心 API 列表保持不变（本次未做 API 层漂移修复）

## 验证
- [x] `specs/marketing.md` 路由表每一行都能在 `src/router/index.tsx` 中找到对应
- [x] `specs/marketing.md` 守卫矩阵每个守卫都能在 `src/router/guards.tsx` 中找到对应导出
- [x] `specs/marketing.md` 数据流章节提到的 API 都能在 `src/repositories/types.ts` 找到
- [x] `config.yaml` 路由小节与 marketing spec 路由表零差异
- [x] 无代码文件改动（git status 仅显示 `openspec/` 下的改动）

## 归档
- [x] 提交 commit `docs(openspec): 修复 marketing spec 与实际路由/数据流的漂移`（待用户确认后执行）
- [x] 征得用户确认后，把本变更目录从 `changes/` 移动到 `changes/archive/2026-04-23-spec-drift-fix-marketing-routes/`
- [x] 归档时 proposal.md / design.md / tasks.md 的 front-matter `status` 改为 `archived` / `completed`
