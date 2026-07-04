# CloudAgent AgentCore Context Projection Contract

This document defines the CloudAgent-owned Hermes-rs contract for durable
AgentCore context across runtime upgrades.

The core idea is simple:

**AgentCore does not own user-visible chat history. AgentCore owns only the
minimal context projection required to continue work safely.**

Gateway, MyChat, ChannelGateway, ACP, WeCom, and future protocol adapters may
store complete conversation history in their own read models. Hermes-rs must
not depend on any one chat-store schema to resume a runtime.

## Ownership

### Gateway Owns Conversation History

Gateway-side storage owns user-visible conversation facts:

- channel messages
- user and assistant chat bubbles
- UI replay
- message search
- conversation recall such as "what did we talk about before?"
- protocol-specific metadata

AgentCore may query this history through tools, but must not treat gateway
message tables as its durable runtime state.

### AgentCore Owns Runtime Projection

Hermes-rs AgentCore owns the durable execution projection:

- active objective
- compressed reference summary
- recent turns needed for model continuity
- tool facts needed for safe continuation
- run ledger cursor
- pending run state
- workspace checkpoint pointer
- selected skills and memory references
- system prompt snapshot identity

This is not a complete transcript. It is the minimum recoverable runtime state.

### Workspace Owns Filesystem State

Workspace/Wisp/runtime-host owns filesystem durability:

- workspace identity
- checkpoint identity
- mount/runtime metadata
- lease/fence ownership
- runtime-host lifecycle markers

AgentCore projection may reference workspace state, but does not store file
content as chat history.

## Current Persistence Shape

Today Hermes-rs persists two different surfaces:

- `runtime-store/runtime_snapshot.json`
  - snapshot of transcript, run ledger, pending runs, cwd, and session id
- `runtime-runs/{run_id}/events.jsonl`
  - append-only run event stream with monotonically increasing `seq`
- `runtime-runs/{run_id}/run.json`
  - run status
- `runtime-runs/{run_id}/result.json`
  - final run result

This means run events are append-only JSONL, while runtime context is still a
JSON snapshot. The desired direction is to make context projection itself an
append-only event stream with a compact snapshot cache.

## Target Persistence Shape

The target layout is:

```text
agentcore/
  projection.json
  projection.events.jsonl
  runs/
    {run_id}/
      run.json
      result.json
      events.jsonl
```

`projection.events.jsonl` is the source of truth for projection changes.
`projection.json` is a rebuildable acceleration snapshot.

If `projection.json` is missing or unreadable, AgentCore should rebuild from
`projection.events.jsonl`. If both are missing, AgentCore may start from an
empty projection while keeping the same workspace identity when available.

## Projection Snapshot Schema

Illustrative schema:

```json
{
  "projection_version": 1,
  "session_id": "session_x",
  "agent_version": "cloudagent.v1",
  "workspace_version": "wisp.v1",
  "system_prompt": {
    "snapshot_id": "sp_1",
    "hash": "sha256:...",
    "model": "agent-sidecar-chat",
    "provider": "..."
  },
  "active_objective": {
    "text": "Continue the current user task",
    "source_turn_id": "turn_42"
  },
  "compressed_summary": {
    "summary_id": "sum_1",
    "text": "Reference summary only...",
    "reference_only": true,
    "covers": {
      "from_turn_id": "turn_1",
      "to_turn_id": "turn_40"
    },
    "created_by_agent_version": "cloudagent.v1",
    "created_at_unix_ms": 1780000000000
  },
  "recent_turns": [
    {
      "turn_id": "turn_41",
      "role": "user",
      "text": "Check whether the file is still there."
    }
  ],
  "tool_facts": [
    {
      "fact_id": "fact_1",
      "kind": "workspace_file",
      "summary": "Created /workspace/a.txt with content abc",
      "source_run_id": "job_1"
    }
  ],
  "workspace": {
    "workspace_id": "workspace_x",
    "workspace_runtime_id": "rt_x",
    "checkpoint_id": "checkpoint_x",
    "restorable": true
  },
  "run_cursor": {
    "last_completed_run_id": "job_1",
    "last_event_seq": 18
  }
}
```

The concrete Rust types may differ, but the boundaries above are mandatory.

## Projection Event Types

Recommended append-only events:

```json
{"type":"projection.created","projection_version":1,"session_id":"session_x"}
{"type":"projection.system_prompt_updated","snapshot_id":"sp_1","hash":"sha256:..."}
{"type":"projection.objective_updated","turn_id":"turn_42","text":"..."}
{"type":"projection.summary_updated","summary_id":"sum_1","covers":{"from_turn_id":"turn_1","to_turn_id":"turn_40"}}
{"type":"projection.recent_turn_appended","turn_id":"turn_41","role":"user","text":"..."}
{"type":"projection.tool_fact_recorded","fact_id":"fact_1","kind":"workspace_file","summary":"..."}
{"type":"projection.workspace_checkpoint_updated","checkpoint_id":"checkpoint_x"}
{"type":"projection.reset_marker","reason":"runtime_store_missing"}
```

Every event should carry enough data to rebuild the snapshot and enough ids to
debug version migrations.

## Compression Contract

Compression is part of AgentCore projection.

The stored artifact is the compressed semantic result, not the original chat
history. The compression result must be treated as reference-only context.

Rules:

- compressed summaries are never active instructions
- latest user input and active objective override compressed summaries
- summaries must record the turn range they cover
- summaries should record the agent version and compression policy version
- old tool output may be collapsed into tool facts
- workspace facts must remain grounded in workspace state or tool evidence
- failed or partial compression must not delete the previous valid projection

This prevents stale summaries from hijacking the next turn while still allowing
runtime upgrades to preserve useful context.

## Conversation Recall Contract

User-visible recall is not AgentCore projection.

When the user asks questions such as:

- "what did we talk about before?"
- "who said this?"
- "show the previous message"
- "when did I ask you to create the file?"

AgentCore should call gateway-provided tools:

```text
conversation_search(query, time_range?, limit?, speaker?)
conversation_recent(limit?, before?)
conversation_get(message_id | turn_id)
```

Gateway is responsible for mapping those tools to MyChat, WeCom, ACP, or any
future conversation store.

AgentCore should use projection for continuation, not for full chat recall.

## Upgrade Contract

AgentCore upgrades must migrate only projection state.

Allowed upgrade flow:

```text
old projection snapshot/events
        |
        v
ProjectionMigrator
        |
        v
current projection
        |
        v
new AgentCore runtime
```

If an old session has no projection:

1. preserve workspace identity if gateway/runtime-host can provide it
2. ask gateway for a bootstrap context projection if available
3. otherwise start with an empty projection and write a reset marker

Do not migrate UI chat schemas inside Hermes-rs.

## Non-Goals

- Do not make Hermes-rs parse every gateway conversation schema.
- Do not use gateway chat tables as runtime source of truth.
- Do not store complete chat history in AgentCore just to answer recall
  questions.
- Do not make compressed summaries active instructions.
- Do not expose workspace checkpoint internals as public protocol semantics.

## Required Tests

Minimum regression coverage:

- old projection version migrates to current projection version
- missing projection starts from empty projection while preserving workspace id
- compressed summary is marked `reference_only`
- latest user turn overrides compressed summary text
- conversation recall calls gateway search instead of reading projection only
- projection snapshot can be rebuilt from projection event JSONL
- corrupted snapshot falls back to event replay
- failed compression keeps previous valid projection
- workspace checkpoint pointer survives AgentCore version upgrade

## Implementation Notes

Prefer typed Rust models over raw strings:

- `SessionId`
- `RunId`
- `TurnId`
- `ProjectionVersion`
- `SummaryId`
- `WorkspaceId`
- `CheckpointId`
- `EventSeq`

Macros may help generate small ID newtypes and event kind strings, but the
primary contract should remain visible in ordinary Rust structs and enums.
