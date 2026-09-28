## goal
Allow an iPhone camera HEIC/HEIF photo selected in the Web Composer to become a sendable JPEG attachment, while preserving the existing Draft-owned preview, retry and cancellation lifecycle.

## non_goals
- No server-side HEIC transcoding, Expo picker changes, archival preservation of HEIC originals or service rollout without separate authorization.

## requirement_ids / requirement_refs / requirement_excerpt
- User report, 2026-09-27: iPhone camera photos show retry overlays while screenshots work; screenshot supplied in the conversation. No external ticket ID.

## interface_refs / data_structure_refs
- `ImageProcessingService.compress` returns `ImageResult`; HEIC-to-JPEG is a compatibility transcode, not optional size optimisation.
- `resolveBrowserAttachment` admits only inline transport MIME types PNG/JPEG/WebP/GIF and must cap bytes after conversion.
- `AttachmentPreviewSession` owns the original `File`, object URL and retry job by Draft/attachment identity.

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`, `opencraft/packages/image-processing/README.md`, `docs/engineering/journeys/agent-request-streaming.md`.
- `relevant_evolution`: image thumbnail/retry presentation and headless release at `b5ded3114`/`3a3cf80cb`; HEIC remained an unsupported pass-through in image processing.
- `superseded_refs`: none.

## acceptance
- A supported browser decode path converts HEIC/HEIF to JPEG with matching name, MIME, size and data URL, even when JPEG is larger than the original.
- If conversion is unavailable, the attachment stays failed/retryable with a specific error; no unsupported HEIC bytes are submitted.
- Empty browser MIME plus `.heic`/`.heif` still enters image preview/processing.
- Original and converted bytes are bounded before base64; remove/abort cannot publish a late conversion.

## affected_paths
- `opencraft/packages/image-processing/`, `opencraft/apps/workbench-web/src/runtime/browser-attachment-resolver.ts`, `opencraft/packages/codex-composer/src/attachment-preview-session.ts`, corresponding tests and architecture docs.

## required_context
- Root Context router returned no matching pack; bounded exact search in the OpenCraft image/attachment paths followed.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | Root authority | Task Pack, validation and authorization boundary |
| `opencraft/AGENTS.md` | Service authority | Ownership and cross-platform checks |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Maintenance method | Preserve draft and failure lifecycle |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Verification route | Focused model, browser and runtime evidence |
| `opencraft/docs/chat-ui-architecture.md` | Current chat design | Preview and resolver ownership |
| `opencraft/docs/platform-architecture.md` | Platform boundary | Web-only image adapter |
| `opencraft/packages/image-processing/README.md` | Codec policy | HEIC previously passed through |

## evidence
- Screenshot: camera photo thumbnails show retry overlays; screenshots do not.
- Source trace: HEIC was preserved by the worker while resolver rejected its MIME before ready state.
- `npm run gate` passed after implementation (before the final 50 MP HEIC bound adjustment).
- Final focused 22 tests and image-processing typecheck passed after the 50 MP adjustment. Web and Composer typechecks passed before that adjustment and their source was unchanged afterward.
- Browser smoke could not start: this machine has no `playwright` package or Chromium executable; the scripted build completed before the missing-module error.
- Actual iPhone HEIC file and Safari/WebKit acceptance are not yet available. The HEIC decode branch was exercised with a DOM/canvas test double, not a native HEIC codec.

## risks
- Browser-specific HEIC decode/canvas behavior needs an original iPhone file and Safari acceptance; unsupported browsers fail closed.
- Re-encoding can change metadata and color appearance; original selected File remains owned by the Draft for retry.
- Large JPEG derivative must be rejected before base64 allocation.

## validation
- `node --import tsx --test tests/image-processing.test.ts tests/workbench-attachment-resolver.test.ts tests/codex-composer-attachment-preview.test.ts`
- Typecheck image-processing, codex-composer, workbench-web; browser smoke if available; full `npm run gate` for cross-package change.
- Real iPhone camera HEIC selection/send remains separate client acceptance.

## decisions
- Use the browser's image decode/canvas path only for HEIC/HEIF, keep ordinary PNG/JPEG worker processing and one-job service admission.
- Preserve larger JPEG only when the result is a successful HEIC compatibility transcode; reject unsupported original if conversion fails.

## scan_scope
- Bounded `rg` in OpenCraft image-processing, Composer, Web runtime and test paths.

## scan_output
- No separate scan artifact; exact results are summarized in evidence.

## handoff
- Source implementation and verification are complete at the code level; no commit, push or running Web update authorized by this bug report alone. Await an original failed HEIC for real-device acceptance and explicit release direction.

## checkpoint
### stage
- Code fix staged for review; next gate is original HEIC/iPhone WebKit acceptance and release authorization.
### verified
- HEIC was formerly passed through and rejected by the inline resolver; the new path produces JPEG and preserves the original Draft-owned File.
- Full gate, focused tests, typechecks and docs impact validation passed as recorded above.
### unverified
- Native iPhone HEIC decode/canvas behavior, color/orientation and live Web send with a real photo.
### discard
- The failed generic-Web headless release is unrelated to this HEIC source fix; the current server still runs the prior released code.
### restore
- Preserve unrelated dirty worktree changes in activity renderers and `agent-gateway-runtime.md`; only the explicitly staged HEIC paths belong to this task.
### next_action
- Test one original iPhone HEIC through the staged Web source, then ask for commit/push/release confirmation before changing the live server.
