# Typography contract

Authority: `packages/design-system/src/typography/typography.tokens.json`.
This document defines usage; the registry owns numbers. Do not copy a numeric
scale here or introduce a parallel registry in a feature/plugin.

## Design language

Calm, content-first typography. Regular text is the default. Use structure,
spacing and a small hierarchy instead of emphasizing every interactive label.

- Web/Electron use bundled Inter for Latin, the existing system CJK fallbacks,
  then bundled Noto Sans SC. Inter is not a Chinese font. Native uses its system
  UI face. These are intentional platform differences, not permission for local stacks.
- Keep the established Web mono stack in this change. Native mono is selected by
  `nativeMonoFontFamily(Platform.OS)` from the registry. Do not hardcode Menlo in a renderer.
- 400: reading text, ordinary controls, current configuration values. 500: mild
  emphasis, section labels and primary actions. 600: page headings and semantic
  prose emphasis. 700 is reserved for source-content emphasis such as ANSI/syntax,
  not generic buttons. Optical adaptations belong in the platform projection.
- Natural tracking is the default. No local negative tracking or arbitrary 560/650
  weights. Selection/hover/open/disabled may change TextTone/material, not font weight.
- Reading text keeps the existing chat scale and user preference. Native text
  retains font scaling; touch editing retains its minimum readable size. Do not
  turn a compact layout problem into smaller essential text.

## Select by meaning

| Meaning | Existing role / registered extension | Do not use |
|---|---|---|
| Application page title | `settingsTitle` | A feature's independent h2 scale |
| Utility panel/dialog heading | `panelTitle` | Page title merely because markup is h2 |
| List/form/kanban section | `sidebarSection` | Button role for noninteractive copy |
| Conversation identity | `threadTitle` / `threadListTitle` | A toolbar title to make a selected row bolder |
| UI reading copy | `body` | Small caption to fit a long sentence |
| Chat reading / composition | `chat` / `composer` | UI menu line-height |
| Model, reasoning effort, permission, filter value, compact Web menu item | `controlCompact` | `toolbarTitle` or `label` to emphasize a selected value |
| Ordinary button | `control`, `controlSmall`, `controlLarge` | A primary action weight inherited by all variants |
| Primary action emphasis | `primaryAction` weight plus the control size | Weight chosen by sm/md/lg |
| Explanatory text, time, essential status | `metadata` | `controlSmall` (even if both happen to be 12px) |
| Passive compact context label or badge (for example a row’s project name) | `label` | Date grouping, essential status or an actionable control |
| Empty state / welcome display | `emptyTitle` / `displayTitle`, `displaySummary` | Page heading enlarged ad hoc |
| Prose headings / emphasis | `proseHeadingOne/Two/Three/Small`, `proseStrong` | Browser h1/strong defaults |
| Fenced / inline code | `proseCode` / `inlineCode` | Terminal font just because both are monospace |
| Terminal grid / mono metadata | `terminalText` / `code` | Inherited body tracking |
| Touch editable text / login verification code | `mobileInput` / `verificationCode` | Per-feature numeric exception |

Conversation-list Show more / Show less use `controlSmall` with the tertiary tone, retaining the existing control hit area and hover/focus behavior.

In the conversation list, date groups use `metadata` with the secondary tone;
row project names use `label` with the tertiary tone. Project names remain plain
text beneath the title, without a badge surface. Keep essential activity status
on `metadata`; do not shrink the whole metadata line to quiet the project.

Conversation process summaries (Thinking/Thought, command/read/image status),
including active/completed context compaction and the empty thinking placeholder, also use `body` (14px/20px, regular weight). They describe
execution rather than reading content. Expanded reasoning and returned content
retain `chat` and the user's reading preference; status headers stay consistent
with each other rather than inheriting the paragraph scale. ActivityDisclosure and
ActivitySummaryRow share that role; icon calibration and enforcement follow
[conversation activity visuals](activity-icons.md). A valid font token does not
justify a different role for a system record.

Existing role names are retained for compatibility. Add a role only for a real,
repeated semantic distinction, with Web and Native mappings in the same registry.
Do not add a role named after a component, state, palette or one screenshot.

## Implementation recipes

SCSS: `@include typography.role(control-compact, secondary);`.
Plain CSS: `font: var(--typography-control-compact-font);` and
`letter-spacing: var(--typography-control-compact-tracking);`.
JSX class: `className="ui-text--metadata"`; use existing layout utilities separately.
Native: `...nativeTypographyStyle("metadata", Platform.OS)`; colors remain separate.
Use `typographyRole` for a specialist API such as xterm that takes numeric metrics.
Native Button primary emphasis and size remain independent just as on Web.
Native touch option rows use the ordinary `control` role; toolbar values use
`controlCompact`. Menu density does not justify shrinking touch option labels.

Complete roles own family, size, line-height, weight and tracking. A metric-only
projection is appropriate for a specialist renderer or emphasis span; it is not a
way to assemble a new local type scale. FontFamily, TypographyRole, TextTone and
rasterization policy remain separate owners. Portaled menus set their full role.

## Agent workflow and progressive enforcement

1. Enter through `AGENTS.md` → `design/ui/README.md` → this topic, only when UI/text
   is affected. Unrelated protocol/host work need not load the typography document.
2. Classify text by the table before editing. Search the existing role/consumer;
   fix the shared default before adding an override in a feature.
3. Run `npm run check:typography`. It verifies generated output and parses owned
   SCSS/CSS and TypeScript/JSX across apps, packages and plugins. It rejects local
   metrics, arbitrary weights/stacks, font shorthand, inline styles and Tailwind
   font/size/leading utilities. There is no ordinary-UI legacy debt baseline.
4. Run `npm run test:typography` for semantic contracts and adversarial lint cases.
   Run `npm run smoke:typography` for real composer/controls/document samples in
   desktop/mobile, light/dark, including model menu and actual font loading.
5. For a new UI, check meaning as well as metrics: a paragraph can reference a
   valid button role and still be wrong. Review screenshots for hierarchy, mixed
   scripts, long labels and truncation. A linter cannot decide all semantic intent.
6. Changes to registry/default controls/exception ownership need design-system
   review in the normal PR. Include role choices, scope, before/after evidence and
   platform limits. Do not make lint pass by weakening it or refreshing a baseline.

`npm run check:typography` is already included in `check:boundaries` and `gate`;
The semantic/parser tests run both in `gate` and the existing control-standards
test chain. Thus
future Agent work uses the normal repository gates, not an optional new process.

## Specialist boundaries and exceptions

`typography-exceptions.json` contains exact file + selector + property + value,
owner, rationale and review condition. Stale exceptions fail. It is a reviewed
specialist allowlist, not a generated inventory, wildcard ignore or legacy baseline.
PDF selectable text uses document geometry; empty-message placeholders are layout;
mobile inputs have a platform minimum; chat reading size follows preferences;
the sole adapter interpolates registry names. No ordinary UI literal is exempted.

Synced `upstream/`, generated, vendor and external documents keep their source
ownership. Change their source and refresh/check the existing sync closure; never
rewrite imported files to satisfy this UI lint. This scope is OpenCraft, including
its owned plugins and Native renderers, not a redesign of independent downstream products.

## Lessons from merged changes

- `1440a028b6` / MR !5457 changed the family preference correctly, but family alone
  cannot fix weight or size roles. Keep separate family and semantic acceptance.
- `e4d24b774a` / MR !5460 isolated list titles from headers correctly. Preserve that
  distinction instead of changing every consumer of threadTitle.
- `fbf85a839f` added a feature-local 12px model-menu override. The new parser gate
  rejects that regression, including equivalent inline and utility forms.
- Earlier standards tests checked selected source strings/literal sizes. Replace
  those assertions with role/meaning contracts plus computed-style evidence; do
  not lock an incidental implementation number into a design requirement.

These commits illustrate the failure mode, not contributor intent. Existing token
ownership was useful; enforcement coverage and role guidance were incomplete.

Shared control Sass imports the stylesheet-free `typography-mixins.web.scss` owner. The public `typography.web.scss` entry forwards the same mixins and continues to emit semantic `.ui-text` utilities for the global shell. Incidental control imports must not emit additional copies of those utilities into startup CSS. Existing five metric-owner exceptions follow the extracted implementation; their declarations and scope are unchanged.

## Rounded numeric badges

`countBadge` is a specialist numeric role: the existing metadata scale, bold
weight, and the `count` family. Web/Electron bundle the original **OpenCraft
Rounded Count** WOFF2 (0–9, plus, grouping punctuation); letters and unsupported
localized numerals fall through to the existing UI stack. Native maps the same
role to system bold without introducing a remote font dependency. Use the shared
tertiary text tone for passive collaborator totals. This does not change ordinary
UI weight policy, labels, names, body text or title typography.

The editable centerlines, pinned build-only tooling and deterministic generator
are in `packages/design-system/assets/rounded-count/`. Run `python generate.py`
there after installing `requirements.txt` in an isolated environment; `--check`
compares the WOFF2 byte-for-byte. Normal application builds consume the checked-in
font and need no Python. The face is original project artwork under Apache-2.0;
it is not a renamed or transformed third-party font. All digits have equal
advances and open counters. Badge owners retain exact-count formatting,
accessible labels, hit areas and responsive fitting; the font does not own counts.
Verify a real consumer with the font loaded, long counts, font failure fallback,
light/dark surfaces and touch input. Do not apply the numeric family to names.

The typography generator emits two adapters: `_generated.web.scss` owns global
CSS variables and forwards the role names; `_roles.web.scss` contains only the
Sass role-name list. The mixin entry imports the latter so isolated component
styles do not silently re-emit every global font variable. The application loads
the global typography/tokens entry once. `generate:typography --check` checks both
files, and the real Sass regression checks that a local numeric role emits no
`:root` while global typography still supplies the required variables.
