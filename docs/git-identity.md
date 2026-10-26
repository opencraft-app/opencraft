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

`GitIdentityBroker` returns `configured`, `unconfigured`, `unavailable` or
`expired`. Only an authoritative absent binding or explicitly unowned execution
allows the original server environment. Unknown ownership and broker outages
fail after bounded lookup retries. Git itself is never replayed. The Linux IPC
bridge obtains PID/UID using `SO_PEERCRED`; the resolver attests native process
ancestry and birth time against the existing engine registry and immutable
execution intervals. A Thread ID is a locator, not authority. Long-lived tool
bridges do not supply the birth time of a later command. Boundary ambiguity or
an unrecognized engine fails closed.

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
explicit submodule repository. Redirects, embedded URL credentials and personal PAT authentication through
SSH remotes are rejected; use a matching HTTPS remote. Multiple or absent local
identity profiles require an unambiguous managed remote. An unconfigured command
keeps its original environment in full.

New commits use the configured author and committer. Amend, rebase, cherry-pick,
and am preserve authors and set the committer. Revert creates a new commit with
the current employee as author and committer. GitHub-compatible SSH
signing uses an Ed25519 key held only in broker memory and an ephemeral
`SSH_AUTH_SOCK`. The agent signs only Git SSHSIG payloads. The private signing
key never has a filesystem projection; a killed broker can leave a socket but
cannot leave a temporary private key. Expiry, configuration rotation, process
exit and close retire command capabilities.

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
