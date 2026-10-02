## goal
Make a backticked Hermes `MEDIA:/.../*.md` reply open the existing Markdown preview in OpenCraft Web chat.

## non_goals
- Change Hermes output, file transport, Host permissions, or non-Markdown media behavior.
- Merge or publish this follow-up.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot in this task: backticked `MEDIA:/home/agentuser/国庆江西行作文.md` remains inert after MR !4887, while a backticked path without the prefix opens the preview.

## interface_refs / data_structure_refs
- `ChatDocumentNode` inline-code; `createInlineMarkdownFileRenderer`; `mediaMarkdownPath`; `ChatResourcePolicyService.resolve`; `ChatRenderContext.openResource`.

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.
- relevant_evolution: MR !4887 handled standalone plain-text `MEDIA:` but omitted inline-code `MEDIA:`; it is merged at `8c193ae8dbce62af0358fcd2b7d3f24047907d7f`.
- superseded_refs: prior Task Pack `docs/context/tasks/2026-10-01-media-markdown-preview.md` is history, not authority for this follow-up.

## acceptance
- Backticked `MEDIA:<explicit Markdown path>` clicks through the existing Host-scoped read-only panel.
- Normal backticked paths keep working; malformed paths, non-Markdown files, streaming content, and code inside explicit links stay inert.
- Focused test, relevant typechecks, Web build, browser smoke, documentation and change-impact checks pass.

## affected_paths
- `opencraft/packages/chat-render-web/src/renderers/resource-link/resource-link.tsx`
- `opencraft/tests/inline-markdown-file-preview.test.mjs`
- `opencraft/docs/chat-ui-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- Router packs: `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft`.

## context_receipt
| File | Reading reason | Use |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@HEAD` | Agent ownership | Renderer-local fix |
| `docs/context/domains/site-environment-routing.md@HEAD` | Domestic site boundary | Do not infer release |
| `docs/context/project/upstream-subtrees.md@HEAD` | OpenCraft source authority | mono2 only |
| `docs/context/project/services/opencraft.md@HEAD` | Service validation | Focused renderer checks |
| `opencraft/AGENTS.md@HEAD` | Service rules | Browser validation and Host scope |
| `opencraft/docs/chat-ui-architecture.md@HEAD` | Current chat behavior | Extend Markdown entry |
| `docs/engineering/domains/agent-gateway-runtime.md@HEAD` | Change-impact design | Record accepted form |

## evidence
- MR !4887 returned `state=merged`; the user's new screenshot shows a gray inline-code pill with `MEDIA:` prefix.
- Bounded exact search located `createInlineMarkdownFileRenderer` and the existing focused test.
- The nearest adjacency card is `frontend-runtime-openspec-i18n.md`; this change has no frontend/ locale/config dependency. The relevant neighboring test is `opencraft/tests/inline-markdown-file-preview.test.mjs`.
- Local compiler parsed backticked `MEDIA:/home/agentuser/国庆江西行作文.md` as `inline-code`; click resolved to the existing `file:///home/agentuser/国庆江西行作文.md` resource and opened the Host-scoped right panel.

## risks
- Treating arbitrary code as a file could create unsafe links. Require the existing explicit Markdown path pattern after removing only the recognized prefix; retain resource policy and Host read checks.

## validation
- `node --test tests/inline-markdown-file-preview.test.mjs` passed (1/1).
- `npm run typecheck --workspace @opencraft/chat-render-web` passed.
- `npm run typecheck --workspace @opencraft/workbench-web` passed.
- `npm run build:web` passed; Vite reported existing chunk and dynamic-import warnings.
- Headless Chrome render/click smoke using `WebChatDocument` passed with no page errors; temporary smoke fixture and script were removed after execution. Screenshot: `/tmp/opencraft-media-inline-preview.png`.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` passed; `agent-gateway-runtime` design mapping present.
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json` passed with no errors or warnings.
- `git diff --cached --check` passed.

## decisions
- Reuse the existing inline-code renderer and `mediaMarkdownPath`; no new component or transport. Owner: task implementation.

## scan_scope
- `opencraft/packages/chat-render-web/src`, `opencraft/tests/inline-markdown-file-preview.test.mjs`, mapped design docs.

## scan_output
- Bounded command outputs in task history.

## handoff
- Implementation, local Web verification and staged context gates complete; commit, push and new MR remain. Production status is unverified.
