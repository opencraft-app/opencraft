# vela-chat-query

React Query adapter for `velad` read models and command writeback.

This package owns React-side server state orchestration:

- stable query keys for `velad` read models
- hooks for cache-backed session list reads
- command mutations that update the relevant read-model cache

It does not own transport contracts, streaming conversation runtime, desktop
chrome, or host-local persistence. Keep those in `vela-chat-client`,
`vela-chat-controller`, `vela-desktop-shell`, and `vela-chat-host-state`.

