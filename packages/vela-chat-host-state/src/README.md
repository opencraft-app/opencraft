# Host State Source

This folder defines typed state slots over a tiny synchronous key-value
interface. It is deliberately small so future agents can find the correct
boundary quickly:

- `conversationScroll` is consumed by the ChatUI scroll runtime.
- `composerDraft` is consumed by the headless chat controller.
- `createVelaShellLayoutStore` is consumed by desktop/mobile host shells.

Do not add velad facts, secrets, or OpenAPI DTOs here.
