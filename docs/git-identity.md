# Managed Git identity

The optional node runtime separates account storage, execution ownership, Git
adaptation and signing. Products supply opaque account scopes and a trusted
execution resolver; the generic runtime does not infer an account from a display
name, browser body, mutable Thread mapping or previous sender.

The local Linux adapter requires Node with `node:sqlite`, Python 3 for kernel
peer credentials, `getconf`, Git 2.34 or newer and OpenSSH `ssh-keygen` for SSH
signatures. Installing the runtime does not alter global Git configuration.

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
