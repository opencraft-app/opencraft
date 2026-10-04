# OpenCraft Codex request body limit

## goal

Allow a long Codex conversation to pass the Host loopback Account Pool proxy and return a clear HTTP size error if a request exceeds the new bound.

## non_goals

- No change to upstream provider limits, account selection, authentication, or image retention in Codex history.
- No commit or source mirror push. Preview replacement required separate authorization, which the user gave in a later message (`搞吧`).

## requirement_ids / requirement_refs / requirement_excerpt

- User conversation on 2026-09-29: after diagnosing `stream disconnected before completion: error sending request`, the user approved raising the local limit and fixing the silent disconnect (`好的 搞起来`). No external issue ID.

## interface_refs / data_structure_refs

- `opencraft/packages/account-pool-host/src/server.ts`: loopback HTTP request body reception and HTTP 413 behavior.
- `opencraft/packages/account-pool-host/src/codex-proxy.ts`: authenticated proxy guard before upstream forwarding.
- Both boundaries must use the same byte limit; an oversized request must not reach upstream.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md` Host-side provider account pooling; `docs/engineering/journeys/agent-request-streaming.md`.
- `relevant_evolution`: the existing 10 MiB bound was exceeded after a long conversation retained multiple image inputs through compaction. The first failing request followed a successful turn in the same Host.
- `superseded_refs`: none.

## acceptance

- A loopback POST above 10 MiB and below 32 MiB reaches the proxy and its upstream test double.
- A POST above 32 MiB receives HTTP 413 with `Request too large`, reaches no upstream, and leaves the server usable.
- Account Pool package typecheck, focused transport test, relevant boundary and documentation checks pass.

## affected_paths

- `opencraft/packages/account-pool-host/src/{request-limits,server,codex-proxy}.ts`
- `opencraft/tests/account-pool-host.test.ts`
- `opencraft/docs/platform-architecture.md`
- `docs/engineering/journeys/agent-request-streaming.md`

## required_context

- `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft` via the mono2 Context Router.

## context_receipt

| File | Reason | Use |
| --- | --- | --- |
| `AGENTS.md`, `opencraft/AGENTS.md` | Root and service rules | Scope, task record, test and release boundaries |
| `docs/context/domains/agent-gateway-runtime.md` | Streaming behavior | Test the actual local transport and avoid provider assumptions |
| `docs/context/domains/site-environment-routing.md` | Context Router result | Confirm no site or environment change |
| `docs/context/project/upstream-subtrees.md` | Context Router result | Keep mono2 as the sole source |
| `docs/context/project/services/opencraft.md` | Service owner | Keep the change in OpenCraft |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | Maintenance workflow | Verify source and runtime evidence separately |
| `opencraft/docs/platform-architecture.md`, `docs/engineering/journeys/agent-request-streaming.md` | Current design | Document the new bounded behavior |

The adjacency catalog has no OpenCraft Account Pool card; the bounded source and neighboring transport test were checked directly.

## evidence

- The Codex HTTP client logged failed POSTs to `127.0.0.1:40823/v1/responses`; other threads on the same Host received HTTP 200.
- The affected conversation's compacted history retained 12 image inputs. Its reconstructed history approached the 10 MiB local bound immediately before failures began.
- A read-only local probe of the old running proxy with a body of `10 MiB + 1 byte` produced a closed connection without an HTTP response.
- The first inline `systemctl stop` interrupted the agent hosted by that same preview before the remaining switch script could run. The persistent fallback service restored availability but served an older 2026-09-27 bundle. A detached `systemd-run` cutover then started the reviewed candidate.

## risks

- Buffering up to 32 MiB raises per-request memory use; the loopback bridge retains a bound and discards oversized chunks while draining the request.
- Upstream request limits are outside this change and may still reject a large forwarded request.
- The deployed preview is an isolated patch of the previously active server bundle, preserving the separately updated Web files. It is not a full clean source rebuild; the next ordinary release should include the mono2 source change.

## validation

- Account Pool package typecheck passed with the installed Node running the local TypeScript CLI (`tsc --noEmit -p packages/account-pool-host/tsconfig.json`).
- Focused Account Pool test passed: 23/23 with the local `tsx --test tests/account-pool-host.test.ts` CLI. This includes the new 10 MiB acceptance, 32 MiB HTTP 413, and follow-up request cases.
- Platform boundary check and typography check passed with the installed Node.
- Context documentation and changed-path impact validators passed; no broken links or impact errors. The impact check flags the usual `wisp/mono2-maintainers` review advisory.
- `git diff --check` passed for the changed tracked files.
- Candidate archive SHA-256: `fb2dae523dfb488ea62bef71e7ea9eed07d1570cc12ad2af66c84b2d22680948`; package smoke passed with buildId `20260929023352-7c5388ad9f9f`.
- The candidate runtime itself passed synthetic `10 MiB + 1 byte → 200`, `32 MiB + 1 byte → 413`, and follow-up request checks with a local fake proxy.
- After detached cutover, `opencraft-worked-final-limit-preview.service` was active with PID `358854` and runtime SHA-256 `754c0ac7f0bb1483ecb1b0b20b6ad6a7d77bf0ea8fdbcbaea3ac3180e508a42c`; HTTP health and Web buildId checks passed. The live loopback proxy returned `401` for an unauthenticated `10 MiB + 1 byte` request, confirming it passed the size gate, and `413` with `Request too large` for `32 MiB + 1 byte`.

## decisions

- Use a shared 32 MiB constant at reception and proxy boundaries; keep a finite memory bound.
- Drain bytes beyond the bound before responding with 413 so HTTP clients receive the error instead of an abrupt disconnect.

## scan_scope

- `opencraft/packages/account-pool-host/src/`, `opencraft/tests/account-pool-host.test.ts`, current design documents.

## scan_output

- Bounded `rg` output in the active task; no persisted scan artifact.

## handoff

- The source change is ready for review and the authorized preview replacement is active. The candidate package lives at `/data/opencraft-worked-final-release-ij4EdE/candidate-20260929-account-pool-limit-Rx4Hxy/opencraft-server`; the old package remains available for rollback.
- The checkout contains substantial pre-existing unrelated edits, including in `opencraft/docs/platform-architecture.md`. The preview candidate retained the active package's Web files and altered only the bundled Account Pool runtime plus package manifest. A future ordinary source release should incorporate the source fix rather than treating this preview overlay as a new source baseline.
- The self-hosted service cutover lesson is recorded in `opencraft/.agents/skills/opencraft-self-hosted-preview/SKILL.md` and routed from `opencraft/AGENTS.md`.
