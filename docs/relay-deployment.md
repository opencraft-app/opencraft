# Ordinary relay deployment

OpenCraft can run directly or connect outward to an independently deployed Node relay. The relay lives in `apps/relay-server` in this repository and builds separately; instance connectivity is optional `plugins/relay-connect`. `packages/identity-core` defines verified identity and scoped assertions, `packages/access-control` owns instance membership, and a trusted downstream identity adapter owns enterprise verification and employee-specific presentation. The public core does not bundle an enterprise identity plugin. Removing an identity plugin leaves an enabled core admission policy closed.

The first release forwards ordinary HTTP and WebSocket traffic, including streamed responses and uploads. The relay operator can see application traffic. TLS protects each transport hop; this is not E2EE. A team can choose its department relay or a shared company relay. Relays have separate credentials, keys, sessions and route registries; instances never automatically fall back to another relay.

## One enterprise identity entry, independently owned instances

Only `authentication.origin` needs an approved identity entry. A team address redirects document navigation there, verifies identity through the configured server adapter, then returns a single-use, short-lived handoff ticket. The callback also requires the initiating browser's host-only login cookie. It establishes a host-only, HttpOnly session for that team origin; tickets and sessions are bound to the configured instance and origin. API/WS requests without a session return 401 rather than HTML redirects.

Team addresses still need DNS and TLS. A relay operator can provision wildcard DNS/certificates once, then enroll team subdomains without each team applying for an enterprise identity application/domain. Wildcard enterprise identity registration is unnecessary with the fixed authentication origin. Availability and approval policy of a company's actual enterprise identity gateway must still be verified by its operator. The relay is not an organization directory or a SaaS business-data service.

An instance only trusts a pinned relay issuer/public key and its own instance/origin scope. Ed25519 assertions bind the verified provider/subject to the HTTP method, exact path, instance, origin, expiry and single-use nonce. Managed document probes use the exact core GET admission endpoint and preserve the originally signed method and path. Trusted product startup may declare additional exact compatibility probe paths through `relayAssertionOptions.additionalAdmissionProbePaths`; the generic default has none. This list is copied and validated at provider construction, is never read from relay JSON or HTTP, and does not change signature, nonce, expiry or membership checks. The relay strips incoming assertion/enterprise identity headers. Each request is authorized again against the instance-owned member database. The relay's enrollment credential grants tunnel connectivity, not team administrator permissions.

The legacy connector remains supported. The Hub network additionally implements bounded multi-hop HTTP/WS transport with stable node identity, connection-scoped routing epochs and explicit forwarding policies. This transport slice does not implement general cross-Hub Actor registration, resource federation or per-resource tenant isolation. Trusting the enterprise identity adapter and its pinned assertion key is an explicit identity trust configuration; tunnel enrollment alone never grants that trust or membership.

The relay is also a trusted identity issuer: a malicious operator holding its signing key can impersonate an admitted employee. Key pinning and local membership constrain the trust relationship but cannot protect against that issuer itself. Teams requiring a different trust boundary should deploy their own department relay.

## Request-local shared entry origins

Trusted server composition may supply `RelayComposition.entryOrigin(request)`
when shared server selection is enabled. It returns an approved browser origin or
null for the existing configured behavior. Core requires the request authority and
configured TLS scheme to match; public JSON and forwarded headers cannot load or
select the resolver. Product code owns domain allowlists and ingress approval.

For an approved entry, login and callback use that origin. Login starts, one-use
tickets and host-only sessions remain bound to the exact browser origin, including
concurrent entries; a token copied between origins is rejected. Logout affects its
own session. API, mutation and WebSocket Origin checks use the visiting entry,
while forwarding keeps the selected installation's configured origin, assertion
scope and independent membership. No extra tunnel, route registry or session
owner is created for aliases. Existing fixed-origin deployments are unchanged.

## Shared entry server selection

Set `serverSelection: true` on an authenticated relay whose approved authentication
origin is also an explicitly configured entry route. It is opt-in; existing
per-origin deployments keep their behavior. A document visit to `/` lists only
servers whose own `/__opencraft_access/session` admits the verified principal.
Static routes can set an optional `name` (up to 128 characters); discovered routes
use their peer name or enrolled hostname. The explicit chooser is `/servers`; a selected Workbench runs at
`/servers/<instanceId>/`. Static routes and discovered Hub routes use
the same scoped issuer and target admission contract. A user may access another
instance even when the entry instance denies that user membership.

Operators can separate public route labels from immutable instance IDs:

```json
{
  "serverSelection": true,
  "serverPaths": {
    "aliases": { "entry-instance": "main", "hub-instance": "research" },
    "defaultServer": "entry-instance"
  }
}
```

Aliases are unique lowercase labels, up to 63 ASCII letters, digits or hyphens,
starting with a letter. They are local entry configuration, including for discovered
Hub IDs; they do not rename a Hub, grant access or change issuer scopes. Configured
aliases are the public routing keys, not additional aliases for the old ID URLs.
Ambiguous routes fail closed. An omitted alias uses the instance ID. Cookie names,
preference values and browser storage continue to use immutable instance IDs.

`defaultServer` must identify the explicitly configured authentication-entry
instance. Its Workbench, settings, API and WebSockets run without a server prefix.
The chooser links to its explicit named route; **after successful HTML admission**
the document replaces that URL with its unprefixed path, preserving query/fragment,
before Workbench starts. This avoids a root-entry redirect loop and commits the
successful explicit selection. Other servers keep `/servers/<label>/…`. A visit
to `/` is still automatic entry: it consumes the verified user's last successful
choice, or the configured default on first use. An unprefixed deep link explicitly
belongs to the default instance and never follows another remembered server.
No API, upload or WebSocket request is redirected to canonicalize its address.
Deploy compatible Workbench clients before enabling this routing configuration.

Legacy `/__opencraft_servers` document links redirect to `/servers`, preserving
the selected instance, deep path and query. Old API, upload, stream and WebSocket
requests keep working at their original prefix until navigation. Updated clients
accept both deployment contexts, so upgrade target clients before activating a
relay that emits the short path. Instance IDs, remembered choices and browser
storage scopes remain unchanged.

In a relayed Web Workbench, **Settings → Servers** shows the current server and
provides **Switch server** to open the explicit chooser. This is the only Shell
entry for switching servers; it is available to ordinary admitted members and
does not require the server-administration build flag. Direct deployments without
relay context do not advertise a chooser. The relay-supplied selector path also
preserves compatibility with legacy deployments.

Without `serverPaths.defaultServer`, unprefixed entry Workbench bookmarks, such as `/settings/remote-connections`,
redirect after target admission to that same instance's `/servers/<instanceId>/`
path, preserving the deep path and query. This applies only to successful GET
HTML navigations; API requests, uploads and WebSockets retain their existing
behavior. It does not consult another saved server choice or grant membership.
Reload an already-open unscoped page to receive the deployment context and the
**Settings → Servers** entry.

The URL `/servers/<label-or-instanceId>/…` always selects that server, including deep
links and reloads, regardless of a saved choice. After a successful admitted
top-level document opens, the browser remembers that server under a key derived
from verified provider and stable subject, within that entry origin. This includes
direct links, not just chooser clicks. Future root visits reopen it only while
target admission succeeds. Failed navigation, background requests and embedded
frames do not change the preference; a different tab remains bound to its own URL. Root entry resolves the saved/default destination before the chooser can paint.
Automatic navigation shows no intermediate text or status; the full chooser
appears only when a choice is needed. Without JavaScript the choices remain usable.
Explicitly opening the chooser never redirects
automatically. Another browser, cleared browser data or a different identity
requires another choice unless an operator configured an identity migration default. Offline or revoked targets return document navigation
to the chooser; APIs/WS return errors and never silently switch servers. Existing
execution continues independently when the user switches the page.

Operators migrating an existing installation can set `serverSelectionDefaultsFile`
to an absolute, owner-only JSON file:

```json
{"schemaVersion":1,"defaults":{"<sha256-of-JSON-[provider,subject]>":"team-a"}}
```

Snapshot verified stable bindings for existing users into this deployment data;
never put employee names or IDs in source. For historical records that predate
stable bindings, the file may also contain hashed provider aliases. These only
match aliases explicitly supplied by the currently verified identity provider;
they supply navigation hints, never identity merging, saved preference keys or
authorization. A stable binding default takes precedence over an alias hint. The hash uses UTF-8 compact
`JSON.stringify([provider, subject])`. Limits are 10,000 entries and the private
configuration reader's 1 MiB size cap. A default only applies on a root visit
without a saved choice and is remembered when the admitted target opens. Saved
choices, including currently unavailable ones, take precedence. Explicit chooser
visits remain open. Defaults never grant membership, resurrect disabled users or
silently substitute another target. New identities absent from the file see the
chooser. File changes take effect on relay restart.

The URL binds the target per tab. The relay validates the browser's entry Origin,
removes the target prefix before signing the exact target request, and preserves
the enrolled target origin as its assertion audience. Browser assets, Router
basename, application HTTP/WS adapters and persistent storage are scoped by the
injected deployment context. Target cookies are renamed and path scoped; entry
login cookies and other instances' cookies are never forwarded. Uploads, SSE and
binary responses remain streams; only HTML documents are buffered (maximum 2 MiB)
to inject context. Update/deployment control paths remain unavailable.

Saved bundled WebSocket profiles use the stable instance namespace. Before opening
transports, the client reconciles a profile whose same-origin AppServer URL still
uses that instance's former stable-ID prefix to the current deployment URL. This
updates only the endpoint and retains the profile identity, enabled state, custom
browse roots and other preferences. Other instances, origins, custom paths and
URLs carrying credentials or query parameters are never retargeted. This is a
saved-recipe repair; retired public routes are not enabled or redirected. Reloading
the client is sufficient and does not clear its conversation or profile databases.

This mode reuses the existing entry DNS/TLS/enterprise identity configuration; no target DNS record
is required. The enrolled target origin remains a virtual identity audience.
Both relay and target Workbench must be upgraded together before enabling it.
Target membership/admin stores remain authoritative and independent; relay
operators never acquire an instance administrator role by enrollment or selection.
Same-origin installations share the browser origin trust boundary: use this mode
with trusted server operators. Separate origins are the supported boundary for
mutually untrusted application code; storage/cookie namespacing is not a browser
sandbox against malicious same-origin JavaScript.

Validate the built Headless Web client with `npx tsx scripts/smoke/execution/smoke-server-selection.ts`
(after a Headless Web release build). It uses two real isolated core membership
stores, relay tunnels and Chromium with synthetic provider/Codex boundaries.
It does not stand in for actual corporate employee sign-in.

## Build and configure

Use Node 24 or newer. From the repository root (`opencraft/`):

```sh
npm ci
npm run build:relay -- /absolute/output/relay
node /absolute/output/relay/relay.mjs /absolute/private/relay.json
```

All JSON configurations below must be owner-only regular files (0600), with absolute paths. Generate an Ed25519 key pair and independent random 32-byte base64url enrollment credentials using your deployment secret tooling. Never commit actual keys, tokens, sessions or configurations. A minimal core transit configuration is:

```json
{
  "schemaVersion": 1,
  "host": "127.0.0.1",
  "port": 18090,
  "routes": [],
  "hubNetwork": {
    "stateFile": "/private/hub-network.json",
    "operatorCredentialFile": "/private/hub-operator.json"
  }
}
```

The operator file contains `{ "credential": "<independent 43-character random base64url>" }`.
Enrollment, peer TLS and incoming endpoint configuration are described below.

An authenticated gateway instead requires a trusted entry that supplies
`RelayComposition.createIdentity`; the default CLI rejects gateway configuration
without that adapter. See [server identity composition](server-authentication.md#headless-composition-contract)
for the instance-side boundary. Its core configuration shape is:

```json
{
  "schemaVersion": 1,
  "host": "127.0.0.1",
  "port": 18090,
  "authentication": {
    "issuer": "department-relay",
    "origin": "https://login.example.test",
    "privateKey": "<Ed25519 PKCS8 PEM>",
    "providers": ["example-identity"]
  },
  "routes": [{
    "instanceId": "team-a",
    "origin": "https://team-a.example.test",
    "credential": "<43-character base64url enrollment credential>"
  }]
}
```

Terminate HTTPS at a trusted ingress with a loopback relay backend, or configure `tlsCertFile` and `tlsKeyFile` for native HTTPS. A non-loopback plain HTTP listener requires explicit `tlsTermination: "trusted-proxy"`; restrict its network access to that ingress. The TLS gateway is part of the trust boundary and must preserve the public Host and enterprise identity headers only from the real identity gateway. Configure gateway header/body/connection limits. The application limits each instance to 512 concurrent streams, bounded stream buffers, 10-second tunnel acquisition, 30/60-second response establishment, and a one-hour stream lifetime. Long sessions reconnect normally; request bodies and non-HTML responses stream without full buffering.

The instance connection configuration contains only:

```json
{
  "schemaVersion": 1,
  "relay": "https://relay.example.test",
  "issuer": "department-relay",
  "instanceId": "team-a",
  "origin": "https://team-a.example.test",
  "credential": "<same per-instance enrollment credential>",
  "publicKey": "<Ed25519 SPKI PEM>"
}
```

Start the instance with `--relay-connect-file /private/connection.json`. This enables core membership without requiring the relay's identity-provider credentials on that instance. The local target defaults to the instance listener. For an installation with a separate managed static entry, an operator may pin `targetPort` to that entry's loopback port. A relay cannot choose the target, tunnel to arbitrary services, or export the managed update endpoints. Keep updater access on a protected management route; membership admin is separate from software deployment authority.

`allowLoopbackInsecure: true` permits only an explicit `http://127.0.0.1:PORT` relay for local tests or a relay on the same machine. Network connections require HTTPS and normal certificate verification; optional absolute `caFile` adds a private company CA bundle without disabling verification. Enrollment is administrator maintained in the relay's configuration; adding/removing a route or rotating its credential requires restarting the relay. Run one connector per instance credential. Relay restart drops sessions/tunnels and requires employee sign-in again, with no application database changes.

## Core entry and product composition

The default `npm run build:relay` artifact is product independent. For a transit
Hub it accepts `routes: []` and the existing `hubNetwork` configuration. Gateway
authentication uses an explicit `authentication` object with `issuer`,
`privateKey`, `origin` and `providers`. A trusted server composition supplies
`createIdentity` from `relay-server/application`; the default CLI rejects that
configuration when no adapter is supplied. It never imports a module named by
JSON or silently ignores private fields. Declared providers constrain principals
returned by the adapter; core authorization at each target remains authoritative.

Downstream products bundle their identity adapter explicitly via the `relayEntry`
parameter of `packageRelay` or `packageWebServer`. The product owns private
configuration and adapter creation; private fields are not part of the core
configuration illustrated above. Trusted external product entries use normal dependency resolution
first, then the current core workspace's node_modules as a build fallback; no
module path comes from runtime JSON. The application owns resource rollback, listeners, TLS, assertions and
Hub routing. Existing product artifacts retain their `relay.mjs` interface.
Choose the matching product artifact for real enterprise login validation; the
public tests below use synthetic providers. The default core artifact deliberately
rejects unrecognized product configuration.

## Bootstrap a new team without its own enterprise identity application

Before the team's first Headless startup, inspect/import its invitation using the
bundled offline machine-owner command. It uses the same core commands as settings
and refuses to open a state file already owned by a running process:

```sh
node /absolute/output/relay/hub-admin.mjs /private/team/hub-network.json /private/inspect.json
node /absolute/output/relay/hub-admin.mjs /private/team/hub-network.json /private/connect.json
```

The owner-only `inspect.json` contains `{ "action": "inspect", "invitation": "<invitation>" }`.
After checking the fingerprint/issuer, `connect.json` contains
`{ "action": "connect", "invitation": "<invitation>", "trustIdentity": true, "publishOrigin": "https://team.example.test" }`.
The selected origin must be granted by the invitation. Keep the invitation out of
shell history and remove these private input files after use. The same binary is
bundled as `runtime/hub-admin.mjs` in the server package. A plain invocation with
only the state path prints a credential-free snapshot.

Bootstrap a member/admin using `access-admin.mjs` below, and start Headless with
that same data root and `--access-control`. Persisted Hub identity trust and
published origin enable target admission without a separate enterprise identity token or legacy
connector configuration on the team. An explicit
`--access-member-provider example-identity` may admit all verified employees when that is
the team's policy; administrator grants stay explicit. The approved enterprise identity entry
still runs only at the original relay. Later node administration uses settings.

## Member administration

The authoritative store is `memberships.sqlite` under the instance data directory, opened with managed migrations and reported in health outcomes. It is not replicated to the relay. `admin` can maintain members/audit; `member` can use this shared installation. Members in one installation share its authorized projects, conversations and saved connections. This release does not claim per-conversation ownership or viewer-only restrictions.

Bootstrap/recover administrators from the instance machine using the independently bundled administration command:

```sh
node /absolute/output/relay/access-admin.mjs /private/instance/memberships.sqlite grant example-identity STABLE_SUBJECT admin
node /absolute/output/relay/access-admin.mjs /private/instance/memberships.sqlite grant example-identity STABLE_SUBJECT member
node /absolute/output/relay/access-admin.mjs /private/instance/memberships.sqlite revoke example-identity STABLE_SUBJECT member
node /absolute/output/relay/access-admin.mjs /private/instance/memberships.sqlite list
node /absolute/output/relay/access-admin.mjs /private/instance/memberships.sqlite audit
```

Replace `example-identity` and `STABLE_SUBJECT` with the configured provider and
its verified immutable subject from the session/member APIs. Core subjects are
provider-scoped and need not be numeric; display or login names are not identity
proof. A trusted adapter may supply verified legacy aliases for one-time grant
binding. Core consumes that alias grant and retains the stable subject, so later
name reuse does not transfer the bound grant. Explicit stable-subject revocation
wins over a legacy alias. Product-specific staff mapping and enrollment inputs
belong to that product's adapter.

The core also exposes authenticated `GET /__opencraft_access/session`, admin-only `GET/POST /__opencraft_access/members` and `GET /__opencraft_access/audit`. POST requires matching Origin, JSON and `{provider,subject,role,enabled}`; remote self-removal is rejected. Local machine administration is the recovery authority and its audit operator is recorded as `local-operator`, not a fabricated employee. There is no organization synchronization.

For an installation that admits every verified identity from a provider, explicitly configure
`--access-member-provider example-identity` on the instance. Only identities verified by
the configured provider/assertion trust receive an implicit ordinary member role;
anonymous requests and other providers stay denied. Existing administrators retain
their role. Explicit stable-subject/Actor membership revocation and disabled Actors
remain authoritative. The default role is not persisted as an explicit membership,
so restarting without this option removes default access without leaving permanent grants.
The default installation remains explicit-member-only. This option never disables
signature, scope, expiry, relay admission or resource authorization checks.

A downstream adapter may import validated legacy memberships once through the
core store; its legacy configuration and input validation remain product-owned.
The public Headless CLI does not expose a private allowlist-file option.
Subsequent administration uses the core store; reimporting a previously recorded
source does not resurrect revoked accounts. An enabled admission policy without
member grants or a configured provider default denies everyone. Removing a provider does not turn off `--access-control` or relay membership. HTTP admission is checked for every request, and open HTTP/WS sessions are checked on a 500ms revocation poll (subject to event-loop scheduling); revoked WS clients lose message delivery and are forcibly disconnected even if they ignore the close handshake; native engine work can continue under its existing independent execution contract.

## Validate without a registered domain

```sh
npm run test:relay
npm run test:headless-server
```

Use `.test` names resolved locally and a trusted local test CA for browser HTTPS/cookie/redirect tests. No domain registration is needed. Keep synthetic enterprise identity signing keys confined to the test boundary; success does not establish that a real corporate gateway forwards the right headers. Separately verify actual employee login through the approved existing entry.

Enterprise provider tests and browser sign-in smoke commands belong to the
downstream product that supplies the adapter. For the public packaged transit
Hub/browser path, use the `smoke:hub-network` command documented below; it uses
isolated test identities and does not validate a real enterprise provider.

The test matrix includes two isolated instances, team-bound login/cookies, rejected cross-team/replayed assertions and tickets, HTTP and WS/binary flow, large upload checksums, incremental SSE, membership revocation, instance disconnect/reconnect, independent relay credentials and gateway Origin rejection. Revoke enrollment by rotating/removing the route credential and restarting its relay; revoke business access in the instance store. Never silently move an instance between relays.

For managed site, first deploy compatible core code through clean `env/join` and its managed CI, then validate a relay and protected local entry on separate ports. Preserve the business data root, machine/server/thread IDs, independent execution services and updater route. Only move the public ingress after both the login path and the member bootstrap have evidence and a tested configuration rollback. Version/health on the management entry remain the source of delivery truth. A source build, local mock login or successful merge alone is not a production cutover receipt.

The managed entry supports `OPENCRAFT_RELAY_INGRESS_URL=http://127.0.0.1:RELAY_PORT`
and `OPENCRAFT_RELAY_INTERNAL_PORT=PRIVATE_PORT`. It forwards public business HTTP/WS
to the relay while its second listener binds only loopback and serves the protected
instance through the existing static-worker/headless owners. Every private static request
is admitted by the instance core, including requests without HTML Accept headers. Pin the connector's
`targetPort` to that private port. `/version.json`, health and the existing updater
keep their management behavior; team membership does not grant deployment keys.
CLI options take effect when the stable managed launcher is restarted from its
aggregate artifact, not merely when its static worker updates. Preserve the old
environment/configuration for rollback; do not restore an older business database.
The managed package also carries inactive `runtime/relay.mjs` and
`runtime/access-admin.mjs` entry points so a relay can be deployed from the same
fixed-source artifact without borrowing feature-branch files.

## Hub network and cascading connections

In a Headless Web installation open **Settings → Hub network** as an instance
administrator. The core owns node identity, routing, invitations and forwarding;
`relay-protocol/node` supplies the same streaming duplex used by the ordinary
relay. enterprise identity validation remains in its identity plugin. The independently deployable
relay stays in this repository; no second server repository or SaaS control plane
is required.

1. Set a node name and its reachable HTTPS endpoint before enabling incoming
   connections. An outgoing-only node needs no incoming endpoint. Enable transit
   only when this node should carry traffic for descendants.
2. Generate an invitation with the exact service origins permitted through this
   connection and whether descendants may transit. Empty origins permit a node
   connection without publishing business services. Share the invitation privately.
3. On the joining node paste the invitation, inspect the node fingerprint and
   identity issuer, then explicitly accept that identity source if supplied.
   Optionally select an allowed origin to publish this installation. Connecting
   does not grant local employee membership or administrator rights.
4. To form A ← B ← C, B imports A's invitation, enables incoming connections and
   forwarding, then generates C's invitation. A's scope must include C's origin
   and permit transit. C's invitation must include that origin. Route views show
   the actual path; disconnect/revoke withdraws it and closes affected streams.

The first redemption binds an invitation to the joining node's Ed25519 key.
Unused invitations expire after 24 hours; redeemed nodes reconnect with the same
persisted identity until revoked. Invitations are shown once; incoming enrollment
stores a hash, outgoing connections retain their required credential in the private
node state. Public snapshots contain neither credentials nor private keys. Keep
`hub-network.json` under the Headless data root private and backed up with its
identity; copying it into two running deployments is unsupported. One process
owns the file and lock. Endpoints, identity trust and published origin survive
process restart, independently of application resource IDs and databases.

Advertisements require an owner-signed service descriptor and an acyclic path,
with at most eight nodes. Each neighbor enforces exact origins and transit scope;
ambiguous public hosts are rejected. Connection retirement removes its routes.
The original pinned identity issuer signs for the final target; intermediate nodes
do not become identity issuers. The target checks signature, audience, origin,
request, expiry, nonce and its own current membership. Revoking identity trust
stops publishing the local service. Forwarding is ordinary hop-by-hop transport,
so intermediate operators remain trusted with traffic; there is no E2EE or
transparent replay of interrupted writes. Alternate paths are selected only for
new requests.

### Standalone relay as the same logical Hub

Optionally add the following to the existing private relay configuration:

```json
{
  "hubNetwork": {
    "stateFile": "/private/hub-network.json",
    "operatorCredentialFile": "/private/hub-operator.json",
    "caFile": "/private/hub-ca.pem",
    "tlsCertFile": "/private/hub-cert.pem",
    "tlsKeyFile": "/private/hub-key.pem",
    "port": 18443
  }
}
```

This is an additional peer-only native TLS listener. It reuses an existing DNS
name with another reachable port if necessary; no new enterprise identity browser entry is needed.
The CA field is optional for a normally trusted certificate. A private CA is
carried inside the signed invitation and used with normal hostname/certificate
verification, never `rejectUnauthorized: false`. The endpoint configured in the
settings must match the certificate and actual externally reachable listener.
When HTTPS is already terminated at a trusted ingress, the existing relay listener
can carry the peer upgrade paths and the separate peer listener can be omitted.

`hub-operator.json` contains `{ "credential": "<independent 43-character random base64url>" }`.
To let this installation's administrators manage that same relay-owned Hub, create
`hub-network-controller.json` under the Headless data root, owned by the server
user with mode 0600:

```json
{
  "schemaVersion": 1,
  "endpoint": "http://127.0.0.1:18090",
  "credential": "<same private operator credential>"
}
```

Headless reads this optional file at startup and delegates its admin-only settings
API to the loopback owner. The credential never reaches the browser. The relay's
operator endpoint independently requires loopback and this credential; its public
peer TLS listener does not expose it. Without the file Headless owns its own local
Hub state. A configured invalid file fails startup rather than creating another
identity. A relay configured as an enterprise identity gateway has an operator-managed assertion authority and
preserves legacy routes and the approved authentication origin. Only services
explicitly trusting that same authority are published through its enterprise identity gateway.
A department node serving only as a transit relay omits the `authentication`
object and sets `routes: []`. Import the upstream invitation into its state with `hub-admin.mjs`
before startup, then configure its incoming endpoint and issue downstream invites.
It forwards the original issuer's scoped assertions without holding that issuer's
private key or obtaining its own enterprise identity application. The core application supports both roles through explicit
composition; gateway authentication requires the trusted adapter entry described above. Partial
gateway configuration is rejected.
Changes to listener certificates, delegation or relay configuration require a
service restart; ordinary invitation and policy changes use settings with revision
conflict detection and operator audit. Keep the previous configuration/artifact
for rollback without restoring old business databases.

Run `npm run test:hub-network`, `npm run smoke:hub-network-settings` and
`npm run build:relay -- /absolute/output/relay`, then
`OPENCRAFT_HUB_RELAY_ARTIFACT=/absolute/output/relay/relay.mjs npm run smoke:hub-network`.
The last smoke uses actual packaged relay code, two normally verified TLS hops,
Chromium login handoff and target membership revocation, entirely with isolated
`.test` names and synthetic enterprise identity fixtures. Neither domain registration nor real
employee credentials are required. It proves the transport, not external firewall
reachability or real corporate enterprise identity gateway configuration.

### Origin-bound installation sessions behind a selected server

The injected server context includes the enrolled `targetOrigin`, distinct from
the browser entry origin. Clients use it only to validate installation session
metadata; all requests still go through the scoped same-origin relay path. The
relay translates a Referer only when it belongs to this entry and this selected
server. Other target and foreign references never acquire target authority.

A headless target reached through a public relay origin must explicitly enable
its existing SSH management ingress policy (`--ssh-public-access`, or a fixed
HTTPS `--ssh-public-origin`). A loopback listener alone does not opt in to a
public Host. The outer instance admission, origin-bound SSH grants, cross-site
checks and namespaced cookies still apply. This does not grant team membership
or enable a remote SSH connection automatically.

The sidebar conversation error label describes a failed conversation state; it
does not prove that its Host transport is disconnected. Read the conversation's
actual error to distinguish provider quota from connection failure.

### Nested application documents

HTML rewriting preserves a root-relative application `<base href>` within the selected installation prefix. This keeps relative script and stylesheet requests under a nested application's own resource directory. Documents without a usable local base retain the installation root; external or escaping bases do not retarget relay admission. This only scopes HTML resource resolution and does not change request identity, cookies or membership checks.


## Optional provider admission policy

A trusted Headless identity adapter may supply `admissionPolicy` with asynchronous
`prepare(principal)` and synchronous `allows(principal)` / `allowsBinding(binding)`.
The gateway prepares verified identities before ordinary HTTP/WS and human Actor
interfaces. InstanceAccess applies the same policy to role checks, existing
connection watchers and durable human-Actor admission. The port never verifies
identity, grants a role, removes an explicit revocation or changes Session bearer
permissions. Omitting it preserves current behavior. Provider-specific settings,
verified attributes, storage and execution belong to the adapter. Policies must
fail closed, fence stale asynchronous completions and retain trusted binding
facts needed for durable admission after restart. Publication invalidates old
policy decisions. Local recovery and machine-to-machine Hub authentication keep
their separate existing contracts.


## Standalone HTML preview responses

`/__opencraft_preview` owns its relative URLs, snapshot limits, CSP and report
sandbox. Relay forwards these responses as a stream without Workbench document
injection, canonical-navigation redirects or the 2 MiB Workbench HTML rewrite
buffer. It preserves status, body bytes, encoding and security headers, while
retaining existing selected-instance cookie scoping, login, signed assertions,
instance admission, stream budgets and response deadlines. In particular a large
inline-image report must not be truncated or receive Workbench scripts, and an
expired preview must keep its 403 rather than redirect to the server chooser.
Other Workbench HTML keeps its existing rewrite behavior and bound.
Regression: `tests/protocol/relay-html-preview.test.ts` exercises the full selected
Relay/tunnel/instance/ticket path with a report larger than the rewrite limit.
