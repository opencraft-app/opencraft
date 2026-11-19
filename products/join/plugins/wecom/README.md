# WeCom synchronization into native groups

A WeCom group is an external source bound explicitly to an existing OpenCraft
native group. There is one local group identity and one canonical message history
in the managed Server database. The connector has no independent group list,
message database, membership ACL or history API.

Private deployment configuration: `wecom-channel-sync.json`. In addition to the
provider credentials, configure explicit bindings:

```json
{
  "localGroups": [
    { "chatId": "EXTERNAL_GROUP_ID", "channelId": "group:00000000-0000-0000-0000-000000000001" }
  ],
  "enableImages": true
}
```

Create the native group first with its intended Human owner and members. Each
external source and native group has at most one binding in this version. The
native membership authority controls history, images, sending and unread state.
Binding enables inbound synchronization and outbound synchronization of **new**
local messages, including Bot messages sent with existing native permissions.
Existing local messages are never replayed to the provider. An external sender
is a namespaced message identity, not a new platform Actor or an implicit member.
Neither administrator status nor an external provider's member list grants local
access. Changing the target of an existing source fails closed.

The authenticated callback defaults to `/__opencraft_im/channel-callback/wecom`.
An existing deployment may explicitly set `callbackPath` to
`/__opencraft_im/shadow-callback/wecom` to retain its provider registration while
using the same native owner. Only the configured path is registered; this does
not restore legacy storage, discovery or ACLs. It ACKs
only after the native owner durably admits the message. Provider message IDs
are unique within the full installation/source identity; duplicates return the
original native message, conflicting payloads are rejected. Callbacks from the
service itself are ignored to avoid outbound echo. Provider display-name lookup
is bounded and optional; it never changes sender identity or membership.

The native owner stores canonical text in `actor_messages`, attachment content
in `actor_channel_images`, source identity in `actor_channel_external_messages`,
and transport receipts in `actor_channel_outbox`. It uses the existing managed
storage Worker, not synchronous SQLite on the gateway network thread. Native
history, delta sync, unread and read frontiers apply to both external and local
messages. Image state and delivery changes advance the same native sync cursor.

Native admission atomically creates an outbound intent when a binding is active.
A Worker claim precedes provider I/O. Sender generation, original credential validity/expiry, membership epoch and
binding incarnation are checked before handoff, including between upload,
attribution and image send. Provider success, rejection and unknown outcomes
remain distinct. The local message remains even on external rejection. Retry of
the same client request returns its original native message; it never re-sends an
unknown effect. Startup marks interrupted claims unknown and resumes unclaimed
intents after authorization checks. An already acknowledged remote effect cannot
be undone by a later membership revocation. Removed bindings stop synchronization;
messages sent while unbound are local only.

Provider access tokens and media API remain transport concerns. PNG/JPEG up to
2 MiB are supported; incoming images resume pending downloads after restart.
An image send requires confirmed attribution before its image handoff; partial
and unknown attribution receipts remain visible. Callback and outbound deadlines
are bounded. A storage failure after remote success leaves an unconfirmed local
receipt for recovery rather than authorizing another remote send.

The former shadow timeline implementation, legacy single-Actor ACL/discovery
configuration, standalone UI and shadow history HTTP endpoints have been removed.
There is no automatic import of `im-shadow-groups.sqlite` and no automatic deletion
of any existing deployment file. Operators must use explicit native group bindings;
legacy-only deployment configuration is rejected, not silently accepted as an empty
synchronizer. This source change has not altered any running deployment.

Validation uses managed SQLite/Worker, native HTTP/WebSocket and synthetic provider
fixtures. Real WeCom account access and production callbacks require separate
acceptance; offline tests do not prove provider availability.

### Synced sender identity in native groups

A verified WeCom Human association is also used by the native channel's
viewer-relative `sender.isSelf` projection. Your synchronized messages therefore
use the same right-side self presentation as messages you send in OpenCraft;
other members see them as received messages. ChatUI does not recognize provider
names or compare nicknames. The product adapter resolves exact, corporation- and
source-scoped external sender hashes against verified Actor bindings; the generic
channel layer validates that the linked Actor is an enabled, admitted Human.
Avatar/directory hints do not establish this identity.

Archival author IDs, external message IDs, original labels and receive status are
not rewritten. The projection grants no membership, send/edit/delete authority,
or provider read receipt, and never enqueues an outbound echo. Existing history,
search and sync share this projection. Binding/unbinding wakes group readers;
the viewer's identity binding set participates in the sync cursor, so the next
read replaces stale self presentation without re-importing history. Unbinding
still revokes old authenticated contexts through the Actor owner's generation.

### Immediate native group edits

Committed native rename/member changes notify the WeCom transport through the
existing channel-change owner. Actionable intents are read from the managed Worker
and dispatched immediately, independently per channel, rather than waiting for the
maintenance interval. Same-channel provider work remains serialized with the fallback
poller. Successful settlements drain the next queued edit; stable intent tokens
prevent status/readback events from causing request loops. Unknown writes still
require bounded read-only recovery, not automatic replay. Periodic reconciliation
remains the restart/lost-notification fallback. Permissions, source ownership and
verified member identity resolution are unchanged.

### First creation handoff and RTX edit targets

Before the first creation claim, freeze the current committed native title and
roster (including edits after identity lookup); only an already-dispatched request
remains immutable for uncertain retries. Title shortening preserves complete
surrogate pairs. Only a matching creation attempt can settle a dispatched claim;
an uncorrelated failure must not clear its lease or overwrite its outcome.

Assistant RTX add/remove commands reverse the same installation-owned, verified
IOA metadata used for native invitations. Numeric OA subjects resolve to existing
Actors only; labels, missing claims, conflicting associations and distinct legacy
Actors do not establish or merge identities. Ordinary native group permissions and
provider delivery receipts remain the mutation and synchronization owners.

## Personal Turn notifications

The internal customer-service connector contributes an `企业微信` notification
method through Core's existing Turn notifications. Only the current native Human's
unique verified `wecom.<corpId>` binding can be selected. IOA's existing verified
subject-to-RTX metadata supplies the display name; labels do not establish identity.
No prior direct chat, native group or assistant assignment is required.

The Relay explicitly negotiates support in `register`; an older Relay does not
advertise this method. `turn-notification` verifies the recipient/Actor against
the requesting Server's fresh native directory. It uses the existing customer
service send API for a single text containing title/status, generic body and link,
never the full response. A seven-day effect receipt prevents replay after unknown
acknowledgements and rejects conflicting payloads. It creates no private-chat
binding and invokes no agent. Preferences, subscriptions, Turn observation,
master/individual switches and delivery lifecycle remain owned by Core.

Both explicit and auto-enrolled Mirror targets expose the same optional port.
The separate directly configured channel transport is not yet a contributed
notification target; do not claim this method before Relay capability negotiation.
