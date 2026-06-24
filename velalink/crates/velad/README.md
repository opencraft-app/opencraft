# velad

`velad` is the local daemon API shell.

It owns Axum routing, request extraction, response shaping, and dependency wiring. It must remain thin: command state belongs in `vela-runtime`, persistence belongs in `vela-store`, projection belongs in `vela-projection`, and wire shapes belong in `vela-protocol`.

## Run

```bash
cargo run -p velad
```

The daemon listens on `127.0.0.1:3857` by default and serves the OpenAPI surface under `/api/v1`.

Environment:

- `VELAD_LISTEN_ADDR`: socket address, default `127.0.0.1:3857`.
- `VELAD_DATABASE_URL`: SQLite URL, default `sqlite::memory:`.
- `VELAD_BACKEND_CWD`: backend working directory, default current directory.
- `VELAD_CODEX_MODEL`: optional default model shown for the configured Codex backend. Codex sessions can still override `agent_config.model`.
- `VELAD_ACP_COMMAND`: ACP agent command, default `hermes`.
- `VELAD_ACP_ARGS`: whitespace-separated ACP agent args, default `acp`.
- `VELAD_ACP_MODEL`: optional default model shown for the configured ACP backend. ACP model selection is startup/process configuration; current ACP sessions do not accept runtime `agent_config.model` or `agent_config.reasoning_effort` updates.
- `VELAD_ACP_API_KEY`: optional ACP/OpenAI-compatible API key. `VELA_CLOUDAGENTS_API_KEY` is also accepted.
- `VELAD_ACP_ENV_*`: extra environment variables passed to the ACP process after stripping the prefix. For example `VELAD_ACP_ENV_FOO=bar` becomes `FOO=bar`.
- `VELAD_PI_COMMAND`: Pi CLI command, default `pi`.
- `VELAD_PI_SESSION_DIR`, `VELAD_PI_MODEL`, `VELAD_PI_THINKING`, `VELAD_PI_SESSION`, `VELAD_PI_PROVIDER`, `VELAD_PI_API_KEY`, `VELAD_PI_NO_TOOLS`: optional Pi adapter configuration.
- `RUST_LOG`: adapter/runtime diagnostics filter, default `warn`. For Codex app-server protocol debugging, use `RUST_LOG=vela_backends::codex=trace,velad=debug`.
- `VELA_CLOUDAGENTS_API_KEY`: when set, velad configures both local defaults:
  - Pi: writes a temporary Pi `models.json` that registers the `cloudagents` OpenAI-compatible provider at `https://tokenhub.tencentmaas.com/v1`, then starts Pi with `--provider cloudagents --model minimax-m2.7` unless `VELAD_PI_PROVIDER` or `VELAD_PI_MODEL` overrides them.
  - ACP: creates a Vela-owned temporary `HERMES_HOME` for the Hermes ACP process, configures a `custom` OpenAI-compatible provider at `https://tokenhub.tencentmaas.com/v1`, and advertises `minimax-m2.7` unless `VELAD_ACP_MODEL` overrides it. This avoids mutating the user's global `~/.hermes/config.yaml`.
  Pi config stores only `$VELA_CLOUDAGENTS_API_KEY`. Hermes v0.16 requires the concrete key in its `custom` provider config, so velad writes it only into that process-scoped temporary `HERMES_HOME` with owner-only directory permissions.
- `PI_CODING_AGENT_DIR` or `VELAD_PI_AGENT_DIR`: optional directory for the generated Pi agent config. If omitted, velad uses a process-scoped temp directory.

CloudAgents smoke run:

```bash
VELA_CLOUDAGENTS_API_KEY=... VELAD_PI_THINKING=off cargo run -p velad
```

Codex is also registered by default when `velad` starts. It uses the Codex app-server protocol through `codex app-server --stdio`; set `VELAD_CODEX_MODEL` when you want `/backends/codex` to advertise a default model.

ACP is registered by default as a generic backend kind. The default local host is Hermes ACP through `hermes acp`, but public API clients still see backend kind `acp`; Hermes-specific launch details stay inside `vela-backends`.
