# Relay-owned WeCom store-and-forward

The Join Relay and Gateway now wire this adapter into their existing lifecycles.
Redis remains Relay-owned; the target uses NativeChannelSync and the existing
native SQLite timeline, image, membership and external-message tables. No shadow
history or second SQLite store is created.

## Configuration and rollout

### Default automatic receivers

The Join Gateway image includes automatic WeCom receiver enrollment. Once the
ordinary Relay connection or Hub enrollment is configured, it discovers the
existing TLS peer and CA, proves the existing route credential or enrolled Hub
machine key, and requests a receiver-scoped lease. No per-server `servers` entry
or hand-written `wecom-mirror-target.json` is needed. Relay still needs its shared
WeCom provider and durable recording Redis configuration.

Receiver leases last one hour and renew five minutes before expiry. Redis owns
the lease across Relay replicas; every machine request also checks the current
route credential or connected, routed Hub membership. Expiry, removal and trust
rotation deny further receiver requests. Enrollment signatures are audience-bound,
timestamped and replay-fenced. Dedicated receiver credentials remain stable across
renewals/restarts to preserve native file identities, and change with server trust.

Gateway stores the generated lease in owner-only `wecom-mirror-auto.json` and
reacquires it automatically on restart. The saved corporation ID restores native
source bindings; optional enrollment outages leave durable outbound work unclaimed
and retry without failing Gateway startup. Existing groups stay pinned to their
chosen Relay/server; automatic discovery does not move them. Candidate visibility
still requires live recording heartbeats and the user's existing server admission.
It never chooses or binds a group on the user's behalf.

Explicit mirror/channel/directory configurations retain precedence. Set
`JOIN_WECOM_AUTOMATIC_RECEIVER=0` to opt out. Deploy the new Relay first, then the
Gateway; older Relays refuse automatic enrollment and the Gateway retries safely.
Manual receiver setup remains supported below for compatibility.

1. Use the existing Relay `clusterFile` and namespace. Every Redis master must
   report healthy AOF and `maxmemory-policy=noeviction`; startup rejects mirror
   mode otherwise. Set fsync, replication and backup policy deliberately. An
   every-second fsync policy can still lose the last second on total failure;
   use `appendfsync always` when acknowledgements must wait for disk flush.
2. Set `JOIN_WECOM_MIRROR_FILE` to a private, owner-only JSON file:

   ```json
   {"wecom":{"corpId":"wxexample","serviceId":"fwexample","corpSecret":"<private>","token":"<private>","aesKey":"<private>"},"servers":[{"id":"server-one","name":"My server","credential":"<random 32-byte base64url>"}]}
   ```

   The existing `/wecom_callback` handles signed GET verification and encrypted
   POST callbacks. Mirror mode replaces the previous transparent callback
   forwarder. Other Join ingress handlers remain active.
3. The target Gateway reads private `wecom-mirror-target.json` from its existing
   data directory:

   ```json
   {"relayOrigin":"https://relay.example:18490","serverId":"server-one","credential":"<same private credential>","corpId":"wxexample","caFile":"/private/relay-ca.pem"}
   ```

   The optional CA file contains only the trusted public CA. TLS and hostname
   verification stay enabled. Machine endpoints under
   `/__opencraft_wecom_mirror/` require TLS, a pinned server ID and bearer token;
   browser Origin headers are rejected. Plain HTTP machine requests are denied.
   `allowLoopbackInsecure` is only for explicit local fixtures.
4. Do not configure `wecom-channel-sync.json` simultaneously: there is one ingress
   owner. Existing native history remains in place. Retired shadow history is
   not automatically imported; preserve its backup and migrate it explicitly
   before changing an installation still using the retired timeline.
5. Validate the target and Redis before enabling the production Relay file.
   Preserve fixed source/image identities, prior configuration and rollback.
   Deploy both components; a Relay rollout alone cannot establish native ACKs.

`JOIN_WECOM_REDIS_FILE` may point to a separate private Relay Redis configuration
for the recording queue. Relay composition opens and closes this connection;
the same MirrorStore remains the sole queue/binding authority. Authentication and
Hub state keep their existing shared Redis. The dedicated service must still pass
the AOF/noeviction check; an unavailable queue fails startup rather than falling
back to the session cache.

For a verified older full MirrorTarget deployment that predates the registration
capability field, its pinned server entry may set `legacyRecording: true`.
This only fills an omitted capability during a live authenticated registration;
an explicit `recording: false` and forwarding-only mode always take precedence.
Do not set it for directory-only targets. It permits configuration-only activation
of an existing native receiver without rebuilding unrelated Gateway components.

## Mention commands and participation records

Command parsing, personal replies and participation storage are owned by this
WeCom forwarding module (`../commands.mjs` and `store.mjs`). A verified group
mention always returns the sender's available servers and command list, including
an empty mention or unrecognized text. `帮助`, `服务器 [页码]` and `记录 [页码]`
work in forwarding mode; `保存 <服务器ID>` is offered only when
store-and-forward is active. Ordinary messages do not trigger replies.

Each authenticated server registration keeps the existing 90-second live snapshot
and records `firstConfirmedAt` / `lastConfirmedAt` in a separate Redis hash with
no TTL. These times describe confirmed membership, not invented visit history.
The history survives registration expiry and Redis/AOF restart. History queries
intersect with the latest live membership; removed members and offline servers
are never returned as currently available. Historical records grant no access.

The existing Hub forwarding mode uses `../automatic-directory.mjs`: the trusted
signed WeCom Sender may be a Tencent directory ID (`T…`), distinct from the
employee login and staff id. The existing authenticated Tencent
`convert_to_name` lookup resolves that directory ID to the employee account;
callback display labels are never used. Lookup failures keep the notice retryable
instead of reporting that no server record exists. The module resolves the
stable staff subject from provider-verified OA claims in the existing Relay
session owner and retains the identity attestation without browser tokens. Every
query uses the Relay's existing server selector and fresh target admission.
No association code, extra Gateway deployment or server enrollment is required.
Unknown employee claims prompt use of the unified entry, not manual linking.
Identity lookup never matches display names or creates/merges native Actors.
Confirmed relationships have no application TTL; directory/history replies still
filter out targets that do not currently admit that employee. Only identity
attestations are retained after browser-session expiry, never its credential.

The existing Hub forwarding mode does not enable the 200-message spool. Its
`JOIN_WECOM_NOTICE_FILE` may additionally contain the
existing pinned `servers` array (server ID, display name and private credential).
Only register/link machine endpoints are enabled in this mode, over the existing
TLS listener; poll, native delivery and provider send APIs remain unavailable.
Mention jobs share the durable, deduplicated notice outbox, while group ciphertext
continues to the existing receiver unchanged.

A Gateway retaining `wecom-channel-sync.json` can add an owner-only
`wecom-directory-target.json` with the same relayOrigin/serverId/credential/corpId
and optional CA shape used below. The module's directory-only target publishes
only native verified, admitted Human bindings and processes link proofs. It does
not claim message delivery, create native groups or change the existing channel
bindings. It cannot be combined with a full mirror target. The existing
authenticated `wecom.link` action issues the user's one-time association code.
This optional target belongs to the explicit store-and-forward identity flow;
it is not required by the existing Hub forwarding mode's automatic directory.

## Store-and-forward: verified human and destination selection

A signed-in admitted Human requests a short-lived code with a same-origin
`POST /__opencraft_im` body `{"action":"wecom.link"}`. The result contains `code`
and `expiresAt`. In the enterprise group, that person sends
`@机器人 关联 <code>`. The encrypted, signed provider callback proves the WeCom
sender; the target rechecks the Human generation/admission and binds that verified
identity through the existing Actor owner. Codes are single-use, scoped to the
server and Human, and expire after ten minutes. Retrying the same proof is safe;
a different sender cannot reuse it. Equal names/emails do not establish identity.

The person then sends `@机器人 服务器` to list their available servers and
`@机器人 保存 <服务器ID>` to select this group's immutable destination. A target
registers only verified identities of its enabled, admitted Humans, and rechecks
that authority before accepting each group. Existing groups restore their native
source mappings on restart even when the Relay queue is empty.

## Delivery contract

Private messages are not accepted. A verified single-chat message receives
“暂不支持单聊，请将我加入企业微信群后，在群聊中使用。” directly from the Relay.
Its content and attachments never enter Redis, group selection or native history;
no provider media is downloaded. A failed notice returns a retryable callback
failure. Provider retries can repeat the notice; it is not a chat delivery.

An external source is `[wecom-customer-service, corpId, serviceId, chatId]`.
Human directory entries and the durable destination binding are separate. Servers
publish only verified external identity bindings of admitted, enabled local Humans.
A provider callback can select only a server registered for its verified sender.
The target rechecks that identity before acknowledging delivery.

Unassigned rooms retain the first 200 distinct messages. Message 10 schedules a
selection-required warning. Later messages are acknowledged and discarded without
retaining their payload. Provider retries do not consume capacity. The binding is
one immutable server choice in this first version; switching requires an explicit
future migration, never automatic failover.

Bound delivery is at least once. Redis removes an item only after a target's
durable ACK, with claim-token fencing. The target native-channel external-message unique
source/message key makes replay idempotent. Offline targets retain their inbox;
the unassigned 200-message discard policy does not silently discard bound traffic.

The Redis namespace must use persistence and noeviction. It is a delivery store,
not a disposable cache. AOF/replication durability follows the deployment policy.
No enterprise credentials, user messages or machine bearer tokens go to logs.

## Limits and recovery

The first version permits 256 configured servers, 256 groups per destination and
8192 active room records per namespace. A bound queue has a 10000-message and
512 MiB encoded-payload ceiling per room; capacity failures return a retryable
callback failure, never successful silent eviction. Unassigned rooms retain at
most 200 messages under the same byte ceiling. PNG/JPEG images are bounded to
2 MiB; message text is limited to 16384 characters. Media and its queue reference
are stored atomically and removed only after native image persistence and ACK.
A full/unassigned room discards new images without fetching provider media.

Retained IDs remain deduplicated until delivery. Delivered/discarded callback IDs
have a seven-day, 4096-ID per-room retry window. The immutable destination and
native external-message IDs prevent normal retry duplication; this is at-least-
once delivery, not an end-to-end exactly-once claim.

Warnings and commands use a durable outbox. Replies are recorded before provider
send and removed only after a positive provider result. Uncertain provider effects
may repeat a control notice; native outbound messages retain their existing
unknown-result behavior and are not automatically replayed. Text, attribution and
images send through the same Relay/provider adapter after native authorization.
Shutdown aborts polling/downloads, awaits workers, then closes shared resources.

## Validation and deployment status

`npm run join:test:relay` includes a real Redis/AOF fixture, five concurrent
clients, 200/overflow/dedup tests, lease fencing, restart recovery, signed AES/XML
callbacks and link-code isolation. The target integration uses the real native
SQLite storage Worker and covers 200 queued messages, image bytes, lost ACK,
target restart and outbound text/images. Native channel and Relay lifecycle
regressions remain separate checks.

Production activation requires deployment evidence. Source integration and local
tests do not imply that the production target or its Redis policy has changed.

## Group recording web selection

When the Relay provides its entry authentication ports, group mention replies now
link to `/wecom/record/<ticket>`. This page configures the originating group's
recording destination; it is deliberately separate from the general `/servers`
page, which only enters a server.

The 15-minute Redis ticket identifies the verified callback's source and sender.
Opening it also requires a normal entry login whose verified employee account
matches the provider-resolved WeCom sender. It is not a standalone bearer grant.
The page presents only the intersection of fresh normal server admission and
live recording-capable target registrations. A directory-only target is not a
recording destination. Selection needs an explicit confirmation; GET never binds.

The browser obtains the existing target-owned `wecom.link` proof over the normal
authenticated server proxy and exchanges it internally with the Relay. Users do
not enter an association code. The proof must name the selected server. The
native Actor owner still verifies the human and publishes the WeCom identity;
the Relay waits for that registration before applying the existing immutable
group binding. Origin checks and a required JSON request header protect writes.
Concurrent selection cannot replace an existing destination.

The page first reports that a destination has been selected and is waiting for a
server receipt. It reports recording only after the native delivery ACK has
updated the room's `lastDeliveredAt`. Server entry is a separate link available
after that receipt. The first 200 queued messages and native deduplication retain
the existing delivery contract.

An earlier ACK proves a saved message, not continuous receiver availability.
The page keeps refreshing the target heartbeat and pending queue after the first
receipt, and shows an unavailable receiver separately from saved history. Expired
or mismatched-account links show a readable error; terminal authorization errors
stop polling. Confirmation disables the choices while its request is pending.

This requires full store-and-forward deployment on both sides. Forwarding-only
mode may show the scoped page, but explicitly reports that recording is not
connected and rejects binding. Do not enable the recording configuration merely
to make the page report success: validate Redis persistence, the target native
owner, preserved existing source mappings, the target credential/TLS connection,
and actual native storage receipt first.

The recording receiver publishes its native `mirrorSources` projection during registration. Relay only attaches a group ID to rooms already bound to that authenticated receiver and never retargets an established location. The browser links to the native channel view with its `opencraft-channel:` resource, retaining server admission and channel membership checks. Existing delivered rooms recover this location on the next registration without needing a new message. Older receivers can keep delivering but cannot expose a direct group link until they publish their location.

## Immediate, replaceable typing presentation

Native admission and assistant execution remain immediate and independent of
cosmetic provider calls. An eligible mention or five-minute follow-up wakes a
background typing pump immediately, without waiting for the 1.5-second recovery
tick. Each source + sender + binding generation owns at most one current spinner
and one unfinished predecessor. A new accepted message supersedes the cosmetic
turn, not the task: text/image bursts collapse to the newest pending message.
The predecessor receives an empty finished stream before any new spinner opens.
Late answers retain their original message context and cannot finish the new
turn. Different senders/rooms, duplicates, control commands and robot callbacks
cannot retire another person's spinner. The five-minute follow-up window and
all native execution/identity/queue authority are unchanged.

Admission, deduplication and presentation registration remain one Redis ingress
transaction. Distributed lease fences order opens, closes and answers. Both open
and close intents persist **before** external I/O. An unknown/refused predecessor
close suppresses fresh dots instead of retrying an uncertain update or piling up
bubbles. New native inputs still proceed. A real reply or non-text completion
retains that uncertain predecessor barrier until the bounded cosmetic cleanup;
it does not erase it merely because task output arrived. Unconfirmed close state
expires after the eight-minute cosmetic budget without claiming a provider-side
withdrawal or cancelling native work. Only successful provider acknowledgement
allows immediate replacement. Empty finished streams already use the transport's
terminal path; physical-client disappearance still requires WeCom verification.

Receiver capability, the sender's own registered identity, current binding and
membership are checked before opening. Missing registration retries only within
a bounded cosmetic window. Open dots time out after eight minutes, ending display
state only; later actual output is separate. Prior-version placeholders keep their
bounded cleanup path. Provider failure cannot guarantee a phone update and never
justifies replaying an uncertain answer.

For mixed-version rollout, first deploy this code to **all** Relay replicas with
`OPENCRAFT_WECOM_IMMEDIATE_WAITING=0`. This retains the old two-minute ingress
shape/deadline, while new readers already understand retiring/settled state. Only
after all old code has left, set it to `1` (the default) and roll out the same image.
Do not roll old readers back over live retiring state; disable the feature on this
image instead, or wait for cosmetic state to drain. This flag changes presentation
only, never recording, membership, follow-up ownership or native work.

## Forwarded chat record originals

Forward arrivals retain a bounded, validated `forwardedRecord` alongside the readable
preview. Relay/journal retry identity excludes only derived directory display names,
preview text, resolved resources and transcripts; provider body, structure, sender IDs
and original media references remain immutable. The first accepted presentation wins.
Gateway enrichment registers the original JSON through existing scoped inbound-file
storage and persists it as a native message attachment with MIME
`application/vnd.opencraft.chat-record+json`. No second timeline or database is created.
The native client renders a compact card and a sender/time reader; old flattened records
are explicitly text archives, not reconstructed conversations. Nested media reads use
current channel membership, the saved root document and matching provider provenance,
never a browser-supplied file ID, disk path or remote URL. Agents receive the original
structured material and decide interpretation with their own tools.
