# Personal assistant authority and Host integration

A Human explicitly claims a personal assistant on a selected installation. `get`,
login, registration and catalog reads never create one. The Server owns the claim;
a Renderer does not own the Bot, memory, engine process or credential. Concurrent
claims converge through the existing storage Worker transaction and unique Human
key. This phase accepts no project owner or caller-supplied Human identity.

## One model across deployments

Desktop local rendering, a remote client of that desktop, and headless consume the
same Actor, Collaboration, native Channels and personal-assistant contract.
Desktop Main owns and migrates its installation at `human-account`; its Daemon
borrows the existing WAL store and must not initialize or import another copy.
The native Main-held Human session authenticates Daemon submissions. Headless
retains its installation owner. Transport does not decide identity or permissions.
A desktop connected to a remote installation claims there, not implicitly locally.

The personal-assistant relation records stable `botId`, Session Actor, Human,
assignment, revocation epoch and active Host credential. It is not a replacement
for the Actor registry, native group membership, conversation ownership or a new
execution scheduler. `createdBy` remains provenance, not authorization.

## Public protocol

The existing Channels AppServer advertises `opencraft/personal-assistant` version 1.
Both native and Web transports call `Collaboration.personalAssistant` with an
already authenticated context. Public suffixes:

- `get`, `claim`, `revoke`, `retry`, `open`: Human self-service only; no parameters.
- `authorize`: Bot-only bounded lease with authoritative immutable binding.
- `groups/list`, `groups/history`, `groups/search`: group-only delegated reads.
- `conversations/list`, `conversations/history`: current visible conversation
  discovery and bounded history; existing engine capability restrictions apply.

HTTP uses POST `/__opencraft_actors/collaboration/personal-assistant/<suffix>` with
the existing authentication/CSRF checks. GET at `.../personal-assistant` only reads
claim status. Neither transport returns Host credentials to the claimant.

Bot identity remains the caller. A narrow internal read projection uses the owner's
current group membership and conversation permissions, not Bot group membership.
It cannot send, mark read, change members, grant access or start execution. Reads
revalidate delegation and permissions after asynchronous work. Group delivery
checks membership epochs, including removal followed by rejoin. Audit records
acting Bot, represented Human, delegation epoch and source references, not content.
Historical shared conversations retain the existing visibility rule.

## Activation and persistence

After explicit claim, a trusted Host calls `provisionPersonalAssistant(humanContext)`.
This issues the Bot's credential through the existing Worker. Issuance replaces
its active delegated-reader credential; revoke and reclaim clear that binding.
Old credentials cannot revive delegated access after reclaim. Raw credentials
stay in the trusted Host/runtime channel, never in profile JSON or model input.
Resource claim is not a declaration that a model or runtime has started.

The independent Butler runtime consumes `platformAssistantPort({request})` for a
trusted native/IPC adapter or `httpPlatformAssistantPort({origin,token})` for HTTP.
`startPersonalAssistant({serverDirectory,port,profileOptions})` verifies authority
before provisioning `<serverData>/bots/<botId>`, then starts the existing runner.
Memory, SQLite business state and `engines/` survive turns, UI closure and ordinary
process restarts. Only one profile writer owns mutation. No native group history
is copied into a second authoritative store. Querying itself does not write memory;
subsequent learning remains subject to the existing MemoryService/source policy.

## Host and claim UI

The Everyone entry lists admitted Humans and enabled Bots without granting new
message permissions. Claim, open and disable are explicit actions. Mounting the
page only reads state. Native private chat is reused; its history remains owned
by Channels. Human avatars currently use initials; Bot avatars use shared SVG
companion artwork with identity-derived, versioned shape and colour selection.

Both Desktop Daemon and headless wire the same installation Host. A filesystem
lease prevents duplicate supervisors; each Bot retains its existing profile lock.
The Host reconciles claimed assignments, issues/renews credentials privately,
limits concurrent workers (default 8) and retries failed starts with bounded
backoff. Revoke stops the worker, not its persisted memory or engine directory.
The delegated read port remains read-only. Separate private IPC methods allow
only the claimed Bot/owner direct-message pair; they are not model tools.
Incoming native sequence cursors are committed after durable intake; stable
message IDs deduplicate outbound delivery and replay after restart.

The claimed Human selects a model in Agents → My Agents. Core
owns only the provider/model reference and a compare-and-swap revision in the
existing personal_assistants row. The request carries no Human ID, endpoint or
key. Claim/revoke epochs fence late saves; refreshing or reclaiming retains the
selection. Reading the directory never claims or selects a model.

Both hosts inject the existing Model Services repository and credential resolver.
The selector lists enabled Responses chat models with a usable explicit
connection and credentials, filtered by the installation model-usage policy.
It does not infer protocol from a model name, borrow a signed-in Human's native
credentials or silently fall back to another model. Empty lists direct the user
to have Model Services configured and then refresh. No endpoint/key editor or
second model catalogue is introduced in the assistant UI. Codex must be installed;
compatibility filtering does not establish paid-provider availability or quality.

Only the private Host/worker IPC resolves a selected reference to credentials.
Resolution rechecks the delegation and model policy; native startup and each
turn admission resolve again. Keys exist in worker/process memory, not Bot
profiles or native shell snapshots. Connection/key changes during an existing
native session reject its next turn instead of continuing with stale credentials.
A disabled/deleted model stops its worker but retains selection and Bot files;
repair resumes it. A different model selection drains and restarts the worker
under the existing profile lock, projecting Core's reference into runtime config.
The original profile.json is not a second writable selection authority.

New native executions bind the selected provider/model at their first admission.
Already-bound executions resume that original reference/thread after selection
changes; queued work without a native binding uses the current selection. The
original provider must remain enabled and authorized. No native checkpoint is
migrated between engines, and legacy endpoint bindings still require their
original configuration. Selection changes do not erase memory, tasks or engines/.

For installations without a user selection, the existing explicit operator file
`<installationData>/personal-assistant.json` remains supported: Codex adapter
configuration, optional backgroundCodex, maxRuntimes (1–64) and timeZone. Managed
selection takes precedence and uses one Codex model for the hosted roles; it
retains the configured capacity/time zone. Legacy adapter credentials retain
the private key-file contract. No model is chosen automatically on claim.

The native transport currently supports text and question prompts. Attachments,
secret requests and authorization requests fail explicitly rather than claiming
delivery without a suitable UI/secure transport. Worker startup and shutdown have
bounded deadlines. Physical Desktop, paid-model availability and production
activation require separate verification.

Source validation covers Core authorization, worker restart/revocation/lease,
real native-chat intake/reply and actual Workbench desktop/touch light/dark
claim and model-selection flows. Real Codex/Worker integration uses a deterministic
local Responses endpoint; UI execution is a fixture, not a paid model.
This source change is not a deployed release.

The runtime is maintained in `apps/personal-assistant` (`@opencraft/personal-assistant`).
Its package export provides `startPersonalAssistant`, and `./platform-port` provides
native and HTTP adapters. It shares the workspace dependency lock while retaining
an independent CLI. `SOURCE.json` records the one-time import from committed lab
source; there is no ongoing dual-source synchronization.

Run `npm run test:personal-assistant` from the repository root for the runtime and
real Core HTTP bridge checks. Source integration, package build, deployment and
activation remain separate steps; importing the runtime alone does not start an unattended supervisor.

## Agents directory and hiring

`opencraft.im.agents` is the unified `AssistantActor` (`session://`) directory and
management route; Inbox remains the message entry. Built-in presets (`BUILTIN_ASSISTANT_PRESETS`)
model the default personal assistant as `presetId: "personal-assistant"` with
`cardinality: "singleton-per-human"`. Hiring dispatches `personal-assistant/bots/create`
with `{ presetId: "personal-assistant", clientRequestId }` (converging idempotently
with legacy `personal-assistant/claim` onto the same single resource per Human).
Once hired, the singleton preset and any custom `cardinality: "multi"` assistants
share the same `AssistantActor` lifecycle state machine (`bots/list`, `bots/pause`,
`bots/update`), execution environment binding (`local` or registered sandbox templates),
model selection (`models`, `model/set`), private memory (`memory`), delegated task
profiles (`threads/*`), and direct-chat opening (`open` with `{ botId }`).

“My assistants” consumes a single `bots/list` replica scoped to the current
`ActorContext`, eliminating duplicate `personal-assistant/get` + `bots/list` polling.
The people directory and group invitation candidates exclude other Humans'
private personal assistants on the server, before they reach the UI. Existing
group-member visibility and authorized communication are unchanged. The same
extension/authority contracts apply to desktop-hosted and headless installations.
