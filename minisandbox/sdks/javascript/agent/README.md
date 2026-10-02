# Minisandbox Agent SDK

This package is a small JavaScript/TypeScript client for persistent JS Agents running on the
Minisandbox Workers API. It is not another service and it does not define an AI framework. Agent
code is deployed separately; this package creates, invokes, restores, and permanently deletes one
remote Agent object.

```ts
import { AgentClient } from "@minisandbox/agent";

const client = new AgentClient({ endpoint: "https://workers.internal/v1" });
const agents = client.kind("assistant-worker", "Agent");

// Allocating the identity separately means a lost create response can be retried with the same ID.
const agent = agents.newAgent();
await agent.create();

const response = await agent.fetch("https://agent.local/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
  },
  body: JSON.stringify({ message: "hello" }),
});

console.log(await response.json());

// AgentRef is plain JSON. Persist it in the application database and restore it after a restart.
const saved = JSON.stringify(agent.ref);
const restored = client.get(JSON.parse(saved));
await restored.fetch("https://agent.local/messages");

// Deletion is terminal. This exact Agent ID can never be recreated.
await restored.delete();
```

For the concise path, `await agents.create()` allocates and creates an Agent in one call. Use
`newAgent()` followed by `create()` when the caller needs to retain the generated ID across a lost
network response.

The SDK uses the platform Fetch API, works in Node.js 20+ and modern browsers, preserves the
caller's original request URL, streams request and response bodies, and passes application headers
such as `Idempotency-Key` through unchanged. Browser use additionally requires the Workers API
origin to allow the caller through CORS. The SDK never automatically retries a request: callers
must decide whether an operation is safe to repeat.

The current internal Workers API is protected by the private network boundary, so this version has
no platform-authentication option. An application `Authorization` header is passed through to Agent
code unchanged. Platform authentication must eventually use a separate transport mechanism rather
than consume that application header.

[`examples/persistent-agent.mjs`](./examples/persistent-agent.mjs) is a runnable three-command
example. It emits a JSON `AgentRef` during `create`; supplying that reference to a later process
demonstrates that the client process owns no Agent state:

```bash
export WORKERS_API_ENDPOINT=http://127.0.0.1:6688/v1
export AGENT_WORKER=assistant-worker
export AGENT_CLASS=Agent

ref="$(node examples/persistent-agent.mjs create)"
AGENT_REF="$ref" node examples/persistent-agent.mjs call
AGENT_REF="$ref" node examples/persistent-agent.mjs delete
```

The stable `AgentRef` intentionally contains no endpoint, token, Actor ID, Cell, namespace, runner,
or datacenter. The same reference can be rebound to another environment explicitly by constructing
an `AgentClient` for that environment.

Code publishing, prompts, model providers, message schemas, tools, Secrets, schedules, and automatic
retry policy are deliberately outside this package.

[`examples/deepseek-harness`](./examples/deepseek-harness) demonstrates the next layer without
adding it to the SDK itself: the official DeepSeek Harness agent loop runs inside a persistent
workerd Durable Object while this package remains only its lifecycle and Fetch client.
