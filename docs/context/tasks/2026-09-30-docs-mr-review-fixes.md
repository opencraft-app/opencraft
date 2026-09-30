# 文档 MR !4859 评审意见复核

## goal
复核并处理 MR !4859 的文档生成、繁中资源、报告归档和钉钉外链意见。

## non_goals
- 不改变成就页功能、路由或文档内容主流程。

## requirement_ids / requirement_refs / requirement_excerpt
- MR !4859；用户提供 8 项走查意见，要求修正真实问题并复验。

## interface_refs / data_structure_refs
- `frontend/scripts/sync-fumadocs-content.mjs`：`docSets`、`writeDoc()`、`localizedImageName()`、`copyImages()`。
- `frontend/next-site/docs-route-manifest.ts`：各 locale 的成就页路由。

## history_context
- `current_design_refs`：`frontend/src/content/docs/`、`wiki/product-state/README.md`、`wiki/sources/README.md`。
- `relevant_evolution`：MR 已生成 8 个 locale 的成就页；`public/docs-images` 是 Git 跟踪的静态资源目录。

## acceptance
- 8 个成就页产物均有 `title`、`description` 和真实图片。
- 繁中产物由 `global/` 正文生成，图片命中 `-zh-hant`。
- 阶段性评估报告移至 `wiki/sources/`；钉钉正文不含第三方外链。
- 文档同步、parity 测试和文档校验通过。

## affected_paths
- `frontend/src/content/docs/configuration/channel-dingtalk.md`
- `wiki/sources/2026-09-30-docs-feature-alignment-audit.md`

## required_context
- `tapd-gongfeng-delivery`；`lv-docs` 文档站规则。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/flows/tapd-gongfeng-delivery.md` | MR 交付 | 核对授权与检查状态 |
| `frontend/AGENTS.md` | 前端门禁 | 选择文档同步和测试 |
| `frontend/scripts/sync-fumadocs-content.mjs` | 生成真源 | 判定 frontmatter、繁中及图片意见 |
| `wiki/product-state/README.md`、`wiki/sources/README.md` | 目录所有权 | 移动阶段性报告 |

## evidence
- `writeDoc()` 为全部产物写入 frontmatter；`zh-hant` 的 `sourcePrefix` 是 `global`。
- 重新同步后，8 个 `configuration/achievements.mdx` 均含 frontmatter；繁中 `source_path` 是 `global/configuration/achievements.md`，图片命中 `achievements-overview-zh-hant.webp`。
- `pnpm docs:sync` 同步 521 篇；国际文档 parity 44 项测试通过；文档校验 0 死链、0 告警、0 未分类。
- `frontend/public/docs-images` 已有 378 个 Git 跟踪文件；本次同步没有给该目录带来新差异。

## risks
- 若未来更改繁中生成策略，需要同步检查 `sourcePrefix` 和本地化图片规则。

## validation
- `pnpm docs:sync`
- `pnpm vitest run scripts/international-docs-parity.test.ts --config vitest.config.ts`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `git diff --check`

## decisions
- 源 Markdown 不加 frontmatter，避免生成器把第二份 frontmatter 当正文；繁中不建独立源文件，遵循现有转换链。
- 仅修正报告归属与钉钉外链；保留已追踪且同步无差异的公共图片。

## scan_scope
- `frontend/src/content/docs/configuration/`、`frontend/scripts/sync-fumadocs-content.mjs`、`wiki/product-state/`、`wiki/sources/`。

## scan_output
- 8 项意见中，2 项需要代码或文档改动，4 项经生成产物核实无需改动，2 项为已通过的既有事实。

## handoff
- 等待提交推送后核对 MR 流水线。
