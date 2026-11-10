# P2a local validation

Implementation base: `origin/main` at `1fbbafa0db` (P1b, P2c, P3 and main
baseline-test repairs included). This records local source and built-artifact verification;
it does not authorize a default-engine switch or deployment.

## Ownership and deliberate decisions

The opt-in daemon adapter reuses the P1a protocol/assembler and P1b Host/inbox.
It attaches the existing Core AppServer, preserving Core account-pool routing,
authentication refresh, native execution environment and permission policies.
It does not launch another Codex writer or own a CODEX_HOME.

Public thread IDs use `bridge:codex:`. Native IDs of bound sessions cannot bypass
the bridge through the legacy adapter. One input lacking native correlation
blocks another steer across turns, avoiding ambiguous attribution. Native
`userMessage.clientId` correlation is context-path evidence, not evidence that
the model understood the instruction. Admission alone never upgrades it.
Unknown mutation outcomes retain their command ID and are not automatically
resent. Clients without the typed evidence extension cannot steer these threads.
The initial capability is text input; unsupported queue/fork/archive/rename and
withdrawal paths remain unavailable. Core's synthetic broker credentials answer
native auth requests; upstream account credentials remain with Core.

## Deterministic and client verification

Commands run locally:

- `npm run test:agent-bridge`: 121 passed after review repairs (120 after rebase,
  69 before the other
  provider batches merged), including native Unix WebSocket fixtures,
  durable Host/inbox, stale refusal, unknown outcomes, auth callback handling,
  native/public ID joins and sanitized native 0.162.1 history replay.
- The P2a gateway process test kills the gateway with SIGKILL during a synthetic
  active turn, advances the native owner while disconnected, and starts another
  gateway process. History and evidence recover with exactly one start and one
  steer. This proves fixture crash recovery, not a real model turn.
- Workspace `typecheck` for agent-bridge-host, account-pool-host, appserver-protocol, opencraft-daemon,
  chat-core, chat-runtime, workbench-runtime and workbench-web passed for touched
  owners.
- `tests/chat/chat-runtime.test.ts`: 75 passed; user-message layout: 13 passed.
  `npm run check:i18n`, `npm run test:i18n`, `npm run check:boundaries` and
  `npm run test:controls` passed without enlarging a baseline.
- `npm run test:sandbox`: 21 passed; `npm run test:sqlite-node`: 38 passed.
  `tests/execution/opencraft-daemon.test.ts`: 12 passed. Token ACL tests: two
  passed on the host after the restricted filesystem refused `setfacl`.
- `npm run build:codex --workspace @opencraft/agent-bridge-host` and daemon
  `build` passed. `npm run build:web:release` passed with the documented headless
  host environment configured.
- `node --import tsx scripts/smoke/execution/smoke-codex-provider-bridge.ts`
  exercised the built Workbench through an actual AppHostServer and synthetic
  native owner: legacy/new histories, Composer steer during a tool, separate
  admission/native confirmation, single tool/input/answer, gateway reattachment,
  retained draft/focus, and switching to Chinese. The screenshot review covered
  the admission, reconnection and localized states; the sidebar has one entry
  for each native/bridge thread.
- `scripts/smoke/conversation/smoke-user-message-semantics.ts` exercised evidence
  rows in narrow/wide containers and light/dark themes. The narrow dark screenshot
  was inspected for status readability and duplicate outcome rows.

The process/browser fixtures use test-only synthetic resources. They make no
claim about production kernel sandbox enforcement, real model responsiveness,
Electron windows or Expo devices. No running product service or default route
was replaced. Generated builds are local, ignored artifacts.

## Real-account evidence and remaining acceptance gap

The cheapest model in the current available list was selected (`gpt-5.6-luna`).
The initial native attempt returned 429 before any tool. A read-only Core account
projection found an eligible account, so the explicitly authorized retry ran.
It exposed an unhandled unscoped native auth-token request; the fix reuses the
existing Core synthetic broker auth and is covered by a deterministic test.
One further attempt, explicitly authorized after that fix, again ended with a
native 429 before a tool. The bridge remained connected and delivered the native
terminal outcome. Further real attempts stopped as instructed.

Consequently no real file read, long-tool steer, nonduplicated real side effect,
or gateway restart during a running real model turn has been demonstrated.
The sanitized native recording covers failed history only. Successful steer and
restart evidence above is fixture-level. The full design §7 P2a row is **not
passed**; resuming real acceptance requires the coordinating user's decision.
Private run IDs and quota projections remain in ignored local evidence, not in
this public record. Account-pool ownership/path was retained in source and the
observed attachment; no account refresh/login was initiated for diagnosis.

## Broader checks with limitations

After rebasing onto `1fbbafa0db`, the two repaired main test files below pass
all 18 tests. The full AppServer suite was not rerun. The expanded bridge suite
initially rejected inherited `BASH_FUNC_which%%` in other providers’ fixtures;
rerunning with this invalid shell-function environment entry removed passed
all 120 tests, preserving production sandbox validation.

The earlier `test:appserver` run was not passing. The coordinator confirmed two
preexisting main failures: Codex reasoning-summary lifecycle counts (expected
four, observed five) and an expired reset-credit fixture with no fixed clock.
Original-main adapter replay reproduced the first failure. No P2a changes were
made to either. A separate local-agent-host test completed its assertions but
kept process handles open; original-main runtime replay reproduced that hang.
The test children were stopped after diagnosis. Missing node-pty build output
was repaired locally with `npm rebuild node-pty` before the passing daemon test.

`test:workbench:live` could not start because its required canonical AppServer
lab fixture was absent. The dedicated built Workbench smoke above passed but
does not replace that lab suite or real-account acceptance.

## Independent review follow-up

The first independent read-only review covered `1fbbafa0db..88761dc70c` and
identified two P1 issues, both accepted: pending approvals were not restored
when the gateway reopened, and approval responders retained obsolete subscription
grants. Recovery now joins replayed request bodies with the Host's current
interaction ledger, then offers the same interaction ID on subscription recovery.
Accepted settlement removes eligibility; replay cannot resurrect it. No schema
migration or separate interaction authority was introduced.

Responder eligibility now requires the current thread subscription and the
specific initialized client epoch. Unsubscribe, disconnect and reinitialize
revoke earlier grants; unknown bridge callback IDs cannot fall through to the
legacy owner. The gateway integration test covers late responses after each
revocation, a pending approval across gateway replacement, exactly one native
response, no duplicate offer on repeated reads, and no settled offer after a
second replacement. Real-account acceptance limitations remain unchanged.

The second and final independent review found three additional P1 paths, also
accepted and repaired locally: native external request resolution/connection
loss was missing from the ledger; re-offering an outstanding request could
conflict with the real client broker; and settled request bodies remained cached.
An additive typed `interaction/resolved` callback now retires exact provider
request ownership. Native connection loss records `connection-lost` without
approving a tool or asserting its outcome. Host command settlement also publishes
retirement in the same Worker transaction. Gateway and client pending requests
retire from these committed events; startup retains bodies only for pending IDs.

The shared AppServer client admits one outstanding handler per request ID and
connection revision: an identical restored request retains that handler and its
receipt, while changed parameters emit a protocol error without replacing it.
A real AppServer client plus `AppServerInteractionBroker` regression verifies
one card, one native answer, and no duplicate-request failure. Native resolution,
owner loss, settled-body cleanup and replacement replay are covered through the
bundled bridge/Host/gateway test. Review rounds are closed at two; these targeted
repairs were verified by the implementing agent without a third review dispatch.

Final targeted validation after these repairs: bridge suite 121 passed; AppServer
connection lifecycle, execution channels, session and shared interaction broker
suites 113 passed together. Typechecks passed for bridge-protocol, Host, daemon
and appserver-client. Codex/daemon builds and the rebuilt Web smoke were repeated
for this changed client and callback path. The initial broader-check limitations
and real-account acceptance gap above are unchanged.
