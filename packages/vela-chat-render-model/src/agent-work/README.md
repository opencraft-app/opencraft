# Agent Work Render Model

This folder turns UI-safe `agent_work` conversation items into render rows.

It should not inspect provider raw events or diagnostics trace payloads. Backend-specific event
vocabulary is absorbed before this layer; files here only decide how projected agent work appears
in the chat render model.

- `tools.ts` maps one normalized `agent_work` item to one render row.
- `summary.ts` describes a run of completed work in user-facing language.
- `grouping.ts` folds consecutive completed compact work rows into `agent_work_group`.

`agent_work_group` is render-model only. It must not enter OpenAPI or velad wire contracts; server
contracts stay focused on canonical conversation/activity facts, while grouping remains a client
presentation policy.
