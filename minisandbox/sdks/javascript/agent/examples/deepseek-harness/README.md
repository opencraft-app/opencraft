# DeepSeek Harness Agent

This example bundles the official DeepSeek Harness agent loop into a workerd Durable Object and
invokes it through `@minisandbox/agent`. Harness session events are stored in Durable Object storage
after every completed turn and restored before the next turn.

Long-running Agents use the complete Harness context-management stack:

- `dsh-token-meter` measures the model-visible request surface.
- `dsh-compaction-basic` automatically summarizes history at 80% of the model context window and
  retains the newest 16% by default.
- `dsh-compaction-tool-result-pruner` replaces the middle of tool results larger than 8,192 Unicode
  code points while retaining their head and tail.
- `POST /compact` runs an explicit idle-session compaction and reports whether useful history was
  compacted.

Compaction does not delete the append-only session log. It appends a summary and replacement events
that shadow older nodes only in the surface sent to the model. Consequently, memory remains durable
and auditable, while model input stops growing without bound. The MiniMax-M2.7 adapter declares its
204,800-token context window; the deterministic Echo adapter intentionally uses a small window so the
E2E exercises automatic compaction without paid model traffic.

An automatic or explicit summary is an additional model invocation. This controls inference cost and
context overflow; it deliberately does not garbage-collect the durable audit log. A production host
should store a long-lived session as segmented events/checkpoints instead of retaining this example's
single JSON value forever.

Build and run the explicit deterministic test mode against a local three-cluster deployment:

```bash
export WORKERS_API_ENDPOINT=http://127.0.0.1:6688/v1
pnpm build
pnpm example:deepseek-harness
```

To call the CloudAgents OpenAI-compatible endpoint with `minimax-m2.7`, set a development-only
credential in the caller process:

```bash
export CLOUDAGENTS_API_KEY=...
pnpm example:deepseek-harness
```

The runner selects the deterministic echo adapter with a test-only header when the environment
variable is absent; the Agent never silently falls back when a real provider credential is invalid.
Every run also creates isolated Echo-backed Agents to prove both automatic and explicit compaction,
even when the main two-turn conversation uses CloudAgents.

The example forwards a configured credential in memory for each model request. It never includes the key in
the Worker source, Version, Harness session, or Durable Object storage. This is only a local
integration path; a production deployment must inject provider credentials through the platform
egress gateway or a Worker Secret binding.

DeepSeek Harness currently reads its own package version using
`createRequire(import.meta.url)`. Dynamic workerd modules have no filesystem URL, so
[`compat/node-module.ts`](./compat/node-module.ts) implements only that exact metadata lookup and
rejects every other CommonJS import. The remaining Node APIs used by the Harness core are provided
by workerd's default Node.js compatibility mode for the selected compatibility date.
