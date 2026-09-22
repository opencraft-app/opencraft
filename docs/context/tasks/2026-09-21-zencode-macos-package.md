---
id: task-zencode-macos-package-20260921
type: task
scope: Rebuild and package the current OpenCraft Mac App including ZenCode.
triggers: ["ZenCode Mac package", "repackage OpenCraft App", "signed ZenCode preview"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [opencraft/docs/build-matrix.md, opencraft/apps/workbench-electron/package.json]
status: retired
reviewed_at: 2026-09-21
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_refs
User requests another packaged App after ZenCode theme implementation.

## non_goals
- No /Applications overwrite, stopping existing windows, commit/push, upload/release or Apple notarization submission.
- Preserve dirty working tree and existing release directories.

## context_receipt / history_context
- Root/OpenCraft AGENTS, maintenance verification checklist and build-matrix macOS signing runbook.
- Router returned no match. Read package-macos-preview.mjs (deletes old preview output), so use electron-builder with a fresh explicit output instead.
- Read package configuration, start-electron launcher, afterPack helper and current Vite changes; non-Electron embedded-build changes are separate.

## acceptance / validation
- Native arm64 release build with current source, Developer ID signed .app and ZIP in a new directory.
- Signature, archive integrity, packaged renderer/daemon identity and isolated launch/ZenCode selection.
- Explicitly report lack of notarization; never bypass Gatekeeper.

## handoff
- Complete: release/signed-20260921-113317-zencode contains Developer ID signed arm64 OpenCraft.app and a 197 MiB ZIP. Build ID 20260921113318-9213bbcb5d56. Detailed hashes/source receipt in its BUILD-INFO.md.
- Rebuilt Renderer, Daemon and Main/Preload; packaged Renderer version and Daemon match fresh outputs byte-for-byte. Tracked source fingerprint unchanged across build.
- 33 focused control/theme/window/launch tests passed before release build. Deep/strict codesign and ZIP integrity passed; signature reverified after launch.
- Gatekeeper rejected as Unnotarized Developer ID; no notarization was submitted and no security bypass performed.
- Real packaged executable launched with isolated user-data, OpenCraft home/model storage. Verified build ID, Settings ZenCode selection, light/dark semantic surfaces and reload persistence. Final page is Appearance / ZenCode / Light; app remains open for the user.
- Logs, app screenshots and launch-report.json under /tmp/opencraft-zencode-package.fg3P4X. An initial automation retry was needed to wait for the reloaded home UI before opening Settings; final full verification passed.
- No old output deleted, no /Applications install, no existing window/profile touched, no commit/push/publication.
