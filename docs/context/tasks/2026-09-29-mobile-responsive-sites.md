---
id: mobile-responsive-sites-2026-09-29
type: task
scope: Domestic and international LightVela mobile browser layout fixes and MR review follow-up.
triggers: ["mobile responsive", "international homepage", "MR 4829"]
owner: pablozhong
authority: primary
source_of_truth:
  - https://git.woa.com/wisp/mono2/-/merge_requests/4829
status: active
reviewed_at: 2026-09-30
review_due: 2026-10-06
revision: 1.1.0
precedence: task
derived: false
---

## goal
改善 LightVela 国内站与国际站公开页面在移动浏览器中的布局、可读性与导航可达性。

## non_goals
- 不修改鉴权、订阅、支付、Agent 业务逻辑或生产发布配置。
- 不把本地预览视作线上发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-09-29）：整体优化国内站和国际站移动浏览器响应式。

## interface_refs / data_structure_refs
- `frontend/next-site/international-home-page.tsx`：两站首页片段入口。
- `frontend/src/components/site/public-site-header.tsx`：公共内页导航。
- 保持现有链接目标、locale 路由与 CTA 行为。

## history_context
- current_design_refs: `frontend/DESIGN.md`；`docs/context/domains/site-environment-routing.md`。
- relevant_evolution: 首页静态片段和内页共享页头并存，当前源码为准。
- superseded_refs: 无。

## acceptance
- 国内与国际站在 320、375 像素宽度下，首页与主要公开页无页面级横向溢出或遮挡；菜单及主要 CTA 可操作。
- 对修改的前端区域运行聚焦测试、`pnpm check`，并保留浏览器截图证据。

## affected_paths
- `frontend/public/lightvela-intl-home/style.css`
- `frontend/src/pages/marketing/changelog-page.tsx`
- `frontend/src/pages/marketing/open-source-licenses-page.tsx`
- `frontend/src/components/domain/tat-file-manager-panel.tsx`
- `frontend/src/components/domain/__tests__/tat-file-manager-panel.test.tsx`
- `frontend/scripts/import-international-homepage.mjs`
- `frontend/src/pages/marketing/__tests__/lightvela-intl-home-style.test.ts`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/`

## required_context
- `site-environment-routing`、`frontend-product-surface`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@4a3b49a` | 双站边界 | 分别验证国内与国际站 |
| `docs/context/project/services/frontend.md@4a3b49a` | 前端服务入口 | 确定门禁 |
| `frontend/AGENTS.md@4a3b49a` | 最近服务规则 | 约束实现和验证 |
| `frontend/DESIGN.md@4a3b49a` | 视觉规范 | 保持复用组件设计 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@4a3b49a` | 前端邻接 | 检查相关测试与语言路由 |
| `docs/context/flows/tapd-gongfeng-delivery.md@4a3b49a` | MR 交付路由 | 核对提交与远端证据边界 |
| `.agents/skills/gongfeng/SKILL.md@4a3b49a` | 工蜂工具路径 | 使用已配置的工蜂接口 |

## evidence
- 主工作区大量未提交改动；本任务使用独立工作树 `codex/mobile-responsive-sites`，基于 `4a3b49a`。
- `pnpm install --frozen-lockfile --offline` 成功。
- 320px 页面实测：国内更新日志原本 `scrollWidth=536`，长简介为 `white-space:nowrap`；修复后 `scrollWidth=320`。
- 320px 页面实测：国际开源声明原本 `scrollWidth=680`，长许可内容不换行；修复后 `scrollWidth=320`。
- 320px 页面实测：国内控制台云存储页原本 `scrollWidth=391`，隐藏的操作提示仍撑宽页面；移动端隐藏提示后为 `320`。
- 首页 320px：品牌图缩为 92px 后页头不重叠；简体中文轮播长词换到完整下一行。
- `pnpm check`：0 个新增 TypeScript 诊断；聚焦测试 87/87 通过。
- 开源声明长词换行最终收窄至 640px 以下；本地 1280px 的 `overflow-wrap` 为 `normal`、320px 为 `anywhere`，页面宽度均无横向溢出。
- 另一次首页资源测试有 3 项既存失败：断言期待 `.png` 或旧文件名，HEAD 实际资源为 `.webp`；本次未改资源或断言。
- 国内与国际站在最终代码上构建分别成功：105 与 616 个静态路由。
- `validate_change_impact.py --staged` 与 `validate_documentation.py` 通过，后者无断链或告警。
- MR !4829 的初始 CI 为 failure/block；本地复现 `check:mono2-agent-console` 因 `tat-file-manager-panel.tsx` 漂移失败。
- 合入当前 `origin/master` 后，MR 自身改动仍为原六个文件；重新导入首页时可能覆盖的窄屏 CSS 已补进 importer，并新增样式断言。
- 当前代码在 360px 国内首页实测 `scrollWidth=360`，品牌、登录入口和菜单不重叠；320px 日文、韩文首页均无页面级横向溢出。
- 合入当前 master 后，首页样式、更新日志与文件页聚焦测试 47/47 通过；`pnpm check` 为 0 个新增 TypeScript 诊断。
- 本 Task Pack 与 checkpoint 在 `validate_context.py` 中无新增条目；仓库其他历史 context 错误仍存在。
- 源码补充提交 `19c26f518` 后运行 `sync:mono2-agent-console`，仅更新生成清单与 `tat-file-manager-panel.tsx` 副本；`check:mono2-agent-console` 输出 `Verified 130`。
- 最终代码上 `build:cn` 与 `build:global` 分别生成 105、616 个路由，均通过 SEO/静态资源检查。

## risks
- 首页静态片段含多种 locale，样式修复须验证至少中英文及长文案语言。
- 国际站本地认证 API 返回暂不可用；匿名公开页面可验证，登录后国际站控制台未验证。
- 国内站在现有浏览器会话下验证了控制台文件页，但测试账号 Agent 处于暂停状态，文件操作不可用；未触发任何写操作。

## validation
- 聚焦 Vitest 87/87、`pnpm check`、双站 320/375px 浏览器验证、`validate_change_impact --staged`、双站构建。

## decisions
- 先实测再改动；以页面级溢出和操作可达性作为优先级。
- 首页保留操作入口，仅在 359px 以下压缩品牌图与菜单间距；中文长轮播词完整换行。
- 文件页移动端不显示悬浮提示；按钮已有 `aria-label`，避免不可见提示撑宽页面。
- 文件页提示仅在 640px 及以上保留外层键盘焦点，避免窄屏隐藏提示后产生空 Tab 停靠点；切换视口时同步更新焦点属性。
- 360px 已无溢出，保留 359px 断点；日文、韩文已有换行效果，不扩大语言选择器。

## scan_scope
- `frontend/next-site/`、`frontend/src/components/site/`、`frontend/public/lightvela-intl-home/`。

## scan_output
- 相关源码和邻接测试已做有界检索；后续记录浏览器矩阵。

## handoff
- MR !4829 已打开；CR 指出的 Opencraft 同步与生成态 CSS 持久性问题已推送。补充修复窄屏提示空 Tab 焦点后，需重新验证、同步 Opencraft 并核对远端状态。发布仍未授权。浏览器验证报告保存在本次 Codex 可视化目录。
