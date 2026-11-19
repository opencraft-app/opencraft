# IOA capabilities and persistent instance data

The internal standard Gateway composes employee Git credentials, Gongfeng MCP and
existing employee CLI public keys through the IOA plugin. No module injection,
Gateway text replacement, `NODE_OPTIONS` hook or per-build SHA pin is needed.
Generic SSH transport and native session lifecycle remain platform-owned.

## Instance-owned inputs

Keep the existing private vault, encryption key, employee SSH/CLI database, Actor
authority, admission data and execution provenance outside the image. This change
does not move them, import identities, change schema, generate/backfill keys or
copy credentials to a package. The CLI adapter selects only public key columns
from existing `employee_cli_keys`, never escrow private keys. Missing/corrupt
stores deny employee CLI access without creating an empty replacement.

Optional `<dataDirectory>/ioa-capabilities.json` is deployment-user-owned mode0600:

```json
{"schemaVersion":1,"employeeGit":true,"gongfeng":true,"employeeCli":true}
```

Absent file/fields enable these compiled capabilities. `employeeCli` only applies
when the platform has SSH ingress configured. False disables the capability;
malformed, symlinked, incorrectly owned or nonprivate configuration disables these
optional capabilities and emits a fixed diagnostic, without removing core IOA
identity/model-defaults/environment services. Configuration cannot name modules,
paths, credentials or authorization grants. Optional config is read at startup,
not hot reloaded. Once closed, retained adapters deny further use.

Employee Git uses the same vault instance/error classes as the product owner;
account scope, CAS revisions, current identity/admission and checks after async IO
remain in force. No secret is returned by status GET. Gongfeng is registered via
the existing capability provider contract, resolves credentials using immutable
execution provenance and current admitted Human authority, and does not give
pending/ended or unrelated executions invocation authority.

CLI authorization uses a read-only, zero-busy-wait query against existing data on
each check, not cached authorization. Removed keys, ambiguous names, Actor
generation and membership revocation fences deny immediately on the next check;
the existing ingress watcher retires an active connection. No automatic retry or
shared employee identity fallback is introduced. Separately configured static
operator keys retain their explicit platform ingress policy. This adapter does
not enable the separate self-service SSH escrow/key-generation endpoints.

## Upgrading a deployment with old injected fixes

Build the standard product Gateway from the committed consumer and source lock.
Keep all instance state and current per-role identities: Hands/executor root,
Gateway/Brain nonroot, Chromium separately nonroot. Do not change old cwd mounts.

Only during a separately authorized, backed-up cutover, remove the old
`container-gateway.cli-compat.mjs` entry bind and credential `--import` hook and
its obsolete hash-pin setting. Inspect merged Compose first: leaving the bind
would still run old code; leaving the loader would reject the new artifact.
Preserve unrelated loader options/overrides and other live fixes rather than
clearing all NODE_OPTIONS/mounts. Old data `ssh/legacy-ssh-access.mjs` may remain
for rollback but is no longer imported by the new product.

Check real employee Git status, current-scope mutation/revocation, Gongfeng
execution ownership, existing CLI login and key removal, core identity and model
defaults in the isolated candidate before production acceptance. Tests use local
synthetic accounts/keys; they do not access real enterprise services or send mail.
13 MCP Apps and Vela branding/application packages are unrelated and unchanged.

## Confirm the actual launched Gateway

Before removing a compatibility mount, inspect the service launcher, not just the
old `container-gateway.mjs` filename. A focused model-defaults image can select
`container-gateway.account-defaults.mjs`; the retained old mount is then inert.
Run the read-only diagnostic in the candidate/runtime filesystem:

```sh
node products/join/tools/inspect-gateway-runtime.mjs /absolute/runtime/directory
```

It records the launcher, selected bundle, retained bundle and a present credential
loader by size/SHA/owner, never imports them and refuses unknown launcher shapes,
missing/oversized selected files or symlinks instead of guessing. Presence is not
proof a loader is active: correlate `NODE_OPTIONS`, process, exact image digest,
merged mounts/environment and recovery entry separately. This inventory is not
an authorization or automatic deployment/rollback tool. Preserve all selected
software inputs and persistent state in the separately authorized backup.

## Shared conversation compatibility

The shared environment scope preserves the admitted sender/input account instead
of borrowing or requiring the immutable creator account. Private-thread access,
current employee admission, actor generation/revocation and each engine's own
execution/process fences remain independent checks. Authorized shared participants
can steer the exact active Turn and edit ordinary queued input. Steering preserves
the running account/environment; edits preserve the original queued principal.
This deliberately delegates input control over work using those credentials, not
credential disclosure or another participant's terminal. Shell/settings/review and
managed Actor inputs retain their existing owner/admission checks. New inputs use
their own credentials at execution. Existing terminals retain their original scope. Deploy matched Gateway and execution-owner artifacts;
a Gateway-only scope change is not full runtime compatibility. See assembled
`docs/account-environment.md` for anonymous/legacy and first-turn boundaries.
