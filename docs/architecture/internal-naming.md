# Owned presentation and model names

OpenCraft owns CSS classes, timeline block discriminators, document directives,
local projection identities and shared presentation helpers. Name these for their
domain. An engine name belongs at a real adapter or compatibility boundary.
The retained engine classes are reviewed separately in [class naming](class-naming.md).

## Owned names

| Area | Canonical names and owner |
| --- | --- |
| Thread-tool rows | `thread-tool-row` in Web; `NativeThreadToolRow`, `threadToolRow` and `threadToolTitle` in Expo. Both consume the shared tool presentation. |
| Account Settings styles | `engine-account*` and `engine-device-login*` in [engine-accounts.scss](../../apps/workbench-web/src/styles/engine-accounts.scss). The current consumer still manages actual Codex accounts. |
| Setup interactions | `setup-step` response/block and `interaction:setup-step` projection input. Web and Expo consume the same model and interaction broker. |
| File citations | `file-citation` document directive, compiled from native citation syntax and consumed by Web and Native renderers. Raw citation text is unchanged. |
| Replica compatibility identities | `appserver-thread:<hostId>:<threadId>` and `appserver-v3:<hostId>:<generation>` identify local V3 projections across Hosts. They are not native Thread IDs or durable V4 journal cursors. |
| User-message projection | `UserMessageSemantics`, `deriveUserMessageSemantics`, `extractLastUserRequest`, `stripGoalDirective`, `normalizeTurnUserMessages` and `userMessageCompareKey`. |
| Message metadata | `projectThreadMessageResult` / `projectThreadMessageNotification` and `projectThreadAttachmentResult` / `projectThreadAttachmentNotification`; consumers import their canonical modules directly. |
| Thread-tool presentation | `ThreadToolNavigationTarget`, `threadToolNavigationTarget` and `thread-tools.ts`; presenters use `thread-tools` / `settings-tools` names and `thread-tool:` summary keys. |
| Storage source constants | `OPENCRAFT_HOST_*` and `OPENCRAFT_MESSAGE_ATTACHMENTS_BASELINE`; SQL contents and migration identity stay at the existing database owner. |
| Collaboration execution ownership | Execution ports declare `hostId`; new bindings and usage recovery use that identity, with no engine inferred from a missing value. |
| Inline image metadata | `inline-image-url` describes Web and Native Composer attachments carried as data URLs. The compiler selects image input from the MIME type and URI, independently of this diagnostic label. |

The typography checker, browser selectors, fixtures, tests and documentation
consume these same names. Host queue, Host state and message-metadata tests use
`opencraft-*.test.ts` names.

## Native and compatibility inputs

- `setup_codex_step`, `setup_codex_context_picker` and
  `item/tool/requestSetupCodexContextPicker` are native request names. Adapters
  preserve their wire spelling and map responses through the owned model.
- The projector accepts the former `interaction:setup-codex-step` as a read-only
  compatibility input and always emits `setup-step`. New runtime input and
  interaction responses use the canonical spelling.
- `isCodexAppThreadTool` explicitly checks the real `codex_app` namespace. Native
  tool names, result kinds (`codex` / `chatgpt`) and result fields remain intact;
  the presentation name is not a second tool namespace.
- `CODEX_*` user-message marker constants describe native prompt envelopes,
  including `My request for Codex` and `Prior conversation with Codex`. Parsing
  them does not rename user content.
- Generated protocol files, native error/approval metadata, `CODEX_HOME`, native
  executable and provider IDs, credential formats, transport options and actual
  engine-facing services retain accurate integration names.
- The collaboration v2 SQL keeps its published `local-codex` default, and
  historical nullable request rows retain that exact recovery identity. These
  are old storage inputs; generic execution ports must explicitly declare their
  Host before opening storage or connecting. Current native composition supplies
  its real Host identity rather than relying on a generic fallback.
- Live Host queue/catalog and attachment tables use owned names through appended
  migrations; published migration names/SQL and historical upgrade inputs remain
  immutable. Fresh files use owned names and existing file paths remain readable.
  [Offline file maintenance](../sqlite-lifecycle.md#两个-host-自有文件的离线改名)
  moves existing names with recovery evidence; installing the code does not move
  a deployment's data. Renaming a TypeScript constant never migrates storage.
- Existing Settings contribution IDs, Host IDs, saved theme aliases and native
  attachment metadata remain compatible. A CSS class is not a route or storage
  key. Native-engine tests and operational documentation retain the engine name
  where it identifies what they exercise.
- Reading old appearance preferences copies them to `opencraft.appearance-theme`
  and `opencraft.appearance-theme-id`, normalizing exact built-in aliases. Current
  keys take precedence; old entries remain available for recovery. An unreadable
  current key is never treated as missing for migration writes. Opaque extension
  IDs remain unchanged even while the extension is unavailable; displaying a
  fallback does not persist that fallback as the requested theme. Fresh defaults
  are not written as user choices, and denied storage writes do not reset the
  in-memory selection. Old input aliases remain readable for offline upgrades.
- Previously saved inline-image transport labels remain readable without a
  migration; the compiler does not use them to select an engine. Native uploaded
  file IDs retain their existing metadata and protocol representation.

Local V3 replica scopes/epochs are rebuilt by the in-process compatibility
source; no native IDs or persisted V4 history are rewritten. Compiled document
nodes and activity summary keys are also derived presentation state. A full
client reload recreates them from source content.

## Server connection identities

The generic headless connection extension/provider is `opencraft.server-connections`.
New server/SSH profiles and settings registrations use that identity. Its native
account settings page remains explicitly `codex-accounts`. The exact former
built-in provider ID is a migration input declared by the
[server connection identity owner](../../plugins/builtin-agents/src/server-connection-identity.ts).
Hosted Web startup rewrites matching profiles with an incremented revision;
Host IDs, recipes and machine observations stay intact. Exact former settings and
View bookmarks are read-only aliases supplied by the Web composition and replaced through the application Router, including
hostless startup and POP. Unrelated extension IDs are never prefix-rewritten.
The old literals remain in that compatibility reader; they are not current
registrations or defaults. Dedicated former-brand test cases and fixture branches
have been removed. The reader remains available for saved profiles and bookmarks,
with less historical-format regression coverage.

Current built-in agents, WebSocket, HyperNode, voice input, Bot views and the
optional theme pack register under `opencraft.*`. Their exact old provider and
bookmark IDs are migration inputs in the Web composition. Availability gates
provider rewrites; disabled plugins do not acquire a transport or change Host
identity during migration. The first-party Paper palette has one exact theme
alias; opaque third-party theme IDs are still preserved.
