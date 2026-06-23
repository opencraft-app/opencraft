# components/workbench

Change here when the top-level Chat workbench layout changes.

`ChatWorkbenchView` owns reusable ChatUI page phases. In particular,
`historyPhase === "hydrating_history"` renders
`ConversationHistoryHydrationView` before the conversation, scroll controller,
and composer are mounted. Keep that gate here so Next, Electron, and future
hosts do not each invent their own preload branch.

Do not:
- Fetch data here.
- Parse wire fields here.
- Inline individual block renderers here.
- Derive conversation history state from cursors or route parameters.

Depends on:
- `adapters`
- `components/conversation`
- `components/composer`
- `styles`

Used by:
- `index.tsx`
