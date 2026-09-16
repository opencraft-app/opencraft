# File manager presentation boundary

`TatFileManagerPanel` is the sole owner of the Bot-scoped file client, managed-root
checks, reconnect-once behavior, file operations, capacity requests and late-result
identity guards. Paths remain under `/home/agentuser`, with the original `.hermes`
initial directory. Upload/download limits, commands, permission checks and retries
are not implemented by the view layer.

Download service-worker registration, MessagePort ACK/backpressure/cancellation,
iframe triggers, timeout cleanup, unmount handling and the memory fallback all
remain in this controller. UI cancellation is not remote cancellation.

`FileManagerEntryView` receives only strings, an icon, selection/directory flags,
optional editor content and callbacks. Its native button keeps single selection;
Space selects and Enter on a directory delegates to the original open action.
The editing branch has no wrapping button, so inputs/buttons are never nested.
`FileManagerInlineEditor` receives a ref, value, labels, pending state and actions.
It does not save on blur or own file commands. Enter confirms; Escape cancels.
The controller records only explicit cancel focus intents with the current Bot ID,
then restores the stable toolbar trigger after the input unmounts. Path-input Escape
keeps its existing focus and draft-reset behavior.

The controlled `Switch` delegates to the original hidden-file toggle, including
clearing a now-hidden selection. `AgentTooltip` portals explanations; only disabled
controls need a focusable explanation wrapper. No bulk controls or additional file
delete confirmation were introduced. Narrow rows wrap metadata and inline editors
instead of clipping controls or suppressing document overflow.

Dependencies: the pure view uses React, existing Lucide icons, `Button` and `Input`;
it imports no repository, context, file-client or remote types. The controller also
consumes shared `AgentState`, `AgentTooltip` and `Switch` under `agents-ui`.

The original client/limit/managed-root/reconnect/download tests remain. Adjacent
controller tests cover Portal semantics, keyboard selection, controlled hidden
state, cancel focus and exact command targets. The dedicated global fixture uses
actual English dictionaries, not translated mock labels. All file and network
operations in tests are synthetic.
