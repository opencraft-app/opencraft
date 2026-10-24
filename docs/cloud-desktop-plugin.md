# Conversation cloud desktop plugin

Toolbar availability is a projection of the observed conversation scopes.
Repeated backend/binding notifications with unchanged availability must retain
the toolbar snapshot; a React layout effect may itself produce such an
observation. Republishing on every notification feeds chrome rendering back
into backend observation and can exceed React's update depth. Availability
changes still notify without navigation, and execution rechecks the current
target independently of toolbar visibility.

Status: source framework, noVNC media adapter, the downstream product provider/viewer port, bounded
backend attachment broker and cloud desktop resource-preparation API. Local Linux Codex
Hosts now have an explicit observation composition and an opt-in private native
mouse/keyboard executor. The
multi-tenant the downstream product broker is not mounted in production: its canonical directory
and a native control executor still require integration. No WebRTC service or real
enterprise service command is included. Local capability is opt-in; default compositions hide
the entry. Explicit trusted-internal deployments can share read-only viewing
with everyone who can access that deployment; enabling control additionally
trusts those users to request exclusive input on that same machine.

Trusted renderer composition can set `cloudDesktop: null` to omit the desktop
plugin entirely, including restored panels, Composer shortcuts and menu actions.
An omitted option retains capability-gated Host discovery; an adapter selects the
product backend. Product policy is independent of Host authorization.

## Ownership

| Object | Authority / lifetime | Teardown |
|---|---|---|
| Authorized target | Product backend adapter, canonical Conversation binding and account/environment directory | Invalidate on binding, permission or principal changes |
| Desktop process / incarnation | Backend, independent of Chat turn and renderer | Backend policy only; no stop operation exposed to the panel |
| `cloud-desktop` tab | Conversation Panel service, singleton within one panel owner | Descriptor contains only Conversation ID, never credentials |
| Attachment | Backend-authorized short-lived viewer lease for exact target/resource/incarnation | Release on bootstrap failure or viewer teardown |
| Media transport + surface | One desktop tab's opted-in resident presentation | Hiding or switching tabs retains viewing but disables input and retires cursor overlays/listeners; tab closure, owner replacement, timeout, connection end or plugin retirement releases viewing |
| Control grant | Server-authorized, exclusive and revocable input lease | Disable input before release on cancel, blur, hidden page, revocation or teardown |
| Button activation | Mounted presentation captures the pressed action; controller issues a single-use command bound to viewing/control epochs | Cancelled physical gestures, focus/page loss, revoked readiness and replaced ownership cannot reinterpret or replay a press |

The UI immediately projects control intention as Stop controlling, including
while a request awaits authorization. This is not confirmed input ownership.
Both video and
input-channel readiness must be true before requesting a grant, independent of
arrival order. Input is not bound before a valid lease arrives. A late result
after cancellation is released without enabling input. Independent peers and
Agent automation must be arbitrated by the backend, not `viewOnly` CSS.
The surface is a focusable child of the panel; adapters keep media/input focus
inside this boundary. Moving focus between toolbar and surface is not blur of
the desktop owner. Losing focus outside it releases control.
The mounted DOM interaction owner observes explicit outside pointer presses,
known outside focus destinations, window blur and document hiding. A null
focusout destination is incomplete platform information, not proof of departure:
it reconciles the current active element after synchronous focus handoff, without
granting input or restoring focus. Body/root as an unknown destination cannot
alone revoke existing control; an outside blank-space press still revokes it.
Controller acquisition/confirmation continues to require actual in-panel focus.
An observing managed-media surface commits a fixed Take command on native
single-finger tap release, since its compatibility mouse events are suppressed.
Movement, a second finger, pointer cancellation or capture loss retires that
command. No synthetic click is emitted; a compatibility click, if provided by
the browser, consumes only the already-spent command. Ordinary toolbar buttons
retain native click/keyboard activation.
Take acquires media focus synchronously while still observe-only, before awaiting
the grant. The platform supplies a read-only current-panel focus predicate;
failed focus cannot request input, and focus is checked again at confirmation.
Confirmation enables input but never refocuses the media. A no-focus touch/AT
button activation followed by leaving the panel cannot accept a late grant or
steal focus back. The focus predicate is not backend authorization.

One native activation has a fixed action, not a toggle of the latest rendered
state. Pointer/Enter/Space press captures Take or Stop; native click consumes
it once. An accessibility click without a physical press remains supported.
Control confirmation stays within the same intent, so a held Stop can still
stop its confirmed grant. Release, revocation, lost readiness or connection
replacement retires earlier commands: a Stop followed by null focusout cannot
turn the same click into Take, or revoke a later user's grant. Window/page loss
and cancelled/outside pointer release also retire the presentation's press.
There is no pointerup-synthesized click, debounce or delayed safety release.

A trusted backend may declare a separate positive finite `prepareTimeoutMs` for
resource preparation. It does not extend the media/first-frame deadline. Readiness
timers and reentrant status notifications remain fenced by the connection generation.
An established viewer that explicitly reports `control-released` retires input and
obtains one freshly authorized observe-only attachment without a transport-failure
banner. The provider must consume that transition as observation, never reserve
input again. A fresh connection that is already ended cannot trigger an unbounded
reattachment loop. No input intention is replayed on the new viewer.

The noVNC mount observes positive container geometry after a zero-sized hidden
interval and reruns its public scaling setter even when the restored dimensions
match the original. Zero-sized measurements never set scale; disposal disconnects
the observer and fences queued callbacks. Embedded panels resolve keyboard focus
within their own ShadowRoot and use composed event paths for interaction ownership.

Preparation is bounded (120 seconds by default); media startup and first-frame
readiness share a separate 20-second deadline (or the shorter injected bound).
Progress changes cannot extend that deadline. Failed
connections expose explicit reconnect. Losing readiness revokes control and
starts a bounded readiness wait. Automatic recovery is opt-in, described below;
it is not a complete phone network-recovery or foreground-probing implementation.

### Panel presentation

An authorized desktop action is also available next to the Composer command menu.
The shortcut reads “Cloud computer” in English and “云电脑” in Simplified Chinese;
its task label is independent of the desktop tab title.
It consumes the same filtered Panel action and current Conversation scope, and launch
rechecks the backend target. Without an installed adapter, a permitted presentation
action or a current target, no Composer desktop entry is rendered. Embedded products
select their allowed panel actions at the product composition; file preview mode
retains the desktop renderer and its existing lifetime and input authority.

The shared Design System `desktop-view.web` primitive owns an aspect-fit media
card, rounded clipping/shadow, a floating ownership island and a confirmed-control
perimeter/visor. This presentation has not been verified by an official Mac
pixel-comparison and does not change the remote OS theme.
Desktop control appearance is independent from the application accent: its
current default is the purple submit pair (#8952ee light, #7849d1
dark, white foreground). The shared primitive owns the paired defaults; trace,
wash, visor and translucent release action consume the same local variables.
There is no assistant appearance authority wired to this local desktop yet, so
this is a product default.
Application theme/skill colors and remote Linux wallpaper remain unchanged.
The adapter reports optional `mediaAspectRatio` from decoded backing dimensions;
the controller projects the current connection's geometry. Missing geometry uses
4:3 temporarily. Shell owns available space; noVNC remains the sole owner of
scaling, zoom and input-coordinate mapping, with remote resize disabled. The
frame fits container width/height without a second scaling transform; the island
is anchored to its bottom edge with reserved control space below. Connection
feedback remains centered and failures have explicit reconnect. The ownership
strip stays mounted with reserved geometry but is invisible, accessibility-hidden
and inert until current video and input are ready. Initial connection, recovery
and failure cannot expose duplicate disabled actions or accept hidden input.
The optional connection `capturePreview` returns only a bounded JPEG of decoded
backing pixels (1280px longest edge, quality .85, at most 2M data-URL characters).
Capture is synchronous at connection retirement; unsupported/tainted media falls
back to plain feedback. No screenshot polling, persistence or shared cache exists.
The controller retains one frame in memory, scoped to target identity, resource
and physical incarnation. Recovery shows it only after fresh authorized attachment
preparation validates the same binding; pending preparation remains plain feedback.
New identities/instances, denied authorization and disposal clear eligibility.
Reentrant capture cannot write after a newer lifecycle generation.
Cached images are decorative, pointer-inert and never establish readiness or
input authority. A connecting overlay distinguishes stale pixels from live media.
Once current video and input are ready, the preview and feedback fade over 240ms;
reduced motion hides them immediately. The media mount remains the same, and a
fresh exclusive grant is still required after recovery.
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
The ownership action uses the shared 12/16 regular `control-small` role, a 32px
capsule and at least 44px coarse-pointer target. Icon actions retain shared compact
panel controls. Activation feedback is immediate with no press scaling. Disabled
opacity is 0.4; touch does not inherit sticky hover. A decorative solid button
layer fades over 240ms into the translucent confirmed-control background and
back on release; only confirmed ownership selects this presentation. Reduced
motion skips the fade, and held-press geometry/feedback remains immediate.
The ownership island keeps a
bounded width and single-line truncated status, so control/clipboard pending
cannot move the media or neighboring actions. Requesting keeps Stop usable; after
200ms animated dots visually replace status while accessible status remains.
Reduced motion retains readable status without dots or color/position animation.
The localized control labels share an intrinsic sizing slot, so Take/Stop
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
the toolbar reports busy and Stop controlling remains visible and usable. The
pressed state represents cancellable intent; input is still blocked until the
backend grants control. The decorative ring and connected visor require
**active + ready + confirmed controlling**, never merely pressed/requesting.
Observing uses a theme-surface island 8px below the frame. Confirmation joins the
island to the frame over 180ms, draws a two-sided masked perimeter over 320ms after
a 50ms delay, and washes the bottom visor over 420ms. Return reverses presentation;
it never delays input revocation. Decorative layers are non-interactive and
aria-hidden. The status slot reserves ordinary localized ownership labels
intrinsically, without a fixed pixel width; hidden measurement labels are excluded
from accessibility. Only the confirmed visor has the 241px minimum. Auxiliary
input actions remain capability-driven. Narrow and wide shoulder masks use distinct
asymmetric reference curves. Card shadows crossfade fixed pseudo layers over 240ms
rather than interpolating shadow geometry; the wide card retains one shadow across
ownership changes. Paired theme accent/foreground tokens drive color independently of product or
assistant identity, without hardcoded global purple. Watching does not falsely assert
an agent owns control. Clicking observing media uses the same single-use,
lifecycle-fenced Take activation as the button. Window/panel blur and logical
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
The local Host adapter opts in. the downstream product's desktop service preparation does not: an unknown POST
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
responsive geometry and tab closure. Desktop explicitly registers renderer
`residency: "while-tab-open"`; the Shell retains that viewer when its pane is
hidden or another tool tab is selected. Its `active` projection is logical
visibility, not exit-animation progress: becoming inactive immediately cancels
control intention, releases the grant and makes the DOM inert. Reopening retains
the media connection but never automatically takes control. Inactivity also stops
RFB framebuffer pull requests and disables continuous updates at the producer.
Already in-flight data may finish; hidden periods produce no continuing request /
decode loop with a compliant peer. A first handshake while hidden defers its first
pixel request until shown. The previous framebuffer stays available. Rapid
hide/show waits for the continuous-stop acknowledgement before enabling the next
stream, and pull mode never adds a duplicate pending request. This preserves
quick restoration without a new authorization/preparation POST. Removing the tab or
changing its owner disposes the viewer. This is current-Shell residency, not
cross-route/process persistence. Non-opted-in tools retain their normal active
tab and physical-presentation lifetime; a resident desktop cannot keep another
tool alive after the pane finishes closing. The remote desktop is never stopped.

`DesktopSurface.setActive` receives that same logical activity, including when
media finishes mounting while hidden. The media adapter owns overlays even if
the decoder attaches them outside the panel DOM. noVNC's touch fallback cursor
is a fixed body-level canvas. The reviewed decoder derives its attachment from
surface activity and the adapter's existing `viewOnly` input-grant projection;
there is no separately writable cursor-control flag. Observation and pending
authorization never attach it. Stop, revocation, focus loss or inactivity detach
the cursor and its listeners immediately and restore the canvas's ordinary
`auto` cursor, including the desktop URI-cursor path, without closing the viewing
stream or relying on a touch-generated mouseleave. Shapes still decode into
latest media state without writing to the detached cursor. Late shapes and
mouseover cannot resurrect it. Reopening restores observation only; a fresh
valid grant attaches the latest shape without stealing focus. Repeated enable
notifications do not clear an already attached cursor. Closing removes it before
transport teardown. This governs local control feedback, not cursor pixels
already present in the remote framebuffer. Shell never searches global canvases
or owns a second cursor-visibility state.

The decoded cursor hotspot, rather than the image's top-left corner, must align
with the input's client point. The reviewed noVNC cursor utility subtracts that
hotspot after its existing visual-to-layout viewport conversion for managed
movement, just as native mouse movement does. Framebuffer packets and the
adapter's geometry remain unchanged. A shape/hotspot change preserves the same
input anchor. Verification must include a nonzero hotspot, relative-pad clicks
and direct touch on zoomed media; a zero-hotspot fixture misses this failure.

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
the same local machine desktop**. It adds no the downstream product login, cloud-service or multi-tenant policy.
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
only the ticket hash. Unclaimed grants expire after 30 seconds; a claimed viewer
has a five-minute authorization window, renewable only by backend confirmation.
Per-Client budget is 4 grants including preparations; total is
128. Disconnect/reinitialization, engine failure and Host shutdown revoke old
grants; late preparation cannot resurrect them. Physical identity remains
verified by the native proxy, while the Host rechecks Thread metadata every
5 seconds and fails closed on deletion/replacement or a read timeout.

The separate same-Origin `/desktop/connect` WebSocket follows the selected
loopback or trusted-internal policy, rejects query credentials, limits frames/backpressure to 1 MiB and
retires stalled writes after 10 seconds. The first text frame uses the neutral
`desktop/attach` protocol; binary RFB begins only after matching `desktop/ready`.

### Existing Linux desktop installation

The optional `runtime/native-desktop/install-desktop.py` is an explicit root
operator action, separate from application startup. It binds an already running
non-root Xvnc, Xtigervnc or Xvfb display to its owning systemd unit and installs
an additional immutable x11vnc observation channel on loopback 5903. It never
restarts the source display, existing VNC or window manager. The verified proof
transport remains loopback 5902; no new public VNC listener is created.

The root-private `/etc/opencraft/desktop.json` records the chosen display,
source unit, process executable/arguments, UID and X authority path. Neither a
browser request nor an inherited environment variable chooses that target.
Observation checks exact immutable x11vnc arguments, the source service's
invocation, process ownership/start identity/cgroup and the actual X socket
peer. Replacing any identity retires old viewers and input grants. The existing
XTest executor consumes the same verified display and authority, instead of
assuming a separate Xvfb or a hardcoded display. Its physical exclusivity and
held-input journal remain independent from browser tabs and Chat clients.

Install x11vnc with the OS package manager first, then run from a clean released
native-assets directory:

```sh
sudo python3 install-desktop.py --source-unit EXISTING.service --display :1 --xauthority /absolute/private/Xauthority --control
```

Omit `--control` for observation only. The operator must separately choose the
application's existing desktop access mode; native installation does not broaden
network admission or change application flags. Only after native observation and
optional control verify against the same incarnation may the application
advertise capability. This is one shared installation desktop, not tenant or
Conversation isolation. Automated acceptance sends input only to a purpose-built
test window and must not interact with existing applications.

### Confirmed viewing renewal

Local discovery and matching `desktop/ready` must both explicitly advertise
`renewable: true`. Thirty seconds before the current deadline, the wire sends
`desktop/renew` with a unique request ID on the independent viewing socket.
The backend rechecks the current logical Client, native Thread revision before
and after observer inspection, and the same physical desktop incarnation within
five seconds. Only the same still-claimed, live, unexpired attachment can receive
`desktop/renewed` with a new five-minute deadline. The ticket remains consumed;
renewal neither creates a desktop nor reopens media nor obtains input control.

The client updates its own expiry only from that matching, bounded confirmation.
No confirmation within ten seconds retires the transport and allows the existing
bounded fresh-authorization recovery; identity/policy failures remain fail-closed.
Invalid receipts and callbacks after closure/owner replacement cannot extend a
viewer or enable input. Both sides retain expiry timers. Legacy discovery/ready
without the capability sends no unknown message and retains the original expiry
behavior. the downstream product/enterprise-service providers are not silently opted into this local contract.

Composition regression uses the real Host backend, wire and viewing controller
with synthetic media: repeated five-minute deadlines retain one attachment and
surface, with no automatic control. Socket tests exercise the real local service
and authoritative revision/incarnation checks, not live native desktop input.

### Local native control authority

Observation remains immutable read-only. Optional `--desktop-control` requires
one explicit desktop access mode and a preinstalled, running
`opencraft-desktop-control.service`. Startup verifies the root-owned Unix endpoint
and checks its physical incarnation matches the observer. Without the flag,
capability and ready remain observe-only. This does not mount the downstream product/enterprise service control.

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
account login, the downstream product adapter or enterprise service credential is trusted as an input gate.
Closing the viewer leaves native desktop services and Codex work running.

### Cloud desktop / downstream product plugin boundary

| Layer | Owns | Must not own |
|---|---|---|
| `plugins/cloud-desktop` | Desktop contract, panel/controller, lazy noVNC adapter, media focus and local input gating | the downstream product account, Bot selection, enterprise service, product HTTP or resource preparation |
| Downstream desktop provider (product workspace) | Account/region and canonical directory checks, desktop service preparation, authorized viewer attachment handoff | noVNC implementation, React/Shell placement, Chat's physical transport |
| Backend viewer broker | Server-side target revalidation, attachment expiry, physical incarnation and exclusive input enforcement | Client menu/view lifetime as resource-stop policy |
| Application composition | Install the pair; retire panel consumers before disposing the downstream product provider | Guessing a target from a renderer route or advertising unsupported media |

Dependency direction is the downstream product provider → neutral desktop `contract` / `rfb`
subpaths. Cloud desktop never imports a product plugin. Product provider does not
import the panel renderer entry or noVNC. Boundary checks cover source imports
and the neutral plugin's product dependencies; they do not establish a security
sandbox for trusted JavaScript.

The downstream desktop adapter returns the existing `{backend, surfaces}`
pair plus an owner `dispose`. It uses the account's authenticated request port,
not another credential store. Its injected directory supplies an exact
Conversation/Server/instance binding; `activeBotId` is not a fallback. Account
epoch, binding revision, region and principal are fenced across each asynchronous
step. Changing a physical binding retires old attachments even when the stable
target IDs do not change. Account detail refresh alone does not invalidate them.

Preparation sends one explicit desktop-service POST, then bounded read-only GET observations.
Unknown POST results are not retried automatically. A changed preparation epoch
fails rather than switching silently. The default 90-second consumer wait is
shorter than the existing 120-second viewer bootstrap bound; expiration abandons
the viewer attempt, not the desktop service's independent background resource job.

The provider requires an explicitly supplied downstream viewer port: an
integration boundary, not a new HTTP endpoint claimed to exist. Without it,
`resolveTarget` returns null and no preparation requests are made. It must return
the authorized target, instance, preparation epoch and a separately verified
physical incarnation. Legacy `/desktop/session` credentials are not substituted.
No default canonical-directory adapter or production viewer port is wired yet.
The downstream viewer-port implementation performs the product handoff against
explicitly configured broker endpoints. It validates the full binding/physical
identity and expiry, captures account credential scope/epoch, and does not accept
peer-supplied addresses. HTTP uses the existing authenticated account port and
its `OK/data` envelope. Release uses a bounded DELETE under the original account;
after identity replacement it relies on socket retirement/server expiry instead
of borrowing successor credentials.

The backend now has an observer-only foundation: the desktop service's installer writes a
separate loopback native view-only x11vnc unit; Sandbox's provider opens only its
fixed port through a dedicated backend enterprise service socket. Neither is auto-started or
exposed as a public API. This is not target authorization, incarnation proof or
a control executor, and it is not composed into the downstream product viewer port yet. Raw
enterprise-service session credentials must not be passed to the renderer. Local native tests
exercise raw key/pointer/clipboard attempts against a fresh isolated X server;
Enterprise service transport tests still stop at a synthetic WS/BSON server. See the
the downstream backend resource contract (not in this repository).

### noVNC media adapter

`createRfbDesktopAdapter` loads pinned noVNC 1.5.0 only when connecting. The
authorized session opens a fresh channel at surface mount, after module loading,
so an early RFB server greeting is not dropped. A connection can mount once and
only with its paired factory. The adapter starts observe-only, scales locally
and disables desktop resize. Handshake establishes input-channel readiness,
not video readiness. The reviewed `firstframe` event follows a non-empty pixel
rectangle, completed decoding, display flip and render-queue flush; empty updates
and cursor/resize metadata are insufficient. Socket open or desktop service prepared state
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

Toolbar touch activation commits on the native click. Normal implicit pointer
capture release after `pointerup` preserves the captured command; capture loss
before release, pointer cancellation and platform deactivation cancel it.
The managed media surface keeps its own release activation without sending a
remote click. Neither path grants input before the backend lease is confirmed.

Confirmed control focuses the media with `preventScroll`; a surface pointer
gesture also focuses it without granting input. Toolbar-to-media focus movement
stays inside the owner. Blur, cancellation and target/connection retirement abort
clipboard intentions along with input.

Control is requested only by clicking/tapping the desktop or activating Take control.
Mouse hover never requests control. A managed media surface commits a primary
mouse/pen click or single-finger H5 tap on release because noVNC can suppress its
native compatibility click. Movement, cancellation, additional fingers and leaving
before release retire that activation; a later compatibility click cannot repeat it.
Toolbar buttons retain native click/keyboard activation. Reopening/reconnecting
restores observation only, and late grants cannot pull focus back after leaving.
The tab, overflow menu and drag label share the localized Cloud computer title.

The Paste action and native Ctrl/Meta+V gesture share one controller-owned
clipboard transaction. The shortcut suppresses the decoder's raw V while
preserving the browser default paste event, then consumes its clipboardData;
it does not request asynchronous clipboard-read permission on keydown. Local text is read only on an explicit
gesture while this exact control lease is valid. Pending reads coalesce, time out
after 5 seconds and are fenced across revocation/reconnection; text is limited to
16,384 UTF-16 units. Notify/basic text is queued before the paste keys on the same stream. Extended
peers may request Provide only after the application receives Ctrl+V; waiting for
Provide before sending keys deadlocks such peers. `clipboardready` confirms basic
ClientCutText or extended Provide has been sent, not remote application acceptance.
The transaction waits for that completion after emitting the shortcut. Provide waits are
bounded at 5 seconds; timeout/revoke clears retained local clipboard data and
cannot emit late keys. Legacy Latin-1 clipboard rejects unsupported characters
instead of silently corrupting text; extended clipboard transports UTF-8.
Ctrl/Cmd+C arms one bounded remote-copy transaction for the current grant. The
decoder still delivers Ctrl+C; Cmd+C is translated to the remote Control shortcut.
Only its peer clipboard response can satisfy the browser write. Where supported,
the browser write starts synchronously with a promised text Blob to preserve the
user gesture. Updates without a copy intention, oversized responses and responses
after leave/revocation never write local clipboard data. No background reads or
unsolicited peer-to-local writes are added. Native input-only providers retain
their explicit lack of clipboard transport. Browser IME verification below is not an
iPhone system-keyboard acceptance claim.

### Pointer, viewing gestures and mobile text input

The neutral Web adapter owns one pointer/scroll policy. Shell only supplies the
viewport; product providers authorize input, never own gesture listeners. The
pinned decoder exposes reviewed `setSurfaceActive`, `setPointerInputManaged`, `getInputCanvas` and
`sendPointer` APIs. Native pointer output and Ctrl-wheel pinch are suppressed in
managed mode; rendering and hardware keys stay decoder-owned. The public port
checks connected/surface-active/view-only state, coordinates and masks and
preserves the eligible fallback cursor. The application adapter only consumes
public ports; reviewed decoder internals implement cursor attachment. Host
remains the input authority. Installation validates the original source hash and
accepts only complete previous event-only/managed-pointer/surface-activity
generations or the complete current patch, not arbitrary subsets.

- Observe mode: pinch/pan change only local viewing, never send remote packets.
- Confirmed control: one-finger tap/drag operates the remote pointer; two-finger
  translation scrolls remotely. Pinch remains local viewing, not remote Ctrl.
- Finger events are sampled together per animation frame so sequential updates
  cannot misclassify fast scrolling as pinch. Cancellation drops the sample;
  normal release may consume its final sample, under the same valid grant.
- Wheel and touch translation share bounded delta accumulation, reversal/idle
  reset and at most one step per axis per 100ms. RFB encodes discrete steps rather than pixel deltas; wheel and touch input
  use the same bounded accumulation policy. Trackpad
  Ctrl-wheel adjusts local viewing only.
- Zoom is 1–4x anchored under the gesture, with bounded pan. Coordinates use
  actual transformed canvas bounds and framebuffer dimensions. Bars cannot start
  a remote click; a captured drag clamps at framebuffer edges.
- Stop/blur/new grant reset buttons, scroll and queued samples. Old physical
  pointers must lift before a successor accepts them, even if joined by a new
  finger. Reopen/reconnect never resumes control automatically.
- Gesture geometry belongs to the physical input transaction. Viewport position,
  size or framebuffer changes retire held pointers and queued pair samples;
  active remote presses also fence canvas bounds. No old start coordinate is
  remapped into new geometry. Retained fingers must lift before another gesture;
  this cancellation does not itself revoke the longer-lived confirmed grant.

Confirmed control on coarse-pointer Web devices also exposes a separate relative
trackpad when the mounted surface supports `attachTrackpad`. It shares the
adapter's pointer position, single writer, scroll limiter, composition handoff
and grant; it creates no media connection or authority. One finger moves the
cursor, a tap clicks, two fingers scroll or tap for right-click. A stationary
single-finger hold starts a left drag after 300ms; movement of 8px before that
threshold cancels arming for the entire stroke. Small finger jitter is tolerated.
Double-tap then move remains available. A second-tap candidate sends no press
before movement or the hold threshold. Adding a second finger cancels a pending
hold; joining an already-held drag releases it and quarantines both contacts,
without converting the gesture to a right-click. The hold callback rechecks its
identity, current grant and geometry, and uses the same composition handoff.
Reset, pointer end/cancel, capture loss and disposal cancel the timer; synchronous
handoff retirement cannot resurrect pressed state. The compact hint includes
hold-to-drag, while secondary copy describes the two-finger gestures.
Pad reset releases only its own held button, cancels queued samples and fences
retained contacts. Direct media touch remains available.

The pad surface declares `data-sidebar-gesture="ignore"`, including gestures
starting on its hint text. Shell checks this existing ancestor exclusion at
capture time, before the pad's bubbling event handlers. One-finger moves and
two-finger scrolls must never reveal or shift the sidebar; ordinary content
retains Shell's swipe navigation. The full-Shell smoke checks held and released
native touch sequences as well as remote movement, scroll and tap output.

Design System fits the picture above the controls and theme-derived aluminium
trackpad in separate rows. The panel also subtracts Shell's existing
`--right-panel-composer-overlay-reserve`, which includes both the floating
Composer and its latest-turn card. Standalone media sizing is insufficient:
full-Shell regression (`npm run smoke:desktop-trackpad-shell`) must verify pad
hit targets, not only rectangle separation. A short available aperture compacts
padding, the control island and pad height while retaining 44px actions and
the picture; it does not grow into the reserved chat region. Available height comes from the existing Shell visual
viewport, including keyboard contraction; there is no second keyboard observer,
remote OS window movement or canvas/connection replacement. Compact height
retains the gesture hint and hides secondary copy. Stop/revoke hides the pad;
fine-pointer presentation retains the existing layout. Browser checks include
320/390/430px widths, a keyboard-sized viewport and light/dark/extension themes.

Coarse-pointer presentation adds one translated compact Show keyboard action,
enabled only after confirmation on a surface with a text-input port. An explicit
gesture focuses a real editable textarea without moving toolbar/media geometry.
Printable text commits via `input`, not also `keydown`. IME candidates stay local
until `compositionend`; Enter/deletion map to key strokes. Unicode uses RFB
keysyms independently of native clipboard availability. Paste/drop remain in the
existing clipboard boundary. Each keyboard transaction owns its DOM, bounds a
commit to 2048 UTF-16 units and clears/removes the input on revoke. Late events
on removed DOM cannot type into a successor; text is not persisted or logged.

Each text transaction is shorter-lived than its control grant. Before a remote
mouse press, touch tap/drag or paste can change the remote input target, the RFB
adapter transfers focus to its canvas while the old target is still selected.
A platform-confirmed synchronous composition end commits there first; then the
old text transaction is detached and removed before pointer/paste packets.
Candidates not confirmed during this handoff are cancelled rather than replayed
into the next target. Delayed input/composition events cannot enter a new typing
transaction even under the same still-valid control grant. Focus remains inside
the panel, so this handoff must not itself release control. Reentrant revocation
or replacement during focus handoff cancels the old pointer press. Hover, local
pinch and two-finger scrolling do not change the text target or end typing.
Event ordering follows the [W3C composition contract](https://www.w3.org/TR/input-events-2/#input-event-order-during-composition).

Tests and the downstream product's `smoke:cloud-desktop` cover the real patched decoder and native Chromium
touch/IME events with a synthetic peer. Real iPhone keyboard opening, candidates,
viewport occlusion and native executor acceptance still require device/runtime
verification; a Chromium touch profile cannot prove them.

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

The downstream sandbox broker contract (not in this repository) exposes
an unmounted HTTP handler. It requires authoritative resolution and verified
native observe/gated streams. It does **not** parse RFB or pretend a local boolean
is an input gate. The existing immutable observer supplies no control port. A
control-capable adapter must actually arbitrate all users of its executor,
including Agent automation, revoke input and clear held keys/buttons on release
and stream closure. The native input executor and product authority composition
remain absent for the downstream product. The backend now has a verified immutable observer transport:
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

## Desktop service preparation foundation

Desktop service now separates explicit `POST …/desktop/resource` preparation from read-only
`GET …/desktop/resource`. A bounded background job advances installation/startup
without browser polling; user/Sandbox rebinding and retries replace mutable state.
The DTO has no VNC credentials. Its `generation_id` is an orchestration epoch, not
the plugin's physical resource incarnation. This is not yet a `DesktopBackend`
adapter: exact Conversation authorization, attachment, media and input enforcement
are still missing. See the downstream backend resource contract (not in this repository),
including in-memory/multi-replica and Gateway rollout limitations.

## Production adapter requirements (not fully implemented)

1. Resolve canonical binding and authorized environment, not legacy `hostId`.
   Revalidate identity in backend `prepare`.
2. Desktop service/enterprise service prepares the desktop resource; resource incarnation and viewer
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
plugin retirement. This is not real video, security, ICE, enterprise service, device input or
production desktop verification. Additional adapter/provider tests cover
observe-only sessions, source-level control grant fencing, exact product binding,
preparation DTO validation, unknown POST failure and provider retirement.

From the downstream product workspace, `npm run smoke:cloud-desktop --prefix products/<product>` runs the real panel, the downstream product provider and noVNC in a
browser against a synthetic local RFB server and product authority. It checks a
decoded binary framebuffer pixel, a deliberately held first-frame/empty-update
negative, actual pointer/key delivery and focus after a grant, ordered clipboard
and paste keys, local input cessation on revoke and viewer teardown. Set
`OPENCRAFT_SMOKE_EXTENDED_CLIPBOARD=1` to verify Unicode Notify/Request/Provide;
the default legacy peer checks rejection rather than silent Unicode replacement.
It does not verify a real
cloud desktop, production input enforcement, enterprise service or mobile network recovery.

`npm run smoke:local-desktop` additionally injects a lost native viewing stream
inside an isolated Host after a real framebuffer is painted. It verifies a new
authorized connection and canvas, the same framebuffer pixel, observe-only input,
one physical Codex engine and no repeated model request. This controlled local
fault is not evidence of real phone suspension, latency, packet loss or enterprise service recovery.

### Transport assessment (2026-10-04)

Existing ingressproxy routes HTTP and WebSocket upgrades through router/shard
ReverseProxy instances. Its manifests expose HTTP listeners, not a generic TCP,
UDP or TURN listener. Local router/shard tests preserve binary messages including
1 MiB payloads; the TLS test covers local WSS. These do not verify live cloud
ingress, mobile throughput or whether all external UDP is blocked.

enterprise service command execution and enterprise-service session proxy are different capabilities. The
existing downstream Hermes multiplexer opens TCP byte streams to loopback ports
over a WSS/BSON session. Its RFC6455 adapter can therefore carry a desktop
WebSocket, not just control commands. The desktop transport tests exercise the
real RFC6455 adapter with synthetic external byte streams: binary fragmentation,
masked client bytes, a 1 MiB message and logical connection closure. They do not
execute real enterprise service, decode a desktop framebuffer or enforce input authorization.

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
  Giving the browser unrestricted enterprise service access and a VNC password would bypass that
  gate. noVNC `viewOnly` is UX, not authorization. The enforcer must distinguish
  required protocol/configuration/framebuffer requests from keyboard, pointer,
  clipboard and other state-changing operations; unknown operations fail closed.
- Desktop transport has its own physical connection owner, separate from the
  Chat Host. Existing enterprise service logical channels isolate closure, not bandwidth or
  backpressure: one shared socket can queue media ahead of chat. Prefer a separate
  desktop session, subject to backend limits, with bounded queues and reconnect.
- Surface teardown retires only its transport, attachment and input lease.
  Resource lifetime, attachment expiry and transport keepalive are separate.
  Phone suspension releases input, not desktop/Agent execution.
- Ordered RFB bytes cannot be dropped arbitrarily to relieve congestion. Apply
  supported framebuffer-request/rate/quality controls or close and resynchronize;
  verify queue limits and mobile weak-network recovery before shipping.

There is a tested Sandbox broker and a separate opt-in local Host composition,
but no the downstream product multi-tenant authority/verified-stream composition or server-side
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

The viewer uses per-Conversation tabs, separate remote/view lifetimes and
separate observe/control permissions. Signaling and user identity remain with
the provider; robust reconnection is not assumed.

### Explicit takeover from read-only viewing

A backend may declare `requestTakeover` for a single explicit reconnect intent.
A read-only viewer without it keeps the control action disabled. With it, one
activation requests one fresh viewer; the provider owns authorization/preemption
and consumes the flag even if preparation fails. The panel waits for that
reconnect, then requests control only while it still owns interaction focus.
Leaving, hiding or disposing retires the intent; a late grant cannot pull focus
back. There is no takeover polling or automatic preemption on ordinary retry.
The real ShadowRoot panel probe covers success and leaving before readiness;
private provider allocation semantics are verified in the downstream product.
