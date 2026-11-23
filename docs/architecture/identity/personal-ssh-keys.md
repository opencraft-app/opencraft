# Personal SSH keys

Status: implemented in Headless (Server migration v26, `0025_actor_ssh_keys`).

Each Human Actor can register their own SSH public keys. An SSH login with one
of them through the Headless SSH ingress (`--ssh-config`) carries that person's
Actor, exactly as their Web login does. Keys belong to the Actor, not to a
login method: every verified identity bound to the same person sees the same
keys.

## Model

- **Owner.** `opencraft-server.sqlite` tables `actor_ssh_keys` and
  `actor_ssh_key_audit`, written only by `actorSshKeyMethods`
  (`@opencraft/storage-node/server-actor-ssh-keys`) in the Server owner Worker,
  or by the offline `ssh-keys` tool holding the installation writer lock.
- **Key.** One OpenSSH public key: `ssh-ed25519`, `ecdsa-sha2-nistp256/384/521`
  or `ssh-rsa` of at least 2048 bits (`parsePersonalPublicKey`,
  `@opencraft/ssh-http-ingress/keys`, the same ssh2 parser the ingress verifies
  with). Stored normalized without its comment, with its OpenSSH `SHA256:`
  fingerprint and a name (the comment when none is given). DSA, certificates,
  `authorized_keys` options and private keys are refused. At most 32 active
  keys per person.
- **Uniqueness.** An active fingerprint belongs to at most one Actor (partial
  unique index). Registering it again is `key_exists` for the same person and
  `key_in_use` for anyone else. A removed key may be registered again.
- **Revocation.** Removal never deletes a row; it sets `revoked_at/by/reason`.
  A key records the Actor generation it was added under. The network thread
  revokes durably, with operator `system`, when the Actor is disabled
  (`actor-disabled`), its generation changed while the server was stopped
  (`actor-generation`), it no longer exists or is not human, or its instance
  membership is explicitly revoked (`membership-revoked`). Re-enabling or
  re-granting never revives a key; the person registers it again. A person who
  merely lacks admission (for example an admission policy refusal) is refused
  at login without losing keys.
- **Audit.** Every add, import, removal and revocation, and every refusal the
  owner saw (`key_exists`, `key_in_use`, `key_limit`, `unknown_key`), is one
  `actor_ssh_key_audit` row with time, operator, Actor, key id, fingerprint,
  action and result. Key material is never written to the audit. Operators are
  `actor:<id>` (self-service), `administrator:<id>`, `local-operator` (CLI),
  `import:<source>` and `system`.

## Hot path and the network thread

`ActorSshKeys` (`apps/headless-server/src/actor-ssh-keys.ts`) loads the active
rows once from the owner Worker and keeps an in-memory projection keyed by
fingerprint and Actor. It never opens SQLite.

- SSH authentication (`publicKeys(username, offeredKey)` and
  `authorize(username, offeredKey)`) hashes the offered key, looks it up in the
  projection and rechecks the Actor's current state from the existing Actor and
  membership projections: enabled Human, same generation, current instance
  admission. The SSH user name is not significant; the key identifies the
  person.
- Writes go to the owner Worker in FIFO order. A key appears in the projection
  only after its commit. A removal leaves the projection before the commit, so
  the key stops authenticating and open SSH sessions end (the ingress polls
  `isCurrent()`) immediately.
- A failed commit or a lost owner Worker fences the projection: every key is
  refused until restart; nothing falls back to main-thread SQLite.
- `authorize` returns a scoped submission context: `actorContext` (Human,
  `credentialId: null`, 24-hour bound), `resourceOwner`, `tokenUsageAuthority`
  and, for a person with exactly one verified identity, that identity as
  `executionPrincipal`. Scoped keys never enter the unscoped legacy HTTP bridge.

The ingress consults an identity composition's own `sshAccess` first, then
personal keys (`composeSshAccess`). It now passes the offered key blob to
`resolveAuthorizedKeys`, so a key-indexed resolver answers without listing every
key; existing resolvers that take only the user name are unaffected.

## HTTP API

`/__opencraft_ssh_keys` (Headless core route). The Actor always comes from the
verified login; Sessions, non-humans and people without instance admission get
403, no login 401, a failed owner 503.

| Request | Effect |
| --- | --- |
| `GET` | `{actorId, subjectActorId, administrator, sshLogin, keys}` for the signed-in person. `sshLogin` says whether this server accepts SSH at all. |
| `GET ?actorId=` | Another Human's keys; administrators only. |
| `POST {publicKey, name?, expectedActorId, actorId?}` | Adds a key (201 `{key}`); same-origin JSON only. `actorId` names another Human for an administrator. |
| `DELETE /<keyId>?expectedActorId&actorId?` | Revokes one key (204). |

`expectedActorId` only fences an account change (409 `account_changed`). Key
views carry id, name, algorithm, fingerprint, creation time and who added it,
never the key body.

## Self-service Settings page

Headless Web builds show **Settings → SSH keys** next to Server information
(`apps/workbench-web/src/components/ssh-keys-settings.tsx`), built from the
shared Settings controls and the Web locale catalogs. It lists the person's keys
with their fingerprints, adds a pasted public key with an optional name and
removes keys with per-row progress. Refusals use a reserved validation slot;
a failed removal uses the Workbench notification. It tells people when the
server does not accept SSH yet. `npm run smoke:ssh-keys` exercises it in
Chromium at 1280 px pointer and 390 px touch, light and dark, against the real
route and owner Worker.

## Operator CLI

`ssh-keys` works offline like `human-account` and `access-admin`: stop the
Headless Server of the same data directory first.

```sh
# Source checkout: npm run ssh:keys -- <arguments>
# Linux package:   bin/node runtime/ssh-keys.mjs <arguments>
node runtime/ssh-keys.mjs /srv/opencraft-data list    --local alice
node runtime/ssh-keys.mjs /srv/opencraft-data add     --local alice /srv/keys/alice.pub "Work laptop"
node runtime/ssh-keys.mjs /srv/opencraft-data remove  --actor human://… KEY_ID
node runtime/ssh-keys.mjs /srv/opencraft-data history --binding PROVIDER SUBJECT
node runtime/ssh-keys.mjs /srv/opencraft-data audit   [--local alice]
node runtime/ssh-keys.mjs /srv/opencraft-data import  /srv/opencraft-private/keys.json [--dry-run]
```

People are selected by stable identity only: `--actor ID`, `--local USERNAME`
(local account) or `--binding PROVIDER SUBJECT`. The operator is trusted, so
the CLI requires an enabled Human that is not explicitly revoked; logins still
require instance admission.

## Adopting an existing key store

A deployment that kept its own per-person SSH keys exports the active public
keys to the neutral import document and runs `ssh-keys import` once (it is
idempotent, so it can be repeated after a later export):

```json
{ "format": 1, "source": "previous-store",
  "keys": [
    { "actorId": "human://…", "name": "laptop", "publicKey": "ssh-ed25519 AAAA… c",
      "createdAt": 1700000000000, "actorGeneration": 3 },
    { "binding": { "provider": "PROVIDER", "subject": "SUBJECT" }, "publicKey": "ssh-ed25519 AAAA…" } ] }
```

- Each entry names the person by `actorId` or by a verified `binding`; the file
  must be private (owner-only, at most 1 MB) and holds public keys only.
- `actorGeneration`, when the source recorded it, refuses keys whose Actor was
  disabled and re-enabled since (`stale-generation`).
- Every key goes through the same validation, uniqueness, limit and audit as
  any other (`import` action, operator `import:<source>`). The report counts
  `imported`, `already-present`, `unknown-actor`, `stale-generation`,
  `key_in_use`, `invalid_ssh_key` and the other refusals per entry; `--dry-run`
  writes nothing.

A store that already keys rows by the core Actor id can be exported with one
query, for example with the `sqlite3` shell:

```sql
SELECT json_object('format', 1, 'source', 'previous-store', 'keys', json_group_array(json_object(
  'actorId', actor_id, 'name', name, 'publicKey', public_key,
  'createdAt', created_at, 'actorGeneration', generation)))
FROM previous_ssh_keys WHERE revoked_at IS NULL;
```

After a verified import the deployment removes its own `sshAccess` resolver,
key-management CLI and audit tables; core then serves registration, logins,
administration and audit. Anything that is not a person registering a public
key, such as server-generated key pairs with escrowed private keys, stays with
the deployment and can keep using its own `identity.sshAccess`, which core
still consults first.
