# ChatUI Visual Contract

This document is the navigation map for ChatUI visual changes. It is not a
wire contract and it must not duplicate OpenAPI. OpenAPI owns client-facing data
shapes; this file owns where visual decisions live and which tests keep them
from drifting.

## Source Of Truth

- `desktop.module.css` is the primary visual source for the reusable ChatUI
  surface: typography, Markdown rhythm, assistant/user message chrome,
  conversation viewport, custom scrollbar, composer, and request dock.
- `renderers/markdown` owns Markdown token-to-DOM semantics only. It should
  emit semantic nodes such as `p`, `hr`, `pre`, `table`, and `img`; visual
  styling belongs under `.messageResponse` in `desktop.module.css`.
- `components` and `primitives` own structure and accessibility. They should not
  invent one-off spacing, color, or typography when an existing visual family
  exists in `desktop.module.css`.
- `packages/vela-desktop-shell` owns host chrome: sidebar, window safe area,
  shell menus, shell motion, and desktop-only frame behavior.

## Visual Domains

### Markdown

Markdown content is styled through `.messageResponse`. Paragraphs, headings,
lists, code, block code, tables, images, and horizontal rules must share one
compact reading rhythm. If a Markdown token renders correctly but looks wrong,
first check `.messageResponse` before touching `renderTokens.tsx`.

## Markdown Visual Rules

Markdown visual rules are CSS rules, not parser rules. The renderer should only
decide semantic shape; `desktop.module.css` decides how that shape reads.

- Horizontal rules use the same low-contrast divider family as turn headers and
  should never render as a browser-default dark line.
- Tables use `.markdownTableScroller` for overflow and `.markdownTable` for the
  visible table chrome. Do not reintroduce third-party table action chrome.
- Lists use compact reading rhythm under `.messageResponse`; list density should
  not be fixed by changing global typography.
- Code uses inline and block code styles under `.messageResponse code` and
  `.messageResponse pre`. Renderer components must not add one-off code boxes.

## Scrollbar Visual Rules

The scrollbar visual is self-drawn by ChatUI and mirrors the real conversation
scroll element. The thumb, track, and drag affordance live in
`conversation-runtime/scrollbar` plus `desktop.module.css`.

- `web-plain` and desktop full preload should expose a full-content scrollbar
  after layout.
- Partial virtualization exposes mounted-and-estimated content until measurement
  settles.
- The scrollbar overlay is a view/controller only. It does not own route memory,
  history paging, bottom-follow intent, or host persistence.

### Agent work

Agent work is not Markdown. Keep tool rows, grouped work summaries, running
items, failures, and expanded details in the agent-work visual family. Do not
solve agent-work density by changing Markdown margins.

### Composer

The composer owns the input frame, bottom overlay, primary send/stop control,
attachments, dictation, and session capability controls. It should preserve
stable dimensions in narrow layouts so text never slides behind the send button
or turns the primary control into an oval.

### Conversation

The conversation viewport owns vertical scrolling, content width, bottom
anchoring, history hydration presentation, and the cross-platform scrollbar
overlay. Document scrolling and route-level shells must not take over ChatUI
scroll state.

### Desktop shell

Desktop shell visual rules live outside ChatUI. The shell owns the sidebar,
traffic-light safe area, desktop menu popovers, shell collapse motion, and
main-surface edge veil. ChatUI should remain embeddable in the shell and in the
plain web debug page.

## Red Tests

When changing a visual domain, add or update the smallest contract test that
guards the behavior:

- `packages/vela-chat-web/tests/dependency-direction.test.ts` guards ChatUI
  visual ownership, typography, Markdown rhythm, composer dimensions, scroll
  ownership, and package boundaries.
- `packages/vela-chat-web/tests/*dom*.test.tsx` guards DOM-visible behavior that
  string/CSS tests cannot prove.
- `packages/vela-desktop-shell/tests/desktop-shell-visual-contract.test.ts`
  guards host chrome, sidebar, desktop menu, and shell motion.

Prefer a contract test over a screenshot when the behavior can be expressed as a
stable structural rule. Use browser/manual visual checks for polish after the
contract is green.

## Change Rules

- Do not put visual compatibility behavior in OpenAPI.
- Do not fork a second Markdown renderer for completed messages.
- Do not add one-off CSS classes inside renderers when a `.messageResponse`
  rule can express the visual.
- Do not move desktop shell chrome into ChatUI to fix an embedding issue.
- If a style change affects spacing, font size, overflow, scroll, or motion,
  add a red test first and keep the test near the owning domain.
