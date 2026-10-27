# Progress

## 2026-09-16

- Fresh worktree created from `origin/master` at `08b9cf56804cc4f4080284bc3680322094c4f54c`; before handoff it fast-forwarded without conflict to `1e1a8b181e654fa56862cdd75f6739059d899249`. The two incoming commits only changed collaboration CI files, with zero OpenCraft overlap.
- Current-master source and formal context re-read; no implementation copied wholesale from the stale branch.
- Current master had a one-line Hermes diagnostics type regression: the panel required the already-existing streamed command port but the main-Bot adapter omitted it. Added the same account-owned stream port with the existing diagnostics timeout; this is recorded separately from reasoning behavior.
- Current-master UI smoke passed: GLM 5.3 shows only Light/High/Max, defaults High, selecting Max writes `effort=max`, and no page errors. Evidence: `/tmp/opencraft-hermes-reasoning-ui-Wioi2r`.
- Final `npm run gate` passed after `prepare:dsh-runtime`, including all workspace types/tests and Web/Expo Web/iOS builds.
- Electron build passed. Independent arm64 preview packaged at `release/hermes-reasoning-current-master/mac-arm64/OpenCraft Preview.app`; strict deep codesign verification passed.
- Packaged preview opened with isolated profile `<home>/.opencraft/preview-hermes-reasoning-current-master` on CDP 19846; Composer and model trigger are mounted.
- No real model inference, credential read, commit, push, or release performed.
