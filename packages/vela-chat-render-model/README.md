# vela-chat-render-model

Host-aware presentation model for ChatUI.

This package converts `ChatSurface` into a renderer-friendly model: long user-message collapse, assistant markdown blocks, row keys, and mobile/desktop host policy.

It does not fetch data, parse OpenAPI DTOs, import React, or own CSS.
