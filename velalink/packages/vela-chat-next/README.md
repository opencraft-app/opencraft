# vela-chat-next

Next.js host adapter for Vela Chat.

Use this package when another Next.js page wants to embed the reusable ChatUI for an existing velad session. It wires the browser host to `useVelaChatSession` and renders `VelaChatWeb` in contained mode.

This package is not a new chat renderer, API client, debug launcher, or desktop shell. Keep those responsibilities in their existing packages.
