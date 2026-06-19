# vela-core/tests/support

Shared helpers for core contract tests live here.

Keep helpers pure and serde-focused. They may load fixture JSON, but they must not start SQLite, HTTP servers, or backend adapters.
