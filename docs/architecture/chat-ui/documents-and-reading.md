# ChatUI: Documents and reading

[Architecture index](../../chat-ui-architecture.md) · [Documentation index](../../README.md)

## Inline link label construction

The document compiler preserves link label Markdown children while disabling
interactive text decorations within that label, including nested formatting.
The link has one resource action; mentions and color decorations do not create
additional actions in its text. Raw target/title values and existing UTF-16 source
ranges stay parser compatibility data. Sanitization, streaming activation and
opening belong to the existing renderer/resource owners.

## Trusted Web renderer composition

A local Application may declare `chatRenderExtensions` as Cordis renderer plugins.
`createWebChatRenderRuntime` installs them after the standard Web renderers,
using the same registries and resource-policy service. The runtime owns their
fibers: startup failure rolls back preceding installations, and Application
disposal releases them. No extension is installed into the library fallback or
another Application. This is trusted build composition, not an HTTP-supplied
module loader or a product ID switch. Product parsers, dictionaries and artwork
stay downstream. `smoke-product-render-extensions.ts` exercises the real
Application and documents, default isolation and startup/disposal failures.

## Message timestamp presentation

Web/Electron user and assistant action rows share `MessageTimestamp`. It formats
the authoritative `sentAtMs` using the application Intl locale and the viewer's
local time zone: today shows hours/minutes, the preceding six calendar days add
the weekday, and other days add month/day. Calendar-day comparison survives DST.
Both roles use an unpadded numeric hour and a two-digit minute; the locale owns
the hour cycle. A full localized date/time with zone is available in the title,
while `datetime` preserves the original instant. Known local zone names remain explicit so the shared Intl cache follows local-zone changes. When a runtime reports `Etc/Unknown`, leave the zone unspecified: native default local formatting still works, but feeding that unknown name back as an explicit zone fails. Missing or invalid values render
no clock. Existing message hover/focus disclosure and timestamp slot alignment
remain independent; this view never derives or persists a replacement time.

## User message copy action

Web/Electron reserve the existing footer slot but reveal its copy icon only on
message hover or focus, alongside desktop timestamps. On touch input, a plain-text
tap focuses the message and reveals copy; tapping elsewhere dismisses it through
native focus. Links, controls, selection and scrolling keep their own interaction.
The message is programmatically focusable without adding a Tab stop; the copy
button remains keyboard reachable. Copied feedback stays visible for its existing
confirmation interval. The action copies the full message even when its bubble is
collapsed, excluding sender, timestamp and attachment metadata. Mobile timestamps
retain their existing visibility policy.

## User message sender display

Web/Electron show each user message's verified employee `loginName` above its
content, with a 20px circular photo beside the small muted label aligned to the end.
The enterprise identity plugin resolves the photo through the trusted identity-avatar contribution;
failed images retain a same-size person icon. Attachment-only messages use
the same label. Unknown or absent senders leave no label. The label consumes
the individual message snapshot, never the current footer account or Turn author,
and is excluded from copied message text and native model input.
The scoped paint-only history cache retains this validated per-message sender
with the message body. A partial preview may inherit an absent sender only for
the exact same message; an explicit sender and authoritative corrections win.
The existing avatar contribution resolves its stable photo URL; the same-size
fallback keeps geometry while the image loads. No cached sender authenticates
the viewer or grants interaction authority.

## Queued-message sender display

The queue uses separate leading slots for its drag handle and fixed 20px author
photo. The handle remains visible and owns sortable activation; the photo has its
own author tooltip and is never a drag target. Unknown authors and failed photos
retain a same-size person icon. Hover, keyboard focus and held dragging do not
fade the photo or place the grip over it. The warning indicator belongs to the
sender slot; right-side Steer/Send, edit, delete and unconfirmed-delivery review
stay distinct. Fine pointers use a compact 24px handle column with a centered
12px grip; coarse pointers get a 44px handle contained in non-overlapping rows.
ChatRuntime carries the original per-entry protocol sender. Exact-client local
submission hints may paint a pending queue before acknowledgement; explicit server
identity (including null) wins, and restored/unrelated entries never inherit the
current employee. Web resolves the enterprise identity contribution into generic name/avatar URL
values; Composer owns only layout/fallback, not enterprise identity URLs or account policy. Queue
editing/reordering never relabels its submitter; these values are display-only.
During first-send promotion, the transcript handoff already displays the initial
input. While that exact user message is visible in the handoff or live timeline,
its matching client message ID is omitted from the attached queue rail for normal queued/submitting
states, including local reconnect waiting. Other inputs stay visible even when
text is identical. Errors, uncertain delivery, paused entries and active queue
operations retain their handling controls. This is display deduplication only;
the runtime queue, delivery authority and first-Turn dispatch remain unchanged.
Queue refresh keeps the current projection until a complete, current read succeeds.
A queue-change notification received during a read invalidates that response;
the coalesced follow-up read replaces it without publishing a stale empty list.
A fresh empty response still removes consumed or deleted entries. Local queue admission and its acknowledgement also invalidate an in-flight read;
this protection does not depend on notification timing. The pending row paints
synchronously before transport acknowledgement. Its client message identity remains
the React render key when the server queue ID arrives; actions continue to use
the server ID. Once an authoritative queue snapshot takes ownership, a late
admission acknowledgement cannot resurrect the retired local row.

## Streaming projection and document reuse

The Host session buffers only append-only assistant, plan and indexed reasoning
text notifications. ThreadViewStore reduces original notifications in order and
publishes one consecutive View revision per batch; notification revision and
last notification retain their original semantics. Web/Electron and Expo inject
frame scheduling with a 32ms timer fallback while presented; hidden documents,
embedded parked views and background native applications batch text with a 250ms
fallback and do not request RAF. Headless uses a 16ms timer. Timers
do not guarantee progress while the event loop is blocked. Lifecycle,
replacement, history, interaction writes, authoritative reads and commands flush
preceding text. Completion and its preceding deltas share one publication;
full terminal snapshots still replace Item membership. Generation guards,
cancelled-callback fencing and disposal prevent replay into newer sessions.
Pressure flushes at 512KiB of UTF-16 delta data or 2048 notifications preserve
all text. Batching reduces downstream JSON/Replica/timeline work while still
running each original projector.

The Session-to-Replica source reuses immutable ThreadView subtrees and freezes its
JSON projection. Replica validation memoizes only deeply frozen data properties;
mutable descendants and accessors remain subject to validation on every write.
Conversation normalization and pure per-Turn projection preserve identity for
unchanged history. Projector registration revisions invalidate the Turn cache.
Metadata-only updates reuse frame arrays and anchor maps; text updates rebuild
only the changed Turn's frames, though assembling the ordered frame list still
walks the history. This is not an O(1) claim for every notification.
Host residency publication compares actual ownership/connection changes and
coalesces lifecycle updates in one microtask. Catalog hooks subscribe to Host
state; active conversation consumers retain their own text subscription.

Command detail output distinguishes waiting from a settled empty result: while a
command runs, empty or whitespace-only output remains blank. After settlement it
shows the existing no-output or missing-result message. Returned logs, their ANSI
presentation, copied values and the command's status footer retain their owners.

Presentation activity is separate from execution ownership. Goal and foreground
command clocks stop in hidden documents or parked conversation surfaces and
calibrate from wall time when shown. Native working shimmer stops on AppState
background and reduced motion. None of these switches cancels remote execution,
changes queue/draft ownership, or removes visible running feedback.
Goal elapsed-time sampling retains its one-second cadence, but only publishes a
presentation update when a displayed duration can change: seconds during the
first minute, then whole minutes. Server accounting or Thread identity changes
replace the sampled baseline immediately. This avoids rerendering the Composer
for unchanged elapsed labels without changing execution accounting or Goal motion.

The compiler caches immutable prefix AST nodes using Marked's actual top-level
token boundaries, then parses the remaining tail. It retains the last block
and preceding live container, protecting lists, quotes, indented code and
partial markers that can rejoin them. Brackets, CRLF and display math
conservatively use full parsing for cross-block dependencies and normalization.
The dialect-scoped cache is bounded to 64 entries and one million key
characters; only matching preprocessed prefixes can be reused. Unclosed fences
retain their real delimiter length and source bytes, without synthetic triple
backticks. This is not a fully incremental parser: a long single block or
fallback still has whole-document costs.

Sessions reuse committed stable node/segment identities and reconcile only
the remaining tail, with cached word segmentation. Immutable parsing memo is
safe for abandoned renders; committed parsed nodes and identity counters move
only under the existing candidate CAS. Reused segments cease to be new entrants
without changing their keys. The bounded global segment reconciler preserves
same-position exact/growing text before globally reusing unconsumed exact text
occurrences. It owns segment keys and entering flags only; word segmentation,
semantic node identity and commit CAS remain separate.  Completion first uses the full parser, then retains
pure completed syntax by exact source and dialect in an LRU capped at 100 entries
and six million key characters. Streaming repairs never enter that memo. A
Session can reuse its committed completed snapshot; Host, theme, resource policy
and rendering stay in the View. Disposal clears compiler caches. Web Suspense
shows an empty busy slot rather than raw Markdown before the renderer is ready.
The Web document boundary uses ordinary React memoization across all props, so
unrelated parent updates skip the unchanged document tree. Source, completion,
dialect, theme, policy, resource and measurement callback changes still render;
runtime Context and document-local enhancement updates retain React's normal
invalidation. There is no custom comparator or second document cache.

Fade owns no execution state. Absolute segment starts have a real 96ms maximum
future wait, followed by the existing 150ms fade, excluding CPU/frame cost.
Remount computes remaining delay; elapsed motion is settled even without
animationend. Prose and resource labels share this scheduler. Completed
documents disable animation at the root and reveal all text. Replica
projection completion remains distinct from React commit and paint.

Tests cover session ordering, document equivalence and segment identity.
`scripts/smoke/conversation/smoke-streaming-presentation.mjs` checks actual Web DOM/CSS with
synthetic text in an isolated browser; it does not update a running Host or
establish real-provider throughput.

### User message code-block sizing

The Web user-message bubble owns its content-sized width and maximum width.
Fenced code inside it must participate in intrinsic width sizing, including
when the fence is the entire message; an inline-size containment used by the
shared code renderer must be lifted only at this bubble boundary. Long code
remains within the bubble's maximum width and scrolls in the code block's own
scroller. Empty-message presentation is based on actual text presence, not on
whether Markdown happens to produce visible inline prose. The shared code
renderer keeps its containment for assistant prose and other full-width hosts.

### Conversation content search deadlines

Native `thread/search` and `thread/searchOccurrences` may scan full raw history.
Their bounded 120-second request deadline passes through the shared runtime
protocol port, independently of the normal 30-second metadata deadline. Searches
remain serialized per source: changing or clearing input aborts presentation and
skips obsolete queued queries, while an already dispatched scan retains its
physical lifetime until completion or timeout. This avoids spawning overlapping
full-history scans. Late results still require the current query, connection and
authorization scope; a slow source does not prevent another source from rendering
its results. The longer deadline does not imply an indexed or faster search.

## Code language labels

Code block headers on Web and Native share the same language vocabulary, including
Arduino, Python REPL, PHP template and the patch alias for Diff. Normalization
ignores surrounding whitespace and casing. Unknown language tags retain their
original text; labels do not choose a highlighter or change code, wrap or copy policy.


## Skill display names

Skill and plugin display names retain canonical spellings such as GitHub,
OpenAI and SQLite, known initialisms and their plurals, lowercase title
connectors after the first word, and colon-separated namespaces. These labels
never replace the original identifier or resource path.


### Skill and Hook presentation compatibility

Skill read activities recognize local `.codex`/`.agents` skill roots, including
`.system` and `_import` scopes, cached plugin skills, and plugin-root `SKILL.md`
definitions. Directory markers and definition/script resource names are matched
case-insensitively; original path spelling remains the navigation identity.
Imported or plugin-root definitions retain the same skill name, wrench icon and
read-activity visibility rules as ordinary skill definitions. Parsing supplies
presentation metadata; it does not grant execution or filesystem access.

Hook details label system, MDM, cloud requirements/configuration and legacy
managed configuration sources as Admin. The original protocol source is retained
in statistics; unknown future sources remain Unknown. This projection changes
neither Hook execution nor approval policy.

### Relational style invalidation during editing

Message action rows keep their existing clock, pointer, keyboard, touch and
pending-fork disclosure. Relational selectors target their actual button,
hook-stat and fork-error owners with positive selectors; `:where` keeps the
previous type-level specificity. A negated universal child after `:has()` can
make unrelated Composer text insertion invalidate the conversation subtree.
Task-list paragraph detection still owns grid activation and checkbox spacing.
Non-checkbox children keep column two independently of that detection, because
grid placement is inert outside a grid. No DOM, event, layout owner or preview
lifetime change is needed.

### Code text selection

Streaming prose segments preserve native selection before React replaces a growing text node. The original text-node renderer owns one snapshot boundary across its existing word spans, rather than adding a React lifecycle owner for every word; boundary refs identify the existing contiguous span run and release ownership on unmount. Prose and code share endpoint capture and restoration, including UTF-16 offsets, direction and independently updating text roots. Existing source replacements keep native behavior; the original word segmentation, fade timeline, DOM structure, focus and scrolling keep their owners.

The code text renderer snapshots native selection endpoints before an append or
syntax-only DOM update and restores their text offsets afterwards. Preserve
selection direction and endpoints outside the code, without moving focus or
scrolling. A replacement that changes existing source does not restore stale
offsets. Streaming completion and theme recoloring keep the reader's selection;
source text, highlighting policy and the code surface keep their owners. When a range crosses code surfaces, capture both stable code roots and text offsets: a theme update may replace tokens at both ends in one commit. Resolve only roots whose existing source remains unchanged or extended.

Code-block clipboard extraction honors the same descendant exclusions as ordinary
Markdown when full-source metadata is absent, including cloned partial ranges
crossing code surfaces. Language captions, controls and hidden duplicates stay
out of quotes; raw source whitespace and Unicode remain intact. Explicit full
source metadata keeps its existing authority. The shared copy owner supplies
this rule to copy and Add to chat, without changing native selection or drafts.


### Conversation reference copy feedback

The shared ThreadActionOwner treats reference copying as one asynchronous row
action. Its keyed Workbench notice remains pending while the reference RPC and
clipboard write complete, then reports success only after the write resolves.
A failure uses the same error owner, and a late completion after unmount removes
the pending notice without reviving feedback. Menu closure does not cancel the
operation; the existing per-thread busy guard prevents duplicate submissions.

## Inline visualization content references

Assistant documents recognize a standalone `visualize` content reference using
U+E200 / U+E202 / U+E201 delimiters and a JSON object with an absolute HTML `path`,
optional `title` and optional `mode: "wide"`. The compiler creates a directive;
user-message dialect and code samples remain literal. Incomplete streaming
references stay hidden until complete. Stored source is unchanged, so reopening
history uses the same parsing and resource resolution.

The Web renderer consumes the Host's existing resource policy and file byte
lease. It reads only a local leased object, limits fragments to 1 MB and never
inserts executable HTML into the Workbench DOM. The opaque iframe grants scripts
without same-origin or host/device capabilities. Its CSP disallows connection,
frames, workers, forms and objects; static resources use the visualization CDN
allowlist. Theme aliases and a compact utility stylesheet are supplied by this
renderer. The initial implementation exposes theme only, not MCP tools, follow-up
messages or durable widget state APIs. It must not claim full host API parity.

The reading surface owns width; wide references borrow only available prose
space. Source-checked frame messages report bounded intrinsic height and enter
existing document measurement transactions. Failed loads offer retry and the
existing file-open action. Disposal aborts file work and ignores late results.
