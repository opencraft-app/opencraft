# OpenCraft Codex CLI 0.160.0

## goal
Update the bundled headless Codex CLI so the current preview can discover `gpt-6.1-sol` when the account model catalog offers it.

## non_goals
- Change model entitlements, upstream catalog content, or unrelated application behavior.
- Change the production deployment.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-10-02: update Codex CLI because `6.1sol` cannot be selected in the current conversation.

## interface_refs / data_structure_refs
- `opencraft/runtime/codex/package.json` and lockfile pin the packaged CLI.
- Codex AppServer `model/list` supplies the selector through the OpenCraft Host.
- The headless package uses stock Codex CLI; queued message steering stays in the Host-owned queue.

## history_context
- `current_design_refs`: `opencraft/docs/build-matrix.md` headless archive section; `opencraft/docs/platform-architecture.md` Codex Host section.
- `relevant_evolution`: the working tree already moved the runtime pin from `0.156.1` to `0.157.0`; this task advances that existing change to `0.160.0`.
- `superseded_refs`: none.

## acceptance
- CLI reports `0.160.0`.
- Local fixture `model/list` returns `gpt-6.1-sol` through the production Codex Engine adapter.
- Focused adapter tests, daemon typecheck, and headless candidate startup pass.
- Any preview switch is verified in the reconnected session; actual account catalog availability is checked separately.

## affected_paths
- `opencraft/runtime/codex/package.json`
- `opencraft/runtime/codex/package-lock.json`
- `opencraft/scripts/smoke-codex-engine.ts`

## required_context
- Context router returned no matching pack. Bounded search found the runtime pin, headless package path, and AppServer model path.

## context_receipt
| File | Reading reason | Decision |
|---|---|---|
| `AGENTS.md` | Repository boundaries | Preserve unrelated dirty work and require release confirmation. |
| `opencraft/AGENTS.md` | OpenCraft validation and preview boundary | Verify the real runtime and client after a switch. |
| `opencraft/.agents/skills/opencraft-self-hosted-preview/SKILL.md` | Current agent is hosted by the preview | Stage an isolated candidate and use an external supervisor for any switch. |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Model and Host maintenance | Keep the model catalog owned by the runtime. |
| `opencraft/docs/build-matrix.md` | Headless package contract | Keep exact CLI version pin and stock CLI path. |

## evidence
- npm registry latest package metadata on 2026-10-02: `@openai/codex@0.160.0`.
- New CLI `--version`: `codex-cli 0.160.0`.
- Local Codex Engine smoke with `gpt-6.1-sol` fixture: passed, no external model requests.
- Daemon typecheck: passed. Adapter and queue tests: 28 passed.
- Candidate archive: `/data/codex-cli-0160-preview-candidate/OpenCraft-server-codex-0160-linux-amd64.tar.gz`; SHA-256 `dbfd15088a59a1844cdd4b0e03b2d36ccedc38920b2699a8c1b1835b41690b39`.
- Full headless archive smoke passed: manifest, Web release, isolated server startup, and Codex Host handshake.
- Current live `0.157.0` service model list has seven models and does not contain `gpt-6.1-sol`.

## risks
- The running `0.157.0` process remains until the preview restarts. Preserve the existing release and data directory for rollback.
- Fixture catalog success establishes compatibility only. Actual account access to the model remains to be verified after switching.

## validation
- `npm run smoke:codex-engine` using the `0.160.0` binary.
- `npm run typecheck --workspace @opencraft/opencraft-daemon`.
- `npx tsx --test tests/codex-engine-adapter.test.ts tests/codex-host-queue.test.ts`.
- Candidate package manifest, startup, and live model list before any rollout.

## decisions
- Advance the existing exact version pin to npm's `0.160.0` package, preserving the Host queue design and unrelated changes.

## scan_scope
- `opencraft/runtime/codex`, `opencraft/scripts`, and Codex Host adapter paths.

## scan_output
- Bounded `rg` results used in this task; no separate artifact.

## handoff
- Source and candidate are prepared. `switch-preview.sh` is staged but has not run. Preview switch requires repository release confirmation and an independent supervisor, followed by reconnected live verification.
