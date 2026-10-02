# Hermes live-interpreter warm daemon

Date: 2026-08-17

The warm daemon preserves a credential-free Python interpreter after importing
`hermes_cli.oneshot` and `run_agent`. Each restored clone invokes that process
through a bounded guest-local Unix socket. The comparison path starts a fresh
Hermes process from the same deep-preloaded template; both construct a fresh
`AIAgent` and use the same deterministic host-loopback provider.

The measured host has four logical CPUs and no swap. Each guest has 2 GiB of
virtual RAM backed lazily by the shared template plus private COW pages.

| Concurrent clones | Mode | Batch | p50 process to answer | Host user CPU | Peak host RSS |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | fresh process | 6.57 s | 6.57 s | — | — |
| 1 | warm daemon | 4.61 s | 4.54 s | — | — |
| 4 | fresh process | 10.35 s | 9.95 s | 35.96 s | 1.19 GiB |
| 4 | warm daemon | 7.19 s | 7.02 s | 24.68 s | 1.14 GiB |
| 8 | fresh process | 20.55 s | 20.23 s | 73.34 s | 2.33 GiB |
| 8 | warm daemon | 14.74 s | 14.24 s | 49.45 s | 2.27 GiB |
| 20 | fresh process (prior baseline) | 60.69 s | — | — | 6.70 GiB |
| 20 | warm daemon | 38.73 s | 37.69 s | 125.80 s | 5.69 GiB |

At one clone, retaining interpreter state removes about 2.0 seconds (31%) from
the current deep-preloaded fresh process. At four and eight clones it removes
about one third of batch latency and host user CPU. The remaining approximately
4.4-second interval before the first provider request is downstream agent,
tool-surface and provider construction; file page-cache warming alone was
already shown to have no material effect.

The 20-clone fresh number is the immediately preceding maintained benchmark,
not a same-run A/B: re-running its observed 6.70-GiB peak on this no-swap host
with only about 6.5 GB available would risk a host OOM. The 1/4/8 same-template
comparisons establish attribution, while the 20-clone warm result establishes
the new path's density and completion behavior.

## First-request profile and safe preload

A `cProfile` sample of the unmodified warm daemon's first deterministic request
recorded 5.55 seconds under profiling. Cumulative times overlap, but identified
the dominant cold paths: 3.96 seconds below Python's import machinery, including
2.25 seconds compiling source; 1.59 seconds in the lazy OpenAI SDK load; 1.35
seconds building the first system prompt while waiting for the local environment
probe; 0.99 seconds assembling tool definitions; and 0.36 seconds opening the
clone-private session database.

Only the credential-independent OpenAI class load and completed local Python
environment probe were moved before the checkpoint. Both leave no live thread
or unexpected descriptor, so the existing fail-closed checkpoint audit remains
the acceptance gate. Three normal, unprofiled runs on the same kernel, EROFS,
writable baseline and deterministic provider produced:

| Median of three | Baseline | Safe preload | Change |
| --- | ---: | ---: | ---: |
| Template preload marker | 2.285 s | 3.562 s | +1.277 s once |
| Boot through checkpoint | 3.184 s | 4.456 s | +1.272 s once |
| Clone process to answer | 4.586 s | 3.228 s | -1.358 s (-29.6%) |
| Clone process to provider request | 4.443 s | 3.103 s | -1.340 s (-30.2%) |

The remaining cold work is dominated by dynamic tool availability/schema
assembly, provider/config-dependent agent initialization and clone-private
SQLite state. Those cannot be cached globally without separating immutable
tool schemas from credential-, profile- and session-dependent decisions.

## Checked-hash bytecode experiment

The production build step could not be run through Docker on this host, so the
exact compileall command was also exercised inside the same guest against the
existing immutable EROFS. Its generated PEP 552 bytecode lived in a temporary
writable OverlayFS layer, which is a slower source than the final EROFS/DAX
placement. Compilation completed successfully across Hermes and its complete
virtual environment; the one upstream invalid-escape `SyntaxWarning` did not
fail compilation. The temporary layer was discarded after the experiment.

Three runs produced a median 2.337-second clone process-to-answer interval,
versus the preceding safe-preload median of 3.228 seconds: another 0.891 seconds
(27.6%) removed. Median process-to-provider-request fell from 3.103 to 2.336
seconds. The approximately 20-second compileall pass appeared in guest boot only
for this experiment; in the shipped design it runs once in the cached Docker
build layer and is absent from template boot. The experimental ext4 backing
allocated approximately 124 MiB more host blocks than its clean baseline after
compilation; the exact EROFS artifact delta remains to be measured on a
Docker-capable build host.
