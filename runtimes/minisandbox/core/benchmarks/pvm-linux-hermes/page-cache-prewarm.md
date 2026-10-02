# Hermes guest page-cache prewarm experiment

Date: 2026-08-17

This experiment tests whether running a disposable Hermes process before the
PVM checkpoint materially reduces fresh-clone chat startup latency through the
guest Linux page cache alone. It deliberately does not retain a Python process
or `AIAgent` object across the checkpoint.

The baseline warm publisher already imports `hermes_cli.main`. Two stronger
variants were injected into an otherwise identical private ext4 upper layer:

1. Run `/opt/hermes/.venv/bin/hermes --help` to exercise a complete CLI process.
2. Run a disposable Python process importing `hermes_cli.main`,
   `hermes_cli.oneshot`, and `run_agent` to touch the lazy one-shot module graph.

Both variants used an empty throwaway `HERMES_HOME`, no credentials, no network
operation, and exited before the checkpoint. The existing deterministic local
OpenAI-compatible benchmark then measured one fresh clone. Baseline and deep
prewarm were alternated after the host EROFS cache had been populated.

## Results

Times below are medians of three runs unless stated otherwise.

| Measurement | Baseline | Deep prewarm | Difference |
| --- | ---: | ---: | ---: |
| Template warm | 1.553 s | 4.608 s | +3.055 s |
| Batch start to first provider request | 6.778 s | 6.778 s | -0.001 s |
| Hermes process to answer | 6.900 s | 6.919 s | +0.019 s |
| Clone to answer | 6.921 s | 6.937 s | +0.015 s |

The lighter `hermes --help` variant was also rejected after a screening run: it
added about 1.07 seconds to template warm-up while changing first-provider and
answer latency by only 12-19 milliseconds.

## Conclusion

Additional guest page-cache warming beyond the existing
`import hermes_cli.main` is not useful for this workload. The approximately
6.8-second pre-provider interval is dominated by repeated Python module
execution and agent/runtime construction rather than cold file reads.

The next meaningful experiment must preserve live anonymous interpreter state:
keep a credential-free Hermes warm daemon alive at checkpoint and invoke it in
the restored clone. Re-running disposable CLI processes should not become part
of the production warm path.
