# Personal assistant evaluation

Inherits ../AGENTS.md. This directory owns benchmark input projection, isolated
process lifecycle and evidence formatting. It owns no assistant memory, history
or work state; use the existing application owners through the public socket or
domain entry points. See README.md for what each probe measures and how to run it.

- Offline `*.test.mjs` files use synthetic fixtures only and must stay runnable
  without network or credentials. Add new test directories to `test:eval-memory`.
- Live probes and benchmarks require an explicit private configuration file and a
  new output directory. Never wire them into CI, inherit machine credentials, or
  report a smoke probe as a benchmark score.
- Gold answers, labels and question categories stay in the evaluator process and
  never reach the assistant. Keep failures and `not_run` cases; do not filter or
  shorten history to improve a result.
- Keep this directory generic: no research reports, run archives, dataset
  payloads, private endpoints or comparison workers for third-party products.
