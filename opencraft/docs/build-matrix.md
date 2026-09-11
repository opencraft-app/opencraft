# OpenCraft Build Matrix

The repository has one shared semantic core and multiple delivery surfaces. A
successful TypeScript build is not evidence that every surface is deployable,
so each surface is an explicit matrix target with its own artifact contract.

| Target | Renderer/runtime | Output | Build host |
| --- | --- | --- | --- |
| `web-browser` | Vite, HTTP origin, same-origin `/appserver` gateway | Hashed static release | Linux/macOS/Windows |
| `electron-renderer` | Vite, relative assets, Electron loopback origin | Relocatable renderer tree | Linux/macOS/Windows |
| `electron-host` | Sandboxed Electron main/preload + static loopback origin + independent OpenCraft Daemon | Main/preload, daemon executable and pinned DSH runtime | Linux/macOS/Windows |
| `electron-macos-arm64-zip` | Electron host + renderer | Apple Silicon `.app` ZIP | Linux/macOS |
| `electron-macos-arm64-preview` | Electron host + renderer | Isolated Apple Silicon ad-hoc `.app` ZIP | macOS |
| `electron-macos-arm64-dmg` | Electron host + renderer | Apple Silicon DMG | macOS |
| `electron-macos-x64-zip` | Electron host + renderer | Intel `.app` ZIP | Linux/macOS |
| `electron-macos-x64-dmg` | Electron host + renderer | Intel DMG | macOS |
| `electron-linux-x64-appimage` | Electron host + renderer | Portable x86_64 AppImage | Linux |
| `electron-linux-x64-rpm` | Electron host + renderer | TencentOS/RHEL/Fedora RPM | Linux |
| `electron-linux-x64-deb` | Electron host + renderer | Debian/Ubuntu amd64 package | Linux |
| `expo-web` | Expo Router + Metro Web | Expo static export | Linux/macOS/Windows |
| `expo-ios-bundle` | React Native + Metro | JS bundle and assets | Linux/macOS; native archive on macOS |

The browser and Electron targets intentionally do not share a built `index.html`.
They share source and chunks, but have different origin contracts. Electron
serves `electron-renderer` from a private, static-only loopback origin; loading
with `file://` would weaken navigation and asset policy. AppServer traffic does
not pass through that HTTP origin.

Commands:

```sh
npm run matrix:list
npm run matrix:check
npm run matrix:build -- web-browser electron-renderer electron-host
npm run matrix:build -- electron-linux-x64-appimage
npm run matrix:build -- electron-linux-x64-rpm
npm run matrix:build -- electron-linux-x64-deb
npm run package:electron:mac:arm64:preview
```

Desktop packaging jobs are downstream targets. Linux AppImage, RPM, and DEB
consume the same release-minified renderer and protected host. RPM is the native
TencentOS/RHEL/Fedora installation contract; AppImage is the portable smoke
artifact; DEB covers Debian/Ubuntu. Application ZIPs can be
cross-built, while DMG creation, signing, notarization, and the final smoke test
run on macOS. Every package consumes only the verified `electron-renderer`
artifact and separately compiled Electron host.

The explicit macOS preview command is a local QA contract, not a distribution
artifact. It writes below `release/preview`, uses product name `OpenCraft
Preview`, Bundle ID `ai.lightvela.vela.preview`, and the independent
`@vela/workbench-electron-preview` profile. It disables certificate discovery,
prunes foreign-platform `node-pty` prebuilds from both packaged runtime trees,
and applies one consistent ad-hoc hardened-runtime signature and entitlements
to the Electron helpers and outer app before ZIP creation. Release ZIP/DMG
commands retain their Developer ID and notarization responsibilities.

The Electron host never loads the application with `file://`, but its loopback
server is only a static asset owner. Renderer App Host frames cross a transferred
`MessagePort`; Electron Main relays those frames over authenticated local IPC to
the separately bundled OpenCraft Daemon. Only the daemon starts the pinned DSH
runtime, local Agent AppServer and physical transports. The desktop build has no
`/appserver` proxy or `OPENCRAFT_APPSERVER_URL` fallback.

The `web-browser` artifact does not contain the local Host, DSH, Node APIs, or
their extension entry. Its `/appserver` endpoint is owned by the deployment
gateway and may route to a cloud Host. This is a packaging boundary: desktop
ships the Agent next to the application; Web ships only the AppServer client.
