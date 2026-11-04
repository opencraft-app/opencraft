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
hints. Link generation discards the base URL’s existing query and fragment,
preserves its path, and adds only the canonical `conversation` parameter.
The optional title is a display hint from already authorized data; the CLI does
not fetch content to construct a link. Web copy passes the deployment base root,
and both Web and CLI use `conversationLink`. At open, the Web resolver checks the
full reference on configured connections and confirms the Thread with a
metadata-only native read before navigating through the existing Workbench
location owner. Current Host and path hints do not override Server identity.
Fragment removal uses the serialized URL without writing `URL.hash`, which is
read-only in React Native’s global types. Links never carry authentication or a
transcript. The shared codec lives
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

The bundled [CLI](../cli.md) negotiates `servers`, `metadata`,
`metadataDiscovery` and `boundedRead` independently on this same command lane.
The directory returns the admitted Actor and stable installation/Server identity.
Metadata discovery disables native rollout repair and projects only explicit
metadata; it never substitutes preview text for an absent title. CLI history
uses native item pagination and chunk continuations instead of full-history
hydration. Cursors bind the resource, observed native revision and item hash.
The CLI sends `bounded:true`; this selects a separate bounded projection on the
same execution owner. It cannot fall back to the legacy conversation reader.
The independent `tailRead` capability selects `read` with `bounded:true,tail:N`
(1–5 recent Turns, no cursor). The same Actor/resource authorization runs before
and after the read. It reuses descending native Turn headers and one 30-item page
per Turn, with a shared ten-second deadline; no full-history fallback, global
append fence, cursor retry or second history owner is introduced. Text suffixes
are at most 2,000 Unicode characters, entries total at most 24,000 serialized
bytes and remain chronological. Partial message offsets and partial Turn IDs are
explicit. `nextCursor:null` means callers refresh with a new tail request; the
watermark describes only the observed bounded output. Existing snapshot paging
is unchanged. The native/Host adaptation uses the already supported
`thread/turns/list` (`notLoaded`, descending) and `thread/items/list` (Turn-scoped,
descending), with independently negotiated `opencraft/read-history.sourceRead`.
That flag is consumed by the existing history transport and stripped before
Native. It returns an authorized source observation without importing a globally
fenced snapshot or replaying the stored display cache. Older Hosts reject before
any content operation. The Codex adapter consumes the header flag before Native and reads exactly one
native header page, including on a cold rollout. It never opens or builds the
disposable transcript index for this operation, and never falls back to full-Turn
hydration. Unsupported native header views reject the operation. The history
transport advertises sourceRead only when the inner adapter declares it. There
is no native protocol parameter or storage migration.
Codex supports this projection; other engines explicitly reject it until their
native reads are bounded. Existing UI and model-tool readers retain their wire
contract.

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

The CLI's `lookup` action reads the existing Actor/key ledger, reauthorizes the
canonical conversation, and returns an allowlisted receipt without reading
message content or triggering the execution pump. Missing keys remain unknown:
an earlier in-flight request may still commit. `delivery` with `metadataOnly`
uses the same receipt projection and is negotiated as `deliveryMetadata`.
Legacy delivery consumers retain their original response. CLI sends issue one
mutation; disconnections retain the original key and never replay the send.
Waiting for delivery polls only receipts and recognizes submitted/injected as
engine acceptance, while taskOutcome remains unknown.
Discovery filters are separately negotiated and passed to native metadata-only
catalog reads with a bounded page. Paths are normalized on the Server, without
using the calling machine's cwd. Engines without filter support reject the
request before opening a native catalog. Attention is projected from explicit
native flags, without fetching interaction payloads; unavailable identity stays
null. A configured public UI base can render the canonical resource link.
Recovery is read from the existing Host recovery owner. Exact-turn steer uses
the original execution/queue authority and never falls back to queue.
Steer skips optional attention reads. Queue is admitted before its bounded
attention read, which degrades to unknown without preventing admission; recovery enrichment also
has a bounded optional read and cannot invalidate successful native metadata.

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

## Root creation from the human CLI

Collaboration owns the Actor/key creation ledger in Server storage and exposes
separate `create`/`createLookup` capabilities. This is an independent root operation,
not `thread_spawn`; it does not acquire a parent delegation or release another
operation's creation claim. One native `thread/start` uses the verified ingress
submission context and ThreadAccessSession, preserving creator and product scope.
Workspace preparation reads the same machine's product Host catalog (
`opencraft-server` owns `project/list`, not native Codex) and
canonicalizes the chosen project roots and cwd; grouping is not authorization.
The current admitted human has the same instance scope as UI creation. Other
Actors cannot query its operation or submit to an unauthorized private reference.

The durable reservation stores requested-content fingerprint, canonical settings
and unknown creation stage before the only native attempt. The stable ref is
saved before the existing `sendConversation` transaction commits first admission
and its pointer together. The first-input key derives from random operationId.
Creation and first delivery remain independent facts. A repeated key never
restarts an interrupted stage. Lookup only reads ledger/delivery metadata; crashes
and lost responses retain unknown and any saved ref. It does not replay native
creation, enqueue first input, remove partial successes, or infer task completion.


## 48b与51最终组合：根创建和首条同一可信归属

内部ConversationCommandContext明确包含submission与inputAdmission；前者保留原SSH ingress的
Actor、resourceOwner和opaque executionPrincipal供root thread/start使用，后者由接收Codex
owner同步提供，不能从wire body、环境或viewer推导。Headless仅转交该内部对象。
create首次创建获得并持久保存threadId后，把同一inputAdmission交给sendConversation；
首条沿51普通直接human queue的相同快照冻结契约，在Hub受理提交前写既有Codex
execution_submissions。没有复制principal到Server账本，没有新增迁移或owner。
root创建成功而快照/首条受理失败时保留已知ref及unknown/rejected事实；重复create/lookup
只读对账，不重新capture、不重发、不补权、不删会话。agent/source/delegation/steer与旧历史
继续沿51原边界；本批仅接收Codex同Server，Pi/DSH未获得员工执行归属。

### Native registry and uncertain creation failures

The product Host project ID is a catalog identity, not a Native project ID.
Root CLI creation validates the selected existing Host project and canonical cwd,
then sends only the validated `cwd`/`runtimeWorkspaceRoots` to Native. It does not
create/import a Native project or assign a Native `projectId`; the operation
ledger retains the requested Host project. A Native `projectId` filter does not
become a mapping for that Host identity. Native's separate project registry may
reject unknown IDs with `-32600` even when workspace paths are valid.

After the durable reservation, a generic RPC status/code cannot prove absence of
a Thread. Such failures remain `unknown`; pre-reservation validation still rejects
invalid projects/paths normally. Knot preserves only typed `resultUnknown`,
`retryable` and a bounded known `threadId` from the trusted error lane, never
arbitrary Native message/data. A Native ACK followed by Host materialization
failure carries the observed ID with `resultUnknown:true`; Collaboration stores
that ref but does not submit the first input, repair ownership, or replay on
lookup/repeated create. An error without an observed ID cannot invent a ref.
Diagnostics omit IDs and arbitrary data and use only fixed reason categories.
Old rejected rows are unchanged. These rules require no Server/Host migration.


## Read-only discovery ports

`projectDiscovery`, `modelDiscovery` and `executionOptions` negotiate independently.
Collaboration validates the current admitted Actor and selected Server before and
after each catalog await; referenced options also validate conversation read ACLs
on both sides. Host projects retain the same instance scope as UI/create, without
inventing Actor→project ACLs. Project IDs never enter Native registry operations.

A narrow execution port maps project pages to the trusted resource Host and model
pages to that Server's Native lane, including installed ModelPolicyTransport.
The policy owner marks models unselectable when all reasoning choices are denied;
the public projection excludes hidden/unselectable models and arbitrary metadata.
Cursor continuation is retained even for an empty filtered page. Model IDs,
reasoning and advertised tier IDs are catalog evidence, not per-Turn telemetry.

Referenced options use bounded strict Native source metadata, no stored-display
fallback or message items. Current/last persisted model and effort carry source,
scope and observation time. Missing configuration remains null. No trusted policy
ceiling or dynamic options owner is present: these fields explicitly remain
unsupported/unknown instead of treating a Native permission profile as authority.
No new storage, input, settings update or permission mutation belongs to discovery.

Thread options includes the first policy-filtered `modelCatalog` page. Continue
its cursor with `server models --server <same-server> --cursor <cursor>`; a
partial catalog does not claim that omitted choices are unavailable.

## Exact stop and original-request cancellation

`stop`, `stopObserve` and `queueCancel` are independent collaboration capabilities.
The internal Codex Host advertises `opencraft/thread-stop` only with its installed
control owner; an old Host is rejected during initialization before mutation.
The public boundary retains current admitted human Actor, resource ACL and existing
`execution.steer` owner scope for stop, without deriving rights from an execution
ID, principal or body field. Read-only reconciliation requires conversation read.

Stop runs under the existing per-Thread Host serialization, inspects Native recent
headers and passes the exact Turn ID to `turn/interrupt`. Final submission rechecks
current context and the observed active Turn; recovery/provider-retry suppression
matches that Turn rather than overwriting a newer chain. Both owners keep their
existing schemas. A Native ACK and exact header observation are distinct facts;
unknown is retained, never retried. There is no durable stop ledger or fabricated
idempotency/lookup. An observe-only call reads no body and makes no control attempt;
targets outside the five-header bound stay unknown.

Queue cancel verifies original requester/ref/queue mode under the Hub's existing
cancel/pump serialization. Its final Host queue deletion carries a trusted current
admission guard; claimed or unknown requests are not force-discarded. A committed
cancelled row is idempotently observable after restart. An ambiguous delete response
marks uncertainty in the original request, without altering input fingerprints,
contents, identity/model snapshots or historical ownership. No new storage owner,
Server/Host migration or general queue editing API is introduced.

Native may start a new Turn between a header response and receiving the interrupt.
The exact original turnId is never replaced with the latest one: a known stale
owner view rejects before send; an in-transit rejection may retain unknown. In
both cases a newer Turn/recovery chain must remain untouched.


The explicit user cancellation lane separately requires Host `opencraft/queue-cancel`
version 1 with `finalAdmission: true` before `thread/queue/delete`. A legacy Host
that merely understands deletion is unsupported; existing internal authorization
cleanup retains its earlier contract. `cancel_outcome_unknown` is a durable pump
barrier, including after reopen: queued/discarded/dispatching or absent receipts
do not clear it or authorize a second delete/add. Receipt read exceptions
(including generic transport errors and RPC rejections) retain the same barrier
and never enter the ordinary rejection cleanup/re-read/delete branch. A proven delivered/steering
receipt can still report the original execution fact. Internal queue receipt and
delete controls use the same history-independent, authorization-rechecked reply
lane as the outer control, including under blocked history imports.

## Explicit per-input Codex settings (Server7)

Human CLI create/send can negotiate `modelSettings` separately and submit only
`model`/`reasoningEffort`. Queue mode preserves these in the request fingerprint
and the Server-owned `conversation_input_settings` row, in the same transaction
as the request/key and original human admission snapshot. At least one setting
is explicit; old inputs have no row and are not backfilled. Existing standalone
legacy repositories that cannot store these rows reject explicit settings.
A read failure on the consolidated Server is an error, never an absent override.

The receiving Native queue reads settings from the trusted read-only Server port
for its exact Actor request/Thread/Server and revalidates current admission. It
checks the current model catalog/policy before claiming, then passes frozen values
to `turn/start.model` and `.effort`. Creation uses `thread/start.model` (no provider
fallback) and the fixed `config.model_reasoning_effort` key, and passes identical
settings to first-input admission. No body/env/viewer config or principal carries
settings. Steer, delegated/source inputs, unsupported engines and old queue owners
reject this capability; none silently consume explicit settings as defaults.

Readback separates `requestedSettings` from `nativeConfirmedConfiguration`, which
includes `scope`, `source`, `observedAt`. Creation confirmation requires actual
Native configuration fields; an empty ACK does not confirm requested values.
Thread read confirms current/last persisted configuration only. No Native
per-turn configuration evidence exists here: `actualTurnSettings` stays null,
even when a queue receipt identifies an accepted Turn. Lookup/repeated operations
never recapture, replay unknown, rewrite settings, or apply current Thread config
to earlier input. Root partial-success/ref/creator boundaries remain unchanged.

Known7 product identity readers validate exact Server5/6/7 history/schema/hash
with explicit opt-in; default strict validation and writer6 remain unchanged in
the independently deployable reader candidate. Writer7 and complete signed
readable7 recovery qualification are a separate delivery boundary.

Legacy Actor-to-Actor queue inputs still resolve their original binding and
authorization. The same trusted settings port returns absence for these old
inputs; it rejects an explicit settings row on a non-conversation request.
Neither an agent input nor a missing port can acquire human settings authority.

The queue advertises model settings only when the settings read port and its
explicit `settingsAvailable` authority both confirm support. The Server derives
this from its opened settings table; an old standalone/borrowed owner without
that table does not advertise or accept explicit settings. Once opened, a later
read failure is never converted into absence.

模型设置协商与精确停止/取消的finalAdmission、结构化交互的structuredResponses相互独立。显式模型设置在创建及队列领取前都要求对应owner能力，不能因其它能力存在而跳过，普通无设置输入不增加该要求。


## Own Hub queue request list (58E1)

`Collaboration.queueRequests` is the sole read projection for the current human's
pending/uncertain queue requests in an exact authorized ref. It uses the original
receipt's Actor/resource/orchestration policy intersection and rechecks it after
reading; it creates no write grant, task outcome, queue owner or attempt ledger.
Its independent protocol/client/CLI capability is `queueRequests`. The history
transport classifies this action as an exact control reply so a blocked history
import does not gate request observations. The outer AppHost carries the command;
no execution-port or Native request is issued for the observation.

A forced request-table primary B-tree range covers at most 1024 numeric rowids;
all Actor/ref/mode/state predicates precede LIMIT. A global endpoint lookup fixes
the first-page membership ceiling. Pages can be empty, live states may change,
and cursors do not promise a transactional snapshot. Per-request settings use
the existing PK reader. Bulk operation keys remain null to avoid the unindexed
request-to-key scan. Process-local authenticated encrypted cursors reject forgery,
Actor/ref/filter changes and owner restart. No Server1–7/Host17 migration, Core
change or C1 Server8 contract change is needed. Full response, pagination, errors
and state limitations are defined in [CLI](../cli.md#own-hub-queue-request-observations).
Editing, sorting, scheduled input, retry and eligibility remain separate contracts.
## Explicit subsequent Native Thread defaults

The separately negotiated `threadDefaults` / `threadDefaultsObserve` lanes use the
current admitted human and the existing raw Thread method/resource-use authority.
Shared human participants are included; private Threads retain their creator
policy. This is not a `conversation.read` grant or a viewer/editor distinction.
A Native `read-only` permission mode describes a sandbox, not participant rights.
The trusted original Actor/resource owner is checked again inside the Host and
before physical submission. Session/Bot/delegation do not acquire this lane.

A write requires the explicit scope
`subsequent-native-turns-including-already-accepted` and a complete bundle of
named permission, `plan`/`default`, model and reasoning effort. It may affect
**other participants' already accepted but not yet dispatched inputs**. Only
Native builtin mode instructions are selected (`developer_instructions: null`).
There is no arbitrary config/cwd/instructions, sticky tier, live update, second
outer tuple, or automatic mode bundle injection into queued input.

The existing per-Thread Host operation owner orders this single Native setter
with queue preparation/claim/start, holding until its one ACK or known failure.
This is not a global lock across Hub admission, independent Core callers,
generations or crashes. A timeout/disconnection after submission remains unknown
and is never replayed or repaired by a read, sleep or Host compensation. There
is no key, CAS or cross-restart exactly-once promise. Empty ACK means only
`acknowledged`, not saved, durable or used by a particular Turn.

The requested bundle is returned separately from a strict independent Native
Thread read with source, scope and observation time. Missing mode/permissions or
other fields remain null/unknown; requested data and viewer caches are never
confirmed evidence. `actualTurnSettings` stays null. The original request's
Server7 frozen model/effort and fingerprint are untouched: full and partial
explicit fields retain their meaning, absent rows inherit genuinely, and a read
failure does not fall back. An unspecified component is not silently frozen.
Raw `thread/settings/update` also crosses the same existing model-policy owner
and Host serialization; Native profile.allowed/managed requirements remain the
permission authority. No Server/Host migration or second identity owner is added.

### Cold Native Thread preparation for defaults

A retained `thread/read` can report `notLoaded` without loading the mutable Native
Thread. Before the single defaults setter, the same Host Thread operation owner
loads that exact existing Thread with `thread/resume {threadId, excludeTurns:true}`
and no configuration overrides, then rechecks its identity/current resource
authority and performs the original directory/profile/model-policy preparation.
The preparation sends no input and issues no `turn/start`; existing Goal/recovery
owners retain their policies. Warm Threads skip this load. Read-only defaults
observation never resumes a Thread. An unconfirmed setter is never repaired by
loading, writing again, or replaying the submitted bundle; original unknown
receipts remain unknown. This adds no Core/Native API, schema, or permission grant.

## Recorded-name metadata discovery

The typed `threadSearch` read independently negotiates `recorded-name-v1`.
Collaboration reuses metadata discovery's admitted-human,
`conversation.discover` and resource/private/orchestration intersection, without
requiring conversation.read or adding grants. Actor and generation are checked
before the window and again before publication. A request cannot supply a
principal, execution ID or arbitrary Native method.

Host `opencraft/thread-directory/search-names` requires the trusted in-process
Hub submission context, never a decoded wire identity. It is a control read on
ThreadDirectory's original connection, not Native passthrough or history hydration.
The window exposes only internal candidate positions and bounded recorded names
to Hub. Hub filters resources, emits at most 30 ref/name entries, authenticates
and encrypts the continuation, then asks the same owner to validate its source
fence after ACL work. Internal revision, lifetime, bounds, paths and metadata
objects are absent from the public response. The total deadline is nine seconds;
errors remain read-unavailable, changed, invalid-cursor or unsupported, never an
uncertain mutation receipt.

The original remote directory owner is also installed once in the local Codex
adapter's existing Host17/overlay lifecycle. SQL and migration checksums remain
unchanged. Local background sync uses state-only metadata pages of at most 200,
commits in 128-row chunks, yields between pages, and reconciles/observes directory
rows in 1024-rowid windows. Warm scans retain the existing watermark, interval and
backoff. No rollout/body import or native account writer is introduced. Source
failure retires the directory and aborts old IO; a new initialized source owns a
new cursor lifetime. Search does not start or join background sync, and local
thread/list keeps its original routing. A cold directory is unavailable until a
successful source observation. Partial retained directory coverage is always
reported as recorded-only, never exhaustive Native history.
