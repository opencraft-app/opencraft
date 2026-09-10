# Local Agent custom providers

## Ownership

The settings plugin owns an unsaved draft only. All calls go through the selected
AppServer host. `RuntimeProviderService` in local-agent-host is the application
coordinator; it owns no persistent provider database. DSH settings owns provider
profiles, revisions and validation; DSH credentials owns secret values; the
runtime LLM registry owns the effective model catalog. Renderer unmount or
WebSocket disconnect does not cancel a submitted provider application command.

The bundled pi-ai adapter supports `openai-completions` and `openai-responses`.
These are API wire formats, not authentication mechanisms or a guarantee that
every provider implements every model capability. Codex OAuth remains separate.

## AppServer surface

- `runtime/providers/list`: directory and host-supplied creation capabilities
  (`kind`, supported `apis`, namespace `revision`). Existing providers advertise
  editable model/protocol capabilities. The UI does not invent a DSH write path.
- `runtime/providers/apply`: create/update a stable provider ID, expected revision,
  endpoint, optional display name/protocol/model declarations, credential intent.
  Host resolves the underlying namespace/path, validates, coordinates credentials,
  and submits a CAS settings mutation.
- `runtime/providers/setEnabled`: revision-checked runtime lifecycle command.
  Disabling retains settings and credentials; enabling changes actual registration.
  The list reports `configured`, `enabled`, and registry `active` separately.
- `runtime/models/discover`: required `source: catalog | endpoint`. Catalog lookup
  strips the draft URL and key. Endpoint discovery requests `<baseURL>/models`,
  preserves deployment prefixes, rejects redirects, and bounds response size/time.
  Only an explicitly supplied draft key is used; stored credentials are never
  implicitly forwarded to a new host. Results are unsaved candidates.
- `runtime/models/list`: effective model registry, not discovery candidates.
- `runtime/settings/mutate`: remains for generic settings such as default model;
  provider saves from this UI no longer use it directly.

Credential intents: keep (endpoint changes require explicit reuse confirmation),
replace (fresh unique secret reference), reference (explicit existing reference),
none (detach via an unbound reference so inherited credentials cannot reappear).
Detaching does not mean unauthenticated inference is supported: DSH rejects a
missing required credential. No shared old secret is overwritten or deleted.

## Commit invariants and limits

1. Provider identity is distinct from display name and model ID. New providers
   cannot overwrite an existing directory entry. Duplicate/stale writes reject.
2. Settings updates modify addressed fields, not a copy of all effective defaults.
3. New credentials are staged under unique references. A rejected save cannot
   change the secret used by an existing session/provider.
4. Lost acknowledgement is not rejection. Host reads authoritative settings and
   recognizes committed operations. Even DSH `settings-rejected` can follow a
   successful persistence step when a commit listener throws.
5. Cleanup occurs only after a CAS conflict or a definitive rejection plus an
   unchanged authoritative revision. Unknown outcomes retain the staged secret
   and return `provider-save-uncertain`; no automatic resubmission or deletion.
6. There is no cross-store atomic transaction or durable application journal.
   A process crash between credential staging and settings commit can leave an
   unreferenced credential. It must not be collected without checking ownership.
   This implementation does not claim crash-safe automatic orphan collection.
7. `saved: true` means config persisted, not registration/inference/network success.
   Saving a provider does not alter default model or existing session selections.
   Changing a route affects later requests that resolve that route; in-flight
   or whole-run configuration pinning is not introduced by this change.

## Verification

- `npx tsx --test tests/runtime-provider-service.test.ts tests/local-agent-host.test.ts`
- `npm run smoke:local-agent`: actual bundled DSH, isolated data, authenticated
  WebSocket, both protocol registrations, restart persistence, unchanged defaults.
- `npx tsx scripts/smoke-local-agent-settings.ts`: real plugin UI in Chromium,
  real AppServer/DSH, isolated `/models` fixture; creation/discovery/selection/save.
  Requires Playwright and Chromium. `OPENCRAFT_PLAYWRIGHT_MODULE` and
  `OPENCRAFT_CHROMIUM_EXECUTABLE` may point at existing installations.

Tests use synthetic credentials and make no paid or external inference request.

## Settings layout and provider lifecycle

Model management separates catalog definition from selection policy. Runtime-owned
`llm-pi-ai.modelSelection` records disabled model IDs per provider (including native
providers); it does not erase the adapter catalog or existing session bindings.
`runtime/models/list` and `model/list` exclude disabled entries; the management UI
requests `includeDisabled: true` and receives source/enabled metadata.
`runtime/models/setEnabled` and `runtime/models/delete` take provider, model and
the llm-pi-ai namespace revision. Delete is only for custom definitions, preserves
credentials/history, and requires disabling a provider before deleting its last
model. Built-in definitions cannot be deleted. Existing sessions may continue
their currently bound disabled model, but cannot newly select a disabled model.
The AppServer adapter serializes model/provider/default-setting writes and rejects
disabling/deleting the default or selecting a disabled default. Generic AppServer
mutations of llm-pi-ai must use the domain commands instead. Direct external DSH
writers are outside that adapter queue; this is not a cross-process transaction.

The settings shell provides document and master-detail layouts. The plugin contributes
`Default model` and `Model services` pages under Local Agent. Provider navigation and
the detail body use shared scroll surfaces, not a plugin-owned application shell.
Default-model edits and connection edits are independent drafts. Dirty connection
drafts retain their original namespace revision across refresh; stale writes cannot
silently acquire the latest revision. Switching connections asks before discarding.
Existing-provider edit sessions belong to the settings service, not the pane.
They survive pane resizing and view reattachment while that service is alive.
Explicit discard removes the edit session; service disposal releases all sessions.
Drafts (including newly typed credentials) are memory-only, not durably saved.
Creation and default-model forms currently retain component-local drafts.

Provider list, provider detail (addressed by providerId), and creation are independent
page components. The panel composer supplies identified pages to `AdaptivePanelView`;
the list is the primary page and the selected detail/create page is secondary.
An initially selected detail has the same identity when entered in compact mode.
Unknown provider IDs show an unavailable page,
never another provider's form. List search belongs to the list page; edit drafts
belong to the service. The old `SettingsMasterDetail` component was removed.

Provider panels use `AdaptivePanel`: selected secondary page and compact active
page are independent state. `projectPanel` takes container width, never device type
or an application route. Back only focuses the list; it does not discard, unmount,
or deselect the secondary page, even with an unsaved draft. Reopening that page
resumes it. Switching to another page retains the pending/dirty guard; explicit
creation cancellation closes the page. Resizing never mutates panel state.
At the combined page minimum widths both pages are shown; otherwise the active
page occupies the panel. Web keeps the same editor subtree when visibility changes.
Each visible pane owns its scroll. No Settings route is pushed by this panel.
The Web settings shell (connected and hostless) also projects its category rail:
below the category + content width budget, it yields the full viewport to content.
The lightweight Settings link opens the category index without unmounting content.
Category width is shell-owned and does not overwrite conversation sidebar preferences.
The Expo native `AdaptivePanelView` measures with `onLayout` and consumes the same
state/projection, including internal Back and hidden-page retention. Its old
path-based adapter has been removed. Actual native provider forms/settings entry
are not integrated yet; this change does not claim that whole Expo feature is shipped.

Custom connections are created disabled, including incomplete connections. Installed
adapter activation preserves its native protocol/catalog instead of treating every
adapter as OpenAI-compatible. Installed adapters are not cloneable presets in this
implementation. Multiple custom connections have independent stable route IDs.

`scripts/patch-dsh-provider-lifecycle.mjs` adds enabled-state support to the pinned
DSH pi-ai adapter during runtime preparation. It changes the same settings schema,
route resolver and configurable-provider directory; no parallel database is added.
Exact anchors fail closed when the upstream artifact changes. Disabled routes are
excluded from runtime resolution but remain in the directory for editing.

The host prevents disabling the current default using an authoritative read, but
this is not an atomic transaction across the provider and default-model namespaces.
Concurrent generic settings writes are not globally serialized by this command.
Unauthenticated inference, interactive OAuth, multi-endpoint failover and durable
draft recovery are not introduced by this UI change.
