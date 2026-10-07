## goal
将右上角头像菜单通往 `/agents` 的入口文案改为“我的智能体伙伴”。

## non_goals
- 不改变入口显示资格、链接、菜单布局或页面标题；不合并或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-07 截图反馈：右上角“我的智能体”改成“我的智能体伙伴”。

## interface_refs / data_structure_refs
- `UserAvatarMenu` 的 Header 下拉入口，仍链接 `AGENTS_HOME_PATH`。
- 复用已有 `t("我的智能体伙伴")` 翻译键及多语言词典。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`。
- relevant_evolution: 首页 Hero 与浏览器标题已使用“我的智能体伙伴”，头像菜单仍使用旧翻译键。
- superseded_refs: 无。

## acceptance
- 中文头像菜单显示“我的智能体伙伴”，仍链接 `/agents`，资格判断不变。
- 国际站保持现有本地化词典语义，英文仍为“My AI Companion”。

## affected_paths
- `frontend/src/components/site/user-avatar-menu.tsx` 及相邻测试。
- `docs/engineering/domains/site-environment-routing.md`。

## required_context
- frontend-product-surface、site-environment-routing。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@20ee7b3d9` | 服务边界 | 确定前端门禁 |
| `docs/context/domains/site-environment-routing.md@20ee7b3d9` | 双站边界 | 沿用翻译键 |
| `frontend/AGENTS.md@20ee7b3d9` | 服务规则 | 验证要求 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@20ee7b3d9` | 邻接 | 检查生成词典和组件测试 |

## evidence
- `UserAvatarMenu` 原用 `t("我的智能体")`；现有 `t("我的智能体伙伴")` 已有所有站点语言翻译。
- 聚焦菜单测试 13/13 通过；`pnpm check` 通过，0 新增 TypeScript 诊断。
- `pnpm build:cn` 与 `pnpm build:global` 均通过。
- OpenCraft 同步只读检查通过；`validate_documentation.py` 通过，0 断链、0 警告；`git diff --check` 通过。

## risks
- 入口共用于双站，切换翻译键会沿用现有各语言“智能体伙伴”译文；菜单测试覆盖词典值。

## validation
- 聚焦组件测试、`pnpm check`、双站构建、OpenCraft 同步检查、文档与 change-impact 门禁。

## decisions
- 复用现有文案键，不创建平行翻译。

## scan_scope
- `user-avatar-menu.tsx`、相邻测试和既有生成词典。

## scan_output
- 精确搜索命中菜单入口、现有翻译键以及测试断言。

## handoff
- 文案和双站构建验证完成；交由 MR 评审，未合并、未发布。
