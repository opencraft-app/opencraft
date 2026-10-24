# Desktop product composition

The public Electron client owns the window, tray, profile directories, trusted
top-level-frame admission, protocol registration and daemon connection. It does
not create a private product account or expose a private account preload bridge.

A downstream build selects **three local source entries**:

```sh
OPENCRAFT_DESKTOP_PRODUCT_MAIN_ENTRY=/absolute/product/main-entry.ts \
OPENCRAFT_DESKTOP_PRODUCT_PRELOAD_ENTRY=/absolute/product/preload-entry.ts \
OPENCRAFT_DESKTOP_PRODUCT_IDENTITY_ENTRY=/absolute/product/identity-entry.ts \
OPENCRAFT_DESKTOP_PRODUCT_IDENTITY_CONFIG=/absolute/product/identity.json \
npm run build:electron:host
```

All three entries and the matching identity config are required. Invalid, missing or remote
entries fail the build. They are statically bundled into Main/Preload, not loaded
from a runtime URL or renderer configuration. Relative paths resolve from the
core repository root. The normal public build requires no downstream checkout.

Identity exports `resolveDesktopProduct(name): DesktopProductIdentity` and reads
the selected JSON config. The packaging hook checks the selected application ID
and product name against the identity recorded with the built Main bundle.
The downstream product owns
installed application IDs and legacy profile migration inputs. Core provides an
independent OpenCraft default. Main exports
`createDesktopProduct: DesktopProductFactory`; Preload exports
`createDesktopPreload: DesktopPreloadFactory`. The typed contract is
`apps/workbench-electron/src/product-contract.ts`. A trusted product receives its
resolved profile directory, application-owned private file storage, system-browser
and window actions, protocol registration and a narrow IPC handler registrar.
Every invocation is checked against the current Main window's top-level frame.
The product owns its login transactions, session schema, HTTP authority and
private channel names. Product preload contributions cannot replace core bridge
keys. Existing product compatibility channels and storage keys remain downstream.

Early OS callbacks wait for profile activation. A product may consume a callback
locally or return a promise for forwarding to another live process; a successful
callback-only forwarding launch does not open a second anonymous window. Window
navigation/closure cancels product interactions. Shutdown disposes the product
and retires its handlers before closing the daemon and static server; product
cleanup failure does not prevent those core owners from being closed. Activation
failure removes handlers already acquired by that attempt. A factory must unwind
its own partial non-IPC resources if it throws before returning a session.

`npm run test:electron-launch` checks the actual JS bundle closures, packaged
preload behavior, explicit-entry validation, handler admission, rollback and
disposal. These are Node/VM tests of the actual JS output, not an OS desktop,
native helper, signed installer or real external login acceptance result.
