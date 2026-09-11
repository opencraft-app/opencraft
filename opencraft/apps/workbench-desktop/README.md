# Workbench Desktop

Electron host for the shared `workbench-web` renderer. This package will own
window lifecycle, native menus, preload IPC, SSH process transport and app
updates. It must not fork Chat View or design-system components.
