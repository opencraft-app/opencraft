# Reception activity, model input and failure diagnosis

## Observed failure

The reported chat showed repeated fixed acknowledgements, not model answers. Inspection of the affected runtime found six admitted user turns: four settled with model replies and two blocked. All twelve outbound records (six acknowledgements, four replies and two error notices) had transport acceptance receipts. Acceptance does not prove display or human reading.

The first planning exchange took about 51 seconds and reported 18,194 input tokens. Later turns waited behind it; the last input took about 94 seconds from intake to generated response. This is queue wait plus processing, not evidence that every individual model request timed out. The failed native turns lost their structured error details at the adapter boundary. Their historical cause cannot be recovered from `Codex turn failed` alone.

Three causes are established:

1. `acknowledgePending` wrote an ordinary assistant message for every input older than five seconds, including queued inputs. Those messages survived settlement, appeared to be the answer, and became conversation history.
2. The selected protocol sent the complete command manual during routing and then repeated it with native thread history for parameter generation, even for greetings.
3. Both structured inference and durable execution discarded `Turn.error.codexErrorInfo`, leaving a generic failure without an actionable diagnostic category.

## Owners and behavior

- ReceptionService remains the sole intake/settlement owner. The existing SQLite reception table remains authoritative; no new queue, table or migration is introduced.
- `status.reception` projects queued/running counts for user inputs in the main conversation, using a bounded aggregate. System report wakes and Work execution are separate lifecycles.
- ReceptionCoordinator still runs one reception at a time and preserves report fairness. Removing serialization would allow competing user instructions to commit out of order and is not a latency fix.
- The Host Worker samples the projection through the application status API. Its parent holds only an expiring observation (five seconds), not business state. Stopped/failed handles cannot publish a current observation.
- Personal-assistant `get` returns the owner's existing native DM identifier without creating a channel. Status uses the existing owner authentication. No caller chooses a different Human, Bot or status channel.
- The chat header renders activity only for that matching direct channel. Polling is bounded, single-flight and cancelled on unmount/channel change. Missing state means unknown, not success. Drafts, focus and timeline messages are not mutated by a status refresh.
- Only actual replies and concise failure notices enter the existing durable history/outbox. Raw diagnostics are excluded from user-facing failure text. Previously delivered acknowledgements are retained as historical records; this change does not delete or replay user history.

## Model exchange

Codex selected-v2 still uses selection, an exact selected schema, at most one shared correction, and the original deadline. The routing stage now uses a compact capability/evidence guide. Reply/clarify use compact text-only requirements; effectful commands and queries receive the original detailed manual in their parameter stage. Flat-v1 and memory/summary prompts retain their existing protocol.

No new tool authority, semantic routing regex, ID filling, retries or command validation relaxation is added. Prompt selection is presentation; application services still validate source, scope, revision, effects and atomic batches.

A real native loopback test with a greeting measured 10,860 and 11,156 request bytes. The old full instruction alone was 18,027 bytes before repetition and protocol overhead. These are request bytes, **not token counts or production speed measurements**. Native protocol tests use a synthetic model endpoint; natural-language routing quality and provider latency still require live validation.

## Diagnostics

Both native adapters now preserve only declared error categories, turn status and valid HTTP status codes. Provider messages, additionalDetails, URLs, prompts and secrets are never copied into telemetry. Local OTel records `codex.turn_failed`; queue wait is recorded separately from model-operation durations. Unknown native error variants remain `other` rather than exposing raw data or inventing a cause.

No automatic retry of failed user instructions is added: the existing application/outbox boundary must still prevent duplicate effects. A user failure notice asks for retry without claiming success or exposing technical details.

## Verification

Relevant checks include `test/responses.test.mjs`, `test/codex-selected.test.mjs`, `test/native-failure.test.mjs`, the complete personal-assistant suite, identity Host/model/runtime/authorization tests, and affected package typechecks. `scripts/smoke/execution/smoke-assistant-activity.ts` runs the real Workbench and native channel transport with synthetic identity/Host activity, verifying desktop/touch status changes and draft/composer stability. It does not use a real account or model.


## Provider constraint rejection follow-up

A synthetic request using the selected configured Anthropic route reproduced HTTP
400: the service rejected the routing schema's maxItems keyword before inference.
The same request without that wire keyword succeeded. This establishes a concrete
compatibility defect, not the exact lost error bodies of the two historical turns.

The protocol adapter now projects unsupported output-schema constraints to
annotations. The assistant retains the original schema and its local admission
limits: at most four independent user commands, exactly one targeted follow-up or
system continuation, and bounded integer query parameters. Four is a per-message
proposal/admission limit, not a global assistant capacity or model capability.
Rejected values cannot bypass application authorization or mutate state. The
adapter records only a safe unsupported-schema category/keyword alongside existing
request/status metadata. It never logs provider bodies, prompts or credentials.

## Assistant model admission and HTTP 429

Managed assistant model requests use the installation ModelSource loopback gateway
for both Responses and Anthropic routes. This is the single HTTP 429 retry owner;
native request/stream retries remain zero. Reception, necessary context summaries,
durable execution and postponable memory work carry a fixed model purpose from
their harness. The Host binds a private route/token to Bot claim epoch, model
selection revision and purpose; a token for another binding cannot use that route.
Each dispatch rechecks current authority, model policy and connection credentials.
Durable executions retain their original configured model, independently of the
assistant's current reception selection. No alternate model or account is chosen.

The gateway groups all models on a connection's credential reference and endpoint
origin; unauthenticated connections use their own connection identity. This is an
installation-local, conservative quota scope, not discovery of a provider's actual
account-wide RPM/TPM limits or a distributed limiter for unrelated clients. One
stream holds the connection's permit until completion or cancellation. Queues,
resources and route bindings are bounded. Interactive requests have priority;
waiting noninteractive requests gain an aging opportunity after three interactive
dispatches. A short idle grace lets a parameter stage follow successful routing.

Only rejected HTTP 429 requests before client-visible content may be retried,
maximum three total attempts within one 30-second admission budget. Numeric or
HTTP-date Retry-After is a lower bound and is never shortened. Missing/invalid
headers use capped exponential delay with equal jitter. A delay beyond the
remaining budget returns a typed busy outcome immediately. Cancellation removes
waiters and makes no later request. Streaming failures and business effects are
not replayed. Explicit insufficient_quota/quota_exhausted errors are not retried.

Long background cooldowns use the existing memory_learning.next_at field. Both a
queued proposal and a saved proposal awaiting review can be deferred without
consuming semantic failure attempts or losing evidence. A restarted process
recovers those existing jobs; transient HTTP leases/cooldowns are not a new durable
business queue. An abrupt process restart may lose the in-memory provider cooldown.

Native errors retain safe typed HTTP/category metadata. Optional scoped Host
failure metadata carries only rate_limit/quota_exhausted and retry time; provider
bodies and keys are not logged. Expiring Host observations feed the existing DM
header (waiting for capacity / service busy). Finished waits clear the observation;
exhausted user requests produce an explicit busy message instead of remaining
indefinitely in a replying state. Queue wait, protocol correction, model attempts
and business report retries retain distinct owners and budgets.

Validation: tests/execution/assistant-model-admission.test.ts (queue fairness,
shared cooldown, dates, cancellation, revocation, credential rotation, stream
permit, bounded retries and actual Codex two-stage recovery), identity model tests
(actual Host/Worker/native DM), memory-learning/native-failure tests, and the
Workbench assistant-activity smoke in light mouse and dark touch modes. Synthetic
provider responses prove recovery mechanics, not a provider quota/latency guarantee.

## Current work is not message history

The bounded Host `works` observation contains only queued, running, waiting-input,
review, delivery and blocked work. The shared protocol predicate is used by the
Worker projection and the UI; older Hosts may still return terminal entries, which
the UI ignores. Completed, cancelled and failed records remain in the Work ledger
and existing status/detail queries. No task record is deleted or replayed to clear
activity, and no age-based timeout hides a still-current task.

The direct-chat composer dock shows one compact current-work disclosure, with
waiting-input/blocked work taking precedence in its label. The detail dialog lists
the observed current work. If the last task ends while the dialog is open, it shows
an empty state until dismissed. Work snapshots never become timeline entries.
Real replies, reminders and results keep canonical message IDs and their original
place in the shared MessageTimeline. The grid column is constrained to available
space so long task labels cannot push touch navigation offscreen.

Chat-created arrangements default to `notify: always`; explicit `never`/`changed`
remain supported. The low-level automation API retains its silent default, and
existing stored routines/occurrences are unchanged. Updates should carry the
intended notification policy. Reminder delivery text comes from the existing
parent report decision; notification batching no longer prepends internal work
IDs. IDs remain in message metadata for traceability.

Result acceptance into the local mailbox, notification selection, canonical
message/outbox creation and external transport acceptance remain distinct facts
owned by Outcome, NotificationService, ConversationHistory and MessageService.
A `completed` Work does not prove external delivery or reading. Existing durable
identities, transactions and retry/reconciliation paths are reused; there is no
new delivery queue or schema migration. Historical completion alone never causes
a reminder to be resent.

Regression evidence: work-observation, event-notifications, user-messages,
continuation, domain and ownership tests; personal-assistant Host tests; the real
Workbench assistant-activity smoke covers terminal legacy observations, current
work details, completion while open, draft preservation and narrow touch bounds.
The smoke uses synthetic identity and runtime observations, not live model output.

## Capability-aware reading and proposal recovery

Bounded platform lookups are reception queries, not automatically background work.
The routing stage sees `platformReads` and `capabilities.delegationTools`. Long
lookups can use the shared `platform_read` Work tool only when a new delegation
captures `platform.reads` with the current Bot binding. `platform.threads` alone
never grants reading. Old accepted inputs/Work snapshots do not inherit the new
resource. Both entry points call the same authorized platform port; execution
checks Work/revision/resource before and after the await, and the platform checks
current authority before and after the actual read. No send/membership operation
or caller-selected owner is exposed.

Read responses distinguish `tool_unavailable`, typed `access_denied`,
`read_failed`, and `result_too_large`. They retain native source identities,
pagination and `externalContext`; errors never become successful empty pages.
HTTP status is preserved without copying server bodies. Each background read
stores metadata through CompletionService/CompletionLedger, not another message
archive. Report context includes the last 20 current-execution read receipts,
total/omitted flags, and explicitly page-scoped coverage. Worker prose and a
passed text completion check do not prove an exhaustive search or owner denial.
The model must report checked scope and remaining/failed pages. These receipts
support review; they do not mechanically verify the semantics of an answer.

Goal strings now have nonblank/length constraints in the shared proposal schema,
before command submission. Codex uses its existing single protocol correction
and deadline, preserving the selected operation. Pi reception allows one pure
proposal correction using the original input/observations and safe schema error;
it does not retry transport errors or command effects. Native transport is never
wrapped in another correction loop. Final application checks remain authoritative.
Repeated malformed proposals retain typed field diagnostics and a notice that no
execution started. Short confirmations are resolved from history, never filled
into a missing goal by the host. Completed actions, permissions and stale revisions
are not repaired or automatically replayed.

Tests: `platform-read-recovery`, `codex-selected`, `codex-execution`,
`reception-queries`, `bot-resource`, plus the assistant suite. Native tests use real
Codex processes against synthetic loopback model/Host endpoints; they do not prove
production model routing quality or real account visibility.
