## goal
国际站首页主按钮与头像菜单产品入口统一显示 “My AI Companion”。

## non_goals
- 不修改链接目标、登录状态判断或其他语种译文。
- 不提交或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-05 截图：两处红框都显示 “My AI Companion”。

## interface_refs / data_structure_refs
- `frontend/src/components/site/user-avatar-menu.tsx` 使用 `t("我的智能体")`。
- `frontend/src/i18n/generated/en-US.json` 中 `k_69ee4522` 是该文案英文译文；首页主按钮沿用 “My AI Companion”。

## history_context
- `current_design_refs`：`docs/context/project/services/frontend.md`、`docs/context/domains/site-environment-routing.md`、`frontend/openspec/changes/2026-08-31-homepage-auth-entry-design.md`。
- `relevant_evolution`：此前首页按钮与菜单分别使用不同的英文文案来源。
- `superseded_refs`：无。

## acceptance
- 英文菜单文案等于首页 “My AI Companion”；其他语种及链接不变。
- 国际站构建与 i18n 检查通过。

## affected_paths
- `frontend/src/i18n/generated/en-US.json`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`

## required_context
- `validate_context.py --route 'frontend/src/i18n/generated/en-US.json international homepage My Agents menu label My AI Companion'` 命中 frontend、site-environment-routing、frontend-product-surface。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md` | frontend 服务边界 | 确定文案验证范围 |
| `docs/context/domains/site-environment-routing.md` | 国际站 locale 边界 | 仅调整英文词典 |
| `frontend/AGENTS.md` | 最近服务规则 | 执行 check、test、build |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | i18n 邻接卡 | 检查生成入口及测试邻居 |
| `frontend/scripts/i18n-extract.mjs` | 词典生成入口 | 确认已有译文会保留 |
| `frontend/src/i18n/index.ts` | 词典装载入口 | 确认英文词典被加载 |
| `/Users/pablozhong/.codex/skills/karpathy-guidelines/SKILL.md` | 代码修改规则 | 局部改文案 |

## evidence
- 有界精确搜索发现 `t("我的智能体")` 仅用于头像菜单，英文词典值原为 “My Agents”；首页主按钮已有 “My AI Companion”。
- 英文词典与一致性测试已更新，其他语种词典未动。

## risks
- 同一英文词典 key 的其他引用会同步改变；精确搜索确认当前只有该菜单引用。回滚两处文件即可。

## validation
- `pnpm check`：通过。
- `pnpm exec vitest run src/components/site/__tests__/user-avatar-menu.test.tsx -t 'distinguishes the Agents menu|uses natural English labels'`：8/8 通过。
- `pnpm exec vitest run next-site/__tests__/international-home-page.test.tsx src/i18n/__tests__/dictionaries.test.ts`：55/55 通过。
- `pnpm build:global`：通过。
- 头像菜单测试文件完整运行有两条与本次文案无关的“模型入口”用例失败。

## decisions
- 仅更新英文词典中的既有 key，保留业务组件和首页主按钮结构。

## scan_scope
- `frontend/src/i18n/`、`frontend/src/components/site/`、`frontend/next-site/` 精确文案引用。

## scan_output
- 无独立扫描产物。

## handoff
- 本地修复完成并通过相关验证；未提交、推送或发布。
