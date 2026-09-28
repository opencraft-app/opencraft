## goal
Make Web/Electron chat image attachments visible as per-image thumbnails while composing and after send, with honest processing/failure states and a safe full-image viewer.

## non_goals
- No production cutover, commit, push, or native Expo attachment implementation.
- No new image-upload protocol or durable unsent-blob storage across a full page reload.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot in conversation: square thumbnails above composer text, per-image remove control, in-place processing indicator; user explicitly requested implementation after analysis.

## interface_refs / data_structure_refs
- `opencraft/packages/composer-core/src/model.ts`: `ComposerAttachment` and `ComposerDraft` identity/lifecycle.
- `opencraft/packages/codex-composer/src/codex-composer.tsx`: picker/paste/drop, current attachment row, submission.
- `opencraft/apps/workbench-web/src/runtime/browser-attachment-resolver.ts`: browser image conversion into AppServer input.
- `opencraft/apps/workbench-web/src/components/conversation/user-message.tsx`: sent-image row.
- `opencraft/packages/chat-core/src/builtin-projectors.ts`: AppServer history projection.

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`, `opencraft/docs/platform-architecture.md`, `opencraft/design/invariants.md`.
- `relevant_evolution`: Composer already owns attachment lifecycle; Web currently renders filename cards, and sent-image clicks use generic resource navigation.
- `superseded_refs`: `ref/bb` and `ref/paseo` are fixed read-only comparisons, not writing authorities.

## acceptance
- Selecting two images immediately shows independent thumbnails; removing one while processing cannot resurrect it.
- Processing/failed states are visible in place; unresolved images cannot be sent.
- Sent images remain visible after history projection and open a keyboard-accessible viewer without weakening link policy.
- Touch and desktop layouts, dark/light themes, and focus behavior are verified.

## affected_paths
- `opencraft/packages/codex-composer/`, `opencraft/apps/workbench-web/`, `opencraft/packages/chat-core/`, related tests and design docs.

## required_context
- `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft` (router returned broad OpenCraft matches).

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md` | Router must-read | Keep Agent/AppServer authority separate from UI |
| `docs/context/domains/site-environment-routing.md` | Router must-read | Avoid site/deployment inference |
| `docs/context/project/upstream-subtrees.md` | Router must-read | Mono2 remains sole write source |
| `docs/context/project/services/opencraft.md` | Router must-read | OpenCraft validation boundary |
| `opencraft/AGENTS.md` | Service instructions | Web/Native ownership and gate |
| `opencraft/docs/chat-ui-architecture.md` | Chat/Composer authority | Attachment staging and draft semantics |
| `opencraft/docs/platform-architecture.md` | Platform authority | View/Composer ownership |

## evidence
- Composer Controller now supports attachment lookup/update by owning Draft ID and a disposal callback; browser File/object URLs are owned by one Controller-scoped `AttachmentPreviewSession`.
- Web Composer renders independent image thumbnails with processing, failure/retry, and removal affordances. Sent user images open a focused modal viewer with previous/next and keyboard navigation.
- Browser resolver rejects unsupported image MIME before a draft becomes sendable. No AppServer protocol or native Expo path changed.

## risks
- Browser object URLs must be revoked without losing a retained draft's image.
- AppServer history may represent some images as `fileId`; display must not pretend unsupported media is available.
- Large base64 images can amplify memory; previews must not copy encoded input into a second global store.

## validation
- Focused Composer/preview/resolver tests: 32/32 passed after adding a WebP MIME/filename regression. Earlier full chat tests: 429/429; Workbench unit tests: 281/281.
- TypeScript checks previously passed for Composer Core, Codex Composer, Web Workbench, Workbench Runtime, Expo Workbench and Chat Core; the latest Composer check passed. The latest Web check is blocked by three TS2345 errors in a concurrent, unrelated `agent-activity-renderers.tsx` edit. Web and preview bridge builds passed; platform-boundary and i18n checks passed; `git diff --check` passed.
- Formal docs-impact and documentation validation passed. `npm run gate` unavailable because this shell has Node but no npm executable.
- Real mobile/desktop visual inspection remains unverified: no Chromium/Playwright in container. An isolated preview loaded, but the in-app browser reported `PREVIEW_BRIDGE_UNAVAILABLE` for DOM inspection and mobile screenshot support was unavailable. The preview process was stopped; running production service was not changed.

## decisions
- Reuse existing AppServer image input; UI processing indicator does not claim upload percentage.
- Keep browser-only preview resources out of serializable Composer state.

## scan_scope
- Bounded searches in OpenCraft Composer, Chat, Web runtime and fixed `ref/bb`/`ref/paseo` comparison paths.

## scan_output
- No bulk scan output.

## handoff
- Source implementation and automated validation are complete. Do not claim production cutover: no commit, push, publish or service replacement was performed.
- Before release, inspect light/dark and mobile/desktop layouts, picker/paste/drop, image failure/retry, sent-image viewer, and iPhone photo formats in a real browser. HEIC currently fails explicitly unless converted to a supported MIME upstream.
- Clear the unrelated Web type errors before treating the whole worktree as release-ready; do not bundle the concurrent Worked-for diagnosis into this image change by accident.
- Concurrent unrelated edits in the agent-gateway design doc, activity renderers and Worked-for task pack were preserved and must not be bundled unintentionally.
