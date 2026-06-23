# vela-chat-next

Next.js adapter for embedding Vela Chat inside another web page.

This package is intentionally thin:

- it creates or accepts a `VeladClient`
- it wires `useVelaChatSession` to `VelaChatWeb`
- it creates browser client state for scroll and draft state when the host does not provide one
- it renders the ChatUI in `contained` layout so the host page owns the outer shell size

It must not import the debug session launcher, the Electron desktop shell, or route-specific app code. A host page owns session selection, navigation, authentication, and any chrome around the embedded chat panel.
