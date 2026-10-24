# Platform: Architecture and topology

[Architecture index](../../platform-architecture.md) · [Documentation index](../../README.md)


While a `turn/start` or `thread/resume` request is pending, an authoritative
`item/started` notification for `contextCompaction` on the same thread grants
context preparation up to a three-minute absolute request deadline (or the
caller's longer existing deadline). Duplicate starts cannot renew that deadline.
Completion of that exact compaction turn restores the ordinary response wait,
bounded by the same absolute deadline. Other threads and short reads retain their
normal deadlines; timeout-disabled requests remain disabled. Abort, connection
loss and close still reject the exact pending request. The Host owns preparation
and must stop before its deadline; the client never retries or replays the input.

The proposed cross-cutting observation plane is specified in
[Observability V1](../../observability-platform.md), with a separate
[functional and nonfunctional acceptance matrix](../../observability-acceptance.md).
It observes existing owners and does not own execution, recovery or history.
This is an implementation specification, not a claim that the optional stack,
CLI or runtime Skill has already been deployed.

Optional Headless [IM and WeCom server plugins](../../im-switchboard.md) share existing
human authorization, Collaboration input receipts and the Host queue. IM owns
durable `switchboard` bindings and runtime reply context; WeCom owns its protocol
connection. Source keys are not grants; replies never follow a later binding.

The Web/Electron renderer attaches `appserver-diagnostics` to normal runtime
clients and startup identity probes. Console events correlate host, renderer
client instance, connection generation, RPC ID, method and elapsed time for
initialization and conversation restoration. Concurrent reuse of a host/RPC ID
across clients and late responses are diagnostic events, not readiness signals.
Failures are capped at twenty events per client incarnation. Params, results,
raw error messages, credentials and conversation content are never logged.
Observers detach and release pending ownership with their client lifecycle.

Page teardown and owned DSH process recovery follow the
[host lifecycle contract and acceptance matrix](../../../design/dsh-host-acceptance.md).

OpenCraft is a dual-renderer workbench with one semantic application model. This
does not mean one global dependency-injection container. An explicit
Application Supervisor owns multiple lifecycle-scoped runtimes: Host
connections, browser resources, renderer services, extensions, panels and Query clients.
Trusted client products supply account/engine composition through the
`@opencraft/client-product` lifecycle. Core startup owns invocation, rollback and
consumer-before-provider disposal; private products own callback handling,
account creation, extension definitions and configured-Host preflight. Public
clients do not implicitly create a product account or a private brand. Product
sessions may declare managed builtins using resolved deployment defaults; the
existing extension manager retains persisted enablement and lifetime authority. See
[client product composition](../../plugin-architecture.md) for selection and cache scope
boundaries; this does not claim remaining native/private sources are extracted.
The downstream product owns its client and Collaboration plugin workspaces and
their tests. Their existing package exports and runtime implementations remain
unchanged; public core installation has no dependency on those two packages.
Private embedded composition is downstream-owned and selected only by a trusted
local `OPENCRAFT_EMBEDDED_PRODUCT_ENTRY`. Public Web/Electron builds do not probe
for a product entry. Core still owns App, presentation lifecycle and reusable
embedded helpers; the product owns account/physical connection adaptation and
element assembly. Explicit product builds preserve the existing loader and API.
Trusted product Vite configs compose the core build factory, retaining core
platform constraints while owning private feature policy, environment definitions,
gateway settings and artifact directories. A product ID does not implicitly select
private defaults. Product runners retain the original build and compatibility
stages; this changes build ownership without replacing client components.
With dependency auto-discovery disabled, downstream development configs also
own prebundling their private CommonJS dependencies from their own installation.
The public workspace's dependency scan cannot cover packages it does not install.
The shared Vite preload helper stays separate from entry-only polyfill effects;
query-suffixed Workbench loaders have their own chunk. Presentation context does
not re-export the bootstrap factory: consumers use its composition module. This
keeps optional feature updates from invalidating unrelated shared startup chunks.
Renderer realm initialization belongs to the core Web build factory. Both the
HTML entry and trusted embedded product loader finish the shared curated
ECMAScript compatibility module before dynamically importing application/product
code. Product dependencies cannot race shim installation through static module
evaluation. The policy and real minimum-engine startup regression are documented
in [browser compatibility](../../build-matrix.md#browser-compatibility). This boundary
does not emulate DOM/device capabilities, cover Workers or relax owned-source
compatibility checks.

The Vite renderer is the precision desktop surface used by browsers and
Electron. The default Expo entry composes the existing RN Workbench, presentation runtime
and direct WebSocket Host for iOS, Android and Expo Web. Host configuration uses
`EXPO_PUBLIC_APPSERVER_WS_URL` and `EXPO_PUBLIC_APPSERVER_HOST_ID`; a physical
device needs a reachable Host endpoint. It does not instantiate a downstream product account.
The explicit downstream product entry retains its Router, native login, Bot
navigation and packaged frontend DOM runtime. The product runner selects trusted
local entry/config files for the whole Metro/Gradle/Xcode build; core Metro only
replaces the root entry import and delegates every other request to its existing
resolver chain. Product entry directories are added to the watched graph without
replacing npm workspace resolution. Native math/Mermaid capability providers
remain generic and package their runtime code locally. Private routes, account/Bot components and product plugins live downstream.
The public APK/IPA scripts own generic SDK/signing mechanics; the explicit
product runner owns the downstream product edition/identity, permission wording and artifact
naming. The agents-next frontend assembly also belongs downstream, with its
original generated manifest and packaged Bot document. Public commands do not
auto-discover a private product. Legacy development IDs remain unchanged.
The Expo Metro server gzips JavaScript bundle responses for clients that accept
gzip. Physical iOS Expo Go tests require the CLI and phone to use the same Expo
account; an HTTPS reverse proxy uses an `exps://` launch URL. For remote Expo
Go discovery, the Expo tunnel can retain the manifest and list entry while
redirecting bundle downloads to a faster HTTPS origin for the same Metro server.

The target identity and collaboration model is defined in the
[native actors and Hub collaboration charter](../actor-collaboration.md).
Humans and persistent Agent/Bot/Sessions are addressable actors; subjecthood is
independent of permission size. The top-level concepts are Actor, Hub, Resource
and Permission. A Hub is a logical network node with its own identity and one or
more addressable Endpoints; tenant/project scopes are independent of Hub topology.
Hubs can connect directly or through relays and cascade into a larger network,
without requiring a single center or an all-to-all topology. Relays extend
reachability; they do not implicitly issue actor identities, merge tenant scopes
or grant access to target resources. Each hop checks forwarding eligibility,
while target authority remains responsible for the requested operation.
Channels are collaboration resources, and runtime bindings associate execution
contexts with actors. Hubs check admission and forwarding eligibility; the target
resource authority checks the requested operation. This is a target design, not a claim
that cross-Hub trust or tenant isolation is implemented. The initial persistent human /
session Actor registry now provides verified identity binding, revocable Session credentials
and explicit local Actor grants; legacy execution interfaces remain unscoped and reject
these Session bearers. See the charter’s [implementation slice](../actor-collaboration.md#首期主体核心自然人与-session).
The charter's [core and plugin boundary](../actor-collaboration.md#核心与插件的边界)
puts actors, authorization and Hub dispatch in the required core. Identity
sources, execution engines and communication channels enter through plugin
adapters; they do not own the caller's permissions or bypass target authority.

The [human authentication principle](../actor-collaboration.md#多种登录方式绑定同一自然人)
makes the human Actor the stable identity and local accounts, OIDC and enterprise identity
verified identity bindings. One human may have several sign-in methods; each
login identity binds to one human within its identity authority. Permissions,
resource ownership and audit records follow the Actor. Names and matching email
addresses never authorize automatic account merging. Identity adapters verify
their proof; core owns binding, authenticated sessions, admission and authorization.
Client login sessions remain distinct from persistent Bot/Session actors and credentials.
Trusted identity adapters may supply the optional admission port described in
[relay deployment](../../relay-deployment.md#optional-provider-admission-policy).
The gateway prepares verified identities asynchronously; core role, connection
revocation and durable human admission share its synchronous decision. The port
does not replace identity verification, membership or resource authorization.
Headless bundles the official `opencraft.account` server plugin for independent
per-deployment local accounts, configurable OIDC, browser sessions and explicit
linking/unlinking; dedicated enterprise verification remains an optional adapter.
The local plugin owns password policy and credential verification through a narrow
core storage port; core retains the existing v1 database, login tokens and Actor
authority. Deactivation revokes local logins without changing admission or OIDC
identity grants, while ordinary process restart preserves valid sessions.
The authentication owner keeps credentials and browser sessions separate from Actor
bindings and instance membership. See [server authentication](../../server-authentication.md)
for private configuration, operator bootstrap, expiry/revocation and migration boundaries.
Enabling login does not itself change anonymous workspace admission or product-service accounts.

Optional ordinary relay deployment uses core `identity-core` principals and
`access-control` instance membership at every headless HTTP/WS entry. The Node
relay and outbound `relay-connect` plugin transport traffic; enterprise identity authentication
remains an adapter. Ordinary relay tunnels bound active and connecting data streams
with a separate 512-stream per-installation budget; Hub peer links retain their
128-stream budget.
A valid open received at capacity is discarded and its existing server-side ten-second
reservation expires; it never closes the control link or existing data streams.
Once a stream closes, later opens can be admitted. Malformed control messages
still close the link with code 1008. One approved authentication origin hands off a browser-bound,
single-use ticket to each team origin, and the instance independently verifies
scoped assertions and local grants. An explicit `--access-member-provider` policy may admit verified identities from selected providers as ordinary members without persistent implicit grants; explicit revocations and administrator roles remain authoritative. Default installations still require explicit membership. This implements installation admission,
member/admin roles and revocation, not the full Actor/Hub charter or private
per-thread access. Core `hub-network` now supplies stable node identity, signed
invitation enrollment, connection-scoped route epochs and bounded cascading
HTTP/WS forwarding. A Headless settings controller or a private loopback delegate
manages the one authoritative node state; the relay app reuses this core rather
than defining a second federation model. Links, identity issuer trust, forwarding
eligibility and final membership remain separate decisions. This is the Web
transport slice of the charter, not general Actor/resource federation. See
[relay deployment](../../relay-deployment.md).

The existing connection and execution contract is `Client / Hub / Server`. A Client is a
protocol participant and may use an Electron renderer, a static Web page or
another presentation surface. In that contract, the Hub owns scoped attachments,
routing, subscriptions and leases; these roles alone do not establish tenant
isolation. A Server owns Threads and execution state and
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
│        │  └─ @opencraft/appserver-protocol ── Host-aware AppServer contracts
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
OpenCraft desktop frame           iOS · Android · Expo Web
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

The related contracts are grouped in the [architecture index](../../platform-architecture.md).

## Deliberate reuse boundary

The related contracts are grouped in the [architecture index](../../platform-architecture.md).

## Next feature rule

The related contracts are grouped in the [architecture index](../../platform-architecture.md).
