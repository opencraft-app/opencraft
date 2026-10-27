# Implementation and evidence

- Shared Web Button and styles now live in the design system. Existing local
  imports are compatibility exports; SettingsButton and SettingsIconButton adapt
  the same owner. Shared neutral geometry/typography contracts are retained.
- Chrome actions and inert measurement twins use shared components. Explicit
  integrated/floating surfaces replace the catch-all glass selector. Header groups
  own one backdrop; navigation rows and fixed footer actions stay quiet. Floating
  drawers, conversation actions and transcript controls keep their own material.
- Duplicate control paint was removed from the app, utility Settings styles and
  affected task controls. Existing route, Host, editor, panel geometry and motion
  owners remain in place. Unrelated working-tree edits are preserved.
- The parser-based check rejects raw shared-control markup, material imports and
  opt-ins, manual projection attributes, and feature styles repainting shared
  controls. Negative fixtures exercise conditional/composed class names, nested
  selectors and unauthorized projection. Checks are wired into boundaries/gate.
- The ownership guard and its five negative/positive test groups pass, including
  TypeScript checks requiring labelled icon actions and valid surface semantics.
  Boundaries, typography and hover policy pass without a new baseline.
- Final focused verification passes: 23 control/chrome/material/preferences tests,
  9 account Settings tests, 33 Shell-space tests and 10 workspace-presentation
  tests. The migrated panel-toggle assertion passes. Cloud desktop's 40 tests
  pass. Design-system-web, extension-react and workbench-web typechecks pass;
  the earlier full-gate typecheck also covered all workspaces.
- Both Web and Electron Renderer builds pass. The running preview at
  `http://localhost:10000/` serves current source, with its local Host on 9988.
  Built output is separate from this Vite preview. The complete Electron build
  (Renderer, Main/Preload, daemon and native helper) also passes. A new Electron
  window runs from this checkout with a fresh isolated profile. Its actual Mac
  Renderer verifies integrated header controls, stable editor identity during
  Sidebar toggles, retained draft across Settings, on/off/auto density and theme
  selection. Evidence: `.local/control-refactor-evidence/electron-evidence.json`.
  Native AppKit vibrancy pixels are outside the CDP capture; this is not a signed
  installer or physical touch-device acceptance.
- `smoke:controls` passes in real component/browser contexts: coarse/fine input,
  automatic and manual density, narrow pointer and wide touch, four theme
  combinations, original editor/draft preservation, stable in-progress geometry,
  keyboard focus and panel actions. A separate isolated browser profile also
  verifies the running Workbench, integrated header, quiet New Chat and actual
  theme selection. Evidence: `.local/control-refactor-evidence/evidence.json`.
- The existing header/sidebar browser regression passes with 18 evidence entries:
  touch widths 320/390/820/1280, light/dark, desktop hover and touch-hover
  suppression, conversation menu/rename, preview/sidebar toggles, safe bottom,
  scrolling optics and CSS fallback. It now uses a physical fixture and explicit
  dependency optimization; assertions wait for actual transition completion.
  Evidence: `/tmp/opencraft-newera-header/result.json`.
- Inspected the actual running light/blue Workbench and touch header screenshots:
  desktop actions share the bar without separate circles/capsules, New Chat is a
  quiet row, and touch controls retain one floating surface per group. Group
  backgrounds leave glyphs unfiltered and do not cover the menu or editor.
- Verification hardening repairs the initial gate failures at their current
  owners. Exact SCSS base rules are parsed instead of slicing unrelated styles;
  lazy Browser/Composer implementations are checked at their actual files; the
  Host fixture has real browser history. Workbench units now pass (454 tests,
  in addition to the task-draft/client-resource stages).
- Headless restart verification uses real platform evidence. On Linux it retains
  exact process incarnation; on this Mac an unavailable observer leaves the old
  execution unknown, preserves its original submission and rejects reauthorization
  by a later steer. New explicit unowned inputs still cannot inherit that Human.
  No production identity or authorization rule was relaxed.
- Fixture repairs retain private directory permissions, the existing maintenance
  lock database, current migration receipts and all historical checksum/rollback
  checks. Canonical paths avoid macOS aliases; short Mac socket paths and an
  explicit validation socket parent follow the actual runtime constraints. No
  published migration SQL, version or fingerprint was changed.
- A real build-checker defect was reproduced with a new symlinked-root test:
  Vite resolves module IDs, but the graph owner compared them against an alias.
  Canonicalizing the root restores correct relative module ownership. Release
  tests still reject unsupported APIs in lazy and external product modules while
  excluding type-only imports. The new test fails before the fix and passes after.
- All prescribed gate stages pass in segmented verification after these repairs,
  rather than one final uninterrupted `npm run gate`. Evidence chain:
  `.local/control-gate-repaired.log` passes startup through Relay before the old
  Hub fixture; `.local/control-gate-tail.log` verifies repaired Hub;
  `.local/control-gate-tail2.log` verifies identity storage, Actors and Human auth;
  `.local/control-gate-tail4.log` verifies the repaired execution/storage core;
  `.local/control-gate-tail5.log` verifies Headless, Pi packaging, IM and agent
  drivers; `.local/control-gate-tail6.log` verifies release checks (37 + 4), Web
  build, startup-cache check, Expo Web export and iOS bundle. Earlier failures
  remain in those diagnostic logs; the named successful stages supersede them.
  Normal macOS startup also passes without a TMPDIR workaround. The build-checker
  source passes Workbench typecheck and boundaries after its fix.
- The final Web/actual-component browser run passes after the checker change.
  Portal presentation switches are sampled atomically so a retired action node
  cannot produce a false empty computed style. Draft, focus, pending geometry,
  touch overrides and real Workbench theme checks remain enabled. Dev preview
  console includes 404/MIME diagnostics; page exceptions are empty. PWA install
  and offline-worker acceptance are not claimed.
- Browser simulations do not establish physical iPad/foldable input, native
  compositor pixels, authentication, model calls or remote Host acceptance. No
  commit, push or publication is included.

## Disclosure feedback follow-up

- The inconsistency came from a model-only open-state rule in feature SCSS;
  permission triggers had hover paint only. Shared ghost buttons now project
  Radix open / aria-expanded as persistent highlight, with a separate held-press
  state. DisclosureButton fixes the quiet integrated surface and row composition;
  accessory tokens own geometry and capability/preference-based touch targets.
- Model, session-model, permission, Host and project triggers use this primitive.
  Add/context/attachment and dictation controls use shared IconButton. Removed
  the former Composer button geometry, hover/open paint and touch shape rules.
  Voice error color uses the semantic danger variant; gestures, permissions,
  focus leases, selection and mutation ownership are unchanged.
- Negative fixtures reject disclosure inline paint and feature hover/open/press
  overrides. Type fixtures prohibit selecting another disclosure surface/variant.
  Existing check:controls and check:boundaries enforce these with no new baseline.
- Inspected actual permission menus in blue pointer, blue wide touch and 390px
  touch, plus dark Settings navigation. Open triggers retain a highlight while
  the pointer moves into the menu; selected permission warning color remains.
  Navigation rows keep 8px side gutters, 34px pointer / 44px touch targets.
  The voice action has no browser-default frame after the shared migration.
- `smoke:disclosures` checks five real Workbench triggers across light, dark,
  blue, wide touch and narrow touch. It checks hover, held press, persistent open,
  Escape, keyboard reopen, stable menu-open geometry and the original editor and
  unsent draft. Touch scenarios first use an actual tap so Shell input/layout
  projection settles before measuring. Evidence is under
  `.local/disclosure-feedback-evidence/`.
- Boundaries, control negative/type tests, i18n checks/tests and Web/Composer/
  design-system Web+Native/voice-input typechecks pass. Workbench units pass
  (454 tests plus task-draft/client-resource stages); focused dictation, attachment,
  continuity and shared-style tests pass. Shared-control browser regression passes
  capability overrides, narrow pointer / wide touch, keyboard focus, forced colors,
  reduced motion, themes and pending geometry. Web build and browser compatibility
  pass. Logs: `.local/disclosure-*.log`.
- Source is hot-reloaded at localhost:10000; a new Web build is available locally.
  No Electron restart/package, physical-device test or microphone recording was
  performed for this follow-up. Existing native preview is not current evidence
  for these additional Renderer changes. No commit, push or publication.

## Navigation surface follow-up

- Settings navigation now consumes shared NavigationList/NavigationGroup/NavigationItem,
  including extension and management destinations; SidebarNavigationItem and the Web
  updates destination adapt the same row. The list owns an 8px semantic edge gutter.
  Hover, current state and activation use the same box, with 34px minimum pointer
  rows and at least 44px in touch density. Product/icon presentation no longer
  projects a navigation-padding override.
- NavigationGroup reserves the complete neutral keyboard-focus contour inside its
  scroll clip while preserving the row gutter. This was visually reviewed after an
  initial capture exposed clipped side outlines; the browser assertion now checks
  contour containment, not just the existence of an outline.
- NavigationList requires a localized `label`. Obsolete literal landmark baseline
  allowances were removed, and affected browser probes locate the Settings-owned
  shared landmark independently of locale. Shared-control guards cover navigation
  classes, custom consumer classes and inline geometry; type fixtures reject missing
  names and arbitrary row sizes/material. Presentation-policy tests prohibit icon
  style from taking ownership of the shared padding token.
- Actual Web acceptance covers resting/hover/current rows in light, dark and blue,
  consistent inset widths, narrow pointer layout, and real touch contacts on wide
  Settings navigation. Touch navigation retains 44px targets without sticky hover;
  subsequent Tab navigation draws an unclipped 2px neutral focus contour. Editor
  identity, draft retention, pending geometry and density overrides still pass.
  Inspected images: `.local/control-refactor-evidence/settings-navigation-hover-blue-detail.png`,
  `settings-navigation-hover-dark.png`, and `settings-navigation-touch-blue.png`.
- Validation passes: design-system-web and workbench-web typechecks; check:controls,
  test:controls, check:boundaries, focused Settings/presentation checks, check:i18n
  and test:i18n; workbench unit stages (33 + 8 + 454); smoke:controls including the
  live local Workbench and touch Settings; build:web (989 runtime sources, zero
  compatibility issues). Logs: `.local/navigation-*.log`. The Web preview serves
  current source; native windows and physical devices were not rebuilt/retested
  for this follow-up. No commit or publication was performed.

### Settings row containment follow-up

- Reproduced the Appearance defect in the running Web route: the compact value
  shrank to 188px while its three grid tracks still required 68px each. The last
  option extended beyond the row/card. Existing ownership checks passed because
  they checked rule ownership, not rendered geometry.
- Shared Settings rows now wrap using available container space and retain the
  value's preferred width. Copy sizing is a shared token; explicit stacked and
  utility-panel forms retain their vertical sizing. Removed the row's viewport-only
  stacking override. Inset segmented choices cap their width, wrap complete labels
  and stretch equal-height targets, retaining the existing input/density authority.
- Visual review of the narrow-container case exposed a second defect: theme
  choices stayed in two squeezed columns because their breakpoint used viewport
  width. The grid now chooses readable columns from its own available width.
- `npm run smoke:settings-layout` exercises actual `/settings/appearance` on the
  local Web preview: English/Chinese, pointer/hybrid touch, manual off/on/auto,
  320–1280px windows, a 320px card inside a wide window, 150% zoom, keyboard End,
  retained control identity, and light/dark/blue palettes. The injected old sizing
  rules are rejected by the same geometry assertions. Viewport samples wait for
  Shell resize motion to settle; this is stationary layout acceptance, not an
  animation-frame audit. Actual touch contacts are browser simulated.
- Inspected `.local/settings-layout-evidence/zh-CN-pointer-blue.png`,
  `zh-CN-touch-narrow.png`, and `en-US-touch-dark.png`: all segmented labels and
  selected backgrounds are contained; narrow theme choices use one readable
  column. The tall narrow card capture is clipped by its scroll viewport at the
  bottom, so it is evidence of the visible region only.
- Web typecheck, focused shared-control/theme tests, test:controls and
  check:boundaries, check:i18n/test:i18n and live smoke:controls (including this new
  Settings regression) pass. Existing fixture resource 404/MIME console warnings
  remain; no page exceptions were observed. Browser results are in `.local/settings-layout-evidence/report.json`;
  check logs are `.local/settings-layout-*.log`. Current Web serves source changes;
  no Electron/native rebuild or physical-device verification in this follow-up.

### Expanded region versus open popup feedback

- Actual Web SidebarToggleButton reported `aria-expanded=true`, no popup/state,
  no hover and no keyboard focus, yet painted `rgba(26,28,31,0.098)`. The shared
  ghost rule incorrectly treated every expanded region as an open popup.
- DisclosureButton now projects its own shared semantic class. Persistent open
  feedback applies to explicit disclosures, real popup triggers and popup-owner
  open state; ordinary expanded regions keep their accessible state without a
  selected background. No Sidebar feature paint or ARIA removal was needed.
- The held-press regression exposed hover specificity overriding active paint.
  Hover/open rules now yield while active, keeping rest, hover, held press and
  open feedback distinct without adding priority overrides.
- Shared-control browser cases distinguish expanded regions (including
  `aria-haspopup=false`) from explicit/Radix/popup disclosures in four palettes.
  Actual Web sequences cover hover, held press, collapse/reopen, neutral keyboard
  focus and quiet expanded rest in light/dark/blue plus wide touch. Composer popup
  open/close/reopen feedback, draft/DOM identity and narrow touch remain intact.
  Reviewed `sidebar-toggle-rest.png`, `sidebar-rest-blue.png` and
  `permissions-light-open.png` under the existing local evidence directories:
  the Sidebar glyph integrates with its bar while an open menu trigger retains
  its own highlight. Touch contacts are browser simulated, not physical-device
  acceptance.
- Design-system-web/Web typechecks, test:controls, shared-control standards,
  check:boundaries and live smoke:controls pass. `smoke:disclosures` passes all
  five presentation/input contexts after the held-press fix. Logs:
  `.local/sidebar-toggle-*.log`. Current Web serves the changes; Electron was not
  rebuilt, and this follow-up has not been committed or published.
