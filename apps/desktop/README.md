# OpenCraft desktop

This workspace hosts the shared `apps/workbench-web` renderer in Electron. It owns
the window lifecycle, native menus, preload IPC and desktop integration. Chat
views and design-system components live in the shared renderer and packages.

From the repository root, run `npm run build:electron` to build the desktop app.
See the [build matrix](../../docs/build-matrix.md) for platform packaging commands.

The npm workspace is `@opencraft/desktop`. Keep the packaged application name in
`build.extraMetadata.name` stable across upgrades. Electron Builder derives the
updater cache directory from that name.
