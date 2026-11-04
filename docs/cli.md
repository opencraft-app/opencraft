# OpenCraft CLI

The bundled `opencraft` command connects to a Headless server through its
authenticated OpenCraft SSH ingress. Configure your own SSH identity, agent and
known_hosts first. System maintenance SSH access alone does not grant an Actor.
The existing managed website launcher remains `opencraft-web`; service units
continue to use their installed runtime entry.

```sh
opencraft connection add work --ssh my-opencraft --default --json
opencraft server list --json
opencraft status --json
opencraft thread list --server '<server-id>' --json
opencraft thread show '<conversation-uri-or-https-link>' --json
opencraft thread log '<conversation-uri>' --tail 2 --json
opencraft thread log '<conversation-uri>' --json
opencraft thread log '<conversation-uri>' --cursor '<nextCursor>' --json
opencraft thread send '<conversation-uri>' 'Review this change' --mode queue --key review-01 --json
opencraft thread send '<conversation-uri>' --message-file ./message.txt --key review-02 --wait delivered --timeout 30s --json
opencraft thread lookup '<conversation-uri>' --key review-01 --json
opencraft thread show '<conversation-uri>' --delivery '<request-id>' --json
opencraft thread send '<conversation-uri>' 'Adjust the current turn' --mode steer --expected-turn '<exact-turn-id>' --key steer-01 --wait delivered --json
opencraft thread list --server '<server-id>' --project '<project-id>' --cwd /remote/repo --json
```

Profiles contain only the SSH alias, expected installation identity and optional
default Server. They are stored at `~/.config/opencraft/connections.json`;
`OPENCRAFT_CONFIG` selects another file. Set `--default-server` during connection
registration to choose an explicit default. `--connection` overrides
`OPENCRAFT_CONNECTION`, which overrides the configured default. `status` without `--server` returns a `servers` array containing all visible
Servers and their advertised states, even when a default Server is configured;
`status --server ...` retains the single `server` result. An empty directory is a
successful empty summary. Connection readiness does not imply every Server is ready.

`--server` accepts a full ID (preferred on exact match), or an exact,
case-sensitive engine or label that identifies one Server in this connection's
already-authorized directory. No prefix, suffix or cross-connection lookup is
performed. A canonical conversation reference selects its own Server; an explicit
selector must resolve to the same ID. Without a reference or explicit selector,
single-Server commands use the connection default, then the sole visible Server.
This applies to list, create, lookup without a reference, project/model discovery,
search and count. Unknown or ambiguous selections list full candidate IDs in both
human error text and JSON `error.details.servers`, with `--server` and
`--default-server` guidance. Real connection/operation failures keep their existing
meaning. An unavailable advertised Server remains selectable; its operation may fail.

`connection add <new-name> --ssh <alias> --default-server codex --default`
resolves a unique short name once and saves its full ID. Existing connections are
not overwritten by `connection add`; use a new profile name or update the existing
profile's `defaultServer` in the connections file. A stale default reports not found
rather than silently choosing another Server. Explicit options that conflict with a URI fail. Links are
parsed locally and never cause requests to their origin. Unknown installations
and legacy page links are not guessed.

Project filters use exact IDs, never project names. `--cwd` is an absolute path
in the selected Server's filesystem and is normalized there; the caller's cwd
is not substituted. Each request remains a bounded native catalog page. Filters
are negotiated independently; this release supports Codex filters, and other
engines explicitly return unsupported rather than ignore a filter.

Steer requires `--mode steer --expected-turn <exact-turn-id>`. It targets only
that running Turn; stale/finished Turns are rejected without queue fallback.
The Turn ID from a known delivery receipt can be used as the explicit target.
Metadata may leave currentTurnId null when it cannot establish the native value.
Queue remains the default mode.

`attention` contains only the waiting kind and available interaction identity,
never questions or approval payloads. Approval/question native flags are exposed;
unavailable login/setup details are not guessed. Configure the connection with
`--web-url https://your-server.example/` to attach a canonical UI link. `show`,
every `list` item, every successful `send` and a found `lookup` return top-level
`uiLink`, independently of attention or delivery state. An unknown lookup or a
missing public URL returns null. `show --delivery` and `show --delivery-key`
follow the same rule. Explicit titles already returned by `list --include-title`
may appear in links; building a link never reads content or fetches another title.
The shared `conversationLink` encoder preserves the deployment base path and
binds the complete canonical Server/Thread in the `conversation` query. The
website resolves that identity through authorized reference and metadata-only
reads before navigation; a `/local/` path or current Host cannot change it.
These HTTPS links also work as CLI inputs, with the original Server conflict and
authorization checks. The CLI supports `interactions list`, `interactions show`
and structured `interactions respond` for negotiated approval/question methods.
Unsupported interaction methods continue through the UI; ordinary tell does not
answer them. Queue acceptance can carry the last observed attention and
timestamp while remaining unconsumed. Recovery metadata comes from the existing
Host recovery read; recovering/unknown/idle do not establish task completion.
Recovery reads are optional and bounded to one second; unavailable recovery stays
null while native metadata remains available. Steer performs no attention read.
Queue is durably accepted before its optional attention read, which has a
two-second budget. Failure reports an unknown attention kind and preserves
the accepted receipt; it cannot delay admission behind a slow Host read.

`list` and `show` return metadata without titles, previews, messages or tools.
`list --include-title` includes only explicit native titles, without a preview
fallback. Metadata reads use native metadata operations, with rollout repair
disabled on discovery. Unavailable facts remain null or unknown. `log` explicitly
reads user/assistant text, one bounded native item per page and at most 2,000
Unicode characters per chunk; follow `nextCursor` to preserve long-message tails.
Tool items can produce an empty page with a continuation. A changed watermark
requires a new read without a cursor. The CLI never resumes a conversation.

For a running conversation, use `thread log <ref> --tail N` (`N` is 1–5 recent
Turns, including an unfinished Turn). `tailRead` is negotiated separately from
`boundedRead`, both at the command lane and for the selected Server. Older
services and unsupported engines reject it before any history read. Each call
reads one descending Turn-header page and at most one descending page of 30
native items per selected Turn, with a shared ten-second deadline. It never
scans earlier history, builds a cold transcript index or retries invalid cursors. Output includes only user and
assistant text, in chronological order. Each entry retains the last 2,000 Unicode
characters and its original character `offset`; `partial:true` marks an omitted
message prefix. The serialized entries have a 24,000-byte budget; more recent
entries take priority. Tools count toward the native item page but are not
returned. `partialTurnIds` identifies Turns whose item page or output budget
omits content. `truncated` also reports older Turns or shortened text. The result
is a recent observation, not a single immutable snapshot across Turns.

Tail returns `nextCursor:null` even when truncated: repeat the same `--tail N`
command without a cursor to observe newer output. A caller can reconcile entries
by `(turnId,itemId,offset)`; streaming text may replace the same item. A tail
watermark hashes only this bounded output and is not a continuation token.
`--tail` and `--cursor` cannot be combined. Omit `--tail` to retain the original
forward paging and watermark-failure semantics.
This first CLI release supports bounded logs on Codex. Other engines report
`read:false` and `boundedRead:false` in the directory and reject CLI logs with
`UNSUPPORTED_CAPABILITY`. Their existing conversation readers remain available
through their original consumers; the CLI never selects those readers.

Send accepts positional text, a UTF-8 `--message-file`, or stdin (including
`--message-file -`); choose one. Non-interactive calls require an explicit `--key`.
Interactive calls can generate a key saved before sending, with only the Actor,
installation, target and timestamp, in `operations/` beside the profiles file.
Identical Actor/key/payload repeats return the original request; changed content
or target conflicts. A disconnected send returns exit 7 and the original key.
Use `thread lookup --key` or `thread show --delivery-key` for read-only accounting;
a missing record remains unknown and is not permission to resend or change keys.

`--wait delivered` polls until submitted/injected, which means the engine accepted
the input. It does not mean the task completed: `taskOutcome` remains unknown.
Timeout/disconnection exits 7 and preserves the key and known receipt. Explicit
rejection/cancellation while waiting exits 8. Querying those facts succeeds with
exit 0. The CLI creates no second queue. Waiting and lookup do not issue stop or
cancellation requests. Explicit `thread stop --expected-turn` and original-request
`queue cancel` use their independently negotiated controls described below.
There is no general CLI resume command.

Every `--json` invocation writes exactly one envelope to stdout:
`{schemaVersion:1,ok:true,data:...}` or
`{schemaVersion:1,ok:false,error:{code,message,retryable,details?}}`.
Additive fields are compatible; breaking changes require a new schema major.
Local argument errors include `error.details.command`, `parameters`, `reason` and
`usage` (the applicable command's help lines). Missing/invalid options, disallowed
options, repeated flags, missing positionals and conflicting choices identify
their parameter names without echoing argument values. Unknown commands use
`UNKNOWN_COMMAND` (exit 2) and include `availableCommands`. Unsupported flags such
as `--version` are reported as unknown options; no version command is introduced.
Capabilities are negotiated individually. Older Hosts return
`UNSUPPORTED_CAPABILITY`; content reads are never a metadata fallback.

| Exit | Meaning |
| --- | --- |
| 0 | Command succeeded; this does not establish task completion |
| 2 | Invalid arguments, input or configuration |
| 3 | Unregistered or unavailable connection, instance or resource |
| 4 | Authentication or permission required |
| 5 | Ambiguity or state conflict, including changed history |
| 6 | Unsupported link, protocol or capability |
| 7 | Timeout, disconnection or uncertain result |
| 8 | Explicit server rejection or internal failure |

Run `opencraft --help` for the installed command set. HTTPS credential exchange,
desktop CLI admission and Session bearer admission are separate future work.

## Current execution and child conversations

Human SSH profiles retain the commands above. Inside an authorized Agent
execution, `thread_cli` returns a private launcher and connection-file path.
The launcher and the existing CLI share the same execution command implementation;
the installed CLI selects it with `OPENCRAFT_THREAD_CLI_CONNECTION=<private-path>`.
It adds context, paginated child discovery, spawn, tell and wait over the existing
Broker. See [Conversation CLI](thread-cli.md). The environment variable contains a
file path, never a bearer; do not copy connection files or switch to a human SSH
profile when execution authorization fails.

## Create a conversation and its first input

```sh
opencraft thread create --connection work --server '<directory-server-id>' \
  --project '<existing-project-id>' --cwd /remote/repo \
  --message-file ./task.md --key create-task-01 --wait delivered --json
opencraft thread lookup --connection work --server '<directory-server-id>' --key create-task-01 --json
```

`thread create [text]` requires a selected Server (using the rules above), existing project ID, remote absolute
cwd and key, including interactive use. Text, UTF-8 file and stdin follow `send`'s
input rules. Only the directory's Codex Server supports creation. The Server uses
the product Host's `project/list` catalog and the Codex `thread/start` path, verifies that cwd
is a directory within the project's canonical roots, and passes those roots to
the native start. Symlinks resolving outside those roots fail. Project selection
is workspace grouping, not an Actor ACL. Admission uses the current human Actor,
instance membership and the same trusted access lane as UI creation; creator
attribution and product execution context come from ingress, never CLI fields.
模型沿现有默认选择；未指定权限时，在 prepareCreate 与 thread/start 前沿原 managed requirements / profile.allowed 校验并绑定 named `:read-only` / `on-request`，避免仅传 raw sandbox 后在 Native resume 时恢复环境默认权限。省略请求仍保留旧指纹及 absent initialOptions，不补成显式请求；缺可信映射或旧 Host 不支持目录时明确拒绝，不降级为 raw sandbox。
新建时可加 `--permission-mode read-only|accept-edits|full`，作用域为
`new-thread-subsequent`，仅对本人这次新 Thread 的后续执行生效。
`initialPermissionMode` 与 `create` 分别协商；旧 Host、未知值、Codex auto/custom
明确拒绝。`--service-tier` 当前明确不支持：锁定 Native 0.162.1 的 sticky tier
重启后不保留；plan 仅可读目录。本批不提供已有 Thread setter、单次 tier、
任意 options、project 创建、parent 或 delegation 参数。
当前准入 human 沿原 Server/project/cwd 创建 authority 与 UI 同权；读权限或
交互 session grant 不能推出创建写权限。写前复验当前 Actor、项目目录与 Native
permissionProfile/managed requirements，不能扩大 provider/account/model 权限。

`create` and `createLookup` are independently negotiated. The server reserves
Actor/key and a fingerprint of operation kind, requested target and text before
one native creation attempt. It durably saves the canonical settings, then the
returned threadId, before admitting first input through the existing durable
queue with an internal key derived from operationId. Identical calls inspect the
original operation; a changed target, content or explicit initial permission conflicts. A key reserved for
send cannot be reused for create or vice versa.

The response reports `operationId`, `operationKey`, `creationState`, nullable
`ref`/`reference`/`uiLink`, `firstMessageState` and nullable `firstMessage` receipt.
Created and accepted are separate facts. `--wait delivered` waits for engine
acceptance only; `taskOutcome` remains `unknown`. An explicitly rejected first
input returns exit 8 with the created reference; it never deletes the thread.
Unknown creation or first admission returns exit 7 with all known facts.

A lost response or crash leaves unknown at the interrupted stage. The native
creation is never retried. A crash between saving the threadId and atomically
committing first admission leaves `created` plus first-input `unknown`.
Use no-ref `thread lookup --server ... --key ...` for read-only accounting.
Lookup never creates, sends, ACKs or pumps; even a missing record is unknown.
Do not change keys to recover an uncertain operation. Recovery does not guess
threadId from titles, does not borrow a parent creation claim, and does not
reconstruct a lost native response. Existing shared and private access semantics
remain in force for every known reference and delivery read.

显式初值作为 `requestedInitialOptions` 留在原创建账；`nativeInitialObservation`
独立报告 Native thread/start 的分配时观察，缺字段保留 null，不证明某 Turn 的实际值。
两者复用原 `settings_json`，不写普通输入冻结表。Native 0.162.1 首 Turn 前整个 Thread
尚无 rollout，重启无法 resume；Hub 保留请求事实，但不重建、不回放或补偿写权限。
非默认 accept-edits/full 权限在合成 Turn 落盘后才实测跨重启保留。


Creation and no-reference creation lookup consume the same `conversationUiLink`
contract as show/list/send. Every lookup result has top-level `uiLink`; a found
operation also retains its nested link for compatibility. A known ref keeps its
link even when creation or first delivery is unknown. Missing refs and missing
webUrl produce null. Encoding a link never triggers a title/content read; the
complete Server identity round-trips through CLI parsing and website resolution.


## Read-only project and execution discovery

```sh
opencraft project list --connection work --server '<directory-server-id>' --json
opencraft server models --connection work --server '<directory-server-id>' --json
opencraft thread options '<ref-or-link>' --connection work --json
```

Project/model discovery uses the Server selection rules above; follow `--cursor` even on an
empty filtered page. Each source request is bounded to 30 rows. Project IDs and
roots belong to the Host catalog used for creation, not Native project IDs or ACLs.
Model IDs, permitted reasoning efforts and advertised tier IDs pass through the
installed model-policy owner. The catalog is a dated availability hint, not proof
of an executed Turn. Unavailable providers fail without changing defaults.

Each read negotiates `projectDiscovery`, `modelDiscovery` or `executionOptions`.
Old services fail explicitly. Options enforce current resource access before and
after observation; Native current/last-persisted configuration is obtained through
strict source reads, never from cached display metadata. Missing observations stay
null; `actualTurnSettings` is null. Permission ceiling and dynamic options remain
unsupported/unknown until a real policy owner supplies them. This interface does
not modify settings, approve permissions, read message bodies or start a Turn.

追加的 `optionCatalog` 由独立 `optionCatalog` capability 声明，保留上述旧字段语义。
它按当前 Thread cwd 只投影标准 permissionMode、profile.allowed 与 managed constraints、
plan/default 模式目录，包含 source、observedAt 和 new-thread-subsequent scope。
`initialWrite` 分别报告权限初值、tier 和 plan 写能力；仅支持已核实的权限初值。
目录允许值只是当前 Host/Native 观察，不是 Actor 授权或权限 CAS；自定义 profile
没有可信 named 映射就不猜。缺方法与故障分别保持 unsupported/失败，不公开 provider
配置、URL 或 developer instructions。tier ID 继续来自最终模型的 modelCatalog，
目录列出它不表示 sticky tier 可写。

Thread options includes the first policy-filtered `modelCatalog` page. Continue
its cursor with `server models --server <same-server> --cursor <cursor>`; a
partial catalog does not claim that omitted choices are unavailable.
## Exact Turn completion and final output (Codex)

```sh
opencraft thread wait '<ref>' --request '<request-id>' --timeout 30s --json
opencraft thread wait '<ref>' --key '<original-send-or-create-key>' --until terminal --json
opencraft thread output '<ref>' --request '<request-id>' --json
opencraft thread output '<ref>' --turn '<exact-turn-id>' --cursor '<nextCursor>' --json
```

Choose exactly one of `--request`, `--key`, or `--turn`. Send/create keys resolve
only the original Actor's committed request and its original target Turn. A
missing key, queued request or null target remains unknown/pending. Reads
recheck current admission and resource access; an explicit Turn grants no
execution identity. `wait` polls this target only: old idle state, another Turn,
attention and recovery do not complete it. Only Native `completed`, `failed` or
`interrupted` yields `matched:true`; this read succeeds with exit 0 for any of
those terminal states. It does not establish business success. Existing receipt
`taskOutcome` remains `unknown`. Timeout/disconnection is exit 7 and never
pumps, resumes or retries input. The default wait is 30 seconds (maximum 1 hour).

`output` returns **one page**, containing at most 2,000 Unicode characters of a
trusted `agentMessage` with phase `final_answer`. Follow every `nextCursor` and
assemble entries by item ID and character offset in order. It never substitutes
commentary, tool output, user messages or a different Turn. An unfinished or
unlocated Turn has `complete:false`. A terminal Turn without final phase, or
with an unclassified assistant message, reports `finalUnavailable:true` and
cannot claim completeness; known final chunks may still be returned.
`complete:true` marks the last page of a complete, terminal source snapshot;
it does not mean that one page contains preceding chunks. An empty final string
is valid. A consumer needs all preceding pages before claiming the full result.

Each page rechecks a fresh source through the existing Transcript owner and
returns its `source`, `observedAt`, target `watermark` and terminal state. Source
`native-transcript` means that owner's Native Turn projection, not a cached
last reply. The cursor binds Server/Thread/Turn, the Native storage generation
and file incarnation, and the full target content hash. A changed target or
source rejects the cursor with `HISTORY_CHANGED`; begin a fresh read. Appending
other Turns leaves the target hash unchanged. If a target cannot be located
within the bounded source window, it stays unknown/unavailable; that alone is
not proof that the target changed.

The new `exactResult` capability is negotiated independently at CLI/Collaboration
and Host/history boundaries. First support is Codex only; older Hosts and other
engines report unsupported. Every source read has a nine-second total budget,
including queueing, source resolution, at most 20 one-Turn header pages, target
hydration, hash/projection and source revalidation. It does not rebuild a cold
full-history index. Native complete Turn reads are reused when Item pagination
is unavailable. No partial/header-only Turn can claim complete output; an
oversized Turn beyond the existing Native full-Turn budget or unavailable
source is explicitly unavailable. There is no Core change, migration, new task
queue or root-task/recovery-attempt result aggregation.

For this read port, a missing source, exhausted read budget or an incomplete
full-Turn fallback is `HISTORY_READ_UNAVAILABLE` (exit 7), not a connection
failure or a reason to resend input. `wait` keeps polling this read until the
user's timeout; `output` reports the unavailable category. Only an actually
unsupported negotiated capability/Native header protocol is unsupported (exit 6).
The history transport preserves only these allowlisted read error codes and
`HISTORY_CHANGED`; it never forwards arbitrary Native error data.
The Host transport or outer read deadline may expire before the source ceiling;
these specific timer failures retain the same read-unavailable category.
Admission and storage rejections are not indiscriminately relabeled as timeouts.

## Exact Turn stop and original queue cancellation

```sh
opencraft thread stop '<ref-or-link>' --expected-turn '<exact-turn-id>' --json
opencraft thread stop '<same-ref>' --expected-turn '<same-id>' --observe-only --json
opencraft queue cancel '<ref-or-link>' --request '<original-request-id>' --json
opencraft thread show '<same-ref>' --delivery '<original-request-id>' --json
```

Codex controls negotiate `stop`, `stopObserve` and `queueCancel` independently;
old services/Hosts fail explicitly. Stop uses current admitted human/resource
access and the existing owner control scope, checks the exact active Turn and
rechecks authority at Native submission. It does not kill a Core/Host or clear
follow-up inputs. `requestState=acknowledged` means only an interrupt RPC ACK;
`observation.turnState` is a separate Native header observation. Empty ACKs do
not establish stopped. No stop key, persistent operation lookup or cross-restart
exactly-once promise is provided.

After disconnection/unknown, use the exact same target with `--observe-only`.
This only reads Native headers (at most five recent Turns); an older/missing
Turn stays unknown. A terminal observation does not prove which caller stopped
it or that the task succeeded. The CLI never replays an uncertain control.

Queue cancel accepts only this Actor's original queue request on this exact ref,
serializes with the Hub handoff pump, and retains the original message, identity
and model snapshots. It never accepts a Native queue-row ID as a Hub request ID.
Claimed/unknown requests conflict instead of force deletion. A persisted cancelled
request can be repeated/read after restart without a new deletion. A lost delete
response stays unknown in the existing request ledger; inspect delivery before
another action. There is no force flag, retry, reorder or permission change.

### Explicit Codex model settings

`thread create` and queue-mode `thread send` accept `--model <catalog-id>` and
`--reasoning-effort <effort>`, independently or together. For example:

```sh
opencraft thread create 'Synthetic task' --connection work --server '<server>' \
  --project '<existing-host-project>' --cwd '/remote/workspace' --key task-01 \
  --model gpt-6.1-sol --reasoning-effort medium --wait delivered --json
opencraft thread send '<ref>' 'Next task' --key task-02 \
  --model gpt-6.1-sol --reasoning-effort medium --json
```

The Server catalog/policy must allow the selection. `modelSettings` is negotiated
separately; old services, unsupported engines and steer reject it. Omitting both
flags retains Native defaults. No arbitrary config/provider/permission flags are
introduced. Settings are frozen per request and included in key conflicts; they
survive queue delay/restart. Lookup never reapplies them or retries unknown input.

Receipts expose `requestedSettings`, not an assertion of completed execution.
Create can include `nativeConfirmedConfiguration` observed from Native's actual
creation response. `show` reads Native current/last persisted configuration with
`scope`, `source`, `observedAt`; an empty ACK or unavailable fields remain null.
`actualTurnSettings` is null because this Native API provides no attributable
per-Turn configuration evidence. A later thread setting cannot prove an earlier
Turn's model/effort. Permissions retain their existing defaults and policy.

### Scoped Turn configuration observation

`thread show REF --delivery REQUEST --include-turn-configuration` adds a separately
negotiated `turnConfigurationObservation`. Use `--delivery-key KEY` for the original
send/create key, or `--turn TURN` for an explicitly resource-authorized Turn;
choose exactly one selector. `--turn` on show requires this opt-in. Ordinary show,
lookup, delivery receipts and wait do not trigger configuration scans.

The observation has scope `turn-first-recorded-context` and source
`native-rollout/turn_context`. `recordedAt` is the source record's time;
`observedAt` is the read time. Only an exact, still-visible Native Turn with its
retained start boundary and complete retained prefix can be `observed`, with
`initiality: start-boundary-observed`. This is not original-initial, provider routing
or later-step execution telemetry. `actualTurnSettings` remains null and frozen
`requestedSettings`, delivery state, task outcome and execution leases are unchanged.

Missing model/effort fields remain null. Identical model/effort duplicates retain
the first record and time; differing values (including missing versus present),
missing start/session boundaries, compaction/rollback markers, malformed critical
records or an incomplete last line produce `unknown`, never a last-context fallback.
Queued accepted input without a Turn is `pending`; an unknown key is `unknown`.
Old Hosts and non-Codex engines are `unsupported`; source/IO failures are
`unavailable`, while insufficient coverage/deadline is `unknown`. No status retries input. The total deadline also includes Host initialization; an
outer deadline signal is unknown coverage, not a source/IO failure.

The existing Transcript reader owns this projection: a nine-second total budget,
twenty Native header pages shared by before/after target checks and an eight-MiB
retained-prefix limit. Two bounded reads verify the same bytes; the second pass
and final validation must be stable. A concurrent source edit can return unknown;
unrelated appends between queries do not change the target observation watermark.
No cold full-history index or new durable owner is created. Cancellation reaches
source resolution, the shared byte reader and oversized-line scanning. Only the
whitelisted model/effort, target, scope/source, times, coverage/initiality and opaque
watermark leave the Host; paths, raw records and generation identities do not.


## Own Hub queue request observations

`queue list <ref-or-link> [--cursor <opaque>] [--limit 1..100]` negotiates the
independent `queueRequests` capability on both Hub and Server directory. It only
reads the current human Actor's queue-mode Hub requests for that exact Server and
Thread, in `accepted`, `transferring`, `queued` or `unknown`. Existing resource,
private creator and orchestration owner/action-grant checks apply before and after
reading. Session/agent credentials receive no new read or execution authority.

The response has `scope: own-hub-queue-requests`, `source: hub-request-ledger`,
`observedAt`, `consistency: bounded-membership-live-state`, allowlisted `entries`,
`nextCursor` and `complete`. Entries expose request ID, nullable operation key,
mode, delivery state, target Turn, timestamps and original requested model/effort.
`actualTurnSettings` and `nativeConfirmedConfiguration` remain null;
`taskOutcome` remains unknown. No body, principal, credential, internal queue ID,
position, precise total, cancelability or retry eligibility is returned.

This is not the whole Host queue: UI/raw/system and other Actors' requests are
absent. `unknown` may already have executed. A submitted request leaves this
list even if its Turn is still running; absence is not completion. Use the original
request ID with exact wait/output to observe its result. Reading never pumps,
resumes, retries, cancels or calls an execution Host/Native port.

Each scan fixes a global request-rowid upper membership bound and advances an
ascending numeric window of at most 1024 rowids. SQL applies Actor/ref/mode/state
filters before LIMIT; the table B-tree range is forced instead of scanning a
state index or all Actor keys. Each page returns at most 100 rows (default 50),
with indexed per-request settings reads and a 100ms monotonic read/projection
budget. Budget/IO failure is `QUEUE_READ_UNAVAILABLE` (exit 7, no automatic input
retry). SQLite work is bounded synchronously; this is not a hard IO cancellation
or whole-list latency guarantee. Sparse pages can be empty with a next cursor;
keep paging until `complete`, which means enumeration only, not business success.
State is read live on each page, not frozen across pages. Newly appended requests
are excluded from that scan; rows that leave the selected states before their
page are absent. A row that becomes selected after its window passed requires a
new scan. No exact total or transaction snapshot is promised.

Cursors are authenticated, encrypted and bound to Actor/generation, exact ref,
filter, upper bound and scan position. They are read navigation, never credentials.
The Collaboration owner's process-lifetime key is not persisted: restart, another
Hub owner, forgery or scope mismatch returns `QUEUE_CURSOR_INVALID` (exit 5),
requiring a new scan. A normal reconnect to the same owner can continue. Page
limit can change without changing membership. No index/schema migration is added.

`operationKey` is currently null because the existing key table has no indexed
request lookup suitable for bounded bulk observation. The exact original
receipt/lookup API retains its key semantics. This endpoint does not guess a key
from internal IDs or content and does not scan every key per returned row.
Old Hubs/directories without this capability return unsupported (exit 6).
### Explicit Thread defaults (local candidate)

```sh
opencraft --connection join thread defaults '<ref-or-ui-link>' \
  --scope subsequent-native-turns-including-already-accepted \
  --permission-mode accept-edits --collaboration-mode plan \
  --model gpt-6.1-sol --reasoning-effort medium
opencraft --connection join thread defaults '<same-ref>' --observe-only
```

All four choices and the exact scope are required for a write. This changes the
defaults of subsequent Native Turns, **including other participants' already
accepted but unsent inputs**. Current admitted shared human participants use the
existing raw Thread resource lane; private remains creator-only. Native read-only
is a sandbox, not a read-only participant role. Bot/session/delegation and old
Hosts cannot use this capability.

A single ACK is `acknowledged`, never `saved` or proof of Turn usage/persistence.
Lost ACK/timeout exits 7 with `THREAD_DEFAULTS_OUTCOME_UNKNOWN`, known ref/scope
and requested bundle. Do not repeat it or use a new key: there is no operation
ledger/CAS/replay. `--observe-only` is a separate read, not a lookup of the write.
It reports only strict Native current/last-persisted facts; unavailable fields
remain null and actualTurnSettings remains null. No config/cwd/instructions,
sticky tier, live settings or outer model tuple is accepted. This candidate does
not claim a production setter is enabled.

## Recorded name search

```sh
opencraft thread search --server '<server-id>' --field name 'Release' --json
opencraft thread search --server '<server-id>' --field name 'Release' --cursor '<nextCursor>' --json
```

This independently negotiated `threadSearch` / `recorded-name-v1` read searches
only string `name` values already recorded by the Host's ThreadDirectory. Both
query and name are normalized to NFC; matching is a **case-sensitive literal
substring**, without locale-dependent folding. Queries contain 1–512 Unicode
code points and must not be blank. Missing names are not extracted from preview,
first prompt, body, cwd or project. There is no full-text, count, fork or compact
command in this capability.

Only currently admitted humans can search. Each result uses the same
`conversation.discover` and resource/private/orchestration intersection as
metadata discovery; this metadata read does not additionally require
`conversation.read` or a CLI-specific grant. The response contains only `ref` and
`name` entries, at most 30 per page. Each call examines at most one 1024-rowid
window of the existing directory. An empty page can have `nextCursor`; only
`complete` ends traversal of this recorded directory revision, never the Native
history as a whole. `count` remains `{status:"unknown", value:null, unit:"threads"}`;
do not sum pages into a stable total.

`scope=authorized-recorded-names`, `source=host-thread-directory`,
`coverage=recorded-only` and `consistency=revision-bound` describe the source.
`observedAt` is the original directory's last successful metadata sync time,
not a model execution time or proof of exhaustive Native coverage. The opaque,
authenticated cursor binds Actor/generation, Server, query, field/normalization,
archive partition, owner lifetime/revision/sync state and traversal bounds.
Metadata changes, synchronization, source replacement or owner restart invalidate
it. Start a new search on `THREAD_SEARCH_CHANGED` or
`THREAD_SEARCH_CURSOR_INVALID` (exit 5).

Cold/untrusted state, unreadable or oversized metadata, cancellation and exhausted
read budgets return `THREAD_SEARCH_UNAVAILABLE` (exit 7, no input retry). The
nine-second budget includes queueing, Host reads, current ACL checks and the
final source fence check. The directory also checks a 100ms local read budget
between rows and after SQLite returns; synchronous SQLite IO is not forcibly
interrupted. Metadata JSON is bounded to 64KiB and names to 4096 code points;
oversized values make the page unavailable instead of being silently omitted.
Old Hubs/Hosts and non-equivalent engines return unsupported (exit 6).

Codex local and remote adapters share the original ThreadDirectory implementation
and lifecycle. Local Codex now maintains that derived metadata projection on its
existing Host17 connection: background state-only metadata pages, cooperative
chunking, incremental sync and retirement cancellation. Those background writes
are separate from search. Search does not call `list`, refresh, reindex, Native,
pump or any business write. Existing local thread/list routing stays unchanged.

## Imported public message text search

`thread search --server SERVER --field text QUERY [--cursor=CURSOR]` independently
negotiates `publicTextSearch` / `public-text-token-and-v1`. It searches only the
original Server History owner's indexed, imported, current visible complete
user/assistant Items. It performs no Native search, refresh, sync, reindex or
execution. `--field name` retains NFC case-sensitive literal matching and its
metadata discover authorization.

Text queries contain 1–512 Unicode code points and at least a letter or number.
Matching is folded-token AND: NFKD, removal of combining marks, lowercase,
letter/number/underscore words plus individual Han characters and adjacent Han
pairs. Every query token must occur in the same public Item, in any order.
`cafe` matches `Café`; `beta alpha` can match `alpha beta`. This is neither phrase
nor literal/infix matching. Emoji/punctuation-only queries are rejected.

The human's current `conversation.read` and original server/resource/private/
orchestration intersection are checked before payload access and again before
publication. Discover-only grants do not grant text search. Public text is only
`agentMessage.text` (including commentary and unknown phases, as ordinary log)
and user text content joined with newlines. Tool/agentActivity/stdout/stderr/diff,
structured attachments, preview and generated-image revisedPrompt are excluded.
Snippets are reconstructed from this projection, never copied from UI FTS text.

Results are matching **Items**, with exact ref/turnId/itemId/role/snippet; one
Thread may have several hits. Scope is `authorized-imported-public-text`, source
`server-conversation-history`, coverage `indexed-recorded-only`, consistency
`revision-bound`, with read-time observedAt. Count is always unknown/null, unit
items. `traversalComplete` means this cursor's recorded index upper bound was
traversed; it does not prove complete Native history or a total count.

Each page consumes at most a 128-wide integer document-PK window and returns at
most 30 entries. Empty pages may have continuations. Cursor authentication binds
Actor/generation, server/query/semantics, archive policy, owner/source lifetime,
revision, initial upper bound and consumed position. Reopen/source or committed
history changes reject old cursors. Permission is checked live on every page.
No global BM25, full-match materialization or authorization scan is performed.

Only model2, current visible complete Items/groups without a source continuation
qualify. Missing imported source observation is `TEXT_SEARCH_UNKNOWN`; corrupt,
oversized or unavailable source and budget exhaustion are
`TEXT_SEARCH_UNAVAILABLE` (exit 7, no automatic retry or input replay). A payload
is limited to 256KiB, a page to 8MiB, coverage to 64KiB and identity fields to
4096 bytes. Old Host/Hub/non-equivalent engines are unsupported (exit 6).
Source/cursor changes are exit 5. The nine-second total deadline includes queue,
authorization, IO and parsing. Cancellation is cooperative between bounded work;
synchronous SQLite calls are not claimed to be hard-interruptible.

## 已登记 Thread 数量（F1c）

`thread count --server <id>` 使用独立 `threadCount` /
`authorized-recorded-threads-v1` 能力，统计当前本人可发现的已登记、未归档且未删除
Thread，包含没有 name 的记录。它不按 query/project/cwd 过滤，不要求正文 read，
仍沿原 human、discover、private/shared、resource 与 orchestration 权限交集。
它不计正文 Item 或字面出现次数，也不改变 name/text search 的 unknown count。

返回 unit=`threads`、scope=`authorized-recorded-threads`、
source=`host-thread-directory`、coverage=`recorded-only`、archived=false、
consistency=`authorized-stable-window` 和读时 observedAt。
只有完整登记集合和全部授权依赖在本次共同稳定窗口均得到证明，才返回
status=`exact` / value=整数；否则为 `unknown` / null，不暴露候选数、拒读数、下界
或内部版本。exact 不承诺响应后权限仍不变，不是 Native 全历史总数。
旧 Hub/Host 或非等价引擎返回 unsupported；确定准入撤权仍为 401/403，坏数据或 IO
失败为只读 unavailable。不会自动重试、重放输入或新增后台统计任务。

统计预算为认证后九秒合作预算，覆盖本次新增排队、源/SQL、绑定、provider、资源
授权与发布检查；既有 SSH 握手、transport 和外层凭据复验的成本及原审计/兼容导入
行为保持，不承诺端到端九秒或整个认证过程零 SQL 写。统计查询本身不 refresh、sync、
reindex、启动 Native 或写业务账。独立只读初始化不会预暖引擎或覆盖普通 History
初始化；冷目录尚不能证明来源时返回 unknown。

当前完整集合上限 16,384 条、ID 总计 4 MiB；原 Actor registry 读取上限 32,768 条
全局 binding、4 MiB、本人最多32个 alias，每批最多256条，批间归还事件循环。
原目录走 recency 覆盖索引，至多取16,385个有界ID；本地同步枚举采用100ms读后合作
检查，不能硬取消一次 SQLite IO。超限或授权/来源有变化就返回 unknown，不续算
独立页。上述是请求可证明的范围，不代表部署中的数据规模。

实现仅在原 owner 连接的 autocommit 状态组合 lifetime、data_version、total_changes
与 provider 内存决策证明；同连接/外部提交、ABA、事务或重开会使证明失效。私有
provider 无读取证明时不能给 exact。源端一次性临时读取票据仅在原目录 owner 内
最多保留九秒、最多32个；它不进入 CLI、不授予读取或执行权限，也不持久化。

## 已记录消息附件元数据（本机候选）

```sh
opencraft thread attachments '<ref>'
opencraft thread attachments '<ref>' --message '<clientMessageId>'
opencraft thread attachments '<ref>' --cursor='<nextCursor>'
```

默认每页25条，按原附件owner的clientMessageId/attachmentId主键顺序读取；条目明确返回
clientMessageId，可直接用于message筛选，不是Native itemId/Turn。结果仅id/name/mimeType/
declaredSize/kind、clientMessageId/source/observedAt，contentAvailable固定unknown。
不读正文或文件内容，不返回location/path、object URL、下载凭证或任意Native附件payload。
空页只说明此owner/查询下没有已记录元数据，不证明Native没有附件或字节已删除/存在。

独立协商messageAttachments；只有已挂载等价metadata owner的Codex Server声明支持，
旧服务/其它引擎/未挂owner明确unsupported。沿当前human、Actor代次、实例与原
conversation.read（含private/shared和orchestration交集）前/返回前复验，不新增grant。

游标经原owner内存key认证加密，绑定Actor代次、ref/query、page limit及消费位置；
有效期最多5分钟且不超过当前认证生命周期，owner重开/换源拒绝旧游标。逐页live观察，
没有持久revision、冻结全集、精确count或自动sync/refresh保证。继续页也必须重新授权。
CLI使用 --cursor='<value>' 传递不带来源猜测的opaque值，不改message/ref/Actor复用。

每页最多50输出/51候选，单记录JSON先在SQL裁至8193字节（超过8192拒绝），
字段字节上限为clientMessageId/id各512、name1024、mimeType256；整页32768字节，
owner读取/投影250ms，Hub总deadline1秒，客户端5秒上界。损坏、超限或超预算明确
失败，不把截断/拒读冒充成功空页。以上为本机候选合同，尚未部署。

## Command help, guide and build identity

`opencraft thread --help` lists thread commands only; a leaf such as
`opencraft thread create --help` shows its usage, options and example.
`opencraft guide` walks through connection → server/project → create → wait →
output → send without opening a connection. `opencraft --version` (or `-V`)
prints the CLI package version and the source Git revision embedded at build
time; `--json` returns `{version, source}` in the usual envelope. Dirty source
builds have a `-dirty` suffix; builds without Git report unknown source.
This is the local executable's identity, not the remote service version.

## Wait and read final output in one command

`thread wait REF --request REQUEST_ID --output --timeout 5m` first waits using
the existing exact selector, then pins the confirmed Turn ID and follows its
final output cursors within the same timeout. The returned `entries` retain
item/phase/Unicode offsets, and `complete`, `finalUnavailable`, `turnState` and
`taskOutcome` retain their original meanings. Failed/interrupted are terminal.
Default wait is unchanged. Output timeout/read failure includes the accumulated
`error.details.result` and exact Turn target; continue `thread output REF
--turn TURN_ID --cursor=CURSOR`. A changed history must restart from the first
page. No input is retried and no latest-Turn fallback is used.

## Explicit cross-Server discovery

`thread list --all-servers` and `thread search --all-servers --field name|text
QUERY` read one page from each currently visible Server in the selected
connection. The connection default is ignored only for this explicit mode.
Each `results` element includes full `serverId`, label, engine, `ok`, and either
`data` (including the original cursor and resource refs) or an error. Server
failures/unsupported capabilities set `partial=true`; authentication/access
failures fail the entire call. `complete` requires all Servers to succeed with
no continuation cursor. This is not a global ordered list, snapshot or count.
Continue each page using `--server FULL_ID --cursor=CURSOR` and the same search.
`--server`, `--cursor`, `--project`, and `--cwd` cannot combine with this mode;
project IDs and paths belong to one Server. Single-Server defaults stay unchanged.

Capabilities remain independently negotiated. Project discovery, create and
exact wait/output currently require Codex. A capability error includes the
selected Server ID/engine, missing capability and alternative visible Servers
that advertise it; an alternative is a hint, not a guarantee of availability or
access to the same resource. No automatic switch occurs.

Rename/archive/unarchive have no employee collaboration command/capability
contract yet. Native methods available to other clients do not authorize this
CLI to invoke them; write authorization, response and uncertain-write contracts
must be established before exposing these commands.


### 项目名与创建项目投影（阶段58G dogfood）

`thread create --project data` 在所选Server已授权的项目目录中精确匹配唯一名称，
跨页核对重名，ID优先；歧义或目录未完整读取时不创建。旧Server未提供projectDiscovery时
继续传原项目ID，不新增Host调用。目录枚举最多100页，触限请使用完整ID。
`thread show` 对CLI成功创建的会话从Hub持久创建账取Host项目ID，重启后保留；
Native projectId属于另一目录，thread/start原本就不接收Host项目ID。
此修复不新增项目分组写入，也不改变list的原生project过滤。

附件上传尚未开放：现有`thread attachments`仅返回已记录metadata。
Host staging返回内部路径，Hub send/create尚无附件输入、持久绑定、请求指纹或GC交接契约；
不能把`--message-file`当附件，也不能直接对外开放Host staging。

## Recorded context usage and advertised slash commands (58J)

```sh
opencraft thread context REF --json
opencraft thread commands REF --json
```

Both commands use existing `conversation.read` and current resource, private/shared,
orchestration and Actor authority before and after the observation. `contextUsage`
and `threadCommands` negotiate independently for the selected Server and Hub/Host;
old or unsupported engines use the usual Server ID/engine/alternative hints (exit 6).
There is no arbitrary Native method, path, credential or raw record in this API.

Codex context reads the existing Native source through the transcript owner. It
returns `status=observed`, `usedTokens`, `contextWindow`, available numeric
`breakdown`, Native `recordedAt`, and read-time `observedAt`. The source is
`native-rollout/token_count`, scope `latest-recorded-context-window`;
`last_token_usage.total_tokens` is the recorded window observation. Cumulative
`total_token_usage` is never substituted. This is the latest retained sample,
not a live measurement, remaining quota, billing usage or a prediction of the next step.

Unavailable data returns `status=unknown`, null usage/window/breakdown, and a
bounded `reason`: `no-recorded-usage`, `missing-window`, `invalid-record`,
`source-unavailable`, `source-changed` or `read-budget`. The owner reads at most
8 MiB of the source tail, at most 32,768 lines, and rejects individual lines over
256 KiB and incomplete/corrupt suffixes. A newer compaction prevents reuse of an
older sample. A second byte read plus source/inode/stat validation rejects drift;
concurrent appends may therefore return unknown. Queueing and source reading
share a nine-second deadline and existing cancellation ownership. No cold index,
refresh/sync, new database or Server schema version is introduced.

DSH has no equivalent recorded window observation. Pi's existing notification
projects usage and the **current** model's window; it does not establish the
window recorded at that sample. These adapters currently advertise
`contextUsage=false`; their response is unsupported rather than a synthetic value.

`commands` lists only safe command **names** supplied by an engine's actual
slash-command advertisement, using `engine-advertised-slash-commands` and
`observedAt`. Codex AppServer, DSH adapter and the Pi durable engine currently
provide no such owner/advertisement, so each advertises `threadCommands=false`.
The command currently returns unsupported on all three. It never fabricates an
empty successful list or substitutes UI actions, skills, tools, prompts or Native
method names. The typed read API and white-list projection support an equivalent
owner when one is actually connected; no command execution is exposed.
