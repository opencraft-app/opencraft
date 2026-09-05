## goal
让国内站首页浏览器页签显示与国际站一致的 LightVela 机器人 favicon，并使浏览器绕过国内域名下的旧图标缓存。

## non_goals
- 不调整首页正文、导航、页面标题、Open Graph 图片或品牌 Logo。
- 不执行提交、推送、MR、发布或生产变更。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图需求（2026-09-05）：国内站页签图标错误，应参考国际站页签图标。

## interface_refs / data_structure_refs
- `frontend/src/app/layout.next.tsx`：Next Metadata `icons`。
- `frontend/src/app/manifest.webmanifest/route.next.ts`：Web App Manifest `icons`。
- 不变量：两处均引用同一 PNG/SVG favicon 版本，国内站与国际站不分叉。

## history_context
- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：`9fea54d18` 曾将 favicon 从文字 Logo 换为无文字机器人图标；当前生产 HTML 已声明机器人图标，但未版本化 URL。
- `superseded_refs`：无。

## acceptance
- 国内站与国际站构建均输出带新版本参数的机器人 favicon URL。
- Web manifest 与 document head 的 PNG/SVG URL 保持一致。
- 聚焦测试、前端检查与双站构建通过。

## affected_paths
- `frontend/next-site/site-icons.ts`
- `frontend/next-site/__tests__/site-icons.test.ts`
- `frontend/src/app/layout.next.tsx`
- `frontend/src/app/manifest.webmanifest/route.next.ts`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- `site-environment-routing`
- `frontend-product-surface`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@2.0.0` | 双站属于独立交付面 | 要求分别验证国内/国际站 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端服务验证边界 | 选择聚焦测试、检查和双站构建 |
| `frontend/AGENTS.md@65784cf2e` | 前端硬规则与门禁 | 保持最小改动并运行服务验证 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 首页静态产物邻接 | 检查静态构建产物与测试邻居 |
| `docs/engineering/domains/site-environment-routing.md@65784cf2e` | change-impact 映射设计真源 | 增补 favicon 双站与缓存约束 |
| `frontend/openspec/specs/marketing.md@65784cf2e` | 当前营销页约束 | 确认未触及正文与站点路由 |

## evidence
- 实现前线上只读核对：两站 HTML 均声明 `/lightvela-icon.png` 与 `/lightvela-icon.svg`；两站 `/favicon.ico` 均为 404；机器人 PNG 可正常返回。
- `pnpm exec vitest run --config vitest.config.ts next-site/__tests__/site-icons.test.ts`：2/2 通过；因本机 `localhost` 无 DNS 映射，运行时临时将 Vite host 指向 `127.0.0.1`，已撤回该临时改动。
- `pnpm check`：通过；TypeScript baseline 新增诊断 0。
- 国内站 `NODE_OPTIONS=--max-old-space-size=8192 NEXT_PUBLIC_REGION=cn VITE_REGION=cn pnpm exec next build --webpack --experimental-app-only`：96/96 静态页面构建成功；`out/index.html` 输出 4 条版本化 favicon 声明，manifest 指向 `https://lightvela.com/...?...`。
- 国际站对应 webpack App Router 构建：606/606 静态页面构建成功；head 声明与国内站一致，manifest 指向 `https://lightvela.ai/...?...`。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过，错误与告警均为 0。
- `validate_change_impact.py --staged` 对 7 个变更文件检查：`docs-impact: passed`。

## risks
- Safari 对 favicon 缓存较强；通过更换稳定 URL 查询版本规避。回滚时恢复旧 URL 即可。
- 共享 layout 会同时影响两站；聚焦测试与双站构建用于防止区域分叉。

## validation
- 已通过：聚焦 Vitest、`pnpm check`、documentation gate、change-impact gate。
- 已通过：国内/国际站 webpack App Router 静态构建与最终 HTML/manifest 检查。
- 标准 `pnpm build:cn` 的 Turbopack 编译在当前机器持续无进展后被中止；默认 4GB 的 webpack fallback 首次因 OOM 失败，提高到 8GB 后双站构建成功。未把本地构建成功描述为生产发布。

## decisions
- 复用现有、已核验为机器人形象的 PNG/SVG 文件，仅更新到基于当前 PNG 内容哈希前缀的稳定查询版本；避免复制二进制资源或引入站点条件分支。

## scan_scope
- `frontend/src/app/**`
- `frontend/next-site/**`
- `frontend/public/lightvela-icon.*`
- `frontend/openspec/specs/marketing.md`

## scan_output
- 有界搜索未发现其他 favicon 声明；Organization JSON-LD 的 `lightvela-logo.jpg` 不是浏览器 icon 来源。

## handoff
- 本地实现与验证完成；尚未提交、推送、创建 MR 或发布。
