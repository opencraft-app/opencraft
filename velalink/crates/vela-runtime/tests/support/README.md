# vela-runtime/tests/support

Runtime harness helpers live here.

This layer may compose `SqliteEventStore`, `Runtime`, and scripted backend adapters. It must stay independent from Axum and OpenAPI response helpers.
