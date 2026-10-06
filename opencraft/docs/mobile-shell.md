# iOS mobile shell

## Ownership

`apps/workbench-expo/src/runtime/mobile-shell-model.ts` owns the semantic surface:
`agents`, native `account`, first-party `account-web`, or `billing`. Gesture
progress, drag cancellation, safe-area geometry and animation belong to the
native navigation surface and iOS mobile drawer. A WebView route change
may update only an already open first-party web surface; a late page event must
not replace the Bot or native account surface.

LightVela mobile accents and drawer geometry live in
`apps/workbench-expo/src/runtime/mobile-visual-tokens.ts`, layered over shared
OpenCraft native tokens. Keep visual choices there instead of scattering
sampled colors or fixed phone widths through feature components.
Native account editors keep the local draft, confirmed server name, cooldown
and pending request ID in `mobile-account-editor-model.ts`. A background profile
refresh updates an untouched field but leaves an edited draft alone; stale
request results cannot replace the current form state. Field validation and
account operations remain in `@opencraft/mobile-account-sdk`.

The Bot WebView and drawer remain mounted behind account surfaces. Opening
Account from an open drawer does not close the drawer. Back from a web account
or billing page returns to native Account; dismissing native Account reveals
the original drawer. Do not use a new WebView or re-created Bot tree as a
transition animation. The native navigation surface measures its current
container, respects safe areas and reduced motion, and lets button Back and
right swipe complete through the same dismissal path.

## Presentation boundary

### Adaptive containers

`runtime/mobile-shell-layout.ts` derives presentation from each mounted
container's measured width and the centralized `mobile-visual-tokens.shell`
metrics. It does not own navigation, Bot selection, Thread or Draft identity.
An iPad in a narrow window uses the same drawer as a phone. Once the container
can fit the sidebar and minimum content width, navigation docks alongside the
content. The user can hide/reopen the docked sidebar. Selecting a feature,
creating or deleting a Bot dismisses only an overlay drawer, never the docked
sidebar. Compact drawer progress and the wide sidebar visibility preference
are independent; switching width does not overwrite either intent.

The same navigation and scene children stay in the same React positions across
resize. Docking changes scene bounds; it does not key or reparent the Bot
WebView, Chat runtime, conversation, Composer or account editor. Chat chooses
its inner conversation-sidebar layout from its own measured width after the
outer Bot sidebar has taken its space, not from the application window width.
Viewport remeasurement rejects older callbacks so keyboard overlap uses the
current screen rectangle.

Account presentation has its own capacity rule: adequate width presents a
centered, bounded panel with a scrim and safe outer spacing; narrow containers
present the existing full page. The account body, first-party account WebView
and native controls stay mounted when moving between Account, account-web and
billing. Back from a subpage returns to Account, then to the original Bot
surface and navigation state. Entry changes invalidate old animation completion
callbacks; geometry changes do not create navigation entries or restart entrance
animation. Nested settings pages remain inside their parent surface. A panel
does not add the full-screen safe-area inset again inside its content.

Dismissal distance is measured to the host container's right edge from the
surface's resting left edge. A centered panel moving only by its own width
still leaves its outer margin visible and must not be released at that point.
Gesture release continues from the current progress with the release velocity;
button Back uses the same UI-thread completion, starting with zero velocity.
Use one clamped spring for completion/return, not a fixed-duration animation
that restarts easing after the drag. At completed exit the surface and its
shadow leave no visible pixels; only then may the current entry callback hide
or release it. Navigation is not switched at the swipe threshold.

Pure geometry and transition tests cover capacity and return contracts. They
do not prove WKWebView continuity, keyboard coordinates, gesture smoothness or
iPad behavior. Check those in Expo on portrait/landscape, narrow multitasking
windows, continuous resize, floating keyboards and hardware keyboards.

The drawer and account controls are native. Use HeroUI Native components and
`@opencraft/design-system/tokens.native` by default. The installed HeroUI
Native version does not export a drawer container; the iOS drawer uses a local
Gesture Handler and Reanimated container, with HeroUI controls inside it. Do
not describe this as a HeroUI drawer or bring in Unistyles.
The closed Bot drawer accepts a deliberate right swipe from roughly 90% of the
main surface width. Its horizontal activation distance is larger than a small
touch wobble, while the gesture handler lets vertical scrolling fail the drawer
pan. Keep this width relative to the current container so phone, iPad, and
folding layouts share the same behavior. The drawer has one UI-thread progress
value. A new horizontal gesture can interrupt opening or closing, cancel the
old animation and continue from the rendered progress. An already vertical
WebView touch stays with scrolling; a fresh touch is eligible for horizontal
arbitration even while WebView scroll momentum is ending. Relate WebView's
native gesture to the drawer pan without remounting the WebView. Keep the
drawer behind account navigation and preserve its progress while account is
visible.
Bot settings pages are the existing `frontend/` components built into the local
DOM runtime; the shell does not reimplement those screens. Bot Chat is the
OpenCraft RN Workbench, connected to the selected Bot instance and Profile;
its conversation model is shared with the OpenCraft Web Chat renderer.
The packaged Bot HTML is read once during iOS shell startup and reused when
the authenticated Bot surface mounts. The first embedded section is Overview,
so its data work can begin as soon as the Bot session is ready. The native
drawer presents creation as a primary card and each Bot with its profile avatar,
name and lifecycle status; frontend still owns creation, deletion and profile
metadata. Cached Bot content stays mounted when account surfaces open.
The drawer begins with the Bot group heading and its close action in one row;
it does not reserve a separate brand-title header above the list.
For Chat, the native composer owns the bottom safe-area inset so its surface
continues through the Home Indicator region. The Bot host applies bottom
padding only to the other embedded feature pages; do not add both insets.
The embedded iOS Chat owns a stationary measured viewport. One keyboard model
holds the current screen frame through the native closing animation, derives
composer overlap and editing capacity, and reserves matching scroll space for
the conversation. `react-native-keyboard-controller` supplies per-frame iOS
keyboard progress to translate the composer; the measured geometry supplies
the target, including a theme spacing gap above the keyboard. The shell must
not also resize Chat with a second keyboard-avoiding layer. iPhone, iPad
floating and external keyboards, Split View and Stage Manager use the current
container and keyboard rectangles rather than device-specific heights.
Android keeps the system `resize` keyboard mode: its measured window shrinks,
so the same absolute composer follows the new container bottom without a
second translation. Do not apply the iOS keyboard shift on top of Android's
window resize.
Real-name, complete
account management, and subscription/payment remain first-party web routes.
During initial language and session restoration, the login surface remains in
place with its primary action disabled. Do not insert a separate branded
loading page between Expo startup and the authenticated workbench.

## Focused checks

Exercise: open drawer → Account → Back; open drawer → Account → full account →
Back; Account → Subscription management → Back; rapidly switch Bot sections;
reload the Bot runtime; rotate or resize the container while a surface is
visible. Observe that the drawer selection, scroll, Bot state, safe-area fill
and status bar stay stable. The pure transition tests guard late web events;
they do not substitute for checking an Expo runtime after visual changes.
For gesture changes, additionally open → immediately close before the spring
settles, close → immediately reopen, drag vertically in the Bot WebView →
continue sideways without lifting, then lift → immediately swipe sideways
during scroll momentum. Check a WebView horizontal control separately.
