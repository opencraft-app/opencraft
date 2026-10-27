# Built-in MCP App builder

the managed site's Headless gateway owns the built-in App definition service. The existing
Web client host renders its self-contained HTML in an opaque-origin sandbox;
the native Codex and DSH execution engines keep owning conversation history.
App definitions are not another conversation history or business database.

## User workflow

In a new managed site conversation, ask the AI to create an interactive App, for example:
“创建一个 MCP App，输入单价和数量计算总价，发布后在当前会话打开。”
The built-in `opencraft_apps.manage` tool loads precise authoring guidance with
`help`, reads `list`/`get`, validates a complete serialized App spec, then publishes
and opens it. `openBuilder` opens the management UI in the conversation.

Existing DSH conversations acquire the tool through their existing capability
registration boundary. Native Codex conversations retain their original dynamic
tool declarations; an older native conversation needs a new conversation to
acquire the newly introduced tool. Remote SSH Hosts and older servers do not
advertise this service and are not given its tool declaration. This release
implements the Headless managed site service, not a new desktop/native App builder.

## Ownership and protocol

`packages/mcp-apps` owns management, validation, release storage and execution.
Only admitted gateway connections receive a trusted `resourceOwner` context.
The owner is the existing verified Actor; installations without authentication
use their explicit shared anonymous workspace. RPC arguments never select an
owner. The native local Host transport and the DSH `/appserver` proxy decorate
the same typed MCP tool/resource methods. External native MCP inventory is
preserved; DSH's unsupported inventory response gains the built-in inventory.
The service is exposed through AppServer, not a separately public HTTP MCP endpoint.

`opencraft/mcp-app-builder` version 1 is advertised only by the actual service.
The client adds the authoring tool only after this capability is present. The
runtime preserves existing connection/lease/generation cancellation. A delayed
validation rechecks authority before commit; a delayed tool result rechecks the
active release. Writes have no automatic retries. Client disappearance revokes
pending replies; it does not recreate a request or roll back an admitted commit.

A successful `open` result carries an owned resource envelope in the existing
dynamic-tool result. Native namespace `opencraft_apps/manage` and the DSH
projection `deepseek-harness/opencraft_apps__manage` use the same chat projector.
Only that exact tool identity can request inline rendering; the gateway still
checks owner/server/resource for every operation. Restoring history preserves
that envelope through the existing engine history. No new history store exists.

## Historical card compatibility

Management, drafts and mutation versions stay private to the creating Actor.
An admitted viewer can run an exact published card after the gateway observes
its successful builder result in that connection's engine-owned conversation
history or completed item event. Evidence is scoped to the thread, server and
full resource URI, bounded in memory and discarded on disconnect. It is not
accepted from user text, RPC arguments or arbitrary tool output. Native/DSH
history, resume initial pages and later turn/item pages use the same rule.

Existing schema-1 definitions, server names, revision numbers and resource URIs
remain unchanged; no ownership rewrite, republishing or history migration is
required. Existing owner-only calls keep working. New clients include the card
URI in optional tool metadata to distinguish equal App IDs/revisions owned by
different Actors. Legacy calls without that metadata work when unambiguous;
ambiguous calls fail rather than execute another card's code. Runtime inventory
includes only active releases evidenced in that requested thread, alongside the
viewer's own Apps. Access to a card never grants listing/getting its private
definition or using builder management as its creator.

History evidence cannot revive an unpublished, deleted or replaced release.
Every resource/tool access checks the creator's current active revision, and
worker completion rechecks revocation. Reconnection reacquires evidence from
the canonical history; browser display caches never authorize access. If a cached
built-in card is restored before that read completes, its first failed resource
read shares one canonical thread hydration per view owner and retries the
resource once. Gateway-observed history still determines access. External App
resources, tool invocations and chat messages do not acquire automatic retries.

## Persistence and versions

`mcp-apps.sqlite` is gateway-owned and opens through the managed SQLite owner
contract. Health reports its outcome. Each owner/App pair has one draft, a CAS
`version`, an active release and a monotonic next release number. `saveDraft`
does not change the active release. `publish` validates before one transaction
stores and activates an immutable release. Every mutation requires the version
just read; concurrent or ambiguously acknowledged writes require a read/reconcile.

Resources are content-addressed HTML under
`ui://opencraft/apps/<owner-hash>/<app-id>/sha256-<digest>.html`.
Each runtime server also pins the release number. Backend-only edits can retain
the same resource URI while changing the server revision. Rollback changes only
the active pointer. Unpublish revokes tool/resource access while retaining drafts
and releases. Delete removes HTML/code/releases and leaves a minimal identity,
version and next-revision fence: recreating the ID cannot rebind an old iframe
to new code. `get` exposes that fence for explicit recreation. Restart restores
published definitions without loading all Apps or executing generated code.

Limits: 64 non-deleted Apps, 256 lifetime IDs, 64 release numbers per App and
16 MiB total definition text per owner; 650 KB input spec, 512 KB HTML, 16 tools.
Lists are bounded and include compact titles/descriptions; get with revision reads the exact immutable spec. These are definition limits, not a durable business-data API.

Local HTML forms may dispatch validated submit events inside the opaque sandbox.
The iframe allows forms so existing `submit` listeners and Enter submission work;
CSP still sets `form-action 'none'`, so a form cannot post to the network or
navigate the iframe through a submission. Generated forms should prevent the
browser default and use the narrow App bridge for the requested action.

## Generated code and UI

Handlers run synchronously in a fresh QuickJS WASM realm in a separate worker,
with no Node, files, network, host callbacks or secrets. Runtime memory is 16 MiB,
stack 256 KiB, guest execution budget 100 ms, total worker lifetime 3 seconds,
output 128 KiB, and global worker concurrency four. The runtime closure is pinned
and packaged independently; only the release/sync variant is shipped. No WASM is
loaded on gateway startup or into the renderer. Infinite loops, async return
values, memory exhaustion and oversize output fail explicitly. JSON Schema is a
bounded local subset without remote references or regex; inputs and declared
outputs are checked. Generated code cannot persist business data or call an
external integration implicitly. View state uses the existing widget state; real
business services need a separately authorized integration.

The management UI uses bounded widget state to retain small unsaved edits across
iframe disposal. Large definitions require explicit Save Draft before leaving;
the UI explains this rather than silently exceeding the existing 32 KiB state
budget. Deletion uses an in-frame confirmation dialog, compatible with the
opaque sandbox. The management UI and generated HTML have no external script/resource grants.
The current client host retains foreground/viewport lazy loading and background
frame disposal. No new polling or subscriptions run while Apps are closed.
Explicit widget data stays in Application memory across virtualized row disposal
and connection-lease replacement, scoped to the Host, Thread, source block, server,
resource URI and call ID. The App must restore its controls from that bounded JSON;
arbitrary DOM and unsaved inputs are not captured. Active authority is checked
again by the original owner and bridge. Data recovery neither executes an operation
nor grants access, and an Application reload ends this view checkpoint.
The host also retains an explicit Pause choice in that scope. Recycling a row or
replacing a connection does not reload a paused App; only the user choosing Open
resumes it. App-authored widget JSON cannot alter this host control.
Changing server, resource URI, call or source block disposes the old document and
bridge before reading the new resource. Its error, token and navigation-load count
start independently; late old resources cannot revive it. Display-name changes
update the label without reloading the App.
The builder UI is an explicit management resource, not a startup page.

## Visual authoring in the conversation

The [OpenCraft design entry](../design.md) routes repository agents to the existing
design language and token owners. Choose Settings composition for configuration
rows, Chat for input/result reading, or Sidebar for compact grouped choices. Adapt
the pattern to the inline frame and retain the App's own domain state. Builder
`help` includes this selection rule without requiring repository access. Token
references do not make those variables available inside an isolated App.

Generated Apps are tools embedded in an existing conversation, whose host already
provides a border, rounded frame, title and open/close action. Prefer a compact
content-first composition. A fruit picker needs two clear choices, quantity and
one send action; a calculator needs aligned inputs and a prominent result. Neither
needs a hero, repeated page title, nested white card or promotional copy.

Use a deliberate hierarchy, consistent spacing, aligned labels and a restrained
neutral palette with one purposeful accent. Avoid default gradients, large shadows,
oversized emoji, decorative badges and making every label bold. Emoji can identify
a fruit alongside a text label. Do not make all Apps identical: let the user's task
and requested visual direction determine the composition. For an explicitly playful
App, expressive color and illustration are appropriate when they support the task.

The Workbench [typography contract](../design/ui/typography.md) favors regular
reading/control text and modest emphasis, and the [design language](workbench-design-language.md)
keeps surfaces calm. The sandbox does not inherit these CSS tokens, bundled fonts,
React components or icon libraries. Generated HTML therefore uses a self-contained
system/CJK font stack, native semantic controls and local semantic CSS variables;
never invent a host token bridge or rely on CDN scripts/fonts. An example palette
is a starting point, not a second platform token registry:

```css
:root {
  color-scheme: light;
  --surface: #ffffff; --text: #242424; --muted: #636363;
  --border: #d6d6d6; --accent: #245d42; --selected: #edf5ef;
  --focus: #555555;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface: #202020; --text: #eeeeee; --muted: #b5b5b5;
  --border: #555555; --accent: #9ed8b6; --selected: #283b30;
  --focus: #b5b5b5;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--surface);
  color: var(--text); font: 14px/1.5 system-ui, "PingFang SC",
  "Microsoft YaHei", sans-serif; }
button, input, select, textarea { font: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
```

Read the actual host theme initially and on changes; do not remount the form or
send a message in response to theme updates. The current compatibility API exposes
`theme` and `openai:set_globals`, not `styles.variables`:

```js
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(theme) {
  document.documentElement.dataset.theme =
    theme === "dark" || theme === "light" ? theme :
    systemTheme.matches ? "dark" : "light";
}
applyTheme(window.openai?.theme);
window.addEventListener("openai:set_globals", event => {
  const theme = event.detail?.globals?.theme;
  if (theme !== undefined) applyTheme(theme);
});
systemTheme.addEventListener("change", () => applyTheme(window.openai?.theme));
```

Use the current container width and natural content height. Avoid fixed page widths,
viewport-height layouts and nested scrolling in a small form: the host measures the
content and limits the inline frame to 1600px. Check at 320px and a wider chat pane,
with long labels and large values; do not solve overflow by shrinking essential text.
Provide comfortable touch targets, explicit labels and a visible radio/check/outline
for selection, not color alone. Support keyboard focus, disabled/pending, empty and
error states with adequate contrast. Motion should clarify an action and respect
reduced motion, never run idle decorative animations.

Before declaring a generated App polished, inspect its actual light/dark rendering,
narrow/wide layout, keyboard path and failure/pending states. Check that switching
theme or size preserves input. Spec validation alone cannot establish visual quality.
These authoring rules do not restyle existing published Apps automatically.

## Verification

`npm run test:mcp-apps` covers store versions, CAS, ownership, revocation, worker
limits, managed migration/checksum behavior and a real isolated packaged runtime.
`scripts/smoke/extensions/smoke-mcp-app-builder.ts` builds the production Conversation/host and
runs real WebSocket gateway/Actor/SQLite/QuickJS operations at 390/1280 px;
only the model/engine and proof provider are synthetic. It covers AI tool
requests, validation/publication/open, iframe tool calls, manager UI, rollback
and a separate Actor. This is not a paid model, employee account or iPhone test.
