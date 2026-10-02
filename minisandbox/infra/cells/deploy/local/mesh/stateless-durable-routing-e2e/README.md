# Stateless Worker and Durable Object routing E2E

This permanent local gate uses the real three-cluster stack. It proves:

- ordinary Worker fetch runs in the stateless execution plane;
- A and B executors both dispatch requests;
- one Object placed in B is invoked once from B and once from A, covering same-Cell and
  cross-Cell Object Router paths;
- rendezvous placement is immutable and one Object is created in each Cell;
- the public ObjectRef API and Worker binding converge on the same persistent state;
- explicit sleep/wake preserves SQLite state;
- replacing a stateless executor Pod does not change Worker identity or durable state.

```sh
infra/cells/deploy/local/mesh/stateless-durable-routing-e2e/run.py
```
