# vela-chat-controller

Headless React controller for a single Vela chat session.

This package owns client-side session state: loading read models, subscribing to
SSE, full-history hydration, sending messages, cancelling turns, pending
requests, attachments, and agent config updates. It does not render UI, touch
Next.js routing, or own desktop shell chrome.

The controller is transport-injected. Local desktop/web hosts can let it build a
default browser stream transport from `baseUrl`, but remote hosts should pass a
prebuilt `client` and `eventStreamTransport` into `useVelaChatSession`. That
keeps TAT/TSSH forwarding, auth leases, remote-port mapping, and host-specific
failure classification outside velalink while reusing the same velad HTTP API,
SSE cursor recovery, and UI state model.

Conversation history loading is exposed as `historyPhase`.
`hydrating_history` means the controller is still auto-preloading older pages
for a desktop full-history session; renderers should show a page-level loading
gate and must not mount conversation scroll state yet. Host shells should pass
the phase through unchanged instead of recreating hydration branches.

Consumers pair this controller with `vela-chat-web` or another renderer.
