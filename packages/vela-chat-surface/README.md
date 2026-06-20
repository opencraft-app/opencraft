# vela-chat-surface

Semantic chat state for all renderers.

This package normalizes OpenAPI read models into a stable `ChatSurface`. It preserves debug provenance such as source event IDs and cursors when the OpenAPI read model provides them; it does not invent source event IDs from row, item, or request IDs.

It does not render UI, split markdown blocks, choose mobile/desktop layout, or call `fetch`.
