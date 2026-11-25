# A2A server plugin

Expose an explicitly selected OpenCraft conversation through A2A 0.3.0
JSON-RPC. The plugin provides Agent Card discovery, `message/send` and
`tasks/get`. An optional Relay adapter forwards these two HTTP paths to one
configured Hub service.

This is a trusted server-side plugin selected by startup composition, like
the existing channel adapters. Installing the workspace does not open a
listener, issue a credential or enable a route.

## Gateway

Use a dedicated Codex conversation created through the authenticated
`thread/start` API with `historyMode: "paginated"`. The current native runtime
provides bounded Turn/Item pages for that history format. Existing legacy-format
histories cannot supply completion artifacts through this interface.

Create a dedicated Session Actor through existing Actor management. Add it to
the conversation's Server space and explicitly grant `conversation.read`,
`message.send` and `execution.queue` on that conversation. Issue a limited
lifetime credential and give it to the client through its credential settings.
Keep the token out of prompts, URLs and the public Agent Card.

Pass this composition to `startHeadlessServer(options, composition)` or
`startContainerGateway(composition)`:

```ts
import { createA2aPlugin, parseA2aConfiguration } from '@opencraft/plugin-a2a/server';

// Load the operator-owned binding through private installation configuration.
const configuration = parseA2aConfiguration({
  origin: 'https://agent.example.com',
  actorId: 'session://AUTHORITY_UUID/ACTOR_UUID',
  conversation: 'opencraft://conversation/v1/SERVER_ID/THREAD_ID',
  name: 'My agent',
  description: 'Send text requests to my agent.',
  version: '1.0.0',
});
const composition = {
  createServiceIngress: ports => createA2aPlugin(configuration, ports),
};
```

Replace placeholders with actual management API results. The parser validates
the Session identity and canonical conversation reference. `origin` must be a
canonical HTTPS origin. The name, description and version default to generic
OpenCraft metadata.

The core's opt-in service ingress runs before browser admission. Every send
and task read authenticates the configured Actor's bearer on the storage Worker
and checks current installation membership, space membership and all three
resource grants. Native completion observation is followed by another
authorization check before returning output.

The existing collaboration owner stores the input, task identity and
idempotency key. Only completion evidence for the exact input-associated Turn
can mark a task completed; queue acceptance alone is `submitted` or `working`.
Hosts without that evidence leave the outcome unconfirmed. A reply is bounded
by the native completion projection; `artifacts[].metadata.truncated` signals
truncation. The plugin creates no execution queue or task database.

Codex conversations support completion artifacts through both the provider
bridge and the legacy Host. Native Pi/DSH input adapters currently expose queue
state without a completion projection, so they cannot confirm a completed A2A
reply.

## Relay

If a Relay fronts the installation, add the exported adapter to its existing
`createIngress` composition and close it with the other ingress resources:

```ts
import { createA2aRelayIngress, parseA2aRelayTarget } from '@opencraft/plugin-a2a/relay';

const target = parseA2aRelayTarget({
  origin: 'https://agent.example.com',
  gatewayOrigin: 'https://gateway.example.com',
  hubId: 'hub-<registered Gateway Hub ID>',
});
const ingress = createA2aRelayIngress(target, openHubStream);
// Delegate to ingress(request, response), then await ingress.close() on shutdown.
```

The placeholders must name a registered service. `gatewayOrigin` defaults to
`origin`. The Relay matches the public Host and exact Card/RPC paths, and opens
only the configured Hub target. It forwards the Actor bearer and JSON body
without browser cookies or forwarded identity headers. Body sizes, concurrency
and timeouts are bounded. The deployment supplies its normal HTTPS listener
and Hub registration.

## Client requests

Read `https://agent.example.com/.well-known/agent-card.json` with GET or HEAD.
The public Card contains no Actor or conversation identifiers. Call its `url`
with `Authorization: Bearer <Actor Session token>` and JSON content type:

```json
{
  "jsonrpc": "2.0",
  "id": "request-1",
  "method": "message/send",
  "params": {
    "configuration": { "blocking": false },
    "message": {
      "kind": "message",
      "role": "user",
      "messageId": "stable-client-message-1",
      "parts": [{ "kind": "text", "text": "Please review the test results." }]
    }
  }
}
```

Poll `tasks/get` with `params: {"id":"<Task ID>"}`. Reuse the same `messageId`
and content when retrying a send. Durable deduplication survives Gateway
restarts; changed content under that ID is a conflict. A credential cannot read
another Actor's tasks. The context ID identifies the configured channel and
conversation; it cannot select a different resource.

By default a send observes progress for up to eight seconds. Set
`blocking:false` to return immediately. An explicit `blocking:true` request
exceeding that budget returns error `-32010` with `error.data.taskId`, so the
client can poll without submitting another input. Disconnection stops waiting;
an already committed input remains owned by the core.

Current scope is one configured Actor/conversation, text messages and polling.
Streaming, push notifications, attachments, task continuation and cancellation
are unavailable. `tasks/cancel` verifies task access and returns the standard
TaskNotCancelable error. Revoking the credential, a required grant or space
membership blocks subsequent calls. Removing the composition closes the entry
and leaves previously accepted work with the core. Use a dedicated conversation
for each integration needing separate history or execution policy.

## Verification

```sh
npm run typecheck --workspace @opencraft/plugin-a2a
npm test --workspace @opencraft/plugin-a2a
```

Tests use real Relay forwarding, Gateway routing, Actor credentials,
space/grant checks, owner Worker calls and a temporary managed database. Native
completion evidence is synthetic. These tests do not establish live model
execution, production deployment or compatibility with a particular external
A2A client.

Protocol reference: [A2A 0.3.0 specification](https://a2a-protocol.org/v0.3.0/specification/).
