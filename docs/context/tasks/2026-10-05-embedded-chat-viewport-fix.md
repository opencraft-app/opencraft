## goal

Implement the native-validated embedded keyboard fix at the LightVela host boundary,
preserving the shared OpenCraft Conversation/Composer and user state.

## non_goals

- No unrelated cloud mutation, real account or inference. The user subsequently
  authorized commit, push, MR merge to master and production publication.
- No shared Composer/viewport protocol refactor, timeout workaround, scroll reset,
  removal of sticky/paint/blur, or Application/editor remount.

## requirement_refs / requirement_excerpt

User: “搞起来”, after R4 iPhone feedback and stepwise production-boundary analysis.
R4 native export: five keyboard cycles, no negative composer Y; pageTop still lagged
page shift in four cycles, but screen coordinates stayed constant.

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-chat-visual-viewport.ts`
- Existing `lv-agent-embedded-chat-page` marker in `agent-settings-page.tsx`
- Preserve one Application, editor identity, draft/focus and inner reading position.
- CSS owns document constraint scope; helper owns only its page-height variable.

## history_context

- current_design_refs: `frontend/openspec/changes/2026-10-05-embedded-chat-viewport-ownership.md`
- relevant_evolution: R3 fixed roots stopped gray but not jump; R4 compensated
  early root scroll. The compositor's precise native implementation is unproven.
- Source starts at latest fetched master `30e62a4fe`; retain its newer56px mobile
  toolbar and international embedded-chat changes, not the older104px fixture.

## acceptance

- Scope fixed roots to mobile embedded chat; route/marker removal and desktop
  breakpoint release them without clearing an independent modal lock.
- Compensate late pageTop; bound height by the current fixed-root allocation on
  close; preserve browser zoom layout and release all binding listeners.
- Real-component browser continuity plus built CSS geometry checks; new native
  iPhone confirmation of the final source-derived artifact.

## affected_paths

- frontend/src/pages/marketing/agent-chat-visual-viewport.ts
- frontend/src/styles.css
- frontend/src/pages/marketing/__tests__/agent-chat-visual-viewport.test.ts
- frontend/scripts/check-agent-chat-viewport.mjs
- frontend/openspec/changes/2026-10-05-embedded-chat-viewport-ownership.md

## required_context

Root router returned no pack for the bounded viewport query; inspect exact source,
test and frontend adjacency instead of widening to the whole repository.

## context_receipt

| File | Reason | Effect |
|---|---|---|
| AGENTS.md; frontend/AGENTS.md; opencraft/AGENTS.md | Scope and gates | No implicit delivery; independent checkout dependencies |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md; references/verification.md | Ownership and evidence | Preserve core/editor; distinguish simulated and native checks |
| .agents/skills/lightvela-web-validation/SKILL.md | UI regression | JSON/HTML/screenshots; retain failure evidence |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | Neighbor checks | Existing viewport tests, compiled CSS script and source spec |
| .agents/context/change-impact.json | Formal impact | No mapped boundary rule; add scoped OpenSpec contract anyway |

## evidence / validation

- 28 focused tests pass; `pnpm check` passes with166 current/171 baseline TS
  diagnostics and0 new. Agent Console generated closure check passes130files.
- CN and global production builds pass; both exported compiled CSS viewport
  checks pass. Generated next-env build change restored.
- Real Conversation/Composer Chrome regression:27local cases pass;26public cases
  pass before adding the extra resize-first history case. No page errors or
  cross-origin requests; draft/focus/editor remain, root scope releases.
- Full frontend suite was attempted but failed assertions and several worker OOMs;
  stopped the owned runner (exit130), not a full green run. Clean master comparison
  of98tests reproduces the exact9failures from the same subset, no new failures.
- Documentation check has0errors; explicit affected-path impact check passes.
- Repository-wide context catalog validation fails on pre-existing metadata and
  secret-literal checks. Do not treat it as a passing gate or repair unrelated
  records in this scope.
- R5 native export identifies `30e62a4fe+viewport-fix`: 25 events, three keyboard
  cycles, 13 keyboard samples all place the Composer at Y=259.34375, bottom=360
  within visual height=376. The editor identity and six buttons remain stable.
  Late pageTop catches up without a second position change; the final history
  reading offset stays -349 through focus and keyboard close.
- User confirmed R5 “一切正常”. This confirms this device's reported visual
  symptoms and sampled keyboard geometry, not all devices, rotation or typing:
  native draft length is zero throughout.

## risks

The final source-derived R5 artifact passed native iPhone feedback and recorded
keyboard geometry. Exact Radix/Next route integration, rotation/zoom, native draft
typing and other devices remain beyond that recorded acceptance.
Do not generalize the root-height cap to arbitrary scrollable embedded containers.

## decisions

Use existing DOM marker and1023px media scope instead of a second writable root-lock
service. Max(pageTop,scrollY) compensates the observed ordering; fixed-root height
caps late closing offsets. Do not cache pre-rotation dimensions. Browser zoom uses
CSS allocation instead of keyboard reflow. Shared OpenCraft files are unchanged.

## scan_scope / scan_output

Bounded frontend helper/page/styles/tests and neighboring script/spec only; no
secret/account scan or production state writes. Existing worktree changes preserved.

## handoff

Branch `fix/lightvela-embed-keyboard-owner-20261005`; the user explicitly authorized
“提交发布通过MR盒入master” after R5 acceptance. Follow normal MR checks and
production publication gates; retain exact source/artifact evidence and do not
call a merged MR a completed deployment.
