# Hermes projection follow-ups

User requested recording these issues for a subsequent fix (2026-09-08).

## Implemented locally (2026-09-08, not published)

- Streamed segment identity now survives display completion at a tool boundary.
  `message.interim(already_streamed=true)` reconciles the same Item, including
  authoritative non-prefix corrections and repeated interim notifications.
  Empty interim events are inert; new streams retain independent identity even
  when their text is identical. Legacy final-prefix cleanup cannot cross a tool.
- Tool updates merge with the existing tool Item. Missing fields no longer reset
  name or arguments. Context, summary, progress, inline diff and structured result
  survive translation. Hermes tools expose expandable input/output/diff details
  and source-authored contextual subtitles instead of only a generic tool name.
- `item/updated` is a Vela adapter notification extension, not a standard Codex
  notification. Payload is `{threadId, turnId, item: {id, type, ...fields}}`.
  It patches that Item without starting/completing it or resetting lifecycle
  timestamps. Omitted fields are retained. `item/started` and `item/completed`
  remain the lifecycle owners. The Hermes bridge currently emits its merged
  snapshot; the session projector also accepts partial updates.
- Verification: 182 targeted tests passed, including the translation -> timeline
  -> tool-presentation path and session notification patching. Web and Expo type
  checks passed. Node plugin tests use a temporary CSS/SCSS import stub because
  they exercise protocol behavior, not browser layout.

Scope: controlled protocol regression tests, not a captured production trace or
browser visual acceptance. Older Hermes versions may omit display metadata;
arguments/results remain available without fabricating richer descriptions.

## Original findings

## Duplicate interim text

The production state machine reproducibly creates two distinct commentary Items
for `message.delta(text) -> tool.start -> message.interim(text, already_streamed=true)`.
Repeated interim events also create separate Items. These are controlled input
sequences, not a captured trace of the user's screenshot. Preserve segment
identity across display completion and authoritative reconciliation; do not
globally deduplicate equal text. Confirm actual wire order before choosing the
precise boundary rule.

## Tool presentation loses source information

Local Hermes reference `tui_gateway/server.py` emits tool.start context/args,
tool.complete summary/result/duration_s/optional inline_diff, and optional
verbose args_text/result_text. The Vela toolItem mapper preserves name, args,
JSON-stringified result, duration and basic status but drops display context,
summary and inline diff. Validate which fields the deployed Hermes advertises
and actually sends; local latest source is not proof of production capability.

progressTool reconstructs an entire Item from a partial payload, so absent name
or args can overwrite known values with defaults. It updates internal state
without publishing an item-update notification. This requires a protocol-aware
patch model, not longer UI labels. Keep generic fallback for unknown tools and
preserve original structured results. Do not infer execution success or tool
purpose from invented descriptive copy.
