# LightVela Hermes extension

Trusted OpenCraft extension that signs in to LightVela, discovers running Bot
instances, reaches each Bot's loopback Hermes dashboard through Tencent TAT,
and presents the result as a normal OpenCraft AppServer Host.

Each physical instance remains one Host. Its provider binds the control-plane
`GET /v1/instances/{instanceId}/bots` catalog to native `profiles.list`, mapping
the public root profile `main` to native `default`. Display names never route
requests. The client reuses the typed `vela/bot-conversations` extension and
existing Bot View; conversation/execution ownership is isolated by profile.

Production capability negotiation includes Bot management through the existing
instance-scoped control-plane API. `bot/create` without a template creates a blank
Bot; `templateId` selects an exact source Bot for cloning. Rename preserves IDs;
the default Bot cannot be deleted separately. Missing endpoint/method support omits
the Bot extension without inventing a default Bot. Authentication and network
failures are not interpreted as an empty catalog. The legacy explicit
`enableBotConversations` fixture opt-in remains runtime-only compatibility,
not the production control-plane management path. A Host-owned mutation port
retains create command receipts across bridge replacement; unknown POST outcomes
are not automatically retried. CTL has no cross-client revision/CAS API: the
adapter checks a fresh semantic revision and serializes this Host's writes, but
does not claim a server-side cross-client transaction.

See [implementation and verification](../../design/hermes-profile-bots/task_plan.md).

The copied transport and protocol implementation is derived from the
`mychat` reference repository. The prototype page, global DOM wiring, and CSS
are intentionally not copied: OpenCraft owns application chrome and rendering.
