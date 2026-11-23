# Personal Git execution credentials

The existing account vault remains the sole credential store. The trusted owner
issues an opaque execution attestation, not a private credential. Git reads and
writes use the admitted account's SSH authentication agent; repository-local
`core.sshCommand` cannot select an old machine key. The separate Gongfeng MCP
token is not required for Git SSH.

## Owners and admission

`PersonalGitEnvironment` has three explicit roles:

- `issuer`: the identity Gateway seals admitted execution evidence. It owns no
  Git command Worker or signer; replacing it cannot close an execution's agent.
- `execution`: the execution owner hosts the read-only authority/credential Worker,
  serves command agents and publishes a private ready descriptor.
- `status`: a metadata-only Worker checks binding state. It cannot serve command
  opens and is never advertised as an execution endpoint.

Protocol 2 seals account, host, thread, input, execution and lease generation with
AES-256-GCM and a distinct AAD using the existing vault key. It carries no private
key or Git token and is not a bearer replacement for current lease checks. The
Worker requires accepted human admission, enabled account/membership, active
lease, matching generation and native turn/incarnation, and current credential
revision before use and on each signature. Preparing another input does not
revoke an unrelated active lease. Creation/catalog scopes cannot mint grants.
The first admitted native input refreshes its Git environment even when the
creator and sender are the same account. Native configuration waits for readiness;
a failed preflight rejects before dispatch rather than pretending input was sent.

An installation with a separate vault owner signs grants there instead:
`PersonalGitSealPort` (`{ authority, seal(scope): Promise<string> }`, subpath
`personal-git-seal`) is served by the core vault-owner Worker
(`environmentDelivery: 'opaque'` without an identity port) or supplied by an identity composition
as `ExecutionEnvironmentRuntime`'s `gitSeal` option. The owner seals only its own
durable admission and the caller rechecks after the await; grants are
byte-compatible with in-process ones. See
[ENV launch delivery](../execution/environment-launch-delivery.md#core-vault-owner-issuer).

An identity composition that owns the vault Worker and supplies
`identity.environmentLaunch` gives Headless its Git execution owner as
`environmentLaunch.git = { hosts, authority, grant(locator), reservation(locator) }`,
the members the core assets Worker offers (`gitHosts`, `gitAuthority`,
`executionGitGrant`, `executionGitReservation`). Headless composes the Gateway
owner (DSH `hostGit`, the Git status tool) and the Codex adapter's
`createExecutionGit` from it with the same live Actor and native-process checks
as for the core Worker. One installation has one Git owner: a `git` beside core's
assets vault is refused. With a split Codex Core, a vault owner without a Git
owner fails startup instead of running Codex Turns without personal Git.

Workers query vault/lease stores off the routing event loop. No private key is
exported to command environment, files, responses or image layers.

## Discovery and recovery

Native Codex receives the sealed grant and locator through its existing per-thread
shell environment policy. The launcher and Worker are shipped with the runtime.
Use `OPENCRAFT_GIT_RUNTIME_DIRECTORY` at the same path for participating owners;
`OPENCRAFT_GIT_HOSTS` remains deployment-owned. Discovery checks private ownership,
file/socket types, protocol and the injected installation authority, then performs
a bounded ready handshake. It never selects an arbitrary or newest owner socket.

Retained protocol-2 environments can open a new command through another ready
execution replica with the same authority, without changing account or lease.
The Worker still rechecks current durable execution evidence. A command already
opened stays pinned to its original signer; losing that execution owner may fail
that command, and neither wrapper nor discovery replays native Git. Replacing
only Gateway is not such an execution-owner change.

Open retries use one request ID and reuse the same command session. Capacity is
reserved before asynchronous agent creation (128 per Worker), disconnected
undelivered opens are reclaimed, close clears the cached result, and expiry or
revocation retires agents. Readiness, IPC and shutdown all have bounded waits.

Unknown SSH host keys use accept-new with a persistent deployment-owned
known_hosts file; changed keys remain rejected.

## Failure meaning and deployment boundary

`unbound` is an absent personal binding; expired admission is not a transport
outage. Missing/refused/denied sockets, request timeouts, malformed replies,
capacity, agent and authority-store failures have separate sanitized reasons and
correlation IDs. Do not log capabilities, credentials, accounts or filesystem
paths. Binding status explicitly reports that no command probe was performed.
Unavailable personal Git does not trigger a machine-account fallback. Existing
operator-selected `serverReadHosts` policy is separate and is not enabled here.
No Git operation with an unknown outcome is automatically replayed.

This is a matched Gateway/Brain/wrapper protocol change. Old protocol-1 grants
were process-local and cannot be reconstructed after their owner disappears;
the deployment must prepare fresh execution grants through the ordinary admitted
refresh, not claim that legacy ongoing environments automatically migrated.
Images/rollout and real remote Git acceptance must be verified separately.

The intended credential boundary mounts only the private socket directory into
Hands, never vault files. A compatibility deployment with root Hands and a broad
`/data` bind can still expose the vault through that alias: socket checks do not
fix that filesystem boundary. Removing it requires a legacy-cwd/mount migration,
not an unreviewed permission change. This implementation uses same-host Unix
sockets; isolated/remote E2B transport remains a separate adapter concern.

Focused checks: `tests/identity/personal-git.test.mjs`,
`tests/identity/git-identity-ipc.test.ts`, the execution-environment tests, and
`tests/execution/codex-engine-adapter.test.ts`. Synthetic native-Git fixtures are
not an assertion that production credentials or a remote Git host were exercised.
