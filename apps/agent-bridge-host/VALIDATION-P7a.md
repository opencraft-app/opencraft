# P7a local validation

Initial base: `114a08539e`; rebased onto `cc5e82b176` with `--no-autostash`; branch `feat/agent-bridge-p7a`. No deployment, default
engine switch, Hermes change, push, PR or automation command is included.

## Implementation decisions

- Server admission signs the existing execution capability after domain admission.
  Host verifies that signature and exact Server/Thread pair, and rechecks current
  Server admission before publishing a private execution launcher. The extra
  admission lookup runs in the existing orchestration Worker.
- CLI descriptors point to a Host forwarding endpoint. Only live Host leases
  forward using the Server execution bearer retained only in Host; descriptors contain a distinct short-lived Host bearer, so copying them cannot bypass Host revocation by calling Server directly; terminal callbacks, stop and owner loss
  revoke forwarding. Server retains per-call delegation/resource checks and owns
  the sender identity, write budget and durable operation receipts.
- Codex configuration refresh has one shared owner. The legacy path keeps its
  existing permission capture, runtime retirement and settings restoration order;
  the bridge consumes the same owner for execution environment changes.
- `thread input status` takes an operation ID, keeping lookup restricted to the
  calling delegation and checking target read access before reading delivery.
- `tell --delivery native` maps to the existing native steer path and requires an
  expected Turn. Queue uses the existing durable input path. Interrupt is explicitly
  unsupported by the current Broker authority; it never silently becomes queue.

## Verification

After rebase, the frozen source passed:

- `npm run test:agent-bridge`: 168 passed, one opt-in Core probe skipped.
  The runner removes the inherited invalid `BASH_FUNC_which%%` environment key;
  production sandbox validation remains strict.
- Focused CLI, legacy MCP refresh, session capabilities, IM read tools, legacy
  Codex adapter and Broker regression tests: 136 passed.
- Root `npm run typecheck` and `npm run check:boundaries`: passed.
- `npm run build:codex --workspace @opencraft/agent-bridge-host`: passed.

The rebase retained P3c resume checks and typed refusal, P2d dispatch settlement,
abandon and evidence reconciliation, and the P9 compatibility tests. No running
service consumes the new local bundle.
Real model acceptance is separate from deterministic native-boundary fixtures.
The recorded local Codex Core native socket was absent during this run. No Core
was started and no other CODEX_HOME writer was opened. A real model
spawn/tell/wait/output chain has therefore not been verified.

## Remaining provider scope

The configured independent Codex Host path consumes the new execution CLI port.
Other providers have no new execution environment adapter in this change and must
not advertise CLI execution merely because they support a shell. A configured
Host refuses issuance when the provider does not declare that capability.

## Independent review

First review: `thr_ib9yikrd2v`. Three P1 findings were accepted and fixed:
preparation failures no longer mark an unsent native Turn unknown; direct Server
bearer descriptor issuance was removed; and the main CLI fixture now invokes the
actual launcher through Host gateway, Host forwarding, Server authorization and
Broker. It covers spawn/tell/wait/output and gateway restart. The production Turn
binding wait helper and the bridge retirement polling branch have regressions.
The optional existing-Core probe remains opt-in and does not claim a model task.
