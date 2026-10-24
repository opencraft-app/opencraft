# Platform: Presentation and input

[Architecture index](../../platform-architecture.md) · [Documentation index](../../README.md)

### Conversation desktop plugin

The trusted `plugins/cloud-desktop` panel registers its own renderer and entry.
The application may inject an authorized backend/media adapter pair; absence
means no advertised desktop capability. Conversation owns tab identity, the
explicitly resident desktop presentation owns its transient viewing connection, and the backend
owns the remote desktop incarnation and exclusive input authorization. Closing
the viewer cannot stop the desktop or Agent. See the [desktop plugin contract](../../cloud-desktop-plugin.md)
for framework invariants and the remaining production integration boundaries.

The mounted presentation captures one physical activation's fixed control action;
the viewing controller fences its single-use command by connection and control
intent epochs. Focus loss still revokes immediately, but cannot turn a pressed
Stop into Take after rendering changes, or release a successor grant. Physical
clipboard capability and currently authorized paste are separate projections;
unsupported adapters do not render a dead toolbar action.

The desktop renderer alone opts into `while-tab-open` residency. Shell hiding
and tool-tab selection project logical `active=false`: the controller releases
input immediately, while viewing stays mounted. The media adapter stops framebuffer
pull requests and disables RFB continuous updates while inactive. It completes
in-flight protocol data, retains the last frame and connection, and resumes pixels
when shown; it does not merely discard decoded frames. Reopening never reacquires input;
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

The neutral desktop plugin owns the lazy noVNC media adapter; the downstream
desktop provider owns account/directory validation, desktop service
preparation and attachment handoff through narrow ports. Dependencies point
from product to neutral contract/media/session-wire, never in reverse. the downstream product's
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
of the downstream product accounts and enterprise service. The dedicated WebSocket gateway is exact-Origin and
loopback-only by default; an explicit `--trusted-internal-desktop` deployment
instead trusts everyone admitted to that installation's network access. That
deployment advertises a distinct same-origin trusted-internal transport, supports
TLS-terminated HTTPS without trusting forwarded headers, and retains immutable
read-only native observation and Thread/Client-bound grants. Neither mode is
public DevCloud authentication. Hosts without either explicit mode do not
advertise it. Viewer teardown cannot stop Codex or
desktop processes. Full lifecycle and bounds are in the
[local authority contract](../../cloud-desktop-plugin.md#local-execution-server-authority).

An explicit native installer can bind an existing non-root Xvnc/Xtigervnc/Xvfb
display without replacing its VNC or windows. Root-private configuration and
actual X socket/process/service identity own this binding; it is never supplied
by a browser. See the desktop contract for installation and identity checks.

Optional `--desktop-control` composes a separate root-private Unix XTest executor,
verified against the same physical incarnation; the observation stream remains
read-only. LocalDesktopService owns Thread/Client-bound control intent and
confirmation, while the native executor owns physical exclusivity, renewable
leases and held-key/button cleanup. Bounded RFB input decoding retains the grant
at each message's first byte, including fragments. Viewing recovery never
reacquires control; clipboard is explicitly unavailable in this local composition.
See [native control authority](../../cloud-desktop-plugin.md#local-native-control-authority).
SSH bindings do not inherit the local desktop service: the shared-native
initialize projection removes any upstream desktop extension, and desktop
attachment RPCs cannot be forwarded through the remote binding.

Local viewing recovery opts in only because preparing a new attachment cannot
replay resource creation or Agent work. Wire/media classify established transport
loss; the viewing controller owns bounded backoff and fresh-grant replacement,
never inherited input. the downstream product preparation remains manual on failure. See the
[viewing recovery contract](../../cloud-desktop-plugin.md#bounded-viewing-recovery).
Local viewer expiry is renewable through explicit discovery plus wire capability,
not a removed timeout: the dedicated viewing socket requests reauthorization,
the Host rechecks native Thread/Client/incarnation, and a matching confirmation
re-arms both expiry owners. Failure remains bounded and cannot reacquire control.
Legacy and the downstream product providers are not implicitly opted in. See
[confirmed viewing renewal](../../cloud-desktop-plugin.md#confirmed-viewing-renewal).

### Typography ownership

Typography is a design-system protocol, not feature CSS. The checked-in
`packages/design-system/src/typography/typography.tokens.json` registry is the
single data authority for font-family roles and per-platform semantic metrics.
`typography.shared.ts` projects that registry to TypeScript/Native, while
`scripts/generate-typography.mjs` deterministically creates the Web custom
properties in `_generated.web.scss`. Generated output is checked but never
hand-edited.

Web/Electron UI and content prefer the bundled Inter Variable / Inter faces,
then the existing system and CJK fallbacks. Native retains its platform system
face. The monospace family, semantic metrics and rasterization policy are
independent of this UI preference.

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

Role usage and progressive Agent loading are owned by
[the UI typography contract](../../../design/ui/typography.md). The repository-wide
parser gate rejects typography literals in owned apps/packages/plugins; specialist
exceptions are exact and fail when stale. Semantic tests also cover role misuse,
such as paragraphs consuming button typography. `scripts/smoke/shell/smoke-control-standards.ts` renders actual controls across
light/dark/custom palettes and tests size, focus, invalid, disabled and loading
states; optional isolated Electron execution requires an explicit executable.

### Theme surfaces and native appearance

`Graphite` (`opencraft.core.graphite`) is an optional built-in Web/Electron palette
with layered grays: opaque chrome, light gray/white surfaces in
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

`tests/shell/theme-material-capabilities.test.ts` covers the shared contract and native
policy; `scripts/smoke/shell/smoke-theme-materials.ts` uses real extension registration,
renderer projection, production preload and native applicator in an isolated
Electron harness. The harness does not boot the full Agent runtime. Expo still
uses its static light/dark palette adapter; dynamic Native themes are not part
of this capability.

### Client voice input ownership

Voice input is a client input service, not an Agent Host tool or chat model.
On Mac Electron, Main owns
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

Final-only delivery means recording presents waveform, not editable ASR
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

Dictation captures a concrete Composer controller, synchronously appends to its
View, then sends that same controller's `getText`. It appends trimmed text at the
document end, adding a separator only when
the existing text has no trailing whitespace; it does not replace arbitrary old
selection. Dictation retains this append policy while preserving selection
replacement for generic transient producers.

Because OpenCraft separates Store and physical View, its adaptation adds explicit
write acknowledgement. The input record binds Draft ID, concrete View lease and
content epoch. `replace-content`, target/reset and View replacement invalidate the
old record; both before and after a synchronous write the same ownership must
hold. The View acknowledges only an applied transaction whose physical document
matches the expected result. Missing reservation, rejected dispatch or reentrant
replacement yields `false`/`commit-rejected`; recognition text being nonempty is
not sufficient to authorize sending. This boolean port acknowledges only an
applied OpenCraft document transaction.
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
stop requests share one completion. Escape cancels; a 150ms hold
separates release-to-insert from the synthesized click. The gesture owns its
pointer-ID release/cancel listener independently of the trigger's inert state;
blur releases a held gesture, while cancellation/unmount removes its ownership.
Native audio levels are
bounded numeric samples at at most approximately 20Hz; they bypass draft snapshots
and feed a View-owned, bounded waveform buffer. No raw audio or second capture
crosses into the renderer; meters without actual samples show a quiet baseline.
See [the dictation interaction plan](../../../design/dictation-interaction/task_plan.md)
for the interaction contract and acceptance evidence.

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
remount the editor. Deployment and acceptance are in [cloud dictation](../../cloud-dictation.md).

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
that acceptance is reported separately in [the native speech plan](../../../design/native-speech/task_plan.md).

### Internationalization authority

The [project-wide authoring and coverage contract](../../internationalization.md) applies
to every first-party app, shared UI and bundled plugin. Source discovery is no
longer limited to migrated Web feature folders: `check:i18n` also checks literal
JSX/accessibility/branch/template copy against an explicit legacy inventory and
validates descriptors under their Web/shared or native Main catalog owner.
A clean check reports remaining inventory debt; it does not certify full project
translation or indirect/imperative message paths. Shared dictation, queue and
image/table preview controls consume the existing application's Intl instance,
preserving domain values, draft/editor identity and current preview/queue state.


Application localization uses an explicit
locale override, an `IDE` / `SYSTEM` / `FIRST_AVAILABLE` source policy, canonical
BCP-47 tags, regional catalog matching, lazy messages, and a cached FormatJS Intl
instance. `FIRST_AVAILABLE` prefers a non-English IDE locale, then a non-English
system locale. The standalone Web/Electron adapter selects `SYSTEM`; the embedded
host supplies its locale through the `ideLocale` input. Product region is not an input.

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

Settings contributions may declare portable `titleMessage` / `groupMessage`
descriptors alongside their legacy string fallbacks. The contribution registry
validates and freezes descriptors; the Settings projection resolves them with
its application's Intl object on each locale change, without reactivating
plugins or changing page IDs, Host ownership, ordering or selection. Built-in
model services, remote connections, Codex accounts, voice input and employee
identity navigation use this contract. Unmigrated extensions retain their string
labels. Extraction includes the owning public built-in and voice plugins; employee
identity, creator grouping and participant catalogs and their validation belong
to the downstream adapter. Trusted product composition adds non-conflicting
messages to the existing application catalogs; it cannot replace core messages
or add language choices. The build entry replacement covers both the main bootstrap
and the locale catalog importer, so activation and translation consume the same
trusted composition rather than silently using separate extension lists.
All consumers retain the same application Intl runtime
and activation owner. Anonymous account labels use provider-owned message
descriptors rather than provider-ID conditionals in the Shell.
English and Simplified Chinese cover these menu labels and section headings.
This coverage does not claim that every contributed page body is translated.

The initial OpenCraft catalogs cover English and Simplified Chinese for the
migrated shell/settings/chat/browser controls. Other feature-local hardcoded
copy and vendored Hermes dictionaries have not been claimed as migrated, nor
are other products' translation catalogs represented as OpenCraft
translations. Catalog registration
uses literal dynamic imports so only the selected translation chunk loads.

`npm run check:i18n` checks source ID/default consistency and ICU parameter parity;
`--extract <path>` on its script exports descriptors for translators. `test:i18n`
covers source policy, late results, load failure/retry, root isolation, persistence
and shared Intl identity. `smoke:i18n` exercises actual Settings/Composer/Intl and
IndexedDB, including focus, DOM identity and undo across a locale switch. These
checks are part of `gate`; locale coverage is distinct from runtime correctness.

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

## Expo Web's place

Expo Web is a first-class output of `apps/mobile`, not a compatibility
mode hidden inside the Vite app. It is appropriate for mobile-width browsers,
PWA distribution, and validating universal routes. The Vite app remains the
desktop browser/Electron target where precise Workbench layout and mature chunk
control matter.

Production routing can send desktop browsers to the Vite deployment and mobile
browsers to the Expo deployment, or expose the Expo build under a stable path.
Both connect to the same app-server and consume the same runtime snapshots.

### Read-only Office resource previews

Host file authorization, byte reads, resource identity and download remain in the
Workbench resource panel. `file-preview-core` owns engine leases without renderer
imports; `file-preview-web` owns DOM attachment and the built-in adapter registry.
`plugins/office-preview` receives authorized Blob bytes, lazily parses legacy DOC/DOCX/PPTX and spreadsheet formats
and owns third-party renderer cleanup. This is a trusted built-in service boundary,
not an additional public extension ABI. See [file previews](../../file-preview.md).


### MCP App Web/Electron host

`apps/workbench-web/src/mcp-apps` owns the executable MCP App view, independently authored against MCP Apps 2026-01-26. `contract` is a narrow owner-bound capability interface; `owner` translates to existing typed AppServer MCP methods and Composer untrusted additionalContext. `policy`, `sandbox`, and `bridge` share one authorization boundary for standard JSON-RPC and Hypernode's `window.openai` compatibility API. Standard transport contains only JSON-RPC fields; signed compatibility envelopes are consumed by the injected bootstrap before a standard SDK sees them. Conversation renders the lazy App surface outside the collapsed tool transcript; ordinary tools remain unchanged. Native and static HTML previews do not gain this capability.

The Host remains the sole owner of MCP execution, resource versions and canonical conversation history. View state is ephemeral, catalog reads are shared per active owner, iframe instances exist only near the visible viewport in a foreground conversation. No polling or per-frame React updates are added. Switching owner/generation invalidates old views and pending results; tool calls are never retried. Restored built-in App cards may share one read-only canonical-history hydration before retrying a denied resource once. A failed hydration is evicted so a later explicit open can retry; a successful hydration remains cached for that owner. History loading does not grant resource access, and external servers or other resource URI namespaces do not enter this recovery path. Only inline display and text messages/context are advertised in this version. Download, sampling, resources subscriptions, nested frames and elevated browser permissions remain unsupported.

Automatic height distinguishes content invalidation from a height-only response to the iframe viewport. A viewport-dependent layout (such as body min-height:100vh with margins) cannot turn each applied height into another content request. DOM mutations, intrinsic media/font completion and width changes invalidate measurement; the observer callbacks share a single scheduled frame and are disposed with the view. Explicit App size notifications retain their existing bounded bridge semantics. The outer view observes the actual iframe width and coalesces changed-width host-context notifications; unchanged width or height-only changes do not replay context or tool results, fetch resources or rebuild the iframe. Browser geometry checks wait for the scheduled iframe measurement to reach the parent after removing temporary controls before sampling their baseline; growth and shrink assertions keep their original bounds.

References: [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

The Headless gateway supplies an actor-owned [MCP App builder](../../mcp-app-builder.md).
It reuses the existing dynamic-tool channel and MCP host, with one managed store
for definitions/releases, CAS publication and immutable runtime revisions. Generated
handlers execute in bounded QuickJS workers, not Node's application realm. The
existing execution engines remain the history authorities; remote Hosts do not
inherit this local resource authority. Service capability negotiation controls
which conversations receive the authoring tool.

## Host Composer command adapters

Trusted Host connection providers may optionally own localized Composer command
declarations and an action adapter. This extends their client-side adapter role,
not their authority over Thread, queue, Replica or authorization. Registration
validates and freezes declarations; catalog snapshots expose metadata only.
The resident runtime projects an optional command port over its captured provider
and protocol. Each invocation rechecks profile/runtime ownership, acquires the
same provider instance and releases that per-call lease on success or failure.
Retirement publishes removal immediately and drains already accepted calls.
No command registry or asynchronous lookup of the selected Host is introduced.
See [Composer semantics](../../chat-ui-architecture.md).
