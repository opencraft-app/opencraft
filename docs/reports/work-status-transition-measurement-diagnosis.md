# Working → Worked: measurement authority diagnosis

2026-09-08. Initially diagnosis only; the subsequent implementation is recorded below.

## What was compared

`scripts/diagnose-work-status-completion.ts` drives real Activity and
Conversation rendering through work → final and late-final-at-completion changes.
It records the status node identity, label/row geometry, scroll height, response
spacer position and motion transforms for 30 RAF samples.

`WORK_OBSERVER_ONLY=1` removes only the eager latest-Turn measurement effect
in a test-server transform. Production source remains untouched.

## Findings

1. Pure label changes in the same disclosure do not move vertically in the
   tested cases. Divider entrance and Activity expansion are different
   lifecycles from a work-clock label update.
2. Work divider → disclosure can replace the label node. Partitioning moves the work item into the outer header; node replacement alone
   is not proof of an ownership bug or permission to ban this presentation.
3. The renderer eagerly measures the latest row on every `latestTurn` change in
   `virtualized-conversation-turns.tsx`. During collapse/migration, this can
   capture an outgoing AnimatePresence subtree plus the new tree, then commit
   that transient sum as virtual-list geometry. A later observer corrects it.
## Causal isolation

Long late-final transition, with the same production Markdown renderer:

| Host | scrollHeight before / first changed sample / settled |
| --- | --- |
| the downstream product | 2193 / 4252 / 2187 |
| the downstream product, eager latest measurement disabled in test | 2193 / 2193 / 2187 |

At the bad sample the visible row is already 2059px high, but total scroll
height still includes the outgoing 2065px region. The label's top jumps from
-1493 to -3548 and back to -1483. The exact sampled frame index varies with real
browser scheduling; these runs are not a shared-clock frame-parity test.

In the short work → final case the row is 123px, but the next spacer position is
192px for one sample: the outgoing 69px region was retained in virtual geometry.

## Ownership implications

- A new semantic Turn object is not authority to measure a transitional DOM tree.
- Animation/presentation staging and authoritative virtual-list geometry are
  separate lifecycles. A transaction can be internally consistent yet wrong if
  it was started by the wrong trigger at the wrong boundary.
- Measurement policy and opt-in keys must be explicit, beyond the
  list/controller APIs or the order inside a measurement transaction.
- Regression coverage must include subtree replacement/collapse with actual
  Activity presentation. Pure duration tests and growing fixed text rows missed
  this transition.

## Limits and remaining details

The reported live session's exact event stream has not been captured. The local
reproduction establishes a concrete matching class of defect, not that every
perceived downward motion in production has this one cause.

## Implementation follow-up

On explicit approval, removed the unconditional latest-Turn layout-effect
measurement from `virtualized-conversation-turns.tsx`. Both production policies
now use no per-update synchronous
measurement key. There is no new fallback flag, compensating offset, timer,
status animation override, or global RAF delay.

New-row pre-paint measurement, row-observer transactions, explicit renderer
measurement requests and target-positioning measurements remain separate
supported triggers. Removing the eager path does not remove those owners.

The diagnostic's temporary `WORK_OBSERVER_ONLY` source transform was removed.
It now tests production code directly and asserts that late-final transitions
cannot double-count outgoing content or move the reading position outside the
before/after bounds. `WORK_TRANSITION_ONLY=1`
selects five work/final/collapse scenarios; the default also tests missing clocks.

The status label, divider entrance and Activity expansion animation parameters
were not changed to conceal the measurement defect. Typography
verification remains outside this correction. No deployment is implied.

Verification after the correction: 126 focused unit tests and Web typecheck
passed; five status-transition cases passed. The production-renderer
scroll fixture covered 143 event boundaries. Real scroll smoke,
continuous submissions, history fill in both policies and the work-status
label/disclosure smoke passed, with zero reported ResizeObserver warnings in
the scroll regressions.

## Follow-up: remaining presentation verification

The user still reports that the transition does not feel like an in-place
update. The fixture above cannot disprove that report: it uses controlled
Activity inputs and CSS. It establishes the corrected
measurement boundary, not the live session's presentation.

The second browser audit adds a DOM Range over the label text. In the short
divider-to-header case, the element box changes from top 0 / height 22 to top
4 / height 16, but the text bounds change from top 3 / height 16 to top 4 /
height 16. The previously noted 4px element-box difference is therefore **not
a measured 4px glyph movement**. Actual text movement is 1px in this fixture.
The header appears without a sampled translate animation. In the long,
bottom-aligned late-final fixture the settled row also shrinks 6px; text moves
7px in viewport coordinates (6px row relocation plus the 1px local change).
These fixture results do not identify the user's remaining production effect.
