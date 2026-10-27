# AppServer Lab

`appserver-lab` is a machine-first smoke and fault-injection consumer of OpenCraft's
public AppServer SDK. It is not a product TUI. Every observation is emitted as
NDJSON and every run has a meaningful exit code.

```bash
npm run lab -- scenario smoke
npm run lab -- scenario suite
npm run lab -- scenario pagination --limit 20
npm run lab -- scenario concurrency --requests 16
npm run lab -- scenario timeout --timeout-ms 500
npm run lab -- scenario abort --inbound-latency-ms 100
npm run lab -- scenario canonical-session
npm run lab -- scenario reconnect
npm run lab -- scenario reconnect-loop --cycles 10
npm run lab -- scenario resume --thread <id>
npm run lab -- scenario resume-contract --thread <id>
npm run lab -- scenario desktop-resume --thread <id>
npm run lab -- scenario replica-resume --thread <id>
npm run lab -- scenario history --thread <id>
npm run lab -- request thread/list '{"limit":2}'
npm run lab -- scenario smoke --record /tmp/appserver-smoke.json
npm run lab -- scenario smoke --replay /tmp/appserver-smoke.json
```

The reconnect scenario delays the next inbound response, disconnects while the
request is pending, verifies rejection and cleanup, reconnects, reinitializes,
and verifies a second `thread/list` under a new connection generation.

`suite` runs the safe connection scenarios in one process: smoke, cursor
pagination, resume, repeated/reconnected resume identity, history continuation,
out-of-order concurrency, timeout isolation, abort/late-response isolation, and reconnect. Use
`reconnect-loop` separately for repeated lifecycle churn.

`canonical-session` is the explicit write-capability test for a real AppServer.
On its first run it calls `thread/start`, persists the returned server-owned
`thread.id` under `.opencraft/appserver-lab/canonical-thread.json`, locates that exact
ID through paginated `thread/list`, and resumes the same ID. Later runs never
create a replacement Thread. Use `--identity-file` to put this durable identity
somewhere else, or `--thread <id>` on the first run to adopt an existing Thread.
The scenario leaves the canonical test Thread archived in a `finally` cleanup
and verifies it through the archived `thread/list`. HyperNode/9988d treats an
archived workspace view as terminal (`thread/unarchive` returns `-32071`), so a
later run verifies the same archived ID without forking or creating a
replacement. The non-creating `suite` intentionally excludes this write-capability scenario.

All production and test sources are TypeScript. The workspace type gate runs
`tsc --noEmit`, and the platform-boundary gate rejects JavaScript source added
under `apps/appserver-lab/src` or a non-`.test.ts` Lab test.

The Lab imports only public package exports. If a smoke assertion needs access
to a private pending map or renderer store, the SDK contract must be improved
instead of adding a Lab escape hatch.

The implemented and deferred scenario matrix is documented in
[`docs/appserver-lab-scenarios.md`](../../docs/appserver-lab-scenarios.md).
