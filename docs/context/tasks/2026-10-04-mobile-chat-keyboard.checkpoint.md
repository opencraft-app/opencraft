## stage
Local implementation and service validation complete; handoff pending.

## verified
- Domestic mobile Chat uses the OpenCraft embedded workbench, whose composer follows its host height.
- The host Chat page previously used `100dvh` and clipped overflow while the iOS visual viewport can shrink or pan with the keyboard.
- The host now follows the visual viewport bottom; focused tests passed 8/8, `pnpm check` and `pnpm build:cn` passed.
- Build-generated font and `next-env.d.ts` changes were restored; the main checkout was not edited.

## unverified
- Physical iOS or WeChat keyboard behavior on the user's device.

## discard
- The temporary Vitest `127.0.0.1` binding was removed after testing.

## restore
- Worktree: `/Users/pablozhong/.codex/worktrees/mobile-chat-keyboard/lightvela` at base `f3db0e91f0093b9331954964764d518c0ccdd8c2`.
- Task Pack: `docs/context/tasks/2026-10-04-mobile-chat-keyboard.md`.

## next_action
- Submit the authorized MR for the keyboard fix and mobile composer height change; report the physical iOS keyboard check as pending.
