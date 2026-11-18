# Response-end notifications

The secure iOS/iPadOS Home Screen workbench can opt into server-driven response
notifications through the local device control in Settings → Chat. A separate account-scoped master switch pauses all configured methods. Permission
is requested only from the explicit switch action. The test action reports acceptance by the push service, not proof
that the OS displayed a notification. TurnNotificationController owns this feature, combining the existing page preference
and authenticated persistent subscription. There is no separate background-notification
switch. Existing page-only consent stays page-only until an explicit enable action;
existing push-only consent appears enabled and is preserved. Disabling revokes both
paths, including device revocation when the server is offline. Opening Settings refreshes the current device permission and subscription. The complete
initial read, including browser subscription APIs and response-body reads, has a ten-second
deadline. A stalled read releases the pending state, exposes a connection failure and
fences late results so they cannot undo a later enrollment. Blocked permission leaves
the switch actionable for feedback and recovery after the OS permission changes; an
unsuccessful permission action never stores consent.

An enabled server
subscription suppresses the page path for the same managed Host to prevent duplicates.

Both delivery paths identify the conversation before the terminal response status.
Background delivery reads only that outbox entry's exact Host/Thread metadata
(`thread/read`, `includeTurns: false`), using its name or initial-message preview.
Whitespace is collapsed and labels are limited to 80 Unicode code points. A missing,
mismatched or unavailable Thread falls back to its exact ID, never another task or
the currently selected page. Metadata is read at delivery time, including retries;
no conversation text is added to the persistent push store. The status describes
one response ending, not completion of the whole task. Test notifications stay generic.

## Owners and identity

PwaRuntime owns ApplePwaPushDevice through PushDevicePort. Application-owned TurnNotificationController composes the page display adapter
and PwaTurnPushController. The latter binds the browser subscription to the authenticated server
Actor and supplies translated notification templates from the existing IntlRuntime.
TurnPushService and PushStore belong to the Headless server, independently of
React, document visibility and renderer websocket leases. PushObservationTransport
observes trusted TransportSubmissionContext at the physical gateway boundary;
no actor identity is decoded from a submitted RPC body.

Device consent is scoped to the deployment origin, human Actor and browser
subscription. A device rebind gets a new binding ID; old queued deliveries cannot
cross accounts. Mutations require current human authentication and matching
trusted HTTPS origin. The subscription API exposes the VAPID public key only. The VAPID
private key and subscription encryption material remain in the managed private
SQLite store. Local/OIDC device bindings retain a non-bearer login digest so logout,
credential revocation and expiration remain enforceable after gateway restart.
Account sign-out revokes the device before ending the provider session. Actor
revocation and instance admission are checked again immediately before sending.
Already accepted OS/push-service notifications cannot be recalled.

## Completion evidence and bounds

Only opted-in actors' submitted input IDs on local-codex and opencraft-server
are watched. turn/start, turn/steer and thread/queue/add are observed without
altering execution. A bounded five-second server sweep correlates the exact
userMessage.clientId in authoritative thread/items/list history with its Turn,
then checks thread/turns/list terminal evidence. No completion is inferred from
history recency, text, socket loss or a thread's generic idle state. A rejected or
unknown submission produces no notification unless its exact input is later
proven in history. External/SSH Hosts are outside this version's coverage.

There are at most 4096 outstanding watches, eight inspected per sweep, at most
five 100-entry pages per history phase, and at most eight outbox sends per sweep.
Reads for the same thread/page share one request within the sweep. Each internal
history request has a ten-second lease deadline. Watches expire after 24 hours;
inputs beyond the bounded history window are left unresolved rather than matched
heuristically. These bounds can delay notifications under load; they do not delay
or resubmit execution. Storage and source failures are reflected in plugin health.

Terminal evidence transactionally marks its watch and inserts per-device outbox
rows, deduplicated by Actor, server, Thread and Turn. Restarts retain watches,
VAPID keys and pending deliveries. 404/410 retire a subscription; transient and
429 errors retry at most six attempts with bounded backoff, within one hour.
The push TTL is one hour. Invalid/permanent failures stop that delivery. There is
no exactly-once OS delivery guarantee; a stable notification tag also limits duplicates.

## Browser delivery

On iOS/iPadOS 18.4+ the window PushManager supports declarative Web Push. The
server sends web_push=8030 and a complete visible notification with a same-origin
conversation URL; the OS can display it without document or worker execution.
Older compatible Home Screen apps register the fixed opencraft-push-worker.js
under a dedicated nested scope. It only displays notifications and opens the
validated same-origin destination; it never handles fetch or claims application
pages. This leaves existing proxy and notification workers under their owners.
The standard subscription APIs are feature-detected rather than version-sniffed.

The API uses server-context-aware paths. HTTPS and its trust chain must work on
the receiving phone. A reverse proxy may terminate HTTPS and forward HTTP
internally, preserving the configured public origin and worker/API paths. The
server needs outbound Apple push connectivity; Apple does not call a private
backend callback. No paid Apple Developer Program membership is required.

Validation must distinguish synthetic device/provider boundaries, real HTTP and
AppHost behavior, packaged UI and actual iPhone/APNs delivery. A build, provider
2xx or desktop simulation is not physical-device acceptance.

Managed Headless installations forward the exact `/__opencraft_push` HTTP route
from the static Web worker to Headless, preserving authentication, Origin and body.
Static serving alone cannot handle subscription operations.

## Additional Turn-end notification methods

Settings → Chat now presents an account-scoped master switch, the existing local
notification control, and a list of independently enabled destinations. Add opens
a compact dialog on desktop and the shared adaptive bottom sheet on narrow
screens. Configuration drafts stay in memory. The master switch pauses server
notifications without deleting destinations and discards pending deliveries and
watches; re-enabling does not replay events from the paused period. Browser-local
notifications consume the same master state when the application refreshes it.
The local device control still owns browser permission and PWA subscription consent.
An older or unavailable server retains the original local-notification UI.

- Bark accepts the copied `https://server/device-key/title/body?...` URL or a GET
  curl example. Curl is parsed as text, never executed. Example title/body are
  replaced; options such as `group` and numeric `ttl` are retained. The server
  sends JSON to `/push` with a conversation link. HTTPS self-hosted Bark servers
  with a public network address are supported, including explicit ports.
- Webhook sends POST JSON: `id`, `event` (`turn.ended` or `notification.test`),
  `title`, `body`, `url`, `status`, and, for Turn events, `hostId`, `threadId`,
  `turnId`. The optional Authorization header is entered under Advanced settings.
  The response must be HTTP 2xx. Receivers can deduplicate retries using `id`.
- IM lists only verified sender identities belonging to the authenticated human,
  using enabled Slack or WeCom connections with proactive-send support. These
  are personal direct-message targets, not arbitrary groups. Slack uses
  `conversations.open` and `chat.postMessage` (the bot needs `im:write` and
  `chat:write`); WeCom uses the existing proactive direct-message adapter.
  Delivery rechecks admission, identity binding and connection readiness.
  An unknown IM acknowledgement is not automatically retried; a failure known
  to occur before sending may retry. No chat routing or conversation binding is
  created for notifications. Group-target discovery is not included.

Save and test first persists configuration, then explicitly submits a test. A
failed test leaves the saved destination available for editing or retry. Repeated
saves after an uncertain HTTP response share a creation ID, avoiding duplicate
configuration. Test acceptance is not confirmation of display on a phone.
Endpoints and authentication values are never returned by the configuration API;
only a masked host label is shown. Editing with an empty address keeps the saved
address. To change Webhook authentication, re-enter the address and the new header.
No full assistant response is sent; titles can contain conversation names or
initial-message previews, as on the existing PWA path.

`/__opencraft_notifications` uses the same human authentication, trusted HTTPS
origin and account-generation checks as the subscription API. Configuration is
stored by migration 2 in the existing private `web-push.sqlite`; migration 1 is
unchanged. `push-storage-worker.mjs` exclusively owns production SQLite access,
including migrations, keys, watch registration, outbox state and shutdown. The
main service awaits committed changes through an asynchronous port. Packaging
must ship the worker beside the headless entry point; there is no main-thread
SQL fallback. Expired external bindings pause delivery and retain configuration
for explicit reconnection through Edit and save.

External HTTP delivery resolves and validates public IPs on each attempt, pins
DNS results for the TLS connection, refuses redirects, bounds time and response
size, and never reports endpoint secrets in errors. Private, loopback, mapped
and transition addresses are rejected. Webhook/Bark transient failures retry via
the shared bounded outbox; delivery is at-least-once, not exactly-once. Changing
a target invalidates its previous queued deliveries. Existing Host coverage
remains `local-codex` and `opencraft-server` only.

Focused verification: `test:web-push`, `test:notification-destinations`,
`smoke:notification-destinations`, affected workspace typechecks, i18n and shared
control checks. The UI smoke uses real settings/modal/menu components with a
synthetic notification API; it does not establish real phone or IM delivery.

### Notification request diagnostics

Failed requests to `/__opencraft_notifications` and `/__opencraft_push` emit
`[opencraft notification request failed]` to the gateway service log, including
failures before notification admission. Each request gets a server-generated
`x-opencraft-notification-request-id` response header. Match this value to
`requestId` in the log; an incoming header cannot choose the ID.

Records contain only endpoint category, HTTP status, a fixed error code/reason,
and elapsed milliseconds. Origin rejection reasons distinguish
`trusted_origin_missing`, `trusted_origin_invalid_protocol`, `origin_missing`,
`origin_mismatch`, `cross_site`, `content_type_invalid`, and
`method_not_allowed`. Earlier gateway origin rejection is
`matching_origin_required`. Aborted responses have status `0` and
`request_aborted`; unknown upstream responses remain `unknown`.

No request bodies, destination URLs, query strings, headers, account identifiers,
or exception messages are logged. Successful requests are not logged. Requests
rejected by an external proxy before reaching this gateway require that proxy's
logs; they will not carry this gateway's request ID. Existing log rotation applies.

Notification writes accept an authenticated human's HTTP or HTTPS `Origin` when it
exactly matches the request `Host` (including the port), or the identity provider's
explicit HTTP/HTTPS trusted origin. This follows Actor/IM same-origin writes even when a
provider omits the optional `trustedOrigin` capability or TLS terminates at the
trusted ingress. The accepted browser origin is saved for notification links.
HTTP is supported for reverse proxies and local deployments. Forwarded headers
do not establish origin authority. Missing or non-HTTP(S) origins, cross-site
requests and non-JSON writes remain rejected.

## Connection-owned Turn notification methods

An optional ChannelSync transport `notifications` port contributes verified personal
targets and a sender through the existing IM notification/outbox path. Core knows
only optional `methodId` / `methodLabel` metadata, not a product identity or API.
The Settings add menu displays named contributed methods alongside Bark/Webhook
and the existing connected-IM selector. The dialog scopes options to that method;
server-selected metadata is retained for saved/reconnect rows. No migration or
new queue is needed. The provider rechecks recipient ownership immediately before
its send; unknown outcomes are not replayed. Product ports must not return groups,
credentials or arbitrary user-entered recipients.
