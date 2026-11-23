# Managed Git identity

The optional node runtime separates account storage, execution ownership, Git
adaptation and signing. Products supply opaque account scopes and a trusted
execution resolver; the generic runtime does not infer an account from a display
name, browser body, mutable Thread mapping or previous sender.

The local Linux adapter requires Node with `node:sqlite`, Python 3 for kernel
peer credentials, `getconf`, Git 2.34 or newer and OpenSSH `ssh-keygen` for SSH
signatures. Installing the runtime does not alter global Git configuration.

The installed Git launcher supplies its fixed managed paths, broker socket and
host policies on every invocation. Command runners may filter inherited
environment variables, so a parent environment file alone is insufficient.
Thread and execution locators remain inherited and are never supplied by the
installation; the broker still resolves employee identity from trusted records.

`EmployeeGitVaultStore` owns `employee-git-vault.sqlite` and its separate 32-byte
owner-only key. Managed schema v1 stores an encrypted document per account and
exact host. AES-256-GCM authenticates an unambiguous version/account/host/field
tuple. A missing key on a nonempty database fails recovery. Clearing retains a
revision tombstone, so a stale writer cannot recreate an earlier generation.
Only sanitized status, identity and public signing metadata reach the browser.
Managed data-directory aliases resolve once to the existing private directory;
database and key files still refuse symlinks and retain owner-only permissions.

`GitIdentityBroker` returns `configured`, `unconfigured`, `unavailable` or
`expired`. Only an authoritative absent binding or explicitly unowned execution
allows the original server environment. Before origin lookup, the broker
permits the original environment if a metadata-only query proves there are no
configured accounts for that exact host. Unbound commands therefore do not wait
on execution adapters. This is checked on each command; adding
any binding immediately requires attested account lookup again. Unknown ownership and broker outages
fail after bounded lookup retries. Git itself is never replayed. The Linux IPC
bridge obtains PID/UID using `SO_PEERCRED`; the resolver attests native process
ancestry and birth time against the existing engine registry and immutable
execution intervals. A Thread ID is a locator, not authority. Long-lived tool
bridges do not supply the birth time of a later command. Boundary ambiguity or
an unrecognized engine fails closed.

The native adapter fixes the tool-root Thread field (`CODEX_THREAD_ID` for
Codex, `OPENCRAFT_THREAD_ID` for local engines). The resolver reads it from the
attested tool root's kernel environment and checks it against the locator before
querying a lease. Missing, duplicated or mismatched metadata stays unknown, so
concurrent Threads in one native cannot select each other's overlapping interval.
This check assumes the stated trusted-maintainer boundary; it is not protection
against a same-UID adversary deliberately replacing the root environment.

Origin readers advertise `originClock: 'boot-monotonic-v1'` and match the
attested boot ID and process birth ticks against intervals from that same boot.
Legacy wall-clock records cannot authorize personal credentials: clock changes
must not move an old tool into another execution. Personal credentials and each
signature also require a live read of the original native Turn; a stale SQLite
active row after Gateway loss is insufficient. Command expiry uses monotonic time.

Each configured command receives an expiring capability bound to its process
tree and account generation. Its credential helper resets inherited helpers,
headers and cookies for that command and returns a PAT only for the exact HTTPS
host. Inherited global and URL-scoped usernames are replaced by the employee
identity. Client-certificate authentication conflicts are reported before network
execution, because an empty certificate setting does not disable it in Git.
A command-private empty HOME prevents libcurl from authenticating with the
server's netrc before Git calls its helper; global Git policy is included by
read-only path references. No original global file is changed. Hooks share that
command-private HOME. The directory contains no token or private signing key.
Fetch/pull use their fetch remote, while push and local commit profiles follow
push-remote selection. Explicit URLs honor insteadOf and pushInsteadOf before
authorization. Configured submodule network commands require executing in the
explicit submodule repository. Canonical `git@host:path` and `ssh://git@host/path` addresses for a bound host are rewritten to HTTPS for that command only; the repository remote is retained. Noncanonical SSH identities/ports, aliases, conflicting preexisting rewrites, redirects and embedded credentials are rejected. SSH transport remains disabled for a configured command, so unavailable personal authentication cannot select a machine SSH key. Multiple or absent local
identity profiles require an unambiguous managed remote. An unconfigured command
keeps its original environment in full.

Deployments may explicitly opt exact managed hosts into `serverReadHosts` when
personal HTTPS Git is unavailable but the server has established SSH read access.
The rendered launcher exports `OPENCRAFT_GIT_SERVER_READ_HOSTS`, so callers using
the stable launcher receive the policy without restarting execution owners. The
default remains personal HTTPS. For configured, attested commands on those hosts,
`clone`, `fetch`, `pull` and `ls-remote` use canonical SSH and the original server
HOME/SSH agent. Canonical HTTPS URLs are rewritten for that invocation only.
This is a deliberate read-access policy, not a retry after authentication fails;
it grants the server account's read access and does not prove employee read
permissions. Repository/global configuration stays unchanged. Recursive CLI/configuration is
rejected; implicit fetch recursion is disabled, so each submodule must be read in
its own explicit managed repository. Preexisting URL rewrites are rejected before
networking rather than relying on a second native rewrite. Pull-created commits
retain personal identity and signing, with a signing-only program selecting the
personal agent independently from SSH transport. Push and local writes retain
personal authentication and never enter server SSH. Unknown ownership and expired
leases still fail closed; unconfigured commands retain their original behavior.

New commits use the configured author and committer. Amend, rebase, cherry-pick,
and am preserve authors and set the committer. Revert creates a new commit with
the current employee as author and committer. GitHub-compatible SSH
signing uses an Ed25519 key held only in broker memory and an ephemeral
`SSH_AUTH_SOCK`. The agent signs only Git SSHSIG payloads. The private signing
key never has a filesystem projection; a killed broker can leave a socket but
cannot leave a temporary private key. Expiry, configuration rotation, process
exit and close retire command capabilities. A broker restart also retires all
command capabilities and signers. A subsequent Git invocation in the same live
execution opens a new capability from persisted bindings and execution evidence;
an already running Git command is never replayed.

This is an identity convenience for trusted collaborators sharing a system UID.
Owner-only files and process-scoped sockets do not isolate mutually hostile
processes under that UID. PATH adaptation is intentionally opt-in and can be
bypassed by explicitly invoking another Git implementation. Remote hosts need
their own trusted runtime and are outside the local socket contract.

Products own account validation, membership rechecks, remote key registration
and environment deployment. Public-key registration must occur outside SQLite
transactions and reconcile uncertain prior results before retrying. Public
registration, a configured token and a verified commit are separate observations.

Run `npm run test:git-identity` for synthetic storage, IPC, author and signature
tests; no real token or account is used by these tests.


Optional personal SSH push authentication is separate from Git SSHSIG signing.
Products can set `personalSshPushHosts` in the installation renderer; the stable
launcher projects this policy to existing callers. A bound account on those hosts
must explicitly create an `sshAuth` key before pushing; no HTTPS token fallback
is attempted. Products own the explicit generation/rotation/deletion operation
and manual public-key registration. The encrypted credential document stores
optional authentication metadata without changing the managed SQLite schema.

A push capability may expose a public key and an expiring memory-only userauth
agent. It never returns the private key. The agent accepts only Ed25519 publickey
userauth for user `git` and service `ssh-connection`, rechecking the original
command authority and vault revision on each signature. It cannot sign Git
SSHSIG or arbitrary payloads. Reads retain their configured transport policy.
Canonical HTTPS URLs are rewritten to canonical SSH for that command; inherited
rewrites are rejected. OpenSSH ignores user configuration and inherited agents,
selects only the command public key/agent, keeps strict host-key verification,
disables interactive authentication and forwarding, and never falls back after
failure. Only a public key has a temporary filesystem projection. Unconfigured
employees retain the original environment. The trusted shared-UID boundary above
still applies to authentication sockets and encrypted storage.


Deployments can restrict bearer-token delivery with `httpsCredentialHosts`. Hosts outside that allowlist never receive an HTTPS credential, including while an old token is being retired. An explicit `sshAuth: null` record can retain identity metadata before an SSH key is generated; it does not contain an authentication token or generate a key.


## Execution-attested personal Git protocol

The execution-owned protocol-2 deployment is described in
[Personal Git execution credentials](personal-git-execution.md). Its sealed
lease-generation attestation, issuer/execution/status roles and verified replica
discovery are distinct from the older PID-origin broker described above. It does
not install or revive the legacy systemd broker, does not recover protocol-1
in-memory grants after owner loss, and does not enable server-account fallback.
Binding inspection alone is not a Git command-path health check. Rollout needs
matched Gateway, execution owner and wrapper builds; source tests alone do not
establish production deployment or remote Git availability.


## Native Human / Actor execution handoff

The default Headless account composition uses the **same** encrypted Assets
Worker for configuration and Actor-scoped Git grant issuance. Its compiled
`assets-runtime` entry adds a read-only view of the existing immutable execution
leases, Actor bindings and membership audit. It opens no replacement identity or
lease store, runs no migration and creates no second vault writer. The ordinary
Desktop Assets Worker has no execution resolver and cannot issue these grants.

The private `executionGitGrant` owner method accepts only a Host and Thread with
exactly one original input or native Turn selector. A Turn selector resolves its
original input from the existing unique native lease, never the latest message.
It derives the canonical `actor:human://…` partition from the
persisted original execution principal, never from JSON account/email/username.
The existing admission path snapshots the verified Human Actor ID and generation
alongside that provider principal in the existing submission JSON. A later login
binding reassignment cannot transfer an old execution to its successor Human.
Historical submissions without this original Actor provenance are not backfilled
on replay and cannot acquire Actor-scoped Git credentials; a newly admitted input
is required. Likewise, disabling and re-enabling an Actor requires a new input
with the new generation, not merely preparing another capability for the old one.
It is **not** an HTTP action or a browser tool. Its result contains only scope,
native incarnation/Turn evidence, an authority fingerprint and a sealed
attestation: no PAT, private signing key or vault key crosses into Gateway Main.
The trusted Main adapter separately rechecks the existing `InstanceAccess`
admission policy and Actor generation before and after bounded native history
inspection; it does not invent a second membership policy or require a new
Actor-membership row where the core already admits a verified binding.

Actor attestations use the v3 authenticated envelope and bind Actor generation
and the existing membership-revocation revision as well as exact execution ID,
original input and lease generation. Disable/enable between polls cannot revive
an old capability. Legacy provider-partition v2 envelopes keep their original
format and behavior. Actor and provider-partition broker discovery use distinct
authority fingerprints; a legacy replica cannot silently stand in for an Actor
replica with a different account mapping.

The Actor-mode broker requires a bounded parent liveness port on each open,
credential read and signature. The parent rechecks the same sealed scope and
reads the original native Turn, then the Worker rechecks lease, Actor/membership
and credential revision after that await. Stale SQLite active rows, an unavailable
parent/native observer, a successor Turn or an authority change fail closed.
Retiring a view does not cancel an admitted Turn, but retiring the execution owner
closes its broker and cannot start an orphan after an awaited native inspection.
Git commands and unknown effects are never automatically replayed.

The Assets Worker explicitly declares only its synchronous, non-mutating grant
read as reentrant. It may read committed state while remote GitHub verification
waits, without waiting behind that network request. Configuration mutations and
ordinary snapshots remain FIFO; close drains both lanes. No SQLite transaction
spans the provider await. A committed credential revision still retires an older
command even if its authorization read was admitted before the write completed.

`PiDurableSession` consumes this asynchronous port at the actual bash boundary.
It strips only its own Turn-scoped request-ID prefix to recover the original
admitted input, preserves background-command ownership, and refuses unknown
preparation rather than using the server credential. The current default wiring
covers **in-process Headless Pi** and independently owned Pi configured with
`executionContext: "assets"`, using the packaged Git runtime. The trusted adapter
supplies its actual Node executable for npm-style packages without `bin/node`.
DSH uses the same port at its native bash/PTY boundaries as described below.
Native Codex consumes a pre-submission reservation through its existing native
shell environment policy, as described below. A saved connection alone does not
prove deployment support. No deployment or sandbox isolation claim is made.

`tests/identity/assets-execution-git.test.ts` uses a real Human/account and HTTP
save, sole vault Worker, managed Git launcher, actual SSH signature verification,
and a native Pi bash tool with a synthetic model. GitHub responses are synthetic:
no real account, token or remote key is used. It also covers native-liveness loss,
Actor/membership disable-enable cycles, the absent public grant action, retirement
during preparation and held-provider-IO responsiveness.


### Independently owned Pi and DSH

Unix IPC has a byte-length limit independent of deployment directory length.
The broker budgets the complete UTF-8 signer socket path, not just `broker.sock`.
When necessary, only its IPC endpoints move to a deterministic, UID-scoped
0700 namespace under `/tmp`; encrypted data, trust policy and authority-checked
discovery metadata remain in the canonical runtime. Symlink/foreign/permissive
roots and an already claimed owner are refused. Closing an owner removes its
socket directory, without removing a live peer. Consumers must share the IPC
filesystem namespace; container deployments should mount the canonical runtime
at a short shared path rather than depend on another container's private `/tmp`.

The compiled native owner uses the existing private session-capability attachment
and loopback listener for `/host-git`. Its `host-git` HMAC audience is distinct
from MCP sessions, native tools and model-visible CLI credentials. The request
contains no body scope: Server, Thread and exactly one original input or native
Turn selector come from signed Host
claims. Gateway maps the installed Server back to its physical Host and repeats
the same existing Actor/membership and bounded native Turn checks before returning
only the sealed Git handoff and deployment fingerprint. No credential key, PAT or
private signing key crosses that listener; it is not a browser endpoint or a tool.

The native Pi owner retains its own read-only execution broker and checks its own
process incarnation. On each authorization it rediscovers the current owned
Gateway descriptor and rechecks the exact execution, Actor and membership epochs.
It pins the authority/Host list once in use, aborts pending reads on retirement,
and refuses mismatched successors. Gateway loss fails closed. Recovery permits a
later explicitly invoked command with retained valid evidence; it never replays
a running or uncertain Git operation.

New container Pi/DSH assembly defaults `OPENCRAFT_EXECUTION_CONTEXT=assets`, selects
`executionContext: "assets"` and its
packaged Git Worker, so that owner does not open `ExecutionEnvironmentRuntime` or
create another writable vault. An absent mode retains historical legacy product
configuration; `OPENCRAFT_EXECUTION_CONTEXT=legacy` explicitly retains that existing
product ENV/Git owner instead. This selects assembly, not an authorization fallback
or an automatic credential-partition migration.
There is no runtime sniffing, fallback between modes or shared second writer in
Assets-mode Pi or DSH. This is a trusted same-machine, same-UID attachment, not a remote
network credential protocol or hostile-process isolation. Native Codex stock
combined-Core execution is covered below; routed/four-role acceptance is separate
and must not be inferred from same-namespace verification.

DSH's existing generation resolver projects the exact live Agent's open native
Turn to its public `dsh-turn-<thread>-<turn>` alias. It never takes a later steer,
queue message or model-selected input as the credential owner. Preparation checks
the registered Agent reference and native generation before and after awaiting
the Server; cancelled/replaced executions cannot publish an environment. The
pinned SDK patch awaits this port in the existing async bash tool and terminal
backend before foreground, background-job or PTY allocation. Its synchronous
`shellEnv` contributors remain synchronous. The SDK's approval, sandbox,
subprocess, job and terminal owners are unchanged; packaging refuses SDK drift
and includes this transformation in the runtime cache key.

A background process or persistent PTY retains its creation-Turn provenance;
it cannot adopt a later sender's credentials. Git operations fail closed when
that Turn ends or its admission is revoked. For Git in a later Turn, create a
new terminal under that Turn. Automatic credential rebinding of a persistent
shell is **not implemented** and must not be inferred from terminal reuse.

For installed-runtime verification, set `OPENCRAFT_DSH_RUNTIME` to a read-only
installation matching `runtime/dsh/package.json` and run
`npm run test:git-identity`. Tests transform isolated SDK entry copies, exercise
native foreground/background/PTY paths with a synthetic provider and the real
Assets Worker, and verify SSH signatures and cancellation. They do not modify
the reference installation or call a real GitHub account.


An explicitly configured anonymous installation answers with a separate
`mode: "anonymous"` status and no credential authority. This preserves ordinary
anonymous shells without inventing a Human grant or opening a vault on the native
owner. It is never inferred from a missing login or failed issuer. Once a native
broker has pinned a credential authority, an anonymous response is a refused
downgrade, not fallback. Invalid, unavailable and revoked replies always fail.

### Codex pre-submission configuration

Codex installs shell environment policy before `turn/start`, unlike the Pi/DSH
per-tool boundary. The compiled Host may reserve a sealed Git scope for the exact
accepted original input's **pending** lease and verified native incarnation.
Reservation is not execution authority: every actual broker operation still
requires that same lease to have an independently verified active native Turn,
with current Actor/member epochs. Pending, ended, revoked and replaced scopes
cannot obtain credentials or signatures. No additional identity ledger or vault
writer is introduced, and reservation is not a browser-facing Assets action.

The adapter derives its native identity from the managed child process, or fresh
authenticated Core health observations; cached environment
configuration and last-sender state are not provenance. A configuration refresh
uses the existing native unsubscribe/resume lifecycle and preserves permissions,
model settings and sandbox policy. It never launches a substitute executor.
Git-bearing ephemeral Threads are explicitly refused until their native owner
can install this policy without a persistent-thread resume; unowned internal
Threads do not borrow another participant's Git configuration.

Installed stock Codex can be verified with `OPENCRAFT_TEST_NATIVE_CLI` pointing to
an installation matching `runtime/codex/package.json`, then running
`npm run test:git-identity`. The opt-in tests use synthetic model/account responses
and the real native `exec_command`, create and verify SSH-signed commits, retain
the original Human after Gateway replacement without restarting Core/Turn, and
deny retained credentials after native completion. No real provider account or
GitHub token is used. Verification deliberately selects unrestricted fixture
permissions; it does not assert sandbox containment.

Gateway replacement reattaches a read-only broker only after reconciling the
existing original lease against live native history. It never replays an input,
resumes or reconfigures an active Turn, or binds a newer sender. Credentials deny
while the broker/authorization owner is unavailable; this is not a guarantee of
Git availability throughout Gateway downtime.

When `OPENCRAFT_GIT_RUNTIME_DIRECTORY` configures the shared mount, Assets brokers
use stable per-observer `gateway`, `codex`, `pi` and `dsh` subdirectories. This
makes retained command paths visible at the same absolute path in Hands without
mounting the vault there, and avoids selecting another native observer's broker.
An explicitly shared directory whose full signer socket path exceeds the budget
is refused, not silently moved into container-private `/tmp`. Local installations
without that setting retain their existing directory/fallback behavior. The
existing `compose.personal-git.yaml` overlay supplies the shared mount; it does
not transfer the vault or keys to Hands.

Actual four-role namespaces, routed native generation replacement, and ephemeral
personal Git remain separate acceptance work. A combined-Core stock test is not
proof that every Codex deployment uses Assets Git end to end.
