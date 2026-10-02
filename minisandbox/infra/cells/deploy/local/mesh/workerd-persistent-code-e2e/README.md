# Persistent Worker code E2E

This gate proves the user-facing path against the real local three-cluster mesh:

1. upload immutable JavaScript Worker Versions without deploying them;
2. create a 100% v1 Deployment and a deployment-bound Durable Object Actor
   using only the Worker name;
3. mutate actor-scoped SQLite through `env.RIVET_STORAGE.sql.exec()`;
4. explicitly sleep/unload the Actor and create a 50/50 v1/v2 gradual Deployment;
5. delete and replace the exact workerd runtime Host Pod;
6. independently calculate the Deployment hash assignment and require the
   Actor to wake on exactly that Version while reading the old SQLite value;
7. mutate the same database again;
8. create a 100% v3 Deployment while the Object remains active and require an in-place isolate
   reload to preserve the value before another mutation;
9. remove the qualification resources.

The proof does not mount or inspect Depot files. A changed Pod UID and Envoy key prove that the
original workerd process and its disposable code cache were destroyed. The v1 code acknowledges a
mutation to `1`; under the gradual Deployment, the replacement Host must report the release selected
by `hash(namespace, worker, deployment_id, actor_id)`, read `1` without mutation, and only then
advance the same database to `2`. Repeated requests under one Deployment must retain that assignment.
A final online v3 deployment must
read `2` and advance it to `3` without sleeping or replacing the Host. Retrying either read-only
probe can therefore never manufacture a false-positive result.

Run after installing the real runtime and Worker registry:

```bash
./infra/cells/deploy/local/mesh/workerd-persistent-code-e2e/run.py
```

The script is intentionally independent of the capacity and autoscaling harnesses. It only targets
the single-Host baseline installed by `install-real-runtime.sh` and fails closed if that topology is
not present.
