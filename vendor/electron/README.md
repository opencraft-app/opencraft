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

## Source and build

Use Python 3.11+, Git, Chromium's platform build prerequisites and
[depot_tools](https://chromium.googlesource.com/chromium/tools/depot_tools.git).
The build entry currently supports Linux. macOS/Windows require their native
toolchains and separate validation; packaging an existing binary on Linux is
not a cross-compilation strategy for a modified Chromium runtime.

From the OpenCraft repository root:

```sh
python3 vendor/electron/manage.py checkout
python3 vendor/electron/manage.py verify
python3 vendor/electron/manage.py sync
python3 vendor/electron/manage.py build --jobs 16
vendor/electron/.work/src/out/OpenCraft/electron --ozone-platform=headless vendor/electron/probe.cjs
```

Every command accepts `--root /absolute/isolated/build-root` to move the gclient
tree outside the checkout. `sync` downloads Chromium/Node and runs Electron's
normal dependency/patch hooks. `build` compiles locally, without remote build
execution. These are explicit operations, not part of normal application builds.
On a root-only disposable Linux test environment, Electron may require the
explicit `--no-sandbox` CLI option; production sandbox policy is unchanged.

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
