# Shared reading plane and Composer dock

User goal: See's main chat, side chat and empty tool pane must share a continuous
material, including the area below the Composer. Correct ownership rather than
adding a theme-specific cover strip. Main and side chat already share Conversation
and OpenCraftComposer; their hosts must not impose conflicting paint ownership.

Implementation:
- Shell owns the spatial canvas; main and tool pane consume material-reading-background.
- Conversation owns a stable dock beside its reading scrollport. Desktop clips the
  scrollport before the Composer's lower corners; touch retains a floating gutter.
- The existing viewport owner's footer observer publishes a normal-flow reservation.
  No duplicate ResizeObserver, React geometry state or restoration policy.
- A shared inline offset moves transcript and dock without translating scrollbar chrome.
- Browser/terminal content keeps its own content surface. No palette or feature-specific override.

Validation (source 2026-11-10):
- Web typecheck passed.
- Six focused viewport-owner checks passed.
- Actual AppShell, main Conversation/OpenCraftComposer and SideChat plugin with
  synthetic histories: desktop 1600 and touch 390, See light/dark, theme switch
  retaining the editor/draft, fixed dock during scroll, input growth, empty pane.
- High-contrast transcript probe verifies desktop lower-gutter clipping versus
  touch floating paint. Main touch editor exercised with tap and text input.
- Existing top-inset/history/delayed-measurement smoke passed both scroll policies,
  including narrow/wide layouts and a taller footer retaining the last answer.
- Screenshots reviewed in .local/reading-material; no physical device claim.

Known baseline failures: full conversation-scroll smoke fails its direct final-answer
streaming start assertion at line 283 on both unchanged HEAD 9f37a983 and this change.
The broader workbench-timeline-host suite has six unrelated source-shape failures
(Settings, Composer callbacks, panel animation); those assertion targets are unchanged.
Focused checks and actual-component coverage above pass. These are not reported as
full-suite success. Evidence copied to /data/build/artifacts/reading-plane.
