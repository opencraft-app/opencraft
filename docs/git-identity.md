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
any binding requires a known execution attribution. Unknown attribution and
broker outages fail after bounded lookup retries. Git itself is never replayed.

## Execution context, not live authorization

`OPENCRAFT_EXECUTION_ID` is an opaque execution locator, not a credential. The
Host records immutable input ownership before dispatch. Pi/DSH process snapshots
carry that ID automatically; each snapshot key includes the execution so workers
from a previous run keep their own locator. Nothing is added to model prompts or
Git command arguments, and shared `process.env` is never changed.

The wrapper sends the ID with its existing broker request. An indexed lookup of
execution ID plus Thread ID reads the original accepted principal from the
existing Host store. Suspended, unknown or completed execution state does not
change attribution. Git does not read native Turn status or reconstruct history.
The adapter retains its legacy internal `active` result spelling for a resolved
binding; it no longer means that the native Turn must still be running.

Older engines, including an already-running Codex generation, may only expose
`CODEX_THREAD_ID` or `OPENCRAFT_THREAD_ID`. Their first lookup reuses the existing
kernel peer/command-birth locator to select the original immutable execution
interval. It never selects the latest sender. The wrapper then passes the
resolved `OPENCRAFT_EXECUTION_ID` into native Git and hooks; subsequent signing
and credential requests resolve that same ID directly. Boundary ambiguity and
missing attribution remain errors. A wrong explicit ID never falls back to a
newer execution or another user.

This replaces the earlier requirement to revalidate a live Turn for Git. Other
platform tools retain their existing execution-authority rules. Git account
admission, credential revisions, command expiry and process-scoped helpers still
apply, while application recovery is outside attribution lookup. This mechanism
provides convenient account selection in a shared trusted runtime, not isolation
against malicious code running under the same Unix account.

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

## Lookup recovery and diagnostics

Authorization lookup has a 15-second monotonic budget including IPC time and
exponential backoff (100ms up to 1.6s). Only lookup is retried; Git is invoked once
after authorization. Expired command capabilities, changed credentials and invalid peer/request
fail immediately. Every retry resolves the original execution attribution; no latest-user mapping
is substituted across an application restart. A process health
reply therefore does not promise that a particular execution can be authorized.

IPC distinguishes timeout, disconnect, connection failure and invalid responses.
The broker keeps the existing status contract and adds controlled reason codes
for unavailable attribution and legacy origin lookup. Failure logs carry
a generated request ID, operation, peer PID and duration; the client reports that
ID with the final reason. Arbitrary error messages, credentials, account records
and request bodies are never logged. Lease recovery diagnostics separately carry
thread ID, request ID, phase and duration. These IDs diagnose a failure; they are
not authorization evidence. A later lookup always validates current authority.

A separately installed broker and stable Git launcher must be updated explicitly
from a fixed managed artifact. Updating the application alone does not update
either independent runtime. Existing in-flight capabilities are retired if the
broker restarts; the next command opens a new capability after full validation.

Lease recovery schedules unsettled conversations by their most recent admitted
execution, with a stable thread-ID tie break. This is scheduling only: old leases
are still scanned and every lease needs native confirmation. Admission timestamps
are never used here as evidence for credential authorization. This avoids making
a current command wait behind hundreds of historical unresolved conversations.
