# OpenCraft AppServer Profile Skills Protocol V1

Status: **implemented baseline**
Wire protocol: **JSON-RPC 2.0 over the existing AppServer WebSocket**
Extension identifier: **`opencraft/profile-skills`**
Version: **1**

This document defines the stable boundary used to inspect and manage the Skills
of one Agent profile. It deliberately does not expose Hermes REST paths,
`skills.manage`, filesystem paths, subprocesses, or Desktop types. Hermes is
the first adapter; another Agent runtime can implement the same contract.

## 1. The invariant

The resource is a Profile's Skill installation, not a page, Bot, conversation,
Turn, working directory, or WebSocket connection.

```text
Workbench Skills page
  -> Cordis ProfileSkillsService
  -> AppServerProfileSkillsClient
  -> skills/* JSON-RPC methods
  -> AppServer ProfileSkillsHandler
  -> provider adapter (Hermes first)
  -> provider-owned Profile storage and action runner
```

The following rules are normative:

1. The physical Host is selected by the `AppServerClient`/WebSocket. Requests do
   not repeat `hostId`.
2. Every request explicitly names a Profile scope. There is no implicit
   "currently selected profile" on the wire.
3. `profileId` is a provider profile identity. It is never a LightVela `botId`,
   conversation ID, Thread ID, display name, or filesystem path.
4. The provider's Profile storage and configuration are authoritative for
   installed and enabled state. The renderer owns only filters, selection,
   expanded cards, disposable query caches, and optimistic presentation.
5. Install, uninstall, and update are asynchronous Actions. An accepted command
   is not evidence that its mutation succeeded.
6. Action identity and projected Skill state have the same Profile scope and
   must be reattached together after reconnect. Changing Profile never retargets
   an existing Action.
7. The UI must not construct install directories, issue Shell commands, call
   provider REST endpoints, or poll provider action names.
8. Browser execution is a temporary host for the handler, not domain ownership.
   Moving the handler to a server must not change this protocol or the UI-facing
   service.

## 2. Boundary with existing `skills/list`

The upstream AppServer method `skills/list` remains unchanged. It discovers
Skills available to a Codex session from `cwds` and extra roots so the Composer
can build a per-Turn catalog.

Profile administration uses the methods in this document:

- `skills/installed/list` means "what this Profile has installed and enabled";
- `skills/catalog/*` means "what a provider catalog offers";
- `skills/install`, `skills/uninstall`, and `skills/update` mutate one Profile;
- `skills/action/read` observes a mutation after acceptance.

No adapter may implement `skills/installed/list` by forwarding to upstream
`skills/list`, or add Profile semantics to upstream `SkillsListParams`.

## 3. Capability negotiation

The server advertises this extension in the existing `initialize` result:

```json
{
  "capabilities": {
    "extensions": {
      "opencraft/profile-skills": {
        "version": 1,
        "features": {
          "contentRead": true,
          "officialCatalog": true,
          "catalogSearch": true,
          "catalogPreview": true,
          "catalogScan": true,
          "install": true,
          "uninstall": true,
          "update": true,
          "enablement": true,
          "actionNotifications": true
        },
        "limits": {
          "maxPageSize": 100,
          "maxActionLogLines": 500
        }
      }
    }
  }
}
```

Feature fields describe actual adapter support. A missing extension makes the
Profile Skills UI unavailable. A false feature hides or disables only that
operation; the renderer must not substitute Shell or direct HTTP behavior.

## 4. Common wire types

Field names and discriminants below are normative. Identifiers, cursors,
revisions, and operation IDs are opaque non-empty strings.

```ts
interface ProfileSkillScope {
  type: "profile";
  profileId: string;
}

interface ProfileSkillInstalled {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  provenance: "bundled" | "catalog" | "local" | "unknown";
  usageCount?: number;
  catalogIdentifier?: string;
}

interface ProfileSkillCatalogEntry {
  identifier: string;
  name: string;
  description: string;
  source: string;
  trustLevel?: string;
  repositoryUrl?: string;
  tags: readonly string[];
  installed?: {
    name?: string;
    trustLevel?: string;
    scanVerdict?: string;
  };
}

interface ProfileSkillCatalogSource {
  id: string;
  label: string;
  available: boolean;
  searchable: boolean;
  rateLimited: boolean;
}

interface ProfileSkillScanFinding {
  severity: string;
  category: string;
  file: string;
  line?: number;
  description: string;
}

interface ProfileSkillScan {
  identifier: string;
  name: string;
  source: string;
  trustLevel: string;
  verdict: string;
  summary: string;
  policy: "allow" | "ask" | "block";
  policyReason?: string;
  findings: readonly ProfileSkillScanFinding[];
  severityCounts: Readonly<Record<string, number>>;
}

type ProfileSkillActionKind = "install" | "uninstall" | "update";
type ProfileSkillActionState =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

interface ProfileSkillAction {
  actionId: string;
  operationId: string;
  scope: ProfileSkillScope;
  kind: ProfileSkillActionKind;
  target?: string;
  state: ProfileSkillActionState;
  startedAtMs?: number;
  completedAtMs?: number;
  exitCode?: number;
  logLines: readonly string[];
  logCursor?: string;
  error?: ProfileSkillsErrorData;
}

interface ProfileSkillsErrorData {
  domain: "profile-skills";
  code: ProfileSkillsErrorCode;
  retryable: boolean;
  scope?: ProfileSkillScope;
  actionId?: string;
  operationId?: string;
  currentRevision?: string;
}
```

`repositoryUrl`, catalog content, log lines, and scan findings are untrusted
provider data. They are display data, not instructions to the renderer.

## 5. Requests

All list limits are clamped to the negotiated maximum. All cursors are opaque.
An omitted `cursor` starts from the first page. V1 adapters may return
`nextCursor: null` when their provider does not paginate.

### 5.1 Installed state

#### `skills/installed/list`

```ts
interface Params {
  scope: ProfileSkillScope;
  cursor?: string;
  limit?: number;
  forceReload?: boolean;
}

interface Result {
  data: readonly ProfileSkillInstalled[];
  nextCursor: string | null;
  revision: string;
}
```

`revision` represents the complete normalized installed/enabled projection for
that Profile, not merely the returned page. It is suitable for cache validation
and compare-and-set mutations.

#### `skills/installed/content/read`

```ts
interface Params { scope: ProfileSkillScope; name: string }
interface Result { name: string; content: string; revision: string }
```

Provider-local paths are intentionally excluded.

#### `skills/enabled/set`

```ts
interface Params {
  scope: ProfileSkillScope;
  name: string;
  enabled: boolean;
  expectedRevision: string;
  operationId: string;
}

interface Result {
  name: string;
  enabled: boolean;
  revision: string;
  operationId: string;
}
```

Enablement is a bounded synchronous configuration mutation in V1. It is not
represented as a background Action.

### 5.2 Catalog

#### `skills/catalog/sources/list`

```ts
interface Params { scope: ProfileSkillScope }
interface Result {
  data: readonly ProfileSkillCatalogSource[];
  indexAvailable: boolean;
  featured: readonly ProfileSkillCatalogEntry[];
  revision: string;
}
```

#### `skills/catalog/official/list`

```ts
interface Params {
  scope: ProfileSkillScope;
  cursor?: string;
  limit?: number;
}
interface Result {
  data: readonly ProfileSkillCatalogEntry[];
  nextCursor: string | null;
  revision: string;
}
```

#### `skills/catalog/search`

```ts
interface Params {
  scope: ProfileSkillScope;
  query: string;
  source?: string;
  cursor?: string;
  limit?: number;
}
interface Result {
  data: readonly ProfileSkillCatalogEntry[];
  nextCursor: string | null;
  sourceCounts: Readonly<Record<string, number>>;
  timedOutSources: readonly string[];
}
```

`timedOutSources` makes partial success explicit. A partial search is not a
transport failure and must not erase successful rows.

#### `skills/catalog/preview`

```ts
interface Params { scope: ProfileSkillScope; identifier: string }
interface Result {
  entry: ProfileSkillCatalogEntry;
  skillMarkdown: string;
  files: readonly string[];
}
```

#### `skills/catalog/scan`

```ts
interface Params { scope: ProfileSkillScope; identifier: string }
interface Result { scan: ProfileSkillScan }
```

### 5.3 Mutations and Actions

#### `skills/install`

```ts
interface Params {
  scope: ProfileSkillScope;
  identifier: string;
  expectedRevision?: string;
  operationId: string;
}
interface Result { action: ProfileSkillAction }
```

#### `skills/uninstall`

```ts
interface Params {
  scope: ProfileSkillScope;
  name: string;
  expectedRevision?: string;
  operationId: string;
}
interface Result { action: ProfileSkillAction }
```

#### `skills/update`

```ts
interface Params {
  scope: ProfileSkillScope;
  expectedRevision?: string;
  operationId: string;
}
interface Result { action: ProfileSkillAction }
```

#### `skills/action/read`

```ts
interface Params {
  scope: ProfileSkillScope;
  actionId: string;
  logCursor?: string;
  maxLogLines?: number;
}
interface Result { action: ProfileSkillAction }
```

`skills/action/read` is the reconnect and notification-loss recovery path. It
must resolve against the same physical provider backend that accepted the
mutation. `logCursor` returns only later lines when the provider supports it;
otherwise the adapter may return a bounded tail and a replacement cursor.

## 6. Notifications

### `skills/action/updated`

```ts
interface Params { action: ProfileSkillAction }
```

Emitted when state, logs, progress, or completion changes. Notifications are a
latency optimization, not durable truth. The client resumes observation with
`skills/action/read` after reconnect.

### `skills/installed/changed`

```ts
interface Params {
  scope: ProfileSkillScope;
  revision: string;
  cause: "install" | "uninstall" | "update" | "enablement" | "external";
  actionId?: string;
}
```

This is an invalidation signal. The client reruns `skills/installed/list`; it
does not patch authoritative rows from the notification.

Notifications from another Profile may be cached by the service but must never
mutate the mounted Profile view.

## 7. Action and idempotency semantics

The state machine is monotonic:

```text
accepted -> running -> succeeded
                    -> failed
                    -> cancelled
```

- Terminal states never become non-terminal.
- `operationId` is generated once by the semantic caller and reused for every
  retry of the same user intent.
- Within one Host and Profile, `(operationId, method)` is idempotent. Repeating
  it returns the same Action or synchronous mutation result.
- Reusing an `operationId` with different parameters fails with
  `OPERATION_CONFLICT`.
- A transport timeout is an unknown receipt, not a failed operation. The client
  reconnects and retries the same `operationId`; it must not generate a new one.
- Conflicting mutations of the same installed Skill are serialized by the
  handler. Independent Skills may run concurrently if the provider permits it.
- Completion first causes the handler to refresh provider state, then emit
  `skills/installed/changed`. The UI never infers success from an exit log.

The service owns a bounded operation journal. A server implementation persists
it server-side. The temporary browser handler may persist only this journal and
action attachment metadata in origin-local browser storage. That cache is not the source of truth
for installed Skills; provider reads reconcile it after startup.

## 8. Revisions and concurrent writers

- Revisions are opaque hashes or provider versions over normalized Profile
  state. Clients compare only equality.
- `skills/enabled/set` requires `expectedRevision` because it is a direct
  read-modify-write operation.
- Background mutations accept an optional `expectedRevision`. When supplied,
  mismatch is rejected before the Action is spawned.
- On `REVISION_MISMATCH`, the renderer refetches and asks the user to repeat the
  intent; it does not silently overwrite another writer.
- Provider-side external changes are legal and surface through a changed
  revision on the next read, with `cause: "external"` when detected live.

## 9. Error contract

Domain failures use the normal JSON-RPC error envelope with a stable
`error.data`:

```json
{
  "code": -32061,
  "message": "Skill install was blocked by policy",
  "data": {
    "domain": "profile-skills",
    "code": "POLICY_BLOCKED",
    "retryable": false,
    "scope": { "type": "profile", "profileId": "default" },
    "operationId": "01J..."
  }
}
```

V1 error codes are:

```ts
type ProfileSkillsErrorCode =
  | "PROFILE_NOT_FOUND"
  | "SKILL_NOT_FOUND"
  | "CATALOG_ENTRY_NOT_FOUND"
  | "INVALID_IDENTIFIER"
  | "ALREADY_INSTALLED"
  | "NOT_INSTALLED"
  | "REVISION_MISMATCH"
  | "OPERATION_CONFLICT"
  | "ACTION_NOT_FOUND"
  | "ACTION_EXPIRED"
  | "POLICY_BLOCKED"
  | "SOURCE_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "UNSUPPORTED_OPERATION"
  | "INTERNAL";
```

Provider HTTP status, safe summaries, and retry hints may be included as extra
fields. Tokens, cookies, environment variables, absolute paths, raw commands,
and unrestricted provider responses must not cross the boundary.

## 10. Hermes adapter mapping

The Hermes adapter uses the authenticated Dashboard REST API because it is the
surface Hermes Desktop itself uses and it has materially greater parity than
Gateway `skills.manage`.

| AppServer method | Hermes Dashboard operation |
| --- | --- |
| `skills/installed/list` | `GET /api/skills?profile=<profileId>` |
| `skills/installed/content/read` | `GET /api/skills/content?name=...&profile=...` |
| `skills/enabled/set` | `PUT /api/skills/toggle` with `profile` in the body |
| `skills/catalog/sources/list` | `GET /api/skills/hub/sources?profile=...` |
| `skills/catalog/official/list` | `GET /api/skills/hub/official?profile=...` |
| `skills/catalog/search` | `GET /api/skills/hub/search?q=...&source=...&limit=...&profile=...` |
| `skills/catalog/preview` | `GET /api/skills/hub/preview?identifier=...&profile=...` |
| `skills/catalog/scan` | `GET /api/skills/hub/scan?identifier=...&profile=...` |
| `skills/install` | `POST /api/skills/hub/install` with `identifier` and `profile` |
| `skills/uninstall` | `POST /api/skills/hub/uninstall` with `name` and `profile` |
| `skills/update` | `POST /api/skills/hub/update` with `profile` |
| `skills/action/read` | `GET /api/actions/<provider-action-name>/status` on the accepting backend |

The adapter converts snake_case payloads into the wire DTOs and maps Hermes
`agent`, `bundled`, and `hub` provenance to `local`, `bundled`, and `catalog`.
The provider action name and PID stay adapter-private; AppServer exposes its own
opaque `actionId`.

Gateway RPC `skills.manage` is not the primary V1 path: today it does not cover
the full list/content/toggle/source/preview/scan/uninstall/update/action surface.
It may be used only behind the adapter for an operation whose semantics are
proven equivalent, never as a UI fallback.

The adapter reuses the Host-owned TAT/Dashboard transport and authentication.
It must not create a second TAT session, WebSocket, gateway ownership token, or
provider process merely because the Skills page mounts.

## 11. Cordis and UI wiring

```text
mono2-derived Skills presentation
  -> ProfileSkillsRepository (presentation DTO adapter)
  -> ProfileSkillsService (Cordis domain service)
  -> AppServer client selected by hostId outside the protocol
  -> typed skills/* request

temporary browser AppServer handler
  -> ProfileSkillsHandler
  -> HermesProfileSkillsAdapter
  -> existing host-scoped authenticated Dashboard client
```

`ProfileSkillsService` takes `{hostId, profileId}` at its public application
boundary, obtains the Host's AppServer client from the runtime registry, checks
`opencraft/profile-skills`, and sends a wire request containing only the
explicit Profile scope. Components never inject `appServerClients` directly.

The mono2/Hermes Desktop presentation remains external reference code. We add
one narrow repository/provider seam at our integration boundary; we do not
copy networking, paths, polling stores, or Shell behavior into its components.
Diagnostics and Cloud Storage can later use the same architecture with their
own domain services, without becoming part of Profile Skills.

## 12. Required tests before UI integration

1. Protocol codec tests for every method, notification, discriminant, and
   malformed scope.
2. Capability absence and individual feature-disable tests.
3. Hermes mapping tests against a fake Dashboard, including all snake_case
   normalization and sanitized errors.
4. A proof that `botId !== profileId` and that switching Bots cannot retarget a
   Profile Action.
5. Profile A/B tests where A completes after the UI switches to B; B's rows and
   action log must remain unchanged.
6. Duplicate `operationId` tests before receipt, after timeout, after reconnect,
   and after terminal completion; only one provider mutation may be spawned.
7. Same-action reconnect tests proving `skills/action/read` reaches the backend
   that accepted it and restores log/state without duplicate installation.
8. Revision mismatch and external-writer reconciliation tests.
9. Partial catalog search tests preserving results from non-timeout sources.
10. Static/runtime assertions that the page does not call Dashboard HTTP,
    `skills.manage`, `fs/*`, `process/*`, or Shell commands.

## 13. Implementation order

1. Add the protocol types, method map, notification map, capability constant,
   and contract tests only.
2. Add `ProfileSkillsService` plus a fake in-memory handler; prove ownership,
   revisions, idempotency, reconnect, and Profile switching.
3. Add `HermesProfileSkillsAdapter` over the existing authenticated Dashboard
   client and pass adapter contract tests.
4. Introduce the single repository seam for the external Skills presentation.
5. Remove the current page-owned mock/direct behavior; do not retain a second
   compatibility path.

This order freezes the domain contract before borrowing presentation code and
prevents an external UI implementation from becoming the owner of the model.
