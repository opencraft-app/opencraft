# vela-runtime

`vela-runtime` is the command authority. It validates command preconditions, enforces idempotency, appends command facts, invokes backend side effects, and appends normalized runtime facts.

It is intentionally testable without an API server.
