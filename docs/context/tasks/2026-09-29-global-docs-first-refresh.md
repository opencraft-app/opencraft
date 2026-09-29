## goal
Update the first batch of international LightVela product docs so purchase, credit, Skills, onboarding, and WhatsApp setup guidance matches the current international product, then update MR !4756.

## non_goals
- Domestic documentation, product behavior, deployment, merge, and release.
- Broad navigation redesign and remaining long-form content cleanup.

## requirement_ids / requirement_refs / requirement_excerpt
- User request: "国际站lightvela.ai，也看看官网文档要不要更新一轮吧" and "先改一轮吧，改完也提交到mr 4756".
- MR: https://git.woa.com/wisp/mono2/-/merge_requests/4756.

## interface_refs / data_structure_refs
- `frontend/src/config/docs-sidebar.ts` and `frontend/scripts/sync-fumadocs-content.mjs` determine published international routes.
- Live `https://lightvela.ai/subscribe`, `/agents/skills/`, and `/agents/channels/` provide current UI evidence; billing authority remains the live checkout.

## history_context
- `current_design_refs`: `docs/context/domains/subscription-entitlements.md`, `docs/context/domains/site-environment-routing.md`, `frontend/AGENTS.md`.
- `relevant_evolution`: MR !4756 currently contains domestic third-batch documentation and is open at `5d0fe6ab2`.
- `superseded_refs`: none.

## acceptance
- Published international sources across existing locales agree on plan/credit/Skill/WhatsApp facts and current navigation.
- `pnpm docs:sync`, documentation checks, `pnpm check`, focused tests, and required frontend gates are reported with exact outcomes.
- Commit and push to MR !4756 source branch; remote source SHA and MR state verified.

## affected_paths
- `frontend/src/content/docs/{en,global,id,es,ja,ko}/` for selected published pages.
- `frontend/src/content/docs/{en,global,id,es,ja,ko}/use-cases/scheduled-task-*.md` for summary gate repair (16 sources; the other two `global` pages already had summaries).
- `wiki/growth-state/lightvela-docs-content-categories.md` for content status history.
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json` for the post-source-commit generated manifest sync.
- This Task Pack.

## required_context
- `subscription-entitlements`, `site-environment-routing`, `tapd-gongfeng-delivery`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/subscription-entitlements.md@939c01b03` | Credit and quota ownership | Avoid invented billing rules |
| `docs/context/domains/site-environment-routing.md@939c01b03` | International boundary | Keep domestic content unchanged |
| `docs/context/flows/tapd-gongfeng-delivery.md@939c01b03` | MR delivery | Verify remote evidence |
| `frontend/AGENTS.md@939c01b03` | Service gates | Run frontend checks |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@939c01b03` | Locale and generated docs neighbor | Inspect docs sync and locale output |
| `opencraft/AGENTS.md@3b62229f4` | Generated mono2 boundary | Use the official sync and drift check |
| `opencraft/MONO2_MIGRATION.md@3b62229f4` | Source and generated target ownership | Keep frontend as the only write source |
| `docs/context/project/upstream-subtrees.md@3b62229f4` | OpenCraft import boundary | Avoid copying or hand-editing generated files |

## evidence
- 2026-09-29 live international Subscribe shows Launch/Cruise with 100/200-credit low tiers, Launch AI/Cruise AI with 4500/10000-credit tiers, 5/10 Bots, and one-time additional credit packs.
- Live Skills supports marketplace search, installation, Skill Packages, and Installed tab; live Channels shows WhatsApp QR connection.
- `pnpm docs:sync` produced 513 docs; generated `zh-sg` and `zh-hant` Credits both include the four plan allocations and credit-pack rule. Generated output is not staged.
- Checked 525 relative links and image references across changed pages; zero unresolved after accounting for shared `frontend/src/content/docs/images/`.
- MR !4756 source `3b62229f49e5146efde3af66b9ab383b1323def8` failed the OpenCraft guard: the generated manifest recorded `00bb6f9db7f0627154a471526bc01867c5a2370d`; the guard expected the source commit. Translation warnings and MDX deprecation output were not the fatal error.
- After `npm --prefix opencraft run sync:mono2-agent-console`, the generated diff is exactly one `UPSTREAM.json.sourceRevision` line. No vendored source copy changed.

## risks
- Live prices and offers are dynamic: retain Subscribe/checkout as authority and avoid hard-coded promotional prices.
- Multi-Bot availability varies by runtime state: preserve rollout qualifiers unless independently verified.

## validation
- `cd frontend && pnpm docs:sync`: passed, 513 docs.
- `cd frontend && pnpm check`: passed, TypeScript 166 current / 171 baseline / 0 new; existing translation warnings only.
- `cd frontend && pnpm exec vitest run --config vitest.config.ts scripts/international-docs-parity.test.ts src/content/docs/__tests__/doc-summary.test.ts src/content/docs/__tests__/channel-consistency.test.ts src/content/docs/__tests__/automation-tab-order.test.ts --api.host 127.0.0.1`: 62/62 passed.
- `cd frontend && pnpm build:global`: passed, 614 static pages generated and SEO checks completed.
- Full Vitest suite was attempted with `--api.host 127.0.0.1`; many unrelated UI and model-config tests failed, then stopped after the focused docs failures were isolated and repaired. Full-suite success is unverified.
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`: passed with zero errors, warnings, and broken first-party links.
- `python3 .agents/context/scripts/validate_context.py --build-catalog`: passed; reverted generated catalog and font-subset noise afterward.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`: passed, no matched impact rules.
- `npm --prefix opencraft run check:mono2-agent-console`: reproduced the CI `sourceRevision` mismatch before sync; passed afterward, verifying 130 Agent Console files.

## decisions
- Scope is `global` because the user named lightvela.ai and international docs.
- Keep one Hermes instance distinct from the 5/10 Bots shown for plan variants.

## scan_scope
- Published international docs under `frontend/src/content/docs/{en,global,id,es,ja,ko}` and matching registration entries.

## scan_output
- Bounded `rg`, focused source reads, and `scripts/international-docs-parity.test.ts` identified and resolved locale structure drift. The first docs-summary test found 16 missing international task summaries, now repaired.

## handoff
- First-batch docs source is committed as `3b62229f4`. CI identified a generated OpenCraft manifest mismatch. The official sync and focused check passed locally; next commit the generated manifest repair and verify MR !4756 remote SHA and CI snapshot.

## checkpoint

### stage
First-batch source was delivered; CI repair is locally validated and awaits a follow-up commit.

### verified
- Six international source locales cover the first-batch pages; 16 scheduled-task summaries close the existing docs-summary test failure.
- `pnpm check`, international build, and 62 focused tests passed; generated docs/link checks passed.
- The CI failure is `UPSTREAM.json.sourceRevision` drift; the official sync changed only that field and the check now passes.

### unverified
- Remote MR SHA and CI state after the follow-up push.
- Full Vitest suite, which showed unrelated baseline failures and was interrupted.

### discard
- Earlier two-test international parity failure; Spanish quote and Japanese link parity have been fixed.
- Generated catalog and font subset build noise; both were restored to HEAD.

### restore
- Worktree `/Users/pablozhong/.codex/worktrees/cn-docs-batch-one/lightvela`, branch `codex/cn-docs-batch-three`, MR !4756.

### next_action
- Commit the generated manifest repair, push, and verify MR.
