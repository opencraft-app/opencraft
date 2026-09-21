---
id: fix-cn-home-cta-2026-09-04
type: task
scope: 修复国内站新版首页认证态 CTA 回归，并同步当前免费体验主文案。
status: ready-for-review
owner: wisp/mono2-maintainers
---

## goal

恢复国内站新版首页的状态化转化入口：未登录 Header 与 Hero 显示“免费试用”，已登录显示“开始使用”；将下方免费体验主文案更新为“免费体验，10秒极速开通”，同时保持国际站现有行为不变。

## non_goals

- 不修改认证、订阅、支付或 `/agents` 路由守卫。
- 不修改国际站首页 CTA 文案与 `loginOnly` 规则。
- 不发布、不修改 GitOps 或生产环境。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户现场反馈（2026-09-04）：发布国内站新版首页后，未登录首页“免费试用”按钮消失。
- 用户文案确认（2026-09-05）：国内站首页“免费体验，30秒极速部署”调整为“免费体验，10秒极速开通”。
- `wiki/prd-docs/2026-09-04-domestic-homepage-international-zh-adaptation.md`：CTA 对未登录、未订阅、已订阅用户进入正确国内站路径。
- `frontend/openspec/changes/2026-08-31-homepage-auth-entry-design.md`：未登录保持“免费试用”，登录态入口使用“开始使用”。

## interface_refs / data_structure_refs

- `frontend/next-site/public-header-auth-island.tsx`：`loginOnly`、`promoteFreeTrial`、`showProductEntry`。
- `frontend/next-site/international-home-runtime.tsx`：静态 V2 首页认证态桥接。
- 不变量：国内未登录 CTA 指向 `/subscribe`；登录态产品入口指向 `/agents`；国际站继续仅展示语言切换与登录动作。

## history_context

- `current_design_refs`：`wiki/prd-docs/2026-09-04-domestic-homepage-international-zh-adaptation.md`、`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：MR !3610 将国内根路径切到 `zh-CN` V2 静态片段；MR !3611 为 V2 Runtime 补回登录态 Header 产品入口，但未恢复未登录 Header 与状态化 Hero CTA。
- `superseded_refs`：早期 `frontend/openspec/spec.md` 中“国内站不启用 V2 首页”的约束已被 2026-09-04 PRD、当前路由源码及正式领域文档取代。

## acceptance

- 国内未登录桌面 Header 显示“免费试用”与“登录”；移动 Header 保持现有紧凑登录入口，不扩大本次需求。
- 国内未登录 Hero 显示“免费试用”，链接为 `/subscribe`。
- 国内已登录 Header 和 Hero 显示“开始使用”，链接为 `/agents`。
- 国际站 Header 继续 `loginOnly`，国际站 Hero 文案与链接不变。
- 国内站下方免费体验主标题显示“免费体验，10秒极速开通”，国际站对应文案不变。
- 聚焦测试、`pnpm i18n:check`、`pnpm check`、`git diff --check` 通过。

## affected_paths

- `frontend/next-site/international-home-runtime.tsx`
- `frontend/public/lightvela-intl-home/index-fragment.zh-CN.html`
- `frontend/next-site/__tests__/international-home-rendering.test.tsx`
- `frontend/next-site/__tests__/international-home-page.test.tsx`
- `docs/engineering/domains/site-environment-routing.md`
- `wiki/prd-docs/2026-09-04-homepage-copy-deepseek-and-blog-visual-refresh.md`
- `docs/context/tasks/2026-09-04-fix-cn-home-cta.md`

## required_context

- `frontend-product-surface`
- `site-environment-routing`
- `adjacency-frontend-runtime-openspec-i18n`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@1878ce679` | 前端硬规则与验证命令 | 约束实现和门禁 |
| `docs/context/project/services/frontend.md@1878ce679` | 前端服务边界 | 确认双站与验证范围 |
| `docs/context/domains/site-environment-routing.md@1878ce679` | 双站边界 | 要求国内/国际分别验证 |
| `docs/engineering/domains/site-environment-routing.md@1878ce679` | 当前正式站点设计 | 保持国际站 `loginOnly`，国内显式适配 CTA |
| `wiki/prd-docs/2026-09-04-domestic-homepage-international-zh-adaptation.md@1878ce679` | 国内 V2 首页产品真源 | 确认 CTA 状态与国内裸路径 |
| `frontend/openspec/changes/2026-08-31-homepage-auth-entry-design.md@1878ce679` | 认证态入口设计 | 确认“开始使用”及 `/agents` 目标 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1878ce679` | 静态片段邻接检查 | 检查实现、测试与生成边界 |

## evidence

- 生产页面与 `origin/master@1878ce679` 源码确认：V2 Runtime 传入 `loginOnly`，`zh-CN` Hero 静态写死“我的智能体伙伴”。
- 聚焦 Vitest：3 个测试文件、55 个测试通过，覆盖国内匿名/登录态 Header 与 Hero，以及国际站隔离。
- `pnpm i18n:check` 通过。
- `pnpm check` 通过：相对基线 0 个新增诊断；保留 48 个既有翻译警告。
- `pnpm build:cn` 通过：96 个静态页面，构建产物首页默认输出“免费试用”并指向 `/subscribe`。
- `pnpm build:global` 通过：606 个静态页面，国际站首页继续输出既有 Hero 文案及 `/agents` 链接，无国内 CTA 标记。
- 本地国内站真实登录会话验证：桌面 Header 与 Hero 均显示“开始使用”并指向 `/agents`，布局正常。
- 匿名态由静态构建产物及组件集成测试验证；本机浏览器会被现有 API 会话恢复，未取得独立匿名截图。
- 国内站免费体验主标题已更新为“免费体验，10秒极速开通”；聚焦页面测试 31/31 通过，国内构建产物只包含新标题。

## risks

- 风险：以 locale 代替站点边界导致国际站中文串线。缓解：同时使用编译期 `isGlobal` 与 `zh-CN` 判断国内 V2 首页。
- 风险：认证恢复前闪现错误入口。缓解：SSR 静态默认输出安全的未登录态，认证准备完成后仅切换登录态文案与目标。
- 回滚：回退 Runtime 与 `zh-CN` fragment 的本次局部改动。

## validation

- [x] `pnpm exec vitest run --pool=threads --maxWorkers=1 next-site/__tests__/international-home-rendering.test.tsx next-site/__tests__/international-home-page.test.tsx next-site/__tests__/public-header-auth-island.test.tsx`
- [x] `pnpm i18n:check`
- [x] `pnpm check`
- [x] `pnpm build:cn`
- [x] `pnpm build:global`
- [x] 文案增量：聚焦页面测试 31/31、`pnpm i18n:check`、`pnpm check` 与 `pnpm build:cn` 通过。
- [x] 国内站桌面真实登录会话浏览器验证。
- [x] 匿名态构建产物与组件集成测试验证。
- [ ] 独立匿名浏览器截图与 390px 移动视口截图；不阻塞本次代码门禁，列入发布回归。
- [x] `git diff --check`
- [x] `python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file ...`

## decisions

- 使用 V2 Runtime 的小型认证态桥接更新国内 Hero 静态链接，不重构整份 fragment。
- 国内 Hero SSR 默认“免费试用”，避免未登录用户在 hydration 前看到产品内入口。
- 不修改国际站片段和文案。

## scan_scope

- `frontend/next-site/`
- `frontend/public/lightvela-intl-home/index-fragment.zh-CN.html`
- `frontend/scripts/import-international-homepage.mjs`

## scan_output

- 精确搜索确认国内 `zh-CN` 片段为 MR !3610 的站点适配产物，当前导入脚本不负责该国内 CTA 状态桥接。

## handoff

- 当前状态：实现与前端门禁完成，待代码审阅；尚未 commit、push、创建 MR 或发布。
- 下一步：获得用户单独授权后再提交并更新/创建 MR；发布后补生产匿名态与移动端回归。
- 阻塞项：无。
