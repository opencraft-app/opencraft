# ChatUI: Activities and tools

[Architecture index](../../chat-ui-architecture.md) · [Documentation index](../../README.md)

### Activity closure and disclosure authority

`AgentActivitySegmentEnd` records why a contiguous slice ended (`user-input`,
`content`, `reasoning`, `final-answer`, `turn-terminal`, or still `open`). This is chronology
and live-header ownership, not permission to hide content. Ordinary task
disclosure is eligible only for the nearest meaningful work slice reaching its
own displayable, non-async final answer. Readable reasoning may separate physical
work slices, but cannot multiply that response's outer fold owners. Earlier
slices retain their ordinary tool summaries and their tools' independent choices.
A Steer, hook, question, approval, image, unphased text,
terminal Turn, or a final answer in an earlier response cannot grant eligibility.
No phase is inferred to make a disclosure work. Earlier completed commentary
therefore stays visible when the user follows up, rather than becoming a stack
of default-collapsed historical-message headings. Cancelled work stays visible.

Eligibility, automatic default, explicit View choice and temporary expansion
constraints are independent. `resolveAgentActivityDisclosure` is the shared
pure policy; `resolveAgentActivityLayout` applies `forceExpanded`/`disableCollapse`
before selecting partition regions. A no-toggle surface must not expose only
the collapsible subset or duplicate persistent items. Displayable non-async
final answers are persistent even if supplied to the inner partition, although
the ordinary ordered plan renders them in separate source-owned slots.

Only user actions write collapse choice. Defaults and constraints never write
it back; old saved choices cannot manufacture eligibility. Web's existing
View restore receipt and Native's component choice remain their presentation
owners, not Thread storage or an execution preference. Stable segment/Item
keys, the single Turn clock/Thinking owner and viewport reflow leases are
unchanged. No new scroll writer, timeout, renderer sorting or remount is added.

The ordinary task policy applies to ordered multi-response slices. Input
boundaries do not grant fold eligibility. The distinct Bot chat renderer and
viewport retain their own presentation contract. The explicit eligibility and
preference tables in `chat-activity-disclosure` cover all 96 ordinary-task state
combinations; `scripts/smoke/conversation/smoke-activity-disclosure.ts` covers the input sequences
and real Conversation. Deployment and native-device acceptance remain separate.

### Returned thinking content

The Web reasoning disclosure uses the shared thinking activity SVG in the centered
20px activity rail. The rail stylesheet calibrates painted geometry to roughly
15px and effective strokes to 1.2 CSS pixels across thinking, read, terminal and
supplemental interface icons. Source padding may require different canvas sizes;
copy, slot geometry and alignment stay shared. Both live and settled content use
the same metrics. The live glyph's internal pulse/cursor remains animated, and
all live process labels use the existing cadenced text sweep: reasoning, commands,
read/search/edit, tools, compaction and active group summaries. All process row variants compose ActivityRowContent, which owns the rail and
one summary sweep. Disclosure and summary adapters supply required running state
and raw content. Deferred group content never captures animation state; only the
glyph can hand motion to expanded running rows. CadencedShimmer is a separate
leaf for independent plan/approval/loading consumers.
Completion, failure or interruption removes the sweep; reduced motion disables both decorations. See the activity icon design contract.

Engine-returned reasoning is a chronological Item-owned inner disclosure within
the response's work container, not the body of a tool group's live “Thinking” header.
All engine adapters consume the same shared disclosure policy: nonempty explicit
summary text wins; when no summary is returned, the actual returned textual detail/content is available.
The body selects that content once, without concatenating duplicate summary
and detail. Empty Items and opaque/encrypted fields create no disclosure and
cannot be used to fabricate an explanation.

Request policy and disclosure policy are different owners. The Codex Host's
single native request writer supplies `summary: "auto"` on `turn/start` only
when the caller omits that field. The same boundary covers normal/new/forked
conversations, empty continuation and Host-owned queued starts, over local
stdio or remote Codex transport. Explicit modes (including `none`) are retained;
explicit `null` keeps native thread/Host inheritance. Invalid explicit values
remain the native validator's responsibility. Each omitted-field start reapplies
the product default rather than inheriting a previous explicit `none`; callers
wanting native inheritance use `null`. No summary field is added to Steer,
Thread lifecycle requests or generic Hermes/DSH submissions. Codex's
native model capability gate still owns upstream support; asking for a summary
does not guarantee returned text. Existing running turns and historical Items
are not rewritten. The UI stays initially collapsed and only actual returned
text creates its disclosure.

Hermes already projects actual `reasoning.delta` and its durable reasoning
columns by default, without a separate display opt-in. Its ordinary Responses
transport asks for an automatic summary, but provider-specific transports and
explicit session/model/global reasoning settings can differ. “Enabled by
default” therefore means accepting returned text, not promising content on
every response or treating `reasoning.available` liveness as that content.

`chat-core` owns selection, chronological slots and single live Thinking
arbitration. Stable Turn/Item identity survives streaming, completion and
history updates. A patch item changing multiple files retains its whole-group
summary and disclosure when the Turn settles. Completion does not reveal a file
list that the user collapsed; one-file patches retain the existing plain-row
behavior. A completed single-item group may use a plain row, but keeps
its group origin in the presentation plan. Web flattens only the group's
header and layout wrappers while retaining the mounted item content. Completing
or replaying that item preserves its explicit disclosure choice, log reading
position and focused action; an unopened item remains collapsed.
Reasoning and Bash/Read/tool groups have separate inner
disclosures inside the same contiguous response work container. The newest
current-response reasoning may own live feedback; later tools, answers,
questions or inputs retire that feedback without deleting readable content.
When no returned content exists, the existing noninteractive Thinking status
retains its current owner rather than becoming an empty expand button.
Pending generated images own their media progress surface, so the Turn does not
add a separate Thinking placeholder. Completion releases that feedback; an image
before the latest answer or input cannot suppress the next response.

Reasoning presentation uses two phases: grouping and Thinking ownership inspect
selected returned text without Markdown compilation, then each visible Item's
header is compiled once in its final active/settled mode. The latest todo read
is a separate shared selector and never builds transcript presentation. Web and
Native each own a `ReasoningPresentationCache` for a mounted Turn, replaced when
its Turn key changes and released on unmount. It compares Item ID, selected
content/source and active parser mode, so immutable reprojection does not reparse
unchanged history; text/source edits, empty replacement and completion invalidate
the affected Item. The LRU retains at most 128 presentations and 1,000,000 source
plus header characters; larger Items still render in full without being cached.
No ASTs, disclosure choices, execution authority or persistent text cache are
shared through it. Headers continue to use the same assistant Markdown grammar
as the unchanged canonical body, including reference definitions and streaming
repair. The display-math tokenizer skips its boundary regex when neither actual
delimiter is present, retaining the existing rule for documents containing math.
Streaming reference, standalone image and link-target suffix repair scans input
linearly, preserving the existing output without repeated regex suffix searches
on untrusted model text.

Both platforms initially fold reasoning, even while streaming. Only an explicit
View action changes that choice; new deltas or completion never automatically
expand, collapse or write a preference. Web reuses its existing View restore
receipt and disclosure reflow owner; Native keeps Item-keyed inner choices on
the stable outer work component. Collapsing the outer container may unmount its
body but must not reset either reasoning or tool-group choices. The header uses a short localized status plus the latest
nonempty visible document line when active, or first visible line when settled.
The status label stays readable in full; the document-line preview yields space
and truncates when the header is narrow or the line is long.
Embedded the downstream product status labels follow the host locale for all supported site
languages; returned reasoning text stays in the language supplied by the engine.
`chat-document` owns the shared assistant Markdown grammar and plain-text
projection: labels omit formatting controls and link destinations, but preserve
escaped literals and code identifiers. `chat-core` selects the line and keeps
the selected Markdown body unchanged; neither platform regex-strips content.
The expanded body uses the ordinary Web/Native document renderer, with stable
Item document identity, the existing Host resource/media policy and the Web
viewport measurement ingress. Block Markdown is never nested in a raw paragraph;
its renderer owns whitespace and narrow code/table overflow. Only current live
feedback animates the document. Rendering a resource or a stream update cannot
change either disclosure choice or take tool/final-answer ownership.
The full selected text is available during and after execution. It is not
copied into the final response's copy action or tool statistics.

Adapter event names are not content authority. In the inspected Hermes agent
revision `3c3ab69abb9b08683b5eb15b4e2b8be1198c875f`,
`turn_response_intake._relay_thinking` sends up to 500 characters of
`assistant_message.content` as `reasoning.available`; it is an assistant-body
preview, not returned reasoning. The Hermes bridge uses this only for liveness,
leaving body ownership to `message.delta/interim/complete`. Actual
`reasoning.delta` and durable reasoning columns own separate reasoning Items;
an answer with equal or prefix-continuous text cannot erase them. History
aliases select one returned representation instead of duplicating it.
An empty or opaque reasoning source Item remains a work observation; it does not
flush/re-key a work slice, close an adjacent tool group or create a history-count
heading. Actual nonempty text owns a source-identified chronological disclosure.
First returned text inserts a new inner disclosure, including when later Items
already exist in restored history; it never splits or re-keys the outer work
container. Source identity and existing valid View choices survive. Nonempty
reasoning separates adjacent inner tool groups, not responses or outer folds.
Within the same contiguous response, a real final answer grants exactly one
outer work disclosure containing both reasoning and tools in source order.
The final answer remains outside. Tools never move into the reasoning body.
Real user input, an asynchronous question or other content/interaction retains
its existing ordering boundary; separate completed responses keep their own
legitimate folds even though execution shares one Turn. Only one work container
owns the Turn-total clock; reasoning cannot redirect it across a response/input
boundary. Actual reasoning alone is meaningful work, so a completed reasoning-only
response has a real outer fold, even with no tools. Its Worked-for label uses
only the provided clock, never fabricated timing. Empty reasoning alone does
not create an empty toggle. Outer visibility and independent inner choices are
different authorities; streaming, completion and outer collapse never rewrite
those inner choices.

The interaction draws on DSH `ReasoningRow` in locally inspected
`@deepseek-ai/dsh-client-ui-conversation@0.1.1-rc.2`. Shared model and adapter
tests plus `scripts/smoke/conversation/smoke-reasoning-disclosure.ts` cover empty/summary/detail
content, first control activation, browser touch/mouse/keyboard, separate tool groups,
in-place streaming, completion, prepended history and View restoration. The
browser fixture uses synthetic engine text; it does not claim paid-provider
execution, hidden reasoning availability or iPhone OS acceptance.

The embedded canvas permits the existing `opencraft.voice-input.toggle` Composer
action. Dictation uses the platform speech provider and the same transient input
transaction as the full Workbench; no microphone starts until user interaction.
Unsupported browsers retain the provider's disabled-state explanation.

All floating primitives in that canvas resolve through one Workbench
Presentation Root. This includes Composer model/effort menus, Draft project and
Host selectors and application modals. The root also owns the
semantic theme variables required by those primitives; a Portal must never fall
back to the embedding product's document body.

Global type-to-compose resolves input ownership through the keyboard event's
composed path, including editable descendants inside the embedded Shadow DOM.
It never inserts printable keys owned by an editor or control, or IME keys
marked composing / keyCode 229 (including the initial composition key).

The Web renderer localizes the Thinking status through one `ThinkingLabel`
for turn placeholders, live reasoning and activity-group gaps between tools.
Core status strings remain renderer-neutral; real reasoning summaries are preserved.

### Disclosure scroll anchor lifetime

While a user expands or collapses an activity, its heading retains its screen
Y coordinate. Numeric disclosure height samples are projected onto whole CSS
pixels by the shared Web animation adapter before Motion commits layout,
matching the scrollport's conservative pixel grid. Otherwise rounded scroll
writes can leave the heading oscillating by almost a pixel even when its final
position is correct. Natural `auto` layout and later streaming growth are not
fixed or rounded by a second observer. The disclosure owns its
animation and reports completion through a View-scoped reflow lease; the Web
conversation viewport is the sole owner of scroll writes and observation. It
keeps the anchor through the animation and final stable layout frames, including
body removal and reduced motion. No fixed timeout decides completion for the
activity row, group or Worked-for controls.

Worked-for animates entry only. Its closed branch removes content in the same
React commit; it must not add an exit-presence owner that defers unmount after
the parent reports synchronous layout completion. Completing a reflow lease
applies the committed layout compensation immediately, then waits for stable
frames before retiring observation.

Each viewport has at most one interaction anchor. Reversal or a new heading
supersedes the old lease; delayed completion can only complete the lease from
its own render. User scrolling, control unmount and viewport replacement cancel
preservation immediately. Unmigrated expanders keep their separate bounded
compatibility policy and cannot create a second owner alongside an activity lease.

Browser regression measures the visible label's entire path and peak-to-peak
movement, not only final position or each frame's distance from the starting
point. It covers measured multi-Turn layout, fractional starting geometry,
mouse/touch input, reduced motion and interrupted/reversed animations. A
separate nonvirtualized control checks retirement of the interaction anchor;
normal virtualizer compensation during later growth is not evidence of a leak.
That control also holds a real viewport lease without an animation deadline:
body growth is initially pinned, then actual wheel/touch-pointer input must
release it before subsequent growth. Growth checks wait for the measured body
height to change before sampling the heading. Detaching the viewport releases its anchor
while the former DOM is still connected. Actual disclosure unmount separately
verifies hook cancellation. These adapter lifetime checks complement the real
mouse/touch animation path; they do not claim Native or Electron acceptance.

### Subagent detail continuity

Web retains explicit detail and full-member-list choices in the existing
Conversation View disclosure snapshot. The core render-unit identity owns a
collaboration group, including when one operation grows into several; a standalone
block uses its own identity. Member order, count and status do not replace that
owner. Detail choices retain the running/settled defaults separately, while
showing all members is independent of execution phase. A fresh View starts with
the original defaults. Only display booleans enter this snapshot; agent content,
status, navigation and execution remain under their existing owners.


Grouped collaboration rows retain each agent’s latest matching operation and
instruction. Their display names, status and messages still come from the shared
core aggregate; a later operation for another agent cannot replace that detail.
Older instructions for the same agent are not repeated. A single-operation group
retains the standalone input, reasoning effort and agent path. Disclosure changes
only presentation and does not start, message or approve a subagent.

### Command elapsed presentation

Active foreground commands retain an elapsed label when their protocol item has
no start timestamp. The mounted view tracks its first observation only as a
presentation fallback; a reported start wins and a completed item uses its
reported duration. This local observation is not a reconstructed execution start
or persistent history clock. Parked/hidden views stop ticking and recalibrate
when shown; background terminal labels do not create an elapsed interval.

### Activity disclosure spacing ownership

Activity rows (reasoning, command groups and image views) declare a stable
`data-conversation-row="activity"` at the renderer boundary. Lists project that
role through a direct row or one known timeline slot and use the grouped-item
gap between activity rows. The role does not depend on open/closed, running,
settled or streaming state. A prose/work section containing nested activity is
not itself an activity row; its content boundary keeps the list's content gap.

The list alone owns external row spacing. The shared disclosure owns its
summary and detail region, including readable internal padding. Opening only
grows that region; neither it nor a nested disclosure can change ancestor or
sibling margins, unrelated row sizes, order or DOM identity. The same contract
holds during animation, streaming growth and rapid reversal. Closing restores
the original geometry without leftover detail space. Viewport anchoring may
move the viewport and following rows naturally move down, but neither is a
spacing authority. Do not use descendant open-state selectors to reclassify
rows, or replace the regression with per-reasoning overrides or delayed layout.

`scripts/smoke/conversation/smoke-activity-spacing.ts` samples actual Conversation geometry before,
during and after mouse/touch disclosures, including first/middle/last reasoning,
image details, nested commands, streaming, rapid reversal and reduced motion.
The regression is sibling-boundary and unrelated-size stability, not constant
absolute screen coordinates while content grows.

### Conversation process visual ownership

Interactive and passive process records share metadata typography and an
ActivityIcon rail. Context compaction is a process record, not reading prose,
and must consume ActivitySummaryRow rather than inherit chat metrics. The
scoped activity stylesheet alone owns optical size/stroke; renderers supply
unchanged glyphs and content. Reading preferences retain control of expanded
reasoning/documents. This visual contract does not reclassify spacing roles or
change compaction lifecycle. See [activity visuals](../../../design/ui/activity-icons.md)
and `scripts/smoke/conversation/smoke-conversation-activity-metrics.ts`.

A single visible compaction record remains directly readable after an answer,
without an outer work disclosure. Determine this from the projected collapsible
content, excluding clock metadata and Items with no visible body, such as empty
reasoning or an empty file change. Visible companion work or multiple compaction
records retain the normal disclosure and explicit user choice.

## Web search activity detail projection

The shared tool detail formatter owns only display-field selection and compact
search text. It preserves the current nested action envelope, operation aliases,
query/pattern/URL precedence and existing hostname/first-query helper contracts.
Ordered site facets and ordinary punctuation are presentation compatibility data.
The presenter continues to own phase, summary, grouping and expandability; the
Timeline owns protocol projection and call identity. A detail string neither
executes a search nor authorizes or opens a resource. Web and Native consume the
same pure projection.

### Tool detail choices in a retained View

File-change diffs and tool disclosures keep their explicit choices in the owning
Conversation View snapshot, keyed by tool block or patch block and file identity.
The shared disclosure hook retains separate running-collapsed and settled-expanded
choices; restoration does not change either phase's defaults. MCP details continue
to start collapsed. A new View starts with the existing defaults, while returning
to a retained View restores its choice before paint. Only presentation booleans
are checkpointed. Website tool subcalls use the same View store, keyed by their
source block, ordered subcall slot and tool name; each restores its own explicit
choice independently and fresh Views retain collapsed defaults. Thread handoff
step disclosures checkpoint their separate running and settled choices under
the handoff block identity. Returning to the same View restores those choices;
a fresh View keeps the running-open and settled-collapsed defaults. Standalone
automatic-review disclosures retain those separate phase choices by review block.
Their rationale, including reviews attached to command, patch and tool bodies, retains
its own manual choice by parent block and review identity. Collapsing a parent
body and returning to the same View preserve that choice; fresh Views keep
rationales collapsed. Review text and status always come from the current
timeline and never authorize or replay an approval. Output,
permission, execution and App document state remain with

their existing owners. Updated output is rendered from the current timeline.


Code-block clipboard extraction honors the same descendant exclusions as ordinary
Markdown when full-source metadata is absent, including cloned partial ranges
crossing code surfaces. Language captions, controls and hidden duplicates stay
out of quotes; raw source whitespace and Unicode remain intact. Explicit full
source metadata keeps its existing authority. The shared copy owner supplies
this rule to copy and Add to chat, without changing native selection or drafts.


### Host-owned tool details

The optional Conversation tool-content renderer claims the body whenever it
returns a value other than `undefined`. Claimed content, including explicit
`null` or `false` suppression, takes precedence over built-in thread-tool cards.
The renderer is called once per tool render; its body is not duplicated with
the default content. Default thread creation/navigation stays semantic when
the Host returns `undefined` or does not provide the port. Handoff disclosures
exist only for reported progress steps; an empty step list leaves a summary row.
Explicit `null` or `false` suppresses the default body and does not create an
empty disclosure. Approval reviews remain visible when the Host suppresses its
own tool content.
These choices own presentation and cannot create a Thread or execute a tool.

Side Chat queries the child Host/runtime model catalog for display metadata only. The execution snapshot owns inherited model, effort and service tier. The compact non-interactive footer retains catalog casing, with readable identifier fallback.

## Delayed command completion placement

History adapters retain finite Item-envelope `startedAtMs` and `completedAtMs`
when loading paged history. The shared chat-core projection places a delayed
completed command at its known execution start relative to later timed Items.
It preserves source membership, non-command order, equal/unknown clocks and
commands that actually started after an answer; it never globally sorts replies.
Live completions update an existing execution or use explicit lifecycle evidence.
An orphan completion without a start cannot establish a new transcript position;
authoritative history can recover it. Failure status, exit code and output stay
attached to the execution. Web and Native consume the same projected order.

### Live tool disclosure state

Generic dynamic tools use the shared activity disclosure state: a running tool
whose presentation declares an expandable body or whose Host supplies a visible
body starts open, a user collapse survives progress updates, and settled
details have their own initially collapsed choice. A historical completed tool
therefore starts collapsed without an expand-then-collapse frame. MCP details
retain a separate initially collapsed choice. Attached approval reviews alone do not
activate the running choice; review-only tools retain their settled/manual memory.
Presentation still owns whether
a tool has a body; an unknown compact dynamic tool does not expose its payload.
`smoke-thread-tool-activity.ts` exercises native Items through the original
projector and complete Conversation, including completed/failed settlement,
manual reopening, historical restore and MCP/compact controls.

### Tool detail choices in a retained View

File-change diffs and tool disclosures keep their explicit choices in the owning
Conversation View snapshot, keyed by tool block or patch block and file identity.
The shared disclosure hook retains separate running-collapsed and settled-expanded
choices; restoration does not change either phase's defaults. MCP details continue
to start collapsed. A new View starts with the existing defaults, while returning
to a retained View restores its choice before paint. Only presentation booleans
are checkpointed; output, permission, execution and App document state remain with
their existing owners. Updated output is rendered from the current timeline.

### Live Turn resource entry motion

The Composer Turn change summary consumes the owning Conversation entry-motion
context. A recovered authoritative baseline or retained View return paints the
resource fully visible and stationary from its first frame. Genuinely new live
resources retain their entry animation, and count updates keep the same node.
Reduced-motion preferences remain effective. This changes presentation only;
Turn identity, diff content, review actions and execution authority are unchanged.

### Command log reading continuity

Command disclosure and log reading state belong to the existing Conversation
View. Its restore snapshot retains explicit open/collapsed choice, both log
scroll axes and the reader's follow-output intent, keyed by source block identity.
Virtual row remounts and returns to that same View restore the state before paint.
Layout teardown captures the actual log coordinates before refs detach, including
a final scroll whose browser event is still queued when the View leaves.
Hidden routes retain that snapshot: background output, layout-generated scroll
events and hidden teardown cannot replace it with zero geometry. The existing
presentation lifecycle restores both axes before paint when the log resumes;
a following reader then catches up to the current tail.
New output follows only when the reader was already following; manual reading
keeps its position. Explicitly reopening starts at latest output. A fresh View
starts with the normal collapsed command default. These memory-only numbers and
choices contain no output, execution state, permission or automatic action.

### Subagent lifecycle notices

A single native lifecycle notice without a collaboration tool uses the shared
core inline status label and agent identity. Accepting a `started` notification
does not mean that the child finished: started, interacted and interrupted remain
visible as such. The whole inline button opens the child through the existing
navigation context and is disabled without that capability. Collaboration tool
groups and completed-notice projection keep their existing presentation.

### Subagent summary density

The summary initially exposes at most three agent chips and a remaining-agent
count action. Expanding that count exposes all navigation chips independently of
the detail disclosure. This keeps narrow summaries readable while the shared core
continues to own every agent identity and status. The header and chip rail wrap
naturally when a long operation label or an explicit full list needs more room;
the remaining-agent action stays on one line.


Thread handoff rows with reported steps use that same running/settled choice.
The operation's queued/running status determines presentation even when its RPC
has completed. User collapse survives progress, settlement starts with its own
choice, and completed history starts collapsed. Empty step lists remain summary
rows. Transport failure takes precedence over earlier running progress; the View
does not invent progress or issue a handoff command.

### Host-owned tool details

The optional Conversation tool-content renderer claims the body whenever it
returns a value other than `undefined`. Claimed content, including explicit
`null` or `false` suppression, takes precedence over built-in thread-tool cards.
The renderer is called once per tool render; its body is not duplicated with
the default content. Default thread creation/navigation stays semantic when
the Host returns `undefined` or does not provide the port. Handoff disclosures
exist only for reported progress steps; an empty step list leaves a summary row.
Explicit `null` or `false` suppresses the default body and does not create an
empty disclosure. Approval reviews remain visible when the Host suppresses its
own tool content.
These choices own presentation and cannot create a Thread or execute a tool.

### Display selection and provenance

`ConversationDisplayContinuity` owns the bounded, account-scoped storage projection
and transient first-submission handoff. It accepts authoritative observations only;
stored data is validated at this boundary. It does not select what a View renders.

`selectConversationDisplay` in workbench-runtime is the single pure display selector.
It fences all candidates by the committed View's Host/Thread key and returns a
Timeline with explicit history, preview, cache or submission provenance, or empty.
Nonempty authoritative history wins. A first-submission echo survives an empty
baseline until canonical user content retires it; otherwise authoritative empty
history clears stale cache. A partial preview inherits missing metadata only for
an exact Turn/frame-kind/block-kind/message identity, retaining cache if it still
omits known visible metadata. Explicit sender removal and authoritative correction
win. Active clocks never become completed intervals through this merge.

The Web `useConversationDisplay` adapter owns subscriptions, cancellable cache reads
and authoritative observation effects. Its loaded value is a scoped I/O receipt;
synchronous continuity memory takes precedence. The App consumes the selector's
Timeline and provenance instead of duplicating source precedence or inferring it
from object identity. Provisional display suppresses history actions; command
permission still requires the existing live runtime, authority and lease checks.
Avatar media loading remains separate from message identity and display selection.
This refactor retains the existing cache schema and storage keys.


### Website tool call details

Browser WebMCP child calls retain separate Tool and Result JSON previews. The Tool preview identifies the tool, website, read-only hint and parsed input; list operations use the Listed website tools summary. Parse complete JSON for reading, preserve truncated or invalid text exactly, and label truncated input/results. An absent result adds no Result section. Reuse the shared code preview and its scroll budget, keep each document identity scoped to the parent call, and preserve data when details are closed and reopened.


### Approval reviews on tools without results

An attached automatic approval review owns an expandable body even when the
tool presenter has no content surface. While a tool is awaiting a decision, users
can open its review progress and subsequent denial rationale. This does not grant
a generic compact tool an input/output surface, invent an empty result, or change
the tool's initially collapsed state. Review identity and state remain owned by
the runtime and chat-core; Web only combines the existing disclosure and review
list. Tools without reviews retain their presenter's expansion policy.

### Raw tool result facts

The Web Raw dialog preserves the tool transport's result shape. MCP protocol failures
include the error message and protocol kind; an absent envelope stays null. A received
MCP result retains its content, structuredContent and raw envelope, including isError
without reclassifying it as a protocol failure. Dynamic tools retain success and the
complete contentItems. Invocation identity falls back from server to namespace. The
existing JSON preview and copy action consume the same complete value; none of these
display fields can change execution, permissions or the compact-tool policy.

## Message footer time disclosure

User and assistant message footer clocks are visible at rest for touch input
through the shared coarse-pointer/no-hover/current-touch policy. Desktop pointer
clocks remain hidden at rest and reveal on existing message hover/focus. Keep
time metadata, slot geometry, history cache and action-button availability;
elapsed work duration is separate.


### Details arriving in a mounted activity row

The activity disclosure binds its measurement observer whenever its actual body
mounts, including a diff that arrives after an initially empty file record.
Removing that body releases the old observer; a later body binds a new one.
The existing row, expansion intent, motion and viewport reflow owner remain.

### Command result language

Host-owned command result and empty-output labels use the existing application
locale service. Command text, native stdout and exit codes remain source values.
A language change updates labels in place, retaining the same log viewport,
reading coordinates and follow-output intent, and the existing composer state.
