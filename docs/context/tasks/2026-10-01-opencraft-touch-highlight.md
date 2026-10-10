## Goal

Remove Safari's rectangular touch flash from OpenCraft Web controls so pressed feedback is owned by the app.

## Scope and non-goals

- Apply the Web renderer style to all elements, including controls inside the embedded workbench shadow root.
- Preserve existing `:active` and `:focus-visible` treatments, button semantics, and disclosure behavior.
- Do not restart, publish, or alter the running preview.

## Context receipt

- `AGENTS.md`, `opencraft/AGENTS.md`: repository and UI ownership rules.
- `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` and `references/verification.md`: UI maintenance and evidence boundaries.
- `opencraft/apps/workbench-web/src/styles/app.scss` and `components/overlay-disclosure-trigger.tsx`: actual Web style and transparent hit target.
- `opencraft/tests/workbench-overlay-disclosure-trigger.test.ts`: focused regression coverage.

## Acceptance and verification

- iOS system tap highlight is disabled at the Web renderer style root.
- Existing keyboard focus style remains intact.
- Focused test, Web typecheck, and Web build pass; real iPhone appearance remains a separate check.

## Result

- Added `-webkit-tap-highlight-color: transparent` to the Web renderer's universal style rule. This also covers the embedded workbench's shadow-root stylesheet.
- Focused disclosure tests: 5/5 passed. Web workspace typecheck and Vite build passed.
- The running preview was not replaced; iPhone visual verification is pending on a new preview.
