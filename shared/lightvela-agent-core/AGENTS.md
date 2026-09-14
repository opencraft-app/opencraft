# LightVela Agent Core

This package owns renderer-neutral Agent/Bot identity and application policy.
mono2 Web is the first behavioral consumer; other surfaces adopt only contracts
already characterized there.

Hard boundaries:

- no React, DOM, React Native, Electron, Next or router imports;
- no network, storage, timers, analytics, i18n or product copy;
- distinguish environment, physical instance, product Bot and Hermes Profile;
- adapters retain server authority for authentication, entitlement and mutation;
- every exported behavior requires table-driven consumer tests and strict typecheck.

Do not add a platform convenience to core. Define the smallest port and inject it
from the consumer instead.
