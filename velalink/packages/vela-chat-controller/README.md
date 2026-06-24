# vela-chat-controller

Headless React controller for a single Vela chat session.

This package owns client-side session state: loading read models, subscribing to
SSE, full-history hydration, sending messages, cancelling turns, pending
requests, attachments, and agent config updates. It does not render UI, touch
Next.js routing, or own desktop shell chrome.

Conversation history loading is exposed as `historyPhase`.
`hydrating_history` means the controller is still auto-preloading older pages
for a desktop full-history session; renderers should show a page-level loading
gate and must not mount conversation scroll state yet. Host shells should pass
the phase through unchanged instead of recreating hydration branches.

Consumers pair this controller with `vela-chat-web` or another renderer.
