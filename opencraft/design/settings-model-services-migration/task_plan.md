# Settings Model Services Migration Plan

## Goal

Move local model services into Settings and remove the Environment application surface while preserving the local model configuration capability and runtime ownership.

## Non-goals

- Do not remove local model/provider storage, credentials, discovery, or DSH adapter behavior.
- Do not change production, publish, commit, or push.
- Do not redesign unrelated Settings sections.

## Phases

- [complete] Load repository context and map current navigation/routes/owners.
- [complete] Specify the target Settings information architecture and migration invariants.
- [complete] Implement navigation and route removal with focused tests.
- [complete] Run service gates and verify the real desktop surface.
- [complete] Retire the task pack and hand off evidence.

## Decisions

- “整体删除环境界面” means remove its product-facing navigation/routes/views, not delete the underlying Host/environment runtime required by chat.
- “本机模型服务放到设置” means Settings becomes the single user-facing owner of the local model-services entry.

## Errors

- Focused typecheck attempt 1 failed before compilation because this worktree has no `opencraft/node_modules` and therefore no `tsc`. Resolution: use the already-installed dependency tree from the main checkout without modifying package manifests or locks.
- Test replacement patch attempt 1 failed because `apply_patch` rejects Delete+Add operations targeting the same file in one patch. Resolution: perform the deletion and addition as two explicit patches.
- Focused typecheck attempt 2 reached compilation through the shared root dependency tree. Extension Contract and Built-in Agents passed; Workbench Web was blocked by missing `@types/react-dom` declarations in the borrowed dependency layout, with errors only in pre-existing React DOM consumers. Resolution: inspect and mirror the main checkout's workspace-level dependency layout rather than editing manifests.
- Model Services smoke attempt 1 failed before the UI opened because this worktree lacks `runtime/dsh/node_modules`. Resolution: reuse the main checkout's pinned DSH runtime dependency directory, then rerun the same synthetic/local test.
- Full gate attempt 1 stopped during Expo typecheck because the borrowed root dependency tree does not include Expo's workspace-local packages (`expo-router`, `expo-status-bar`, `react-native-safe-area-context`). Resolution: mirror the main checkout's Expo workspace dependency directory and rerun the full gate.
- Desktop preview attempt 1 exposed verification contamination: borrowed npm workspace symlinks resolved package imports to the main checkout, proven by the stale `Local Agent` group label. Resolution: remove only the temporary symlinks created in this task, install ignored dependencies locally without updating lockfiles, and rerun all gates/builds.
- Local dependency install attempt 1 used `--package-lock=false` and began resolving current registry peer versions rather than reproducing the repository lock; it was deliberately interrupted before completion. Resolution: use `npm ci --ignore-scripts` against the existing root and DSH lockfiles.
- Worktree-local full gate attempt 1 passed 150/151 AppServer tests but failed the pre-existing macOS process-RPC replacement case with `{ code: -32603, message: 'posix_spawnp failed.' }`. Resolution: inspect and run the exact test in isolation before deciding whether the full gate needs a platform workaround or another clean run.
- The isolated process-RPC test reproduces the same `posix_spawnp failed` before any changed Settings/navigation path. This is a known macOS environment-specific launch issue and is outside this UI task; retain it as an explicit gate exception and run every remaining gate stage separately.
- PTY environment repair attempt 1 (`npm rebuild node-pty`) did not restore the packaged helper's executable bit, so the isolated test still failed. Resolution: apply the known-good executable permission to the byte-identical worktree dependency file and retest.

## Final Evidence

- Focused tests: 27/27.
- Full current-worktree `npm run gate`: passed.
- Model Services and shared Sidebar browser smokes: passed with isolated/synthetic data.
- Electron renderer/host build, isolated mac-arm64 package and strict codesign verification: passed.
- Live packaged window: Environment action count 0; Settings group `本机`; one selected `模型服务` entry; provider directory visible.
