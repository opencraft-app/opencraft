# Porcupine history gate

This gate is an independent second checker for histories produced by the real
SQLite block repository. The Rust test executes concurrent aligned range
writes, reads, discards, and flushes. It records invocation and response times
without using the Stateright history representation. This Go program then
checks the resulting register history with upstream Porcupine v1.3.0.

The gate also changes one completed read to a value that was never written and
requires Porcupine to reject that history. This negative control prevents a
broken loader or vacuous model from turning every input into a pass.

Run from the repository root:

```bash
storage/verification/porcupine/check.sh
```

The history models block zero. A range write changes that register, discard
sets it to zero, read observes it, and flush preserves its value. Repository
durability and restart checks remain in the Rust producer; Porcupine checks the
real-time ordering of the concurrent operations independently.
