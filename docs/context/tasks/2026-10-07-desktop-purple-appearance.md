---
id: task-2026-10-07-desktop-purple-appearance
type: task
scope: Independent purple desktop control material, not application accent.
triggers: [desktop purple appearance]
owner: opencraft-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/design-system/src/desktop-view.web.scss
status: retired
reviewed_at: 2026-10-07
review_due: 2026-11-07
revision: 1.0.0
precedence: task
derived: false
---

## goal
Use a scoped purple foreground/background pair for desktop control materials.
## non_goals
- No global theme change, Linux wallpaper/theme modification, shader invention,
  identity-provider API, offset fix, preview replacement, restart, commit or push.
## requirement_refs
- User approved separating the desktop colors after comparing purple reference.
## interface_refs / history_context
- Current design `opencraft/docs/cloud-desktop-plugin.md#panel-presentation`.
- Codex 26.930.31428 build 12913 rich panel resolves its appearance independently
  from application accent. Its imported purple submit palette is #8952ee light,
  #7849d1 dark with white foreground (K3i / Q3i). No runtime pixel-parity claim.
## acceptance
- Ring, color wash, visor and confirmed action consume a paired local appearance;
  light/dark/custom themes retain contrast without inheriting global blue.
- Existing activation, reduced-motion, pending cancel and input authority unchanged.
## context_receipt
- Maintenance skill/verification fully read; root/local AGENTS from current
  workspace re-used. Router query unmatched; exact desktop stylesheet,
  theme-engine/appearance and adjacent real panel fixture/smoke inspected.
## affected_paths
- Shared desktop stylesheet, browser smoke and formal desktop design.
## validation
- Build current CSS, browser light/dark/custom matrix and relevant type/boundary checks.
## risks / decisions
- Default purple is product presentation, not a fabricated assistant identity.
- No new backend or GPU resource lifecycle; existing masked CSS animations retained.
## evidence / handoff
- Implementation complete in shared desktop primitive; defaults are explicit
  paired purple/white rather than global app accent. No geometry, input contract
  or motion modifications. Existing decorations consume the same local pair.
- 44 focused desktop/appearance tests passed; plugin/Web typechecks, boundaries,
  current Web build, whitespace and scoped docs-impact passed. Empty staged check
  is not scoped evidence. CSS minifier shortened white to #fff; browser assertion
  now accepts equivalent white representations and checks computed status color.
- Browser matrix passed `/tmp/opencraft-desktop-ui-Pui5nx`: 1024/720/320px
  light/dark/custom and Shell1280/390px. Actual trace/wash/background/foreground
  sampled, not only stylesheet names. Light720 Chinese confirmed-control screenshot
  visually inspected. Backend/media synthetic, not production authority or iPhone.
- White-on-purple contrast calculated 4.661:1 light and 5.718:1 dark.
- Live remains `20261007-desktop-control-frame-5b9f70ea2`; no replacement/restart,
  commit/push or Linux theme modification.

## checkpoint
### stage
Scoped appearance implementation and verification complete; source only.
### verified
Paired independent default desktop purple and unchanged existing lifecycle/motion.
### unverified
Official reference runtime pixel parity, assistant appearance mapping and remote OS theme.
### next_action
On explicit replacement request, transfer scoped desktop stylesheet and smoke into
the current running baseline candidate, headless-build and independently exchange frontend.

## preview_delivery
- User authorized replacement. Self-hosted preview skill fully read; current
  port/PID/unit/cgroup/cwd/data flags/runtime hash checked. Router delivery query
  unmatched; bounded live package/prior scripts inspected.
- Shared desktop stylesheet and browser smoke integrated into running baseline
  candidate, source/candidate hashes equal. Headless Web build and real panel
  matrix passed `/tmp/opencraft-desktop-ui-fm5wGD`.
- First preparation blocked on changed diagnostic .map metadata before switch;
  paired runtime JS bytes verified identical. Retain new maps only for identical
  paired runtime; strict JS/CSS collision checks preserved. Partial stage retained.
- Independent systemd exchange succeeded. Live build
  `20261007-desktop-purple-5b9f70ea2`, health OK; PID1907435 and runtime hash
  unchanged, backend/data not restarted or changed. Four live desktop/mobile
  light/dark startup cases passed; isolated ephemeral DOM verified served CSS
  purple/white/trace values. No real desktop/production authorization exercised.
- Receipts `/data/opencraft-desktop-purple-preview-yAgh9E`, rollback directory
  `web-desktop-purple-20261007-2`; old hashed assets retained. No commit/push,
  Linux theme change or offset fix. Refresh existing pages for the new frontend.
