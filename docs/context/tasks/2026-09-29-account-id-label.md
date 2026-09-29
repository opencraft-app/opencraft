## goal
将账号页昵称下方的用户 ID 标签改为明确的“账号 ID”，并补齐各语言译文。

## non_goals
- 不改动用户 ID 值、复制行为、账号资料或站点路由。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图与本轮请求：`/account` 页面把“id”改为“账号 ID”，优化多语言文案。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/account-page.tsx` 中的 `user.id` 展示；保持展示值与复制值一致。
- `frontend/src/i18n/t.ts` 的中文原文键与插值规则。

## history_context
- current_design_refs: `frontend/src/i18n/index.ts`、`frontend/scripts/i18n-extract.mjs`。
- relevant_evolution: 当前英文原文键未被中文文案提取器收录。
- superseded_refs: 无。

## acceptance
- 中文展示“账号 ID：<用户 ID>”；各注册语言展示对应本地化标签。
- 插值与复制的用户 ID 不变；i18n 检查及前端检查通过。

## affected_paths
- `frontend/src/pages/marketing/account-page.tsx`
- `frontend/src/i18n/generated/`

## required_context
- Pack: `frontend-product-surface`。
- `docs/context/project/services/frontend.md`、`frontend/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@HEAD` | 前端服务边界 | 确定文案范围与验证要求 |
| `frontend/AGENTS.md@HEAD` | 最近服务规则 | 确定检查命令 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | i18n 邻接 | 核对提取脚本、字典与测试 |
| `frontend/src/i18n/index.ts@HEAD` | 翻译加载入口 | 确认注册语言的字典加载 |
| `frontend/src/i18n/t.ts@HEAD` | 文案键和插值 | 使用中文键及插值参数 |
| `frontend/scripts/i18n-extract.mjs@HEAD` | 生成入口 | 正确生成 locale 键 |
| `frontend/src/i18n/__tests__/dictionaries.test.ts@HEAD` | 字典测试邻居 | 验证全语种键与占位符 |
| `frontend/openspec/changes/2026-09-14-global-agents-account-language-switcher-design.md@HEAD` | 账号语言入口约束 | 确认不改变语言选择行为 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md@HEAD` | 交接要求 | 记录本轮最终状态 |

## evidence
- 初始精确搜索：原文 `t("id: {{id}}")` 仅在账号页出现，生成字典未收录。
- `pnpm i18n:extract` 生成新增键 `k_fff0e138`；`pnpm i18n:zh-hant` 生成“賬號 ID”。
- 自定义只读断言核对七种字典的完整标签与 `{{id}}` 占位符，全部通过。
- HEAD 基线的韩语字典比简中多 5 个旧键，而字典测试同时断言键集相等和其中一个旧键存在，现有基线无法使这两项断言同时通过；保留旧键避免本轮越界修改。

## risks
- 长标签在窄屏截断；保持现有 `truncate` 布局并检查译文长度。
- 生成脚本可能产生无关字典改动；检查差异并只保留本次键。

## validation
- `pnpm i18n:check`、`pnpm i18n:validate`、字典聚焦测试、`pnpm check`。
- `pnpm check` 通过：七种语言无新增缺口，i18n 结构错误 0，TypeScript 新增诊断 0。
- `account-page-name-audit.test.tsx` 通过：45/45，含账号 ID 展示及复制行为。
- `pnpm build:cn` 与 `pnpm build:global` 均通过；构建产生的 `next-env.d.ts` 和字体文件改动已恢复。
- 字典测试：含 18 项，基线旧键冲突使 3 项失败；保留了该基线，不将清理扩入本次文案改动。

## decisions
- 使用中文原文键并沿用原有 ID 占位符替换方式，避免各语言回落成英文且不改变 ID 处理；owner: 本轮实现。

## scan_scope
- `frontend/src/pages/marketing/account-page.tsx`、`frontend/src/i18n/`、`frontend/scripts/i18n-extract.mjs`。

## scan_output
- 有界 `rg` 输出已用于定位单一展示点与字典生成入口。

## handoff
- 本地文案、聚焦验证、双站构建及差异检查已完成；远端状态以工蜂最新记录为准。
