# ChatUI: Files and resources

[Architecture index](../../chat-ui-architecture.md) · [Documentation index](../../README.md)

### Changed-file review

The Turn's existing unified diff remains the read authority for its changed-file summary. ChatUI renders a lightweight in-progress entry and a completed resource card; it only emits an open intent. In the Web Workbench, the actual Composer owns the active Turn's live entry above the editor, including when that Composer floats over a panel. The live entry is a compact, content-width pill centered above the Composer with a visible gap, independent of the attached queue/goal rail and its material. The same placement remains when approval replaces the editor. Its exact Turn identity suppresses duplicate live resources in the main and mini transcript; it is presentation routing, not a second execution or resource owner. Standalone Conversation consumers retain inline presentation. On completion, the same resource appears as the transcript's completed card. The Workbench owns the read-only Review dialog, keeps it tied to the active Thread, and projects the current Timeline block while streaming. File selection filters that existing diff for display; it does not create a second TurnDiff model or mutate the workspace. Undo/Reapply is not advertised until a real Host apply-patch capability is connected.

The Web resource presentation uses a square-plus-minus glyph in a 40px
slot, 12px header padding, 10px gaps and theme-owned `radius-lg` (10px in the
default theme). The title uses chat typography; both signed counts are shown,
including zero, in chat-minus-one typography with tabular digits and 4px gaps.
Running counters retain columns and animate their transform, with reduced-motion
support. The digit viewport, each track cell and translation step use the same
inherited line-height (`1lh`), rather than font-size (`1em`), so a resting glyph
is never clipped by a taller chat line box. Interrupted updates settle on the
latest value; no timer or animation completion event owns the count. Completed multi-file cards show three 36px rows by default and an
explicit expanded state; disclosure reflow belongs to the viewport owner.
The shared outline toolbar Button emits “View changes”. Desktop hover offers
an interactive live file list or a bounded small-file diff preview after 800ms;
more than 5000 rendered/change lines bypass inline preview. File clicks close
the live list before opening Review. Modifier-click opens a file only when a
real resource opener exists. Touch does not force hover copy or browser rings.
Diff sections are indexed once per completed resource revision, not reparsed
for every filename. These are Web adapter details; Native preserves its own
touch surfaces while sharing the Turn resource and Review intent.

The shared summary consumes actual Git paths: unquoted spaces and C-quoted
UTF-8 bytes resolve to repository file identity, including extended rename/copy
metadata without removing a real `a/` or `b/` directory. Binary and mode-only
sections remain zero-count files. Inside a hunk, lines beginning `+++` or `---`
are changed code; only pre-hunk file headers are metadata. Repeated paths retain
first-observed order and aggregate counts. Review indexes the same decoded paths;
the original unified diff remains unchanged. The shared review-line parser
tracks the declared old/new hunk ranges. Within a hunk, `+++` and `---` remain
changed code with source line numbers and intraline highlights. Completing a
hunk or starting another file ends that numbering scope; file metadata and
patch separators never acquire source line numbers or become collapsible
unchanged code. Partial add/delete observations remain readable without
invented line numbers.

The aggregate is a **Turn-owned resource**, not an ordered transcript Item.
`chat-runtime` passes `unifiedDiff` separately from source Items; `chat-core`
projects it as `changeSummary` metadata and the assistant presentation plan's
fixed resource surface. Its stable identity is `${turnId}:turn-diff`, without
source Item anchors. Web and Native render that surface separately from ordered
slots. Arrival, update or removal cannot end an Activity segment, alter its work
clock, qualify a final answer, claim Thinking ownership, or move a response.
The live Review lookup includes this resource; ordinary transcript Blocks are
not a second read authority. A resource-only recovered Turn may have an empty
carrier Frame, never a fabricated message. Inline resource surfaces count toward
the virtualizer's top-level geometry; Composer-routed live resources count toward
footer geometry instead. Neither becomes a latest activity follow anchor.

The Turn resource is read from Frame metadata independently of assistant Items.
A Turn with only user or interaction Frames still materializes an empty assistant
resource surface when it has a change summary. Completed, failed and interrupted
Turns retain their Review entry even when no assistant message was returned;
clearing the canonical resource removes it without inventing transcript content.

Old `turnDiff` Items are lowered at the shared projection boundary and excluded
from transcript/work-status derivation. An explicitly supplied Turn value,
including null, wins over those compatibility Items; a null canonical `diff`
also wins over a stale `unifiedDiff` alias. This is a narrow compatibility path,
not a new generic resource registry or another persistence store. Regression
tests cover running diff updates, later work, saved collapse choices, reload,
final answers, resource clearing and completed Review cards. The browser fixture
uses the real Conversation and Review dialog in desktop/mobile-width light/dark
views; it is not a production deployment or native-device acceptance claim.

Changed-file row geometry belongs to its renderer: line counts retain their intrinsic width while the path consumes the remaining space. The directory yields first to the basename, but the basename is capped at its path slot and truncates when even the filename cannot fit. Neither path segment may paint over the counts. Truncation affects presentation only; the complete path remains the accessible row label and Review target. Regression coverage includes long basenames without directories, deep directories, both counts, narrow containers and expanding/collapsing the file list.

Skill autocomplete treats a bare `$` as catalog browsing, not an empty file
search. The Composer, runtime catalog and Skill search share this policy;
`@` remains query-gated. Skills are scoped to the current Host/root set,
enabled-only and deduplicated by authoritative path. Empty queries retain
source order; typed queries match canonical name, display label and path. Query words and boundary patterns are prepared once per search, while normalized candidate fields are reused across its words; this does not add a cross-request cache or change fuzzy scores, tie ordering, limits or canonical identity.
Discovery errors are rejected before query caching rather than stored as a
successful empty catalog. A Host returning no metadata is not supplemented
with renderer-local or fabricated Skills.

The picker displays loading, unavailable/retry and no-results states, supports
wrapped arrow navigation (and macOS Ctrl-P/N), Enter/Tab insertion and mouse
selection, and never submits while a Skill picker owns Enter. Escape/blur
dismiss the current match without deleting its text; changing the match may
reopen it. Unmatched queries containing whitespace dismiss the picker.
Selected text and code blocks do not activate the picker, and IME
commit does not select or submit. Async results carry catalog, target, query,
retry and controller ownership; stale completions cannot become selectable.
Inserted resources retain canonical Skill name/path through the document
codec and native AppServer UserInput compiler.

`smoke:skill-autocomplete` tests the real ProseMirror Composer with a synthetic
Host catalog in Chromium or isolated Electron. This proves the interaction and
protocol payload, not remote Skill installation or model execution.

Model-response URLs are resources, not page-local anchors. `chat-document`
preserves the model-authored paragraph/heading/list/table structure and raw
Markdown label; `chat-render-react` alone classifies and sanitizes the target;
the Web renderer projects an allowed HTTP(S) target as an inline
mention with origin favicon, globe fallback, URL tooltip and Radix context
actions. It never demotes a heading merely because its child is a link.
Restricted or unsafe targets receive no href, favicon request or open action.

During streaming, a changed URL remains inert for 500ms before it receives an
href or begins remote favicon loading, and the prior href cannot remain active.
Opening is a semantic `ChatResourceOpenIntent` (`target`, `disposition`,
`source`): the Renderer reports ordinary, modifier/middle-click and context-menu
intent while the Workbench Browser owner chooses the physical in-app or external
surface. Copying uses the sanitized target. Favicon pixels, tooltip state and
menu focus are presentation state only and never enter Timeline, Replica or
history. `smoke:url-presentation` verifies the real renderer, heading
preservation, fallback favicon, tooltip, menu, clipboard and delayed streaming
activation in Chromium.

React Native consumes the same list and resource decisions. Ordered Markdown
lists retain their authored start number; task items use checkbox markers.
Both renderers resolve links, workspace references, citations and images through
the same priority-ordered resource policy service. Their standard URL policy
is registered as a fallback, so Host restrictions and rewrites apply before
either platform performs an open or media load. Image-only data URLs remain a
local media exception and do not become navigable links.
On Native, a Host resource denial is final: a denied HTTP(S) link cannot fall
through to the system browser. The system URL opener is only a fallback when no
Host opener owns the action and the resource policy allows the target.
Nested unordered lists use the Web marker progression (disc, circle, square)
and nested spacing; user-message lists keep their compact Composer rhythm.
Tables keep the authored rows and column alignment on both surfaces. Web uses
its dialog to expand a wide table; Native uses a full-screen preview with its
own horizontal and vertical scrolling, sized from the actual container so the
same content works on a phone or tablet. Both keep the original Markdown copy
source available from the inline table.
Web table content uses an intrinsic, non-shrinking width inside its own native
horizontal scrollport. Bounded cells wrap long content without contributing
arbitrary single-character breaks to intrinsic sizing; short tables still fit
their container. Phones, tablet split views and desktop share this rule, based
on available container space rather than device detection. Native touch panning,
trackpad/wheel scrolling and scrollbar dragging retain browser text selection,
link activation and vertical timeline scrolling. Appending rows keeps the same
table and scrollport; no JavaScript pan controller or document-wide overflow is
introduced. `scripts/smoke/resources/smoke-markdown-table-scroll.ts` verifies the real renderer.
Wide blocks use automatic expansion beyond the prose column, bounded
by the current reading surface rather than window width. The timeline supplies
`--chat-wide-content-available-width` and `--wide-block-panel-max-width`; its
viewport already excludes docked panels and accounts for content shift. Tables
and Mermaid consume the same wide-content budget. Without a layout owner, they
remain within the local column. Compact latest-turn previews own a separate
container and cap expansion at their own content width. Narrow conversations use
the same rule, without viewport-media negative margins that can hide table edges.
Supported CSS anchor positioning keeps each table toolbar inside its actual
visible table edge; other browsers retain the container-edge fallback.
`smoke-markdown-wide-layout.ts` checks bounds, expansion, local scrolling and
identity while the available conversation width changes.

Complete Web Mermaid fences lazily load Mermaid and its registered ELK layout
provider together. The default uses ELK, classic/base rendering, the shared UI
font and semantic surface/text/border tokens; it does not add neo node shadows.
Rendering stays strict, serialized and cancellable. After attachment, the
renderer checks actual SVG bounds against its serialized viewBox and repairs a
viewport that excludes graphics before sizing the outer shell. Shell measurement
rounds upward and includes its border. Accessibility-only source is hidden by
renderer-owned CSS rather than requiring the embedding host to supply a utility.
A reserved header keeps preview/copy actions clear of diagram content; touch
controls remain visible with 44px targets. Existing source fallback, stable
loading geometry and reading-surface width limits remain authoritative.
`scripts/smoke/resources/smoke-mermaid-display.ts` checks full SVG bounds, hidden source, toolbar
separation, resizing, source replacement and preview on real WebChatDocument.
Appending prose after a complete fence and finishing the Turn preserve the SVG.
Measurement delivery reads the latest committed document callback and generation
without becoming an input to the diagram's render lifecycle. Source or theme
changes still invalidate the diagram; resize measurements still reach the
current document owner.

Bounds checks measure the actual scrollport, initial resource link and table
actions against the reading surface, and verify the final column is reachable.
Document scroll width alone cannot prove this: a clipped ancestor can hide an
incorrectly positioned scrollport without widening the page.
The labelled scroll region is focusable for keyboard horizontal navigation and
uses the existing neutral keyboard-only focus indicator; touch retains native
selection and does not paint a persistent focus frame.
Native task items use the same compact, read-only checkbox geometry as Web;
ordered markers reserve one shared column width across digit boundaries.
The shared renderer call also carries neighboring node kinds so Native can
apply the Web user-message paragraph rhythm without adding a trailing gap.
It also carries the next document node: Web and Native use one Han-text test
to tighten adjacent root paragraphs, while first/last heading and divider
margins follow the same document-edge rules.
Web image previews share `ZoomableImage` across user attachments, Markdown,
generated images and workspace image resources. The preview owns a transient
0.2–5× transform: two pointers zoom and freely rotate around their midpoint;
one pointer pans against bounds derived from the rotated image and the actual
preview viewport. Shrinking below the fitted size remains available. Lightbox viewports fill the
available screen independently of the fitted image dimensions; zoomed pixels
must be visible outside the initial image rectangle. Embedded workspace resources
retain their panel viewport. Only the image viewport claims touch
gestures, leaving modal close, gallery navigation and focus with their existing
owners. Source changes, reopening and viewport resizing restore the fitted view.
No page zoom, navigation or media reload is required for manipulation.
The preview's whole modal input layer, including empty screen space, excludes
background Shell gestures. Global capture listeners must resolve native dialog
semantics, the composed path and the presentation root before admitting input;
image-only propagation handling cannot establish modality. Opening the preview
revokes an already-held background gesture; dismissal allows fresh gestures.


Native Markdown images retain their intrinsic ratio within the current
container and use a document-scoped native preview for adjacent images in
source order. Its modal exists only while previewing; no browser page or
conversation route is created.
Native links stay inside the surrounding text flow and share the 500ms
streaming URL settle rule. The native shell can open HTTP(S), mail and contact
links directly; workspace files, app routes and other resources require an
explicit Host opener and are otherwise inert. Native images accept HTTP(S) and
image data sources directly. File and resource images require the Host media
loader; when unavailable or blocked, the renderer shows the alt text instead
of attempting to load a device-local path. Physical scroll, keyboard and
viewport geometry remain the Native viewport owner's responsibility. It receives
touch-down before `ScrollView` recognizes a drag, cancelling auto-scroll and
pending layout restoration as the Web owner does on pointer-down. Only a
recognized drag changes the origin of physical scroll events to user input.

The shared resource classifier recognizes `app:`, `agent:` and `navigation:`
routes, and retains `codex:` as a read-compatibility input for existing content.
It preserves the original target. Classification does not register a deep link
or grant navigation capability; the Host opener decides whether it is available.

The Expo Workbench now supplies a Host opener for resolved workspace files and
external URLs. It passes the active Thread's cwd and Host identity to ChatUI,
reads file bytes through `fs/readFile`, and displays bounded UTF-8 text in a
native resource surface. It never sends a Host `file://` target to the phone's
URL handler. The Host advertises which allowed policy decisions it can open;
app routes, unsupported resource schemes, unresolved relative files, binary
files and oversized text remain unavailable until an owning surface exists.
Changing Thread or Host closes the preview and aborts its read. These resource
capabilities are independent of the renderer's URL policy and must not be
inferred from whether a URL merely parses.
The same active Host supplies raster Markdown images through `fs/readFile`,
with a shared Web/Native MIME hint and a Native 10 MiB byte bound. Only PNG,
JPEG, GIF and WebP receive a Native data source; SVG and unknown formats stay
unavailable rather than being treated as device-local files. The renderer
aborts stale reads and drops its source when its document unmounts. The Expo
loader merges concurrent reads for one Host path, retains a 10-second,
24-MiB-weighted in-memory cache, and discards it when the Host connection
generation changes. The last departing consumer aborts an unfinished read;
the cache does not authorize file access or extend a session's lifetime.
Web and Native image presentation keys include Host, conversation, cwd and
document identity as well as the resolved target. A context switch cannot
reuse the previous image's loading result or keep its gallery open while the
new Host media request settles. This applies to Markdown images, user
attachments, generated images and tool image results.
The Workbench conversation-media hook reuses its serialized presentation key
within the mounted component while the source, resolved decision, Host,
conversation, cwd and document identity remain unchanged. Scroll rerenders do
not repeatedly serialize long inline image addresses. This is a local derived
value, not a resource cache; request cancellation, stale-result fencing,
release and measurement ownership remain with the existing media effect.
User-message image attachments, generated images and image-view tool results
consume the same conversation-media decision and Host loader. A Host file path
is never rewritten to a phone-local `file://` URI; direct HTTP(S) and image
data remain direct sources. Native preview opens the resolved image source in
the conversation's gallery when no product-specific preview owner is supplied.

MCP tool-result thumbnails retain their intrinsic aspect ratio inside the
current details width and a 192px height budget. Those constraints and
`object-fit` belong to the rendered image, rather than an outer wrapper that
could let intrinsic pixels overlap later result parts. Small images are not
upscaled. Collapsing and reopening uses the same media policy and bounded
geometry; the Host loader and resource permissions remain unchanged.

Expandable non-MCP tool details, including the DSH presenter, preserve the
original arguments alongside returned content and errors. Input, Output and
Error labels mark role changes between adjacent parts. Those inputs remain
visible while a result is pending, after settlement and after reopening.
MCP details continue to show returned content with arguments in the Raw view;
generic dynamic calls still need a registered presenter to gain a details body.

Web and Native derive file citation labels/targets and workspace mention
targets from one renderer-neutral model. Native presents workspace mentions
as inline code and file citations with a separate citation tone; it makes
either actionable only when the host supplies resource navigation. External
Native links use system long-press actions; a delayed action must still match
the current settled URL before it opens or copies anything.
Image-bearing Native paragraphs keep prose in selectable text runs and place
images in block containers so the text engine cannot collapse their layout to
an inline placeholder. In the iOS drawer host, code/table/math surfaces retain
a horizontal stroke only while their measured content exceeds the viewport;
short content leaves the stroke to the drawer. Before measurement completes,
the local scroller retains the stroke so wide content is not stranded.
Native user bubbles compile with the same `user-message` dialect as Web,
including Composer link and adjacent-list rules; assistant output continues
to use the assistant dialect.
Native list-item paragraphs and quoted paragraphs follow Web's child spacing:
the list or following block owns its own gap, and quoted paragraphs have no
extra margins. At the document level, heading and rule leading margins account
for the previous block's trailing margin because RN adds margins where CSS
collapses them. User-message paragraphs and lists have no trailing margin, so
their following heading or rule keeps its full leading space.

Code fence language labels, wrap policy and wrap preference come from the same
renderer-neutral model on Web and Native. Native keeps horizontal overflow
inside the code surface and offers code copying. Native tables retain Markdown
column alignment and one width per column across every row; columns fill their
actual container until the minimum readable width requires local horizontal
scrolling. Both platforms copy the table's canonical Markdown source, while
their preview controls remain platform-specific.
Unspecified table-cell alignment and prose/heading writing direction are
natural rather than forced LTR, matching Web's `dir="auto"` intent; explicit
Markdown column alignment remains authoritative.

Web and Native code fences now consume one Shiki grammar registry and the shared
OpenCraft syntax theme. Web turns that result into HTML; Native projects its token colors
and font emphasis into selectable `Text`, preserving exactly the original code
string, wrap mode and horizontal scroll geometry. Native delays enhancement
until a complete fence is present and caps tokenization at 12,000 characters;
larger or still-streaming fences remain plain text. Highlighting is presentation
only and never changes the copied code or Timeline content. Web assigns one code-surface owner to each
non-Mermaid fence from its first streamed bytes through completion. Closing the
fence enables near-viewport highlighting and complete-only copy/SVG preview
without replacing the surface, wrap control or scroller, retaining focus and
local horizontal position. Open fences remain plain text.

Complete Mermaid fences share Web's source preparation rule. Native reads a
bundled, offline renderer only when a diagram is present and runs it inside a
network-disabled WebView document; this is a document renderer, not a page
navigation or a second Bot runtime. The transcript keeps a bounded preview
slot, and a native full-screen viewer owns panning and source inspection.
Invalid, oversized, streaming or failed diagrams stay readable as source code.
The HTML asset and Mermaid library are packaged with the app; the document
cannot fetch scripts, fonts, images or data from the network. Each visible
diagram currently owns its own WebView, so long conversations with many
diagrams require device memory and scroll testing before calling it equivalent
to Web. Display math uses a separate packaged, network-disabled KaTeX document
with embedded fonts and the same `renderToString` safety options as Web. Its
horizontal overflow belongs to the formula surface and its measured height is
bounded in the transcript. Inline math remains in Native `Text` as readable
source because RN text cannot host the DOM typesetter without breaking inline
flow and selection; a true inline equivalent remains open work.

Open pickers subscribe to catalog invalidation. Host/root/revision query keys
prevent pre-change RPC completions from entering the new directory. Browsing
does not silently truncate at 50 entries. Search normalizes path separators and
Unicode compatibility forms and requires every query word to match a name,
display name or path. Icons accept explicit HTTPS or raster data URLs, never a
remote filesystem path interpreted as a renderer-local file; text and icon
fallbacks remain usable. Skill status/scope text uses the shared i18n port.

The Local DSH adapter validates explicit name/path against the executing Agent's
registry and user-invocation permission through the private capability bridge,
then lowers each reference to DSH's native `/name` user gesture. The installed
`dsh-tool-skill` pre-step hook loads and injects the full instructions. Missing
loader, unavailable Skill and changed path fail closed; `turn/start`, steer and
queue paths share this lowering. This uses native Skill semantics rather than
asking a model to infer instructions from labels. Native gesture history remains
owned by DSH. Tests execute the installed native pre-step handler without a
provider request; no live inference outcome is implied.

Profile-scoped Hermes Hosts implement `skills/list` using `/api/skills` plus
bounded-concurrency `/api/skills/content` reads for authoritative paths. Content
bodies are not returned in the directory. An unscoped instance Host requires
Profile selection instead of guessing a default. Submit/steer revalidate selected
Skill enablement and path in the owning Profile before invoking Hermes' existing
slash Skill behavior. Profile management change events invalidate Composer
catalogs; old dashboards that omit canonical paths report metadata errors.

DSH terminal adaptation follows the HyperNode reference contract: completion,
interruption and failure notifications are lifecycle summaries (`itemsView:
"summary"`), never empty full Item snapshots. Full membership belongs to
history reconstruction. Visible reasoning, assistant and tool Items settle
before the Turn; only explicit completed output receives final-answer phase.
`final_answer` is an optional Item rather than a prerequisite for a
completed Turn. A Turn with settled commentary or tool activity may complete
without fabricating an answer; a completely empty completed Turn still fails
closed as a provider/runtime contract violation.
Aborted/interrupted runs retain partial output with final-answer phase, blocked/max-token/unknown
terminal reasons fail closed, and failures emit a typed error before completion.
The same terminal policy is consumed by live and history projection.

DSH steering has three distinct ownership states. `queued` remains an editable
next-turn occurrence, `steering` is Host-accepted user input waiting for the
active Turn's next step boundary, and the matching durable `user/message` owns
the transcript after AgentLoop claims it. The Local Host returns a steer command
when the unary DSH RPC accepts it; it must not wait for a later `session/queue`
snapshot or claim event. Conversation Runtime moves a strict queued steer into
the active Turn immediately, then reconciles the optional authoritative
`steering` projection by client-message identity so reconnect and durable handoff
produce neither a blank interval nor a duplicate row. This does not redefine
steer as a hard interrupt: the current provider request and tool step remain
owned by DSH and may finish before the next-step inbox is consumed.

The standalone main conversation defaults fresh follow-up input to queueing during
an active response. Chat settings can persist `steer` instead through
`UiPreferencesRuntime` (`chat.defaultFollowUpAction`, installation scope). The
the downstream product embedded conversation defaults to `queue` while a response is active,
independent of the standalone preference.
Ctrl/Cmd+Enter temporarily chooses the opposite action; idle input still starts
a normal response. Content always takes precedence, including attachment-only,
processing-asset and provisional-text drafts. Only when an ordinary draft is
empty and the admitted mode is `queue`, Ctrl/Cmd+Enter invokes the visible queue
head's existing Steer (or idle Send) operation. It never skips a blocked head,
edits or clears a different draft, or bypasses atomic-steer capability, Host
readiness, restart reconciliation or unconfirmed-delivery restrictions. Queue
editing and dictation keep their existing submission path. Autorepeat is ignored;
buttons and the shortcut share one in-flight queue-steer guard owned by the
physical Conversation View. A preference change does not replace the Composer document,
editor or selections, and submission rechecks the actual active Turn. Side Chat
retains direct steering because it does not own a durable next-turn queue.

Workbench queue wiring is exercised by `scripts/smoke/execution/smoke-ssh-codex-workbench.ts`
against an isolated headless Web build (`OPENCRAFT_SSH_UI_WEB_ROOT`). With
`OPENCRAFT_SSH_UI_ACTIVE_FIXTURE=true` and
`OPENCRAFT_WORKBENCH_QUEUE_FIXTURE=v1` or `v2`, its synthetic OpenCraft Host
drives the actual settings, Host client, runtime and Composer. It holds queue
admission to check that pending input cannot be deleted, restores accepted
input after reload, and verifies legacy Steer gating versus a single V2
command bound to the queued ID and active Turn. This replaces source matching
of the Workbench capability/projection props; component SSR accessibility and
engine durability tests remain separate. Without the queue mode, the same
entry verifies native SSH admission restrictions. It uses the current Work in
machine picker and explicitly reports missing Project API support rather than
returning malformed success data. These fixtures do not certify a commercial
backend or embedded preference policy.

The real embedded preference policy is covered by
`npm run smoke:product-isolation --prefix products/<product> -- --embedded-only` (from the downstream product workspace), using the isolated
the downstream product Web and Embedded Workbench builds. It saves immediate follow-up through
real the downstream product settings on the same origin/product, holds completion after real
first-Turn admission, and checks that embedded still offers Queue. The same
fixture retains multi-Profile draft/focus, reconnect, hidden lease and account
replacement coverage across light/dark and DPR 1/2. The external account, enterprise service
tunnel and Hermes service are synthetic. This focused mode explicitly does not
certify the separate standalone visual oracle; `OPENCRAFT_EMBEDDED_WEB_ROOT` and
`OPENCRAFT_PRODUCT_ISOLATION_OUTPUT` allow separate negative artifacts.

Queued-message steering is gated by the Host's
`opencraft/thread-queue: { version: 2, atomicSteer: true }` declaration. DSH
provides the one native `session.updateQueue(steer)` operation. Stock Codex
AppServer 0.156.1 has `turn/steer` for fresh input and `thread/queue/start` for
an idle Thread, but no `thread/queue/steer`; its queue also auto-dispatches at
idle. Therefore a Codex queued message cannot safely be converted to an active
steer by composing `turn/steer` and `thread/queue/delete` in the Client or Host.
The Codex Host now owns queued input in its own durable SQLite store. It claims
one item before sending the standard `turn/steer` to Codex, and reconciles by
client-message ID against paged Codex user-message history. A crash or timeout
with no conclusive acknowledgement leaves the claim delivery-unconfirmed,
outside automatic dispatch; the Host never silently resends it. The user may
explicitly discard an unresolved claim after reviewing the transcript. The
Host delete request requires the original queue ID, target Turn ID and an
acknowledgement flag, checks history and rejects while the Thread is active.
For Codex queued steering, a matching `turn/steer` acknowledgement is the
admission boundary: the Host persists `steering` before releasing the per-Thread
dispatch operation, so a later queued steer need not wait for the first input
to appear in Codex history. Accepted `steering` rows remain visible for history
reconciliation but do not occupy the dispatch head. Only `dispatching` or
delivery-`unknown` rows block later admission; an unknown claim is reconciled
by client-message identity and is never retried automatically. The Composer
disables later Send/Steer and reorder while such a claim is unresolved, and
must not offer a generic Resume action behind it. Editing and removing ordinary
queued rows remain available.
Queued-message action hints use a hover/focus tooltip mounted in the Workbench
presentation root, outside the scroll-clipped queue tray. The tooltip remains
hoverable and text-selectable; native `title` is not used for these actions.
This does not prove Codex never saw the input. `unconfirmedSteerDiscard` remains
a separate Host capability; DSH's `atomicSteer` does not imply it. A failed
history read also rejects discard. Ordinary direct steering and idle queue Send
remain separate. At upgrade, native Codex queue rows migrate before AppServer
starts so two independent dispatchers never own the same item.
After a DSH Host restart, a durable local queue row without a matching native
queue snapshot is marked `restored-after-host-restart`; that item cannot be
started or steered until native reconciliation confirms its identity. The Host
enforces this even if a client bypasses the disabled UI action.

Attachment staging is a Host resource, not a Renderer filesystem convention.
The `opencraft/attachment-staging` capability declares accepted source kinds,
returned location kinds and the byte limit; Composer consumes only the shared
`pending/processing/ready/failed` lifecycle and an opaque `AttachmentRef`.
The local and SSH Host ordinary-file allowance is 1024 MiB (shown as 1024 MB).
The optional `chunkBytes` capability negotiates `attachment/uploadChunk` and
`attachment/uploadCancel`; older Hosts retain their advertised limits and the
32 MiB one-shot path. Images keep their separate 20 MiB inline allowance.
Web/Electron reads File slices; native opens a read-only FileHandle. Both use
one shared upload loop, send at most 1 MiB decoded bytes per RPC and await each
acknowledgement before reading more. Neither builds whole-file Base64 for this path.
The Host checks metadata and exact offsets, writes each chunk to a private disk
spool and computes SHA-256 incrementally. A ref is returned only after all declared
bytes are committed. Each upload store allows eight active uploads; partial
spools expire after ten idle minutes or are removed on cancellation, failure and
normal Host shutdown. This is not a persistent resumable-upload protocol; a client
losing the final reply must treat the outcome as unknown. The last acknowledgement
is awaited even if the Draft cancels, so its ref can be released by the existing
attachment-session owner. A process crash can leave a private spool; startup
recovery of those abandoned spools is not implemented.
Hermes Hosts with enterprise-service terminal commit port also advertise 1024 MiB and the
same chunk RPCs. This includes the embedded Workbench, which mounts the regular
App and its attachment resolver. The Hermes adapter uploads each 1 MiB part through
the existing authenticated Dashboard file endpoint; enterprise service transports the bounded HTTP
request using its BSON frame splitting. No 1 GiB Base64 request is built. Once all
parts are acknowledged, an isolated enterprise-service terminal command runs Python on the remote
Host: it verifies offsets, part hashes and total size, streams assembly and SHA-256,
then publishes content and the history manifest/index under an exclusive attachment
lock. Existing identities must match content and metadata. Parts are removed after
commit, cancel, error or normal bridge shutdown; inactive uploads expire in ten
minutes while their owner remains alive. Browser/process crashes or network failures
can leave remote parts requiring later cleanup; no persistent resume is claimed.
Final remote assembly has a two-minute budget; its lost acknowledgement is an unknown
outcome and must use the same attachment identity on retry. Legacy Hermes adapters
without the terminal port retain 32 MiB; one-shot staging remains limited to 32 MiB.
The shared file limit does not enlarge image limits or the separate inline Bot API.
Historical product validation named `tests/hermes-large-attachment.test.ts` and
`scripts/smoke-hermes-large-attachment.ts`; neither probe is shipped in this
standalone checkout. The recorded browser smoke used a local enterprise-service
protocol peer and HTTP endpoint and ran the remote Python locally; that evidence
did not certify a real cloud instance and is not a current passing core check.
The retained `scripts/smoke/resources/smoke-embedded-attachment.ts` exercises the production
Composer and shared resolver, not full Application boot.

The AppHost WebSocket message cap remains 48 MiB, accommodating legacy one-shot
requests; chunked files do not require a larger WebSocket limit. The Local Host
commits under its owned data root, never a Renderer-derived `codexHome` directory.
SSH chunked uploads spool on the Hub and transfer via backend SFTP. Legacy
one-shot bodies up to 10 MiB use native `fs/writeFile`; larger one-shot bodies
through 32 MiB use SFTP as before. Chunk uploads never forward the large file as
one native remote RPC. Large SSH upload/verification transfers have a 30-minute
budget each; the final upload-chunk request allows one hour for their completion.
The remote root comes from native `initialize.codexHome` and
is isolated by stable Server/endpoint namespace, never by a browser or connection
generation. A private partial file is committed by SFTP rename and verified
against the submitted size and SHA-256 before `ready` is returned. Small-file
verification uses native RPC; large-file verification downloads through SFTP and hashes the local spool as a stream,
so an expanded large Base64 payload never enters the remote RPC channel.
Saved passwords use the existing private askpass IPC plus a fixed private SSH
wrapper that overrides SFTP batch-mode authentication; keys/agents retain normal
batch authentication. All transfers retain the binding's strict host-key trust.
The Hub persists only lifecycle/display metadata in private Server storage;
temporary upload and verification spools are removed after each operation.
An unknown upload outcome keeps an `uploading` intent for identical-ID retry;
metadata/content conflicts cannot overwrite the resource. Failed removals keep
`pending-removal` for retry, and sent refs cannot be removed from history.
Remote send/steer verifies owned refs and adds the same model-visible locator;
display metadata survives reopening and follows native forks. Queue, Goal,
desktop and other Local-only capabilities remain absent on SSH Hosts.
Cloud object-store adapters remain unsupported until their Host advertises them.
Failed or unresolved
attachments block submission and retain their precise error; removing an
unsubmitted ready attachment asks its owning Host to release the staged ref.
The local Codex Host uses the same staging service beneath its own data root,
intercepts `attachment/stage` and `attachment/remove` before forwarding to the
stock Codex AppServer, and advertises the capability only with that handler.
An ordinary staged file compiles to Codex's native `mention` path. That item
preserves attachment identity in Codex history, but Codex does not include it
in model-facing text. At direct or queued Turn dispatch, the Codex Host verifies
that each mention still belongs to its staging service, then adds a model-visible
text locator beside the mention. Its UI-only text-element marker explicitly
identifies the following `mention` as a staged file; the shared projector
renders a file card without exposing the Host path or duplicating an `@` chip.
Ordinary mentions remain context chips. The first preview's exact generated
locator with an empty placeholder is recognized for history compatibility,
but arbitrary paths or filenames are never inferred to be attachments.
The queue retains the original input; validation and
augmentation happen before claiming delivery, so a removed file cannot become
an uncertain claim. A ready file alone is valid input. A browser-selected file is not ready merely because its
name and byte count are visible. The Composer retains the original `File` for
retry within its Draft owner, shows ordinary-file preparation/failure in the
card itself, and does not expose raw Host errors in the primary UI. An ambiguous
response after disconnect is retried under the same attachment ID instead of
blindly deleting a potentially accepted resource.
Durable history treats `AttachmentLocation` as opaque resource identity. The
owning staging service persists a location-keyed metadata index and implements
an `AttachmentMetadataResolver` that restores the authoritative `AttachmentRef`
display name during hydration. Transcript projection never parses a Host path
or storage directory; history without indexed metadata degrades to a generic
basename without exposing the full location. The Hermes storage adapter can
also lazily backfill a missing index from its own pre-existing owned manifest;
that compatibility remains behind the resolver rather than leaking its layout
into the transcript model.

The source implementations live in `apps/local-agent-host/src/hypernode/`:
TurnManager, DSH tool projection and the engine event/terminal core.
`dsh-execution-record.ts` supplies local clock, replay-stable unique Item
allocation, notification and synchronous pacing ports. One ordered ledger is
used for live snapshots and native history replay, including active reasoning.
The local HTTP/mux transport, product-owned models and credentials remain host
ports; HyperNode SSH tenancy and per-workspace process launch are not local
execution policy. See [migration contract](../../../design/dsh-engine-migration.md).

1. A conversation is identified by `(hostId, threadId)`. A bare `threadId` is
   not a cross-host identity.
2. React components never import a WebSocket, JSON-RPC client, Electron bridge,
   Session View store or Replica Journal entry.
3. `appserver-session` may translate AppServer V3 Resume/history into the common
   reader contract. Its local View revisions are snapshot continuity hints,
   not a server-sequenced V4 Journal.
4. A Transcript, Timeline Frame and Timeline Block are disposable projections.
   They never become a second persistence authority.
5. ProseMirror and Native editor documents are adapters. Persisted drafts use
   `ComposerDocument` from `@opencraft/composer-core`.
6. Submission freezes an immutable `SubmitIntent`; no UI calls
   `send(blocks): boolean` in the final architecture.
7. Unknown AppServer Item types render an explicit fallback Block. Protocol
   growth must not blank the conversation surface.
8. Visible restore authority and execution capability readiness are separate.
   `thread/resume` plus the initial history window may promote the Conversation
   immediately; connector or dynamic-tool registration prewarms independently
   and must never prolong the full-page restoring state. Every mutation that
   can execute Agent work still awaits the binding's generation-scoped
   capability lease, and a failed prewarm is retried there rather than
   invalidating already-restored history.

### Image and plan reading continuity

Web keeps explicit inspected-image disclosure and plan preview choices in the
existing Conversation View disclosure snapshot, keyed by block identity. Separate
image blocks remain independent even when they refer to the same path. The latest
plan and its completion state still come from the timeline; a saved display
choice does not cache plan text, media, permissions or execution. Writing plans
keep the existing bounded preview default and completed plans start expanded in
a fresh View. An explicit choice survives content updates, completion and a return
to the retained View. Media opening, plan copy/download and preview geometry keep
their existing owners.

### Browser image attachment presentation

The Web Composer displays a selected image immediately from a browser-owned
object URL. The object URL and original `File` belong to the Composer
Controller's draft-owner attachment session, keyed by Draft ID and attachment
ID; neither enters the serializable Draft or AppServer input. The session owns
compression/resolve work across React mount changes, updates only the Draft
that initiated the work, and aborts/revokes on removal, clear or Controller
disposal. A retry uses the retained original `File`. `processing` means local
image preparation, not measured network upload progress. The existing
`canSubmit` rule remains the admission gate for unresolved or failed assets.
For iPhone camera HEIC/HEIF input, browser image decode and canvas encoding
produce a JPEG upload derivative. This is required format conversion, so it is
kept even if larger than the selected HEIC; the original File stays with the
draft-owner session for retry. A browser without that decode/encode path leaves
the attachment failed rather than sending HEIC under an unsupported MIME.
The post-conversion inline byte cap still applies before base64 allocation.
Failed image cards show the preparation error beside the thumbnail, so touch
users can identify a decode, size or encoder failure without a hover tooltip;
retry still uses the original selected `File`.

After acceptance, image presentation is derived from the authoritative
Timeline. Sent-image thumbnails resolve direct image data or Host-backed media
through the existing media source boundary; their click opens a modal image
viewer rather than generic link navigation, which deliberately rejects `data:`
URLs. The viewer uses the Workbench Presentation Root so embedded Shadow DOM
keeps its modal styles and focus behavior; an explicit modal portal target
still takes precedence. No generic resource-policy exception is introduced. Full page reload
does not preserve an unsent browser `File`; that requires a separate durable
draft/blob storage contract.

## Selection Add to chat

Conversation owns one selection menu beside its scroll root. A range wholly inside
one rendered assistant or user document opens a non-autofocusing Radix popover.
Activation revalidates the live range; the application checks that the current
composer targets the visible host/thread. Scroll, resize, Escape and unmount close
the menu. Sender labels, controls, composer and cross-message ranges are excluded.
Selection extraction reuses sanitized Markdown content extraction, removing copied
full-code metadata first so a partial code selection stays partial.

ComposerController.appendQuote is an optional View capability with an explicit
acceptance result. Submission, active transient input and detached Views reject
it. OpenCraftComposer inserts literal text into a quote block and appends an empty
paragraph in one isolated undo transaction. It retains prior draft content,
attachments/context and focuses the trailing paragraph; it never submits. The
existing AppServer compiler retains `> ` prefixes in native input. This Web/Electron
interaction does not change Native or workspace/terminal selection behavior.

Validation: `scripts/smoke/conversation/smoke-selection-add-to-chat.ts` exercises real rendered messages,
selection popover and editor through native submission compilation without inference.
It covers draft retention, undo, partial code, caret placement, exclusions, stale
selection cleanup, theme palettes and Chromium touch. Set OPENCRAFT_CDP_URL to an
isolated Electron preview for the same client test.

The virtual anchor is clipped to the intersection of timeline bounds and browser
viewport. Long selections anchor at the first still-visible selected line while
retaining all selected text; wholly offscreen ranges do not open a floating action.
### Turn file-list choices in a retained View

The completed Turn resource's expanded file-list choice belongs to its owning
Conversation View and is keyed by the stable Turn resource ID. Returning to that
View keeps explicitly expanded or collapsed files. Current resource updates,
including a temporary list of at most three files, do not erase that choice.
Other Turns and new Views start with the original three-file default. This
reuses the existing View presentation checkpoint; no file/diff content,
execution, permission or transient hover state is persisted. The resource stays
separate from transcript Items, Activity boundaries and Thinking ownership.

### Diff reader position in a retained View

The file-change reader checkpoints its horizontal and vertical DOM scroll
coordinates under its existing patch/file View identity. Restore before paint;
ordinary output growth leaves manual reading stationary. Layout teardown reads
the live element before refs detach, including when its native scroll event is
still queued. Hidden scroll events and hidden teardown cannot overwrite that
checkpoint with zero geometry. Restoring while hidden waits for the existing
presentation lifecycle to resume a measurable reader, then restores both axes
before paint. Different files and new Views start at their original reading
origin. Unkeyed consumers retain local behavior. The snapshot contains only
coordinates, without diff text, execution state or permission.

### Reading expanded file diffs in a retained View

The file-change consumer also keys its nested diff preview to the same patch and
file identity. Explicitly shown unchanged contexts and the long-diff expansion
are presentation choices in that View snapshot. Restore them before paint, keep
different files and fresh Views isolated, and continue rendering current diff
text through the existing parser. Consumers without a restore key keep their
existing local defaults; no raw diff, approval or execution state is stored.

### Code and table reading positions in a retained View

Conversation checkpoints local code/table scroll coordinates in its existing
View snapshot. The shared Web renderer owns capture and before-paint restore,
keyed by document and stable node identity. Layout cleanup reads the attached
element even when a native scroll event is still queued. Zero positions use
the original default and do not occupy snapshot entries. Other Conversations,
new Views and unscoped documents retain their own defaults.

A fixed-size source fingerprint and length allow a restored block to consume
its previous position only for the same source or an appended source. Replaced
content cannot inherit a stale position; the checkpoint contains no code or
table text. Streaming/highlighting and theme updates retain the existing DOM
without replaying a saved scroll on every update. This adds no focus writes,
selection replacement, global persistence, execution or permission state.

### Plan preview natural height

A collapsed plan has a 320 CSS-pixel ceiling, rather than a minimum height.
The body is capped by its natural content size while the existing Motion owner
continues the expanded/collapsed height transition. The content wrapper retains
the document inset; its border-box observation only decides whether the collapsed
preview needs its fade and expansion overlay. Short content stays readable without
an overlay, and streaming growth, shrinkage and width changes update that affordance.
The existing View choice, completion defaults, copy/download and viewport ownership
remain unchanged. `scripts/smoke/conversation/smoke-reasoning-disclosure.ts --plan-preview-only` covers
short and long content, growth/shrinkage, expansion and View restoration.
Queue row leading content is compact: the reorder hit area begins one spacing
unit from the row edge and immediately precedes the independent sender slot.
Keep the existing desktop/touch hit widths and row heights; only preview and
trailing actions retain their normal text separation. Reducing leading whitespace
must not put the photo inside the drag activator or overlap its target.
