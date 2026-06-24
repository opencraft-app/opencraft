# vela-chat-debug

CDP-friendly debug contract for the ChatUI.

This package defines the browser automation surface exposed as `window.__VELA_CHAT_DEBUG__`.
It owns debug snapshot and console event shapes, but does not import React, fetch data, or render UI.

`snapshot.conversation` summarizes the app-side conversation runtime. Its
`scroll` child is diagnostic-only: it exposes sticky-follow state and the latest
bottom-anchor blocked reason, plus session route-resume status, so CDP tests can
explain scroll failures without reading React internals.
