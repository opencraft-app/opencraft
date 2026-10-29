# Platform: Execution and models

[Architecture index](../../platform-architecture.md) · [Documentation index](../../README.md)

### Host-side provider account pooling

In server Web deployments, the Server Connections extension
(`opencraft.server-connections`) contributes the Codex account settings entry in
the Server group beside model services. The composition root
disables the built-in local account page in that deployment; standalone Web and
Electron retain their existing local account entry and Host ownership.
Account identity text masks email mailbox and private domain labels by default,
including email-based account names, details, accessible action labels and remove
confirmations. Expanding details does not reveal the full address. This is a
presentation policy, not an authorization boundary or a mutation of stored account
identity; existing account RPC metadata and credentials remain owned by the Host.

An Account Pool is a Host-private provider credential-routing policy. It is not
a Host, execution Engine, Thread, model, authentication session or renderer
preference. `account-pool-host` owns account metadata, separate 0600 credential
files, quota observations, the provider cursor and affinity keyed by
`(provider, hostId, providerThreadId)`. Renderer-facing projections expose only
metadata and credential presence. Storage roots are injected by the platform
directory resolver; the package never derives product state from `homedir()` or
the process cwd.

Codex device authorization is completed by the Host-owned maintenance client,
independently of Renderer polling. On a matching native completion notification,
the Host imports credentials once, starts subscription maintenance and closes the
isolated login worker. Pending logins expire after ten minutes even if no page
returns; explicit cancellation prevents subsequent import. A completion already
received wins over cancellation and shutdown drains its import before closing
storage. Terminal results remain idempotently queryable for thirty minutes in a
bounded in-memory receipt cache; a server restart retains imported accounts, not
pending authorization sessions. Before cleaning old isolated profiles, startup
recovers reusable credentials already written by native authorization through
the same account owner; newest profiles fill missing credentials while existing
configured credentials and enablement remain authoritative. Storage errors retain
those profiles for retry. It never
restarts an unfinished authorization. No credentials or device codes enter browser
storage. Account Settings reads the server account list on mount, pageshow,
focus and return to visible state, and resumes a retained login poll when present.
A page reload can therefore discover a completed login without its former
session ID. A pending login lost on reload can finish on the Host, but its code
is not restored; starting again is an explicit user action.

Codex subscription maintenance also retains the backend-issued reset-credit count
and its own last-successful observation time. Only a nonnegative safe integer in
`rate_limit_reset_credits.available_count` is a known count; missing or invalid
metadata is unknown, including on older Hosts. A failed refresh preserves the
previous observation. This metadata never affects account selection, affinity,
or inferred recovery from a blocked quota.

Hosts with `resetCreditActions` expose on-demand credit details and explicit
redemption through the same account owner in Core and the embedded adapter.
Settings keeps this action hidden for older Hosts. Detail reads never redeem a
credit. Only credit metadata reaches the Renderer: ID, title, status, supported
plan, issue/expiry times and observation time; profile identities and OAuth
credentials do not. Raw HTTP ISO times are normalized to milliseconds. Unknown
expiry is distinct from explicit no-expiry, and the backend total is independent
of the possibly capped detail list.

Redemption requires a confirmation for one account and one credit. The Host
re-reads details and rejects unavailable, expired, unsupported or unrecognized
credits before POST. It binds `credit_id` and `redeem_request_id`, coalesces
duplicate attempts and rejects concurrent attempts for the same account. An
uncertain network, HTTP or payload result never reports success or automatically
replays POST. Settings requires a fresh detail read before a further explicit
confirmation and retains the same retry key for an unresolved attempt during the
application service's lifetime. This in-memory tracking is not a durable queue
or a cross-client guarantee; upstream credit identity/idempotency remains the
redemption authority. No fallback selects a different credit. The original
quota/count owners are refreshed afterward; a successful reset followed by a
failed usage read remains a successful reset with a refresh-needed notice.
Closing the account owner drains its credit requests before closing storage.

Codex AppServer connects to one synthetic Responses provider on a loopback-only
HTTP proxy. Each AppServer child receives only the proxy URL and a Host-scoped
token through its environment; real account OAuth credentials do not enter
process arguments, AppServer configuration, Renderer state or logs. The proxy
authenticates the Host, strips inbound credentials, selects the account, and
injects the upstream bearer token plus ChatGPT account identity at the final
HTTP boundary. Forks may inherit their parent's affinity within the same Host;
identical provider Thread IDs on different Hosts never share a binding.
Native startup establishes ephemeral `chatgptAuthTokens` auth using a locally
issued broker JWT with no upstream identity, plan or OAuth credentials. This
retains the native image-generation surface, which API-key mode hides. The
account pool remains the only upstream credential owner. Both the native provider
and ChatGPT metadata base URL point at loopback; the broker JWT is never sent to
an external backend. No shared auth file is copied into native runtime state.
Initialization waits for native auth before releasing logical clients.

The native hosted MCP route `/api/codex/ps/mcp` maps to ChatGPT's
`/backend-api/ps/mcp`, outside the Codex Responses prefix. It authenticates the
loopback broker bearer before injecting an account credential. Native launch
also supplies that synthetic bearer through `CODEX_CONNECTORS_TOKEN`, which the
implicit hosted MCP client resolves separately from external account login.
Neither value is an upstream OAuth credential. Tool calls use
native `params._meta.threadId` for Host-scoped affinity; initialization and
catalog requests do not reserve a conversation or advance the cursor. Hosted
tool failures retain their upstream status and never replay on another account
or change text quota. This is not an unrestricted ChatGPT API proxy.

The loopback bridge preserves request bytes, including native compressed Responses
bodies, without a UTF-8 round trip. Upstream Fetch decodes response compression;
the bridge omits its stale `Content-Encoding` and compressed length so clients
consume the decoded JSON or event stream once.
The proxy also allows POST `/v1/images/generations` and `/v1/images/edits`.
Native image turn IDs resolve through a bounded, Host-scoped map populated by
Responses turn metadata to the same thread affinity. Unknown or cross-Host turns
are rejected. Native image requests run once and retain their backend status and
image failure metadata; their separate image quota cannot exhaust text quota or
trigger cross-account replay. The native engine owns image saving and events;
Renderer consumes its existing image-generation presentation. The native
`image_generation` feature remains the enablement authority rather than a second
application-only switch.

The synthetic provider's `/v1/responses` and `/v1/models` paths are translated
to ChatGPT Codex's `/responses` and `/models` paths, preserving query parameters
and Codex-owned request metadata. The Codex child generates its own persistent
installation ID in its runtime `CODEX_HOME`; migrating account credentials does
not copy another device's installation identity.

New independent Threads use equal round-robin admission across eligible accounts,
wrapping in configured priority order. Priority defines order, not a preferred
account to exhaust first. Selection commits the Thread binding and provider
cursor atomically before any upstream I/O; parallel first requests for the same
Thread therefore share a binding, while different Threads spread immediately.
Bindings are reservations, not proof of a successful upstream execution.
Success only records last usage and cannot replace a newer binding or rewind
the cursor. Metadata/model discovery reads do not create bindings or consume
round-robin slots. This balances new Thread admission, not token consumption
or active-stream concurrency; existing bound traffic does not advance the cursor.

An eligible bound Thread stays pinned. A short temporary hold returns bounded
`Retry-After` for that Thread while new Threads may use another account. The
proxy advances within one request only after an explicit pre-success quota or
authorization rejection; successful responses, transport failures and
indeterminate streaming outcomes are never replayed. HTTP 429 with exhausted
quota headers or JSON `error.type` equal to `usage_limit_reached` is an explicit
quota rejection; an ordinary temporary rate limit does not trigger replay.
A body-only rejection excludes that account for the current request without
inventing a quota window or reset time; subscription refresh owns durable usage.
The provider cursor moves to the next eligible account after the current account
and wraps in configured priority order; recovery of an earlier account does not
pull new Threads back.
The loopback HTTP bridge owns each response stream until completion. When its
client disconnects, it aborts the upstream request and consumes the resulting
stream error without terminating the Host process or replaying the request.
The proxy uses a dedicated HTTP/1.1 pool with sixteen non-pipelined connections
and the loopback bridge admits at most sixteen concurrent upstream requests.
Waiting for response headers is bounded to 60 seconds and an idle response body
to 180 seconds. Slow headers, queue delay and transport failure emit
content-free diagnostics keyed only by provider Thread/account identity. A
timeout or other transport failure is surfaced to the owning Turn and is never
replayed on another account, because the upstream execution outcome is unknown.
The bridge accepts request bodies up to 128 MiB. It drains an oversized body
without forwarding it and returns HTTP 413, so a large Codex history produces
an explicit size error instead of a disconnected stream.
Account order, enablement, quota, admission cursor and reserved affinity survive Host restart.
Affinity expires after 30 idle minutes and storage retains only the 4,096 most
recent bindings, within the bounded scheduling contract.

Codex subscription state is distinct from credential presence. The Host reads
the ChatGPT Usage endpoint with the selected account credential on add/enable,
manual refresh and a five-minute background interval. It persists plan type,
primary/secondary limit windows, reset times, observation time, last-use
metadata and the derived `ready | held | exhausted | error | disabled` state.
Header observations from real inference merge into the same windows. Renderer
projections contain only this metadata; access and refresh tokens remain in the
Host-private 0600 secret files. Usage refresh failure does not invalidate an
otherwise usable inference credential.
The Codex account Settings projection renders each reported window reset time
as visible local time in the quota row and full date/time in account details;
touch access must not depend on hover. An absent reset time remains explicitly
unknown rather than being inferred from the window duration or account status.

Electron now contributes a `local-codex` Host backed by the Daemon-owned
`CodexEngineAdapter`. One physical stdio AppServer serves the Host generation;
the adapter virtualizes request IDs, shares physical initialize, and restores
logical-client targeting for responses, Thread notifications and server
requests. The Daemon owns the physical Host generation independently of Renderer
claims. A lost or closed Renderer revokes only its logical client lease; the
adapter and an admitted Turn continue until the owning service closes or the
transport fails. Reconnection creates a fresh logical client lease on the same
physical generation and resumes the Thread. A failed physical generation is
closed and recreated before it accepts a new claim.
Queue-to-active-Turn steering is a separate Host capability. Stock Codex
AppServer has no single queued-steer operation, and its idle queue drain cannot
be fenced by two independent RPCs from the adapter. The Daemon therefore owns
Codex queued messages in its Host-state database (`opencraft-host-state.sqlite`
for new stores; existing `codex-host-queue.sqlite` remains in place); its physical AppServer is
only the execution target for standard `turn/start` and `turn/steer`. The Host
serializes queue dispatch per Thread, persists a claim before sending, and
advertises `atomicSteer` and `unconfirmedSteerDiscard` from this Host-owned
implementation, independently of a patched Codex binary. An interrupted or
timed-out dispatch stays delivery-unconfirmed and blocks later auto-dispatch;
it is never blindly retried. The Host checks paged Codex user-message history
by client ID before settling a claim. Explicit discard requires an idle Thread,
the original target Turn and a successful history check; discard acknowledges
uncertainty, not proof that the model never saw the input.
Before starting the physical AppServer, the Host migrates any legacy native
queued rows into its own store and removes the old rows. Migration is
idempotent and fails closed on malformed or conflicting rows. The single
Host/AppServer owner for the data directory remains required. DSH retains its
own Host-side queue plus native `session.updateQueue(steer)` execution path;
it does not inherit Codex's recovery capability.
For pending Codex server requests, the adapter retains the exact request frame
and Thread ID within that physical generation. Disconnect revokes the previous
Client's response authority, not the AppServer request; successful `thread/resume`
lets a new logical Client claim and receive unowned requests. Merely being an
initialized or subscribed Client is not authority to answer. A late resume from
a disconnected Client cannot reclaim ownership. The routing ledger is bounded
and in-process, while the AppServer remains the pending/resolved authority; this
does not add multi-tenant authentication to the single-user direct topology.
Codex also declares `opencraft/thread-start-durability` because `thread/start`
can return an in-memory ID before a recoverable rollout exists. The Workbench
therefore dispatches the first `turn/start` before retiring and navigating away
from the Draft. DSH and Hermes do not inherit this policy: absence of the
capability preserves their durable-Thread-first promotion path.

The builtin Codex Accounts Settings page consumes Host extension methods for
redacted list, enable, reorder, remove, subscription refresh and Device Login
operations. It presents the plan, live limit windows, reset times and derived
account state without growing a second account or quota authority in React.
Device Login runs an isolated Codex maintenance AppServer using the official
`chatgptDeviceCode` flow; only a completed login with a valid private auth file
commits an account. An explicit import action reads the external Codex authority
(`CODEX_HOME`, otherwise `~/.codex`) supplied by Electron Main, copies its
validated OAuth credential into the private pool and never rewrites the source
`auth.json`. Refresh likewise round-trips one account through an isolated
managed-auth profile and verifies that account identity does not change. Login
and refresh profiles are 0700/0600 temporary state and stale profiles are pruned
on the next service construction. Renderer snapshots never include tokens.
The external Codex executable is resolved once by Electron from an explicit
override, PATH or the official user installation location; it is not bundled.

Servers can explicitly opt into an independent `codex-core` owner through the
daemon's `--codex-core-endpoint`. It owns the native Unix WebSocket AppServer,
account proxy, login, refresh and usage maintenance. The daemon remains the
logical-client/product-protocol adapter and closes only its own native connection;
the final page leaving or the execution service restarting does not stop Codex
work. The account service is shared with the default desktop embedded path, not
duplicated in remote daemons. Both owners acquire the same data-directory writer
lock. See [Codex core operations](../../codex-core.md) for authentication, independent
systemd units, migration and the interrupting CLI/proxy maintenance boundary.
Web/gateway readiness is independent of this Host's protocol compatibility:
Headless serves HTTP and other Hosts while its Codex connection initializes in
an abortable, bounded retry worker. Deployment observes the preserved Core
process identity separately from connection compatibility; incompatible Core
connections fail locally and never turn into a second writer or a Web release
barrier. Host readiness is a separate health projection, not HTTP readiness.

`codexCoreEndpoint` is explicitly optional in both desktop and SSH daemon
composition. Without it, the downstream product retains embedded/SSH execution, including the
Host-owned queue, verified senders and enterprise identity participant metadata. The core bridge
does not own or reproduce those downstream Host overlays and rejects verified sender
attribution. Existing internal Headless deployments are not switched to core mode.

The transport packages are peers. Replay is not a wrapper around WebSocket and
Memory is not a fake method surface: all three carry the same JSON-RPC text
frames through the same `DuplexTransport` contract. `RecordingTransport` is the
only decorator; it can wrap any physical transport and produces Replay input.

### Bot management ownership

Applications exposes a persistent Bots management View. It consumes the
AppServer Bot directory and explicit Host connection command; selecting a
management target does not change the active chat Host. Create/clone/rename/delete
are gated by Host `botManagement` and per-Bot `management` operations. Dialogs
own only user intent and draft text; Radix owns focus, Escape and delete confirmation.
The same creation entry is used from the Bot sidebar and management page.

Trusted `ClientProductSession.botManagement` declares optional provider eligibility
and empty-state copy. Core defaults to all enabled profiles; an explicit empty
allowlist selects none. Assembly snapshots and freezes the policy. The management
view prefers a unique eligible Host with directory-reported Bot management;
otherwise only a sole eligible profile may connect. Ambiguous candidates never
select an arbitrary Host. Product eligibility grants no capability or authority:
Host and per-Bot operations remain the mutation gates. Existing persisted View IDs
remain compatible. Selection-scoped reads discard late group results and feedback;
a pending request cannot block refresh for a new target. Operation drafts retain
their captured Host rather than following selection changes.


Hermes transports own one control-plane mutation port per account/instance,
surviving replaceable bridge generations. The port maps blank creation and
template-based cloning to the existing instance Bot API; it never constructs a
native profile from the display name. Root profile deletion is prohibited.
Creation receipts retain success or failure for a command ID; uncertain writes
are not retried automatically. Semantic revisions increase within the Host port;
fresh-read revision checks and serialized writes are not a desktop service cross-client CAS.
Deleted Bot events invalidate open conversation snapshots and block later sends.
Only current Host generations may publish mutation receipts into the directory.

Downstream products own their Bot identity/lifecycle libraries and generated HTTP
repositories. These are product dependencies, not public OpenCraft packages. The
shared lifecycle contract stays independent of renderers, storage, authentication
transport, i18n and analytics; OpenCraft consumes it through explicit AppServer/Host
adapters. Downstream Web validates its product behavior before that adapter contract
is adopted. A generated HTTP repository remains a compatibility consumer, never
a second source of product policy.

- Protocol, content models, session state, restore/replica logic, commands,
  deterministic tests, routing identifiers, and design tokens: 100% shared.
- React subscriptions and feature view-model hooks: share when they remain
  renderer-neutral.
- Account authentication and cloud Bot availability do not own the Web/Electron
  conversation surface. Zero cloud Bots, account refresh/errors, and sign-in do
  not replace a usable local or other-Host Workbench with a creation guide.
  Account-level `applicationIntervention` is a deprecated compatibility field
  ignored by the Shell. Only the selected Host's actual connection failure can
  request a matching provider intervention. the downstream product no longer contributes an
  automatic `empty-workbench` creation guide; zero-Host startup has a neutral
  no-Agent state with a Settings action. Environment discovery and cloud
  creation services do not create an application-level Environment surface.
  The onboarding `bot-required` projection is retained for explicitly selected
  the downstream product configuration, not as a global desktop prerequisite. Native Expo
  account onboarding is a separate adapter and is not changed by this desktop fix.
- Product onboarding shares a renderer-neutral account-state projection. An
  authenticated the downstream product account with zero executable Bots can still enter
  Collaboration; `bot-required` belongs only to an explicitly selected Bot Host path, not
  to the application account gate. Web and Expo still resolve the same
  region-aware `/dashboard/create` target when a user explicitly enters that
  Agent path, then refresh the account catalog after regaining focus.
- Conversation and composer behavior: shared models/controllers; separate DOM
  and native views.
- Workbench resource identity and durable routes: shared. AppShell geometry,
  right/bottom panel placement, iPad split view, gestures, text editing and
  accessibility: platform implementations with matching semantic APIs.
- Extension manifest, activation identity, install permissions, commands and
  declarative contributions: shared. Arbitrary React DOM/React Native component
  bodies are not a public cross-platform plugin ABI.
- Embedded feature controls share semantic state contracts rather than raw
  renderer markup. Web `Select`/`Option` primitives emit stable state and role
  attributes, while the Host theme adapter owns their colors, focus, selected
  and disabled presentation. Body-portaled controls must choose a named Host
  presentation plane such as `floating-control`; feature code must not invent a
  numeric `z-index` relative to an application modal.
- Modal windows follow the same ownership rule. Feature code supplies content
  plus a renderer-neutral descriptor; the platform owns the controller, the
  single modal Host, the window surface and all modality behavior. Web adapts
  that contract through Radix Dialog for Portal, focus, Escape and outside
  interaction. Expo adapts it through React Native `Modal` today and may map a
  fullscreen presentation to a navigation Stack later. Features must not own a
  scrim, focus loop, Escape listener, Portal or numeric modal `z-index`.
- Announcement windows are a content specialization of that modal contract,
  not another window manager. Trusted JavaScript calls
  `api.window.showAnnouncement()` with a serializable descriptor and awaits a
  data result; `AnnouncementCenter` owns request/extension lifetime, while the
  renderer supplies the themed content recipe through the existing modal Host.
  Campaign eligibility, impression persistence and automatic scheduling stay
  in a separate orchestration layer.
  Renderer-owned static assets must be resolved to an absolute HTTP(S) or blob
  URL before entering that descriptor. Relative Vite asset strings are a Web
  adapter concern and must not weaken the renderer-neutral validation contract.
- Timeline windowing, restore anchors and latest-Turn follow policy: shared
  algorithms. DOM `ResizeObserver`/scrollTop and RN `onLayout`/contentOffset are
  thin platform adapters; neither platform may introduce another virtualizer
  as window authority.

Trying to share the Web DOM frame through React Native Web would weaken the
desktop result. Trying to embed the DOM composer in native would create a
WebView boundary and break native input behavior. The reusable unit is the
typed feature contract, not the rendered element tree.

### Settings-owned local Model Services

Settings owns only the page placement, category navigation and master-detail
viewport. The extension-owned Model Services View keeps its provider directory,
drafts and immutable local Host client across Settings reattachment. Connected and
hostless shells use the same Settings route; neither creates an Environment parent
or a second model settings service. Removing the page from view must not dispose a
Host, alter the active conversation, or rewrite model/provider configuration.

Electron activates these settings with its daemon-owned `local` and
`local-codex` Host profiles. The generic OpenCraft Web package includes these
settings views and activates them from website-owned HTML configuration before
Host startup. The website derives `local` (managed site) and `local-codex`
(managed site), both `remote-control`, from its primary and Codex proxy targets. URLs
remain same-origin; private execution addresses and HyperNode user headers are
not exposed. The managed website disables the HyperNode plugin to avoid a duplicate
primary profile; its user header remains transport configuration only. Explicit `VITE_APPSERVER_HOSTS_JSON` overrides the runtime
list; explicit Agent/HyperNode build flags override activation. Static/Vite
pages without configuration retain existing defaults; invalid injected data
fails startup through the existing error boundary. Legacy generic Web HyperNode
links and remembered history resolve to `local` at the Router boundary; missing
local thread/project selections are copied without deleting legacy values or
overwriting existing local intent. This compatibility applies only to the
website-owned primary proxy without explicit Host overrides or a real saved
HyperNode profile. the downstream product excludes these
plugins and Electron ignores website configuration. The Web
extension registers presentation only; the deployment's WebSocket profiles own
the Host connections, and provider credentials remain on the AppServer Host.

Implement a feature in this order:

1. protocol/domain types;
2. renderer-free runtime command and snapshot projection;
3. first vertical platform adapter;
4. a second physically different adapter that proves the SPI;
5. freeze the smallest contract that both implementations need;
6. remaining platform adapters and cross-platform capability tests.

If a feature starts in either app with networking, timers, persistence, or
business state embedded in a component, it has crossed the boundary too early.

### Embedded console model authority

The embedded the downstream product Chat uses the Host's configured model policy. Its model
and reasoning controls are omitted; saved Composer choices cannot override the
current Bot/Profile configuration. Before each new Turn the runtime re-reads
the profile-scoped Host model catalog, validates input against its declared
default and submits that canonical model. It does not hard-code `auto`, choose
the first model, or overwrite Hermes reasoning settings. Missing defaults fail
before sending and direct users to model settings. Steering and queued follow-ups
retain the running Turn's model semantics. The full Workbench keeps user-owned
model selection.

### Host-owned automatic Codex conversation titles

The shared local or SSH Codex product adapter observes newly created durable Threads and starts
one background title attempt after their first accepted text input. It uses the existing initialized AppServer connection for a
private
ephemeral Thread, a structured `turn/start` result, then `thread/name/set` on the
original Thread. Actual `model/list` availability selects Luna, then mini; it
never changes the conversation model or creates a second credential owner.
A missing small model, invalid result, error or 30-second deadline preserves the
existing preview. Existing/resumed/forked Threads are not bulk renamed.

The Host owns at most two simultaneous inference turns and 32 pending jobs; a
View disconnect does not cancel title generation. Inference has no project
documents, tools, plugins, hooks, memory, search or runtime workspace roots.
Private frames do not enter the conversation UI, completion notifications or
product metadata indexes. Cleanup interrupts only an unfinished private turn
and unsubscribes its ephemeral Thread. Host disposal cancels all pending work.

Manual rename, deletion and archive invalidate pending generation at admission.
Before applying, the Host serializes against original-Thread mutations and
rechecks the native name; an existing name is preserved. Successful persistence
invalidates catalogs for every initialized Client, including readers without an
open Thread View. Native storage remains the title authority. Only the adapter receiving the creation response owns the title attempt; other
Hubs or Clients observing notifications do not start another attempt. Pure native
core forwarding does not create a second owner; DSH and Hermes
continue to use their existing title sources.

### Shared Codex credentials

An operator may bind an account to an existing OAuth `auth.json` owned by another local credential manager. Run the packaged `runtime/codex-account-reference.mjs` with the installation's Node binary, the Codex data directory, the absolute shared auth file and an optional local account ID. Run as the service identity in its actual mount namespace while no Codex writer owns that directory; the command acquires the existing writer lock. It stores an external file reference and fixed upstream account identity, never the source tokens or shared session databases. This is an operator tool, not a browser RPC for reading arbitrary paths.

Each credential selection rereads the file, including atomic replacements and symlink targets. Source identity must still match the registered account. Missing, malformed or changed-identity files fail closed without a cached credential. The external owner alone refreshes the source; OpenCraft neither refreshes these credentials nor writes or imports over the reference. Expiry or rejection requires that owner to renew the login. Ordinary managed accounts retain their existing refresh behavior.

The service must have read access to the source in its real mount namespace; do not assume root access, copy credentials, relax permissions globally or share the whole `CODEX_HOME`. Reference files use the existing private account-secret directory and file permissions. Removing the account removes its local reference, never the external source. Older readers do not understand references: remove the newly registered external account before rolling back to one, preserving all conversation and source data.

### Codex subscription windows and extra credits

Account pooling preserves subscription percentages even when extra credits remain.
Verified usage `credits.has_credits` or `credits.unlimited`, without an overage cap,
permits an enabled account beyond a full subscription window. Window JSON persists
this optional fact without resetting utilization or changing credential ownership.
Successful upstream responses can update the credit fact; omitted headers retain
the latest observation. A real upstream429 explicitly removes that exception.
Unknown/exhausted credits, authentication errors, disabled accounts and retry
backoff retain the existing admission rules. Usage refresh owns later recovery.

### Codex model capacity retry

The Codex Host owns a durable provider retry queue in `@opencraft/host-recovery`.
Only structured native failures qualify: overload, connection/stream loss and
HTTP 500/502/503/504 (including native retry exhaustion carrying that status).
Authorization, budget/context, policy, malformed requests and tool/sandbox
failures are terminal. Error prose cannot authorize a retry.

A chain permits four automatic continuations after the original attempt.
Overload waits start at 5 seconds; other transient failures at 60 seconds.
Exponential delay is capped at 120 seconds before up-to-one-delay jitter.
Rate-limit failures consult the existing account-pool owner: a ready account
can route again, held/exhausted accounts require known reset times. Unknown
or unavailable routing facts decline retry; subscription waits beyond six hours
are declined. Waiting adds a 15-second buffer and up to 30 seconds of jitter.
No credit/reset policy is changed. Native global quota notifications cannot
identify a pooled account and are not used to invent reset times.

The engine writer lease protects `provider-turn-retry.sqlite`. It retains IDs,
category, due time and spent attempts across restarts, without prompts or
credentials. Preparation consumes a durable attempt before asynchronous work.
Duplicate failure events cannot create another queued attempt. Before sending,
the Host rechecks native thread status, latest failed Turn and pending user work.
A new message, steer, queue/Goal change, stop, archive or delete revokes pending
continuation, including during tool preparation. A final admission fence precedes
the native send. A native `systemError` thread is eligible only with its matching
failed Turn; active or unknown state never authorizes continuation. Summary history
omits error details, so a waiting receipt reuses its exact Turn-bound observed
classification. A running successor cannot inherit that previous failure fact.
Unknown acceptance is visible and is never blindly replayed.

Codex has already accepted the failed Turn, so continuation starts with empty
input rather than re-sending the user's task or replaying shell commands.
Automatic work keeps system provenance and existing native model/thread settings.
`opencraft/turn-recovery` reports scheduled, exhausted and unconfirmed states;
reconnecting clients read the same Host projection. The old
`opencraft/capacity-retry` v1 capability remains advertised to suppress legacy
client timers. Failed historical Turns are not scanned or retroactively retried.
DSH/Pi retain their existing native failure behavior and shared process-loss
recovery; the new provider retry policy is currently wired to Codex only.

### Native history read fault boundary

Codex Core history reads (`thread/read`, `thread/turns/list`, `thread/items/list`) use a Host-owned pool of bounded read-only native sockets with capped concurrency and queue depth. A socket initializes once and serves at most one RPC at a time; subsequent reads reuse it without repeating native connection initialization. Each RPC has a unique transport ID mapped back to its caller ID, so duplicate or late replies cannot satisfy another request. Its deadline includes queueing, health lookup, initialization and response delivery. Expired queued work starts no new connection. Timeout, malformed or oversized replies retire that slot; failed requests are not replayed. Transport reset fails old reads and retires their connections before a new incarnation can initialize. Host close drains pending reads and prevents late health results from allocating sockets. They do not subscribe, resume, run tools or own the Core process. An oversized response or read socket failure resolves only its originating RPC; it cannot publish failure on the shared execution/subscription socket. Payload limits stay bounded, with a non-retryable `HISTORY_RESPONSE_TOO_LARGE` response for oversized pages. Host queue/Goal/tool-configuration resumes explicitly exclude history. Capacity retries inspect one summary turn, and schedule inspection scans bounded summary pages, retaining unknown when the target is unavailable. This is a failure-domain boundary, not tenant data separation or process-level resource isolation.

### Execution observation and bounded history delivery

The shared schedule owner tracks plans and occurrence bindings, while native
execution events and engine receipts supply outcomes. Codex/DSH/Pi implement the
same port with native-specific recovery; Pi now declares schedules and paginated
history. Per-conversation bounded flights keep slow admissions from holding peer
completion. History RPC serialization fails oversized results within the request
without retiring the shared connection. Configuration snapshots are confirmed
only after native installation in each adapter. The detailed ownership and
limits are in [execution ownership](../../execution-ownership.md#bounded-history-replies)
and [session capabilities](../../session-capabilities.md).

### Connector HTTP recovery and consumers

Headless connector reads use the selected browser server context. Polling owns state and pending approvals; a successful read only invalidates managed configuration when supported definitions or instances change. Management views retain and release their Host subscription independently of background connection/approval synchronization. List reads coalesce while in flight and support cancellation; a configuration invalidation during a read schedules at most one subsequent read. Authentication failure revokes earlier requests across Hosts and backs off recovery; stale rejections cannot invalidate a newer successful response. Origin/protocol or resource denial clears only the affected Host and waits for an explicit retry. Mutations are never automatically replayed.

### Responses stream completion and account-owner handoff

A successful `/v1/responses` SSE stream ends at a complete JSON data record
with `type: "response.completed"` and a response identity. The loopback bridge
forwards that record, finishes downstream HTTP and cancels the remaining provider
body; native consumers already stop reading at this protocol boundary. Waiting
for provider HTTP EOF can turn an ordinary native close into an uncertain write.
SSE framing is incremental across UTF-8/chunk/line boundaries. Completion-looking
model text, incomplete records and malformed JSON do not end the stream. The
observer retains at most 1 MiB per record; larger records pass through without
completion recognition and retain conservative transport-failure handling.

A client disconnect before completion or a failed upstream transport after
dispatch still calls the owner uncertainty hook. No POST is replayed by this
bridge, no historical uncertainty is removed, and installing a Web package does
not replace an independently running account Core. Owner handoff must separately
preserve its exact historical uncertainty list.

## Advisory service tier capability

Capability lookup reuses recent successful pages from the same runtime Host (preferring the Thread scope), with a two-second total pre-send budget. An uncached catalog request has a 1.8-second timeout. Submission includes a selected service tier only when the resolved model catalog declares it. Catalog failures or missing models omit the tier and leave model and reasoning validation to the Host. An explicit model-selection policy rejection and cancelled dispatch still block submission. Unsupported tiers are omitted silently without changing the saved preference.

## Administrator model usage policy

Deployment restrictions belong to the server, independently of personal model defaults. The managed policy database commits revision changes and actor-attributed audit records atomically. Only current server administrators may read management settings or mutate them; provider identities remain supplied by product composition. The gateway filters catalogs and rejects execution against restricted models or reasoning levels. Native Pi queue dispatch, DSH resolved request admission, ACP prompt admission and Codex internal recovery/goal admission also check policy. An already admitted Turn continues; the next Turn reads current rules. A denied persisted selection remains selected until the user chooses another option. See [policy design](../../../design/model-usage-policy.md).
