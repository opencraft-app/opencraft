# Conversation cloud desktop plugin

Status: source framework, noVNC media adapter, Vela provider/viewer port, bounded
backend attachment broker and CTL resource-preparation API. Local Linux Codex
Hosts now have an explicit observation composition and an opt-in private native
mouse/keyboard executor. The
multi-tenant Vela broker is not mounted in production: its canonical directory
and a native control executor still require integration. No WebRTC service, real
TAT command is included. Local capability is opt-in; default compositions hide
the entry. Explicit trusted-internal deployments can share read-only viewing
with everyone who can access that deployment; enabling control additionally
trusts those users to request exclusive input on that same machine.

## Ownership

| Object | Authority / lifetime | Teardown |
|---|---|---|
| Authorized target | Product backend adapter, canonical Conversation binding and account/environment directory | Invalidate on binding, permission or principal changes |
| Desktop process / incarnation | Backend, independent of Chat turn and renderer | Backend policy only; no stop operation exposed to the panel |
| `cloud-desktop` tab | Conversation Panel service, singleton within one panel owner | Descriptor contains only Conversation ID, never credentials |
| Attachment | Backend-authorized short-lived viewer lease for exact target/resource/incarnation | Release on bootstrap failure or viewer teardown |
| Media transport + surface | One mounted desktop presentation | Unmount, target change, timeout, connection end or plugin retirement closes transport and releases attachment |
| Control grant | Server-authorized, exclusive and revocable input lease | Disable input before release on cancel, blur, hidden page, revocation or teardown |
| Button activation | Mounted presentation captures the pressed action; controller issues a single-use command bound to viewing/control epochs | Cancelled physical gestures, focus/page loss, revoked readiness and replaced ownership cannot reinterpret or replay a press |

The UI only requests control. Requesting is not confirmed control. Both video and
input-channel readiness must be true before requesting a grant, independent of
arrival order. Input is not bound before a valid lease arrives. A late result
after cancellation is released without enabling input. Independent peers and
Agent automation must be arbitrated by the backend, not `viewOnly` CSS.
The surface is a focusable child of the panel; adapters keep media/input focus
inside this boundary. Moving focus between toolbar and surface is not blur of
the desktop owner. Losing focus outside it releases control.

One native activation has a fixed action, not a toggle of the latest rendered
state. Pointer/Enter/Space press captures Take or Stop/Cancel; native click consumes
it once. An accessibility click without a physical press remains supported.
Control confirmation stays within the same intent, so a held Cancel can still
stop its confirmed grant. Release, revocation, lost readiness or connection
replacement retires earlier commands: a Stop followed by null focusout cannot
turn the same click into Take, or revoke a later user's grant. Window/page loss
and cancelled/outside pointer release also retire the presentation's press.
There is no pointerup-synthesized click, debounce or delayed safety release.

Preparation is bounded (120 seconds by default); media startup and first-frame
readiness share a separate 20-second deadline (or the shorter injected bound).
Progress changes cannot extend that deadline. Failed
connections expose explicit reconnect. Losing readiness revokes control and
starts a bounded readiness wait. Automatic recovery is opt-in, described below;
it is not a complete phone network-recovery or foreground-probing implementation.

### Panel presentation

The panel follows the decoded Codex 26.930.31428 WebView desktop structure:
compact status/outline-control toolbar, contained media, centered connection
feedback and a full-panel unavailable state with explicit reconnect on failure.
This is source-referenced presentation, not an official Mac pixel-comparison.
Empty-state geometry and the 18/24 medium panel-title role belong to the shared
Design System; desktop-specific layout belongs to the neutral plugin stylesheet.
The design system also owns a decorative 24px vector progress indicator (a
16px ring with a 0.3-opacity track and a 270-degree foreground arc). Its two-second,
60-step rotation follows the shared document timeline; separately mounted
indicators stay in phase. Reduced motion keeps the same geometry without rotation.
Vector geometry remains in the renderer-free `design-system/progress` contract;
`design-system-web/progress` projects it to React/SVG and owns animation phase.
Empty-state sizing and secondary tone apply only to direct glyphs, not nested
progress primitives, so the spinner is neither enlarged nor clipped.
Compact outline controls apply theme feedback immediately, without a color tween
or press scaling; disabled opacity is 0.4 and touch does not inherit sticky hover.
These are source-referenced Codex motion rules, not a Mac runtime parity claim.
The shared controls retain compact 14/18 regular capsule actions and a 44px coarse-pointer
target. Toolbar feedback is single-line and cannot push the media down when
control or clipboard operations are pending.
The localized control labels share an intrinsic sizing slot, so Take/Cancel/Stop
do not move adjacent buttons. Ready status is short; unsupported clipboard
capability hides Paste altogether. Physical clipboard availability is separate
from whether the current control grant enables pasting; supported providers keep
their explicit disabled/enabled action without adding it only after confirmation.
The application supplies the complete theme properties, not merely a light/dark
attribute. Raw errors and credentials never enter feedback copy.

The media mount element stays the same across ready, failed, unavailable and
retry states. Feedback overlays do not instantiate a second controller or attach
input. Control is disabled until both channels are ready and the provider permits
it; local immutable observation remains visibly read-only. While requesting,
the toolbar reports busy and the Cancel action remains visible and usable; a
request is never displayed as confirmed control. Window/panel blur and logical
closure preserve the existing immediate revocation semantics. Shell continues
to own the tab, close action and maximize presentation.

`npm run smoke:desktop-panel` renders the actual plugin/controller/current built
CSS with synthetic backend/media boundaries. It checks light/dark/custom themes,
720px/320px geometry, connection/failure/retry/withdrawal, control cancellation,
normal and null-focusout stop activations, Enter/Space, blur, grant-confirmed focus,
unsupported clipboard, stable action geometry, held pointer/touch feedback,
sampled progress frames and shared phase, coarse-pointer tap sequences, motion preferences and
stable media DOM. Its screenshots are not native-input or production
authorization acceptance; those require the separate runtime tests below.

### Bounded viewing recovery

`DesktopBackend.recoverTransport` is an explicit promise that repeating `prepare`
only obtains a fresh, reauthorized viewer, not resource creation or Agent work.
The local Host adapter opts in. Vela's CTL preparation does not: an unknown POST
result must never be replayed by the neutral controller.

Wire classifies an already-ready socket's abnormal close/error as transport loss,
before notifying noVNC. Media marks it retryable only after its first framebuffer
has actually been drawn. Ordinary/policy closes, aborts, malformed frames, security challenges,
bootstrap and preparation failures remain manual recovery. No raw error text,
peer close reason or credentials enter the classification or UI.

The mounted viewing controller owns one recovery episode. It first disables and
releases input and retires the old surface, transport and attachment. It then
waits 1, 2, or 4 seconds, at most three automatic retries, re-resolves the target
and obtains a new one-use grant. Control is never reacquired automatically.
Brief successful handshakes do not reset the budget; 30 seconds of uninterrupted
readiness does. A failed fresh authorization/bootstrap stops automatic retries.
Repeated gestures/backend refreshes share an active attempt. Closing the viewer
or changing its target fences timers and late results. Manual retry remains after
budget exhaustion; it starts a new episode. The toolbar reuses its short
connecting status without adding diagnostic text or changing layout ownership.

## Composition

`plugins/cloud-desktop` is a trusted built-in Cordis panel plugin, using existing
Panel definition / React renderer / toolbar action registrations. It does not
change the public Extension ABI or bypass authorization. The application installs
it via `createWebWorkbenchApplication`; the `cloudDesktop` option supplies a real
`{ backend, surfaces }` adapter pair. Without an injected product pair, the active
Web application installs the capability-gated local Host adapter described below.

Without an adapter there is no toolbar or launcher entry. With one, `resolveTarget`
must return an authorized exact-Conversation target; null remains hidden.
Capability invalidation republishes toolbar contributions and retires active
viewers if their target changes. No local machine is implicitly substituted.
Repeated opens focus the existing tab. Shell still owns placement, navigation,
responsive geometry and tab closure. A physical viewer may unmount when its
outlet disappears; the remote desktop does not.

The platform-free `contract.ts` models canonical Conversation, Server,
environment and principal identity separately from transient resource incarnation.
`viewer.ts` is the Web DOM adapter boundary. Descriptors lack persisted credentials
or host-specific executable names. Adapter-private credentials and raw errors are
never rendered or logged. User states use brief task-oriented toolbar copy.

### Local execution Server authority

`opencraft-server --local-desktop` is restricted to `127.0.0.1`. Startup verifies
the already-installed root-owned native observer before advertising
`opencraft/desktop`; it neither installs/starts system services nor silently
falls back to a legacy VNC port. Public mode rejects this flag even with the
unauthenticated-public acknowledgement. Loopback access is trusted local-owner
access, **not** DevCloud multi-tenant authentication. Reverse-proxying this listener
publicly would violate its trust boundary and is not an approved deployment.

An operator can instead choose `--trusted-internal-desktop` for a deployment whose
network admission is already trusted. It permits a non-loopback listener with the
existing explicit listener acknowledgement; the two desktop modes are mutually
exclusive. This means **everyone able to access that deployment is trusted to view
the same local machine desktop**. It adds no Vela login, TAT or multi-tenant policy.
The Host advertises `same-origin-trusted-internal` only after native observation is
verified. Default/public deployments without this flag still hide the entry.
The gateway requires an exact HTTP(S) Origin authority matching Host, including
port. TLS termination is supported without trusting forwarded headers: the proxy
must preserve the external Host. Missing/cross-site Origin and URL credentials are
rejected. HTTPS renderers use `wss`, HTTP uses `ws`. Native observation remains
loopback-only and immutable read-only; Thread checks, one-use grants, budgets and
recovery are unchanged. This flag is not safe as anonymous Internet deployment.

The backend registration owns Server ID (data-root/local-owner digest), local
machine ID (hashed `/etc/machine-id`) and principal (execution UID). The Codex
adapter stamps the logical Client namespace/epoch and implements two Host RPCs:

| Method | Request | Authority |
|---|---|---|
| `opencraft/desktop/attachment/create` | Only native `threadId` | Metadata-only native `thread/read`, exact durable path/creation identity, verified physical observer, then another metadata read |
| `opencraft/desktop/attachment/release` | Only `attachmentId` | Release only the issuing logical Client epoch's viewer |

Browser/legacy Host labels, Scope aliases and request instance IDs are never
backend authorization. `HostDesktopBackend` explicitly maps the presentation
Scope to the existing bound native Thread and validates the returned native
identity; its returned Scope target is only the panel projection. Discovery
capability identifies a namespace, not permission to an arbitrary Thread.

The grant contains a one-use ticket bound to Thread revision, local registration,
process preparation generation and physical incarnation. Server storage keeps
only the ticket hash. Unclaimed grants expire after 30 seconds; a viewer expires
after 5 minutes. Per-Client budget is 4 grants including preparations; total is
128. Disconnect/reinitialization, engine failure and Host shutdown revoke old
grants; late preparation cannot resurrect them. Physical identity remains
verified by the native proxy, while the Host rechecks Thread metadata every
5 seconds and fails closed on deletion/replacement or a read timeout.

The separate same-Origin `/desktop/connect` WebSocket follows the selected
loopback or trusted-internal policy, rejects query credentials, limits frames/backpressure to 1 MiB and
retires stalled writes after 10 seconds. The first text frame uses the neutral
`desktop/attach` protocol; binary RFB begins only after matching `desktop/ready`.

### Local native control authority

Observation remains immutable read-only. Optional `--desktop-control` requires
one explicit desktop access mode and a preinstalled, running
`opencraft-desktop-control.service`. Startup verifies the root-owned Unix endpoint
and checks its physical incarnation matches the observer. Without the flag,
capability and ready remain observe-only. This does not mount Vela/TAT control.

`LocalDesktopService` reserves one controller before asynchronous Thread checks
and native acquisition; it confirms only after another revision check. Each
intent is bound to the current viewer/Client/Thread/incarnation. Cancellation,
expiry, disconnect, native failure and revision withdrawal retire it; late
acquisitions are released, not installed. Preparation is bounded at five seconds,
but a confirmed lease is not subject to that preparation timer. Recovery opens
a new viewing attachment and never automatically reacquires input.

The native executor listens only at root-private
`/run/opencraft-desktop-control/control.sock`, accepts only root peers, verifies
the fixed Xvfb/observer identity and owns one physical controller across Host
processes. It has no network, shell, arbitrary display or clipboard command.
It renews a three-second native lease once per second; EOF/expiry releases held
keys/buttons. A private incarnation-bound journal records injection ownership
and original temporary Unicode mappings before injection; executor restart
clears only its recorded inputs and restores mappings on the same physical X
server. Observation-process restart does not erase input cleanup ownership;
replacing Xvfb does. Control authorization still uses the full verified incarnation.

The Host mirrors the ordered media stream to the still-read-only observer and
decodes only bounded pinned noVNC/RFB key/pointer messages for native input.
Each fragmented message retains the confirmed grant at its first byte and
requires the identical current grant at completion. Buffered input from before
acquire or an older grant cannot execute. Clipboard frames are parsed but not
executed; local ready advertises `clipboardAvailable:false`, disabling the paste
action independently of mouse/keyboard control. The client input toggle remains
UX, not authorization. Physical executor ownership is separate from panel state.

Install the reviewed helper and unit from
`apps/local-agent-host/native/linux/` as root-owned files; do not enable legacy
interactive VNC/noVNC. The unit is not automatically enabled at boot. Explicit
native acceptance uses only a newly created test window, not user applications.
The native x11vnc process enforces immutable observe-only input; no client flag,
account login, Vela adapter or TAT credential is trusted as an input gate.
Closing the viewer leaves native desktop services and Codex work running.

### Cloud desktop / Vela plugin boundary

| Layer | Owns | Must not own |
|---|---|---|
| `plugins/cloud-desktop` | Desktop contract, panel/controller, lazy noVNC adapter, media focus and local input gating | Vela account, Bot selection, TAT, product HTTP or resource preparation |
| `plugins/lightvela-platform/src/desktop` | Account/region and canonical directory checks, CTL preparation, authorized viewer attachment handoff | noVNC implementation, React/Shell placement, Chat's physical transport |
| Backend viewer broker | Server-side target revalidation, attachment expiry, physical incarnation and exclusive input enforcement | Client menu/view lifetime as resource-stop policy |
| Application composition | Install the pair; retire panel consumers before disposing the Vela provider | Guessing a target from a renderer route or advertising unsupported media |

Dependency direction is Vela provider → neutral desktop `contract` / `rfb`
subpaths. Cloud desktop never imports a product plugin. Product provider does not
import the panel renderer entry or noVNC. Boundary checks cover source imports
and the neutral plugin's product dependencies; they do not establish a security
sandbox for trusted JavaScript.

`createLightVelaCloudDesktopAdapter` returns the existing `{backend, surfaces}`
pair plus an owner `dispose`. It uses the account's authenticated request port,
not another credential store. Its injected directory supplies an exact
Conversation/Server/instance binding; `activeBotId` is not a fallback. Account
epoch, binding revision, region and principal are fenced across each asynchronous
step. Changing a physical binding retires old attachments even when the stable
target IDs do not change. Account detail refresh alone does not invalidate them.

Preparation sends one explicit CTL POST, then bounded read-only GET observations.
Unknown POST results are not retried automatically. A changed preparation epoch
fails rather than switching silently. The default 90-second consumer wait is
shorter than the existing 120-second viewer bootstrap bound; expiration abandons
the viewer attempt, not CTL's independent background resource job.

The provider requires an explicit `LightVelaDesktopViewerPort`, which is an
integration boundary, not a new HTTP endpoint claimed to exist. Without it,
`resolveTarget` returns null and no preparation requests are made. It must return
the authorized target, instance, preparation epoch and a separately verified
physical incarnation. Legacy `/desktop/session` credentials are not substituted.
No default canonical-directory adapter or production viewer port is wired yet.
`createLightVelaDesktopViewerPort` now implements the product handoff against
explicitly configured broker endpoints. It validates the full binding/physical
identity and expiry, captures account credential scope/epoch, and does not accept
peer-supplied addresses. HTTP uses the existing authenticated account port and
its `OK/data` envelope. Release uses a bounded DELETE under the original account;
after identity replacement it relies on socket retirement/server expiry instead
of borrowing successor credentials.

The backend now has an observer-only foundation: CTL's installer writes a
separate loopback native view-only x11vnc unit; Sandbox's provider opens only its
fixed port through a dedicated backend TAT socket. Neither is auto-started or
exposed as a public API. This is not target authorization, incarnation proof or
a control executor, and it is not composed into the Vela viewer port yet. Raw
TAT session credentials must not be passed to the renderer. Local native tests
exercise raw key/pointer/clipboard attempts against a fresh isolated X server;
TAT transport tests still stop at a synthetic WS/BSON server. See the
[backend resource contract](../../ctl/docs/cloud-desktop-resource.md).

### noVNC media adapter

`createRfbDesktopAdapter` loads pinned noVNC 1.5.0 only when connecting. The
authorized session opens a fresh channel at surface mount, after module loading,
so an early RFB server greeting is not dropped. A connection can mount once and
only with its paired factory. The adapter starts observe-only, scales locally
and disables desktop resize. Handshake establishes input-channel readiness,
not video readiness. The reviewed `firstframe` event follows a non-empty pixel
rectangle, completed decoding, display flip and render-queue flush; empty updates
and cursor/resize metadata are insufficient. Socket open or CTL prepared state
is not readiness. Unexpected credential/trust challenges fail
closed instead of prompting for raw passwords.

The pinned npm client is Babel CommonJS. The module-loader boundary validates
both constructor and default-export-object shapes before returning a constructor;
otherwise a passing fake-client unit test could hide a browser mount failure.

Control requires a lease issued by that exact connection. Foreign, concurrent,
revoked and late grants cannot enable input. Availability withdrawal and revoke
disable input synchronously; close aborts in-flight requests and releases grants,
noVNC, channel and session independently. The adapter uses public noVNC APIs only.
Backend rejection, lease expiry and releasing held remote keys/buttons remain
backend responsibilities; local `viewOnly` is never their substitute.

The pinned npm decoder has a deliberately small public-event extension applied by
`scripts/patch-novnc-desktop-events.mjs` during postinstall and before Web builds. It verifies version,
original SHA-256, every unique replacement anchor and the complete idempotent
result. Upgrades and partial/unreviewed edits fail installation/build; they cannot
silently remove first-frame evidence. The application consumes only public
events/APIs, not decoder private fields or a second RFB parser.

### Focus, clipboard and diagnostics

Confirmed control focuses the media with `preventScroll`; a surface pointer
gesture also focuses it without granting input. Toolbar-to-media focus movement
stays inside the owner. Blur, cancellation and target/connection retirement abort
clipboard intentions along with input.

The Paste action, focused Ctrl/Meta+V and native paste gesture share one
controller-owned clipboard transaction. Local text is read only on an explicit
gesture while this exact control lease is valid. Pending reads coalesce, time out
after 5 seconds and are fenced across revocation/reconnection; text is limited to
16,384 UTF-16 units. The decoder's `clipboardready` means basic ClientCutText or
extended Provide has been sent on the ordered stream, NOT remote application
acceptance. Only then does the media adapter emit paste keys. Provide waits are
bounded at 5 seconds; timeout/revoke clears retained local clipboard data and
cannot emit late keys. Legacy Latin-1 clipboard rejects unsupported characters
instead of silently corrupting text; extended clipboard transports UTF-8.
No unsolicited peer-to-local OS clipboard writes or background reads are added.
Remote copy-to-local and native IME/mobile keyboard usability remain unverified.

The controller owns preparation/connection/video/input/connected stages and fixed
failure classifications. Its diagnostic sink receives only generation, stage,
operation, reason enum and elapsed time; the default emits these safe fields to
the developer console. It does not persist diagnostics or include raw errors,
targets, credentials or clipboard text. The panel projects short translated
task-oriented feedback, not protocol/stage names.

### Authorized session wire and backend broker

Neutral `session-wire` owns one dedicated socket plus its binary-only noVNC
facade. The product adapter supplies socket creation and scoped authentication;
it never supplies a Chat socket. The media facade stays CONNECTING until an
identity-matching `desktop/ready` arrives, filters all JSON from the decoder,
and opens only when the noVNC surface mounts. Opening is bounded at 15 seconds,
control requests at 10 seconds. Output backpressure over 1 MiB retires rather
than queues indefinitely or drops ordered media bytes.

Version-1 protocol:

| Direction | Message / meaning |
|---|---|
| Client → broker | `desktop/attach {version:1, attachmentId, ticket}` as the first text frame |
| Broker → client | `desktop/ready {version:1, attachmentId, controlAvailable}` before any binary media |
| Client → broker | `control/request {requestId}`; monotonic per-connection decimal ID |
| Broker → client | `control/locked {requestId}` only after an executor grant; `control/denied` otherwise |
| Either direction | `control/release {requestId}` cancels/releases only that request/grant |
| Either direction | Binary frames: ordered RFB bytes, never control JSON |

Confirmation creates the client lease; requesting does not. Cancel/timeout fences
the ID, and late confirmation is released rather than enabling input. Duplicate
confirmation does not revoke an existing valid grant. Release delivery failure
closes the whole attachment. Remote revoke, identity change and transport end
synchronously invalidate the lease before further local input.

Sandbox's [broker contract](../../sandbox/docs/desktop-viewer-broker.md) exposes
an unmounted HTTP handler. It requires authoritative resolution and verified
native observe/gated streams. It does **not** parse RFB or pretend a local boolean
is an input gate. The existing immutable observer supplies no control port. A
control-capable adapter must actually arbitrate all users of its executor,
including Agent automation, revoke input and clear held keys/buttons on release
and stream closure. The native input executor and product authority composition
remain absent for Vela. The backend now has a verified immutable observer transport:
a native loopback proxy checks actual process/socket ownership and signs each
fresh challenge using a root-only runtime key. It strips that proof before
handing off RFB and retires the viewer on physical identity change. This is not
Conversation authorization; the current client-side legacy Server projection
cannot be used as its source.

The broker's short ticket is exchanged inside WSS, never a URL/subprotocol.
HTTP creation/release require product login. Browser WebSocket authentication
uses the ticket because browsers cannot attach arbitrary bearer headers; an
optional trusted cookie/gateway identity must also match if configured. The
broker derives principal from its stored ticket binding, not from a frame.

## CTL preparation foundation

CTL now separates explicit `POST …/desktop/resource` preparation from read-only
`GET …/desktop/resource`. A bounded background job advances installation/startup
without browser polling; user/Sandbox rebinding and retries replace mutable state.
The DTO has no VNC credentials. Its `generation_id` is an orchestration epoch, not
the plugin's physical resource incarnation. This is not yet a `DesktopBackend`
adapter: exact Conversation authorization, attachment, media and input enforcement
are still missing. See [CTL contract](../../ctl/docs/cloud-desktop-resource.md),
including in-memory/multi-replica and Gateway rollout limitations.

## Production adapter requirements (not fully implemented)

1. Resolve canonical binding and authorized environment, not legacy `hostId`.
   Revalidate identity in backend `prepare`.
2. CTL/TAT prepares the desktop resource; resource incarnation and viewer
   attachment have independent identities. Existing HTTP-only `Ready` is not
   proof of media readiness.
3. Compose the tested attachment broker/short-lived credentials with a production
   authoritative directory and verified stream adapter.
   Initial transport candidate is WSS; WebRTC requires separately verified
   ICE/TURN infrastructure. The adapter owns transport teardown, bounded
   reconnect, media sizing and tested pointer/keyboard/touch coordinates.
4. Backend enforces unique controller and input rejection after revoke, including
   manual-user versus Agent arbitration. Client gating is only UX.
5. Heartbeat/expiry belongs to backend/adapter policy; phone suspension cannot
   implicitly stop Agent work. Identity changes abort old connections; release
   methods are idempotent and non-throwing.

## Verification

`npm run test:cloud-desktop` covers both readiness orders, denied/wrong targets,
principal switching, delayed prepare/connect/control results, synchronous
revocation, teardown failures, bootstrap timeout, capability notifications and
one-tab self-registration. A real React component in JSDOM replaces only the
external backend/media boundary and exercises observe/control, window blur and
plugin retirement. This is not real video, security, ICE, TAT, device input or
production desktop verification. Additional adapter/provider tests cover
observe-only sessions, source-level control grant fencing, exact product binding,
preparation DTO validation, unknown POST failure and provider retirement.

`npm run smoke:cloud-desktop` runs the real panel, Vela provider and noVNC in a
browser against a synthetic local RFB server and product authority. It checks a
decoded binary framebuffer pixel, a deliberately held first-frame/empty-update
negative, actual pointer/key delivery and focus after a grant, ordered clipboard
and paste keys, local input cessation on revoke and viewer teardown. Set
`OPENCRAFT_SMOKE_EXTENDED_CLIPBOARD=1` to verify Unicode Notify/Request/Provide;
the default legacy peer checks rejection rather than silent Unicode replacement.
It does not verify a real
cloud desktop, production input enforcement, TAT or mobile network recovery.

`npm run smoke:local-desktop` additionally injects a lost native viewing stream
inside an isolated Host after a real framebuffer is painted. It verifies a new
authorized connection and canvas, the same framebuffer pixel, observe-only input,
one physical Codex engine and no repeated model request. This controlled local
fault is not evidence of real phone suspension, latency, packet loss or TAT recovery.

### Transport assessment (2026-10-04)

Existing ingressproxy routes HTTP and WebSocket upgrades through router/shard
ReverseProxy instances. Its manifests expose HTTP listeners, not a generic TCP,
UDP or TURN listener. Local router/shard tests preserve binary messages including
1 MiB payloads; the TLS test covers local WSS. These do not verify live cloud
ingress, mobile throughput or whether all external UDP is blocked.

TAT command execution and TAT session proxy are different capabilities. The
existing `lightvela-hermes` multiplexer opens TCP byte streams to loopback ports
over a WSS/BSON session. Its RFC6455 adapter can therefore carry a desktop
WebSocket, not just control commands. The desktop transport tests exercise the
real RFC6455 adapter with synthetic external byte streams: binary fragmentation,
masked client bytes, a 1 MiB message and logical connection closure. They do not
execute real TAT, decode a desktop framebuffer or enforce input authorization.

WSS is the initial first-class transport candidate, not a WebRTC-timeout fallback.
Browser ICE does not accept this JavaScript TCP proxy as an injected socket.
TURN over TLS may use TCP, but is not an HTTP/WSS protocol and cannot simply use
an HTTP reverse proxy. UDP inbound restrictions alone are insufficient to decide
ICE viability; external relay reachability is still unverified.

The existing product uses noVNC 1.5.0. Its public
[RFB constructor](https://github.com/novnc/noVNC/blob/v1.5.0/docs/API.md)
accepts a WebSocket channel, providing an adapter boundary without patching global
WebSocket or touching private noVNC fields. This is a source-level integration
candidate, not a completed OpenCraft viewer.

The implementation boundary is:

- Backend resolves and revalidates the exact target before issuing a restricted,
  expiring attachment bound to a physical desktop incarnation. A resource
  preparation generation is not a substitute for this identity.
- An authorized WSS broker or remote protocol-aware enforcer gates desktop input.
  Giving the browser unrestricted TAT access and a VNC password would bypass that
  gate. noVNC `viewOnly` is UX, not authorization. The enforcer must distinguish
  required protocol/configuration/framebuffer requests from keyboard, pointer,
  clipboard and other state-changing operations; unknown operations fail closed.
- Desktop transport has its own physical connection owner, separate from the
  Chat Host. Existing TAT logical channels isolate closure, not bandwidth or
  backpressure: one shared socket can queue media ahead of chat. Prefer a separate
  desktop session, subject to backend limits, with bounded queues and reconnect.
- Surface teardown retires only its transport, attachment and input lease.
  Resource lifetime, attachment expiry and transport keepalive are separate.
  Phone suspension releases input, not desktop/Agent execution.
- Ordered RFB bytes cannot be dropped arbitrarily to relieve congestion. Apply
  supported framebuffer-request/rate/quality controls or close and resynchronize;
  verify queue limits and mobile weak-network recovery before shipping.

There is a tested Sandbox broker and a separate opt-in local Host composition,
but no Vela multi-tenant authority/verified-stream composition or server-side
control executor. The noVNC media adapter,
session protocol and product handoff exist in source, but no new transport
capability is advertised by default. If WebRTC is added
later, select by explicit backend capability and retire the old connection and
control lease before switching; do not run two active viewer transports.

Source boundaries: `sandbox/internal/ingressproxy/router.go`,
`sandbox/internal/proxycore/client.go`, ingressproxy Service manifests,
`tencent-tat-session-multiplexer.ts`, `tat-websocket.ts`, and the legacy
`frontend/src/pages/marketing/agent-cloud-desktop-panel.tsx`. Standards references:
[WebRTC configuration](https://w3c.github.io/webrtc-pc/#rtcconfiguration-dictionary)
and [TURN transport](https://www.rfc-editor.org/rfc/rfc8656.html#section-3.1).

Reference: read-only Codex 26.930.31428 desktop tab/viewer analysis. Adopted
per-Conversation tabs, remote/view lifetime split and observe/control split;
did not copy private signaling endpoints or UID, or assume robust reconnection.
