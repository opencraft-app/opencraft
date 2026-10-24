# Conversation references and delivery

Headless exposes conversation references, bounded native history reads and durable
message handoff through one core `Collaboration` service. The Web/Electron renderer
supplies copy, paste, `@` search and a reference dialog. Resource routing covers
local Codex and enabled Pi/DSH targets. Separately, Codex source threads created
with the configured Headless adapter receive server-owned `read_thread`,
`send_message_to_thread` and `get_thread_delivery` tools. Those source tools do not
extend to Pi, DSH, SSH or federated resources merely because a target is routable.

## Identity and ownership

`ConversationRef {serverId, threadId}` identifies a resource, independently of an
Actor, connection URL or renderer Host route. Its versioned canonical encoding is
`opencraft://conversation/v1/<encoded-server>/<encoded-thread>`. HTTPS navigation
links carry that encoding in `conversation`; title and current page are display
hints. Links never carry authentication or a transcript. The shared codec lives
in `appserver-protocol/collaboration`. Opening a link checks the resource's stable
server identity before selecting a local Host route.

Each Headless server namespace uses its persisted installation identity plus an
engine namespace. Moving its data retains that identity; connecting through
another route does not create another resource. Resolution outside this
installation is not yet implemented, and an unknown server fails closed without
requesting a supplied URL.

Actor remains the acting subject. Referencing an old thread does not create a
Session Actor, issue a credential or wake the target. An explicit Actor run binding
and its epoch are separate from a conversation address. The configured target port
owns native discovery, read, durable enqueue, receipt, cancellation and exact-Turn
steer. The core does not own another runnable queue or native history mirror.

## User interaction and context

A capable conversation's context menu copies its reference. Pasting the plain link
creates a removable thread mention; `@` search produces the same node. The compiler
preserves its canonical address in native input. Both draft mentions and saved
Markdown references open the shared dialog, which reads actual history and can
send a follow-up. Failed sends retain their text and idempotency key; changing the
text is a new command. The dialog uses the shared modal, clipboard and notices.

On the configured Codex source path, submitting up to three references asks the
core to attach a bounded native-history excerpt in `additionalContext` with
`kind: untrusted`. This works for existing source threads as well as new ones.
Queued user inputs resolve their original execution authority when the target
turn begins, independently of the old page.
Excerpts identify their source and history watermark; unavailable and truncated
sources are explicit. A reference alone never proves content has been read, and
old snapshots do not update automatically.

Native history pages expose only user/assistant text, with message/Turn IDs,
chunk offsets, a content watermark and `nextCursor`. Pages contain at most thirty
chunks and about 24 KiB of serialized entries; a very long message is split
without dropping its tail. A changed watermark invalidates continuation rather
than mixing two snapshots. The submission context has a separate total byte bound.
Tool transcripts, credentials and binary attachments are not mirrored into these
previews. The native history remains authoritative.

## Commands, permission and audit

`opencraft/collaboration` is the initialized Host command lane. `reference`,
`discover`, `read`, `send`, `delivery` and `cancel` reuse the same core authority as
model tools and the existing Actor HTTP channel adapter. The wire cannot supply
an author, execution identity or source thread. Human authentication and Session
credentials are verified at ingress; browser commands also recheck their live
resource owner across asynchronous work.

The current shared-instance policy allows admitted human Actors to operate its
native conversations, matching the existing native UI. Session Actors require
explicit resource grants for read, send and execution actions. Discovery currently
serves admitted humans only. ActorStore accepts a trusted resource-authority
registration for this local server's canonical addresses; registration is not a
grant and cannot authorize another server. Queue and steer are distinct grants;
steer requires an exact expected Turn and never falls back to queue.

Model tools use a durable, bounded user delegation captured from the authenticated
input that started their Turn. Its issuer, Actor generation, credential, source
thread and expiry are stored and audited. The maximum lifetime is one day, bounded
by the original authentication. A newly selected viewer or latest message author
cannot replace it. Native capacity continuations retain that precise delegation
and its send budget. Disable/revocation and instance admission are rechecked.
Unbound turns fail closed. Incoming cross-conversation messages do not acquire the
sender's execution identity or silently inherit a previous viewer's delegation.

Tools may send at most eight distinct messages per originating delegation; retries
with the same idempotency key do not consume another slot. Self-delivery is denied.
No output, acknowledgment, read receipt or status query automatically sends a reply
or wakes another model. Incoming messages show their real author and source link.

## Persistence and execution

The existing `actor-collaboration.sqlite` receives an additive version 2 migration.
Its original migration/checksum and all Actor messages, bindings, idempotency keys,
unknown requests and receipts are preserved. New columns distinguish Actor and
conversation targets, stable server addresses, source references and delegation
provenance. Existing table names and `actor-input:` queue keys are retained as data
identities. The implementation is `access-control/collaboration`; there is no second
`ActorCollaboration` domain service.

Message, idempotency receipt and optional execution intent are one SQLite
transaction. `conversation-execution` is the narrow target adapter, using existing
AppHost logical-client admission and the canonical server identity to select the
engine. Codex handoff uses its `OpenCraftHostQueue`; Pi and DSH use their native
Host input ports and durable submission receipts. Each target retains its own
admission, model, account, workspace and permissions; the core adds no second
engine queue. Target authorization is rechecked before native admission. Pi/DSH
do not support conversation steer or retracting a native handoff through this
adapter. A conversation target remains fixed even if an unrelated Session is
rebound. Conversation routing is resolved from the current adapter rather than
saved as its resource identity.

Accepted, queued, submitted/injected, rejected, cancelled and unknown are different
facts. Submitted proves engine admission, not semantic completion. Cancellation
checks the target's durable admission receipt, and an uncertain transfer is
queried by its original ID after reconnection or restart. It is never resent
merely because a response was lost. Historical submitted facts remain factual
after revocation.

## Supported boundary and verification

Configured local Codex and enabled Pi/DSH targets can be discovered, read and
receive messages through the shared core. Actor run bindings and source-tool
delegation remain on the primary Codex authority; target routing does not extend
those capabilities. Existing Codex source threads receive bounded reference
context. Native dynamic tools are registered at source thread creation; this
adapter does not pretend that native resume can add tools to older source threads.
The reference dialog remains available for direct reads
and sends. New adapters must implement native history and durable handoff before
advertising these capabilities; no renderer-only delivery fallback is provided.

`conversation-collaboration.test.ts` verifies identity, grants, idempotency,
revocation, restart and delegation budgets. `actor-collaboration-codex.test.ts`
uses the real core, AppHost and persistent Host queue with a synthetic native
engine, including detached-viewer tools and untrusted reference context.
`im-multi-engine.test.ts` covers routed catalog identities, native Pi handoff,
duplicate-input receipts and unsupported steer with isolated model fixtures.
`smoke-conversation-interoperability.ts` exercises real browser components and
that core/queue with fixture human authentication and model output. It covers
copy/paste/search, saved links, history, failed-send retention and successful
handoff in narrow/wide light/dark views. These fixtures do not claim real employee
login, physical mobile hardware, paid inference or cross-server federation.
