## goal

Add Teach, Grill Me, and Reddit Automation as the final Featured batch on the international Skills page in the checkout that powers the active global preview.

## non_goals

- Do not change the existing uncommitted domestic SkillHub Featured or category work.
- Do not change search, category ordering, installed-skill behavior, deployment, commit, push, or merge-request state.

## requirement_ids / requirement_refs / requirement_excerpt

- User request in the current task: move the international Featured implementation into `/Users/cassidyshi/CodeBuddy/LightVela-NEW/frontend`, which powers the active global preview.
- Skills supplied by the user:
  - `https://www.skills.sh/mattpocock/skills/teach`
  - `https://www.skills.sh/mattpocock/skills/grill-me`
  - `https://www.skills.sh/flowkit-labs/skills/reddit-automation`

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx` owns global Featured cards and switches to `FEATURED_SKILLS` only when `mode === "global"`.
- `frontend/src/pages/marketing/skills-demo/curated-skill-overviews*.ts` own locale-specific structured detail content.
- Global skill identities must use `registry: "skills-sh"` and a complete three-segment `rawId`.

## history_context

- The original implementation was mistakenly made in `/Users/cassidyshi/Documents/LightVela mono2`, while the active local global preview runs from this checkout.
- Existing uncommitted changes in this checkout are limited to domestic SkillHub Featured and category data plus their generated i18n content.

## acceptance

- Teach, Grill Me, and Reddit Automation form the final three-card Featured batch in global mode.
- Each uses a unique 1200 x 576 AIGC banner with left-side copy space and no embedded text, logos, or watermarks.
- Card and detail content are localized for English, Simplified Chinese, Traditional Chinese, Indonesian, Spanish, Japanese, and Korean.
- Domestic Featured data remains unchanged.

## affected_paths

- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- `frontend/src/pages/marketing/skills-demo/curated-skill-overviews.ts`
- `frontend/src/pages/marketing/skills-demo/curated-skill-overviews.zh.ts`
- `frontend/src/pages/marketing/skills-demo/curated-skill-overviews.id.ts`
- `frontend/src/pages/marketing/skills-demo/curated-skill-overviews.es.ts`
- `frontend/src/pages/marketing/skills-demo/curated-skill-overviews.ja.ts`
- `frontend/src/pages/marketing/skills-demo/curated-skill-overviews.ko.ts`
- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- `frontend/src/pages/marketing/skills-demo/curated-skill-categories.test.ts`
- `frontend/src/i18n/generated/*.json`
- `frontend/public/assets/skills/featured-teach.jpg`
- `frontend/public/assets/skills/featured-grill-me.jpg`
- `frontend/public/assets/skills/featured-reddit-automation.jpg`

## required_context

- `frontend-product-surface`
- `.agents/skills/product-skills/lv-sitepage-skills/SKILL.md`
- `frontend/AGENTS.md`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `.agents/skills/product-skills/lv-sitepage-skills/SKILL.md` | Featured 和双站 Skills 页面约束 | 保持 global data、skills.sh identity、详情模板与独立横幅边界。 |
| `docs/context/project/services/frontend.md` | 前端服务路由 | 确认 locale 生成和聚焦 UI 测试要求。 |
| `frontend/AGENTS.md` | 前端实现和验证规则 | 使用现有组件、i18n 管线和最小有效验证。 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | i18n 和测试邻接 | 确认从生成脚本维护 locale 文件，并检查相邻测试。 |

## evidence

- The active global preview process uses this checkout with `NEXT_PUBLIC_REGION=global` and serves `http://127.0.0.1:3000`.
- The previous checkout contained the intended international configuration but its assets returned 404 from this preview.
- All three new banner assets return HTTP 200 from the active preview and are 1200 x 576 JPEGs.
- The global Skills route `/agents/skills/` returned HTTP 200 after compilation.
- The MR frontend guard failed after i18n validation, not from domestic/global Featured data: `CreateSkillPanel` is an intentionally hidden upstream panel that TypeScript now reports as unused.

## risks

- Existing domestic changes share the same component file, so patches must remain limited to global Featured entries and copy keys.
- Full validation can be blocked if this checkout has unrelated dependency or type errors.

## validation

- `pnpm i18n:check` passed for all supported locales.
- `pnpm exec vitest run src/pages/marketing/skills-demo/curated-skill-categories.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx --maxWorkers=1` passed: 2 files and 71 tests.
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json` passed with no errors, broken links, or warnings.
- `git diff --check` passed.
- `pnpm check` passed: TypeScript reported 0 new diagnostics after documenting the intentionally hidden Create Skill panel.

## decisions

- Append the three entries to `FEATURED_SKILLS` so they become the final global Featured batch.
- Reuse the three AIGC assets generated earlier in this same user request instead of producing duplicate art.
- Do not modify `DOMESTIC_FEATURED_SKILLS` or domestic catalog files.

## scan_scope

- `frontend/src/pages/marketing/skills-demo`
- `frontend/src/i18n/generated`
- `frontend/public/assets/skills`

## scan_output

- Bounded exact search confirmed that the global and domestic Featured datasets are selected by `isDomestic` in `SkillsDemoPanel.tsx`.

## handoff

- Current status: implementation complete.
- The international Featured sequence ends with Teach, Grill Me, and Reddit Automation.
- Each card has a dedicated AIGC banner, localized card copy, and localized structured skill details in English, Simplified Chinese, Traditional Chinese, Indonesian, Spanish, Japanese, and Korean.
- The domestic Featured list and its existing uncommitted work were left unchanged.
- The local global preview remains running on port 3000.
- Existing React 19 compatibility warnings from Tencent Tea and legacy packages appear while compiling the route, but the route completed with HTTP 200.
- The hidden Create Skill panel now has an explicit TypeScript expectation. Re-enabling the tab will make TypeScript require removal of that expectation.
- The MR frontend guard failure is fixed on `codex/skills-featured-updates`; the related Skills tests passed again.
- No commit, push, merge request, or deployment was performed.
