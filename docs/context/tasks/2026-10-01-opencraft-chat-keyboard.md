## goal

Keep the embedded OpenCraft iOS Chat composer visible when the on-screen keyboard opens, using measured geometry across iPhone and iPad layouts.

## non_goals

- Change the shared Chat domain model, transport, or Bot DOM pages.
- Publish an app build or change the shared Chat domain and Bot DOM pages.

## requirement_ids / requirement_refs / requirement_excerpt

- 本会话用户：「paseo的建模你看看，现在我们输入框触屏键盘会遮挡，但是又不能hardcode，需要考量pad 和 ipad」。
- 真机截图反馈：输入卡片底边与键盘上沿贴合，圆角及操作区视觉上被压住。
- 用户继续要求建模级修复，避免只补视觉间距而留下动画与状态差异。

## interface_refs / data_structure_refs

- `WorkbenchFrameShared` owns the absolute native composer and conversation scroll padding.
- `KeyboardEvent.endCoordinates`, `Keyboard.metrics()` and `View.measureInWindow()` provide screen rectangles; `react-native-safe-area-context` supplies the bottom inset. Expo Go includes the SDK 57 compatible `react-native-keyboard-controller` 1.21.9 for native keyboard progress.
- `mobile-chat-keyboard-geometry.ts` derives displacement from viewport/keyboard intersection, capped to the measured viewport.
- `mobile-chat-keyboard-layout.ios.ts` owns keyboard phase, iOS native Animated progress, layout reservation and editing capacity. Web/Android keep their existing adapter.

## history_context

- `current_design_refs`: `opencraft/docs/mobile-shell.md`, `opencraft/docs/chat-ui-architecture.md`.
- `relevant_evolution`: iOS Bot Chat recently switched to the shared OpenCraft RN Workbench inside a persistent native Bot host; its absolute composer was under a `KeyboardAvoidingView` in the embedded layout.
- `reference`: read-only `/data/mono2/ref/paseo` at `3cc4ae2` uses a keyboard provider, keyboard animation and measured composer capacity; this task borrows the geometry ownership, not its fixed iOS accessory offset.

## acceptance

- Opening the iOS keyboard leaves the Chat composer above it and preserves access to the latest conversation content.
- Composer movement follows native keyboard progress; closing keeps scroll reservation until native keyboard dismissal ends.
- A floating iPad keyboard moves the composer only when the two intersect; hardware keyboard does not displace it.
- Android tablets retain `resize` window mode, with no second keyboard translation.
- Rotation, Split View and Stage Manager use current container dimensions, with no device-specific keyboard height.
- Expo typecheck, focused geometry tests and iOS bundle pass.

## affected_paths

- `opencraft/apps/workbench-expo/src/components/workbench-frame.shared.tsx`
- `opencraft/apps/workbench-expo/src/components/mobile-opencraft-chat.ios.tsx`
- `opencraft/apps/workbench-expo/src/components/mobile-bot-host.ios.tsx`
- `opencraft/apps/workbench-expo/src/runtime/mobile-chat-keyboard-geometry.ts`
- `opencraft/apps/workbench-expo/src/runtime/mobile-chat-keyboard-layout.ios.ts` and platform fallback
- `opencraft/apps/workbench-expo/src/components/native-account-layout.ios.tsx`
- `opencraft/apps/workbench-expo/package.json`, `opencraft/package-lock.json`
- `opencraft/apps/workbench-expo/app.json`
- `opencraft/tests/mobile-chat-keyboard-geometry.test.mjs`
- `opencraft/docs/mobile-shell.md`
- `opencraft/apps/workbench-expo/AGENTS.md`

## required_context

- Root Context Router matched frontend product surface due layout terms; `docs/context/project/services/frontend.md` was read, but this change is owned by OpenCraft Expo.

## context_receipt

| File | Reason | Use |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md`, `opencraft/apps/workbench-expo/AGENTS.md` | Repository and Expo boundaries | Scope and verification |
| `docs/context/project/services/frontend.md` | Context Router must-read | Confirmed frontend is outside edit scope |
| `opencraft/docs/mobile-shell.md`, `opencraft/docs/chat-ui-architecture.md` | Current design | Preserve native Chat and safe-area ownership |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `opencraft/.agents/skills/opencraft-expo-cf-preview/SKILL.md` | Maintenance and preview workflows | Focused checks and light preview verification |
| `/data/mono2/ref/paseo/packages/app/src/app/_layout.tsx`, `/data/mono2/ref/paseo/packages/app/src/keyboard/shift/internal/provider.ts`, `/data/mono2/ref/paseo/packages/app/src/composer/dock/index.native.tsx` | Reference keyboard model | Compare ownership and capacity |

## evidence

- Focused geometry and keyboard phase tests: 10/10 passed, including docked/floating iPad keyboards, compact-window editor and whole-composer capacity, native close reservation, floating reposition and hardware-keyboard accessory filtering.
- Expo typecheck passed.
- Final iOS bundle passed with the native Animated adapter (4757 modules).
- Final Android bundle passed (4852 modules) after the whole-composer capacity change, explicitly retaining the system `resize` model.
- Metro restarted after the dependency install; iOS manifest and bundle origin passed the lightweight check on the existing Quick Tunnel. The bundle was not downloaded for link verification.
- `git diff --check` and `validate_change_impact.py --repo . --staged` passed; the latter evaluated the repository's pre-existing staged set.

## risks

- iPhone/iPad real keyboard animation remains unverified without a physical device; focused tests cover geometry, not UIKit timing.

## validation

- `node --import tsx --test tests/mobile-chat-keyboard-geometry.test.mjs` (10/10)
- `npm run typecheck --workspace @opencraft/workbench-expo`
- `npm run bundle:ios --workspace @opencraft/workbench-expo`
- Lightweight Expo Go manifest check; no full bundle download.

## decisions

- The embedded native Chat measures keyboard overlap and uses one keyboard phase owner. iOS native Animated follows the provider's keyboard progress as in Paseo; the measured target preserves iPad floating-keyboard geometry instead of assuming a full-width docked keyboard.
- Keep a theme-token gap between the composer card and the keyboard; a zero-pixel boundary causes the two rounded surfaces to visually merge on iPhone. Apply this gap to both movement and capacity.
- Keep the existing `KeyboardAvoidingView` for the standalone Workbench; the embedded layout owns its composer displacement.
- Bound the entire composer in a compact docked keyboard viewport, then let the text editor shrink inside it. A floating keyboard keeps the normal card capacity.
- Android uses the Expo-supported `softwareKeyboardLayoutMode: resize`; the iOS per-frame shift is not layered over Android's resized viewport.

## scan_scope

- `opencraft/apps/workbench-expo/src/components/`, `opencraft/apps/workbench-expo/src/runtime/`, bounded Paseo keyboard/composer source.

## scan_output

- Bounded source inspection only; no generated scan artifact.

## handoff

- Source, build and preview checks are complete. Real iPhone/iPad keyboard timing and focus remain to be checked on device. No commit, push or publication.
