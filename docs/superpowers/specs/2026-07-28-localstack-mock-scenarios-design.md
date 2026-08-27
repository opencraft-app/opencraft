# Localstack Mock Scenarios Design

## Status

Implemented for the first localstack slice.

This design deliberately avoids a general workflow engine, a programmable DSL,
and a centralized state-machine runtime. It introduces only the structure
needed to select a local test user and experience successful or failed
real-name verification through the existing application flow.

## Goal

The localstack Fake QQ authorization page must let a developer select:

1. a local test user;
2. a scenario from a searchable scenario list.

The first user-facing scenarios are:

- `realname-success`;
- `realname-failed`.

The registry also contains `full`, the default scenario with no overrides.

After selection, Fake QQ completes the normal OAuth redirect. The developer
then uses the selected user's displayed local test identity on the existing
account page. Auth continues to call the existing Tencent FaceID client, which
terminates at `fake-tencentcloud`. The selected scenario determines whether
`IdCardVerification` succeeds or reports an identity mismatch.

For the success scenario, a newly created QQ user still has no phone in Auth.
After `IdCardVerification` passes, the developer completes the existing local
phone-verification step with the displayed fixture phone and configured local
development SMS code. "Real-name success" means that the existing Auth flow
reaches its final verified state, not merely that the provider call succeeds.

No real QQ, Tencent FaceID, payment service, or cloud resource is contacted.

## Non-goals

The first slice does not include:

- a general state-machine DSL;
- a scenario compiler;
- CEL, JavaScript, Lua, shell, or arbitrary SQL in scenario definitions;
- arbitrary response-body fixtures;
- a general workflow engine;
- a full operations console;
- automated generation of every possible scenario combination;
- changes to production Auth or frontend behavior.

## Core Model

The system has two independent file-backed registries.

### Capability registry

Each mockserver declares the capabilities it implements. A capability is a
stable semantic operation with a finite set of named presets.

Example:

```yaml
id: tencentcloud.faceid.id-card-verification
provider: fake-tencentcloud
defaultPreset: success
presets:
  - success
  - identity-mismatch
  - timeout
```

The mockserver owns:

- protocol parsing;
- protocol response construction;
- valid preset names;
- any protocol-specific persistent state.

Adding a capability or preset may require mockserver code. Adding a scenario
that references existing capabilities does not.

Capability files are the source of truth. They are loaded and validated at
startup; they are not copied into a database in the first slice.

### Scenario registry

A scenario is data. It contains metadata and sparse capability overrides.
Capabilities not mentioned by a scenario use their declared default preset.
The localstack default is therefore full external-boundary simulation with
successful behavior.

Example:

```yaml
id: realname-failed
name: 实名不通过
tags:
  - auth
  - realname
overrides:
  tencentcloud.faceid.id-card-verification:
    preset: identity-mismatch
```

The scenario directory may contain thousands of independent files. The control
service loads them into a searchable, paginated list. A small generated index
may be added when scale requires it, but no capability catalog generator is
required in the first slice.

Scenario files are also the source of truth. The first slice persists only a
user's current scenario selection, not copies of scenario definitions.

`full` is the default scenario and contains no overrides. A user with no
persisted selection resolves through `full`; each unmentioned capability then
uses its capability's `defaultPreset`, which is `success` for the initial
capabilities.

## User Isolation

The Fake QQ page has two user sources:

- `创建空白用户`, the default entry, creates a new local test identity;
- `已存在用户`, accounts present in the active localstack state, including
  users restored by the active snapshot and users created during this runtime.

Creating a blank user does not pre-seed rows or state in Auth, subscription,
payment, sandbox, or other application services.

Each created user has local synthetic identities:

- Fake QQ OpenID;
- display name;
- local phone fixture;
- local real-name test name;
- syntactically valid local test ID card number;
- aliases needed by mockserver protocols.

The real-name identity values are synthetic local fixtures. Fake QQ displays
them, the local phone fixture, and the development SMS code after the user is
selected so the developer knows what to enter in the existing real-name flow.
The phone fixture is not pre-bound to the Auth user by Fake QQ.

The first OAuth login creates the Auth user through the normal application
flow. Its phone is empty, real-name verification is incomplete, and it has no
subscription, order, agent, or sandbox state unless the normal application
flow creates that state later.

Reusing an existing mock user preserves state produced by earlier interactions.
Scenario selection never silently resets application or mockserver state.
Starting blank again uses `创建空白用户`; explicit reset remains a later
operation.

Fake QQ defaults to `创建空白用户` with the `full` scenario when no automation
selection is supplied. Submitting it creates a unique mock user, Fake QQ
OpenID, phone fixture, and real-name identity alias before continuing OAuth.

## Localstack State Snapshots

A snapshot belongs to the whole localstack environment, not to one user. It
captures a coherent baseline across participating services, for example:

- Auth users, phones, and real-name state;
- subscriptions and payment/order state;
- agents and sandbox allocations;
- mockserver protocol state;
- `mock-control` users and active scenario selections.

The Fake QQ existing-user list is a view of accounts available in the active
snapshot plus users created after restore. Selecting a user does not restore a
snapshot.

Snapshots and scenarios have separate responsibilities:

- a snapshot establishes state that has already happened;
- a scenario controls behavior of future fake-provider calls;
- switching a scenario does not rewrite snapshot-derived state;
- restoring another snapshot is an explicit environment-wide destructive
  operation.

For portability, repository snapshots are logical seed bundles with a manifest
and service-owned SQL or fixture data. Raw Docker volumes, Kubernetes PVC
images, and machine-specific database files are not committed. The first slice
uses the existing localstack bootstrap/seed path for its default baseline; a
general snapshot create/restore command and snapshot selector are later work.

The selected scenario is stored per local test user. Switching a user's
scenario affects only future mock calls. It does not rewrite protocol state
that already exists.

### Protocol alias boundary

Production Auth sends only `Name` and `IdCard` to `IdCardVerification`; it does
not send the QQ OpenID or an Auth user ID. Without changing production Auth,
`fake-tencentcloud` therefore cannot prove that the entered identity belongs to
the currently logged-in QQ account.

For localstack, the deterministic real-name fixture is the protocol alias for a
mock user. The expected flow is:

1. select mock user A in Fake QQ;
2. Fake QQ displays user A's real-name fixture;
3. enter that fixture in the existing account page;
4. `fake-tencentcloud` resolves the request to mock user A.

If a developer deliberately enters user B's fixture while logged in as user A,
the request resolves to user B and uses user B's scenario. This is explicit
local test semantics, not a claimed production identity binding. A strict
login-to-provider binding would require production context propagation and is
outside this design.

Automation isolation can later create unique local test users from the same
fixture template. It does not require production services to propagate a
`mock_run_id` header.

## Runtime Components

### mock-control

A localstack-only service provides:

- scenario loading and validation;
- test-user listing;
- per-user scenario selection;
- identity alias resolution;

It loads capabilities, scenarios, and the blank-user template from repository
files. It stores created mock users and their current scenario selection in
MySQL. It is included in the localstack manifests, but it is not included in
non-local environment overlays or release images.

The local MySQL bootstrap creates a dedicated `mock_control` database and user.
`mock-control` runs an idempotent startup migration so an empty MySQL volume
requires no manual setup.

The bootstrap is responsible only for the database and database user. The
`mock-control` startup migration is responsible for application tables.

The first slice has one runtime table:

#### `mock_users`

- `mock_user_id`;
- `display_name`;
- `qq_openid`;
- synthetic phone and real-name fixture fields;
- `identity_alias_hash`;
- `active_scenario_id`;
- `created_at`;
- `last_selected_at`;
- timestamps.

The versioned blank-user template defines how these local-only values are
generated. `mock-control` builds an in-memory index from a hash of normalized
name and ID card to `mock_user_id`; raw identity values are never used as
database lookup keys. The raw values stored in this local-only table are
synthetic fixtures, not real identities.

`mock_user_id`, `qq_openid`, `phone`, and `identity_alias_hash` have database
unique constraints. Blank-user creation generates a syntactically valid local
phone and ID card, inserts the user and initial scenario in one transaction,
and retries generation on a unique-key conflict. The API returns success only
after all four identities are durably unique.

Real-name values are not returned by general list endpoints. Fake QQ obtains
them through the internal user-detail endpoint only for its local
selection/confirmation page.

### Fake QQ

`GET /oauth2.0/authorize` renders a local selection page when no explicit
automation selection is present.

The page contains:

- a default `创建空白用户` action;
- a selector for existing local users;
- a searchable and paginated scenario selector;
- scenario name, tags, and description;
- the selected user's local real-name test fixture;
- an `以此场景登录` action.

Submitting the page either creates a blank user or updates an existing user's
active scenario through `mock-control`, then continues the existing OAuth code
flow. OAuth protocol behavior after selection remains unchanged.

`qq-oauth` is shared with the legacy `deploy/local` compose stack. Scenario
mode is enabled only when `MOCK_CONTROL_BASE_URL` is configured by localstack.
Without it, `qq-oauth` preserves its current immediate-redirect behavior and
does not require `mock-control`.

### fake-tencentcloud

`fake-tencentcloud` registers
`tencentcloud.faceid.id-card-verification`.

For `IdCardVerification` it:

1. normalizes and hashes the received local name and ID card;
2. resolves the corresponding local test user through `mock-control`;
3. resolves that user's active preset for the capability;
4. returns the existing Tencent Cloud-shaped response;

Preset behavior:

- `success`: `Result = "0"`;
- `identity-mismatch`: a non-zero result with a local mismatch description;
- `timeout`: delayed or unavailable response, added after the first slice.

If no local user can be resolved, the adapter returns a deterministic local
error rather than silently choosing another user's scenario.

Alias normalization is shared by fixture loading and request handling:

- decode as UTF-8 strings;
- apply Unicode NFKC normalization;
- trim leading and trailing whitespace;
- uppercase the ID card value;
- hash `normalizedName + NUL + normalizedIdCard` with SHA-256 and encode it as
  lowercase hexadecimal.

`fake-tencentcloud` uses the same optional integration rule as Fake QQ. When
`MOCK_CONTROL_BASE_URL` is absent, it preserves the current successful default
used by the legacy compose stack.

## State Ownership

`mock-control` owns only scenario selection and the in-memory alias index.

Each mockserver continues to own its protocol state:

- Fake Jifei owns deal and callback state;
- fake-envd owns process invocation state;
- Fake QQ owns OAuth code/token state;
- fake-tencentcloud owns provider-specific behavior.

When these services become scenario-aware, their persistent rows are keyed by
`mock_user_id` or an alias resolved to that user. This preserves per-user
isolation without inventing a universal state-machine schema.

## Runtime Switching

Changing a user's scenario changes only future behavior.

The linearization point is the committed `PUT` update:

- after `PUT /v1/users/{mock_user_id}/scenario` returns success, a newly
  started `resolve` observes the new scenario;
- a request that has already resolved its preset keeps that preset until its
  response completes;
- switching does not rewrite provider state created before the update.

Existing protocol rows remain unchanged. Explicit operations are
used for:

- resetting one mockserver's state for a user;
- resetting all local mock state for a user;
- creating a new isolated user for automation.

Only scenario selection is required in the first slice.

## API Surface

Initial local-only endpoints:

```text
GET  /v1/scenarios?q=&tag=&page=&page_size=
GET  /v1/users?q=&page=&page_size=
GET  /v1/users/{mock_user_id}
POST /v1/users
PUT  /v1/users/{mock_user_id}/scenario
POST /v1/resolve
GET  /healthz
```

`GET /v1/users` returns the paginated non-sensitive existing-user list.
`POST /v1/users` creates a blank user from the versioned template and assigns
the requested scenario, defaulting to `full`. The user-detail endpoint is
available only on the cluster-local service and returns the selected synthetic
fixture required by Fake QQ.

`POST /v1/resolve` accepts a capability ID and hashed identity aliases. It
returns:

```json
{
  "mockUserId": "local-user-000001",
  "scenarioId": "realname-success",
  "preset": "success"
}
```

The service is reachable only inside localstack, except for any explicitly
exposed local operations UI added later.

The API is not a general mutation surface for capability or scenario
definitions. Those remain repository files.

`mock-control` is built as a dedicated local-only Node image from
`deploy/local/mockservers/control/Dockerfile`. Its package manifest pins the
YAML parser and MySQL driver required by the service. `localstack.sh` builds the
image for the configured local platform and deploys one replica through the
localstack manifests. It is not part of the release-image contract.

## File Layout

```text
deploy/local/mockservers/
├── control/
├── qq-oauth/
│   ├── server.mjs
│   └── capabilities.yaml
├── tencentcloud/
│   ├── server.mjs
│   ├── server.test.mjs
│   └── capabilities.yaml
└── scenarios/
    ├── user-templates/
    │   └── blank.yaml
    └── scenarios/
        ├── full.yaml
        ├── realname-success.yaml
        └── realname-failed.yaml
```

One file defines one user or scenario. IDs are stable and do not depend on file
paths.

## Operations UI

The immediate UI is the Fake QQ selection page.

A later lightweight local operations page may provide:

- user list;
- scenario switching;
- event timeline;
- explicit reset operations.

Raw database inspection should use a local read-only Adminer deployment rather
than a custom database browser. Adminer is not required to deliver the first
real-name scenarios.

## Validation

The first slice is complete when:

1. localstack starts from an empty MySQL volume without manual setup: the
   infrastructure bootstrap creates the `mock_control` database/user and the
   service startup migration creates its table;
2. Fake QQ defaults to `创建空白用户`, lists previously created local users,
   and lists `full` plus both real-name scenarios;
3. creating a blank user with the success scenario completes the existing
   `IdCardVerification` and local phone-verification steps and reaches Auth's
   final verified state;
4. creating another blank user with the failed scenario shows the existing
   identity mismatch frontend message;
5. the two created users do not share active scenario state;
6. switching one user's scenario changes only subsequent verification calls;
7. unit tests cover Fake QQ's selection page, selection submission, OAuth
   continuation, and legacy fallback when `MOCK_CONTROL_BASE_URL` is absent;
8. `fake-tencentcloud` tests cover success, mismatch, unknown identity, and
   legacy fallback;
9. `mock-control` tests cover blank-user creation, identity uniqueness and
   conflict retry, paginated existing-user and scenario search, invalid
   scenario rejection, the default `full` resolution, per-user selection
   isolation, alias normalization, and the committed-update switching
   boundary;
10. the unified localstack validation script runs all three test suites and
    checks scenario references against capability presets;
11. localstack bootstrap and the service startup migration establish the
    `mock_control` database, user, and table from an empty MySQL volume;
12. no non-local environment manifest references `mock-control`;
13. no real external endpoint is contacted.

## Incremental Delivery

### Slice 1

- `mock-control` file loading, minimal selection persistence, and
  read/selection APIs;
- blank-user creation and existing-user listing;
- the default `full` scenario and two real-name scenario files;
- Fake QQ selection page;
- fake-tencentcloud success/mismatch resolution;
- browser verification.

### Slice 2

- runtime scenario switching UI;
- per-user reset operations;
- event timeline;
- sanitized event persistence;
- read-only Adminer.

### Slice 3

- automation API for unique users;
- additional mockserver capabilities;
- generated scenario index if list size or search latency requires it.
