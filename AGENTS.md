# VelaLink Agent Notes

## Fast desktop preview

Use this loop for Electron shell, ChatUI, and work-monitor visual feedback:

```bash
make desktop-preview
```

This is the default preview path. It runs the Electron dev host directly,
builds `target/debug/velad`, and lets the Electron host spawn that local daemon.
Do not start a separate external `velad` for desktop preview unless the task is
explicitly about pure web mode or daemon-only API testing.

Expected feedback behavior:

- Renderer, thumbnail, and work-monitor React/CSS changes update through Vite.
- The renderer dev server prefers port `5173`; if it is busy, the dev script
  uses the Vite-assigned fallback port and passes that URL to Electron.
- The preview host sets `VELA_DESKTOP_USER_DATA_DIR` to repo-local
  `.tmp/desktop-preview-user-data`; preview `velad` must not share the packaged
  `/Applications/Vela.app` SQLite database.
- `make desktop-preview` first clears older dev preview processes from this
  repo. Use `make desktop-preview-stop` to stop the running dev preview without
  starting it again.
- Electron main, preload, and `electron/work-monitor/*` window-manager changes
  require restarting `make desktop-preview`.
- Use `make desktop-install-dev` only after the fast preview looks right and
  the packaged `/Applications/Vela.app` behavior must be checked.
- Run `make desktop-pids` if the UI looks stale; it reports both dev preview
  processes and packaged `Vela`/bundled `velad` processes.

For work-monitor UI iteration, create/open a Codex session and send a message.
The mini window should open from local send intent and then follow the
read-model thumbnail state. If it looks like fake data, inspect
`packages/vela-chat-web/src/thumbnail/` before changing backend code.

## Local observability

`velad` has local-first observability for desktop debugging. Use it before
guessing why chat, session creation, Codex app-server calls, or the desktop
runtime failed.

Signals currently recorded:

- Trace ingest: `POST /v1/traces` accepts OTLP/HTTP JSON.
- Log ingest: `POST /v1/logs` accepts OTLP/HTTP JSON.
- Query API: `/api/v1/observability/status`,
  `/api/v1/observability/recent-errors`, and
  `/api/v1/observability/traces/{trace_id}`.
- SQLite indexes: `observability_spans` and `observability_logs`.
- Raw evidence: `traces.jsonl` and `logs.jsonl` under the local raw dir.
- Rust `tracing` events are copied into local observability logs.

Important span names:

- Desktop runtime: `electron.velad.start`, `electron.velad.stop`.
- Renderer/client HTTP: `velad.session.create`, `velad.session.send_events`,
  `velad.session.events.stream`.
- Rust runtime/backend: `velad.backend.send`.
- Codex adapter: `codex.app_server.connect`,
  `codex.app_server.initialize`, `codex.app_server.thread_start`,
  `codex.app_server.turn_start`, `codex.app_server.turn_interrupt`, and
  `codex.app_server.permission_request`.

For packaged macOS builds, the default database is:

```bash
db="$HOME/Library/Application Support/@vela/desktop-electron/runtime/velad/vela.sqlite"
```

The raw dir should be:

```bash
$HOME/Library/Application Support/@vela/desktop-electron/runtime/velad/observability
```

If `raw_dir` contains `Application%20Support`, the runtime is using an old
binary or a bad path derivation. The fix belongs in
`crates/vela-observability/src/lib.rs`, where raw paths are derived from the
SQLite database URL.

## Querying desktop failures

Find the packaged `velad` process and listening address first; do not assume
the port:

```bash
pid=$(pgrep -f '/Applications/Vela.app/Contents/Resources/bin/velad' | head -n 1)
addr=$(lsof -Pan -p "$pid" -iTCP -sTCP:LISTEN | awk 'NR>1 {print $9; exit}')
```

Check whether local observability is enabled and where raw files are written:

```bash
curl -sS "http://$addr/api/v1/observability/status" | jq .
```

Check recent errors first when the UI says "failed to fetch", a Codex chat
fails in less than one second, or a session enters an unexpected failed state:

```bash
curl -sS "http://$addr/api/v1/observability/recent-errors?limit=20" | jq .
```

List recent spans directly from SQLite when the API result is too high level:

```bash
sqlite3 -header -column "$db" "
select trace_id, name, printf('%.1f', duration_ms) as ms,
       status_code, coalesce(backend, '') as backend,
       coalesce(error_message, '') as error, observed_at
from observability_spans
order by observed_at desc
limit 20;
"
```

Group spans by trace to find the best trace id for a failing workflow:

```bash
sqlite3 -json "$db" "
select trace_id, count(*) as span_count,
       min(observed_at) as first_seen,
       max(observed_at) as last_seen,
       group_concat(name, ' -> ') as span_names
from observability_spans
group by trace_id
order by max(observed_at) desc
limit 20;
" | jq .
```

Open one trace through the API for a structured view:

```bash
curl -sS "http://$addr/api/v1/observability/traces/$trace_id" | jq .
```

When debugging Codex-specific failures, expect the useful chain to include
`velad.session.send_events`, `velad.backend.send`, and the
`codex.app_server.*` spans. If those spans are missing, check whether the
renderer sent `traceparent` and whether the app was launched against the
bundled `velad` rather than an external server.

Timestamps stored in local observability are UTC. Convert them before comparing
against local UI screenshots or macOS logs.
