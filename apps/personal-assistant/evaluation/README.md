# Personal assistant evaluation

Generic evaluation harnesses, synthetic scenarios and explicit opt-in probes for
the personal assistant runtime. Nothing here contains model credentials, research
reports, dataset payloads or historical run archives.

There are two kinds of entry point:

- **Offline tests** (`*.test.mjs`) use synthetic fixtures and isolated profiles.
  They make no model or network calls and run in CI.
- **Live probes and benchmarks** call a real model endpoint. They never run in CI
  and never run implicitly: each one requires an explicit private configuration
  file and a new output directory, and refuses to overwrite earlier evidence.

## Offline tests

From the repository root:

```sh
npm run test:eval-memory --workspace @opencraft/personal-assistant
```

This runs `evaluation/*.test.mjs` and `evaluation/pibench/*.test.mjs`. The root
`npm run test:assistant-runtime` gate includes it.

## Live probes

Probes check that one end-to-end behaviour works against a real model. They are
acceptance smoke checks, not benchmark scores: every report records
`benchmarkScore: null` (or `false`) and retains failures, the profile and usage.

All probes run against the product's public local socket (`LocalRunner` +
`request`) with a fresh, isolated profile under the system temp directory. No
external messages are sent; work products are local synthetic notes.

| Probe                         | Measures                                                                                                                                                                                                                                    | Arguments                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `codex-probe.mjs`             | Native Codex reception answers an ordinary chat message and does not create work.                                                                                                                                                           | `--codex-config PRIVATE_JSON --output NEW_DIR`                                     |
| `codex-execution-probe.mjs`   | Durable Codex execution: delegated work asks the user, survives a runner restart while waiting, resumes in the same native thread after the answer and publishes one note. `--all-codex` also uses Codex for reception and parent delivery. | `--codex-config PRIVATE_JSON --output NEW_DIR [--all-codex]`                       |
| `scope-probe.mjs`             | Memory authorization across two agents of one synthetic human: private agent memory and unjoined projects stay hidden from APIs and the model; explicit join allows reads; leaving revokes them.                                            | `--codex-config PRIVATE_JSON --output NEW_DIR`                                     |
| `work-coordination-probe.mjs` | The real main model creates two independent works in one batch, one waits for input while the other completes, both survive a restart, then targeted answer, goal amendment and status summary keep work identity.                          | `--codex-config PRIVATE_JSON --output NEW_DIR` (run inside a git checkout)         |
| `time-source-probe.mjs`       | Diagnostic: re-plans an already evaluated query with original message timestamps added to the read-only QA projection and compares the proposal with the recorded reply. The original response is not rewritten.                            | `--profile EVALUATED_PROFILE --model-config PRIVATE_JSON --output NEW_FILE`        |
| `lifecycle-probe.mjs`         | Lifecycle probe with either a model or Codex configuration.                                                                                                                                                                                 | `--model-config PRIVATE_JSON` or `--codex-config PRIVATE_JSON`, `--output NEW_DIR` |

Example:

```sh
cd apps/personal-assistant
node evaluation/codex-probe.mjs --codex-config ~/private/codex.json --output /tmp/codex-probe-$(date +%s)
```

`time-source-probe.mjs` needs a profile produced by a replay run
(`longmemeval.mjs` / `assistant-session.mjs`) that contains the
`evaluation-query` turn, and the same model configuration as that run.

### Configuration files

Configuration files must be owner-only regular files (`chmod 600`); symlinks are
rejected.

- `--codex-config`: a Codex harness object with an absolute `binary`, `baseUrl`,
  `modelId`, and optionally `credentialFile` and `reasoningEffort`
  (see `src/adapters/codex/config.mjs`).
- `--model-config`: `{ "provider", "modelId", "apiKey" }`, with `baseUrl` and
  `thinking` only for the `openai-compatible` provider.

## Benchmarks

`longmemeval.mjs`, `benchmark.mjs`, `memory-system.mjs` and `butler-suite.mjs`
run larger replay or synthetic-suite evaluations. They need explicit datasets and
model configurations, pin source fingerprints, and keep `not_run` and failed
cases in the denominator.

## π-Bench dialogue pilot (`pibench/`)

A capability-limited dialogue pilot that drives the product through a pinned
checkout of the public π-Bench user simulator and scorer. It is not the full
benchmark and produces no leaderboard score; see `pibench/AGENTS.md`.

- `channel.mjs` is a stdin/stdout JSON-lines bridge from the simulator to the
  product socket. It only forwards visible user content and waits until delegated
  work has settled before returning the visible reply.
- `pilot.py --upstream PIBENCH_CHECKOUT --model-profile PROFILE_DIR --node NODE_BIN --output NEW_DIR`
  verifies the pinned upstream revision. Without `--dialogue-probe` it only writes
  a zero-call `readiness.json`; with `--dialogue-probe` it runs the first
  researcher tasks against a fresh all-Codex profile and calls the model.
- `diagnose.py --upstream PIBENCH_CHECKOUT --run RUN_DIR`
  rescores observed dialogues from an existing run; no new assistant calls, never overwrites results.

Run the Python scripts with the π-Bench checkout's own Python environment.
