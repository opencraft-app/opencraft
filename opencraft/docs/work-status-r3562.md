# Worked for — Codex r3562 alignment

Reference root: `/data/mia/.runtime/lifecycle-authority-dead-contract-r3562`.

## Ownership

- AppServer session projection owns observations of Turn start, first work Item
  start, and the last assistant Item start. It prefers event/server clocks and
  samples the observation clock only when a live event has no timestamp. React
  mount time is never a work-start fact.
- Full completion snapshots own Item membership and content. Missing clock
  fields do not erase known clocks for the same IDs; obsolete Items must not be
  resurrected to preserve those clocks.
- `chat-core/work-status.ts` derives a renderer-neutral `worked-for` item. It
  does not mutate protocol state or run a timer. A sleep Turn has no interval.
  First observed work enables timing; Turn start is the preferred origin.
- A final-answer placeholder only closes work after it is displayable (text,
  explicit completion or structured output). The interval ends at assistant
  start, not at the end of final-answer streaming.
- `You stopped` additionally requires this client's interrupt intent. Remote
  interruption alone cannot claim the local user stopped the Turn.
- The shared React hook owns only a one-second display clock. It stops ticking
  for worked/stopped labels. Work facts survive UI unmount/remount unchanged.
- Activity partitioning extracts the work item for the outer disclosure. It is
  neither expanded work content nor a counted previous message in that region.
  Without partitioning, it is a standalone divider before live work / after
  settled work. The final answer stays outside Activity.
- Neither divider nor label registers as the latest answer's scroll-follow
  content. Existing viewport measurement/capture ownership remains intact.

## Presentation

`subagent-activity-chip-group-CC185tmV.js`: `ak/sk` (status clock), `ok`
(standalone divider), `gA/_A` (label priority and toggle), `fA/DA` (partitioning).

- Work item → duration fallback → previous-message count, in that order.
- `Working` under one second; then `Working for`; settled `Worked for`; local
  stop `You stopped after`. Duration uses floor seconds and narrow localized
  units, retaining nonzero seconds even in hour/day durations.
- Full-width default-border rule below the toggle, with 4px top spacing;
  standalone label/rule gap 8px; tabular status numerals.
- Standalone divider: opacity/height, 300ms, easing `[.19,1,.22,1]`.
- Outer expansion: opacity/8px translation, 220ms, `[.33,1,.68,1]`.
  Reduced motion suppresses movement. These are separate animation owners.
- Expo consumes the same model/partition/clock rather than a second outer
  summary with a mount-time `open` boolean. Its native animation implementation
  is typechecked, but was not pixel-tested on an iOS/Android device in this run.

## Missing history facts

An old history snapshot without work/final start timestamps cannot provide an
exact work interval. A renderable disclosure can use Codex's existing Turn
duration fallback. Hidden reasoning alone plus a duration does **not** create a
synthetic empty disclosure. No browser persistence or guessed final timestamp
was added to disguise missing provider data. Remount tests use retained facts;
they are not a claim that every upstream provider persists these new facts.

## Verification

- `scripts/compare-codex-work-status.ts`: executes actual original pure
  functions against our implementation: 176 interval cases, 110 localized
  duration cases, zero differences. This is not a full original-app pixel test.
- `tests/chat-work-status.test.ts`: eligibility, final readiness, partition
  ownership/count, stable identity, local stop, unknown history and formatting.
- `tests/appserver-session.test.ts`: clocks survive authoritative membership
  replacement; removed content stays removed; subsequent Turns are isolated.
- `tests/chat-runtime.test.ts`: replica facts survive fresh runtime creation.
- `scripts/smoke-work-status.ts`: real Web Activity renderer with deterministic
  Items, live clock, full-width visible rule beneath toggle, expand without
  duplication, frozen timing, snapshot remount, interval cleanup and local stop.
- Existing Conversation headless scroll regression passes. It reports two
  transient ResizeObserver warnings, not an idle loop.

No production deployment is part of this refactor.
