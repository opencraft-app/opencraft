# Human model gateway

The mini gateway reuses the Codex account proxy, configured-model forwarding and
personal assistant gateway. Its admission ledger is separate from the Token
dashboard's participant allocation. It does not create a second credential vault.

## Implemented scope

- Human contributions add a connection to installation Model Services. The human
  owns the key, with personal-only access by default. Team use requires explicit
  consent. Both scopes use the same gateway and token ledger. The endpoint, protocol and model must already
  be declared in an administrator-owned connection; an unconfigured/disabled
  declaration can serve as the template. Humans cannot add arbitrary server egress.
  The contribution retains the template's model-policy identity, so a fresh key
  cannot bypass a model ban. Removing/changing the template invalidates the route.
  Credentials remain in the existing private `credentials.json`, not in the budget
  database, browser responses, runtime profiles or logs. This repository is private
  file storage, **not encrypted-at-rest storage**.
- Connections remain explicitly selectable. Existing Codex OAuth pool selection
  and affinity are preserved. This version does not load-balance arbitrary BYOK
  connections or automatically replace a selected model/key after an ambiguous call.
- Human-owned configured connections use the ledger through Codex Responses and
  configured personal assistants, including their title and child tasks. Existing
  platform OAuth/API connections retain their previous execution and usage paths.
- New Codex tasks carry a bounded execution authorization: the authorizing Human,
  actual Session executor when bound (otherwise null), exact model/connection,
  task identity and expiry. The existing collaboration authority revalidates
  direct, queued and delegated Human tasks. Historical usage attribution, a Bot's
  creator and a parent Thread ID do not authorize new tasks. Autonomous Session
  requests without a Human delegation fail closed in this version.
- “Only me” means the owner and assistants acting on the owner's admitted task.
  An assistant does not acquire a reusable key grant. Another Human cannot steer
  that paid execution. After completion, the same Thread may admit another Human
  using their own connection/authorization. Admission never silently changes the
  payer of an existing request. Requests retain their execution and settlement
  identity across restart.
- Native child requests from the authenticated engine derive the parent's bounded
  model scope and expiry, share the Human budget, and stop on ancestor revocation.
  Managed collaboration child inputs must independently carry current delegation
  evidence. Parent metadata alone in a public request is not admission evidence.
- Every physical dispatch rechecks the execution's recorded expiry/revocation and
  current key ownership/scope/state. Source Actor authority is checked again before
  native execution starts; this is not a synchronous federated identity lookup at
  every upstream byte. Existing in-flight responses still settle after withdrawal.
- The personal settings directory and the public model catalog omit another
  Human's private connections. Gateway mode also protects legacy model-settings
  RPCs: ordinary users cannot mutate installation settings, private credentials
  cannot be reused/edited through that surface, and unmetered probes of private connections are refused. Platform probes remain available.
  Administrators retain the platform configuration entry in the same settings page.
- Legacy sponsorship remains for existing assistant bindings and historical rows.
  Its conservative private-thread guards are retained; old Thread ancestry is not
  migrated into newly granted execution authority.
- Existing PI/DSH/ACP/Claude Code execution, legacy assistant profiles and image
  generation remain available. Unmetered adapters exclude personal connections
  before resolving or exporting credentials. Personal connections are selectable
  only on adapters with the metered forwarding path; enabling this feature does
  not turn off other engines or charge their platform usage to the personal ledger.
- Personal Codex subscriptions reuse device login, refresh and provider quota
  handling. Account rows are scoped to the Human in the existing account database;
  platform selection cannot use them. Model configuration contains a private local
  proxy credential, never the upstream OAuth token. Subscriptions remain personal
  and cannot be opened to team use. Provider plan quotas still apply independently
  of the additional local token ceiling. Other subscription providers need their
  own adapters. Stopping a connection denies future dispatch but retains the login
  for reconnection; it does not cancel the upstream subscription.

## Accounting and limits

Limits are per human: monthly total tokens, reservation per physical model request,
and concurrent outstanding requests. `*` configures a default for humans without
an individual policy. A human with no policy is denied; there is no hidden fallback
to unlimited platform spending. Monthly periods use UTC and belong to admission
time. Unknown older-period requests continue occupying concurrency slots.

`BEGIN IMMEDIATE` serializes admission across processes sharing the database.
Admission checks settled usage plus held reservations; a successful terminal usage
receipt settles the actual input + output tokens and releases the remainder.
Cached input is already included in the normalized input count and is not added
twice. Anthropic normalization remains owned by the existing protocol adapter.

This is **admission-budget control, not a strict monetary billing cap**. Different
models have different prices. A request can exceed its configured reservation;
its full actual usage is recorded, and subsequent admission is denied if the budget
is exhausted. Configure reservation sizes to match actual model/context usage.
No actual usage is clamped to make the budget appear respected.

Humans can set an additional personal monthly ceiling without increasing their
platform allowance. Sharing a key does not escape its owner’s ceiling: requests
count against the initiating Human and the contributed key owner, with one receipt
and no double-counting when they are the same Human. The owner sees aggregate
spending without receiving other users’ conversation transcripts.

Pre-dispatch failures release their reservation. Once dispatch may have occurred,
disconnects, missing/malformed receipts, HTTP errors without usage and process
termination retain the hold. There is no TTL-based release or automatic replay.
After a confirmed owner stop and/or an upstream receipt, an administrator can
reconcile an unresolved request with actual tokens and an audit reason. Reconciling
a still-running request could free capacity prematurely; the operator must establish
the outcome first. Settled receipts are idempotent and conflicting values reject.

## Enablement

The feature is opt-in. Before enabling, configure a policy with the local operator
tool. Use a **dedicated private directory** for the database:

```sh
node --import tsx scripts/admin/model-gateway.ts /absolute/budgets/model-gateway.sqlite configure '*' /absolute/limits.json
```

Example `limits.json` (choose deployment-specific values):

```json
{"revision":0,"monthlyTokens":10000000,"requestTokens":200000,"concurrency":4}
```

Then set `OPENCRAFT_MODEL_GATEWAY_DATABASE` to that absolute path in the gateway,
Codex account owner and all execution/assistant processes. They must access the
**same local SQLite database**, including across container mounts; separate files
would produce separate budgets. Do not put SQLite on a network filesystem. Empty
or relative values reject. Do not enable only the HTTP gateway while leaving an
older/unconfigured inference owner running. This change does not mutate the current
deployment, activate a policy or migrate production data automatically.

The local operator can inspect a human or reconcile a verified unknown receipt:

```sh
node --import tsx scripts/admin/model-gateway.ts /absolute/budgets/model-gateway.sqlite status HUMAN_ACTOR_ID
node --import tsx scripts/admin/model-gateway.ts /absolute/budgets/model-gateway.sqlite reconcile REQUEST_ID /absolute/receipt.json
```

The receipt file contains `actualTokens` and `reason`. The local operator has OS
access to this private database; that authority is distinct from the HTTP user.

## Authenticated HTTP surface

`/__opencraft_model_gateway` uses the existing human login and current membership.
It is available only when gateway mode is configured. No new bearer authentication
scheme is introduced. Responses use `private, no-store`. POST requires the trusted
same origin and JSON, and rechecks identity and administrator status after reading.

| Request | Authority | Result |
| --- | --- | --- |
| GET | Human | Own limits, usage, last 100 requests and contribution metadata |
| GET `?actor=ID` | Administrator for another human | The selected human's budget |
| POST `action=configure` | Administrator | CAS-update `actor`, `revision`, `monthlyTokens`, `requestTokens`, `concurrency` |
| POST `action=reconcile` | Administrator | Set `requestId`, `actualTokens`, `reason` from a verified receipt |
| POST `action=contribute` | Human | Supply `name`, `baseUrl`, `protocol`, `model`, `apiKey`; optional `scope:personal` (default) or `scope:team` with `shareWithTeam:true` |
| POST `action=personalLimit` | Human | CAS-update own `monthlyTokens`, `revision`; cannot raise platform limits |
| POST `action=scope` | Connection owner | CAS-update `provider`, `scope`, `revision`; opening requires `shareWithTeam:true` |
| POST `action=withdraw` | Contributing human | Disable owned `provider`; prevent future resolution |

Contribution success returns `providerId`, `modelId`, `scope` and `shared`, never a key.
Omitting scope/consent or using `shareWithTeam:false` creates a personal key.
Legacy `shareWithTeam:true` explicitly creates a team key. Contradictory values
are rejected. Scope changes are owner-only, revision-checked and rechecked at dispatch. Schema migration 2 preserves previously consented team shares; it does not
convert them to personal keys or widen new keys' scope.
The submitted key must be for the declared endpoint; no model request is made
during contribution. The normal model connection check remains separate.
Contribution metadata is created before staging a unique credential reference.
Only the final ready state (internally named `shared` for compatibility) is
selectable; the separate `scope` determines who may use it. A crash/conflict can leave a preparing
entry or an unreferenced private credential; there is no unsafe automatic cleanup
across the two existing stores. A withdrawn connection remains blocked even if its
Model Services document update was interrupted. Existing in-flight calls can finish.

In gateway-enabled Server settings, the existing Model Services destination now
shows personal connections, approved platform services, key registration, the
“Only me” scope, explicit platform sharing consent, withdrawal and personal token
usage/limits. It does not offer unsupported per-Session or group sharing choices.
The ordinary desktop connection editor keeps its local credential owner and shows
its local-only scope; the new server budget UI requires the gateway endpoint and
is not a claim that standalone Electron has acquired a server identity service.

Schema migration 3 adds execution/turn bindings, key-owner accounting, scope
revisions and personal ceilings. Existing requests and consent are preserved.
The gate remains opt-in; source changes do not enable it on a running deployment.

## Verification

`tests/usage/model-gateway.test.ts` covers cross-process admission races, stable
sponsorship and descendants, CAS, restart persistence, settlement, streaming,
malformed receipts, HTTP access, contributions/revocation, the actual Codex proxy
and the actual assistant loopback HTTP route. The Codex adapter test covers trusted
human admission and rejection before native dispatch. Existing account-pool,
configured-model, assistant-admission, policy and title tests remain applicable.
Personal-key checks include owner/other-human Codex and assistant HTTP requests,
child inheritance, forged actor fields, collaboration steering, withdrawal at
dispatch and v1 database migration. All inference used for these checks is synthetic; no production key or paid model
call is needed.
