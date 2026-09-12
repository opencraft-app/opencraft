## goal
Replace the domestic `理财分析` category's Xiaohongshu analysis card with the verified SkillHub finance-advisor skill, keeping its card, detail view, and installation identity consistent.

## non_goals
- Do not alter international Skills categories or search behavior.
- Do not change the other five domestic finance category cards.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-12: replace `小红书数据洞察与竞品分析助手` in domestic `理财分析` with `金融助手` at `@user_0caf726f/finance-advisor`, and ensure installation and detail content use the replacement skill.

## interface_refs / data_structure_refs
- `DOMESTIC_SKILL_CATEGORIES` is the domestic fixed-category source of truth.
- Domestic install actions call `buildSkillhubInstallCommand(skill.rawId)`, so the card must retain the verified `finance-advisor` raw ID.
- `CURATED_SKILL_OVERVIEWS_ZH` supplies the domestic skill detail dialog by raw ID.

## history_context
- `current_design_refs`: `frontend/src/pages/marketing/skills-demo/domestic-skill-catalog.ts` and `curated-skill-overviews.zh.ts`.
- `relevant_evolution`: none.
- `superseded_refs`: the replaced `xiaohongshu-content-tools` domestic category entry.

## acceptance
- The domestic finance category contains `finance-advisor` in the replaced card position, with the verified title, description, download snapshot, and icon.
- Installing the card issues the standard domestic `acli skills install 'finance-advisor'` path.
- Opening the card finds a complete Chinese structured detail overview for `finance-advisor`.

## affected_paths
- `frontend/src/pages/marketing/skills-demo/domestic-skill-catalog.ts`
- `frontend/src/pages/marketing/skills-demo/curated-skill-overviews.zh.ts`
- `frontend/src/pages/marketing/skills-demo/domestic-skill-catalog.test.ts`

## required_context
- No route matched this domestic Skills-page request.
- `lv-sitepage-skills` defines SkillHub identity, catalog, install, and detail requirements.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库级行为和验证边界 | 限定变更与交接 |
| `frontend/AGENTS.md` | 前端测试要求 | 为运营配置变更添加聚焦测试 |
| `.agents/skills/product-skills/lv-sitepage-skills/SKILL.md` | 国内 Skills 分类工作流 | 保持国内 SkillHub slug、安装和详情一致 |
| `https://api.skillhub.cn/api/skills?keyword=finance-advisor` | SkillHub 可验证来源 | 核对 canonical ID、名称、描述、下载量和图标 |

## evidence
- SkillHub search returned `@user_0caf726f/finance-advisor`, title `金融助手`, 2,938 downloads, icon URL, and `requires_api_key=false`.

## risks
- A display-only replacement would retain the old installation identity. Mitigation: update the catalog raw ID and add an explicit identity test.

## validation
- Run the domestic SkillHub catalog Vitest file, `pnpm i18n:check`, `pnpm check`, and `git diff --check`.

## decisions
- Use the registry's install slug `finance-advisor`, not the display handle, because domestic installs are keyed by SkillHub raw ID.

## scan_scope
- `frontend/src/pages/marketing/skills-demo/`

## scan_output
- Bounded search found the fixed category card, its Chinese detail overview, and the catalog contract test.

## handoff
- In progress.
