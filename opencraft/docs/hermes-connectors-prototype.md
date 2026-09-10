# Hermes connector prototype

## Ownership

- Workbench owns only generic settings/view contributions. No connector branch was added to core.
- `plugins/lightvela-hermes/src/connectors` owns UI, TAT client and installation action.
- A view is bound to a physical Bot ID; switching Bot or logging out disposes its requests.
- `/data/overmind` owns catalog, instance state, credentials, service clients and skills.
- Hermes uses a stdio MCP bridge to the VM's loopback daemon. Neither COS credentials nor
  the daemon Bearer are stored in Hermes model config or browser persistence.

## User flow

Settings → 连接器 immediately shows a searchable catalogue with original icons,
even before login or installation. Sign in and select a Bot to install the pinned runtime,
supply required tokens, add/connect or disable. The installer URL/checksum live in a collapsed
advanced section, not the primary page.
The installer is an explicit user action, never an effect of opening settings.

`scripts/export-hermes-connector-catalog.mjs` exports public browsing metadata from Overmind's
marketplace; icons are copied from the same snapshot. This build-time projection contains no
credentials or live authorization state. Installed instances and status always come from the VM.
The 173-entry upstream snapshot is filtered by the plugin's WorkBuddy account-dependency
policy before browsing/search/counts: 10 managed packages are hidden, including
ima, Tencent Docs and Lexiang whose upstream entries omit auth_mode. Hiding does not delete
or disable any existing VM instance. Browser OAuth is also hidden until its flow is supported:
auth_mode oauth/mcp plus Canva CN/international and WeStock whose manifests omit auth_mode.
This hides 15 entries in total (158 visible); API-key and CLI entries remain available.
`ConnectorSession` owns a Bot/view's cancellable requests and generation fence. A 45-second
probe cannot block explicit installation; cancellation does not claim a remote mutation rolled
back. Old requests cannot publish into a replacement session. PTY command completion assembles
its marker only in actual shell output, so command echo cannot be mistaken for completion.

WorkBuddy reference: connector panel separates catalog and installed state, cards expose
name/description/status, and detail uses token-schema forms. Service icons come from the
preserved marketplace. We do not copy WorkBuddy's identity-specific authentication flows.

## Delivery

Beijing bucket: `lightvela-overmind-test-1388575217`, private bucket with public-read test artifact.
Exact content-addressed URL/checksum: `src/connectors/test-release.ts` in the Hermes plugin.
Release sources: `/data/overmind/scripts/install-hermes.sh`, `configure-hermes.py`,
`hermes-connector-skill.md`. `installer-script.ts` is generated from the installer.
Archive includes only binary, marketplace and integration scripts, never runtime state/keys.

## Deliberate limits

- Linux x64 VM only; Vela frontend supports Web and Electron.
- No WorkBuddy managed-account auth or remote OAuth callback forwarding.
- CLI terminal authorization requires a Sidecar advertising `cliAuthPty`; old releases show
  an upgrade notice. This change requires both a new Sidecar and the plugin frontend.
- UI manages one service instance per package; daemon has multi-instance identity.
- New conversation or `/reload-mcp` may be required to discover updated tools.
- Detached daemon survives page closure, but reboot supervision is not part of this prototype.
- Encrypted SQLite exists; disk-full reserve is not implemented.
- Config merge backs up existing YAML and detects edits before replacement, but does not
  constitute a universal lock against other programs that ignore the install lock.

## Verification scope

Sidecar tests exercise an actual MCP fixture through the stdio → HTTP → service chain.
Hermes config tests verify preservation, repeat installation and conflicting-entry rejection.
Plugin tests/typecheck/build verify registration and supported-flow boundaries.
An isolated installation also downloads the COS release with wget, verifies the digest,
runs the compiled daemon, repeats installation, checks icons/skills/config and calls a
fixture tool through the compiled stdio bridge. Actual user-Bot TAT installation and
external-service credentials still need an interactive smoke test.

## CLI PTY authorization

The plugin detail panel starts a daemon-owned session through the existing authenticated
TAT HTTP transport; it never sends a shell command. `POST /v1/cli-auth/sessions` takes an
existing connector instance ID; the daemon resolves the trusted catalogue command and
uses that instance's isolated HOME and environment. Installation and status checks reuse
the normal connect workflow. The authorization command runs in a real Unix controlling
PTY, created by Python (already an installation prerequisite). The helper is embedded in
the Sidecar binary; there is no native Node addon to distribute. xterm.js belongs to the
plugin view and interprets ANSI output, keyboard input and terminal sizing.

`GET /v1/cli-auth/sessions/:id` returns a bounded in-memory transcript with an absolute
UTF-16 output offset, input readiness and terminal state. The view writes only new output
to xterm; it resets the terminal if it misses the retained window. `POST .../:id/input`
accepts exact terminal input, including control characters, plus monotonically increasing
sequence; duplicates are acknowledged without writing twice. `POST .../:id/cancel` aborts
the process group and clears the transcript. `POST .../:id/resize` sets validated columns
and rows using TIOCSWINSZ. Input and resize requests are serialized by the view. Input is
not persisted; echo and password masking belong to the CLI/PTY, not a browser form.
Third-party CLI output can still contain secrets and the UI warns accordingly.

Sessions last at most 5 minutes, completed transcripts expire after another 5 minutes,
and the registry is bounded to 16 entries. Closing the view requests cancellation, while
daemon timeout protects against a disconnected browser. Authorization is not called
successful until the normal CLI status/reconcile path reports connected. No arbitrary
shell entrypoint, automatic browser opening, or localhost callback tunnelling is added.

Tests cover controlling TTY, raw arrow input, resize, transport closure, password echo,
non-execution of input, duplicate input, separate
sessions, cancellation fencing, and the authenticated HTTP → CLI → status chain with an
isolated fixture (not third-party account credentials).
