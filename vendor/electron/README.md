# OpenCraft Electron fork

This directory owns the Electron source fork as an immutable upstream revision
plus an ordered, SHA-256-verified patch series. `manage.py checkout` materializes
the full source on an `opencraft/v44.8.0` branch under `.work/src/electron`.
The source definition, patches and build entry live in this repository; no
separate Electron fork repository or manually maintained source copy is needed.

The initial baseline is Electron **44.8.0**, commit
`60169b45c12488c6fda237af7f6425526a7ce5f0`, with Chromium **152.0.7977.167**.
`fork.json` is authoritative. Generated sources, dependencies and build outputs
are ignored; local changes are rejected rather than reset or overwritten.

## GitHub Actions native build capacity

`Electron fork source` runs the Python regression suite and materializes/verifies
our pinned patch series on Linux x64, Windows x64, macOS arm64 and macOS x64.
It also runs actionlint, including expression validation. Source CI does not
claim that Chromium compiled or native IME passed.

Run `Electron fork native artifacts` with `mode=validate` to repeat the selected
native source checks on ordinary GitHub-hosted runners. `mode=build` additionally
compiles Electron, extracts `dist.zip`, runs the focused native desktop probe,
stamps the file inventory, and packages OpenCraft through its verified fork
wrapper. Configure each selected target's repository variable first:

| Target | Repository variable (JSON) |
| --- | --- |
| Linux x64 | `ELECTRON_BUILD_RUNNER_LINUX_X64` |
| Windows x64 | `ELECTRON_BUILD_RUNNER_WINDOWS_X64` |
| macOS arm64 | `ELECTRON_BUILD_RUNNER_MACOS_ARM64` |
| macOS x64 | `ELECTRON_BUILD_RUNNER_MACOS_X64` |

For example, a self-hosted Windows image can use
`["self-hosted","Windows","X64","electron-build"]`; an organization larger
runner uses its configured label as a JSON string. Missing/malformed variables
fail in the planning job, rather than queueing nonexistent runners. Runner
configuration/billing is an administrator operation; this workflow does not
create runners or purchase capacity. Ordinary hosted runners' standard 14 GB
SSD allocation is insufficient for a complete Chromium checkout/build.

Provision images according to the pinned Electron version's native build
prerequisites: Linux build libraries and Xvfb, the supported macOS Xcode/SDK, or
Windows Visual Studio C++/Windows SDK plus Git Bash. Windows builds use the
locally provisioned toolchain (`DEPOT_TOOLS_WIN_TOOLCHAIN=0`). The script checks
target OS/architecture and at least 200 GiB **free** scratch space before sync;
provision 300+ GB SSD and 32–64 GB RAM as a starting point, then size against
measured build usage. OS dependencies and SDK installation belong to the runner
image, not an unprivileged workflow step. The runners need a usable desktop
session for the visible macOS/Windows probe; a Windows service-only session is
not equivalent to interactive IME testing. Linux probes run under Xvfb.

Archives retain executable modes and macOS framework symlinks. Extraction
rejects traversal, duplicate/case-colliding paths, escaping/cyclic links and
writes through links, and publishes the directory only after validation.
`dist.zip` is uploaded unchanged together with its inventory marker and probe
logs; uploading an extracted tree would lose permission/link metadata. Packaging
uses native absolute paths even on Windows. These are unsigned CI artifacts;
signing/notarization and physical-device input acceptance remain separate.

Official references: [GitHub runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Actions job conditions and matrix ordering](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax-for-github-actions#jobsjob_idif),
and [Electron build prerequisites](https://www.electronjs.org/docs/latest/development/build-instructions-gn).

## Source and build

Use Python 3.11+, Git, Chromium's platform build prerequisites and
[depot_tools](https://chromium.googlesource.com/chromium/tools/depot_tools.git).
The build entry runs on native Linux, macOS, and Windows runners. Each runner
uses its own platform toolchain and produces only its own runtime artifact;
packaging an existing binary on Linux is not a cross-compilation strategy for
a modified Chromium runtime. Cross-platform delivery is a matrix of three
native builds followed by the same provenance-stamped packaging step.

From the OpenCraft repository root:

```sh
python3 vendor/electron/manage.py checkout
python3 vendor/electron/manage.py verify
python3 vendor/electron/manage.py sync
python3 vendor/electron/manage.py build --jobs 16
# Linux: vendor/electron/.work/src/out/OpenCraft/electron --ozone-platform=headless vendor/electron/probe.cjs
# macOS: vendor/electron/.work/src/out/OpenCraft/Electron.app/Contents/MacOS/Electron vendor/electron/probe.cjs
# Windows: vendor/electron/.work/src/out/OpenCraft/electron.exe vendor/electron/probe.cjs
```

Every command accepts `--root /absolute/isolated/build-root` to move the gclient
tree outside the checkout. `sync` downloads Chromium/Node and runs Electron's
normal dependency/patch hooks. `build` compiles locally, without remote build
execution. These are explicit operations, not part of normal application builds.
On a root-only disposable Linux test environment, Electron may require the
explicit `--no-sandbox` CLI option; production sandbox policy is unchanged.

The build result is platform-specific: Linux writes
`out/OpenCraft/electron`, Windows writes `out/OpenCraft/electron.exe`, and
macOS writes `out/OpenCraft/Electron.app/Contents/MacOS/Electron`. The same
build also creates `out/OpenCraft/dist.zip`, Electron's clean runtime archive.
Pass that archive with `--archive` and a fresh `--distribution` to
`prepare-desktop-artifact.py`; it extracts and validates the archive before the
desktop probe. Do not point the producer at the whole Chromium `out/` directory.
The producer records the matching platform and architecture in the marker.

To update this fork, change the fixed upstream revision and dependency version,
rebase the ordered patches in a separate source checkout, regenerate their
checksums, then materialize into a new isolated root. Never repair a mismatch by
resetting another developer's source or weakening tree verification. Chromium
changes belong in Electron's own `patches/chromium` series, carried by one of
this directory's Electron patches.

## First native patch

`0001-observe-native-text-input-state.patch` reconnects offscreen text-input,
composition and cancellation notifications to Chromium's `TextInputManager`.
It adds the experimental `webContents.getNativeTextInputState()` method:

- Native active/type/mode/password metadata and document-local node ID.
- Native UTF-16 selection and composition ranges.
- Native selection-focus geometry or EditContext selection bounds in root
  viewport DIPs, when available. Empty/missing geometry stays unavailable.
- No field value or surrounding text is exported, including password values.

This is **observation only**. The browser-process caches are not an atomic
renderer snapshot; `nodeId` is not a globally unique editor identity. No input
lease, focus generation, strict target-bound commit/cancel or local OS IME
adapter is implemented by this patch. It must not authorize remote editing.

`probe.cjs` uses an isolated headless/offscreen process and profile to check
empty-input and end-of-text native caret availability. Fixture geometry is test
input; the bridge does not query page DOM. The probe fails on stock Electron
instead of silently using accessibility or guessed geometry. A successful source
replay, compilation and native probe are three different results. Real OS IME,
OOPIF, scrolling/zoom, full editing consistency and touch/DevTools coexistence
need subsequent native validation.

## Target-bound native IME experiment

`0002-target-bound-native-ime-poc.patch` adds two **experimental, testing-only**
`WebFrameMain` methods, `getNativeImeContextForTesting()` and
`applyNativeImeForTesting({ token, compositionId, type, text, selectionStart,
selectionEnd })`. Types are `compose`, `commit`, and `cancel`; selection offsets
are UTF-16 offsets within the supplied text. The native renderer returns an
opaque, single-use context token, native ranges, and an owned composition ID.
It keeps the native text snapshot private. This is a single-caller experiment
with one outstanding context, not a production remote-input protocol.

The operation checks the document, native focus generation (including A→B→A),
native composition generation and native text/selection snapshot in the target
renderer. A scoped Blink guard checks the original focused element and editable
root again after synchronous website editing handlers. It never refocuses an
old editor. Cancel requires the composition created by this experiment, in the
same document and focus generation; an empty composition command without that
ownership is rejected before it can delete selected text.

The implementation uses Chromium's actual composition and editing paths. Page
DOM access in `probe-target-ime.cjs` is fixture setup and assertion only. The
experiment deliberately rejects passwords, EditContext and other unsupported
editor types; these remain necessary work before claiming a general IME bridge.

```sh
vendor/electron/.work/src/out/OpenCraft/electron --no-sandbox --ozone-platform=headless \
  vendor/electron/probe-target-ime.cjs
```

The probe covers native compose/commit, token replay, focus changes, A→B→A,
selection changes, owned cancel, stale cancel, navigation, and synchronous
`beforeinput`, `compositionstart`, legacy `textInput`, and `input` handlers.
`dispatched: false` means no native edit was dispatched. A handler may modify
the website, detach a frame or change focus during a dispatched operation;
`dispatched: true` plus `target-changed-during-operation` does not promise rollback
of website side effects. A renderer disconnect has an unknown outcome and must
not be retried as an exactly-once operation.

This patch does not implement surrounding-text/geometry updates, a controller
lease, concurrent requests, a local macOS/Windows/Linux IME adapter, physical
Chinese input testing, or multitouch. It does not modify graphics/compositing,
streaming or the serving runtime. A clean patch replay is source evidence;
native compilation and a passing native probe must be recorded separately.

## Target-bound native clipboard bridge

`0003-target-bound-native-clipboard.patch` adds experimental WebFrameMain
`getNativeClipboardContextForTesting()` and `copyNativeClipboardForTesting(token)`
methods. A single-use token binds the actual renderer document, native focus and
selection generations. No selected text is exported by the context operation.
The command invokes Chromium's native Copy path and captures its final text and
HTML, including website `copy` overrides and clipboard policy callbacks.
Passwords and unsupported targets are rejected.

The dedicated worker opts in with `--opencraft-remote-clipboard`. In that mode,
ClipboardHost accepts writes only inside its ordered capture interval and never
flushes them to the server OS clipboard. It refuses server clipboard reads.
Ordinary desktop processes do not opt in. Unsupported formats, multiple commits,
stale targets or no data return explicit failure. Capture is bounded to 65,536
UTF-16 code units across text and HTML. A dispatched website handler can have
side effects even if later validation rejects its result; there is no rollback.

`probe-native-clipboard.cjs` checks real input/textarea/contenteditable/document
copy, website text/HTML overrides, empty prevented copies, unrelated DOM changes,
unsupported formats, token replay, focus/selection A→B→A, navigation and child
frames. It also checks that the host clipboard is unchanged. DOM access is only
fixture setup and assertion. A stock binary must fail the capability check.

```sh
vendor/electron/.work/src/out/OpenCraft/electron --no-sandbox --ozone-platform=headless \
  vendor/electron/probe-native-clipboard.cjs
```

Native source/type checks do not prove the runtime probe. macOS native menus,
physical devices, cross-origin child frames and a complete local IME adapter
require separate verification.

## Linux component build audio boundary

`0004-component-audio-boundary.patch` repairs two upstream PulseAudio naming
references from Chromium shared libraries back into the Electron executable.
The media component reads the same `CHROME_DESKTOP` app ID directly; the existing
Electron UI-thread child-launch hook sets the current application name before
launching the audio service. Unset/empty names and the `.desktop` suffix retain
their existing behavior. PulseAudio remains enabled and strict linker checks
remain enabled. This does not change the native Copy or IME protocol.

`0005-gtk-dialog-dynamic-symbols.patch` registers the two GTK functions used by
Electron's file-dialog and printing patches with Chromium's existing dynamic
symbol loader. GTK stays dynamically loaded; this neither links GTK eagerly nor
disables file dialogs, printing or strict undefined-symbol checks.

`0006-single-native-object-counter.patch` gives the native trackable-object ID
counter one out-of-line definition. This preserves a single counter across
translation units with component builds and keeps the compiler's duplicate-object
check enabled.

`0007-offscreen-input-callback-definitions.patch` moves the three native input
forwarding callbacks from the offscreen header to its implementation file,
retaining the original base-class calls and Chromium's non-inline virtual-method
check. It does not add a production local IME adapter.

`0008-service-worker-native-commands.patch` completes the renderer IPC interface
for service workers. Workers have no frame/editor/selection, so native clipboard
and IME context calls return unavailable; edit/copy commands return an explicit
unsupported target with no dispatch. They do not read or write any clipboard.

`0009-component-libuv-link.patch` keeps Linux's whole-archive static libuv link
for static builds. Component builds use the exported shared libuv already present
in the normal dependency graph. It does not fabricate an archive or suppress
undefined-symbol checks.

## Verification and runtime adoption

```sh
python3 -m unittest discover -s vendor/electron/tests -v
python3 vendor/electron/manage.py verify
```

The source tests reject corrupted patches, unknown clean commits, dirty source
and escaping patch paths. CI replays the real series without compiling Chromium.
It does not report native behavior as tested.

The installed desktop Electron dependency is not automatically replaced.
For a Linux remote-browser distribution, build the complete `electron_dist_zip`
target, extract that archive to an isolated distribution directory, then run:

```sh
python3 vendor/electron/prepare-artifact.py \
  --distribution /absolute/owned/distribution \
  --source-root /absolute/isolated/build-root \
  --evidence /absolute/probe-evidence
OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION=/absolute/owned/distribution \
  npm run package:headless:linux:amd64
```

The producer verifies the exact fork and executes the native clipboard probe
from the extracted distribution before writing its byte inventory and marker.
Packaging verifies that marker against the current `fork.json`, versions,
licenses, executable and every shipped file. An explicitly selected invalid
artifact fails rather than falling back. Without this environment variable,
packaging retains the pinned stock runtime and the worker advertises native
copy as unavailable. This packaging path does not claim that any deployment has
adopted the owned binary; record the actual running artifact separately.
Browser session/permission ownership, H.264, variable-frame-rate streaming and
touch behavior remain with their existing owners.

Desktop launch and packaging have an explicit fork selection path as well. Set
`OPENCRAFT_ELECTRON_EXECUTABLE` to a verified native fork executable when
running `start-electron.mjs`. For desktop packaging, set the target-specific
`OPENCRAFT_ELECTRON_DISTRIBUTION_<PLATFORM>_<ARCH>` (for example,
`OPENCRAFT_ELECTRON_DISTRIBUTION_WIN32_X64`) or the generic
`OPENCRAFT_ELECTRON_DISTRIBUTION` fallback to a platform-native distribution
containing `opencraft-electron-desktop-artifact.json`; the wrapper checks its
platform, architecture, Electron/Chromium versions, fork definition hash and
native probe before passing `electronDist` to electron-builder. With neither
variable set, release packaging fails closed. An explicit
`OPENCRAFT_ELECTRON_ALLOW_STOCK=1` is available only for a local diagnostic
package and must not be used by release jobs. Linux cannot create a Windows or
macOS fork artifact; those markers and probes must be produced by their native
runners.

The native runner that built the distribution stamps that marker only after a
real runtime probe. From the repository root, on the matching host:

```sh
python3 vendor/electron/prepare-desktop-artifact.py \
  --archive /absolute/isolated-build-root/src/out/OpenCraft/dist.zip \
  --distribution /absolute/native/electron-dist \
  --source-root /absolute/isolated/build-root \
  --evidence /absolute/evidence/desktop-electron \
  --probe-arg=--ozone-platform=headless
OPENCRAFT_ELECTRON_DISTRIBUTION_LINUX_X64=/absolute/native/electron-dist \
  npm run package:electron:linux:x64
```

On Linux, pass `--probe-arg=--ozone-platform=headless` as shown. On Windows or
macOS, use the same command without that Linux-only probe argument and set
`OPENCRAFT_ELECTRON_PROBE_HIDDEN=1`; the producer uses the platform's native
distribution and runner. It records the target executable, fork/source identity,
runtime versions, probe JSON, and an exact regular-file/symlink inventory. A
changed byte, stale fork definition, wrong target architecture, or failed
probe prevents the marker from being written and the package wrapper rejects
the distribution.

Electron's MIT notice is retained in `LICENSE.electron` and in the expanded
upstream source. Built distributions must also retain Chromium and other bundled
dependency licenses and notices.

The component-build patch exports the Chromium/gin/GTK entry points used by
Electron, keeps GTK calls on the existing dynamic stub loader, and explicitly
links Viz client, double-conversion and Zstd compression implementations. It
retains strict linker diagnostics and does not change native copy authorization.

Linux explicitly depends on the GTK component exporting those entry points;
GTK itself remains dynamically loaded by the existing stub implementation.

For component distributions, prepare-artifact.py --strip-unneeded removes
nonessential ELF symbols with the checked-out Chromium LLVM tool before the
native probe and byte inventory. Dynamic symbols and runtime code remain; the
marker records the tool hash and operation. Never strip an already stamped
artifact or modify installed runtime bytes.


## Atomic offscreen viewport updates

Offscreen window resize must publish the new viewport and LocalSurfaceId together.
`UpdateScreenInfo` can synchronously notify the renderer before OSR has allocated
its next surface. The native view suppresses that intermediate synchronization
and sends the final visual properties after both compositor and delegated
surfaces have been updated. Chromium surface validation remains enabled.

Run `electron --no-sandbox vendor/electron/probe-offscreen-resize.cjs` against
the built runtime in an isolated profile. The CPU probe paints through keyboard
height changes, width changes and rotations while retaining the document,
input value, focus and selection. It does not test a physical phone keyboard.

## Nested Chromium patch validation

`manage.py` validates the syntax of Chromium patch files changed by this fork against the resulting Electron tree, before changing a checkout branch or running Chromium hooks. Outer patch SHA/tree verification alone cannot detect corrupt inner hunk counts. This early check is not a substitute for a full clean Chromium patch replay or native compilation.


## Offscreen cross-site input transforms

`0014-offscreen-oopif-input-transforms.patch` supplies the offscreen root
compositor FrameSinkId and delegates cross-view coordinate conversion to the
native destination view, matching Chromium Aura. The old OSR implementation
returned false for every other view, so cross-site iframe content could render
without receiving mouse/touch input. No page-DOM hit testing, iframe-specific
coordinates or remote focus changes are added to the input bridge.

The native regression requires an actual cross-process child. It checks trusted
mouse/touch coordinates through ordinary and transformed iframe surfaces, native
Chinese commit to that child, and child wheel scrolling. DOM reads/writes are
local fixture setup/assertions. This does not verify physical OS IME or authorize
binding an unknown first composition to a later focus.

```sh
vendor/electron/.work/src/out/OpenCraft/electron --no-sandbox \
  --ozone-platform=headless --ozone-override-screen-size=1920,1080 \
  --force-device-scale-factor=1 --disable-gpu \
  vendor/electron/probe-offscreen-oopif-input.cjs
```

Source replay, an isolated experimental object/link, a complete native build,
a packaged artifact and actual deployment are separate evidence. Never label an
experimental executable as a verified shipping artifact or replace retained
native owners to activate this patch.


## Native mouse and focused keyboard routing

`0015-offscreen-native-mouse-routing.patch` routes `webContents.sendInputEvent`
mouse events through Chromium's native input router after preserving OSR proxy
and popup handling. Forwarding directly to the root widget bypasses cross-site
hit testing even when CDP mouse and touch routing work. No extra JavaScript
round trip or page-DOM coordinate lookup is introduced.

`0016-native-focused-widget-keyboard-routing.patch` resolves keyboard input via
Chromium's focused-widget delegate before forwarding. A crashed or external
focused widget drops input instead of falling back to a different editor.
Native IME target authorization and client input leases remain independent.

The cross-site native probe now covers both CDP and Electron mouse paths,
trusted focused keyboard events, caret movement, Ctrl+A and Backspace. Each path
also checks native Chinese commit and an unchanged main-frame editor, through
ordinary and transformed iframe surfaces. It does not simulate a physical
Bluetooth keyboard or prove local OS candidate-window behavior.


## Native editor-state notifications

`0017-native-text-input-notifications.patch` adds the experimental
`webContents.setNativeTextInputStateObservation(enabled)` method. A successful
enable returns `true`; missing native view/manager returns `false` so startup
can retry. Changes in Chromium's shared TextInputManager emit the coalesced
`native-text-input-state-changed` event on the next UI task. Read the existing
`getNativeTextInputState()` for current observation metadata. Events carry no
field values, surrounding text, native write tokens or composition capability.

Observation belongs to the native WebContents, survives renderer-view changes,
and removes its manager observer and pending tasks when disabled or destroyed.
A listener may synchronously disable observation or destroy its WebContents.
The event is an invalidation hint, not an atomic editor snapshot or a causal
acknowledgement of a particular input. Existing native target-bound IME checks
remain mandatory.

The worker uses these notifications without a polling timer. Older runtimes
retain a visible-page polling fallback; hiding stops it and reveal reads current
state. `probe-native-input-notifications.cjs` checks main/real cross-process
child focus, edit-range/password metadata without field text, disabled callbacks,
navigation and reentrant disable/destruction. Physical keyboard/candidate UI and
first-focus input authorization require separate validation.

## Causal native input experiment

`0018-native-input-causality.patch` adds an experimental dispatch receipt and a
causal context query. `webContents.sendInputEventWithNativeInputTicket(event)`
accepts `mouseUp` or `keyDown` (fork19 also supports `mouseDown`), waits for the matching native ACK, and returns
`{ nativeInputTicket }`; native UI popup/proxy dispatch completes with a null
ticket rather than inventing a web-editor grant. Touch uses the private experimental CDP command
`Input.dispatchTouchEventWithNativeInputTicket` through the existing native
per-contact injector; its completion includes the native source touch ID. A
receipt is neither an editor observation nor permission to write.

`frame.getNativeImeContextForInputForTesting(ticket)` can consume a receipt
once while the event's native document/focus generation, node and input type
still identify the current editor. Blink records that identity within the
actual event-dispatch task, before ACK; no later focus hint is recaptured as
the original click. A later focus change, including A→B→A, a different native
activation, or a changed input type cannot acquire the old receipt. Native
values are never retained for this identity and never sent in the receipt.

The website keeps ownership of current text and selection. Updates in the same
editor **before** the context grant are accepted as current native state. The
existing single-use edit capability then validates the exact native snapshot
**after** that grant, immediately before writing. A pending native composition
cannot be stolen by a new causal query. Caller control leases, document epochs,
visibility and transaction cancellation remain mandatory outside this
experimental single-caller API.

`probe-native-input-causality.cjs` exercises root/OOPIF mouse and touch, native
Tab/password/Chinese, delayed focus, A→B→A, pre/post-grant website updates,
receipt/edit replay, scroll/pinch refusal and teardown. Artifact preparation
runs it against the exact distribution after optional stripping, alongside the
native clipboard probe. Fork18 alone does not enable unknown-first input.

## Native focus identity and remote first input

Fork19 adds `nativeImeContextVersionForTesting = 2` and `focusIdentity` to the
private native edit context. The identity contains the native document, node,
focus generation and input type. Returning to the same node after A→B→A cannot
revive an old binding. Capturing a password context first settles native layout,
then rechecks focus/document and captures the guarded snapshot; native password
flags must not change as a side effect of the first snapshot read.

`frame.getNativeImeFocusForInputForTesting(ticket)` consumes a native receipt
once and returns only availability, target/focus identity and type.
`frame.getNativeImeFocusForTesting()` observes current focus without a receipt.
Both are read-only: they expose no values, selection, edit token or composition
ownership and do not invalidate an existing single-use edit capability. The
current-focus query is observation only and cannot authorize unknown first input.

The worker advertises `nativeImeActivation` only when all required methods and
version2 exist. A mouseDown/mouseUp/keyDown or final single-contact touchEnd
binds its receipt before the next queued IME begin. TouchStart retains the prior
focus; a scroll cannot manufacture a tap. A release with no tap may continue only
an already-observed exact focus identity captured by that client. An unknown
editor never falls back to a hint arriving later. Each transaction obtains a
fresh native write context; text/selection changes before that grant remain
owned by the website. Terminal dispatched native results may advance *future*
transactions to a synchronously resulting editor, never replay old text there.

Controller, document, visibility, connection and transaction lifetimes remain
separate fences. Only opaque editor/activation IDs and keyboard traits cross
the private controller channel; native identities and tokens stay in the worker.
Older runtimes retain their existing known-editor path. A local staging receiver
supports composition, not a mirror of the remote DOM. Neither API can authorize
a physical iOS/WeChat keyboard popup outside its local user-gesture rules.

`probe-native-ime-focus-identity.cjs` covers20 real native cases; artifact
preparation runs them after stripping, then rechecks the unchanged definition
and verified source before stamping. The provenance unittest uses mocks only.
`OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION=<verified fork19 distribution> node
--import tsx scripts/smoke/browser/smoke-native-ime-activation.mjs` exercises the
actual typed Web client, WS and isolated managed worker. Local composition events
in that fixture are synthetic; physical keyboard/candidate UI needs device proof.
