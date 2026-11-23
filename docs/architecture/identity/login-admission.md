# Login admission policy

`@opencraft/plugin-login-admission` is an optional core plugin that implements
`InstanceAdmissionPolicy` (`packages/access-control/src/index.ts`). It decides
which verified sign-ins of **one identity provider** may enter an instance,
by comparing **one verified login attribute** of the principal (for example an
OIDC claim or a directory login name). It never authenticates: the provider
verifies the credential, then the Hub asks the policy whether that verified
principal is admitted. Membership grants and revocations still apply on top;
the policy can only narrow admission, never grant a role.

## Scope and configuration

A policy is keyed by `{ provider, attribute }`. A principal of another provider
is outside the policy (`allows` returns true for it). Changing the attribute
starts a new, empty document: an allowlist written for one attribute is never
reused for another.

Two ways to enable it:

| Composition | Shape | Use when |
|---|---|---|
| Headless `composition.loginAdmission` | `{ provider: string, attribute: string }` | The default function input is enough. Headless opens `<data>/login-admission.sqlite`, passes the policy to `InstanceAccess` and closes it on shutdown. Requires instance access (membership). |
| Identity composition | `identity.admissionPolicy = await openLoginAdmissionPolicy({ provider, attribute, path, functionInput? })` from `@opencraft/plugin-login-admission/server` | The product needs its own `functionInput` mapping or adoption at startup. |

Both at once fail startup (`Login admission cannot have two owners`).

## Policy document

```ts
interface LoginAdmissionRules {
  enabled: boolean;                 // false: no restriction for this provider
  allowlist: string[];              // exact values, case-insensitive (NFC, lower case)
  patterns: string[];               // `*` any run, `?` one character, anchored, case-insensitive
  conditions: { attribute: string; equals: string }[]; // other verified attributes, case-insensitive
  admitFunction: string | null;     // source declaring `function admit(input)`
}
```

A sign-in is admitted when the document is disabled, or when **any** rule
matches. Declarative rules are evaluated first; the function runs only for a
sign-in they do not admit. A sign-in without the scope attribute is refused.
Limits: 10,000 allowlist values, 256 patterns, 64 conditions, 256 characters per
value, 15,000 bytes of function source. Pattern matching is linear in value ×
pattern length (no regular expressions, so no catastrophic backtracking).

Every publication is a new **revision** (compare-and-set). Revision 0 means
nothing was published (disabled). Each revision is kept in
`login_admission_versions`; each committed write is appended to
`login_admission_audit` with the administrator's stable binding
(`principalKey`), the action (`publish` or `import`) and a summary of rule
counts.

## Evaluation and fail-closed behaviour

- `prepare(principal)` (called by `InstanceAccess.prepare` before every HTTP
  and WebSocket admission) evaluates the verified attributes and caches the
  decision per subject, keyed by the exact attributes. `allows` only reads that
  cache; a principal whose attributes changed is refused until re-evaluated.
- The verified attributes of each sign-in are recorded so a new publication
  re-decides every known identity and durable work (`allowsBinding`) keeps a
  decision without a live login, also after a restart. An identity never seen
  is refused for durable work until it signs in.
- Refusal, not admission, is the answer whenever the policy cannot decide: the
  storage Worker failed or the policy is closing (every principal of the
  provider is refused), the function threw, timed out, exceeded memory or
  returned anything other than exactly `{ allow: boolean }`. A failed function
  evaluation is retried on a later sign-in after one second.
- After the first decision `InstanceAccess.prepare` completes the verified-login
  Actor membership step that authentication skipped while no decision existed,
  so a newly admitted human is admitted on that same request.

## The admission function: decision and sandbox

The reference policy this replaces ran an admin-authored JavaScript function.
It is kept, but only inside the existing core sandbox
`@opencraft/javascript-runtime`:

- QuickJS compiled to WebAssembly, in a disposable `worker_threads` Worker per
  run. The guest has no `require`, `import`, `process`, timers, `fetch`, file
  system or host callbacks; the input is a deep-frozen JSON copy and the only
  output is JSON of at most 128 KiB.
- 16 MiB QuickJS heap, 256 KiB stack, 100 ms interpreter deadline, 3 s wall
  clock, 64 MiB Worker heap. The policy starts at most two runs at once (the
  shared runtime admits four) and queues up to 512 further evaluations; beyond
  that an evaluation fails and the sign-in is refused, then retried later.
- Whole populations (startup, publication, adoption) run in batches of 50 per
  sandbox run; a throwing call fails only its own entry and an interrupted batch
  refuses only its own entries.
- Publication compiles the function first; a syntax error is `invalid_policy`.

The function is **administrator-only** configuration: only a current instance
administrator can publish or preview it, and every publication is audited. It
is a policy expression, not an extension point: it cannot read other data,
cannot call out, and cannot grant anything beyond admission of the one
principal it is given. Prefer the declarative rules; use the function only for
logic they cannot express.

Default input: `{ identity: { provider, subject, value, attributes } }`, where
`value` is the scope attribute. A composition can replace it with a pure
`functionInput(identity)` mapping, for example to keep an earlier input shape.

## Administration API

`/__opencraft_access/login-admission`, served through `InstanceAccess.handle`
by the policy's optional `handle(request, caller)`. The instance authenticates
the caller; the policy rechecks `caller.administrator()` before reading, after
evaluation and immediately before committing.

| Request | Answer |
|---|---|
| `GET` | `LoginAdmissionDocument`: scope, revision, rules, `updatedAt`, number of known identities, last 20 versions and audit entries |
| `POST {action:"publish", revision, rules}` (same-origin JSON) | the new document; `409 revision_conflict` when `revision` is not current; `409 cannot_remove_own_administration` when the publishing administrator signed in through this provider and the new rules would refuse them |
| `POST {action:"preview", rules, identity:{value, subject?, attributes?}}` | `{allow, match, failed}`; nothing is stored or audited |

Errors: `403 administrator_required`, `403 same_origin_json_required`,
`400 invalid_policy`, `413 too_large` (512 KiB body), `503 policy_unavailable`.

## Storage

`login-admission.sqlite` is an independent owner registered in
`packages/storage-node/stores.json` (`schemaId: "login-admission"`, owner
`plugins/login-admission/src/store.ts`, migrations in
`plugins/login-admission/src/migrations.ts`, Drizzle schema under
`packages/storage-node/src/stores/login-admission/`). Every SQLite call runs in
the `login-admission` storage Worker (`@opencraft/worker-owner`); the network
thread keeps an in-memory projection and never falls back to synchronous IO.
`plugins/login-admission/src/server.ts` is a main-thread sync-IO guard entry,
and the Worker is packaged as `login-admission-worker.mjs` beside every bundled
network process. Schema changes append version N+1 through the store's Drizzle
flow ([SQLite lifecycle](../server/sqlite-lifecycle.md)).

## Settings page

`createLoginAdmissionExtension(fetcher, url)` from
`@opencraft/plugin-login-admission/client` (listed in the Workbench's server
extensions) probes the `GET` route at activation and registers the
**Sign-in admission** page under the Server group only for administrators of a
server that enabled the policy; the server still authorizes every call. The page
uses the shared Settings components and the Workbench IntlRuntime. Unpublished
edits survive leaving and reopening the page and stay pinned to the revision
they started from, so a concurrent publication is reported as a conflict
instead of being overwritten. Errors go to the Workbench's asynchronous notices.

## Adopting an existing policy store

A deployment that kept its own admission store adopts it once:

```ts
import { openLoginAdmissionPolicy } from "@opencraft/plugin-login-admission/server";
import { identitiesFromLogins, rulesFromModeDocument } from "@opencraft/plugin-login-admission/adoption";

const policy = await openLoginAdmissionPolicy({ provider, attribute, path, functionInput });
// Read the old store on the product's own Worker; then:
await policy.adopt({
  source: "previous-admission-store",                      // idempotency key
  rules: rulesFromModeDocument(activeDocument, "loginNames"), // {mode:"inherit"|"allowlist"|"javascript"}
  identities: identitiesFromLogins(provider, attribute, rows), // [{subject, value}]
});
```

- `adopt` runs once per `source` (recorded in `login_admission_imports`).
- The rules become revision 1 only when the scope has no published document;
  an administrator's later publication is never overwritten.
- Known identities are merged without replacing newer records, so durable work
  keeps its decisions before the next sign-in.
- The import is audited with operator `adoption:<source>` (or the given
  `operator`).
- An existing function keeps working unchanged when `functionInput` rebuilds
  the input shape it was written for.

After adoption the old store is read-only history; its owner code, schema
registration, administration route and settings page can be removed. Unsent
drafts and the old store's own version history are not migrated; the adopted
active document becomes the first core version.
