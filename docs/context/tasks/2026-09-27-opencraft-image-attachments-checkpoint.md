## stage
Source implementation complete; awaiting real-browser visual acceptance and any separately authorized release.

## verified
- Controller-scoped preview resources survive Composer remount and target switch; removed or cleared attachments cannot be restored by late jobs.
- Focused attachment tests 32/32, earlier chat tests 429/429, and earlier Workbench unit tests 281/281 passed.
- Composer TypeScript, Web build, boundary and i18n checks, docs-impact, documentation validation, and diff whitespace checks passed. Web TypeScript previously passed but currently reports three TS2345 errors in concurrent unrelated Worked-for tracing edits.
- No commit, push, deployment or running-service replacement occurred.

## unverified
- Real iPhone/touch and desktop browser appearance, dark/light presentation, and picker/paste/drop interaction. Isolated preview could load, but its DOM inspection lacked Preview Bridge and mobile screenshots were unavailable.
- `npm run gate` is unavailable in this shell because npm is not installed; the available constituent checks above were run directly.
- Native Expo attachment UX and durable unsent File storage across full page reload are outside this task.

## discard
- Earlier assumption that image upload jobs may be tied to the React editor mount; they now follow the Controller/Draft owner.
- Browser tab inspection attempt that did not return; it is not acceptance evidence.

## restore
- Main implementation: `opencraft/packages/codex-composer/src/attachment-preview-session.ts`, `codex-composer.tsx`, `opencraft/packages/composer-core/src/store.ts`, Web user-message/resolver/styles.
- Task Pack: `docs/context/tasks/2026-09-27-opencraft-image-attachments.md`.
- Preserve concurrent unrelated changes in `docs/engineering/domains/agent-gateway-runtime.md`, the activity renderers, and Worked-for task pack.

## next_action
- Run real-browser mobile and desktop acceptance on an isolated preview before any release request.
