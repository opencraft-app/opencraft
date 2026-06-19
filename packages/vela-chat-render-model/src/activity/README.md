# Activity Render Model

This folder turns UI-safe activity read models into render rows.

It should not inspect provider raw events or diagnostics trace payloads. Backend-specific event
vocabulary is absorbed before this layer; files here only decide how projected activity appears in
the chat render model.
