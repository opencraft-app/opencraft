# LightVela Platform Extension

First-party trusted platform base for OpenCraft. It owns the shared LightVela
account implementation, OAuth callback lifecycle, account View and authenticated
gateway transport. `lightvela.hermes` and `lightvela.collaboration` receive the
same application-owned `LightVelaAccountService` instance.

An authenticated account does not require a Hermes Bot before opening
Collaboration. Bot readiness is an Agent/Host concern owned by Hermes.

Validation:

```bash
npm run typecheck --workspace @opencraft/plugin-lightvela-platform
npx tsx --test tests/lightvela-platform-plugin.test.ts tests/lightvela-account-port.test.ts
```
