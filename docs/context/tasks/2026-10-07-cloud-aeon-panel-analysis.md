---
id: task-2026-10-07-cloud-aeon-panel-analysis
type: task
scope: CloudAeonComputerPanel original-source ownership and presentation investigation.
triggers:
  - cloud aeon source analysis
  - rich desktop reference comparison
  - original desktop ownership island
owner: opencraft-maintainers
authority: derived
source_of_truth:
  - opencraft/plugins/cloud-desktop/src/index.tsx
  - opencraft/plugins/cloud-desktop/src/controller.ts
status: retired
reviewed_at: 2026-10-07
review_due: 2026-11-07
revision: 1.0.1
precedence: task
derived: true
---

## goal
Identify the original rich desktop panel matching the user's screenshots and assess transferable ownership, geometry and motion. Read-only product investigation.

## non_goals
- No implementation, deployment, restart, commit, remote input or environment recreation.
- Do not claim the supplied macOS application was executed or infer current account rollout.

## requirement_refs / requirement_excerpt
- Current conversation: deeply inspect `CloudAeonComputerPanel` after confirming both rich and simple desktop modules exist.

## interface_refs / data_structure_refs
- Original intake: `/data/codex-new/codex-26.930.31428-12913`, version 26.930.31428 / build 12913.
- `unpacked/webview/assets/panel-88a634a92643.js`: export `CloudAeonComputerPanel`; compiled `Dt/Ot/At/wt/ct/Pe` wrappers, presentation and media lifecycle.
- `unpacked/webview/assets/panel-b0cf1fefeb66.css`: matched `v2pom` media geometry and `1qsav` ownership island classes.
- `unpacked/webview/assets/app-initial-970035cbb6b0.js`: real lazy import; compiled `epc/tpc/npc/rpc` conversation presentation service, container attachments and parking node.
- Connection identity includes account/user, displayed conversation, connection thread and environment. Requested control is distinct from acknowledged control; changing presentation is distinct from changing connection identity.

## history_context
- Current design: `opencraft/docs/cloud-desktop-plugin.md`, plugin controller and media contracts.
- `2026-10-06-desktop-visual-review.md` compared the real simple `CloudDesktopPanel` module, not this rich entry. Its geometry measurements do not establish parity with the newer user-provided rich screenshots.

## acceptance
- Verify original export, actual lazy import, matching CSS, media confirmation and presentation lifecycle.
- Identify migration boundary without changing product state or treating screenshots as runtime authorization evidence.

## affected_paths
- This diagnostic record only.

## required_context / context_receipt
- Read root `AGENTS.md`, `opencraft/AGENTS.md`, maintenance `SKILL.md`, task template and `adjacency/frontend-runtime-openspec-i18n.md`.
- Read original intake README for version and analysis limitations; original module and matching CSS, original app initializer bounded excerpts; current plugin presentation, control action and controller; neighboring `tests/fixtures/cloud-desktop-panel-ui.tsx`.
- Router query `opencraft CloudAeonComputerPanel cloud desktop ownership presentation analysis` returned no match. Bounded search in `plugins/cloud-desktop/src` and exact original module paths followed.

## evidence
- Rich module is explicitly lazy-imported as `CloudAeonComputerPanel` in original app initializer, not merely present in a manifest.
- Conversation presentation service chooses expanded attachment before compact attachment; moves the same container with `moveBefore` when possible (otherwise append), parks it in a hidden inert node when needed, and renders a single portal. It does not imply every cross-parent DOM move is focus-preserving.
- Root key separates displayed conversation and connection thread; media key includes environment and identity. Environment or connection identity replacement is not just a CSS change.
- Expanded geometry reserves a second control row and centers an aspect-fit frame using container width/height units. Controls are positioned at frame `top:100%`; compact is inert, hides expanded controls and uses cover rather than contain.
- Confirmed appearance requires streaming plus controlling. Observe surface pointerdown requests control. MODE_CHANGE enables key/mouse sources only with current request intent and open data channel; a late grant without intent is switched back to observe. Blur, data closure and disposal clear input sources.
- Pending control is aria-busy; normal status/button visually yield after 200ms to an avatar and animated dots. Original pending button is disabled; our cancellable pending semantics should not be removed merely for visual parity.
- Observe island is separated by translateY(8px); confirmed control translates to zero and reveals masked bottom visor shoulders. Visor wash is 420ms; two-sided perimeter trace is 320ms after 50ms; release trace 240ms. Wide container >=48rem uses 23px surface radius and 6.75px masked ring; smaller geometry uses 11.628px radius and 4px ring. Reduced-motion handles transitions/animations explicitly.
- Accent is an assistant appearance projection with paired background/foreground, not a protocol or hardcoded global purple. Visible ownership text must not falsely assert an agent owns input when our backend contract only proves local observing.
- Last-frame snapshots retain environment identity and aspect ratio; video events capture at most once per five seconds and cleanup captures before teardown. Snapshot helper bounds largest edge to 1280 and produces JPEG .85 with asynchronous version fencing. It is a preview, not a live or authorized input surface.

## risks
- Do not bind canvas dimensions to a CSS frame using a second scaling owner; current media adapter must expose authoritative dimensions or actual media bounds before rich framing.
- Cached frame is potentially sensitive and must be scoped, cleared and never represented as current live state.
- Our controller's user-gesture focus and late-grant fencing remain authoritative; do not copy reference confirmation-time focus stealing.
- Product environment provisioning, TBO endpoints, handoff, agent avatar and USB passkey flow are not generic desktop dependencies.

## validation
- Static source comparison and neighboring fixture inspection only; no runtime parity, browser or iPhone acceptance claimed. No product files changed, so no build/test completion claimed.

## decisions
- Migration candidate: aspect-fit media card + ownership island/visor, deriving appearance from existing controller state and view eligibility; theme/motion tokens remain design-system-owned.
- Keep generic cloud desktop independent from Vela backend provisioning and agent identity. Implement visual composition separately from transport and authorized input.

## scan_scope / scan_output
- Exact original intake modules and current cloud desktop plugin plus one neighboring UI fixture; no broad source recovery or external network scan.

## handoff
- Analysis complete. Implementation requires a separate user request. Source, build and live preview are unchanged by this task; only this diagnostic record was added.

## post_delivery_gap_review
- User requested another read-only comparison after rich preview delivery. Router query `opencraft rich desktop reference comparison CloudAeonComputerPanel visual gap` returned no match. Exact source/CSS comparison and neighboring real panel fixture inspection followed; maintenance skill and root/local AGENTS read. Running build remains `20261007-rich-desktop-5b9f70ea2`; no preview switch or behavior edits in this review.
- Confirmed remaining control geometry differences: original status is intrinsic `min-w-0 truncate`, floating island has no 241px minimum (visor alone does); ours fixes status width/flex basis to 140px and applies 241px minimum to both presentations. Auxiliary paste/keyboard buttons additionally enlarge our island; their capabilities must not be removed merely to match screenshots.
- Confirmed shoulder differences: original narrow left path is 17×24, right 17×25, top 1.42969px, with measured asymmetric curves. Wide left uses 16px width/top -1px and right top -1.5px. Ours uses symmetric approximate paths and top -1px at both breakpoints. This is an actual remaining join geometry discrepancy, not a control authority issue.
- Confirmed shadow transition difference: original crossfades two fixed shadow pseudo layers over 240ms; ours interpolates a box-shadow property. End states largely match but intermediate frames do not.
- Original uses body 14/20 regular with tracking -.14px; ours body role is also 14/20 regular but does not apply the evidenced tracking. Button original variable weight 590 vs our standardized 600 is intentional typography normalization, not a new arbitrary local weight candidate.
- Original pending presentation hides both text and action and shows animated assistant avatar plus centered dots; ours intentionally keeps cancellation available and uses left-aligned dots without assistant avatar. Generic contract has no assistant identity authority; do not invent it or imply the agent currently controls the desktop.
- Original computer appearance comes from assistant appearance color resolver; ours uses theme accent/paired foreground. Screenshot-purple parity is not established by hardcoding purple. OS wallpaper/browser/Dock are media content, outside panel styling ownership.
- Static reference analysis only; original macOS runtime and side-by-side pixel parity are not verified. Prior delivery browser evidence proves product component behavior, not exact reference rendering. Most valuable refinements are intrinsic stable control layout, exact breakpoint-specific shoulders, and layered shadow crossfade; no new service or backend protocol is needed.

## remaining_gaps_after_refinement_delivery
- Read-only review requested after live build `20261007-rich-refinement-5b9f70ea2`. Maintenance skill read; router `opencraft rich desktop remaining visual lifecycle gaps` unmatched. Exact rich module, appearance resolver, current controller/contract/rendering and neighboring Shell fixture inspected. No implementation or preview mutation.
- Loading/restoration: original expanded frame uses identity-scoped last-frame preview plus aspect ratio, with image loading overlay opacity/visibility transition; compact uses cover. Current plugin has a solid feedback layer and connection-only optional ratio, no snapshot contract/cache. Cached image must remain explicitly non-live/non-interactive and clear on identity replacement; not just add a screenshot to CSS.
- Requesting: original hides text and action after 200ms and rises/swims an assistant avatar with centered dots. Current presentation omits avatar and preserves a cancel action and left-aligned dots. Difference is partly missing presentation, partly deliberate lifecycle/product contract; do not remove cancellation or invent assistant identity.
- Presentation: reference expanded/compact variants and conversation presentation service relocate one container. Current generic plugin has ordinary Shell panel activity and resident keep-mounted handling, but no compact cover preview variant. Keeping media alive is already present; compact placement would require Shell-owned slot semantics, not a duplicate viewer/controller.
- Appearance: reference appearance resolver maps assistant colors to submit background/foreground pairs. Current shared primitive uses application accent pair; color matching is not automatically guaranteed even if geometry matches. Remote wallpaper/browser/Dock remain transmitted content, not panel styling.
- Auxiliary keyboard/paste controls and 44px coarse targets are intentional product/platform differences. Minor typography tracking -.14px and reference variable font weight590 vs standardized600 remain; priority lower than loading continuity. No claim of official reference runtime pixel parity.
- Suggested next bounded improvement: same-identity last-frame preview with preserved aspect ratio and a live-media crossfade. Pure first-load artwork can improve empty presentation independently, but must not masquerade as a live desktop.
