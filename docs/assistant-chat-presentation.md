# Native channel conversation presentation

Native groups, human direct messages and personal-assistant conversations share
one reading surface: compact identity header, outgoing Human bubbles, incoming
content with stable identity avatars, sparse timestamps and a separate chat
switcher beside the compact composer. Incoming group messages retain sender names;
member management, bot mentions, native image delivery and reply attribution remain
channel capabilities. Long press or Shift+F10 exposes Reply; native text selection
remains available. Ordinary Human messages use the Human rendering dialect, not
assistant prose. Assistant activity appears only in its direct conversation.

## Owners

- Native channels own messages, cursors, replies, permissions and delivery. The
  existing per-channel view draft retains its composer, attachments, reply, loaded
  history window and sync cursor across route changes. This is an ephemeral view
  cache, not a second transcript authority. Authoritative snapshots replace it;
  denied access clears it. Failed or uncertain sends retain draft and attachments.
- `chat-render-web/message-timeline` adapts channel entries to the existing
  `timeline-virtualizer` and `timeline-host-web` primitives used by ordinary Chat.
  Stable message sequence keys identify layout entries, never execution Turns.
  The shared viewport controller alone writes scroll compensation. A checkpoint
  carries measured geometry and bottom-relative reading distance; prepending,
  appending and resize measurements reconcile through the shared anchor policy.
  The history control changes identity with the oldest message so it cannot steal
  the reading anchor from a prepended message. Measurement batches are coalesced
  before compensation to avoid ResizeObserver feedback loops.
- Only the visible range plus overscan mounts. The shared interaction-retention
  policy preserves focused/selected/expanded content, and an open message menu
  pins its source row until dismissal. The content range can temporarily widen
  while user work is retained. New messages follow only when already at the end;
  reading older messages preserves position. Read receipts require an active,
  visible viewport at the end, not merely a mounted conversation.
- The Shell owns route Header and registered ComposerActions regions. Connected
  and Hostless Shells inject the same action registry; plugins do not import an
  application component or require an execution-host provider.
- Composer owns the `message` presentation. Single-line input is compact, multiline
  text grows upward, dictation keeps its existing input lease and navigation stays
  at the trailing edge. Speech actions are capability-driven. Uploads appear only
  where the channel supports them. Sending a standalone image preserves unsent
  text and its quote. Read-only channels retain the chat switcher.
- Design-system tokens own dimensions/material/color and the shared progress
  indicator owns its indeterminate bar and reduced-motion behavior. Theme changes
  require no alternate conversation DOM. Menus have one owner per timeline.
- The existing assistant work repository owns tasks. Worker/Host project at most
  eight task summaries through the owner-only status response. Projection is
  read-only and exposes no credentials, execution state or raw error payloads.
  Freshness uses the five-second Host observation lease; failure/revocation or
  stalled observations remove activity. Presence never means task success.
  Directory loading does not wait on this optional observation.

## Verification

`scripts/smoke/execution/smoke-assistant-chat-design.ts` mounts the actual Workbench,
IM extension, communication authority, database and native channel transport. Only
identity admission and Host activity are fixtures; no model call is made. It covers
1160 light, 390 light/dark and 820 dark with coarse-pointer touch contexts,
compact/multiline composition, draft/editor/dock continuity, task detail, keyboard
and long-press Reply, group membership/mentions/reply delivery, expired observations
and a 240-message history with bounded mounting, prepend anchoring, route recovery
and new messages during older-history reading.

`scripts/smoke/execution/smoke-native-channels.ts` additionally covers actual group
creation, Human/Bot delivery, external-channel convergence, read state and native
image presentation. Shared timeline/layout and Web viewport tests cover measurement,
scroll ownership and interaction retention. Screenshots are actual product views;
this does not claim physical iPhone, WebKit or production-model acceptance.
