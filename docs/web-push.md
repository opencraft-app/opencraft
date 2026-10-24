# Apple Home Screen response notifications

The secure iOS/iPadOS Home Screen workbench can opt into server-driven response
notifications in Settings → Chat. Permission is requested only from the explicit
switch action. The test action reports acceptance by the push service, not proof
that the OS displayed a notification. This is separate from the existing
page-online notification preference. An enabled server subscription suppresses
the online notification path for the same managed Host to prevent duplicate alerts.

## Owners and identity

PwaRuntime owns ApplePwaPushDevice through PushDevicePort. Application-owned
PwaTurnPushController binds the browser subscription to the authenticated server
Actor and supplies translated notification templates from the existing IntlRuntime.
TurnPushService and PushStore belong to the Headless server, independently of
React, document visibility and renderer websocket leases. PushObservationTransport
observes trusted TransportSubmissionContext at the physical gateway boundary;
no actor identity is decoded from a submitted RPC body.

Device consent is scoped to the deployment origin, human Actor and browser
subscription. A device rebind gets a new binding ID; old queued deliveries cannot
cross accounts. Mutations require current human authentication and matching
trusted HTTPS origin. The public API exposes the VAPID public key only. The VAPID
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
