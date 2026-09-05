## goal
在不改变国内站新首页视觉和产品行为的前提下，减少根路由 HTML/Flight 重复与无关客户端依赖，并用真实 Next 导出产物和浏览器回归证明结果。

## non_goals
- 不修改首页视觉稿、文案、图片内容或产品交互含义。
- 不修改 EdgeOne、Origin、GitOps 或生产环境配置。
- 不提交、推送、创建 MR、合并或发布，除非用户另行明确授权。
- 不把本地构建差异外推为线上 LCP、INP 或 RUM 收益。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-request-2026-09-05-review`：审查新国内站首页代码、浏览器效果和打开速度。
- `user-request-2026-09-05-implement`：用户在收到分级结论后回复“开干”，授权实施所述首页性能优化。

## interface_refs / data_structure_refs
- `frontend/src/app/(site)/page.next.tsx`：根首页路由与入口依赖。
- `frontend/next-site/international-home-page.tsx`：fragment 的 Server Component 入口。
- `frontend/next-site/international-home-runtime.tsx`：首页客户端运行时与认证动作层。
- `frontend/next-site/international-home-routing.ts`：双站 V2 首页路由选择事实。
- `frontend/next-site/__tests__/international-home-rendering.test.tsx`：首页渲染、脚本与路由回归。

## history_context
- `current_design_refs`：`frontend/openspec/changes/2026-08-31-homepage-performance.md` 及相邻实现计划。
- `relevant_evolution`：历史工作已验证单纯移动 Server/Client 边界不自动消除 Flight 重复；本轮必须比较真实 `out/index.html` 与 emitted chunks。
- `superseded_refs`：历史 Lighthouse 数值和旧构建体积不作为本轮收益证据。

## acceptance
- 从最新 `origin/master` 的隔离 worktree 开发，保持主工作区用户改动不动。
- 国内与国际根路由继续渲染对应 V2 fragment；国内匿名/登录 CTA 行为保持不变。
- 不重复历史上已被真实产物证伪的 Server/Client 边界移动；正文 Flight 重复必须如实记录为待后续架构处理的问题。
- 根路由不再静态依赖不可达的旧 `PublicHomePage` client barrel。
- 增加可验证上述边界的聚焦测试或产物预算检查。
- 同环境对比变更前后 `out/index.html`、Flight、脚本数量/体积与代表性正文重复计数。
- 完成聚焦测试、类型/检查门禁、双站构建及桌面/移动端浏览器回归。

## affected_paths
- `frontend/src/app/(site)/page.next.tsx`
- `frontend/next-site/international-home-page.tsx`
- `frontend/next-site/international-home-runtime.tsx`
- `frontend/next-site/__tests__/international-home-rendering.test.tsx`
- `frontend/scripts/check-homepage-performance-budget.mjs`
- `frontend/scripts/check-homepage-performance-budget.test.ts`
- `frontend/package.json`
- `docs/engineering/domains/site-environment-routing.md`
- 仅在最小实现确有需要时新增 `frontend/next-site` 辅助模块或构建产物检查。
- `docs/context/tasks/2026-09-05-cn-homepage-performance-optimization.md`

## required_context
- `site-environment-routing@2.0.0`
- `frontend-service-detail@2.1.0`
- `frontend/AGENTS.md@working-tree`
- `adjacency-frontend-runtime-openspec-i18n@1.0.0`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库边界、Task Pack 与验证要求 | 隔离工作区并约束远端/生产操作 |
| `frontend/AGENTS.md@working-tree` | 前端代码与验证规则 | 确定最小有效门禁 |
| `docs/context/domains/site-environment-routing.md@2.0.0` | 国内/国际双站边界 | 保持两站入口和 locale 行为 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端服务边界 | 绑定静态导出与双站验证 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 首页邻接卡 | 检查测试、生成物和 i18n 邻居 |
| `frontend/openspec/changes/2026-08-31-homepage-performance.md@working-tree` | 历史性能规格 | 继承真实产物验收边界 |
| `frontend/openspec/changes/2026-09-02-international-home-performance-v2-design.md@working-tree` | Server/Client 边界实验记录 | 避免重复无效方案并保留 Flight 风险边界 |
| `frontend/openspec/changes/2026-09-02-international-home-performance-v2-implementation-plan.md@working-tree` | 既有实施与回退决策 | 选择仍有产物收益的入口和客户端依赖优化 |
| `docs/engineering/domains/site-environment-routing.md@working-tree` | 变更影响映射要求的权威设计 | 记录根路由 V2 直达与产物预算边界 |

## evidence
- 开发 worktree：`/Users/pablozhong/codex/lightvela/.worktrees/cn-homepage-performance`。
- 分支：`codex/optimize-cn-homepage-loading`，基线 `origin/master@65784cf2e6ae16c5687919b2b01f25febf0096b8`。
- 主工作区存在用户未跟踪内容，保持不动。
- 线上只读审查基线报告：`/tmp/lightvela-cn-home-review-20260905/report.html`。

## risks
- App Router 静态导出可能仍将 Server Component 内容写入 Flight；不能以“移出 Client prop”替代真实产物验证。
- 移除根路由 fallback 前必须证明当前国内、国际默认 locale 均由 V2 首页覆盖。
- 认证动作层依赖 session 与 region；结构调整不能破坏国内匿名免费试用、登录后开始使用或国际站登录行为。

## validation
- baseline 与修改后的 `build:cn` / `build:global` 产物体积和正文重复计数。
- `international-home-rendering.test.tsx` 及新增聚焦测试。
- `pnpm check` 与必要的双站构建门禁。
- 本地导出产物桌面 `1280×720`、移动 `390×844` 浏览器截图、DOM、console 与溢出检查。

## decisions
- 首先做最小结构改动并检查真实产物；若 Flight 仍重复，再基于产物证据决定是否需要更换静态壳层方案。
- 不在本轮顺手修改 Edge 缓存或压缩配置。

## scan_scope
- `frontend/src/app/(site)`、`frontend/next-site`、首页生成 fragment、相关测试与构建脚本。

## scan_output
- 根路由静态导入 `PublicHomePage`，即使国内和国际默认 locale 均已确定走 V2，也会让旧首页 client barrel 进入初始产物。
- 公共头部认证岛静态导入 `react-i18next`、登录弹窗和头像菜单；初始未登录且弹窗关闭时仍承担这些模块的入口依赖。
- 首页三段动画脚本按 `onload` 串行请求；三者无声明依赖，改为并行插入后交互脚本仍正常初始化。
- 历史设计及本轮产物均证明正文仍在 HTML 与 Flight 中各出现一次；这不是本轮最小边界调整能消除的问题。
- 同环境 CN webpack 静态导出前后：Next 初始脚本 24→20，原始体积 2,835,941→2,127,394 B（-708,547 B），gzip 953,870→725,261 B（-228,609 B）；旧首页 303,700 B chunk 消失。
- CN HTML 356,899→355,997 B，Flight 209,049→208,550 B；代表正文计数仍为 2，明确未把轻微变化误报为正文去重。
- Global 最终导出 606/606 页，根页 20 个 Next 脚本、2,127,402 B 原始 / 725,233 B gzip，未出现旧首页 chunk。
- 新增 `pnpm check:homepage-performance`，直接读取真实 `out/index.html` 与引用 chunk；当前 CN 产物为 HTML 356,394 B、Flight 208,550 B、20 个 Next 脚本、2,127,394 B 原始 / 725,261 B gzip，预算通过。
- 预算测试覆盖轻量产物通过、旧 `PublicHomePage`/`LandingPageView` chunk 回归失败、初始 Next 脚本超过 22 个失败；没有自动串入默认 build 链，因为本地默认 Turbopack 构建未形成可复现完成证据。

## handoff
- 状态：实现与验证完成，尚未提交、推送或创建 MR。
- 验证：聚焦 Vitest 6 files / 66 tests 通过；`pnpm check` 与 `pnpm check:homepage-performance` 通过；CN 96/96、Global 606/606 静态导出通过；桌面 1280×720 与移动 390×844 浏览器回归通过，console 无 warning/error，移动端无横向溢出。
- 浏览器补充：三段首页运行时脚本均存在，QQ 渠道切换后内容正确更新；移动长截图中的重复粘性片段属于 full-page 截图拼接现象，DOM 中对应区块标题各只有一个实例。
- 下一步：用户确认后再展示提交范围、建议 commit message，并执行 commit/push/MR。
