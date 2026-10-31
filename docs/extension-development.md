# Extension development: current contract

This is the implemented development path. The architecture's proposed hosts,
permissions and marketplace are not additional APIs available to a V1 module.
The authoritative types are [extension-contract](../packages/extension-contract/src/index.ts);
[hello.mjs](../examples/extensions/hello.mjs) is the executable consumer.

## Choose a boundary

| Boundary | Owner and interface | Compatibility |
| --- | --- | --- |
| Core | Actors, identity binding, authorization, Hub dispatch and shared runtime/lifecycle semantics | Changed through core PRs and affected consumer tests |
| Trusted product composition | Login providers, private services, branding, defaults and product adapters; `ClientWorkbenchProduct` and explicit build entries | Built together with the application; internal integration types are not the downloadable Extension ABI |
| Client Extension | Declarative commands, settings, views, navigation, sidebar/workbench metadata, themes, bots and application-owned announcements | Public `ExtensionManifestV1` and `OpenCraftExtensionApiV1`; current host accepts API 1 |
| Host/AppServer plugin or engine adapter | Skills, MCP, hooks and execution capabilities owned by that Host | Its protocol/engine contract, distinct from client Extension installation |

Identity adapters verify their identity source; core decides admission and
resource authorization. UI visibility and contribution registration do not grant
access to a Host or another Actor. See [Actor collaboration](architecture/actor-collaboration.md).

Product owners select trusted **local build entries**, including
`OPENCRAFT_CLIENT_PRODUCT_ENTRY`, `OPENCRAFT_EMBEDDED_PRODUCT_ENTRY` and
`OPENCRAFT_SERVER_EXTENSIONS_ENTRY`. These are application composition inputs,
not module URLs supplied by browser users. Public builds do not discover a
private parent workspace automatically. See [product session types](../packages/client-product/src/index.ts)
and the entry-specific contracts in [plugin architecture](plugin-architecture.md).
A product may use internal trusted renderers; that does not expose React, Cordis
or arbitrary application services to installed Extensions.

Internal contribution changes must update both their typed contract and runtime
validator. Thread badge placement validation exhaustively covers the declared
placement union, including `title`, while rejecting unknown values. Consumer
checks must activate the real optional plugin branch through the production
registry and verify activation, contributions and unload; rendering a component
directly cannot detect an activation transaction rolling back.

## Build and run the first extension

Use the pinned Node version in `.nvmrc` and run these commands from your own clone:

```sh
npm ci
npm run test:extension-example
npm run dev:web
```

In a second terminal at the same repository root:

```sh
node examples/extensions/serve.mjs
```

Open the local HTTP Workbench URL printed by Vite. Press Escape five times in
quick succession, open the page with `?opencraft-dev=1`, or tap the Settings
heading seven times within three seconds to enable the existing tab-scoped
developer mode. In Settings, open the plugin /
extension manager, install `http://127.0.0.1:5174/hello.mjs`, and enable it if
necessary. Select **Hello extension** in the sidebar; an application-owned
announcement opens. Disable the extension while it is open: both the entry and
the pending announcement must disappear. Re-enable it to restore the entry.
The [example walkthrough](../examples/extensions/README.md) includes update,
restart and troubleshooting steps. No configured model or Host is needed for
this example.

## Manifest and capabilities

The example contains a valid Manifest, including numeric `apiVersion: 1`,
`trust: "trusted"`, and `platforms: ["web", "electron"]`. The contract's platform
values are `web`, `electron` and `expo`; declaring a platform does not implement
its loader. This module-URL walkthrough targets the Web/Electron renderer, not
an Expo installation flow. Required dependency IDs must already be active;
there is no dependency version-range resolver. The current eager startup path
does not promise lazy activation merely because an event appears in a manifest.

The public API exposes `signal`, `identity`, `subscriptions`, nullable `storage`,
optional `localPreferences`, and the `commands`, `settings`, `views`, `navigation`,
`sidebar`, `workbench`, `themes`, `bots` and `window` contribution APIs. Capability
availability must be checked rather than inferred from an optional type member.
In particular, view registration describes supported views; it does not install
an arbitrary React component. Themes provide palette data, not arbitrary CSS.

Do not use a Cordis Context, React component, mutable runtime store, filesystem
or Electron IPC as an Extension API. Downloaded modules run as **trusted code in
the renderer realm**, not an isolated sandbox. This channel is for code the user
trusts; a narrow API surface is not execution isolation.

## Activation, persistence and updates

Register contributions in `activate(api)`. Use `api.signal` for asynchronous work
and `api.subscriptions.add(dispose)` or the returned disposer for resources.
Retirement and activation failure abort the signal before cleanup. Do not let
late callbacks register contributions or mutate a retired activation.

Module-URL installation requires one self-contained ESM file of at most 512 KiB.
Bundle dependencies: runtime imports, re-exports from other modules, dynamic
`import()` and `import.meta` are rejected. The JSDoc type import in the example is
not a runtime import. HTTPS Workbench requires an HTTPS module URL; the local
HTTP server is intended for the local HTTP development client only.

Installation stores module bytes and their SHA-256. Restart restores those bytes;
**Update from source / 从来源更新** (`reload`) explicitly fetches an update from the source URL. A failed update
preserves the old persisted installation pointer. This is not a transaction over
arbitrary side effects performed by the module. Ordinary disable/uninstall does
not imply deletion of plugin documents; see [persistence](plugin-persistence.md).

## Compatibility and contributing new capabilities

API V1 evolution must preserve existing consumer behavior. Removing a member or
changing its semantics requires a new API version and a migration proposal.
The host currently checks `apiVersion === 1` and the declared platform. There is
no published semver SDK, engine-range resolver or general capability-grant
system. Workspace packages provide source types; npm publication is not needed
to contribute or run this example.

When proposing a new contribution point:

1. Show the actual consumer need and why an existing public point cannot express it.
2. Keep core authority and application-owned rendering/lifetime intact; isolate
   product implementation behind the reusable port.
3. Test an existing V1 consumer plus new success, unsupported, failure and disposal
   paths, and typecheck both ends of a changed contract.
4. Report the platforms actually exercised in the PR. Use the commands in
   [CONTRIBUTING](../CONTRIBUTING.md#develop-and-validate).

The architecture's isolated ExtensionHosts, publisher distribution, full
resolver and richer permissions remain proposals, tracked separately from this
implemented path. See [remaining ecosystem work](architecture/extensions/implementation-and-acceptance.md#142-尚未完成的生态边界).

### Host model configuration destinations

A Settings page may declare `targetHostId` and `modelConfiguration: true` to provide
that Host's model-menu Manage destination. The client uses the declaration,
platform and audience, without guessing engine or page IDs. Lower `order` wins;
equal orders use page ID order. Pages without this declaration remain ordinary
Settings pages. A declaration without a target Host is rejected atomically.
Run navigation lists enabled Hosts' declared configuration pages in their normal
page order. The extension remains responsible for its page and model credentials.

### Miniapp desktop entries

A trusted extension can expose an existing View or Settings page on Overhome by
registering a navigation entry with `surface: "applications"`:

```ts
api.navigation.register({
  id: "example.clock.app", title: "Clock", icon: "calendar",
  surface: "applications", target: { kind: "view", viewId: "example.clock.view" },
  platforms: ["web", "electron"],
});
```

Register the target View and its renderer through the existing extension boundary
before publication. `MiniAppContribution` names this launch declaration; the
original registry owns activation, identity and retirement. The desktop filters
platform/audience and renderable targets, then uses the normal application Router.
A miniapp entry grants no resource permission and cannot invoke an execution
command. This adds no downloaded-code runtime or public renderer ABI; see
[Overhome ownership](architecture/platform/shell-and-navigation.md#overhome-and-miniapps).


A model settings page that implements the runtime providers, models, settings and
credential-description methods may also declare `modelReadiness: true` alongside
`modelConfiguration: true` and its fixed `targetHostId`. The new-conversation setup
uses this explicit capability to check configuration without probing a model or
reading credential values. OAuth-only account pages should omit this declaration.
