# Findings

- Local profile advertises no filesystem browse roots; Add project is disabled.
- DSH adapter implements engine-derived project/list but no project/create.
- Electron has a trusted same-origin main-renderer IPC boundary, but no folder dialog.
- Native picker returns only a validated local path; Host product repository owns project identities and persistence.
- Previous provider-default context-menu modifications are preserved.
- Host project RPC can be independent from engine availability; explicit projectStorageDirectory allows isolated tests.
- Existing shared JSON lock/atomic-write utility is reused, with no DSH project catalog fallback.
