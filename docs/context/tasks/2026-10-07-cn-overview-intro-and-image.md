## goal
更新国内站 overview 的产品简介和配图，使个人 AI 助理定位与当前首页一致。

## non_goals
- 不修改国际站文档、首页代码或发布状态。
- 不改变 Hermes Agent 的运行行为。

## requirement_ids / requirement_refs / requirement_excerpt
- 本次会话用户提供的 `lightvela.com/docs/overview/` 截图及四点要求：弱化托管 Hermes Agent、突出个人 AI 助理/伙伴及云端 7×24 小时在线、纠正产品名称、更新下方截图。

## interface_refs / data_structure_refs
- 文档源：`frontend/src/content/docs/01-overview.md`。
- 配图源：`frontend/src/content/docs/images/20260424-112540-oxe6.webp`；`pnpm docs:sync` 生成可渲染内容。

## history_context
- `current_design_refs`: `docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`: 本会话前序已将国内站定位改为“云端 AI Agent 产品”，并移除摘要价格信息；该源文件已有未提交改动。
- `superseded_refs`: 旧版首页截图与将 Hermes Agent 称为产品的文案。

## acceptance
- 摘要和简介以个人 AI 助理/伙伴、云端与 7×24 小时在线为主。
- 只说明当前 Agent 基于 Hermes Agent 运行，不把 Hermes Agent 称为产品。
- 现有文档图片替换为真实国内站首页内容，不含浏览器边框或敏感数据。
- `pnpm docs:sync` 成功且源文件与渲染产物核对一致。

## affected_paths
- `frontend/src/content/docs/01-overview.md`
- `frontend/src/content/docs/images/20260424-112540-oxe6.webp`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- `frontend-product-surface`: `docs/context/project/services/frontend.md` 与 `frontend/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@2.1.0` | 文档源与生成边界 | 编辑源并运行同步 |
| `frontend/AGENTS.md` | 前端交接门禁 | 选择验证命令 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端与生成内容邻接 | 核查渲染产物 |
| `docs/engineering/domains/site-environment-routing.md` | 双站正式设计 | 记录国内站定位边界 |

## evidence
- 2026-10-07 浏览器核对 `https://lightvela.com/`，首页展示“越用越懂你，长期在线的 AI 伙伴”。
- 浏览器首屏截图已覆盖既有 WebP（1280×720）；公开图片与文档图片字节一致。
- `pnpm docs:sync` 成功，同步 521 篇文档；源 Markdown 和 `zh-cn/overview.mdx` 的简介与图片引用核对通过。
- `pnpm check` 通过：文档同步、MDX、i18n 和类型检查完成，0 个新增 TypeScript diagnostics。
- 聚焦 Vitest 在测试进程内临时映射 `localhost` 至 `127.0.0.1` 后通过：6 个测试文件、108 项断言；同时更新日语定位语的旧断言。
- `pnpm build:cn`、`pnpm build:global` 与 OpenCraft Agent Console 只读同步检查通过。
- `git diff --check` 与文档验证通过（0 断链、0 警告）；`validate_change_impact.py --repo . --staged` 对本次暂存变更通过。

## risks
- 本次在最新 `origin/master` 创建独立工作树，逐段修改文档并保留主干已有内容。
- 首页含动态轮播文字；截图以本次可见首屏为准。

## validation
- 文档同步、源/产物文案核对、图片尺寸与视觉核对、前端最小有效检查、`git diff --check`。

## decisions
- 只更新国内站 overview；保留其他段落中的套餐与渠道事实。
- 沿用既有图片路径，覆盖旧图，不增加旁路资源。

## scan_scope
- `frontend/src/content/docs/01-overview.md` 及其引用的首张图片。

## scan_output
- 本 Task Pack 的 evidence 与 handoff。

## handoff
- 文案与截图已更新，准备提交 MR；未发布。
