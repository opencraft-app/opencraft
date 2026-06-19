# conversation-runtime/strategy

Platform rendering strategies for conversation stream items.

Change here when the Web list mounting strategy, virtualizer, overscan, or
measurement policy changes.

Use `strategyResolver.ts` for pure, host-aware strategy-name decisions. It must
stay importable from Node tests and should not import React, CSS modules, or
concrete strategy implementations.

Use `strategyRegistry.ts` when React rendering code needs the concrete
`ConversationStrategy` object for the resolved strategy name.

Do not:
- Build stream items here.
- Parse OpenAPI wire fields here.
- Render individual block internals here.

Depends on:
- `conversation-runtime/model`
- React

Used by:
- `components/conversation/VelaTurnList.tsx`
