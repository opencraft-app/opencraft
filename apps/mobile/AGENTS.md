# Mobile container

Follow the core AGENTS.md, design.md and docs/mobile-workbench-container.md.
The only public entry packages the actual Web Workbench. Do not restore a parallel
RN chat, composer, settings or workbench state tree. Expo owns native lifecycle,
safe area, recovery, source selection and device adapters, never conversations.

The default code is bundled. The user may explicitly select a self-hosted HTTPS
website in native settings. This is not an automatic fallback. Validate the URL,
keep source changes transactional and fence retired views/messages. Remote sites
must not receive the bundled document's privileged identity, credentials or native
bridge. The native source control must remain usable on network/process failure.
Preserve bundle IDs, user data and the independent trusted product entry resolver.

Expo Go is a required development preview. Use compatible SDK modules; native
material/permissions have runtime capability fallbacks. Do not require a custom
native client for the basic workbench. Protocol tests, browser rendering, native
JS bundles, signed binaries and physical devices are distinct evidence.

Web owns keyboard geometry and memory navigation. Apply outer safe area once;
Android back uses Web navigation for bundled content and WebView history only in
website mode. Resize/foreground must not remount the working app.

Downstream accounts and packaged Bot consoles stay product-owned. Inspect actual
product consumers when moving/removing utilities; no private code enters core.
Use shared self-drawn icon components, never Lucide. Keep required third-party
notices. Temporary assets, logs, dependencies and preview URLs stay out of Git.

Build: npm run build:web-workbench --workspace @opencraft/mobile.
Preview: npm run dev:expo -- --go. For external iPhone links use the core
opencraft-expo-cf-preview skill, verify the actual external manifest, and report
unverified hardware/auth/model paths honestly.
