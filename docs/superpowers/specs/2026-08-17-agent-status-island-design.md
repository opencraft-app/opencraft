# Agent status island design

## Goal

Agent lifecycle feedback must not occupy the management document flow. Replace the standalone lifecycle hint and the
large permanent operation-status panel with one compact, glass-like status island floating over the Agent detail
canvas. The island communicates ongoing work without looking like a web alert or hiding durable operation detail.

This is presentation convergence only. Operation polling, lifecycle authority, retry semantics and backend state do
not change.

## Interaction model

The island has two states:

- **Collapsed** — the default. A single glass capsule shows a status glyph, a concise summary such as
  `正在启动 Agent · 2/3`, and a disclosure indicator when operation detail exists.
- **Expanded** — the same material grows downward into a compact panel containing the operation steps, terminal
  result, time and any existing “continue query” action. It is not a modal and does not add a backdrop.

Clicking or pressing the capsule toggles expansion. `Escape` collapses it. The trigger exposes `aria-expanded`, the
summary uses polite live-region semantics where supported, and keyboard focus stays on the trigger. The shared trigger
is a React Native `Pressable`/button with expanded state exposed through renderer-neutral accessibility props and
`aria-expanded` on Web. Opening does not move focus into the panel; expanded actions remain independently reachable by
keyboard and screen reader. Pointer events are limited to the island; the surrounding overlay container is transparent
to the page.

This is deliberately not a portal, modal or popover. Do not use `SystemPopover`: its Web implementation participates in
modal-layer overlay positioning and its native implementation owns a `Modal`/backdrop accessibility boundary. The
island renders inline inside `ManagementDetailCanvas` through an absolutely positioned transparent container and a
`SystemMaterialSurface`-style glass child.

The island remains present while any lifecycle hint or operation item exists. A running operation takes summary
priority. Otherwise the most severe terminal result is summarized, followed by a compact all-complete summary. It does
not auto-dismiss because the current operation store owns when evidence leaves the page. A failed, uncertain or paused
operation never disappears merely because the animation finished.

## Component boundary

Introduce two layers:

1. `SystemStatusIsland` is a reusable UI primitive. It owns glass material, floating geometry, summary typography,
   tone, disclosure, expansion, keyboard behavior and accessibility. It accepts semantic content and children; it does
   not know Agent or Operation contracts.
2. `OperationStatusIsland` is the domain adapter. It derives the summary/progress/tone from `OperationStatusItem[]`,
   combines an optional lifecycle hint, and renders the existing operation rows as expanded content.

`AgentDetail` renders one `OperationStatusIsland` instead of a loose hint `Text` plus a full-width
`OperationStatusList`. `OperationStatusList` becomes content-only when embedded: it retains labels, error copy,
timestamps and retry actions, but no longer owns a page-sized background, border, title or outer spacing.

This boundary lets other management resources reuse the island without copying Agent-specific state logic.

Neither layer imports or wraps `SystemPopover`. `SystemStatusIsland` owns only inline expansion; it does not create a
focus trap, dismissal backdrop or second window layer.

## Token model

No component may invent colors, radii, shadows, z-indexes, spacing or durations. The island composes existing geometry
from `recipes.status`, `recipes.contentMeasure`, `recipes.overlay`, `recipes.identity`, the spacing scale and semantic
icon scale. It must not grow the recipe namespace or numeric-leaf budget. Those sources cover:

- collapsed and expanded minimum heights;
- collapsed, expanded and compact-screen widths;
- canvas top/side insets;
- internal horizontal/vertical gaps and content padding;
- glyph and disclosure sizes.

The component must compose existing semantic tokens:

- `semantic.material.composerFill` and `semantic.material.blur` for glass;
- `semantic.color.borderOverlay` and status tone colors;
- `semantic.radius.overlay`;
- `shadows.floatingControl` while collapsed and `shadows.overlay` while expanded;
- `semantic.layer.overlay`;
- `semantic.motion.duration`/easing and reduced-motion behavior;
- existing compact/body/micro typography recipes.

Light and dark themes therefore remain structurally identical, and no new brand accent or blue action color is added.

## Layout and responsive behavior

The management detail canvas is the positioning boundary. The island is rendered inline in that canvas through an
absolute container—never a portal—and is centered near the top of the visible canvas, above document content and below
global application chrome. It does not reserve vertical space. Expanded content grows downward, has a bounded maximum
height and scrolls internally when necessary.

On narrow/touch layouts the island uses the canvas side inset and almost the available width. Pointer layouts keep a
compact capsule width and a bounded expanded width. Long operation names and messages truncate in the collapsed state
and wrap only in the expanded panel.

## State and failure behavior

Summary precedence is exact and uses only the existing `operation.state` and `pollingState` values:

1. Any `failed` or `uncertain` Operation wins and produces a danger summary.
2. Otherwise, any nonterminal item with `pollingState` `idle`, `timed_out`, `rate_limited` or `query_error` produces a
   warning summary. `idle` means automatic polling is paused and manual continuation is available; it is not completion.
3. Otherwise, any `pending`, `running` or `retry_wait` Operation produces an informational in-progress summary.
4. Otherwise, if every item is `succeeded`, produce a positive all-complete summary.
5. `superseded` is terminal and counts as complete, but produces a neutral history summary unless another item has a
   higher-precedence result.
6. With no operations, an optional lifecycle hint produces a neutral/warning capsule with no disclosure. With neither
   operations nor hint, render nothing.

Progress is `terminal item count / total item count`; terminal means `succeeded`, `failed`, `uncertain` or `superseded`.
The representative operation label is chosen from the highest-precedence group, newest by `createdAt` with `id` as a
stable tie-breaker. Expanded details preserve existing input order and existing continuation actions.

The island never fabricates completion from local timers. Backend Operation state and existing polling state remain the
only authority.

## Verification

Tests must prove:

- Agent detail no longer renders the loose lifecycle-hint text or page-sized status panel;
- collapsed status island is the default and exposes a concise live summary;
- disclosure expands/collapses the existing operation detail without losing continuation actions;
- lifecycle-only, active, succeeded, superseded, failed/uncertain, `idle`, timed-out, rate-limited and query-error
  summaries follow the declared precedence and progress calculation;
- geometry is composed from existing recipe/semantic tokens and light/dark token contracts stay isomorphic;
- the inline absolute implementation never renders through `SystemPopover`, `Modal` or a portal;
- narrow width, long copy, renderer-neutral expanded accessibility state, keyboard activation, Web `Escape`, reachable
  expanded actions and reduced motion remain usable;
- existing operation labels and product error normalization remain unchanged.

Run targeted component/Agent tests, theme/density/style-lint tests, Web typecheck and the complete Web test suite before
release.
