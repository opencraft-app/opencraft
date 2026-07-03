# components/workbench

Change here when the top-level Chat workbench layout changes.

`ChatWorkbenchView` owns reusable ChatUI page phases. In particular,
`historyPhase === "hydrating_history"` renders
`ConversationHistoryHydrationView` as a lightweight overlay while the active
session conversation, scroll controller, and composer remain mounted. Keep that
gate here so Next, Electron, and future hosts do not each invent their own
preload branch.

`ConversationScrollInspector` is an optional dev-only diagnostic view over the
scroll controller debug model. It is read-only and must not read wire DTOs,
storage, or OpenAPI fields.

Do not:
- Fetch data here.
- Parse wire fields here.
- Inline individual block renderers here.
- Derive conversation history state from cursors or route parameters.
- Persist scroll state directly from diagnostic UI.

Depends on:
- `adapters`
- `components/conversation`
- `components/composer`
- `styles`

Used by:
- `index.tsx`
