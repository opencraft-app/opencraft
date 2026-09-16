---
id: 2026-09-16-opencraft-bot-avatar-runtime-checkpoint
type: task
scope: Completion checkpoint for the OpenCraft Bot avatar runtime upgrade.
triggers: ["Bot avatar runtime checkpoint"]
owner: skipzhang
authority: task
status: completed
reviewed_at: 2026-09-16
review_due: 2026-10-16
revision: 1.0.0
precedence: task
derived: true
---

## stage

Implementation and scoped acceptance complete; source remains uncommitted in the shared dirty worktree.

## verified

- Stage-owned shared scheduler with active/attentive/ambient/hidden rates.
- Parked logical clocks, fixed-step springs, deterministic behavior and waking handoff.
- OpenCraft-owned 48-point identity geometry, current-frame interpolation and shape-fitted eyes.
- Fourteen bounded `reset → enter → hold → exit → done` effects and five-particle reactions.
- Stable theme-aware identity material, dark mode, reduced motion and offscreen freeze.
- Bot Chat typecheck, 390 chat tests, boundaries, Web production build, browser smoke, documentation and change-impact checks.

## unverified

- Full workspace typecheck remains blocked by the unrelated existing Hermes timer typing errors recorded in the Task Pack.
- No Electron packaged-window acceptance was required; browser rendering exercises the same React/SVG renderer.

## discard

- Graphify output and per-instance RAF design.
- Reference-derived geometry and old CSS effect keyframes.

## restore

- Task Pack: `docs/context/tasks/2026-09-16-opencraft-bot-avatar-runtime.md`.
- Formal design: `opencraft/docs/bot-chat-motion-ownership.md`.
- Browser evidence: `/tmp/opencraft-bot-avatar-runtime/`.

## next_action

- None for implementation. Commit/release only after separate user authorization and review of the shared dirty worktree.
