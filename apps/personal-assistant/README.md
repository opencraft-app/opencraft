# Personal assistant runtime

Optional headless assistant runtime with a standalone CLI and explicit Host ports.
It includes work/execution/completion ledgers, bounded reception, durable waiting,
file-backed memory, goals, messages and explicit Pi/Codex adapters. Installation
alone does not register a provider, claim a Bot or start a Host process.

Run `npm test --workspace @opencraft/personal-assistant` from the repository root.
Tests use isolated synthetic fixtures; optional native-process tests must report
actual skips and use only explicitly configured loopback services. No paid model
or real external service acceptance is implied. `npm run check --workspace
@opencraft/personal-assistant` checks module syntax, not TypeScript semantics.

The evaluation support directory retains generic test harnesses, synthetic scenarios,
smoke input and an explicitly configured lifecycle probe. It contains no model credentials. Research reports, private source
archives, dataset payloads, comparison configurations and historical acceptance
records are not included. Full Host/Web integration and public contribution
acceptance remain separate work; this is not a deployment or release.

The root `test:assistant-runtime` gate runs syntax, the complete runtime regression suite
and synthetic evaluation tests. Model-only cases remain not_run in fixture mode,
not simulated quality passes. Evaluation source identity includes the actual npm
installation manifests and lock; changed dependencies cannot reuse old benchmark
answers. Explicit operator configuration is required for any real-model probe.
