# Progress

## 2026-09-16

- Cloned reference at commit `6c27d9640c37e02e1eab0c4f7d98fa01196c66b8`.
- Read reference README, architecture notes, analysis, component facade, engine, clock, physics, behavior, morph, geometry, renderer, material, and particle systems.
- Read OpenCraft avatar Stage, renderer, motion catalog, shape catalog, CSS effects, architecture ownership, and focused tests.
- Reference verification passed: 39 states, 18 shapes, 14 morphs, 25 materials, 1,521 ordered state transitions, 1,800 shape/expression combinations.
- OpenCraft focused Bot conversation test passed: 20/20.
- No OpenCraft product code was changed.
- Began product implementation with a red scheduler ownership test. The first
  run failed with `ERR_MODULE_NOT_FOUND`, proving the new runtime did not yet
  exist; added the minimal shared scheduler implementation next.
- Added a red clock test for hidden-time fencing; it initially failed because
  the clock module did not exist, then gained a logical park/unpark clock.
- Added a red continuity test for spring retargeting, then extracted the fixed
  1/120-second spring model from the React facade without resetting values.
- Added a red effect-lifecycle test, then implemented actor-owned
  reset/enter/hold/exit/done transitions with bounded enter and exit durations.
- Added red topology and eye-boundary tests, then created OpenCraft-owned
  parametric 48-point rings for all 18 identities plus interpolation and span
  fitting helpers. No reference geometry data was copied.
- Added a red deterministic-behavior test, then extracted seeded pose, blink,
  expression, and state-entry target scheduling from the React component.
- Added a red multi-Bot rate policy test, then defined active 60Hz, attentive
  30Hz, ambient 8Hz, hidden 0Hz, and reduced-motion 0Hz projections.
- Added a red attention-handoff test, then made idle-to-listening presentation
  pass through a 650ms waking state without adding a protocol phase.
- An initial workspace typecheck command used the wrong workspace name and
  reported no matching workspace; reran with `@opencraft/plugin-bot-chat`.
- The focused typecheck then found an unreachable `none` switch branch after
  TypeScript narrowing; removed that branch.
- Replaced the live avatar facade with the shared scheduler, cached pointer
  bounds, sampled path renderer, shape-safe eyes, stable gradient material, and
  bounded five-particle reactions. The original source/mirror Stage remains.
- Removed all state-driven infinite avatar effect and particle CSS animations.
- Focused runtime plus Bot conversation tests pass 29/29; plugin typecheck passes.
- The first `npx prettier` wrapper returned exit 1 without diagnostics. Switched
  to `npm exec prettier -- --write`, which formatted only the explicitly listed
  task files successfully.
- Added a red material-identity test, then extracted a state-independent,
  theme-token-aware soft material definition used by the SVG body and rim.
- One inspection command repeated an `opencraft/` prefix while already inside
  that directory; reran the read with the correct relative path.
- A new low-frequency scheduler test exposed that a never-delivered 0Hz
  subscriber was incorrectly included in another Bot's frame because both
  interval values were infinite. Added an explicit 0Hz delivery fence.
- The direct-effect-switch test initially expected the enter easing value on
  exit. Corrected the assertion to the intended remaining opacity (0.125 at
  half of the 140ms exit); implementation behavior was already correct.
- Platform boundary verification passes. The full workspace typecheck reaches
  an unrelated pre-existing dirty file,
  `plugins/lightvela-hermes/.../group-conversations.ts`, where Expo types see
  browser numeric timers without `.unref()`. The affected Bot Chat package
  typecheck remains green; this task did not edit the Hermes file.
- Web production build passes. The first browser-smoke launch could not resolve
  a local `playwright` package; reran with the Codex bundled Playwright module
  and the installed Chrome executable.
- Browser smoke passed active/attentive/ambient projection, one-shot send/exit,
  zero CSS effect loops, reduced motion, and no page exceptions. Screenshot
  inspection exposed missing fixture-only theme aliases, so dark-background
  computation is now asserted explicitly before accepting the dark capture.
- Extended browser verification to prove the active actor changes frames while
  an offscreen actor reaches `hidden` and remains frozen. Removed the obsolete
  path catalog and dead CSS effect keyframes after the sampled geometry and
  runtime-owned effect lifecycle became authoritative.
- A completion audit found HOLD was bounded only by the next semantic state,
  which was not a true one-shot. Added a failing regression and then a 900ms
  bounded HOLD that automatically exits and reaches DONE without replaying.
- The final choreography audit also found notification/celebration body poses
  could remain selected after their reactions completed. Added a red regression
  and bounded them to 700ms/1200ms before settling to idle; send/receive remain
  bounded by the shared effect transaction.
- Renamed the focused runtime test to `chat-bot-avatar-runtime.test.ts` so the
  repository's existing `test:chat` glob executes it in normal CI.
- Final acceptance: 390 chat tests, Bot Chat typecheck, boundaries, Web build,
  documentation, change-impact, and browser smoke are green. The only broader
  failure is the recorded unrelated Hermes Expo timer typing error.
- A final documentation command was launched from the OpenCraft subdirectory
  with the root-relative `.agents` path and failed to locate the script; reran
  it from the repository root rather than changing the command contract.
- A final line-number search included Markdown backticks inside a shell double
  quote, so the shell attempted `npm run test:chat` from the mono2 root and
  reported a missing root script. No files changed; retained the already proven
  OpenCraft-subdirectory test result and avoided that quoting pattern afterward.
- Context documentation validation passes. Change-impact validation correctly
  required an agent-gateway-runtime design update; added the stable client-side
  Presence/Stage scheduler invariant to that domain document.
