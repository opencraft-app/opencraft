---
change: spec-drift-fix-marketing-routes
status: archived
archived_at: 2026-04-23
branch: docs/spec-drift-fix-marketing-routes
---

# 变更提案：Marketing 主 Spec 路由与数据流漂移修复（文档治理）

## 动机

最近一段时间没有做归档同步，趁这次深度审计主 spec `frontend/openspec/specs/marketing.md`
与当前仓库实际代码 (`src/router/index.tsx` / `src/pages/*`) 的对齐情况，发现**多处严重漂移**：

1. **路由表整体失真**：spec 描述的 `/create-openclaw`、`/openclaw/*` 在代码中早已被重构为
   `/dashboard/*`，旧路径仅作为 `<Navigate>` 兼容重定向。spec 未反映这次重构。
2. **AppShell 分支完全缺失**：`src/pages/app/*` 下的 `/bots/:id/workspace`、
   `/bots/:id/settings`、`/bots/:id/terminal`、`/settings/account`、`/internal/style-lab`、
   `/plans/select`、`/auth/*` 等路由与对应守卫（`AppAccessGuard` / `AuthRouteGuard` /
   `AuthenticatedGuard` / `PlanGuard`）在 marketing spec 中完全未出现。
3. **数据流章节错位**：spec 把 `getSettingsSnapshot(botId)` 归在
   `openclaw-settings-page.tsx` 名下，实际调用此 API 的是 AppShell 分支的
   `src/pages/app/settings-page.tsx`。`openclaw-settings-page.tsx` 走的是
   `configureQQChannel` / `createWeixinLoginSession` / `getTerminalSession` 等更细颗粒 API。
4. **`config.yaml` 路由表同步失真**：`context` 段落的路由列表与 marketing spec 一致地停留
   在 `/openclaw/*` 时代，且 `account-page.tsx` 大小标注为 34KB（实际 41KB）。
5. **文件大小小漂移**：`subscribe-page.tsx` spec 标注 49KB，实际 50.57KB / 1446 行。

本次变更**不涉及任何代码改动**，是一次纯文档治理变更，目的是让 spec / config.yaml
重新成为代码的可信镜像，恢复 OpenSpec 体系的审计价值。

## 影响范围

### 文档 (openspec)
- `frontend/openspec/specs/marketing.md` — 路由表整体重写、新增 AppShell 路由小节、
  守卫矩阵扩展、数据流章节拆分、文件大小数据刷新
- `frontend/openspec/config.yaml` — `context` 段落的「路由结构」小节整体同步到
  `/dashboard/*` 体系；`account-page.tsx` 大小数据刷新

### 代码 (frontend/src)
- 无代码改动

### 未触及
- 后端、其它业务模块、Skillhub、任何 runtime 行为

## 能力变更（Deltas）

| 维度 | 变更类型 | 说明 |
|------|---------|------|
| Marketing 路由表 | 修改 | `/create-openclaw` → `/dashboard/create`；`/openclaw/*` → `/dashboard/*`；明确"旧路径走客户端 Navigate 兼容重定向" |
| AppShell 路由分支 | 新增 | 在 marketing spec 中新增一节，覆盖 `/bots/:id/workspace|settings|terminal`、`/settings/account`、`/plans/select`、`/auth/*`、`/internal/style-lab`，并补路由兜底 `/*` → `/dashboard/settings` |
| 路由守卫矩阵 | 修改 | 由「仅 `MarketingAuthGuard`」扩展为「`MarketingAuthGuard` / `AuthRouteGuard` / `AuthenticatedGuard` / `PlanGuard` / `AppAccessGuard`」五守卫矩阵；`AppAccessGuard` 当前等价 `AuthenticatedGuard`，注明预留扩展位 |
| 数据流章节 | 修改 | `getSettingsSnapshot` 归属从 `openclaw-settings-page.tsx` 更正为 AppShell 的 `src/pages/app/settings-page.tsx`；`openclaw-settings-page.tsx` 列出真实 API 依赖清单 |
| 文件体量标注 | 修改 | `subscribe-page.tsx` 49KB → 50KB / 1446 行；`account-page.tsx` 在 `config.yaml` 中 34KB → 41KB；`openclaw-settings-page.tsx` 补注 2929 行 |
| config.yaml 路由结构 | 修改 | `context` 段落的「路由结构」小节与 marketing spec 同步 |

## 非目标

- **不**重构路由代码、**不**改动任何 runtime 行为
- **不**拆分 `openclaw-settings-page.tsx` 125KB 巨文件（已在主 spec 中作为技术债记录）
- **不**清理 `/openclaw/*` / `/console/*` 旧路径的 Navigate 兼容（保留观察窗口期）
- **不**新增路由或新增业务功能

## 关联

- 发起背景：用户触发一次「好久没归档了，看看主 spec 有无差异」的深度审计
- 审计时间点：2026-04-23
- 同期归档：`2026-04-23-real-name-verification-and-cdn-cleanup`
- 代码基线：`dev` 分支当前 HEAD（含 MR !33 合入后的 `/dashboard/*` 路由体系）
