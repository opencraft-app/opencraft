# Agent Work Render Model

This folder turns UI-safe `agent_work` conversation items into render rows.

It should not inspect provider raw events or diagnostics trace payloads. Backend-specific event
vocabulary is absorbed before this layer; files here only decide how projected agent work appears
in the chat render model.
