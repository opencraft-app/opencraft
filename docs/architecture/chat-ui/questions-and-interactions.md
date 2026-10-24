# ChatUI: Questions and interactions

[Architecture index](../../chat-ui-architecture.md) · [Documentation index](../../README.md)

### MCP elicitation presentation

The shared elicitation normalizer owns field options and metadata routing for
the existing interaction views. Array fields retain titled string constants
from `items.anyOf`, including their order and defaults; explicit field `oneOf`
choices take precedence. Required selections must remain selectable before the
existing typed form response is submitted.

An empty-field request from `browser` or `browser-use` with a nonblank metadata
`origin` and offered persistence scopes uses the tool-approval view. Its existing
actions submit once, session or always responses only as offered by the request.
Valid tool suggestions and URL requests retain their own routing. Presentation
classification does not grant permissions; the Host remains the authority for
the request and its response.

The shared compiler's application link scanner returns raw label/destination and
UTF-16 offsets. It uses the existing non-nested destination grammar: the label's
`](` boundary takes priority even after a backslash, while escaped destination
parentheses remain content. CR/LF reject a candidate; malformed candidates do
not prevent a later valid link. Tokenizer unescaping, renderer resource admission
and Host selection keep their existing owners. This grammar is a compatibility
contract, not a claim to implement every Markdown dialect.

The compiler's math extensions retain the application grammar: display uses
`$$` or backslash-brackets with horizontal-only trailing line admission; inline
uses backslash-parentheses and rejects LF inside the first closure. Raw token
consumption and trimmed formula source remain distinct. Compiler placement,
code fences and streaming identity keep their owners.

User-message block normalization retains one list context through indented
continuations and indented fences, separates unindented kind/prose transitions,
and resets on a zero-length line. CR/CRLF normalize globally to LF before this
projection, including fenced lines. It does not own general streaming repair,
compiler identity or resource admission.

## Agent-originated async questions

The related contracts are grouped in the [architecture index](../../chat-ui-architecture.md).

### Hermes direct approval ownership

Direct/embedded Hermes Threads translate native `approval.request` into
`item/commandExecution/requestApproval`. The existing OpenCraft approval card
owns presentation; Hermes owns the pending request and authorization policy.
Native request ID plus durable Thread ID identifies the prompt independently
of its revocable live session route. Each prompt has its own synthetic Item ID,
so the interaction ledger cannot replay another prompt's grant.

The optional OpenCraft `approvalScopes` extension carries the provider's offered
`once/session/always/deny` scopes. Canonical `accept`, `acceptForSession`, and
`decline/cancel` map to native `once/session/deny`. An explicitly offered
persistent grant uses `{decision: "accept", _meta: {persist: "always"}}`;
it is not a Codex exec-policy amendment and cannot be sent to an unextended
Codex request. Web and Native require a separate confirmation for that scope,
using their existing interaction card controls and design tokens. Backend
restrictions such as smart denial and disabled permanent grants remain binding.

Resume restores `pending_approval`; a quiet heartbeat is not completion while
approval is outstanding. Disposing a View/bridge never answers it. Native tool
completion and successful answers refresh the oldest pending approval snapshot,
not a fabricated complete queue. Snapshot absence clears stale prompts; newer
events and revoked live-session routes fence late snapshots. Failed RPCs or
`resolved=false` retain the approval. A delivery failure needs reconnect to
restore the response channel; it must not manufacture an empty or approving
response. Follow-up snapshot failure cannot turn an accepted grant into a
request to send it again. Group-conversation approval routing is unchanged.

Codex `agentMessage` Items with `delivery: "async"` and `questions` are not
`item/tool/requestUserInput` server requests. The former remain ordinary
assistant messages: their question cards are projected from the Item ID and
question index, stay visible in the Timeline, and do not replace the Composer
or suspend the Turn. The latter use the existing blocking interaction response
port. Device type must not select between these two protocol forms.

An async question's title is model-authored Markdown, not a form-control label
string. Web renders it through the same Chat Document and resource policy as
assistant content, so safe links are usable and unsafe targets stay inert. The
card gives its fieldset an accessible name from the rendered title instead of
placing block Markdown inside a `legend`. Suggested answer strings remain
literal labels and submission values; presentation must not rewrite the answer
envelope or create a second Markdown/link policy.

An async answer is a normal user submission carrying Codex's
`send_user_message_question_reply` envelope. The active Turn uses the steer
submission path; an idle Thread starts a normal Turn. The reply is rendered
readably in the user message, while its structured question ID resolves only
that card. Later ordinary user messages supersede unanswered cards. Pending,
queued, sending, uncertain and answered states derive from the shared Timeline
and follow-up queue so a second subscriber or a reconnect sees the same result.

Resolved async questions use a compact disclosure row. Its summary owns the
minimum pointer/touch hit height; the closed container adds no vertical panel
padding. Expanded question content retains its own bottom inset. Answered cards retain this geometry and native disclosure behavior. Superseded
questions leave no status card or disclosure: their original Markdown title stays
in the ordinary message history, with no deletion or synthesized answer.

The Web/Electron inline async answer textarea submits with Enter or Cmd/Ctrl+Enter;
Shift+Enter inserts a newline. IME composition (including legacy key code 229),
Alt+Enter and held-key repeats do not submit. Keyboard and button actions use the
same guarded answer callback and the Conversation's existing synchronous in-flight
guard; empty, queued, disconnected or resolved answers cannot send. Failed sends
retain the draft for retry. This textarea policy does not change the main
Composer's device-specific Return behavior or blocking interaction response port.
Regression: `scripts/smoke/conversation/smoke-async-question-keyboard.ts` mounts the real Conversation
and replaces only its external answer port.

### MCP approval multiline parameters

Approval string values become expandable above 120 characters or four newline-separated
lines. The initial text preview stays at four lines; Expand reveals the original value
and Collapse restores the compact view without submitting an approval. The shared
chat-core presentation helper owns this policy. Short multiline text must not stretch
the approval card merely because its character count remains below the threshold.
The existing elicitation tests, fixture and smoke exercise this boundary.


### Blocking question input continuity

A pending question's request ID and question definitions own its page and drafts.
Equivalent definitions reconstructed during a Replica refresh preserve the current
page, selected options, freeform text, input DOM, focus and selection. A Thread
metadata update, such as renaming the conversation, does not create a new question.
A different request ID or changed question definitions reset the input state.
The question panel stabilizes its typed JSON definitions before initializing its
local input state; array allocation is not a user-visible reset signal.

### Question keyboard composition

Pending question and option picker cards leave keyboard ownership with the input
method while composition is active. Enter and Escape must not submit, skip or
dismiss the request during composition. The option picker also guards implicit
form submission using the input's composition lifecycle; ignoring a composing
keydown alone does not prevent the browser from submitting a form. Ordinary
Enter and Escape retain their existing answer and dismissal actions once
composition has ended.

Question and option-picker inputs leave compatibility keyCode 229 with the input
method, including the final noncomposing Enter or Escape after compositionend.
The option-picker input also prevents that Enter's implicit form submission;
the original composition flag still gates programmatic submits during preedit.
Ordinary Enter submits or advances and ordinary Escape cancels through the
existing response owner. The original question-extensions smoke covers native
composition, both compatibility keys, unchanged input identity/focus/draft and
ordinary actions on desktop/touch in both themes, retaining its full plan,
multi-question, request replacement, option and setup checks.

Workspace file search owns its filesystem session in the panel startup effect.
Session readiness reruns the existing query debounce with the latest input;
queries typed or cleared before startup completes are never replayed from the
startup closure. Retired sessions stop even when their startup resolves late.
The original workspace media smoke retains its preview assertions and covers
latest pending input, cleared input and closure during pending startup.

Shared ModalSurface leaves Escape dismissal with Radix after composition ends.
While a native key event reports isComposing or the compatibility keyCode 229,
the input method owns Escape: prevent Radix dismissal at onEscapeKeyDown, before
the document capture listener can close the dialog and unmount its query.
The original conversation-search regression drives Chromium composition and
ordinary Escape, retaining query, input identity and focus on desktop and touch.

The complete search fixture supplies the same QueryClientProvider required by
the AppShell update notice. Touch navigation targets the persistent sidebar
action owner, rather than the desktop-only stationary placement marker.
These fixture boundaries retain all original native interaction assertions.

Composer model and permissions menus retain the native editor focus lease on touch. While
Escape reports isComposing or compatibility keyCode 229, the input method owns
it: both the existing editor capture listener and Radix onEscapeKeyDown leave
the menu open. After composition, ordinary Escape retains native dismissal and
focus behavior. The original picker-focus smoke covers model and permissions
menus with native composition and Chromium keyboard input, while preserving
its original selection, scrolling, geometry, outside-focus and unmount checks.

### Pending interaction recovery motion

Pending question, approval and setup panels consume their owning Conversation's
entry-motion context. Recovered baselines and retained View returns paint fully
visible and stationary from the first frame. New live requests keep their normal
entry animation; reduced-motion preferences suppress it. Equivalent request
updates retain the same panel node and input transaction. Question page changes
keep their separate user-initiated transition. No request is authorized or answered
by restoring its presentation.

### Pending interaction draft recovery

The Application owns pending input checkpoints for each Host, Thread and View.
A browser connection gap may remove and remount the question, option picker or
MCP form panel; equivalent requests in the same turn recover their entered text,
choices, typed form values and question page. Presentation IDs and fresh transport
allocations do not create a new input transaction. Changed request IDs, turns or
input definitions create a fresh draft. A successful response releases only its
own checkpoint, so a late completion cannot erase a newer request's input.

These checkpoints contain input and read-only parameter disclosure state, live in
Application memory and end with that Application. They neither keep an obsolete request actionable nor authorize
or replay a response; the active Host request remains the response authority.
The temporarily removed DOM and its focus are not persisted across a connection
gap. Supported setup pickers follow the input contract described below.

Pending MCP tool approvals retain expanded parameter values and Show more state
through a connection gap. A different request, turn or parameter definition starts
a fresh review. The permission menu, permission choices and execution state are
not checkpointed; recovery never grants permission or sends a response.

### MCP approval keyboard ownership

MCP tool approvals preserve the focused control's native Enter action: Deny
declines, scoped permission menu entries retain their chosen scope, and parameter
disclosures only expand or collapse. The card's window shortcut ignores already
consumed events and editable fields. Unfocused Enter still allows once and Escape
still declines; keyboard focus never silently changes the selected permission.

Ordinary command and permission approval shortcuts also ignore already consumed
keyboard events. Escape used to dismiss a foreground menu or dialog must not
answer a background approval. The focused controls, permanent-approval confirmation
and unconsumed body shortcuts retain their existing actions and scope.

### Setup interaction drafts

Supported setup role/task/context requests use the same pending-input checkpoint
as questions and forms. Keep unsubmitted role choices, the first-task choice or
freeform text, and the context search and Browse state through a browser connection
gap. A different request, turn or setup definition starts fresh. Explicit successful
responses release their own checkpoint; inputs never cause an automatic response.

The context catalog, connected-source selection, authentication, installation and
in-flight connection status keep their existing owner. A search checkpoint grants
no source access. Dynamic-tool compatibility support does not imply that a product
registers these tools by default; validate the actual tool registration separately.

运行中的普通命令在 `STEPS_COMMANDS` 的 Activity 标题保留具体原命令；分类器返回一个或多个 `unknown` action 仍属于普通命令，不能因 action 列表非空而退回泛化标题。空白命令回退 `Running command`，`STEPS_PROSE` 保持简洁标题；read/search/list 继续消费各自语义呈现，shell 包装、执行事实与复制内容不在标题层改写。


### Asynchronous question cards

A pending asynchronous question uses one bounded reading surface, regular Chat
copy, shared single-choice rows and the existing primary Button. The complete
question stays intact; the renderer does not guess a shorter title. Choice state
uses a quiet theme-owned selection surface, independently of neutral keyboard
focus. Coarse input retains 44px targets. Controls and feedback use the current
locale. Sending, queued, disconnected and unconfirmed delivery remain distinct;
selection and draft survive them, and only the existing answer port submits.

The question itself leads the card; omit a repeated input-needed heading and
permanent usage instructions. The footer keeps one explicit, compact send action
and shows text only for real delivery or failure feedback. Quiet choice rows use
the shared control appearance with independent selected, pressed and keyboard
focus treatments. Freeform input starts with three readable lines, grows with
the draft and available width, then scrolls within a viewport-bounded height.
Theme changes preserve the same input node, draft, selection and focus.

Confirmed answers collapse to a read-only result with the actual accepted reply
and an accessible disclosure for the original question. The ordered Chat
projection supplies both state and reply, including another client's accepted
answer; a local draft or resolved send promise cannot fabricate acknowledgement.
A superseded question has no invented answer. Failure retains the draft and uses
the Workbench notification owner with a stable footer hint, rather than adding a
layout-changing diagnostic block.

Question card presentation and its stylesheet are loaded together when a timeline contains a question. The pending fallback keeps the original question readable; theme and draft state stay with their existing owners, and the card is not part of the required startup CSS graph.
