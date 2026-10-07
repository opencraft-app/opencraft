# Embedded Bot bridge

The existing Bot product UI lives in `frontend/src/mobile-dom/entry.tsx` and
is bundled into `apps/workbench-expo/assets/mobile-bot-runtime.html` by
`build:mobile-bot-runtime`. The iOS WebView loads that local asset. It does not
navigate to a hosted Bot screen. Both sides import the single wire contract
`@opencraft/mobile-bot-bridge`.

The WebView uses the site URL as the bundled document's base URL so existing
first-party API code works. This does not turn the WebView into a strict
network sandbox. The native document policy admits that base URL only for the
first local HTML load. Every later top-level or iframe document navigation is
cancelled: Bot routes go through the bridge, approved site routes leave through
the native shell, and a redirect to the site homepage is blocked. A retry
remounts the bundled HTML rather than reloading the WebView's current URL.
Keep this policy when changing routing; a permanent allow rule for `/` can
replace the packaged UI with the live website and expose its WebView session.

Messages carry `{ protocol, runtimeId, payload }`. The protocol version
rejects incompatible shapes; the runtime ID distinguishes an old WebView or
account generation from the current one. It is a stale-message guard, not an
authentication secret. The native host validates unknown JSON before changing
state and applies Bot-selection messages only to known section IDs. The DOM
runtime validates native commands before dispatching them to the existing
frontend selection/create/delete behavior. The ready message advertises
supported commands; the host sends feature commands only after capability
handshake. A new command requires a corresponding behavior on both sides,
explicit failure semantics, and a focused protocol test.

The native drawer owns feature navigation; the DOM runtime owns Bot business
logic and renders frontend components except Chat. The catalog also transfers
each Bot's physical instance ID and Hermes Profile ID; iOS Chat binds the
OpenCraft RN Workbench to that exact pair. When Chat is selected, the DOM keeps
its previous feature mounted but hidden, so frontend AgentChat never owns the
visible mobile conversation. `external-navigation` leaves the local
runtime and passes through the shell's first-party route check. Neither side
logs credentials, personal identifiers, query strings, API bodies or error
payloads. Fixed diagnostic event names and bounded numeric facts may enter the
developer log. A protocol mismatch or missing ready event becomes the existing
recoverable Bot runtime error, never an endless loading spinner.
The bundled DOM lays out against its WebView viewport, which can be a phone,
iPad pane or foldable pane. Feature panels must shrink within that width; a
horizontal overflow hidden on the document is not proof that card and file
controls remain readable. The shared frontend components own responsive
content; `frontend/src/mobile-dom/embedded-layout.css` supplies only embedded
overrides, including a narrow fallback for older WebViews without container
queries. Layout probes should inspect inner panel width and touch controls as
well as the document width.
Section render failures include the section ID when available. The native
shell shows that section's retry state without marking the entire WebView as
failed; moving to another section lets the existing DOM error boundary recover.
If iOS terminates the WebView content process, the host reloads it at most
twice within a minute before showing the manual retry card. It keeps the Bot
selection and native Chat state outside that process.

Bot avatar shape definitions are shared by frontend and Expo. Once the DOM
reads a Bot profile, it sends a validated `bot-avatar` message with the Bot ID,
configured flag, shape and color. The native drawer renders that same shape;
before profile data arrives it keeps the existing image fallback. Avatar
messages are scoped to the current runtime ID and never contain image bytes.

After changing frontend Bot code, rebuild the local asset and run the DOM
smoke. After changing the bridge, run `tests/mobile-bot-bridge.test.ts`, Expo
typecheck and frontend typecheck. After changing navigation, also run
`tests/mobile-shell-model.test.mjs` and check the account/drawer return flow
in an Expo runtime. These checks are focused; this document adds no CI gate or
mandatory screenshot requirement.
