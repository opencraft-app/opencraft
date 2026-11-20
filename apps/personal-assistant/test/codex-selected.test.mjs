import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { CodexStructuredHarness } from "../src/adapters/codex/structured-harness.mjs";
import {
  routingSchema,
  decodeRoutes,
  selectedSchema,
  decodeSelected,
  validateOutput,
} from "../src/adapters/models/structured-output.mjs";
import { running, until } from "./helpers.mjs";
const binary =
  "/opt/opencraft/runtime/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
const native = { skip: !existsSync(binary), timeout: 45000 };
const wire = (proposal) => JSON.stringify({ proposal });
const selection = (...operations) => JSON.stringify({ operations });
function send(res, text, n) {
  const events = [
    { type: "response.created", response: { id: `r${n}` } },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: `m${n}`,
        phase: "final_answer",
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: `r${n}`,
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 10,
          total_tokens: 30,
        },
      },
    },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
}
async function endpoint(handler) {
  const requests = [],
    errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const b of req) chunks.push(b);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      assert.deepEqual(body.tools, []);
      assert.equal(body.text.format.strict, true);
      const text = await handler(body, requests.length);
      if (text !== undefined) send(res, text, requests.length);
    } catch (error) {
      errors.push(error);
      res.writeHead(500).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    requests,
    config: {
      binary,
      modelId: "synthetic",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      assert.deepEqual(errors, []);
    },
  };
}
const args = () => ({
  kind: "reception",
  instruction: "Choose and supply the requested proposal.",
  input: { text: "hello" },
  signal: AbortSignal.timeout(15000),
});

test("selected schemas enforce branch requirements before generation and preserve atomic ordered batches", () => {
  const schema = selectedSchema(["answer"], {});
  assert.equal(
    validateOutput(schema, {
      proposal: {
        kind: "answer",
        interactionId: "q",
        expectedRevision: null,
        text: "yes",
      },
    }),
    false,
  );
  assert.deepEqual(
    decodeSelected(
      wire({
        kind: "answer",
        interactionId: "q",
        expectedRevision: 3,
        text: "yes",
      }),
      ["answer"],
      {},
    ),
    { kind: "answer", interactionId: "q", expectedRevision: 3, text: "yes" },
  );
  assert.throws(
    () =>
      decodeSelected(
        wire({ kind: "cancel", workId: "w", expectedRevision: 1 }),
        ["reply"],
        {},
      ),
    /contract/,
  );
  assert.throws(
    () =>
      decodeSelected(
        wire({
          kind: "query",
          name: "goal.get",
          params: { goalId: "g", match: "literal" },
        }),
        ["query:goal.get"],
        {},
      ),
    /unexpected/,
  );
  const routes = decodeRoutes(selection("delegate", "remember"), {});
  assert.deepEqual(
    decodeSelected(
      JSON.stringify({
        command1: { kind: "delegate", goal: "A" },
        command2: {
          kind: "remember",
          key: "city",
          value: "B",
          expectedRevision: 0,
        },
      }),
      routes,
      {},
    ),
    {
      kind: "batch",
      commands: [
        { kind: "delegate", goal: "A" },
        { kind: "remember", key: "city", value: "B", expectedRevision: 0 },
      ],
    },
  );
  for (const names of [
    [],
    Array(5).fill("reply"),
    ["query:memory.get", "reply"],
    ["send", "reply"],
  ])
    assert.throws(() => decodeRoutes(selection(...names), {}), /invalid_batch/);
  const report = { source: { kind: "execution-report" } };
  assert.throws(() => selectedSchema(["delegate"], report), /schema|contract/);
  assert.ok(
    !routingSchema(report).properties.operations.items.enum.includes(
      "goal.create",
    ),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(selectedSchema(["answer"], {}))) < 600,
  );
});

test(
  "real native default selects then fills one exact schema, without native tools or extra generation",
  native,
  async () => {
    const server = await endpoint((body, n) => {
      if (n === 1) {
        assert.ok(body.text.format.schema.properties.operations);
        return selection("answer");
      }
      assert.equal(n, 2);
      const s = body.text.format.schema.properties.proposal;
      assert.deepEqual(s.properties.kind.enum, ["answer"]);
      assert.deepEqual(s.properties.expectedRevision, { type: "integer" });
      assert.equal(s.properties.goal, undefined);
      return wire({
        kind: "answer",
        interactionId: "q",
        expectedRevision: 7,
        text: "tomorrow",
      });
    });
    const harness = new CodexStructuredHarness(server.config);
    try {
      const result = await harness.complete(args());
      assert.equal(JSON.parse(result.content[0].text).expectedRevision, 7);
      assert.equal(result.usage.totalTokens, 60);
      assert.equal(server.requests.length, 2);
    } finally {
      await harness.close();
      await server.close();
    }
  },
);

test(
  "routing and parameter stages share one correction allowance; no fallback to a wider command",
  native,
  async () => {
    const server = await endpoint((_b, n) =>
      n === 1
        ? "invalid"
        : n === 2
          ? selection("reply")
          : wire({ kind: "reply" }),
    );
    const harness = new CodexStructuredHarness(server.config);
    try {
      await assert.rejects(harness.complete(args()), /one protocol correction/);
      assert.equal(server.requests.length, 3);
    } finally {
      await harness.close();
      await server.close();
    }
  },
);

test(
  "selected parameter correction retains the chosen branch and rejects cross-branch writes",
  native,
  async () => {
    const server = await endpoint((body, n) => {
      if (n === 1) return selection("reply");
      assert.deepEqual(
        body.text.format.schema.properties.proposal.properties.kind.enum,
        ["reply"],
      );
      return n === 2
        ? wire({ kind: "delegate", goal: "unrequested" })
        : wire({ kind: "reply", text: "safe" });
    });
    const harness = new CodexStructuredHarness(server.config);
    try {
      const result = await harness.complete(args());
      assert.deepEqual(JSON.parse(result.content[0].text), {
        kind: "reply",
        text: "safe",
      });
      assert.equal(server.requests.length, 3);
    } finally {
      await harness.close();
      await server.close();
    }
  },
);

test(
  "selected cancellation stops the native parameter request and close is reusable/idempotent",
  native,
  async () => {
    let entered;
    const pending = new Promise((r) => {
      entered = r;
    });
    const server = await endpoint((body) => {
      if (body.text.format.schema.properties.operations)
        return selection("reply");
      entered();
      return undefined;
    });
    const harness = new CodexStructuredHarness(server.config);
    const controller = new AbortController();
    const job = harness.complete({ ...args(), signal: controller.signal });
    const rejected = assert.rejects(job, /stop-selected/);
    try {
      await pending;
      controller.abort(new Error("stop-selected"));
      await rejected;
    } finally {
      await harness.close();
      await harness.close();
      await server.close();
    }
  },
);

test(
  "LocalRunner socket uses the default selected protocol and settles ordinary chat without creating work",
  native,
  async (t) => {
    const server = await endpoint((body) =>
      body.text.format.schema.properties.operations
        ? selection("reply")
        : wire({ kind: "reply", text: "hello from selected protocol" }),
    );
    // Runner must close before the provider; cleanup ordering is explicit here.
    let runner;
    try {
      const env = await running(t, {
        mode: "model",
        harnesses: {
          assistant: "codex",
          execution: "pi",
          codex: server.config,
        },
        memoryPolicy: { enabled: false },
      });
      runner = env.runner;
      await env.call("say", { text: "hello" }, "selected-chat");
      // Public socket is the observable receipt; no direct business writes in the test.
      const settled = await until(async () => {
        const r = await env.call("turn", { inputId: "selected-chat" });
        return r.status === "settled" && r;
      });
      assert.match(settled.reply_text, /selected protocol/);
      assert.equal((await env.call("status")).works.length, 0);
    } finally {
      await runner?.close();
      await server.close();
    }
  },
);

test("delivery selection encodes exclusive message/text and plan/review before business submission", () => {
  const input = { source: { kind: "execution-report" } };
  const routes = routingSchema(input).properties.operations.items.enum.filter(
    (s) => s.startsWith("deliver"),
  );
  assert.equal(routes.length, 6);
  for (const route of routes) {
    const fields = selectedSchema([route], input).properties.proposal
      .properties;
    assert.equal(!!fields.text, !route.includes(":message"));
    assert.equal(!!fields.message, route.includes(":message"));
    assert.equal(!!fields.goalPlan, route.includes(":goalPlan"));
    assert.equal(!!fields.goalReview, route.includes(":goalReview"));
    assert.throws(() => selectedSchema([route], {}), /enum/);
    assert.throws(
      () => decodeRoutes(selection(route, route), input),
      /invalid_batch/,
    );
  }
  assert.deepEqual(
    decodeSelected(wire({ kind: "deliver", text: "done" }), ["deliver"], input),
    { kind: "deliver", text: "done" },
  );
  assert.throws(
    () =>
      decodeSelected(
        wire({
          kind: "deliver",
          text: "done",
          message: { type: "text", content: "also done" },
        }),
        ["deliver"],
        input,
      ),
    /unexpected/,
  );
  assert.throws(
    () =>
      decodeSelected(
        wire({ kind: "deliver", message: null }),
        ["deliver:message"],
        input,
      ),
    /contract/,
  );
  assert.throws(
    () =>
      decodeSelected(
        wire({ kind: "deliver", goalReview: null }),
        ["deliver:goalReview"],
        input,
      ),
    /contract/,
  );
  const value = {
    kind: "deliver",
    message: { type: "text", content: "done" },
    goalReview: {
      goalId: "g",
      expectedRevision: 2,
      evidence: [
        { criterionId: "c", statement: "verified", resultIds: ["result:r"] },
      ],
    },
  };
  assert.deepEqual(
    decodeSelected(wire(value), ["deliver:message:goalReview"], input),
    value,
  );
  assert.throws(
    () =>
      decodeSelected(
        wire({
          ...value,
          goalPlan: { goalId: "g", expectedRevision: 2, tasks: [] },
        }),
        ["deliver:message:goalReview"],
        input,
      ),
    /unexpected/,
  );
});

test(
  "real native ordinary replies keep the full command manual out of both model requests",
  native,
  async () => {
    const { ReceptionModel } = await import(
      "../src/adapters/models/reception-model.mjs"
    );
    let original;
    const capture = {
      provider: "test",
      modelId: "synthetic",
      async complete(args) {
        original = args;
        return {
          content: [{ type: "text", text: '{"kind":"reply","text":"hello"}' }],
          stopReason: "stop",
        };
      },
    };
    await new ReceptionModel(
      { configured: { mode: "model" } },
      { transport: capture },
    ).decide({ text: "hello" }, AbortSignal.timeout(10000));
    const server = await endpoint((_body, n) =>
      n === 1 ? selection("reply") : wire({ kind: "reply", text: "hello" }),
    );
    const harness = new CodexStructuredHarness(server.config);
    try {
      await harness.complete({
        ...original,
        signal: AbortSignal.timeout(15000),
      });
      for (const body of server.requests) {
        const bytes = Buffer.byteLength(JSON.stringify(body));
        assert.ok(
          bytes < Buffer.byteLength(original.instruction),
          "ordinary chat request should be smaller than the old manual alone",
        );
        assert.doesNotMatch(
          JSON.stringify(body),
          /Calendar schedules need no startAt/,
        );
      }
      console.log(
        "ordinary chat request bytes:",
        server.requests.map((b) => Buffer.byteLength(JSON.stringify(b))),
        "previous instruction bytes:",
        Buffer.byteLength(original.instruction),
      );
    } finally {
      await harness.close();
      await server.close();
    }
  },
);

test(
  "goal text is checked before submission and one native parameter correction repairs a short confirmation",
  native,
  async () => {
    for (const goal of ["", " \n\t", "x".repeat(20001)])
      assert.throws(
        () =>
          decodeSelected(
            wire({ kind: "delegate", goal, completion: null }),
            ["delegate"],
            {},
          ),
        /text_constraint/,
      );
    const server = await endpoint((_body, n) =>
      n === 1
        ? selection("delegate")
        : wire({
            kind: "delegate",
            goal:
              n === 2
                ? " "
                : "Search currently visible groups for our prior conversations and report coverage",
            completion: null,
          }),
    );
    const harness = new CodexStructuredHarness(server.config);
    try {
      const result = await harness.complete({
        ...args(),
        input: {
          text: "查",
          history: [{ role: "user", text: "我和你在其他群聊过吗" }],
        },
      });
      assert.match(result.content[0].text, /Search currently visible/);
      assert.equal(server.requests.length, 3);
      assert.match(JSON.stringify(server.requests[2]), /text_constraint/);
    } finally {
      await harness.close();
      await server.close();
    }
  },
);
