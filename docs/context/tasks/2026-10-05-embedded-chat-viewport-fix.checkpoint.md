## stage

Implementation, focused/real-component checks, both regional builds and R5 native
iPhone keyboard acceptance complete. User authorized commit/MR/merge/publication.

## verified

- Root CSS declaration scoped to mobile existing embedded-chat marker; current
  root allocation caps late offsets, zoom uses CSS fallback, window resize and
  disposal covered. Shared OpenCraft unchanged.
- 28 focused tests, frontend check and CN/global builds pass. Both exports pass
  compiled stylesheet geometry checks.
- 27 local real-component cases pass; 26 public cases pass (extra local history
  resize-first case added afterward). Report directories in scratch diagnostic tree.
- Full suite has assertion failures and worker OOMs; intentionally stopped exact
  owned Vitest pid 3100828 after checking cwd. No test or production processes other
  than that owned runner were stopped. Not a passing full suite.
- Clean baseline at 30e62a4fe has its own
  frontend dependencies; 98 tests yield the same 9 failures as changed checkout.
- Repository-wide context catalog validation remains failing on historical
  metadata/secret-literal checks; no unrelated records or secrets were modified.
- R5 native: 25 events, three focus cycles; all 13 keyboard samples keep shell
  Y=259.34375, bottom=360 within visual height=376; editor identity stable. User
  confirmed “一切正常”. Late offset does not cause a second jump.

## unverified

- Real Next route transitions, full Radix runtime, other devices, rotation/zoom
  and native typing (R5 draft length remains zero). Production revision pending.

## discard

- Do not call the repeated full-suite failures new regressions or hide the OOMs.
- The older104px fixture is not the latest mobile toolbar; R5 uses116px outer
  allocation matching the current60+56px header/toolbar.

## restore

- Owned delivery checkout, branch
  fix/lightvela-embed-keyboard-owner-20261005, base 30e62a4fe.
- Temporary static service/tunnel are the1718units, expire approximately21:19.
  Final-source preview is round5/static/?native=1&root=lock under current tunnel;
  only synthetic components, no account/Host/inference. Do not restart current Host.
- Scratch reports: round5-source-regression, round5-public-regression and
  baseline-failures.json / changed-failures.json under native-diagnostic.

## next_action

Commit/push only the scoped source, tests, contract and task record; create MR,
attempt normal merge and follow exact-source frontend build/publication gates.
Generated next-env build change restored. Preserve broad test failure evidence.
