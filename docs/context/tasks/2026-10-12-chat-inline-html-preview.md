## goal
Clicking an explicit HTML file path in Chat inline code opens a rendered, read-only page preview in the existing right-side panel.

## non_goals
- Run scripts or load external subresources from the HTML preview.
- Change `MEDIA:` resource syntax, file authorization, downloads, or deployment.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot and follow-up in this task: `/home/agentuser/.hermes/cron/output/wage_report_2026-10-10.html` should be clickable for right-panel preview.

## interface_refs / data_structure_refs
- `createInlineMarkdownFileRenderer` delegates recognized paths to `ChatResourcePolicyService.resolve()` and Host `openResource()`.
- The Host-owned right panel reads file bytes and presents `.html` in a sandboxed iframe by default, with a source switch; rendering a message must not read the file.

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`; `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: merged MR !5183 made explicit `MEDIA:` resources type-independent; bare inline paths still recognized only Markdown extensions.
- `superseded_refs`: none.

## acceptance
- The screenshot's backticked HTML path becomes a `file:` resource link and clicking opens the current Bot's right panel.
- `.htm` works; bare filenames, commands, streaming output, and nested explicit links keep existing behavior.
- HTML preview renders self-contained layout and inline styles, offers source view, and remains subject to Host file access.

## affected_paths
- `opencraft/packages/chat-render-web/src/renderers/resource-link/resource-link.tsx`
- `opencraft/tests/inline-markdown-file-preview.test.mjs`
- `opencraft/apps/workbench-web/src/panels/workspace-resource-panel.tsx`
- `opencraft/apps/workbench-web/src/panels/workspace-resource-model.ts`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/workbench-resource-readonly.test.mjs`
- `opencraft/tests/workbench-workspace-resource.test.ts`
- `opencraft/scripts/smoke-workspace-media.ts`
- `opencraft/tests/fixtures/workspace-media-preview.tsx`
- `opencraft/design/invariants.md`
- `opencraft/docs/chat-ui-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- Renderer query initially returned no matching Pack; bounded search found `explicitMarkdownPath` and its test. The follow-up panel query matched `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, and `service-opencraft`.
- Change-impact mapping: `agent-gateway-runtime`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| Root `AGENTS.md` (user-provided) | Repo boundaries | Scope and verification gates |
| `opencraft/AGENTS.md@8c46dd35d` | Service boundaries | Host ownership and preview validation |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@8c46dd35d` | OpenCraft workflow | Minimal behavioral change and real UI evidence |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@8c46dd35d` | Focused checks | Renderer test and preview validation |
| `opencraft/docs/chat-ui-architecture.md@8c46dd35d` | Current design | Update bare-path behavior |
| `docs/engineering/domains/agent-gateway-runtime.md@8c46dd35d` | Mapped formal design | Update domestic Chat contract |
| `docs/context/domains/agent-gateway-runtime.md@8c46dd35d` | Routed domain | Keep Host file authority |
| `docs/context/domains/site-environment-routing.md@8c46dd35d` | Routed domain | Distinguish local build from site delivery |
| `docs/context/project/upstream-subtrees.md@8c46dd35d` | Routed project | Mono2 is the OpenCraft source |
| `docs/context/project/services/opencraft.md@8c46dd35d` | Routed service | Panel and shared renderer boundaries |
| `opencraft/design/README.md@8c46dd35d` and `opencraft/design/invariants.md@8c46dd35d` | Workspace presentation | Update preview behavior |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@8c46dd35d` | Closest site adjacency card | No frontend config or locale path changed |

## evidence
- `node --test tests/inline-markdown-file-preview.test.mjs`: passed; the screenshot HTML path resolves to a `file:` link and clicking opens the Bot-scoped right panel.
- `node --test tests/workbench-resource-readonly.test.mjs`: 3/3 passed, including HTML iframe and Preview/Source switching.
- `npx tsx --test tests/workbench-workspace-resource.test.ts`: 5/5 passed.
- `npm run typecheck --workspace @opencraft/chat-render-web` and `npm run check:boundaries`: passed.
- `npm run build:embedded-workbench:release`: passed; build artifact remains local and ignored.
- `validate_documentation.py --repo . --format json`: zero broken first-party links or warnings.
- `npm run typecheck --workspace @opencraft/workbench-web`: passed after installing the shared collaboration package's local dependencies in the isolated checkout.
- `npx tsx scripts/smoke-workspace-media.ts` with the bundled Playwright module and local Chrome executable: real headless Chromium passed; the inline HTML link opened a styled page in the right panel, Source/Preview switched, and scripts/external subresources stayed blocked. Screenshot saved outside the repository.

## risks
- HTML content is untrusted. The iframe has an opaque sandbox origin and a restrictive content policy; scripts and external subresources are blocked. The existing Host resource policy retains file-read authority.

## validation
- `node --test tests/inline-markdown-file-preview.test.mjs` in `opencraft/`.
- `npm run typecheck --workspace @opencraft/chat-render-web` and `npm run check:boundaries` (this workspace has no lint script).
- `npm run typecheck --workspace @opencraft/workbench-web` and panel tests.
- Documentation and staged change-impact validation; `git diff --check`.
- `npm run build:embedded-workbench:release`.
- Real Chromium media fixture plus synthetic renderer click; authenticated customer Host access remains a separate check.

## decisions
- Extend only bare inline document paths to `.html` and `.htm`; `MEDIA:` already covers arbitrary file types.
- Default to static rendered HTML in an isolated iframe; keep the Source switch. Do not execute arbitrary report scripts in the Workbench.

## scan_scope
- `opencraft/packages/chat-render-web/src/renderers/resource-link/`, `opencraft/apps/workbench-web/src/panels/`, adjacent tests and mapped design documents.

## scan_output
- Exact search `explicitMarkdownPath` located the sole recognition rule and its focused test. No repository-wide scan used.

## handoff
- Local implementation and validation complete; no commit, MR, or deployment requested for this new change.
