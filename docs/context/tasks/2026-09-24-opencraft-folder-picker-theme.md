## goal
Make the remote folder picker a reusable, theme-correct Workbench control whose confirm action stays legible in every supported appearance.

## non_goals
- Change the Server filesystem or Project RPC contract.
- Add a native macOS dialog to Web or redesign unrelated dialogs.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot and request, 2026-09-24: the enabled folder-picker confirm action appears as an unlabeled black rectangle; extract a folder picker and update AGENTS.md so the model supports themes.

## interface_refs / data_structure_refs
- `WorkspaceDirectoryPicker` takes `rootPath`, `initialPath`, `onReadDirectory`, `onChoose`, `onCancel`; the Application owns Project creation.
- `ModalSurface` owns focus, portal, scrim and window surface; shared `Button` owns semantic variants and states.
- Theme Engine supplies `--color-background-button-primary` and `--color-text-button-primary`.

## history_context
- `current_design_refs`: `opencraft/AGENTS.md`, `opencraft/docs/workbench-design-language.md`, `opencraft/design/invariants.md`.
- `relevant_evolution`: an earlier remote-directory change added a standalone TSX component but left its bespoke styles in `styles/app.scss` and used an undefined background token for primary-button text.
- `superseded_refs`: none.

## acceptance
- Enabled confirmation has legible text in light/dark themes and does not derive foreground from an unrelated surface token.
- Folder picker presentation styles live with the reusable component; footer buttons consume the shared Button primitive.
- Navigation, cancellation, loading, errors, focus and long paths remain usable.
- Focused checks, Web typecheck/build, and real browser computed-style/visual validation pass.
- AGENTS.md and the formal design state component/Host/Design-System ownership and theme verification rules.

## affected_paths
- `opencraft/apps/workbench-web/src/components/workspace-directory-picker.tsx`
- `opencraft/apps/workbench-web/src/components/workspace-directory-picker.scss`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/AGENTS.md`, design docs and focused tests.

## required_context
- Root Context Router returned no matching pack; OpenCraft local Agent and maintenance/design skills apply.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@working-tree` | Explicit user request | Ownership and theme constraints |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | Project maintenance method | Require real UI evidence |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | Validation matrix | Separate source, artifact and browser evidence |
| `/Users/skipzhang/.codex/skills/frontend-design/SKILL.md@local` | User-requested UI component quality | Apply deliberate contrast and interaction states |
| `/Users/skipzhang/.codex/skills/frontend-design/reference/color-and-contrast.md@local` | Theme verification | Require computed color pairs and contrast |
| `/Users/skipzhang/.codex/skills/frontend-design/reference/interaction-design.md@local` | Control states | Check focus, disabled, loading and error |
| `opencraft/design/README.md@working-tree` | Workbench design routing | Update the right invariant |
| `opencraft/design/invariants.md@working-tree` | Workspace presentation constraints | Add folder-picker contract |
| `opencraft/docs/workbench-design-language.md@working-tree` | Formal design authority | Define reusable control boundary |
| `docs/context/tasks/TASK-TEMPLATE.md@working-tree` | Task Pack contract | Track scope and evidence |

## evidence
- Live browser computed style on the enabled `Use folder` button: text `Use folder`, background `rgb(26, 28, 31)`, foreground `rgb(26, 28, 31)`, opacity 1.
- The local CSS set `background: var(--color-text)` and `color: var(--color-background-primary)`; the latter variable was unset, so the color declaration failed and inherited the dialog's dark foreground.
- Shared Button already exposes primary foreground `#ffffff` against the primary background `#1a1c1f` in that theme.
- Source tests passed 5/5, Workbench unit tests 280/280, Web release tests 10/10, Web typecheck/build and boundary check passed. The first build caught a mistaken camelCase typography role; hyphenated generated role was applied and rebuild passed.
- Native Linux archive SHA-256 `18ad590b9f16cf9e7e99d22ce37664e725bc49881d75ee21bbbba08b250736f5`, build ID `20260924112332-c232111388e7`; isolated package smoke passed. It was rebuilt atop the then-current remote source/build `20260924103545-79a7c75e1202`, not the older earlier deployment.
- The first UI version was deployed to the authorized test server and confirmed in a Mac browser: enabled primary button contrast 17.08:1 in Codex light, 17.76:1 in Codex dark, 12.21:1 in ZenCode dark; keyboard focus has a 2px outline and disabled state retains the label.
- Browser validation found a separate state bug: after `fs/readDirectory` returned permission denied, the confirm button remained enabled. Source now disables it on error, with a focused contract test and passing rebuild. This second change is **not deployed**: after its build the host accepted TCP but SSH timed out during banner exchange and HTTP 80 produced no first byte in 15 seconds.

## risks
- `app.scss` and AGENTS/design files are already dirty from other work; preserve unrelated edits.
- Refactoring the style block must not change Modal/Radix focus lifecycle or selected directory state.

## validation
- Typecheck and focused UI/contract checks, Web build, browser visual and computed-style checks across light/dark/disabled/loading/focus.

## decisions
- Retain the already separated `WorkspaceDirectoryPicker` behavior and its narrow callback contract; move only its presentation to a component-owned stylesheet and use shared primitives instead of adding another picker implementation.

## scan_scope
- Folder picker, Modal, shared Button, theme tokens, relevant Workbench style files and tests.

## scan_output
- Bounded exact searches; browser computed-style evidence above.

## handoff
- Core theme fix, reusable component styling, AGENTS and formal design updates are in source and the first UI fix is on the test server. The error-state correction remains local pending restored SSH/HTTP service; do not claim the running app includes it. No commit or push.
