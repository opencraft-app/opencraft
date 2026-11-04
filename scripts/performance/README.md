# Cold history regression

Run from an OpenCraft checkout with dependencies installed and its supported
native Codex executable available (the fixture follows that executable's SQLite
and event schema):

```sh
python3 scripts/performance/history-cold-repro.py --native /path/to/codex --expect-slow
```

The command creates an isolated native profile, seeds one shell command without
inference, and constructs a synthetic 46-Turn conversation with 3-MiB tool
outputs (about 138 MiB total). It starts the real native process, Core, adapter,
AppHost and client with a fresh disposable cache. No existing profile or user
history is read. The initial page requests 46 `notLoaded` Turns, through both
cache hydration and the adapter's oversized-page compatibility fallback. Each
Item response has a deterministic 100-ms local link latency and uses a bounded
24-MiB/s transport. This makes the serial 46-call read land in the 8–13-second
range while each individual call remains fast. `--expect-slow` validates this
pre-fix red signal; omit it after the fix to require both paths to finish below
10 seconds.

The initial page must contain all 46 turns, each Item must be returned without
loss, the serialized public result must omit deferred large tool output, and the
native history total must match the fixture. This is a controlled synthetic
regression, not natural telemetry. To exercise larger header-index rebuilds,
reuse a 601-Turn fixture with a larger initial history while keeping the visible
page explicit:

```sh
python3 scripts/performance/history-cold-repro.py --native /path/to/codex \
  --turns 601 --output-bytes 524288 --visible-turns 46 --load-path both \
  --mib-per-second 24 --rpc-delay-ms 100
python3 scripts/performance/history-cold-repro.py --native /path/to/codex \
  --turns 1001 --output-bytes 131072 --visible-turns 46 --load-path both \
  --mib-per-second 24 --rpc-delay-ms 175
```

Output JSON names a retained fixture and log directory. To compare a second
checkout without changing the fixture, pass `--repo /path/to/other/opencraft`
and `--fixture /path/to/fixture.json` to the same command. `--out` chooses the
evidence parent. Optional `--web-root /path/to/built/web/dist` measures actual
Application DOM first paint in a fresh Playwright Chromium context and records
a screenshot (`--chromium` selects an installed executable). All native state is
synthetic and local; remove the retained evidence directory when no longer needed.
