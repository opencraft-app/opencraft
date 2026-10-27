# Findings

Browser capability acceptance requires both tool RPC and page transport. A real
open succeeded, but the resulting iframe reported "Host ... does not provide
loopback HTTP". Fix the transport seam rather than substituting a URL that
bypasses the actual environment path.

Browser specs include anyOf and numeric ranges unsupported by DSH's schema
subset. Model-facing projection and full execution validation must remain
separate; never silently drop authorization/argument constraints.

OpenCraft browser handler already serves item/tool/call; dynamic tool specs
are supplied on thread start/resume. HyperNode capabilityCall carries
request/result/cancel with a 10-second timeout. Local broker uses these semantics
and rejects cross-thread/connection use. Bundled ToolRuntime exposes register()
and execution.agent.sessionId, but the HTTP RPC map has no registration route.
Do not fabricate one; the engine plugin/worker layer must register real tools.

Bundled DSH skill.list requires sessionId and returns name/description/
whenToUse/modelInvocable, not AppServer-required path/scope. Complete it with
the capability Skill manifest, without invented filesystem metadata.
Native pages must be assembled before Turn projection. Current read-through
does so for correctness; checkpoint/index work remains needed to bound cost.

Current local adapter loses caller identity at dispatch. HyperNode ThreadExecutionTable already implements claim/bindTurn/bindRuntime/markNativeStarted/finish with epoch checks. ThreadExecutionJournal persists fencing facts separately from message history. ThreadWriteLeaseTable tracks exact connection identity and bounded disconnected leases. Import these unchanged before wiring transport ownership.
