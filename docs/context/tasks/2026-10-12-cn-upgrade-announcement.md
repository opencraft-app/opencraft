## goal

将 V2 首页升级公告替换为仅国内站展示的 2026-10-12 22:00 至 2026-10-13 06:00（北京时间）公告，并提交新的 MR。

## non_goals

- 不在国际站展示公告。
- 不合并 MR 或发布生产环境。

## requirement_ids / requirement_refs / requirement_excerpt

- 本次用户请求：国内站今天升级，今晚十点至明早六点；国际站不发；新 MR 替代旧公告。
- 历史 MR：!5191 已合并的 10 月 11 日双站公告；!5196 尚未合并的首页公告遮挡修复。

## interface_refs / data_structure_refs

- `MaintenanceAnnouncementBanner` 的公告 ID、到期 UTC 时间、站点门控和 localStorage 关闭记忆。
- `--lw-announcement-visible-height` 驱动首页固定导航与账号操作区偏移。

## history_context

- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`、`frontend/DESIGN.md`。
- `relevant_evolution`：!5191 的双站公告已合并；!5196 的遮挡修复尚未合并，需随本次公告一同交付。
- `superseded_refs`：10 月 11 日公告文本与其国际站译文。

## acceptance

- 国内站首页展示 10 月 12 日北京时间升级公告；10 月 13 日 06:00 自动撤下。
- 关闭 10 月 11 日公告不影响新公告；国际站首页无公告。
- 公告在视口内时不被固定导航遮挡；滚动离开后导航复位。
- 相关测试、前端检查与双站构建通过；新 MR 的远端状态可查询。

## affected_paths

- `frontend/src/components/site/maintenance-announcement-banner.tsx`
- `frontend/src/components/site/__tests__/maintenance-announcement-banner.*.test.tsx`
- `frontend/public/lightvela-intl-home/style.css`
- `frontend/next-site/__tests__/international-home-page.test.tsx`
- `docs/engineering/domains/site-environment-routing.md`

## required_context

- `site-environment-routing`、`frontend-product-surface`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@ab4ff65c5` | 站点边界 | 双站分开验证 |
| `docs/context/project/services/frontend.md@ab4ff65c5` | 前端路由 | 确定验证范围 |
| `frontend/AGENTS.md@ab4ff65c5` | 服务级要求 | 检查、测试、构建与 OpenCraft 同步 |
| `frontend/DESIGN.md@ab4ff65c5` | UI 规则 | 公告和导航布局 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@ab4ff65c5` | 相邻依赖 | 检查测试与生成 i18n |

## evidence

- 聚焦 Vitest：3 个文件、54 项测试通过。
- `pnpm check` 通过，TypeScript 诊断 0 项新增。
- `pnpm build:cn` 与 `pnpm build:global` 均通过。
- 全量 Vitest 出现大量非公告相关失败及 Node heap OOM，已中止；不计为通过。
- `validate_documentation.py` 通过，首方链接损坏数 0。

## risks

- 新公告与旧公告共用展示组件，必须换 ID 避免旧关闭记录隐藏新公告。
- 固定导航覆盖公告；随视口内公告高度偏移并在离开时复位。

## validation

- `git diff --check`
- `pnpm check` 与聚焦 Vitest（从 `frontend/` 执行）
- `pnpm build:cn` 与 `pnpm build:global`
- `npm --prefix opencraft run check:mono2-agent-console`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions

- 新公告仅国内站展示，直接使用中文正文；保留 `useT` 翻译关闭按钮。
- 在新 MR 中纳入 !5196 的遮挡修复，新 MR 建立后关闭被替代的 !5196。

## scan_scope

- `frontend/src/components/site/`、`frontend/public/lightvela-intl-home/style.css`、`frontend/next-site/`。

## scan_output

- 精确检索定位公告组件、双站测试、固定导航 CSS 和静态首页 CSS 断言。

## handoff

- 待提交新 MR 并关闭 !5196；不合并、不发布。全量测试未通过，见 evidence。
