# Native group lifecycle (v1)

The native channel owns group identity, membership and lifecycle. An optional
transport mirrors provider facts; it is not the lifecycle authority. Direct
conversations are not covered by these group commands. Ownership transfer is not
implemented.

## Three separate intents

- **Hide from Inbox** changes one authenticated actor's durable list preference.
  It synchronizes across clients without removing membership, unread facts or
  history. New traffic does not unhide it. An authorized direct link can still
  open the group, where **Show in Inbox** restores the list entry. This is not
  deletion or archive. It also removes the actor's Inbox projection row via its
  usual tombstone.
- **Leave group** is a self-service action for ordinary members, without owner
  approval. The owner cannot leave. Leaving deletes the member's current epoch
  and fences their reads, search, downloads, writes and group-scoped requests.
  Other members, other groups, Bots and environments remain intact. A durable
  departure fence prevents provider roster replay from silently readmitting the
  actor. An explicit native owner invitation is new membership authority with a
  new epoch; it does not revive old execution/delivery grants.
- **Dissolve group** is owner-only and terminal. Confirmation includes the observed
  revision. Name and membership changes advance that revision; a stale confirm
  returns `channel_revision_conflict` and requires another review/confirmation.
  Current members retain read-only history. Membership is not recreated for
  departed actors. Messages, attachments, invitations and external ingress cannot
  write to a dissolved group.

All three writes use the existing authenticated command transaction and durable
actor-scoped idempotency keys. A lost reply is not a failed mutation: retry the
same key and payload. The self-leave reply deliberately does not require a
post-write channel read, because successful leave revoked that permission. It
still requires current caller/connection authority. Unknown servers advertise no
lifecycle capability; clients do not emulate it with delete/archive.

## Execution and transport boundaries

Read membership and execution/delivery membership are distinct. On dissolution,
existing human readers keep their read epoch, while `memberEpoch` no longer
allows group-scoped execution/delivery. Personal assistant delegated group reads
also lose that active participation authority. The execution reconciler wakes
on member/lifecycle changes and cancels revocable queued inputs. An already
committed engine input remains factual: it is not relabeled as never executed.
There is no blanket process kill or rollback of already executed side effects;
a shared Bot and its work in other groups must survive.

Queued outbound deliveries are rejected when their authority is removed; an
in-flight provider operation becomes unknown, not falsely reported unsent.
Binding rows for dissolved groups remain inactive tombstones. Configuration
replay, provider snapshots, late media and late provider creation acknowledgments
cannot reactivate them or create a replacement native group for the same room.
A provider operation already beyond its I/O boundary may still have external
side effects; no cross-service transaction or automatic WeCom destruction is
claimed.

The v1 native leave/dissolve UI explicitly does **not** promise leaving or
multiparty destruction of the WeCom group. The adapter stops native replication
on dissolution and retains the external identity to fence replay. Ordinary native
leave does not disconnect remaining members' transport. Provider-native lifecycle
operations, if added later, require separately declared capabilities/receipts;
provider availability must never gate native lifecycle.

## Client continuity and cache handling

The existing group inspector composes shared Settings rows, native buttons and
its Radix modal. Personal presentation is separated from destructive membership
controls; confirmation defaults focus to Cancel. Busy requests cannot be
repeated/dismissed midway. Unknown results retain a stable retry key; stale
revision results refresh details, discard that confirmation and ask for another
explicit confirmation.

Hiding keeps the current authorized conversation and inspector mounted while the
server re-resolves its summary by ID rather than requiring it in the visible
list. Permission denial withdraws retained history, draft/reply/file state and
cached media for that group only. A later authorized rejoin can load new media;
resource revocation never clears unrelated channels. Draft persistence cleanup
uses the existing CAS owner and does not overwrite another window's newer draft
on a conflict.

## Validation boundaries

Focused tests cover the real storage Worker, additive migration from the previous
schema, checksum rejection, authenticated AppServer self-leave acknowledgments,
CAS/idempotency, Inbox tombstones, membership epochs, scoped queue cancellation,
provider late-snapshot/creation fencing and media cache withdrawal/rejoin.
Browser tests use the actual Workbench Shell, IM extension, inspector and Composer
with synthetic RPC/provider data. They cover pointer/touch contexts, light/dark
presentation, confirmation cancellation/focus, stale revisions, unknown retries,
hide/restore, ordinary leave and dissolved read-only history. They are not a live
WeCom provider or physical-device acceptance test. A release requires both the
server migration and matching client; source integration alone is not deployment.
