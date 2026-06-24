# vela-store

`vela-store` owns persistence for canonical facts: SQLite migrations, session rows, monotonic `epoch + seq` event append, and idempotency key replay.

It depends on `vela-core` for event and ID types, but it must not know about HTTP routes, protocol DTOs, UI projections, or concrete backend providers.
