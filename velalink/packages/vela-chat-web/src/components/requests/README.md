# requests

Pending request dock for approvals and confirmations.

Change here when the workbench request dock needs a different layout or a new
OpenAPI-backed request response shape.

Do not:
- Parse provider raw events, timeline items, `payload`, or `backend_ref` to
  invent request actions.
- Add transcript rows for pending requests.
- Move request rendering into the conversation stream without first adding an
  explicit auxiliary lane or OpenAPI conversation contract.

Depends on:
- `vela-chat-render-model`
- `components/workbench`
- `styles`

Used by:
- `components/workbench/ChatWorkbenchView.tsx`

This folder renders the request state already normalized by `vela-chat-render-model`.
It must not inspect provider raw events, timeline items, or OpenAPI wire DTOs directly.
