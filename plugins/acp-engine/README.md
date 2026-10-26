# ACP execution owner

`AcpEngine` adapts an explicitly installed ACP v1 agent to the common execution
provider and orchestration contracts. `AcpGenerationHost` pins each native thread
to the process generation that created it. The independent `acp-host.mjs` entry
owns the native pipes and its dynamic, authenticated MCP tool endpoint; gateway
attachments only own transport leases.

Supported ACP operations are initialization, new/resumed sessions, text prompts,
cancellation, model configuration, semantic assistant updates and HTTP MCP tools.
The driver advertises no fork, deletion, images or reasoning selection. Native
history replay requires a corresponding engine-native reader. Claude Code may
use an explicitly configured ACP bridge; configuring a plain Claude CLI does
not manufacture ACP support.

The packaged DSH web runtime and the ACP runtime are independent choices. A DSH
ACP generation requires a runtime that actually supplies `--profile acp`. Its
private generation config names `dshEntry` and optional patch paths. No package
installation or runtime replacement occurs at gateway startup. Existing DSH web
threads stay with their existing owner; new `dsh_acp_` threads use the ACP owner.

The generation control endpoint serializes add/activate/suspend/retire with an
optional `expectedCurrent` comparison. Activating a generation marks the old
current as draining; existing threads and durable preparation tickets retain
their original generation. A draining generation can explicitly suspend after
active turns, admissions, callbacks, unacknowledged creations, preparation tickets
and uncertain inputs reach zero. Its native process exits, while its historical
bindings, fixed command/options and native session ids remain. Reading its
catalog or history keeps it dormant, including after a Host restart. An explicit
Resume or new input restarts that same generation and native session without
changing current. A peer without native Resume support cannot suspend.

Retirement additionally requires no historical bindings. A persisted digest
refuses changed command/options when reopening a pinned generation. The Host
does not migrate native sessions, start a reclamation timer or kill active work.

History is read only through an engine-native reader. ACP itself does not
promise transcript replay. Opening metadata or supplied native history does not
start or resume an engine. Durable routing metadata and creation/input receipts
contain control state, not a second transcript authority.
