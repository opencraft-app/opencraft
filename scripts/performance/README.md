# Cold history regression

Run from an OpenCraft checkout with dependencies installed and its supported
native Codex executable available (the fixture follows that executable's SQLite
and event schema):

```sh
python3 scripts/performance/history-cold-repro.py --native /path/to/codex
```

The command creates an isolated native profile, seeds one shell command without
inference, and constructs 601 synthetic Turns with 512-KiB tool outputs. It starts
the real native process, Core, adapter, AppHost and client with a fresh disposable
cache. No existing profile or user history is read. Native response bytes travel
through an explicit 6-MiB/s local link, so a hidden 100-Turn full page reproduces
8–13 seconds of transfer. A separate 26-second held tool preparation measures
AppHost admission, Core work and the remaining client/transport time.

Every measured cold/read/queue stage must finish within 10 seconds; detail
expansion must equal the complete native Item and the total count must be 601.
The original implementation times out cold and queues its next read for about
27 seconds. The fixed implementation indexes all headers and hydrates only the
visible body. This is a controlled synthetic regression, not natural telemetry.

Output JSON names a retained fixture and log directory. To compare a second
checkout without changing the fixture, pass `--repo /path/to/other/opencraft`
and `--fixture /path/to/fixture.json` to the same command. `--out` chooses the
evidence parent. Optional `--web-root /path/to/built/web/dist` measures actual
Application DOM first paint in a fresh Playwright Chromium context and records
a screenshot (`--chromium` selects an installed executable). All native state is
synthetic and local; remove the retained evidence directory when no longer needed.
