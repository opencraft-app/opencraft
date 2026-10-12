# OpenCraft platform architecture

Page teardown and owned DSH process recovery follow the
[host lifecycle contract and acceptance matrix](../design/dsh-host-acceptance.md).

OpenCraft is a dual-renderer workbench with one semantic application model. This
does not mean one global dependency-injection container. An explicit
Application Supervisor owns multiple lifecycle-scoped runtimes: Host
connections, browser resources, renderer services, extensions, panels and Query clients.
The Vite renderer is the precision desktop surface used by browsers and
Electron. The Expo Router app owns iOS, Android, and an independent Expo Web
build. Android and Expo Web use native-shaped workbench views; iOS signs in
natively, then presents the first-party `lightvela.ai/agents` site in a WebView.
The iOS site shell does not create a native Host or duplicate the site's chat
state. Its native account owns the sign-in token, and the WebView receives it
only on the `https://lightvela.ai` origin.
Expo Go skips the custom-scheme native login gate and opens the website's own
login flow. The site Service Worker caches only versioned static assets for the
iOS shell; it never caches authenticated API or chat responses.
The Expo Metro server gzips JavaScript bundle responses for clients that accept
gzip. Physical iOS Expo Go tests require the CLI and phone to use the same Expo
account; an HTTPS reverse proxy uses an `exps://` launch URL. For remote Expo
Go discovery, the Expo tunnel can retain the manifest and list entry while
redirecting bundle downloads to a faster HTTPS origin for the same Metro server.

The distributed product model is `Client / Hub / Server`. A Client is a
protocol participant and may use an Electron renderer, a static Web page or
another presentation surface. The Hub is the multi-tenant attachment, routing,
subscription and lease authority. A Server owns Threads and execution state and
may attach to multiple Hubs; a Client may attach to multiple Hubs. Host describes
where a Server process and its resources run, not the Server's stable identity.
The current direct topology still projects one Host profile to one Server route;
that compatibility is isolated in `legacyDirectServerProjectionFromHost()` rather
than being repeated by feature code.

```text
Client ApplicationSupervisor
├─ AgentRuntimeDirectory
│  └─ HostRuntimeRegistry
│     └─ Legacy direct Server route (currently named HostRuntime(hostId))
│        ├─ ProtocolPort (initialized AppServer request boundary)
│        ├─ Runtime readiness / connection generation
│        ├─ Domain resources (Threads, Projects, Files, Catalog, Terminal)
│        ├─ @opencraft/appserver-client
│        │  └─ @opencraft/appserver-protocol ── Codex app-server protocol
│        ├─ Resume / Replica / Thread projections
│        └─ DuplexTransport
│           ├─ WebSocket (browser/RN)
│           ├─ Electron App Host channel → OpenCraft Daemon
│           ├─ Memory server
│           └─ Recording / Replay
├─ BrowserRuntime
├─ RendererRuntime
├─ EcosystemSupervisor
│  ├─ ExtensionSupervisor
│  │  ├─ ActivationGraph / ContributionBroker
│  │  ├─ TrustedBuiltinRuntime (Cordis)
│  │  ├─ TrustedExtensionRuntime
│  │  ├─ RestrictedExtensionHost (optional)
│  │  └─ SandboxedUiBroker (optional)
│  └─ AgentCapabilityRuntime
│     ├─ Spec Catalog / Offering Resolver / DisclosureBroker
│     ├─ Policy / LeaseRegistry
│     └─ ExecutionRouter / Journal / DraftLab
└─ QueryClient
        │
        ├───────────────────────────┐
        ▼                           ▼
Vite / React DOM              Expo / React Native
apps/workbench-web            apps/workbench-expo
Codex desktop frame           iOS · Android · Expo Web
        │                           │
Electron bridge               native/web adapters
```

`AgentRuntimeDirectory` waits for Host readiness; it does not own Host
registration, transport, Thread state, Skills state or model configuration.
Views and domain services never read the raw AppServer client registry.

The Electron App Host channel is the first Hub-shaped implementation boundary,
but its version-1 wire names are not the domain model: `rendererId` currently
identifies a logical Client incarnation, and `hostId` currently identifies a
direct Server route. New code must not use those historical names to make a
Renderer or Host the owner of Thread identity. A future protocol migration can
add explicit Hub, tenant and Server coordinates without changing the domain
contract or Sidebar presentation again.

## Package ownership

### Backend SSH Codex connections

The Node backend can attach to existing Linux or Desktop-compatible HyperNode
AppServers through OpenSSH exec and WebSocket-in-SSH. The existing Codex routing
adapter shares initialize, request isolation, Thread readers and interaction
ownership across local stdio and remote physical transports. Remote mode never
constructs local account/queue/attachment services or resolves remote files on
this machine. Backend SQLite owns administrator-managed recipes, pinned trust and
encrypted credentials. Settings drafts are transient; a live read-only profile
overlay never duplicates these recipes in IndexedDB. A separate installation-owner
HttpOnly session gates management and `/ssh-apphost`, with exact Origin and
frame-level revocation checks. Public access requires explicit fixed-HTTPS-origin
or changing-address opt-in; sessions stay bound to their admission Origin.
Default shared installation access bootstraps this session automatically without
an additional key, including after expiry/restart. Every permitted entry visitor
can use saved SSH credentials in this mode; it is not a member ACL. Operators
can require an extra key with `--ssh-require-access-key` or `--ssh-access-file`.
The Application owns bootstrap/renewal and authorization incarnation, not a
Settings mount; known session loss clears old private projections before renewal.
Legacy servers without the policy declaration still require manual key admission.
Bootstrap never dials SSH or replays connection/execution/file mutations. The
explicit management Connect command uses AppHost's service-owned admission, not
a synthetic Client or separate SSH transport. It grants no execution/answer lease;
connection status remains a projection of the shared physical slot.
The native broker's method-admission policy is independent of SSH framing.
It forwards paginated Turn/Item history as well as native Skills/config writes
and preserves unrelated upstream initialization metadata. The same validated
`opencraft/method-access` extension feeds Runtime resources, submission admission,
command compilation and Composer action resolution. Admission is not upstream
support discovery; unavailable local stores/connection resources remain excluded.
Preferences never manufacture capabilities: an SSH follow-up uses admitted Steer
instead of unsupported Queue, without overwriting the preference; rejection is
before optimistic adoption and cannot consume a draft. Legacy manifest absence
is compatible, while a malformed declaration fails closed.
The application catalog separately consumes authenticated physical readiness to
admit its logical reader through the registry. It does not change the selected
chat target, auto-connect policy or Thread subscriptions. Catalog publication
checks configuration revision and authorization incarnation across async
boundaries; a locked/disabled/removed recipe cannot regain visibility through
a late result. Settings navigation and chat navigation consume this same
application projection rather than issuing menu-local history refreshes. Management
discovery is started and disposed by the Application, not the Settings
View. Visible/online reads are single-flight, completion-scheduled and back off
after transient failures (10/20/30 seconds, capped at 30); successful reads poll
every five seconds. Foreground/online hints probe promptly without dialing a
Server. Authorization changes supersede old reads; command receipts require a
fresh post-command status read rather than joining an earlier poll. A missing
management source due to read failure has its own sidebar retry, even before
there are any SSH Host profiles; unsupported or successfully locked sources are
not errors. Healthy background discovery does not flash a loading indicator.
Runtime
uses the shared read boundary for native indexed SSH discovery, not rollout
reconciliation. Each admitted Host query owns loading/failure and scoped retry;
the sidebar never substitutes an empty success for pending/error or lets one
failed Host erase the others. Cached rows are not painted after admission is
revoked, and expansion discloses hidden remote rows within the fetched catalog.
Reconnect
awaits the old physical close before admitting a successor, and failed activation
remains observable after cleanup. Anonymous `/apphost` rejects SSH IDs; Renderer IDs and LightVela login
projections are not administrator authority. Only public fingerprints/configuration
are returned, never saved passwords. Static private key/agent recipes remain a
read-only compatibility source. This is single-installation administrator access,
not member-specific Server sharing. Reset has a physical close/claim barrier.
Closing a page or proxy does not stop the remote daemon, and reconnection does not
replay mutations. Scope, configuration, compatibility gates and limitations are
specified in [SSH Codex Servers](ssh-codex-servers.md).

### Conversation desktop plugin

The trusted `plugins/cloud-desktop` panel registers its own renderer and entry.
The application may inject an authorized backend/media adapter pair; absence
means no advertised desktop capability. Conversation owns tab identity, the
explicitly resident desktop presentation owns its transient viewing connection, and the backend
owns the remote desktop incarnation and exclusive input authorization. Closing
the viewer cannot stop the desktop or Agent. See the [desktop plugin contract](cloud-desktop-plugin.md)
for framework invariants and the remaining production integration boundaries.

The mounted presentation captures one physical activation's fixed control action;
the viewing controller fences its single-use command by connection and control
intent epochs. Focus loss still revokes immediately, but cannot turn a pressed
Stop into Take after rendering changes, or release a successor grant. Physical
clipboard capability and currently authorized paste are separate projections;
unsupported adapters do not render a dead toolbar action.

The desktop renderer alone opts into `while-tab-open` residency. Shell hiding
and tool-tab selection project logical `active=false`: the controller releases
input immediately, while viewing stays mounted. Reopening never reacquires input;
the surface consumes the same activity to detach out-of-aperture cursor overlays
and their listeners. Hidden cursor updates cannot recreate them; reopening only
restores observation, never the previous control or focus. The adapter owns this
projection, not Shell DOM queries or a second visibility registry.
Local control-cursor attachment additionally requires the same confirmed input
grant projection: observation/requesting never attaches it; Stop/revocation/blur
restore the ordinary cursor and retire fallback listeners immediately. Late shape
updates stay cached until a fresh valid grant; the framebuffer itself is unchanged.
Closing the tab or changing the panel owner disposes the viewer. Other tools keep
their existing physical-presentation lifetime. The control button projects the
user's intention immediately as Stop; only a valid backend grant enables input.

The neutral desktop plugin now owns the lazy noVNC media adapter; Vela's
`lightvela-platform/desktop` provider owns account/directory validation, CTL
preparation and attachment handoff through narrow ports. Dependencies point
from product to neutral contract/media/session-wire, never in reverse. Vela's
viewer port consumes configured authenticated broker endpoints and never owns
desktop framing or rendering. Sandbox has a bounded attachment broker with
one-use scoped credentials and confirmed remote control handoff. Its production
authority composition, native input executor and default directory remain absent;
an account or prepared VM alone cannot advertise the entry. The backend observer
transport now verifies native process/socket ownership and a fresh root-key MAC
before exposing immutable read-only RFB; this proof does not authorize a Conversation.

Local Linux Codex Hosts have a separate explicit `--local-desktop` composition:
`local-agent-host/desktop` owns authoritative native Thread checks, short grants
and root-verified streams; `CodexEngineAdapter` binds grants to server-stamped
logical Client epochs. Workbench's `HostDesktopBackend` maps Scope aliases to
native Thread IDs and consumes the neutral media/session-wire. It is independent
of Vela accounts and TAT. The dedicated WebSocket gateway is exact-Origin and
loopback-only by default; an explicit `--trusted-internal-desktop` deployment
instead trusts everyone admitted to that installation's network access. That
deployment advertises a distinct same-origin trusted-internal transport, supports
TLS-terminated HTTPS without trusting forwarded headers, and retains immutable
read-only native observation and Thread/Client-bound grants. Neither mode is
public DevCloud authentication. Hosts without either explicit mode do not
advertise it. Viewer teardown cannot stop Codex or
desktop processes. Full lifecycle and bounds are in the
[local authority contract](cloud-desktop-plugin.md#local-execution-server-authority).

Optional `--desktop-control` composes a separate root-private Unix XTest executor,
verified against the same physical incarnation; the observation stream remains
read-only. LocalDesktopService owns Thread/Client-bound control intent and
confirmation, while the native executor owns physical exclusivity, renewable
leases and held-key/button cleanup. Bounded RFB input decoding retains the grant
at each message's first byte, including fragments. Viewing recovery never
reacquires control; clipboard is explicitly unavailable in this local composition.
See [native control authority](cloud-desktop-plugin.md#local-native-control-authority).
SSH bindings do not inherit the local desktop service: the shared-native
initialize projection removes any upstream desktop extension, and desktop
attachment RPCs cannot be forwarded through the remote binding.

Local viewing recovery opts in only because preparing a new attachment cannot
replay resource creation or Agent work. Wire/media classify established transport
loss; the viewing controller owns bounded backoff and fresh-grant replacement,
never inherited input. Vela preparation remains manual on failure. See the
[viewing recovery contract](cloud-desktop-plugin.md#bounded-viewing-recovery).
Local viewer expiry is renewable through explicit discovery plus wire capability,
not a removed timeout: the dedicated viewing socket requests reauthorization,
the Host rechecks native Thread/Client/incarnation, and a matching confirmation
re-arms both expiry owners. Failure remains bounded and cannot reacquire control.
Legacy and Vela providers are not implicitly opted in. See
[confirmed viewing renewal](cloud-desktop-plugin.md#confirmed-viewing-renewal).

### Workspace file Explorer ownership

Workbench Web's workspace resource panel owns the selected Host/path, the
filesystem query, and unsaved drafts. A query result is only a server snapshot:
refreshing or switching files must not replace a dirty draft. Draft identity is
Host plus path; saving captures that identity and submitted text before the
asynchronous write, and a changed server snapshot blocks saving until the user
reconciles the draft. The extension registry in the resource model supplies
both file-type cues and the CodeMirror language choice. The code editor owns
only its document view and edit events; it does not write files or own drafts.
Binary and oversized files remain outside the text-editor path.
The file-preview header provides a download action for every successfully read
file, including empty or non-previewable binary files. It exports the original
Host-scoped Blob with the selected basename rather than editor text or rendered
HTML. Read-only embedded previews retain download without allowing Host writes.
The preview owns its Blob URL lease; Host/path/runtime generation changes remove
the old download target before exposing the next resource.

### Typography ownership

Typography is a design-system protocol, not feature CSS. The checked-in
`packages/design-system/src/typography/typography.tokens.json` registry is the
single data authority for font-family roles and per-platform semantic metrics.
`typography.shared.ts` projects that registry to TypeScript/Native, while
`scripts/generate-typography.mjs` deterministically creates the Web custom
properties in `_generated.web.scss`. Generated output is checked but never
hand-edited.

The hand-written `typography.web.scss` adapter composes a Typography Role with
an independent TextTone. Platform rasterization remains a root rendering
policy. This keeps font metrics, theme color and macOS/Windows/browser smoothing
orthogonal: selection or disabled state can change tone without creating a new
font role, and platform rendering can change without rewriting every component.
Shell and extension chrome consume the semantic primitive; feature-local raw
metrics are reserved for content systems with a separate owner.

Shared Button and Settings form controls also consume registry roles:
`control/controlSmall/controlLarge/controlCompact`, `input`, and settings
heading/label roles. Native button text metrics are projected from the same
registry; geometry remains in the button contract and is not changed by this
normalization. Web role projection can omit TextTone (`null`) when a control
variant owns its semantic colors. `controls.web.scss` owns state-only focus,
disabled and invalid feedback, including forced-colors focus visibility.
Generic Button loading preserves its label footprint and exposes `aria-busy`;
it cannot widen the button or animate the spinner under reduced motion.

The focused standards test rejects typography literals in these shared
consumers. `scripts/smoke-control-standards.ts` renders actual controls across
light/dark/custom palettes and tests size, focus, invalid, disabled and loading
states; optional isolated Electron execution requires an explicit executable.

### Theme surfaces and native appearance

`ZenCode` (`vela.core.zencode`) is an optional built-in Web/Electron palette
inspired by ZCode's layered grays: opaque chrome, light gray/white surfaces in
light mode and charcoal layers in dark mode. It does not change default theme,
typography or control density. Settings preview cards project each theme's
actual resolved-mode tokens rather than maintaining ID-specific color copies.

The design-system `theme-options` contract owns optional semantic surface
overrides (`window`, `sidebar`, `panel`, `input`, `popover`) and material enums
(`window: translucent | opaque`, `elevation: soft | flat`). Extensions provide
strict hex colors and enum values, never CSS, selectors, URLs or geometry.
Registration validates and freezes nested options before the activation batch
is published. Omitted fields retain generated colors and existing internal
shell-material defaults. Each selection regenerates the full property map,
including fallback values, so unloading a theme cannot leave old overrides.
The elevation enum affects main workspace surfaces, not every popup's shadow.

Web forwards selected palette options without narrowing away material intent.
Settings inputs consume the dedicated input surface rather than borrowing an
unrelated elevated layer. Other components use the corresponding existing
panel/popover tokens. The renderer sends only light/dark/system intent, resolved
mode, opaque-window intent and a hex backing color through the desktop bridge.
Main validates the message and retains sender ownership checks; on macOS an
opaque theme always disables vibrancy, while a translucent theme may use it only
while focused. Unfocused windows and non-macOS windows remain opaque. Legacy
mode-only messages retain their previous backing defaults. Material changes do
not recreate the window or change its bounds.

`tests/theme-material-capabilities.test.ts` covers the shared contract and native
policy; `scripts/smoke-theme-materials.ts` uses real extension registration,
renderer projection, production preload and native applicator in an isolated
Electron harness. The harness does not boot the full Agent runtime. Expo still
uses its static light/dark palette adapter; dynamic Native themes are not part
of this capability.

### Client voice input ownership

Voice input is a client input service, not an Agent Host tool or chat model.
Following BB's capture/transcription/Composer separation does not imply reusing
its Codex authentication or transcription endpoint. On Mac Electron, Main owns
one physical capture through a bundled Speech/AVAudioEngine/CoreAudio helper.
A trusted top-level preload port exposes semantic probe/start/stop/cancel events,
never executable paths, audio buffers or credentials. Web supports a selectable
browser speech adapter or the application-owned Hunyuan transcription service;
other Electron platforms explicitly report unsupported input.

The voice extension owns platform selection and a dictation-session result ledger.
Native recognition tasks supply stable utterance IDs, monotonic sequences and
partial/final events. Final results replace only their own ledger entry; hypotheses
never overwrite confirmed history. A task final rotates the native recognition
request while the same AudioEngine keeps capturing; it does not end the user session.
Only explicit stop drains the active request and ends capture. Request routing is
atomic; canceled/stale task callbacks cannot act on a replacement. Recognition
quality and native handoff latency still require real microphone acceptance.

BB-style final-only delivery means recording presents waveform, not editable ASR
hypotheses. Browser recognition uses actual result indices as ledger identities;
it never publishes partial text through the Composer observer. The completed
ordered ledger is delivered once after successful session end. Unexpected end,
unfinished utterances, cancellation or error do not insert partial results.
Draft ownership, session epochs and cancellation fence late results after submission,
route replacement or unmount. Stop finalizes once; cancel invalidates renderer results
immediately, asks the native task to release, and retains physical ownership
until process close (with bounded termination fallback). Main also releases
capture on navigation, renderer death and application shutdown.

Dictation presentation belongs to that same transient input transaction, not an
independent application-wide mode flag. The controller exposes a separate input
interaction subscription; replacing a draft or physical View releases the reserved
insertion transaction and presentation. The recording editor is read-only, retains
its original document and is not fed provisional hypotheses.
A released transaction cannot update a replacement Footer or insert late results.

The recovered Codex path captures a concrete Composer controller, synchronously
`appendText`s to its View, then sends that same controller's `getText`. Dictation
therefore appends trimmed text at the document end, adding a separator only when
the existing text has no trailing whitespace; it does not replace arbitrary old
selection. OpenCraft adopts that policy for dictation while retaining selection
replacement for generic transient producers.

Because OpenCraft separates Store and physical View, its adaptation adds explicit
write acknowledgement. The input record binds Draft ID, concrete View lease and
content epoch. `replace-content`, target/reset and View replacement invalidate the
old record; both before and after a synchronous write the same ownership must
hold. The View acknowledges only an applied transaction whose physical document
matches the expected result. Missing reservation, rejected dispatch or reentrant
replacement yields `false`/`commit-rejected`; recognition text being nonempty is
not sufficient to authorize sending. This boolean port is an OpenCraft adaptation,
not a claimed Codex original interface.
Composer owns the original Footer geometry and controls: its standard action
children remain mounted but inert/aria-hidden while an in-place dictation Footer
owns the region. Editors are not remounted to switch modes. The voice extension
provides semantic status, cancellation and a single completion promise, not a
React replacement toolbar or access to the root controller.

While a provider is starting, this same Footer shows only the shared decorative
progress indicator and a neutral screen-reader announcement. Startup includes
microphone acquisition, audio-context activation and provider readiness; it does
not prove that an operating-system permission prompt is open. Only a confirmed
listening event replaces progress with the waveform and starts elapsed recording
time. Cancellation stays available before readiness and fences late completion.
This feedback adds no minimum wait, microphone prewarming or background capture;
it does not shorten or claim to measure physical-device startup latency.

Stop-and-insert completes recognition without submitting. Transcribe-and-send
and Enter wait for final text and revalidate the same draft and physical View
before invoking the existing submission compiler. The read-only editor's Enter
is dispatched by the dictation keyboard owner; Enter on a control remains native
button activation. Send availability while capturing does not depend on publishing
provisional draft content. Cancel, error or owner loss
resolve completion negatively, so late results cannot authorize a send. Repeated
stop requests share one completion. Escape cancels; a Codex-style 150ms hold
separates release-to-insert from the synthesized click. The gesture owns its
pointer-ID release/cancel listener independently of the trigger's inert state;
blur releases a held gesture, while cancellation/unmount removes its ownership.
Native audio levels are
bounded numeric samples at at most approximately 20Hz; they bypass draft snapshots
and feed a View-owned, bounded waveform buffer. No raw audio or second capture
crosses into the renderer; meters without actual samples show a quiet baseline.
See [the dictation interaction plan](../design/dictation-interaction/task_plan.md)
for the recovered-Codex/BB comparison and acceptance evidence.

Web cloud dictation separates `AudioCapturePort`, `SpeechServiceClient` and the
existing `SpeechInputProvider`/Composer transaction. Browser capture owns a single
MediaStream/MediaRecorder, drains the final recording event and converts decoded
audio to canonical mono 16kHz PCM WAV. The backend validates the actual container,
length and duration (250ms–120s), not a client-supplied duration or filename.
It calls TokenHub synchronous ASR with Base64 only after explicit stop; recording
is not routed to the selected Agent/SSH Server. Capability discovery never steals
or replaces an active capture. Explicit Hunyuan selection does not silently fall
back to another recognizer on error. Mac's existing semantic native port is unchanged.

The backend owns the API credential and normalizes vendor failures without raw
payloads. Paid public access is separately opt-in, not inherited from public SSH.
Speech model connections and write-only credentials reuse the installation's
ModelConfigurationRepository/ModelCredentialRepository and existing Model Services
commands. The voice page selects an independent defaultSpeechModel; chat defaults,
catalogs and DSH execution projections exclude ASR models and credentials. Only a
Host with the application speech service advertises ASR creation. Speech does not
follow selected SSH Servers. Legacy environment credentials require an explicit
one-time import, never runtime fallback. Capture pins an opaque configuration
binding, checked before billing; model/key changes reject old recordings instead
of redirecting them. Display-only renames do not invalidate captures.
Uploads and vendor calls share a two-operation concurrency bound; admitted paid
calls are bounded to ten per minute. Same session/attempt replays are bound to the
audio digest/language/configuration binding and use a bounded, five-minute in-memory result receipt;
there is no cross-restart task durability or vendor idempotency claim. Client
disconnect/shutdown aborts local work, without claiming upstream cancellation or
refunded usage. Voice recordings are not conversation attachments or database rows.

A retryable failure keeps the original transient input and the same ephemeral
audio, offering up to two explicit retries and expiring after two minutes idle.
Every retry gets a new attempt identity. Failure settles any old send completion
negatively: retry alone can insert, never revive the failed send intent. Cancel,
target/View loss, expiry or extension disposal releases the audio and fences
late results. UI retry/status replaces the existing Footer slots and does not
remount the editor. Deployment and acceptance are in [cloud dictation](cloud-dictation.md).

Input device UID and optional recognition language are client/profile preferences
in Main's private JSON storage, independent of model configuration and DSH.
Device enumeration/probe requests no recording permission. A missing selected
device is an error, not permission to silently switch microphones. System
authorization is requested only by explicit capture start.
`supportsOnDeviceRecognition` is checked for the selected language at capture:
when supported the request requires device recognition; otherwise Apple speech
service may be used. No universal offline guarantee is made. The bundle/helper
carry privacy descriptions and audio-input entitlements. A signed probe and
synthetic desktop test do not prove real microphone permission or recognition;
that acceptance is reported separately in [the native speech plan](../design/native-speech/task_plan.md).

### Thread lifecycle ownership

Conversation pinning is native Server metadata, not a Sidebar preference or a
bridge database. The `opencraft/thread-pins` extension declares a discovery
adapter; its list response separately proves support for the current initialized
connection. Codex uses its reserved native pinned section and metadata-only
section moves; legacy peers without that section remain unsupported. Hermes
uses the already-authenticated Dashboard HTTP channel, passes the owning profile
in each PATCH, and preserves native compression-lineage persistence. DSH has no
fallback pin store. Neither discovery nor mutation resumes or starts a Thread.

The normalized pinned catalog returns complete summaries beyond recent pages.
Runtime merges them once into the initial Sidebar catalog; pinned rows have a
separate visible group and do not consume the recent-row display budget.
The native backend remains authoritative after reload. In-memory write tails
serialize each Thread's intents, and a metadata revision fences reads issued
before a write. A revoked connection cannot publish a late pin result or replay
its write on a successor. Discovery failures remain errors, not unpin-all or
unsupported success. Catalog notifications and connection recovery invalidate
the same shared queries; no menu owns a polling loop or persistent pin set.

The LightVela site renders its own Agent sidebar around the embedded Workbench.
The embedded element passes each Thread's pinned state and the current Host's
discovered pin capability to that sidebar, and forwards pin commands to the same
Thread management resource. The site shows pinned rows outside its recent-page
budget and never persists a second pin list.

DSH display recovery uses [JIT history](../design/dsh-jit-history.md): native
message pages retain their original unit and are mapped to requested Turn
windows without a persistent event mirror. Reading a conversation does not
activate its Agent. A read-only native description supplies metadata; execution
acquires the runtime lazily. Older history-index databases are left untouched
and are no longer opened by the local Host.

Current model identity is a Thread configuration binding, not an execution-engine
label or merely the last request's model. Fork returns the acknowledged choice;
Catalog persists it for resume and lazy execution, including never-run children.
Dynamic tool wire declarations are retained separately from normalized engine
descriptors. Preflight precedes native creation; cold display registration accepts
the declaration without mounting an Agent, and activation installs it idempotently.

For DSH-backed Threads, OpenCraft owns persisted Thread names, archive state
and fork/subagent relation in `opencraft-threads.sqlite` under the Host product
data directory. Codex uses its native AppServer name and archive state, with
`thread/list` and `thread/read` projecting names, instead of duplicating them
in the DSH catalog. Engine
history remains behind the native execution port; metadata discovery never
overwrites a user name or revives an archived Thread. Temporary metadata,
native event logs and application history indexes remain in memory and are
expired on engine restart. Projection/checkpoint adapters must not persist
temporary content, including late disposal writes.

AppHost stamps a logical client identity at the trusted lease boundary and
routes targeted replies/server requests back to that client. Physical transport
sharing does not merge subscription or execution ownership. `thread/unsubscribe`
detaches one logical subscriber; another subscriber is unaffected. Idle durable
threads unload after a 30-minute no-subscriber activity grace; a temporary thread
releases after its final subscriber. Unload and resume transitions serialize.

The Codex Daemon has one physical AppServer stdio subscription per Thread, while
each browser lease owns a separate logical read subscription. A logical
`thread/unsubscribe` or lease disconnect removes only that Client; it never
forwards a native unsubscribe. A pending `thread/resume` is a provisional read
target so notifications arriving before its reply can enter that Client's
resume buffer. Detach/disconnect invalidates the provisional target, and a late
reply cannot reattach it or acquire the separate interaction-response owner.
The Host keeps the physical subscription while any logical reader, admitted
Turn, unsettled queue item or unanswered AppServer request still needs events.
Only an idle, demand-free native Thread is released (2-minute grace for
durable Threads, immediate for ephemeral Threads); release and new native work
serialize per Thread. This is live fan-out plus snapshot/replay during resume,
not a durable event log or multi-tenant authorization boundary.

The packaged Codex runtime is pinned to `0.157.0`: its loaded paginated-Thread
resume path can attach a new Client with `excludeTurns` without materializing
the full persisted history. OpenCraft still sends the physical `thread/resume`;
skipping it would lose atomic subscription and interaction ownership. A
server-rejected Resume is retained for the current connection generation so
automatic View reacquisition does not replay the same failed native request.
An explicit user retry and a new physical generation may retry; transport
failures are not memoized. The shorter Host grace is an additional release
policy, not a substitute for Codex's own idle-thread cleanup.

Native Fork copies a complete, validated event/context prefix with opaque
provider state, not the currently loaded UI turns. Turn boundaries use logical
to-native generation coordinates. Fork gets a new logical identity; execution
recovery keeps the existing identity. Side Chat adds a canonical inherited-history
boundary before acquiring a view or accepting new work. It inherits the effective
model, roots and permissions without continuing the parent task. Its close
transaction retains cleanup ownership for retry and preserves primary failures.

The Thread menu and Side Chat read one versioned Host lifecycle extension,
`opencraft/thread-lifecycle`; an absent, unknown-version or omitted operation
is unsupported. Codex and DSH both use the generic `thread/fork` menu action
and navigate only after the Host acknowledges the child. The menu keeps a
visible pending state while that acknowledgment is outstanding;
once acknowledged, it opens the child without waiting for a background thread
catalog refresh. A changed route scope prevents the late result from stealing
navigation, while the catalog refresh still runs for eventual list freshness.
Ordinary Fork keeps the native AppServer parameter semantics and has no
Workbench request deadline; unlike short reads, a large-history Fork must not
be declared failed after the generic 30 seconds. A transport loss still leaves
the outcome unknown, so the UI warns against blind retry rather than claiming
that the child was not created. Identical concurrent durable Fork intents
share one pending AppServer request within the Host runtime.
Temporary Side Chat requires explicit fork, ephemeral, inject-items and
unsubscribe support. Codex
Fork is only recoverable after the source's first Turn has been accepted;
paginated ephemeral Fork uses `excludeTurns: true` and its returned child is
adopted as the baseline rather than resumed from durable storage. The shared
Codex Engine adapter subscribes only the requesting logical client to the
child; a disconnected client's late Fork response cannot reclaim ownership.
Codex persists a blank durable Fork so `thread/read` can recover it after an
engine restart, but its native `thread/list` omits that child until the first
child Turn completes. The Host-scoped Workbench runtime temporarily projects
the acknowledged child into the default catalog and removes that projection
once the native list includes it; ephemeral children and filtered/archived
queries are never overlaid. The projection is in-memory, so a browser reload
before the child's first Turn retains direct-route recovery but not sidebar
discovery of that blank child.

The SDK fences late unsubscribe responses, retains newly acquired views and
actually reattaches them. Naming uses per-Host/Thread acknowledgement queues and
optimistic-write generations; archive/unarchive modifies durable catalog state,
never deletes a workspace. Catalog notifications invalidate shared queries.
Codex Host exposes rename through `thread/name/set`; the native `thread.name`
is readable from list/read and survives an AppServer restart. The Workbench
title writer keeps optimistic edits scoped to the same Host/Thread until the
native acknowledgement or failure arrives.
The application shell alone projects the current page title to `document.title`
as `<page title> · OpenCraft`, sharing the header's task/extension title rather
than introducing a second title cache. Draft and Settings pages use `OpenCraft`;
background conversations and panels cannot overwrite the document title.
Codex Host advertises archive only when its native AppServer path is wired:
`thread/archive` and `thread/unarchive` pass through the logical-client adapter,
and archived Settings reads native `thread/list {archived:true}`. A Codex Thread
without a first accepted Turn has no rollout to archive; the existing
first-Turn durability rule keeps that blank Thread out of the durable sidebar.
The main sidebar offers only Host-declared operations for active Threads and
does not retain archive-management or transient undo state. Archived browsing
and restore belong to a capability-gated Settings page, scoped to the active
Host and backed by the same catalog query/invalidation owner. All menus and
settings controls reuse the existing Radix and theme primitives. Source and acceptance are tracked in
[the lifecycle plan](../design/thread-lifecycle/task_plan.md).

### Project selection and persistence

OpenCraft owns the local Project catalog and stable IDs. The local Host serves
`project/list` and `project/create` from `projects.json` in the product storage
directory (desktop: `~/.opencraft/projects.json`), using locked atomic writes.
Selecting the same normalized roots reuses the existing Project; the catalog
does not come from DSH `workspace.list`. DSH only receives execution `cwd` and
workspace roots, and can be replaced without losing the product catalog.

Electron Main exposes a narrow, trusted-main-renderer `projects.pickDirectory`
port. It opens a parented directory-only system dialog, validates the selected
absolute directory, and returns a path or null on cancellation. It does not
create a Project. The shared project menu consumes the port only for `local`;
Web/remote Hosts retain their Host-scoped filesystem picker and advertised roots.
Adding a Project requires the selected Host transport to be ready; the menu
explains why it is unavailable while connecting.
An interaction epoch invalidates picker/create results when the draft, Host,
workspace, submission phase or visible route changes. Persisted additions remain
in their original Host catalog, but never retarget a replacement draft.

### Read-only SQLite diagnostics

The decided, not-yet-implemented lifecycle for OpenCraft-owned SQLite and
IndexedDB stores is documented in [storage lifecycle](./sqlite-lifecycle.md)
and [plugin persistence](./plugin-persistence.md). It retains node:sqlite and
does not adopt Drizzle in this phase. Client-local and Host-owned data have
separate authorities; engine-private databases retain their owners.

The first [Host document API](./host-document-storage.md) implementation exposes
versioned capability discovery, read/CAS and content-free invalidation on the
authenticated Local Agent Host. The client borrows a fixed initialized Host
connection and rejects old generations, with no local fallback or implicit
reconnect. This adds API capability, not a Host plugin runtime or multi-tenant
authorization model. SQLite code is shared through document-storage's explicit
Node entry; Web/Expo consume only the pure contract.

Electron internal developer mode exposes a Settings inspector for the four
OpenCraft-owned local Agent SQLite databases under the current desktop profile:
session routing, history index, thread catalog and execution authority. Main
owns the filesystem boundary and opens only those fixed filenames with SQLite
`readOnly` plus `query_only`; Renderer receives database metadata, table schema
and bounded paginated rows. The port accepts neither paths nor SQL and provides
no mutation, import, export or delete operation. Developer-mode visibility is a
presentation gate, not the security boundary. Row values stay on the device;
Blob data is summarized and long cells are bounded for debug rendering.
The Workbench-owned five-Escape gesture toggles internal developer mode for the
current browser session. Plugins, Laboratory and the Electron SQLite inspector
are internal Settings entrances. Disabling the mode removes them
immediately; an active internal-only route returns to Appearance rather than
leaving inaccessible content mounted.

Bot product surfaces are temporarily part of the same internal presentation
audience. Normal mode does not project the Bots application, Bot sidebar
entities, Bot creation command, or Bot conversation views. Enabling developer
mode restores them together; disabling it while a Bot view is active returns
to the ordinary Chat route. The extensions and AppServer capabilities remain
loaded, so this audience flag is a presentation policy rather than an
authorization or persistence boundary.

### Internationalization authority

OpenCraft follows the recovered Codex application localization path: explicit
locale override, an `IDE` / `SYSTEM` / `FIRST_AVAILABLE` source policy, canonical
BCP-47 tags, regional catalog matching, lazy messages, and a cached FormatJS Intl
instance. `FIRST_AVAILABLE` prefers a non-English IDE locale, then a non-English
system locale. The standalone Web/Electron adapter selects `SYSTEM`; the embedded
host supplies the equivalent of Codex's IDE locale. Product region is not an input.

`packages/i18n` owns `LocaleRuntime` and its narrow `IntlPort`. Each application
gets its own runtime/cache. Its snapshot carries the exact Intl object consumed
both by `RawIntlProvider` and imperative services; no global language singleton
can cross embedded application lifetimes. UI call sites own stable message IDs,
English `defaultMessage` and optional translator descriptions. FormatJS handles
ICU plural/select, rich text, dates, numbers, lists and relative time. Missing
translations use English source messages while Intl retains the resolved locale.

`locale.override` is an installation-scoped UiPreferences key. Empty string means
no explicit override and must remain empty when resolving system/host language.
The existing IndexedDB / Main SQLite adapters own persistence and invalidation.
React does not write locale localStorage. Desktop supplies preferred system
languages through a trusted preload port; resolved renderer locale also updates
the native tray through a validated IPC projection, without writing another preference.

`WorkbenchIntlProvider` sets lang/dir on its owned presentation root. Standalone
owns the document element; an embedded instance owns its custom element only.
Embedded `localization` options and `setLocalization()` update the existing
runtime. Without explicit host input, the embed observes its parent document's
lang. Language changes never recreate applications, conversations or Composer
editors. ProseMirror updates placeholder/aria-label in place and retains history,
selection, composition and draft ownership. Translator resource requests are
generation-fenced; failed chunks retain source messages and can be retried.

The initial OpenCraft catalogs cover English and Simplified Chinese for the
migrated shell/settings/chat/browser controls. Other feature-local hardcoded
copy and vendored Hermes dictionaries have not been claimed as migrated, nor
are Codex's product-specific 64 translation catalogs represented as OpenCraft
translations. Their messages belong to different products. Catalog registration
uses literal dynamic imports so only the selected translation chunk loads.

`npm run check:i18n` checks source ID/default consistency and ICU parameter parity;
`--extract <path>` on its script exports descriptors for translators. `test:i18n`
covers source policy, late results, load failure/retry, root isolation, persistence
and shared Intl identity. `smoke:i18n` exercises actual Settings/Composer/Intl and
IndexedDB, including focus, DOM identity and undo across a locale switch. These
checks are part of `gate`; locale coverage is distinct from runtime correctness.

### UI preference authority

Workbench UI preferences are owned by one asynchronous, typed
`UiPreferencesRuntime`. Every registered key declares a schema, default value
and subject scope (`installation`, `account`, or `workspace`); React never
chooses or calls a physical store. Web installation preferences use a
Renderer-owned IndexedDB adapter. Electron's loopback origin uses a random port
per launch, so its installation authority is a Main-owned profile SQLite table
behind a restricted asynchronous preload bridge; Renderer IndexedDB cannot be
its cross-restart authority. Future account/workspace keys must supply their
own HTTP/AppServer authority adapter with revision/CAS.
Temporary interaction state such as peek, hover, drag projection and animation
never enters the preference store.

`chat.defaultFollowUpAction` is an installation-scoped `steer | queue`
preference, defaulting to `steer`. Chat settings and the main conversation
Composer consume the same runtime snapshot. The preference chooses the default
intent only while a response is active; idle sends remain normal Turn starts.
It neither creates a Host capability nor enables atomic queued-message steering.
Temporary Side Chat has no durable queue and retains immediate follow-ups.

`voice.inputProvider` is an installation-scoped `auto | system | hunyuan`
preference. Web's default `auto` chooses Hunyuan only after the backend contract
and local recording capability are available, otherwise the browser adapter.
The choice is read once per capture and is independent of model/Host selection;
it grants neither microphone permission nor paid-service access. No speech
credential enters UI preference storage.

Shell Navigation is the first migrated consumer. Applications Pin, Account
Pin, rail detent, last visible detent, navigation-rail width and left context
sidebar width are installation-scoped.
Applications defaults to unpinned. The legacy `applications: true` value is
not migrated because previous releases automatically persisted that product
default and cannot distinguish it from explicit user intent; other valid
legacy geometry is migrated once. IndexedDB and Electron SQLite both carry
monotonically increasing revisions; Web uses BroadcastChannel invalidation and
Electron publishes change events through its preload port.

Cloud Storage uses the standalone management-page hierarchy adapted from
`codex/chat-demo-v2`: the route owns a stable page title and content boundary.
Its View and navigation contribution are internal-audience only: normal mode
hides both, and disabling developer mode exits an already-open storage route.
This is a presentation gate; storage services and data are not removed.
Anonymous state renders the complete LightVela site selection and sign-in
controls in that content area instead of replacing the page with a bare notice.
Authenticated state mounts the existing TAT file manager for the selected Bot.
This page does not invent local-storage semantics. Skills is a separate full
Workbench adapted from `chat-demo-v2`: public catalog discovery is anonymous,
while installed state and mutations belong to an explicit installation target.
Targets are either the local DSH user root (`~/.opencraft/skills`) or a connected
Hermes Profile; local DSH is never represented as a Profile or Bot. Workspace
discovery additionally reads `<cwd>/.opencraft/skills`, while DSH retains its
native project/user `.agents/skills` roots. Local SkillHub artifacts cross the
AppServer boundary as bounded, checksummed files, install atomically below the
managed root, and uninstall moves the exact entry to recoverable local trash.
Hermes Profile mutations continue through the Profile Skills Host protocol.
For Settings layout, edge-to-edge is an inset policy rather than a scroll
ownership transfer. The persistent AppShell Header remains outside the content
viewport; the Settings viewport keeps `min-height: 0`, stable scrollbar gutter
and the sole vertical `auto` overflow, matching Codex's Header-plus-scrollport
topology. Only master-detail pages suppress that outer scroll and delegate it to
their bounded internal panes. Feature content must not add a second page-level
scroll container merely to compensate for Shell clipping.

Task workspace presentation is specified in [the workspace design](../design/README.md).
The right-panel tab strip owns one dropdown immediately after its existing plus
picker. Its first section lists available creation actions; its second section
lists all tabs in the current owner's region, independent of Browser/Terminal
type. Right-side Browser and Terminal icons remain direct creation shortcuts.
Both menus call the same creation actions; existing entries dispatch activate-tab
without creating resources. No type-group metadata or second tab store is needed.
Duplicate titles retain distinct IDs and display an ordinal; Escape does not
create/switch a resource, and selection hands focus off after the Radix menu closes.
The product exposes right-side tools only; no bottom outlet or move/reveal controls.
Legacy bottom tabs return to the right without disposing their resources.
The Cordis panel service owns tab state; main-chat overlay consumes
the existing Composer controller and Shell geometry. SideChatService owns explicit
ephemeral forks, not parent navigation. Implementation/verification status and
protocol adaptations are tracked there rather than implied by a successful build.

| Layer | Owns | Platform imports |
| --- | --- | --- |
| `appserver-protocol` | host-aware RPC, restore and replica protocol | none |
| `appserver-client` | JSON-RPC request lifecycle and low-level Cordis registry utility | none |
| `appserver-replica` | V4 authority/client, journal replay, snapshot replacement and Cordis registry | none |
| `appserver-replica-storage-node` | atomic JSON persistence for servers and Lab | Node filesystem |
| `appserver-replica-storage-web` | transactional client cache | IndexedDB |
| `appserver-replica-storage-expo` | transactional native client cache | Expo SQLite |
| `appserver-session` | Codex Desktop Resume/View hydration and V3 compatibility reader adapter | none |
| `appserver-transport-websocket` | browser, React Native and direct daemon WebSocket | WebSocket only |
| `appserver-transport-memory` | deterministic in-process AppServer | none |
| `appserver-transport-replay` | frame recording and deterministic replay | none |
| `app-host-protocol` | host/generation/lease envelopes outside AppServer JSON-RPC | none |
| `app-host-client` | Renderer-side logical App Host channel transport | MessagePort-like port |
| `app-host-server` | daemon-side physical Host lifecycle and cross-window lease multiplexing | injected transports only |
| `account-pool-host` | Host-private account metadata/secrets, affinity, quota policy and loopback provider proxy | Node filesystem, SQLite and HTTP |
| `daemon-ipc` | authenticated local daemon handshake and framed IPC | Node socket types |
| `chat-core` | host-aware identity and Turn → Frame → Block projection | none |
| `chat-runtime` | Replica-derived Timeline snapshots and command/history ports | none |
| `composer-core` | portable document, target-scoped draft, SubmitIntent and controller | none |
| `composer-appserver` | lossless document compiler and native Codex command port | none |
| `timeline-virtualizer` | Codex Turn window, restore, anchors, follow and spacer policy | none |
| `workbench-runtime` | HostRuntime registry; per-Host client ownership, Thread catalog and Replica/Session orchestration | none |
| `workbench-resources` (proposed) | renderer-neutral resource identity, durable route and presentation contracts | none |
| `extension-contract` (proposed) | versioned manifest, identity, optional access declarations, contributions and RPC | none |
| `extension-runtime` (proposed) | activation graph, owner-aware contribution broker, install/access state and Cordis-backed trusted runtime | none |
| `capability-core` (proposed) | AI-facing Spec, Offering, ModelView, Lease, Invocation and Receipt | none |
| `capability-runtime` (proposed) | catalog, progressive disclosure, resolver, policy, execution router, journal and Draft Lab | none |
| `design-system` | semantic colors, spacing, radii and theme computation | none |
| `design-system-web` | shared Web/SVG progress projection, document animation phase and motion preference cleanup; consumes renderer-free geometry | React and DOM only |
| `codex-composer` | ProseMirror/DOM composer view | DOM only |
| `workbench-web` | Codex frame, SCSS, Electron/browser adapters | React DOM |
| `workbench-expo` | Expo Router routes, native views, Expo Web view | React Native |
| `workbench-electron` | windows, tray, static origin and App Host byte relay | Electron main |
| `opencraft-daemon` | native Host process, physical transports, local Agent and DSH lifecycle | Node only |
| `apps/appserver-lab` | machine-first SDK smoke, recordings and fault injection | Node only |

Shared packages expose data and behavior, never DOM nodes, React Native views,
storage implementations, timers, file handles, or Electron IPC. Hosts inject
those capabilities through typed ports. `npm run check:boundaries` rejects the
most common dependency inversions.

Cordis Contexts are lifecycle scopes, not global application identity or a
third-party security boundary. Multiple scopes are valid when their resources
are independent; the invariant is that a physical connection, Browser instance
or native Surface has exactly one owner and every child scope is disposed by the
Application Supervisor. Renderer extension registries do not need to share a
Context with AppServer Host runtimes.

### Embedded Workbench Shell

`workbench-web` also publishes a native Web Component entry for embedding the
Workbench canvas without an iframe. The embedding product owns its outer
Sidebar, Explore/Chat routing and page history. OpenCraft owns only the right
canvas: the standard Thread/Draft conversation route, Composer and Header.
The embedded projection exposes an initially collapsed Right Panel for webpage
and conversation file previews. Its action allow-list contains only the browser
launcher; its resource renderer is read-only and omits filesystem browsing, search,
watches and editing. Full Workbench capabilities remain unchanged. Embedded Chat does not use the Bot
conversation protocol. The outer Bot identity selects a logical Hermes Host
scoped by both physical instance and native Profile; the canvas uses ordinary
AppServer Thread ownership inside that fixed Profile. Thread list, creation,
resume, history, model catalog, rename and delete must never escape it. Physical
Dashboard/session-token reuse remains instance-scoped, while Composer queue and
other logical Host state include the Profile identity.
The embedded entry constructs the same Application runtime as the full
Workbench, but contributes an explicit, ephemeral LightVela Host profile and
never persists that physical instance identity into the normal Host catalog.
On startup it restores only a Thread remembered for that exact Host identity;
the legacy global active Thread preference belongs to the standalone Workbench
and cannot select a conversation from another embedded Profile.

These differences are expressed by a typed Workbench Presentation Policy, not
route- or product-name conditionals. The full policy enables Shell navigation,
context Sidebar, Right Panel and Connector launcher. The Embedded Core Chat
policy disables Shell navigation, context Sidebar and Connector launcher, while
restricting Right Panel renderers to browser and read-only resource previews and
Composer actions to voice input. The full policy projects all
Composer actions. This keeps unavailable Web Speech or future optional actions
out of embedded products without component-level product checks.

The domestic console uses embedded OpenCraft Chat by default. The
international console retains AgentChat. The host passes an in-process session
accessor to the component; credentials are never HTML attributes or copied to
OpenCraft localStorage. Account metadata stays in memory. The console remains
the login/logout owner, and embedded startup never consumes its OAuth callback.
Vendored RepositoryContext requires injected account-bound repositories and has
no module-level default initialization that could consume a host OAuth URL.
Session replacement or logout synchronously revokes the old accessor and hides
and disposes its component before another instance can borrow the new session. Entering the domestic Chat route
loads OpenCraft; a neutral loading surface replaces legacy (which is not
mounted) while the embedded Host connects, activates its ordinary Thread/Draft, hydrates initial
history and paints. Connection failures retain the same Application and Host so its
automatic recovery can complete; they never silently restore legacy. The host projects
`opencraft-connection` phases and offers `reconnect()` without remounting a painted
canvas. A module/application startup failure before adoption offers a fresh startup retry. The Web Component's own `show()` then grants its write
lease. `hide()` revokes that lease synchronously without disposing the
Application, so returning to the host-owned Explore view cannot lose
conversation state. Only the visible owner may send,
cancel, approve or answer an interaction. The stable
`/__opencraft/embedded-workbench.js` loader points to a content-addressed Vite
entry; deployments using another static origin must provide the required module
CORS policy explicitly.
For the LightVela Pages release, the Embedded Workbench remains an independent
Vite target and is staged under the same-origin `/__opencraft/` subtree beside
the Next export. It is not imported by the Next application bundle and is only
requested when domestic Chat is active. The release build fails closed when the
reviewed Embedded artifact is unavailable, so legacy fallback cannot disguise
an incomplete production artifact.

Resource preparation starts at the domestic host Chat route after authentication,
before the Next entitlement/Bot gate and lazy settings page, alongside Bot
discovery, through the same lightweight deduplicated loader used by the migration
surface. The actual domestic rollout authority, not hidden-tool preferences,
enables both paths. Loading code never bypasses the entitlement gate for content.
It registers the component but creates no Application or Host; the confirmed
instance/Profile binding still gates the single canvas owner. Failed speculative
loads are retryable by the surface. Optional Host Proxy startup runs independently
of chat readiness. Remote loopback Browser navigation instead waits for its own
proxy registration to activate; it never falls back to client-local localhost.
Embedded Vite `assets/a-[hash][extname]` resources have immutable one-year cache
headers in the Pages artifact. Stable loaders, version files and Service Workers
remain revalidated; publishing must continue retaining old content-hash closures.

The authenticated domestic Chat route may also prepare a physical TAT connection
from the intermediate result of its existing instance-list read, independently
of the slower per-instance Profile catalogs. A sole discovered instance that is Running or an
explicit verified root-instance selection is required; a named Bot among several
machines is not enough to guess its physical target. The TAT API retains ownership,
Running-state and active-Pass checks. No extra Application/account service is
created, and the preparation sends only the TAT handshake: no PTY, Dashboard
bootstrap, loopback health probe, Profile tools or AppServer RPC.

This in-process preparation capability is owned by the route/session discovery
generation and is bounded to 15 seconds while unclaimed. Navigation, discovery
replacement and credential changes revoke it; late HTTP/socket results cannot
revive it. The confirmed Profile's normal provider/preflight and fresh instance
validation still run. Only a matching account, region, instance and API base can
claim the same multiplexer exactly once. Adoption enables the formal transport's
ordinary health probing and transfers disposal responsibility to that transport;
the preparation binding and multiplexer configuration are owner-held snapshots,
not borrowed mutable caller options. Health configuration must succeed before
the transfer commits, so failures still leave a resource that can be disposed;
the route's old preparation owner cannot close an adopted Host. Failed, expired,
lost or already-consumed preparations use the ordinary connection path. The
capability is not stored in profiles, HTML, browser storage or a global pool.
Older independently deployed Embedded artifacts without the static preparation
API keep their original startup path. Dashboard ensure remains a post-adoption
Host operation because it can start or replace an owned remote backend.

The Embedded Application owns one deferred startup lane for Voice,
Collaboration, Bot Chat/Management presentation and the Terminal panel module.
The element releases that lane after its first visible `show()` handoff has
painted; repeated `show()` calls do not activate a second copy. The required
account/instance/Profile validation, WebSocket and Hermes providers remain in
bootstrap, as do Terminal session/tool services needed by protocol capabilities.
Only optional presentation modules move behind chat readiness. They activate in
dependency order through the existing ExtensionSupervisor/Panel runtime; failure
does not revoke an already usable chat. Full Workbench defaults to its existing
eager startup policy. This is an Application startup plan, not a second
Application, speculative Host, or general extension activation-event dispatcher.

Retirement aborts pending optional module scopes before factories can acquire
resources. An in-flight activation is drained before borrowed services,
registries or the Host are disposed; its own Supervisor owns activation and
rollback deadlines. Module waits are bounded, and late imports after timeout or
retirement cannot install into the retired Application. A hidden/disposed element
cannot release a stale paint callback's startup lane.

`show()` is a browser-origin-scoped persisted toggle, not a one-way component
callback. One shared feature-state controller owns versioned storage, in-page
events, cross-tab storage reconciliation and a ref-counted global command.
Calling `show()` again disables the other revealed surfaces and persists that choice;
page components subscribe to the state and never wrap `window.show` themselves.
This command does not change the domestic Chat owner.
The underlying persisted-feature primitive is reusable by other internal
feature gates without copying localStorage/error/event lifecycle code.

An embedded canvas owns one explicit Presentation Root inside its Shadow DOM.
The appearance engine projects the complete semantic token set onto that root,
and every menu, dialog, context menu, drag overlay and panel tab portal targets
the same root. Embedded code must not compensate with global CSS, copied menu
styles or arbitrary z-index overrides; those bypass focus, collision geometry
and theme ownership.

`ExtensionSupervisor` is the one product-level owner for client extension
activation. A Contribution Broker lets one activation register commands,
views, Chat presenters and Composer providers across otherwise independent
runtimes; every disposer is attached to that activation's Cordis Fiber. Public
extensions never receive the Cordis root Context as part of the supported API.
User-trusted local/workspace extensions may run in-process behind that API;
isolated Web realms, Electron utility processes, remote Hosts and sandboxed UI
are optional Restricted-channel policies rather than a universal prerequisite.
A plain same-origin Web Worker is not advertised as a security boundary. Full
rationale and the migration plan are defined in
[`plugin-architecture.md`](./plugin-architecture.md).

The Web application owns exactly one `LightVelaAccountService`, whose source,
OAuth lifecycle, account View and `platformAccount` contribution belong to
`lightvela.platform`. `lightvela.hermes` and `lightvela.collaboration` borrow
that same account authority; deactivating either consumer must not sign out or
dispose the account. Collaboration uses the account's authenticated raw-request
port for its OpenAPI responses, while Hermes retains the envelope-aware request
path. No consumer creates a second token store or interprets another extension's
resource loading failure as logout.

`lightvela.collaboration` owns one routed Collaboration Workspace and the Human
Tencent IM Web data plane for Server, Channel, private Group and Member surfaces.
Its UI, service implementations and Tencent adapters are shared through
`shared/vela-collaboration-web`. The extension preserves its activation owner;
the LightVela `/agents/labs/collaboration` laboratory provides a separate
account-bound owner through the same request port. It is default-hidden behind
`show()` and only eligible when the site's selected authority is
the Beijing test API. It does not borrow Agent entitlement or Bot execution,
switch Shanghai credentials to Beijing, or create another token store. Closing
the laboratory disposes its IM scope; reopening waits for prior logout.
The current Human is read from `GET /v1/collaboration/me/profile`; the delegated
actor profile does not require a locally stored email. The legacy email-based
`/me` response remains available under its published contract.
Its activation-scoped service obtains a short-lived
session from `POST /v1/me/im/session`, logs in through `@tencentcloud/chat`, and
owns SDK close. View mount/unmount only subscribes to the service snapshot; it
cannot recreate or dispose the IM connection. This conversation state is
separate from AppServer Agent conversations and does not register a
`BotContribution`.
Within that activation, services are scoped to the shared account's
`authGeneration`. An identity change immediately invalidates the old Chat and
directory, replaces the Workspace and View state, and waits for the previous
SDK owner to finish logout before logging in the new Human. Late mutations
from a disposed scope cannot navigate the new View. The extension only
unsubscribes from account authority on disposal; it never disposes or signs out
the shared account. A send in progress remains locked to its conversation even
when the user leaves and reopens that conversation.
The empty Workspace offers Server creation through the same authenticated
account request port; one idempotency key is retained across uncertain
submissions, and both immediate and accepted creation responses lead to the
Server's default Channel only once its IM state is ready. A transient failed IM
login can be retried without creating a second connection owner. Channel and
private Group drafts are scoped to their conversation identities; older
message pages are loaded from Tencent IM cursors rather than a second message
store.
An Owner or Admin can create a one-use, 24-hour member invite from the Server
directory. An account with no Server can accept the join link with a retained
idempotency key and navigate to the returned Server ID. The one-time token stays
in View state, is cleared on Server switch, and is never placed in a route or
log. Both account and IM-session responses are checked for their required
fields so a malformed HTTP 200 error envelope cannot masquerade as a valid
Human account or Tencent IM credential.
Realtime messages received while the initial history page is in flight are
merged with that page for the active conversation, never replaced by it;
switching conversations invalidates late history results.
An uncertain text-send outcome retains the original client request ID for
that conversation. The View presents a confirmation action, which reconciles
the existing Tencent IM attempt before allowing another send; it cannot
silently turn an unknown result into a second message.
Failed root Channel initialization is rendered as a failed state rather than
indefinite preparation; the View keeps sending disabled until IM readiness.
An explicit API base/region in standalone Web config selects the account
authority but must not activate the blocking embedded-Host account preflight.
Only a configured embedded Host performs that preflight. An expired standalone
session leaves the workbench running and makes Collaboration offer a sign-in
and retry path instead of crashing the application.

`AgentCapabilityRuntime` is an optional AI-facing consumer of that platform. It exposes
searchable capabilities rather than packages, progressively loads model
context, issues Task/request-series-scoped leases, routes invocations to local/SSH/MCP
providers and records exact receipts. Extension activation never implicitly
adds every contributed Tool or Skill to a model request. The full design is in
[`agent-capability-fabric.md`](./agent-capability-fabric.md).

The first concrete external-integration slice is the application-owned
`ConnectorRuntime` plus its `ConnectorCapabilityRuntime` projection, documented in [platform connectors](./platform-connectors.md).
Trusted extensions register Providers through the existing internal contribution
transaction. It borrows Authentication session epochs and Host-owned clients;
the ConnectorRuntime owns logical readiness, explicit Thread selections and execution,
not credentials or native MCP transports. The capability projection derives a scoped,
revisioned search view, returns compact paginated summaries, loads exact schema only on
detail and then issues revocable invocation handles. Web/Electron wire stable
search/detail/compatibility/call meta tools; AppServer receives them through standard
`thread/start.dynamicTools` with `deferLoading`. Composer exposes a dedicated Connector panel, backed
by a domain Manager, Host-native MCP OAuth and a one-shot write approval queue.
Configuration/intended selections use a separate CAS store (Web IndexedDB,
Electron Main SQLite); credentials remain with the Host, and restart restores
intent without automatic connection or execution grants. Native OAuth completion
is uncorrelated by operation ID and never grants conversation access by itself.
This implemented vertical slice does not imply the complete Capability Fabric, reuse of the Hermes Settings
prototype, new native methods in DSH/Hermes, or verified third-party accounts.

The Skills capability surface now hosts a platform Connector Library alongside
Skills/packages. `connector-core` owns the directory and DTOs; `connector-host`
owns Host-private SQLite configuration, credentials and bounded OAuth transactions,
plus the MCP SDK/API adapters. The renderer receives only public projection and
authorization progress, never stored tokens. This managed path is independent of
the existing borrowed native-MCP adapter, which retains its original authority.
The Composer remains a per-conversation selector, not the configuration catalog.
The Octop-derived catalog contains 23 recipes; 19 have execution adapters and four
remain guide-only. Isolated validation is not third-party account qualification.

The settled AppServer ownership model is application `HostRuntimeRegistry` →
one `HostRuntime(hostId)` → one logical `AppServerClient(hostId)`. A shared
Electron MessageChannel or multiplexed WebSocket may live in an optional
`TransportBroker`, but it only routes frames carrying `hostId`; it does not own
Thread, Resume or Replica semantics. The existing low-level
`AppServerClientRegistryService` remains a Lab/compatibility API during
migration and must not become a second product-level lifecycle owner.

Host discovery is dynamic, but ownership is not. `HostConnectionProfileStore`
persists stable Host identities and provider configuration; the Cordis-owned
`HostConnectionProviderRegistry` accepts trusted transport factories;
`HostRuntimeRegistry` lazily creates and exclusively owns complete Host
runtimes. A provider lease is held for the lifetime of every runtime it
created, so plugin reload cannot invalidate a live connection. Web currently
ships `vela.websocket`; Electron and Expo may register platform-specific
providers without changing Host, Thread, Session or Replica semantics.

Adding a Host is `validate provider config → persist profile → register lazy
runtime`. Removing one is `reject active work → detach registry identity →
dispose runtime → delete profile`. The Profile Store is seeded from deployment
configuration only when empty; after that, IndexedDB is the Web authority.

### Host-side provider account pooling

An Account Pool is a Host-private provider credential-routing policy. It is not
a Host, execution Engine, Thread, model, authentication session or renderer
preference. `account-pool-host` owns account metadata, separate 0600 credential
files, quota observations, the provider cursor and affinity keyed by
`(provider, hostId, providerThreadId)`. Renderer-facing projections expose only
metadata and credential presence. Storage roots are injected by the platform
directory resolver; the package never derives product state from `homedir()` or
the process cwd.

Codex AppServer connects to one synthetic Responses provider on a loopback-only
HTTP proxy. Each AppServer child receives only the proxy URL and a Host-scoped
token through its environment; real account OAuth credentials do not enter
process arguments, AppServer configuration, Renderer state or logs. The proxy
authenticates the Host, strips inbound credentials, selects the account, and
injects the upstream bearer token plus ChatGPT account identity at the final
HTTP boundary. Forks may inherit their parent's affinity within the same Host;
identical provider Thread IDs on different Hosts never share a binding.
The synthetic provider's `/v1/responses` and `/v1/models` paths are translated
to ChatGPT Codex's `/responses` and `/models` paths, preserving query parameters
and Codex-owned request metadata. The Codex child generates its own persistent
installation ID in its runtime `CODEX_HOME`; migrating account credentials does
not copy another device's installation identity.

An eligible bound Thread stays pinned. A short temporary hold returns bounded
`Retry-After` for that Thread while new Threads may use another account. The
proxy advances within one request only after an explicit pre-success quota or
authorization rejection; successful responses, transport failures and
indeterminate streaming outcomes are never replayed. The provider cursor moves
to the next eligible account after the current account and wraps in configured
priority order; recovery of an earlier account does not pull new Threads back.
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
The bridge accepts request bodies up to 32 MiB. It drains an oversized body
without forwarding it and returns HTTP 413, so a large Codex history produces
an explicit size error instead of a disconnected stream.
Account order, enablement, quota and accepted affinity survive Host restart.
Affinity expires after 30 idle minutes and storage retains only the 4,096 most
recent bindings, matching the bounded BB scheduling contract.

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
Codex queued messages in `codex-host-queue.sqlite`; its physical AppServer is
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

The transport packages are peers. Replay is not a wrapper around WebSocket and
Memory is not a fake method surface: all three carry the same JSON-RPC text
frames through the same `DuplexTransport` contract. `RecordingTransport` is the
only decorator; it can wrap any physical transport and produces Replay input.

## Deliberate reuse boundary

### Bot management ownership

Applications exposes a persistent Bots management View. It consumes the
AppServer Bot directory and explicit Host connection command; selecting a
management target does not change the active chat Host. Create/clone/rename/delete
are gated by Host `botManagement` and per-Bot `management` operations. Dialogs
own only user intent and draft text; Radix owns focus, Escape and delete confirmation.
The same creation entry is used from the Bot sidebar and management page.

Hermes transports own one control-plane mutation port per account/instance,
surviving replaceable bridge generations. The port maps blank creation and
template-based cloning to the existing instance Bot API; it never constructs a
native profile from the display name. Root profile deletion is prohibited.
Creation receipts retain success or failure for a command ID; uncertain writes
are not retried automatically. Semantic revisions increase within the Host port;
fresh-read revision checks and serialized writes are not a CTL cross-client CAS.
Deleted Bot events invalidate open conversation snapshots and block later sends.
Only current Host generations may publish mutation receipts into the directory.

`@lightvela/agent-core` comes from the mono2-neutral
`shared/lightvela-agent-core` package. mono2 Web validates each product behavior
first; OpenCraft injects AppServer/Host adapters only after that contract is
stable. The core never imports either renderer, storage, auth transport, i18n or
analytics. During migration the generated mono2 HTTP repository may resolve the
package for shared Bot identity/lifecycle, but remains a compatibility consumer,
not a second source of product policy.

- Protocol, content models, session state, restore/replica logic, commands,
  deterministic tests, routing identifiers, and design tokens: 100% shared.
- React subscriptions and feature view-model hooks: share when they remain
  renderer-neutral.
- Account authentication and cloud Bot availability do not own the Web/Electron
  conversation surface. Zero cloud Bots, account refresh/errors, and sign-in do
  not replace a usable local or other-Host Workbench with a creation guide.
  Account-level `applicationIntervention` is a deprecated compatibility field
  ignored by the Shell. Only the selected Host's actual connection failure can
  request a matching provider intervention. LightVela no longer contributes an
  automatic `empty-workbench` creation guide; zero-Host startup has a neutral
  no-Agent state with a Settings action. Environment discovery and cloud
  creation services do not create an application-level Environment surface.
  The onboarding `bot-required` projection is retained for explicitly selected
  LightVela configuration, not as a global desktop prerequisite. Native Expo
  account onboarding is a separate adapter and is not changed by this desktop fix.
- Product onboarding shares a renderer-neutral account-state projection. An
  authenticated LightVela account with zero executable Bots can still enter
  Collaboration; `bot-required` belongs only to the Hermes/Codex Host path, not
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
  in a separate orchestration layer, matching Codex's announcement model.
  Renderer-owned static assets must be resolved to an absolute HTTP(S) or blob
  URL before entering that descriptor. Relative Vite asset strings are a Web
  adapter concern and must not weaken the renderer-neutral validation contract.
- Timeline windowing, restore anchors and latest-Turn follow policy: shared
  algorithms. DOM `ResizeObserver`/scrollTop and RN `onLayout`/contentOffset are
  thin platform adapters; neither platform may introduce another virtualizer
  as window authority.

Trying to share the Codex DOM frame through React Native Web would weaken the
desktop result. Trying to embed the DOM composer in native would create a
WebView boundary and break native input behavior. The reusable unit is the
typed feature contract, not the rendered element tree.

## Fixed navigation entrances

### Terminal character metrics boundary

TerminalPanel separates visual inset from its measured xterm host, and that host
also isolates inherited application letter spacing, word spacing and text
transforms. xterm owns font/grid metrics and its internal row compensation; CSS
must not override those internal rows. The terminal explicitly requests zero
additional grid letter spacing. Canvas cell measurement and the DOM width cache
must not see different application typography. WSP-21 acceptance measures full
row text advances and the last-column cursor as well as screen/host boxes.
`smoke:terminal-geometry` mounts the real panel and xterm with only the PTY port
replaced, exercises DPR 1/2, hostile body tracking, widths, wide cells, font change
and visibility, and includes the old inheritance as a failing control. Its
rounding budget accounts for pinned xterm's 32-glyph integer-width measurement;
it does not add layout padding or silently remove columns.

Terminal paste belongs to the panel's input presentation. Desktop keyboard paste
continues through xterm's helper textarea; the explicit paste action uses the
browser clipboard only while the current terminal is running. If clipboard
reading is unavailable or denied, a native text field lets touch users invoke
the system paste menu and confirm before sending. Both paths call xterm's
`paste()` so line-ending and bracketed-paste handling remain with xterm, then
flow through the existing `onData`/PTY writer. A late clipboard result must
not be delivered after the panel changes terminal or the session stops. The
entry field is View-scoped, cleared on cancellation or terminal change, and
never persists clipboard contents.

### Conversation terminal semantics

The Host remains the sole owner of PTYs and retained process output. The
renderer application projects those resources through one
`ConversationTerminalSessionRegistry` keyed by Conversation Scope. Its ordered
session directory, most recently activated terminal, Host identity, cwd, shell,
phase and bounded readable buffer are application semantics; xterm and panel
tabs are presentations, not a second process or session authority.

The Terminal panel adapter writes active-terminal changes when a terminal tab
is selected. Selecting Browser or another panel type does not erase the most
recent terminal selection. Closing the selected terminal falls back within the
same Conversation Scope, while releasing the Scope removes every association
and observer. Panel owner IDs and Conversation resource owner IDs remain
distinct.

`read_thread_terminal` is a read-only, no-argument dynamic tool. The calling
AppServer Host ID and Thread ID must resolve through `ConversationBindingStore`
to one Conversation Scope before the current terminal can be read. The tool
does not accept a session ID, enumerate other terminals, inspect xterm DOM or
cross Host/Thread boundaries. Its output is decoded from the AppServer terminal
projection and capped to the latest application buffer; the Host replay window
continues to own longer retention and reconnect truncation.

### Application Router authority

`createApplicationNavigation` in `runtime/workbench-navigation.ts` owns a React
Router data router with no loaders/actions. Electron uses `createMemoryRouter`;
Web uses `createBrowserRouter`. The existing Shell consumes its external-store
snapshot. Connected and hostless supervisors use the same implementation; Views
do not call the browser History API or keep a second writable application route.
Legacy v7 browser metadata is read only as migration input.

Application path, Router entry key, conversation identity and route/View scope are
distinct. `openChat` navigates to the entry's remembered conversation (or hostless
Home); it is not a POP. `navigateToHome` presents a new local Draft. Settings and
extension destinations normally PUSH, explicit invalid-route corrections REPLACE,
and only history controls POP. Router keys supply a known-entry projection for
back/forward. Web saves that key projection per browser session and verifies the
current Router key when restoring it; it is not another path authority. Desktop
memory history lasts for the window, not across process restarts.

History contains resource references, not evidence that a Draft still exists.
At Web bootstrap, the URL/current Router entry is resolved before choosing a
global last-used conversation, and the Router and initial activation consume the
same effective target. Host profiles validate Host availability, ScopeRegistry
validates retained Drafts, and BindingStore resolves durable promotion aliases
to canonical Threads. An expired unsubmitted Draft is not recreated under its
old ID. Global last-used preferences (including changes from another tab) cannot
override a valid current-entry target. Explicit embedded memory navigation starts
at Home and never reads or writes the containing page's conversation history.

The same resource projection validates later restored entries. Invalid references
fall back to the actual retained View, keeping its Composer; promoted aliases may
retain their original View. A View already bound to another Scope must not be
reused. Only the Router REPLACEs corrected entry metadata, preserving the current
Settings/Extension destination. The transaction consumes these corrections as
restoration events even when a POP is normalized into REPLACE.

`WorkbenchNavigationTransaction` fences preparation by intent epoch, commits only
accepted destinations, and restores the complete prior entry after a failed POP.
Changing routes cancels pending readiness without stopping a live turn. A late
Thread lease is released; late success/error cannot take navigation ownership.
POP to a different View of the same conversation must still restore that View.
Returning to the already retained View, by Chat or POP, presents it locally and
resumes readiness in the background; a newer intent or disposal fences and
releases late preparations. Selecting the current sidebar conversation from
Settings uses this same return operation, not a new View or a network-gated
selection. Submission ownership guards remain in force.
Sidebar and other selection adapters express only `selectConversation`; they do
not decide whether a Thread is already selected, whether pending hydration should
be deduplicated, or whether Settings requires Chat return. The transaction owns
that decision: reuse the remembered entry's View (or the actual retained View),
coalesce an in-flight destination only when its View also matches, and no-op only for the presented View with no
competing destination. `navigate` remains a distinct explicit-open operation, so
different history Views of one Thread keep independent Composer documents.
For a completed sidebar A→B→A cycle, the transaction remembers the last
successfully presented View per canonical conversation in a bounded preferred
map. It validates that input slot against its account-bound draft owner, not
just the 20-View presentation cache. Failed or superseded preparations never
publish a preferred View; POP updates it only after acceptance. Draft eviction
forgets the slot, and account revocation clears the map and fences pending work.
`ConversationDraftOwnerRegistry` owns at most 50 nonempty input slots and their
original Controllers independently of View/Scope resource caching. It does not
retain Thread or Host leases. Physical editing/submission protects input;
unprotected slots are evicted in last-used order, releasing attachment resources
and deleting document continuity. Empty editors are not content slots. Scope
promotion updates all retained slots, including ones with no cached View.
Unsubmitted New-chat Scope metadata also queries that input ownership: its
20-empty-record budget cannot evict a Scope with retained input. Empty history
records remain bounded separately and confer no retained-content authority.
All preparations use one intent/lifetime/Router-revision eligibility check and
one accept-or-release path, including local Draft readiness and promotion. A
promotion must originate from the still-active Draft and capture its View before
awaiting; an inactive Draft cannot supersede a newer navigation. Last-used
preferences are written only for still-current accepted command results, never
used as a second selected-conversation or route authority.
Thread/Draft stores, composer state, Host connections and background execution
remain resource owners independent of route history. Shell divider hit targets
start below the toolbar, so pane geometry cannot intercept history controls.

Reference boundaries and acceptance evidence are in the
[application navigation plan](../design/application-navigation/task_plan.md).

Chat and Settings are the built-in application routes. Local Model Services is
a normal Settings page using the shared Settings category and master-detail
container; there is no Environment application route, parent context pane,
breadcrumb, overview or connection-management page. Historical `/environments`
URLs normalize to Settings, preserving a concrete contributed settings slug when
one exists and otherwise opening Appearance.

The Built-in Agents extension registers Model Services only for Electron and its
configuration client remains permanently bound to the immutable `local` Host ID.
Moving the View does not make it follow the active conversation Host. Provider
connection identity, provider-scoped model declarations, write-only credential
intents and per-session selection remain separate; see
[Local Agent custom providers](local-agent-custom-providers.md). Model edit drafts
survive View reattachment and must be applied before saving a connection. A
capability-gated draft endpoint probe uses only explicitly entered credentials,
does not mutate the runtime and is not a substitute for full runtime validation.
The page is absent when that extension/platform contribution is unavailable; the
Shell never falls back to an active remote Host. Global Settings always retains
Appearance; internal developer mode adds Plugins and Laboratory, and Electron
also adds the read-only SQLite inspector described above. EnvironmentDirectory, account discovery and
persisted Host profiles remain runtime services used by Chat and providers, but
they have no built-in application navigation or creation UI.
Desktop account restoration runs asynchronously after extension activation and
never depends on OS Keychain. A Main-process `PrivateStorage` port persists only
region and session token in `userData/private-storage/lightvela-account.json`.
This is explicitly plaintext protected by directory 0700/file 0600 permissions,
not encryption or protection against same-account processes. Writes use private
temporary files and atomic replacement; keys and file types are validated. The
renderer still has no filesystem port or durable token storage. Legacy
`lightvela-account.encrypted` is not decrypted or migrated: one fresh login is
required. Logout clears new session data and obsolete local ciphertext without
accessing the system keychain. Generation/abort guards prevent cancelled saves
and late restoration from undoing sign-out.

### Authentication ownership

The optional `tencentoa.identity` plugin contributes a separate employee provider,
settings page and the account entrance when its server endpoint is configured.
The entrance displays the verified employee login name automatically and opens
identity details/refresh without a fixed login URL. Account contributions have
explicit presentation precedence (`entrancePriority`, default 0; Tencent OA 100);
equal priorities remain exclusive, and unloading the higher-priority contribution
restores the product entrance. Provider session/storage authority is unchanged.
Gateway-owned identities omit `signOut` when no logout operation is supported.
An anonymous employee entrance remains useful for identity details and refresh.
Its Node-only
verifier owns the private TAI application key and independently validates each
request's signature, authenticated JWE and expiration. Browser projections are
memory-only and generation-fenced. Recognition does not authorize shared resources.
Verified employee message provenance is owned by the Codex Host, not the Turn
or Renderer. The Web gateway derives a trusted connection context from signed
WebSocket handshake headers; AppHost passes it through an in-process submission
port. Each user message is keyed by stable Host + Thread + client message ID.
Only the English login name is persisted in the existing Host queue SQLite; queue
admission and provenance share a transaction. Queue dispatch never reattributes
the original submitter. History/live/shared Chat projection carry hidden sender
metadata; the native model input remains free of employee provenance.
See [Tencent OA authentication](tencentoa-authentication.md).

The application supervisor installs two renderer-neutral Cordis services before
activating extensions, and disposes them with the application (including startup
rollback). They are not per-Host, per-Conversation or per-React-View state:

- `authentication` registers provider-owned session/operation ports by activation
  owner through `authenticationProvider`. It validates explicit completion against
  the current session epoch and serializes cancellation before a replacement login.
  Providers retain credential storage, OAuth exchange, restore, logout and expiry.
  Neither this service nor the public View capability receives tokens.
- `authenticationFlows` owns the active interactive flow ID, feature lease, reason,
  presentation, pending/error state and result. Identity/profile changes are not
  login completion; a same-account reauthentication still has its own completion.
  Restore never opens a flow. Close/cancel retires its transaction; route departure
  or inline View disposal abandons only continuation. A valid late callback may
  update session truth but cannot close newer UI, navigate, or invoke feature writes.

The anonymous footer projects provider-owned `signInOptions` as one Radix menu,
using the shared menu theme and keyboard/focus primitives. Selecting an option
closes the menu and directly submits a `presentation: menu` flow; no intermediate
login dialog is mounted. Only the provider interprets/validates its opaque
`optionId` and selects a region, after any prior native cancellation has retired.
The footer reflects pending/error state; reopening its menu exposes retry/cancel.
Closing just the menu never cancels an already selected browser login. The same
content works in fixed/floating Sidecars, with its portal inside its owning footer.

For explicit reauthentication/other contributed surfaces the shared Shell projection
can render `signInViewId` separately from `viewId` (Account).
Matching login success dismisses only its own prompt; Account remains an explicitly
opened utility view. Views receive only `AuthenticationFlowPort`, not Cordis Context.
Inline environment login is owned by its form lease: authentication allows the
form to recheck prerequisites, and creation still requires explicit confirmation.
No flow persists callbacks, arbitrary URLs or privileged continuation commands.

LightVela exposes `snapshot.session` (status + auth epoch) separately from its
legacy `phase` (Bot-catalog loading/error compatibility for existing Host consumers)
and `details.phase` (profile/entitlements). Shell identity, login, and environment
discovery consume session truth. A resource 5xx never logs out or invalidates a
successful login. Authoritative 401 is handled centrally with an epoch/abort fence;
old requests cannot clear a newer session. Account changes clear old details before
new data loads, and profile mutations are fenced after their asynchronous boundary.

Account content composes shared utility-window controls: SettingsPanel owns its
header/body/footer tracks; plain SettingsGroup/Row own compact alignment;
editable text uses Radix Popover, while the host Radix Dialog owns modality and
restores focus. Avatar editing, clipboard feedback and the semantic usage meter
are reusable renderer controls. The account feature retains profile mutations,
credit interpretation and regional billing URLs. Subscription management and
entitlement recovery open `/account/billing` on the signed-in region’s public
site (`lightvela.com` for China, `lightvela.ai` internationally); the legacy
`/account?tab=billing` URL is not used. Utility modal appearance is
theme-owned and content-sized, with no account-specific fixed canvas. Warning,
error, usage-track, utility-shadow and scrim colors are emitted by the theme
engine, not hard-coded in account CSS. Returning from external billing refreshes
account details; model configuration uses the host's settings navigation.

Desktop LightVela login uses the system browser and the registered native OIDC
client/callback. Electron Main owns random state, PKCE, timeout, cancellation,
single-use exchange and OS-encrypted per-profile session storage. Only the trusted
top-level renderer may invoke the narrow preload account port. A callback received
by another profile is forwarded to its live owner through a state-addressed local
socket; the socket carries only the one-time callback and is retired on completion.
Renderer credentials stay in memory; ordinary preferences remain origin-local.
Web retains its browser-navigation PKCE path. Remote login pages never replace the
desktop workbench or receive desktop IPC capabilities. Closing/reloading the
initiating renderer cancels its pending transaction; late callbacks cannot log in.
Authenticated account/control-plane reads and updates use a Main-owned HTTP port,
restricted to the saved session's regional authority and known account, instance
listing, TAT-session and configuration endpoints. Main attaches the credential;
renderer-supplied destinations cannot turn it into a general proxy. This avoids
depending on production Web CORS rules for random desktop loopback origins.

The Shell's Sidecar owns the application/account split entrance as its footer,
not as a window-wide bottom bar. Pinning changes content placement, never the
entrance's parent or local anchor while its owner remains visible. Closing all
Sidecar columns hides the footer too; a transient sidebar supplies its own footer.
The footer owns a non-shrinking layout row below the flexing pane viewport; it is
not a zero-height absolute overlay. Scrollable navigation is constrained above
that row even with docked DevTools or long lists. Floating sidebars use the same
content/footer ownership split. The entrance is locally anchored within this row.
Sidecar paints one continuous material plane behind both panes and the footer.
There is no edge gradient. Header projects the main surface's upper lip from
the same live primary/context frames and context visibility progress, moving
left across the compact rail without waiting for the context owner to unmount.
Its horizontal hairline and Sidecar's vertical divider share the same paint
progress. No independent CSS animation or terminal boolean controls painting.
Content lifetime still belongs to the physical pane exit owner.
Expanded/context materials remain unchanged. The adjacent main surface keeps
its theme-owned stroke/elevation, including soft and flat variants; titlebar
paint must not override it. Floating overlays keep their own elevation.
This is paint-only: pane geometry, resize targets, content identity and focus
ownership do not change. See `docs/workbench-design-language.md`.
Those children do not paint additional backgrounds or stack backdrop filters:
this avoids both a white entrance strip and exposed gray window material under
the neighboring context pane. Floating footer rows inherit their owner's surface.
The compact left square opens application navigation;
the right entrance fills the remaining first-rail width and opens account content.
The group uses coordinates anchored to the Sidecar's left/bottom origin. Compact,
hidden and pane-divider transitions never change either entrance's parent, left
column origin, vertical position or square application frame; only the account
entrance's trailing space may flex. Each content surface has an independent
pin preference, while at most one transient surface is open. Application
navigation is a vertical list of existing contributions; overlapping icons are
only an entrance preview, not a second navigation model.

The application entrance directly toggles its dock on wide screens. It never
opens an intermediate application menu or asks the user to keep it in the sidebar.
On compact screens the same action toggles a Sidecar-shaped drawer, preserving the
wide-screen preference. Account retains its independent menu and optional pin.
`aria-expanded`/pressed feedback for applications reflects current presentation,
not a suspended wide-screen pin. Radix still owns drawer dismissal and focus.

Environment discovery lives in `workbench-runtime/src/environment-directory`,
owned by the Cordis `environmentDirectory` service. Configured local/manual
profiles and trusted provider sources feed one directory. Entries are lazy
connection recipes, not connected Hosts: cloud lifecycle, source freshness and
transport phase remain separate. Provider-managed entries carry a typed
`MachineResourceLifecycle` with canonical and raw phases plus explicit action
capabilities; configured Local/manual Hosts carry `resource: null`. Resource
actions route only through the owning source, require a caller operation ID and
fail closed when either capability or handler is absent. `provisionHost()` still
persists a connection recipe and never means cloud allocation. LightVela discovery lives in its plugin's
`environment-directory` folder and binds identity to region, account and instance.
It lists non-running states, paginates with generation fences, and clears entries
on sign-out. Explicit saved bindings preserve Host IDs; unbound legacy profiles
are not silently reassigned. Environment and Chat share an ephemeral profile
projection; discovery registers factories without connecting or changing the
active conversation. Passive Chat queries only connected/auto-connect Hosts.
New instance creation refreshes this same source, not a second profile registry.
The new-thread Host dot observes the selected Host runtime connection directly;
View/task activation errors never recolor it. Cloud resource phases
appear as secondary machine copy and cannot replace connection status.

There is exactly one Sidecar. It composes a primary application `SidecarPane`, an
optional contextual `SidecarPane`, and one Footer; the panes are not independent
sidebars. Each Pane separates layout from visibility: normal pointer resizing
changes the live layout width in both directions, and Frame and Viewport consume
that same width. Clip is only ink containment for explicit visibility/detent
transitions, not a way to freeze content during ordinary contraction.
Feature code provides only pane content. It does not own clipping,
opacity, mounting, dividers, Footer placement or numeric stacking levels. The
visual three-column layout is `Sidecar(primary + optional context) + main`; two-
column and immersive layouts are projections of those same slots.

`useContextPaneGeometry` owns one live MotionValue, shared by contextual frame
and viewport (not two independently writable values). Its projection enforces
`viewport = frame = live layout width` during normal drag, including contraction
and reversal. The committed width is only a persistence/rollback value. Release
updates that preference without deferred reflow. Explicit visibility progress
may clip the live layout on open/close without becoming its width authority.
AppShell dispatches preview/settle/synchronize operations. External preference synchronization runs
after dock and floating readers subscribe, so transforms cannot miss the write.
Floating presentation consumes the same viewport with its window-space cap.
Validation samples held-pointer frames, actual environment control containment,
contraction/reversal, no-jump release and cancellation/capture loss. A test that
accepts a wider frozen viewport during contraction encodes the wrong contract.

Docked and floating presentations share the same `SharedSidebarContent` owner:
primary navigation, context and footer each have one stable React portal and DOM
container. The presentation surfaces supply mount slots only. Reparenting retains
component state, scroll receipts and eligible keyboard focus instead of recreating
the conversation/settings tree. The floating surface budgets primary plus context
against its own viewport rectangle; it can project compact icons without losing
application actions or overwriting saved widths. Its Applications entrance changes
the in-overlay rail (or opens the existing drawer on very narrow widths), never
implicitly docks the entire Sidecar. Docking remains a separate header action.
Escape/outside dismissal retires both explicit peek and pointer-hover intent.
While floating, AppShell owns a transparent outside hit surface behind the
sidebar and above the conversation. A tap dismisses the transient presentation
without dispatching the same activation to the covered conversation; it does
not change the saved dock intent. Because this hit surface covers the viewport,
its touch highlight must remain transparent rather than flashing the whole
screen. Touch movement does not acquire hover intent.
Dismissal changes the requested presentation first, but the floating panel
continues to own its shared content, navigation projection and outside hit
surface until its exit animation completes. Only then may those portals move
back to the docked slots. Docking is a separate transaction and transfers the
owner immediately because the floating presence owner itself is removed.

The primary pane has three semantic detents: `expanded`, `compact` and `hidden`.
Expanded width remains a separately persisted preference; compact is
a 52px icon projection, not an overwritten width preference, and hidden only
changes pane visibility; it never clears application/account Pin preferences.
Pointer down creates a Web-owned resize transaction that snapshots the semantic
detent and live physical width, including takeover of a running settle animation.
The old animation must be stopped before reading that origin: stop can flush its
final value, so capturing first can leave a stale pointer baseline.
Pointer move directly updates live geometry and an adjacent candidate detent;
there is no spring chase of the pointer. Primary viewport is derived from that
frame: it equals the frame in the expanded range and uses only the expanded
minimum as a layout floor in the compact/hidden transition. One frame animation
drives detent settlement; viewport has no independent animation/writer.
Pointer up commits the candidate; cancel restores the saved target. Lost pointer
capture cancels once and foreign pointer events cannot drive the transaction.
Dock availability, persistence and
the renderer-free reducer cannot observe intermediate pointer positions. Keyboard
actions traverse the same adjacent state machine.

`SidecarPane` also defines the content-sizing contract: its direct feature child
stretches to the complete Viewport width. Settings, conversations and
extension navigation provide content only; they may not retain an intrinsic
route-era width inside a wider platform pane. This is why Settings replaces the
context slot without leaving an unowned blank strip.

The global Header is not a Sidecar pane child and never consumes the primary
detent. The shared Sidecar trigger and history controls remain a complete
window-chrome group at every detent; when the Sidebar is collapsed, the
persistent Header also shows Write. The separator between primary and context
panes begins below that Header and terminates above the Footer; it has no authority
over either fixed region.

`workbenchWindowMetrics` is the shared native/renderer window-size authority.
The primary desktop window may shrink to 480px, matching the main content
reserve and the current Codex primary-window contract. At that width the Shell
uses its immersive fallback: application navigation, context and right tools
are temporarily hidden without changing their saved open/Pin/width intent.
Electron Main must consume this metric rather than maintaining a larger
platform-local minimum. The 760px value used by Settings is a content maximum,
not a minimum window width.

The main Web/Electron Workbench uses a unified sidebar topology. One physical
left pane contains the global Start/extension destinations at the top, the
current application's context below, and Settings/account in a normal-flow
footer. Chat supplies the conversation list; device Settings supplies its
category index; extension pages may omit context without adding a second
navigation column. These destinations use the actual application router and
extension projection. Start invokes the shared new-task action; there is no
second Start row in the conversation list.

`ShellNavigationConfig.layout=unified` selects this presentation in App. The
shared `shell-navigation` projection excludes the former application rail from
its geometry and docking decisions. Old application/account pins and compact
rail preferences do not resurrect it and are not rewritten. There is no
Applications drawer, rail Pin action or separate application resize handle in
the main Workbench. Other explicit renderer presentations retain their existing
contracts; an embedded shell without global navigation is unaffected.

The sidebar has one saved width (default 275px, minimum 240px, maximum 520px) and
one open/closed intent. Its existing context resize transaction owns live frame
and viewport width; all nested destination/context slots follow the same value
while the pointer is held. Visibility clipping is separate and retains content
through exit. Header, main and right-tool geometry consume that single animated
left width. Neither the sidebar nor its presentation owns Host/Thread lifetimes.

`shell-space` arbitrates the complete window budget: the desktop main reserves
480px, and ordinary right tools reserve at least 320px. Under pressure the tools
are suspended, then the whole sidebar becomes floating; there is no independent
compact application rail. The existing 32px restoration margin avoids breakpoint
chatter. Saved width and visibility intent are not resize output. The Header
reveals a suppressed sidebar through the existing floating owner, dismissible
with Escape or an outside click. Choosing a global destination or Settings from
the floating sidebar dismisses it. Revealing suppressed tools uses full width.

Fixed and floating sidebars provide vertically stacked destination/context
slots for the same `SharedSidebarContent` portals. Moving these slots preserves
the DOM, filter, expanded sections, scroll and necessary focus. The footer spans
the sidebar width, with a square Settings action and a filling account entrance;
account menus remain Radix surfaces. The legacy viewport-fill rule excludes the
footer, and only menus are positioned overlays. Controls use existing navigation,
quiet-control and sidebar-entrance treatments rather than a separate visual
system. Anonymous use and account-provider behavior remain unchanged.

The browser Header does not reserve a separate Home button. The sidebar's global
Start owns new tasks while expanded; collapsed persistent Headers show Write
after the sidebar trigger. The off-layout Header clone measures the same action
count and geometry as the visible rail. Thread-edge header eligibility consumes
Shell width minus live right-panel width; left animation is not its input.

The reference is the single `leftPanelSlot` topology in the recovered
`ref/codex/terminal/use-app-shell-layout-motion-04358.ts`. This adapts the topology
to OpenCraft's existing router, extensions, space budget and account providers;
it does not copy its backend or introduce another sidebar business model. Expo
keeps its existing native shell; this Web/Electron renderer change does not
establish native parity.

## Expo Web's place

Expo Web is a first-class output of `apps/workbench-expo`, not a compatibility
mode hidden inside the Vite app. It is appropriate for mobile-width browsers,
PWA distribution, and validating universal routes. The Vite app remains the
desktop browser/Electron target where precise Codex layout and mature chunk
control matter.

Production routing can send desktop browsers to the Vite deployment and mobile
browsers to the Expo deployment, or expose the Expo build under a stable path.
Both connect to the same app-server and consume the same runtime snapshots.

## Commands

```bash
npm run dev:web          # Vite desktop browser renderer
npm run dev:expo:web     # Expo Router through Metro
npm run dev:expo:ios     # custom native build + iOS Simulator (macOS/Xcode)
npm run lab -- scenario smoke      # real 9988 SDK smoke as NDJSON
npm run lab -- scenario reconnect  # in-flight disconnect + reinitialize proof
npm run build:web        # Vite production build
npm run publish:web      # append-only publish to .runtime/workbench-web
npm run serve:web:static # production static host + /appserver WebSocket gateway
npm run build:expo:web   # Expo Web export
npm run build:expo:ios   # Metro production iOS bundle, works on Linux CI
npm run gate             # boundaries + types + Web builds + iOS bundle
```

## Vite Web release invariant

The browser and Electron renderer may consume the same Vite build, but they do
not assume that every file appears at the same instant. `build:web` emits a
Vite manifest, content-hashed assets and `version.json`. `publish:web` then:

1. verifies the build id and manifest;
2. appends or verifies every hashed asset without deleting an older hash;
3. excludes source maps from the public tree;
4. snapshots the manifest and version under `releases/<buildId>/`;
5. atomically replaces `index.html`, then `version.json`.

`index.html` and `version.json` use `no-store`; manifest-owned hashed assets use
one-year `immutable`; non-hashed public files revalidate even when Vite copies
them below `assets/`. If a lazy import fails, the
bootstrap compares its embedded build id with `version.json`, reloads once only
when a newer release exists, and otherwise renders an explicit recovery view.
This is a renderer delivery rule, not AppServer or Replica state.

The browser production host exposes the same-origin `/appserver` WebSocket gateway and
adds the authenticated HyperNode identity server-side. The current fixed
`OPENCRAFT_HYPERNODE_USER` is suitable for a single-user/debug deployment only; a
multi-user Web deployment must obtain that identity from its authenticated
gateway session and must never accept it from browser JavaScript.

The independent headless Linux server archive is a separate deployment of the
existing Local Agent Host, not a new Thread authority. Its Node launcher starts
the DSH-backed Host and serves a packaged Web Workbench from one HTTP server,
bound to loopback by default. The renderer's bundled Host profile resolves `/appserver` against the
actual browser origin at runtime; neither the browser nor the static host owns
the DSH process or its credentials. A separate `/apphost` WebSocket attaches
browser Clients to the existing Codex Engine Adapter through AppHostServer's
lease/generation contract; Codex's stdio process and account pool remain
Server-owned. The headless service retains that physical Host when the last
browser WebSocket leaves, so mobile sleep does not terminate an admitted Turn;
shutdown of the headless service releases it. The artifact is single-user, with a distinct private data root
and a single-writer lock. Explicit `--host 0.0.0.0` plus the dangerous-mode
acknowledgement allows unauthenticated HTTP on one port for static WebUI and
both WebSockets. Public mode does not check HTTP or WebSocket Origin, so an
HTTPS-terminating reverse proxy can forward to the same listener without
special forwarded-header handling; the explicit unauthenticated-public flag
is the only exposure gate. The
installer defaults to port 80 and grants only `CAP_NET_BIND_SERVICE` for
privileged ports. It adds persistent systemd supervision, not another proxy or
access policy. This direct public mode is not a secure multi-user service and
does not change the private default. The Web entry derives UUID v4 from
`getRandomValues` if `crypto.randomUUID` is unavailable on an HTTP origin;
this does not enable browser APIs that require HTTPS. It does not turn the
typed Client/Hub/Server topology into a multi-tenant Hub or expose native
Electron Preload features. The Web build registers the existing Model Services
View against DSH and Codex Accounts View against the Codex Host, so
configuration remains Host-owned rather than duplicated in browser storage.
The packaged Linux Web Host advertises `/` as the remote browse root for its
DSH and Codex nodes. The browser folder picker reads the Server filesystem via
`fs/readDirectory` and registers the chosen path with that node's Project
catalog; it never opens a macOS folder picker or uploads a client directory.
The root is a navigation hint, not a filesystem permission grant: the systemd
service's OS permissions still decide which directories can be read or used.
An older browser profile seeded with an empty root is updated only when it
still matches the bundled WebSocket endpoint; a custom non-empty root and
unrelated profile fields remain untouched.
The browser Workbench retains one AppServer transport object per Host; if its
`/apphost` WebSocket closes, reconnect replaces the invalid AppHost client and
lease inside that object. Existing Workbench listeners stay attached, while
the new lease reinitializes the logical client. If the service and physical Host
remain healthy, it keeps the same Host generation; service restart or physical
failure produces a new generation. Thread state is re-read from AppServer. The
Web host uses protocol Ping/Pong to terminate a half-open socket, and the browser
bounds the initial AppHost handshake; both mechanisms convert an otherwise
indefinite mobile-network stall into the same retryable transport failure. The
Codex Host logs payload-free logical initialize and Thread resume lifecycle
events so reconnect failures can be separated from history projection failures.
For each browser `/apphost` attempt, the Web client sends a new random diagnostic
ID in the WebSocket query. The headless server logs that ID with upgrade,
hello, Host-connect acknowledgement, heartbeat timeout and close stages; a
legacy client without the query receives a server-generated ID. If the browser
fails before it can read a WebSocket response, it posts only that ID, its
connection phase, readyState, elapsed time and optional close code to the
same-origin diagnostic endpoint. The endpoint rejects unknown fields and never
records the page URL, Thread ID, messages, credentials, IP address, Origin,
raw exception or close reason. These events locate the failing layer; a
browser WebSocket `error` cannot itself reveal an HTTP upgrade status. No
diagnostic event changes Host or Thread ownership or retries.

Weak-network recovery separates shared connection reachability, per-Host protocol
readiness and per-resource restoration. Web foreground, pageshow and online hints
are coalesced by the shared AppHost socket owner. A negotiated `connectionProbe`
capability enables a bounded, correlated `connection/probe` exchange; old peers
receive no unknown probe message. The server answers probes outside its business
queues. Probe success proves bridge reachability, not engine or Thread readiness.
Hidden pages cancel probe deadlines; old sockets and cancelled probe replies
cannot affect successor connections. The server's protocol Ping/Pong remains a
fallback for detecting half-open connections. Failed probes revoke only Client
attachments, never service-owned execution.

AppHost ready and Host claim waits have finite control deadlines. Timed-out claim
acknowledgements release their original lease; each subsequent attempt uses a new
lease. Business envelopes serialize per Host, allowing another Host on the same
socket and connection probes to progress during a slow activation. Local send
cancellation releases its pending acknowledgement without cancelling or replaying
remote execution. AppServer initialization rejects results from a revoked transport.

Workbench Host readiness ends at lease acquisition plus AppServer initialize.
Thread restoration uses bounded concurrency with retained Views first; a semantic
Thread failure stays local, while transient failures retry locally. PTY and file
watch recovery do not gate Host readiness. The application binds Host readiness to
host-scoped read-query cancellation and invalidation: active queries refresh,
inactive queries become stale, and existing data remains visible. Stable resource
query keys are retained across connections. This coordination is independent of
menu mounting; late cancelled reads cannot overwrite recovered catalog data.
Execution requests keep their existing admission and reconciliation policies and
are not replayed by connection or cache recovery.

The app-like iPhone Web surface requests a fixed viewport scale for embedded
browsers and keeps focused editable text at a 16px minimum on coarse-pointer
phone viewports. This avoids WebKit focus zoom without changing desktop
Composer density or blocking keyboard focus. Page pinch zoom is intentionally
disabled for this product surface; actual WeChat and WeCom WKWebView handling
must be checked on device because an embedding browser may interpret viewport
scale limits differently.

Electron does not use this HTTP gateway. Its loopback server is static-only;
the application-scoped transferred port described in
[`architecture/opencraft-app-host.md`](./architecture/opencraft-app-host.md) is the sole
Renderer-to-native connection boundary.

Local macOS preview builds use a separate product identity, profile directory,
output tree and ad-hoc signing path. This prevents a preview from taking the
release app's single-instance lock, daemon socket, browser session or stored
credentials. The preview hook mutates only the assembled package: it removes
foreign native prebuilds and signs after all packaged resources are final.

Release renderers use one standard Oxc minification pass plus content-hashed
asset names. They do not enable top-level ultra mangling, repeated aggressive
compression, or a second JavaScript-obfuscator pass over Electron Main,
Preload, or Daemon bundles. Runtime correctness and debuggable failure
semantics take precedence over transforming control flow; source maps remain
outside the public published tree.

## Next feature rule

### Settings-owned local Model Services

Settings owns only the page placement, category navigation and master-detail
viewport. The extension-owned Model Services View keeps its provider directory,
drafts and immutable local Host client across Settings reattachment. Connected and
hostless shells use the same Settings route; neither creates an Environment parent
or a second model settings service. Removing the page from view must not dispose a
Host, alter the active conversation, or rewrite model/provider configuration.

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

The embedded LightVela Chat uses the Host's configured model policy. Its model
and reasoning controls are omitted; saved Composer choices cannot override the
current Bot/Profile configuration. Before each new Turn the runtime re-reads
the profile-scoped Host model catalog, validates input against its declared
default and submits that canonical model. It does not hard-code `auto`, choose
the first model, or overwrite Hermes reasoning settings. Missing defaults fail
before sending and direct users to model settings. Steering and queued follow-ups
retain the running Turn's model semantics. The full Workbench keeps user-owned
model selection.

### Embedded connection recovery

The resident Host runtime remains the sole backoff/reconnect owner. Embedded startup
observes readiness across failures instead of disposing on the first rejection.
Hermes capability initialization overlaps independent control-plane Bot bindings,
native Profile discovery and hosted-room capability reads. It still waits for
their current-connection results before advertising capabilities; an unsupported
Profile API remains an absent Bot capability, while control-plane failures still
fail initialization. The first conversation list remains a fresh `session.list`
read after Host readiness, not a speculative cache that could mask session
changes during connection. Transport stage logs distinguish Host connection,
initialize and `thread/list` latency without recording conversation content.
Disconnects preserve Thread, Composer document and attachment owners; reconnect
rehydrates existing threads and does not replay user submissions. The console shows
a slow-connection notice after 30 seconds; fixed-Profile Hermes transport attempts
have a 90-second deadline. Timeout fences late bootstrap responses and releases the
physical connection; disposal cancels pending startup. Manual retry shares an active
attempt. Authentication/configuration/resource failures retain their manual-recovery
classification. Account or Bot changes retire the old component and credentials;
preservation applies within that owner, not across account changes or refresh.

Embedded browser metadata (pages, tabs and conversation bindings) uses storage
owned by one Application lifetime. Closing the panel parks its pages; switching
conversations selects that conversation scope. Bot or account changes dispose the
Application and do not restore the previous identity's browser metadata. This is
presentation isolation, not an OS filesystem or browser-cookie security boundary.

## 会话顶部信息

手机宽度（不超过 640px）不展示会话标题旁的 Project/工作区附文，标题与操作按钮保留。桌面继续展示附文。已有“…”菜单的会话详情以只读方式展示实际项目名与工作目录：优先当前会话执行信息，目录尚未恢复时可用同一会话的规范 Thread 元数据；未知字段不伪造，不更改执行目录或启动会话。
