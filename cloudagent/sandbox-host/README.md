# sandbox-host

`sandbox-host` is CloudAgent's lightweight native capability host for the inner sandbox.

It runs inside the sandbox, listens on localhost, and exposes a small HTTP JSON protocol for the outer Hermes sidecar. The first version intentionally keeps only the complete minimal primitives:

- `fs.read`
- `fs.write`
- `fs.stat`
- `fs.blob` (raw HTTP file upload/download)
- `fs.list`
- `fs.search`
- `fs.patch`
- `process.exec`
- `process.start`
- `process.poll`
- `process.log`
- `process.write`
- `process.resize`
- `process.kill`
- `process.list`
- `process.close`

There is no separate `code.run` primitive. Code execution is composed through `process.exec`, for example `python3 script.py`, `node script.js`, or `bash script.sh`.

## Run

```bash
sandbox-host serve --addr 0.0.0.0:19091 --workspace /workspace
```

## Oneshot Call

The `call` subcommand is for diagnostics and AGS `run_command` based evaluation. It calls a running daemon over the same HTTP JSON protocol.

```bash
sandbox-host call --url http://127.0.0.1:19091 --method fs.write --json '{"path":"hello.txt","content":"hi"}'
sandbox-host call --url http://127.0.0.1:19091 --method fs.read --json '{"path":"hello.txt"}'
sandbox-host call --url http://127.0.0.1:19091 --method process.exec --json '{"command":"pwd"}'
sandbox-host call --url http://127.0.0.1:19091 --method process.start --json '{"command":"bash","pty":true,"rows":24,"cols":80}'
sandbox-host call --url http://127.0.0.1:19091 --method process.list --json '{}'
```

`fs.search` preserves the model-facing split used by Hermes adapters:

- `{"target":"content"}` searches file contents.
- `{"target":"files"}` discovers files/directories by name or glob.
- `limit` and `offset` page large result sets.
- `output_mode:"content"` returns line matches and supports `context` lines before/after each match.
- `output_mode:"files_only"` returns matching file paths, and `output_mode:"count"` returns per-file match counts.

`fs.read` refuses binary-looking files and device/special files. `fs.blob` is the binary-safe file transfer surface for runtime upload/download and still refuses workspace escapes, device/special reads, and sensitive system writes. `fs.write` and `fs.patch` refuse sensitive system paths when the workspace policy would otherwise allow them.

Large model-facing outputs are bounded by default:

- `process.exec` and `process.log` return at most 64 KiB unless `output_limit` or `limit` is provided.
- Process output responses include `next_offset`, `dropped_bytes`, and truncation metadata for pagination.
- `fs.search` truncates very long matching lines and marks them with `line_truncated`.

## HTTP JSON Protocol

Preferred endpoint:

```http
POST /v1/native
Content-Type: application/json

{"method":"fs.read","params":{"path":"hello.txt"}}
```

Hermes sidecar should prefer direct sandbox port-proxy HTTP transport for runtime file transfer. The CLI transport remains a diagnostic compatibility path for JSON native calls, but runtime upload/download should use the raw blob endpoint instead of shelling out to `test`, `cp`, or `base64`.

The daemon listen address comes from `HERMES_SANDBOX_HOST_ADDR` / `SANDBOX_HOST_ADDR` (default `0.0.0.0:19091`). Local readiness probes and CLI calls use `127.0.0.1` when the daemon binds an unspecified address. Direct AGS/E2B port-proxy HTTP transport is experimental and must be explicitly enabled:

- `HERMES_SANDBOX_HOST_TRANSPORT=http` enables direct HTTP transport through the sandbox port proxy.
- `HERMES_SANDBOX_HOST_ALLOW_CLI_FALLBACK=true` allows HTTP transport failures to fall back to CLI.

Compatibility endpoints are also available:

- `GET /health`
- `GET /v1/host`
- `POST /v1/exec`
- `POST /v1/process/exec`
- `POST /v1/process/start`
- `POST /v1/process/poll`
- `POST /v1/process/log`
- `POST /v1/process/write`
- `POST /v1/process/resize`
- `POST /v1/process/kill`
- `POST /v1/process/list`
- `POST /v1/process/close`
- `POST /v1/fs/read`
- `POST /v1/fs/write`
- `POST /v1/fs/stat`
- `POST /v1/fs/list`
- `POST /v1/fs/search`
- `POST /v1/fs/patch`
- `PUT /v1/fs/blob?path=<workspace-path>` writes raw request bytes to a file.
- `GET /v1/fs/blob?path=<workspace-path>` reads raw file bytes.

Every response uses:

```json
{"ok":true,"result":{}}
```

or:

```json
{"ok":false,"error":{"code":"error_code","message":"error message"}}
```

## Build

```bash
make test
make linux-amd64
```

`make linux-amd64` builds `x86_64-unknown-linux-musl`; the target must be installed in the local Rust toolchain.
