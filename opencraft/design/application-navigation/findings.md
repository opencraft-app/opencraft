# Findings

Codex recovered renderer: render-app-shell-router-09835 wraps MemoryRouter and exposes useNavigate via the scope bridge. useNavigateIfChanged compares full pathname/search/hash. WB App chooses memory for IPC and browser otherwise; goHome, navigateToSession, goBack are distinct; keepAlive is independent. BB BrowserRouter supplies paths, useAppSettingsRouteMemory remembers explicit app/settings destinations; its history controls project PUSH/REPLACE/POP entries.

Current faults reproduced: same-conversation replace changes History but not snapshot; late prepare overrides Settings; failed replace rollback loses the app route; untagged root POP ignored; forward projection resets on router reconstruction. Hostless is a separate boolean return model, and Chat invokes closeSettings/back rather than a destination.

References are read-only. Recovered Codex/WB are not proof of every upstream runtime guarantee. No Graphify.
