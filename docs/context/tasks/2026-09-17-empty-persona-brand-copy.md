## goal
On the international site's no-Bot `/agents/persona/` view, remove the outline around the LightVela brand and use natural AI-companion copy, without changing `/agents` or populated Agent pages.

## non_goals
- Do not change creation behavior, global navigation, other translations, or account menus.
- Do not merge or deploy; the user subsequently authorized MR delivery after local review.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot and request in this conversation (2026-09-17); no external issue ID. Keep the logo, remove only its surrounding frame in the blank creation state, preserve `/agents`, and replace “partner” with polished “companion” language.

## interface_refs / data_structure_refs
- `AgentsPageClient` renders the shared brand header immediately before `AgentSettingsPage` in the authenticated route.
- `/agents/persona` resolves to `sectionId: "buddy"`; `/agents` defaults to `"channel"`.
- The no-Bot view uses `!isModifying && !passesLoading && !isCreating && !botsLoading && visibleBots.length === 0`.

## history_context
- `current_design_refs`: `frontend/DESIGN.md`, `frontend/openspec/spec.md` international-first-party-copy expectations.
- `relevant_evolution`: Existing shared desktop header draws the right and bottom borders; these must remain on normal Agent routes.
- `superseded_refs`: none.

## acceptance
- No brand-area frame in the loaded no-Bot `/agents/persona/` view, with the LightVela logo intact.
- `/agents` and populated persona retain their existing header style.
- English prompt reads “Create your own AI companion”.
- Focused tests, frontend check, and international build pass; local preview remains on port 5174 for review.
- The OpenCraft Agent Console closure contains the revised English dictionary and passes `check:mono2-agent-console` from the final committed frontend source.

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/styles.css`
- `frontend/src/i18n/generated/en-US.json`
- `frontend/src/pages/marketing/__tests__/agent-settings-empty-persona.test.ts`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/` (mechanically generated closure and `UPSTREAM.json`)
- `docs/engineering/domains/agent-gateway-runtime.md` (mapped sync contract)
- This Task Pack and its checkpoint.

## required_context
- `site-environment-routing`, `frontend-product-surface`.

## context_receipt
| File | Reason | Usage |
|---|---|---|
| `AGENTS.md@3165aca5a` | Repository constraints | Task Pack and scoped validation |
| `frontend/AGENTS.md@3165aca5a` | Service checks | Focused test, check, build |
| `frontend/DESIGN.md@3165aca5a` | UI design | Keep existing header except empty state |
| `docs/context/domains/site-environment-routing.md@3165aca5a` | Routed domain | International preview scope |
| `docs/context/project/services/frontend.md@3165aca5a` | Routed service | Frontend ownership |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@3165aca5a` | Adjacency | Inspect route, test, generated translation chain |
| `docs/context/project/services/opencraft.md@e62ce4e18` | OpenCraft service boundary | Generate the complete compatibility closure, not a hand-picked dictionary |
| `docs/context/project/upstream-subtrees.md@e62ce4e18` | Source ownership | Keep mono2 as the sole write source |
| `docs/context/domains/agent-gateway-runtime.md@e62ce4e18` | Runtime context | Verify the shared Agent Console dependency boundary |
| `opencraft/AGENTS.md@e62ce4e18` | Closest service rules | Run closure check and OpenCraft gate |
| `opencraft/MONO2_MIGRATION.md@e62ce4e18` | Generation contract | Keep revision and generated copy together |

## evidence
- `/agents/persona` maps to `buddy` in `agent-routes.ts`; `/agents` uses default `channel` in `AgentSettingsPage`.
- `AgentsPageClient` places the header before the page root, so an adjacent-sibling scoped CSS selector can select only the flagged no-Bot page.
- English translation updated through `scripts/i18n-apply.mjs` for the existing Chinese source.
- Focused Vitest passed 3 files / 27 tests; `pnpm check` passed with 0 new TypeScript diagnostics; `pnpm build:global` generated 649 static pages; documentation validation exited 0 with 0 broken first-party links and 0 warnings.
- After the global build stopped the previous dev listener, `pnpm dev:global:proxy` was restarted from this worktree. `curl` returned HTTP 200 for `http://127.0.0.1:5174/agents/persona/`; `/auth/session/` returned expected anonymous 401. Chrome was refreshed successfully to the local login gate. User's screenshot of the production-domain attempt showed Whistle forwarding to unused port 5173, while 5174 is listening.
- Follow-up auth diagnosis: a redacted local OAuth start request returned Google `redirect_uri` host `api.lightvela.ai`, but the `lc_google_oauth_state` cookie is host-only on `127.0.0.1`. The browser cannot send that state cookie to the callback host, consistent with the repeated `google_state_mismatch`. The prior advice to sign in directly from localhost was incorrect. Authenticated preview requires a same-origin production-host mapping to 5174 with direct API requests, pending user approval for the local Whistle rule change.
- MR !4166 CR correction in an isolated clean worktree: before regeneration, `check:mono2-agent-console` failed on an existing missing `domain/credit-pack.ts` dependency and the copied English prompt remained the old “partner” wording. `sync:mono2-agent-console` regenerated all 129 closure files from source commit `e62ce4e18`; subsequent check passed and both source and copy now say “Create your own AI companion”.

## risks
- The shared header appears on several routes: require both persona route and loaded no-Bot state before the CSS override.
- Local authentication may prevent a live no-Bot screenshot; do not fabricate a session or claim visual verification if blocked.
- MR !4154 independently changed the same generated dictionary and merged as `5fb403d0a` after the first !4166 CR push. The !4166 branch must therefore combine both sources and regenerate the closure before it can be merged.

## validation
- Passed: focused Vitest (27/27), `pnpm check` (0 new TypeScript diagnostics), `pnpm build:global` (649 pages), documentation validation, `git diff --check`, and live route HTTP 200 / Chrome login-gate smoke check.
- CR correction: OpenCraft closure check passed after generation (129 files); staged change-impact and documentation checks, workspace typechecks, extension tests (153/153 and 56/56), and Web build passed. Full OpenCraft gate stopped at `test:appserver` (152/153): the unchanged process-RPC WebSocket replacement test fails with `posix_spawnp failed`, also reproduced in isolation. Later gate stages were not run.
- Pending: authenticated visual check of the no-Bot page. The current localhost+local-proxy flow cannot complete Google OAuth because its state cookie and callback use different hosts. Do not infer authentication from the anonymous login gate.

## decisions
- Keep “Create your own AI companion”: concise, idiomatic, and aligned with the intended relationship; omit redundant “cloud” and “now” from the prompt.
- Preserve shared header markup; use `:has(+ .lv-agent-empty-persona-page)` only when the immediately following page signals the empty persona state.

## scan_scope
- `frontend/next-site/agents-page-client.tsx`, `frontend/src/lib/agent-routes.ts`, `frontend/src/pages/marketing/agent-settings-page.tsx`, `frontend/src/styles.css`, `frontend/src/components/site/public-site-header.tsx`, i18n script/dictionary, and nearby tests.

## scan_output
- Bounded `rg` identified the route, prompt, header CSS, and tests; no scan artifact saved.

## handoff
- The user subsequently approved the Chrome/Whistle local preview on 5174 and authorized initial MR delivery. The user separately authorized committing and pushing this CR correction to !4166. !4154 has since merged into master; !4166 must pick up that already-merged Soul copy to resolve the generated-file conflict, without independently reimplementing it. No MR merge or release is authorized.
