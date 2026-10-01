## goal
Make a completed Hermes `MEDIA:` reference to a Markdown file clickable in OpenCraft Web chat, using the existing Host-scoped right-panel preview.

## non_goals
- Change Hermes output, attachment transport, file permissions, or non-Markdown media rendering.
- Publish or deploy the change.

## requirement_ids / requirement_refs / requirement_excerpt
- User report and screenshots in this task: `MEDIA:/home/agentuser/国庆江西行作文.md` is plain text, while a backticked absolute `.md` path opens the preview.

## interface_refs / data_structure_refs
- `ChatDocumentNode` text and inline-code nodes; `ChatResourcePolicyService.resolve`; `ChatRenderContext.openResource`.
- Preserve Host permission checks and do not read files during rendering.

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.
- relevant_evolution: Existing inline Markdown path support and focused regression in `opencraft/tests/inline-markdown-file-preview.test.mjs`.
- superseded_refs: none.

## acceptance
- A completed standalone `MEDIA:<explicit .md path>` is clickable and opens the same Host-scoped right panel as an inline Markdown path.
- Streaming content, unrelated text, malformed/unsafe paths, and paths inside explicit links remain inert.
- Focused test, affected workspace typecheck, documentation validation, and change-impact check pass.

## affected_paths
- `opencraft/packages/chat-render-web/src/renderers/resource-link/resource-link.tsx`
- `opencraft/packages/chat-render-web/src/runtime.ts`
- `opencraft/tests/inline-markdown-file-preview.test.mjs`
- `opencraft/docs/chat-ui-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- Router query `OpenCraft embedded agent chat MEDIA markdown file preview` returned no pack; bounded exact search found the renderer and test. `opencraft/AGENTS.md` supplies service rules.

## context_receipt
| File | Reading reason | Use |
|---|---|---|
| `AGENTS.md@HEAD` | Repository boundaries | No production or secrets; required checks |
| `opencraft/AGENTS.md@HEAD` | Service validation | Web renderer and real preview boundary |
| `opencraft/docs/chat-ui-architecture.md@HEAD` | Current chat design | Extend existing Markdown preview rule |
| `docs/engineering/domains/agent-gateway-runtime.md@HEAD` | Change-impact design | Record behavior and Host scope |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@HEAD` | Maintenance method | Focused verification |

## evidence
- Screenshots show `MEDIA:` as plain text and a completed backticked absolute path opening the Markdown preview.
- Exact search: `rg -n 'MEDIA:|createInlineMarkdownFileRenderer|InlineMarkdownFileRenderer' opencraft frontend/src`.
- Local parser check confirms the screenshot's `MEDIA:` line becomes its own text node between line-break nodes.
- `node --test tests/inline-markdown-file-preview.test.mjs`: 1/1 passed, including click to current Bot panel, other Bot isolation, malformed input, and streaming state.
- `npm run typecheck --workspace @opencraft/chat-render-web` and `npm run typecheck --workspace @opencraft/workbench-web`: passed.
- `npm run build:web`, `npm run check:boundaries`, documentation validation, staged change-impact check, and `git diff --cached --check`: passed.
- Headless Chrome smoke with actual `WebChatDocument`: screenshot-format `MEDIA:` text became a file link, click emitted the expected `file:///` target, streaming text stayed inert, and no page errors occurred. Temporary fixture and smoke script were removed afterward.

## risks
- Treating arbitrary `MEDIA:` text as a file could create unsafe links. Require a standalone explicit Markdown path and apply existing resource policy; Host enforces read permission after click.

## validation
- `node --test tests/inline-markdown-file-preview.test.mjs`
- `npm run typecheck --workspace @opencraft/chat-render-web`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `git diff --check`

## decisions
- Reuse the current Web resource renderer and Host-scoped `openResource`; do not add attachment transport. Owner: task implementation.

## scan_scope
- `opencraft/packages/chat-render-web/src`, `opencraft/tests`, affected design docs.

## scan_output
- Bounded command output in task history; no scan artifact.

## handoff
- Implemented and verified locally on `codex/media-file-preview` in the isolated worktree; MR submission is authorized and underway. No merge, release, or production verification; the authenticated Host file read remains outside local synthetic smoke coverage.
