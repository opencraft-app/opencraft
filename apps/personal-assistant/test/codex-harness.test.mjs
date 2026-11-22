import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexStructuredHarness } from "../src/adapters/codex/structured-harness.mjs";
import { resolveHarnesses } from "../src/adapters/codex/config.mjs";
import { readCodexKey, readCodexKeyAsync } from "../src/adapters/codex/credential-file.mjs";
import {
  outputSchema,
  decodeOutput,
  validateOutput,
} from "../src/adapters/models/structured-output.mjs";
import { initProfile, loadProfile } from "../src/adapters/local/profile.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { request } from "../src/adapters/local/unix-socket.mjs";
import { inspectLocalConfiguration } from "../src/runtime/local-diagnostics.mjs";
import { completed, until } from "./helpers.mjs";
import { MemoryLearningModel } from "../src/adapters/models/memory-learning-model.mjs";
import { ConversationContextModel } from "../src/adapters/models/conversation-context-model.mjs";
import { modelRequest } from "../src/adapters/models/model-request.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { selectCases } from "../evaluation/longmemeval-data.mjs";
import { runCase } from "../evaluation/longmemeval.mjs";
import { ReceptionDecision } from "../src/domain/conversation.mjs";

test(
  "isolated benchmark worker selects the real Codex harness without receiving gold labels or inherited credentials",
  {
    skip: !existsSync(
      process.env.SUPERAPP_TEST_CODEX_BINARY ??
        "/opt/opencraft/runtime/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
    ),
    timeout: 45000,
  },
  async () => {
    const root = temporary();
    const server = await endpoint(({ body, res, n }) => {
      assert.doesNotMatch(
        JSON.stringify(body),
        /EVALUATOR_ONLY_GOLD_SENTINEL|has_answer|answer_session_ids|synthetic-memory-smoke/,
      );
      sse(
        res,
        body.text.format.schema.properties.changes
          ? '{"changes":[]}'
          : wire({ kind: "reply", text: "isolated Codex answer" }),
        n,
      );
    });
    try {
      const fixtures = JSON.parse(
        readFileSync(
          new URL("../evaluation/smoke-data.json", import.meta.url),
          "utf8",
        ),
      );
      const [item] = selectCases(fixtures, 1);
      const result = await runCase(item.input, {
        directory: join(root, "case"),
        mode: "model",
        timeoutMs: 15000,
        harnesses: {
          assistant: "codex",
          execution: "pi",
          codex: server.config,
        },
      });
      assert.equal(result.hypothesis, "isolated Codex answer");
      assert.deepEqual(result.evidence.harnesses, {
        assistant: "codex",
        execution: "not-run",
      });
      assert.equal(result.evidence.accuracy, null);
      assert.ok(server.requests.length >= 3);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

const binary =
  process.env.SUPERAPP_TEST_CODEX_BINARY ??
  "/opt/opencraft/runtime/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
const native = {
  skip: existsSync(binary)
    ? false
    : "Set SUPERAPP_TEST_CODEX_BINARY to verified Codex 0.162.1",
  timeout: 45000,
};
const temporary = () => mkdtempSync(join(tmpdir(), "superapp-multi-harness-"));
const wire = (proposal) => JSON.stringify({ proposal });
// A constrained provider emits all slots in the branch-neutral wire schema.
function wireSlots(schema, value) {
  if (schema.anyOf) {
    for (const option of schema.anyOf) {
      try {
        const filled = wireSlots(option, value);
        if (validateOutput(option, filled)) return filled;
      } catch {}
    }
    throw new Error("Test value has no wire branch");
  }
  if (schema.type === "object")
    return Object.fromEntries(
      Object.entries(schema.properties).map(([key, field]) => [
        key,
        Object.hasOwn(value, key) ? wireSlots(field, value[key]) : null,
      ]),
    );
  if (schema.type === "array")
    return value.map((v) => wireSlots(schema.items, v));
  return value;
}
function sse(res, text, n, item) {
  const events = [
    { type: "response.created", response: { id: `r${n}` } },
    {
      type: "response.output_item.done",
      item: item ?? {
        type: "message",
        role: "assistant",
        id: `m${n}`,
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: `r${n}`,
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          total_tokens: 15,
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
      assert.equal(req.url, "/v1/responses");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      // This assertion sees what the real native engine sends, not just our config.
      assert.deepEqual(body.tools, []);
      assert.equal(body.text.format.type, "json_schema");
      assert.equal(body.text.format.strict, true);
      requests.push({ body, authorization: req.headers.authorization });
      await handler({ body, res, n: requests.length });
    } catch (error) {
      errors.push(error);
      res.writeHead(500).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    requests,
    errors,
    config: {
      binary,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelId: "gpt-5.4",
      structuredProtocol: "flat-v1", // Explicit compatibility coverage; selected-v2 is tested separately.
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      assert.deepEqual(errors, []);
    },
  };
}
const call = (p, op, params = {}, id = crypto.randomUUID()) =>
  request(p, { op, params, id });
const settled = (p, id) =>
  until(async () => {
    const turn = await call(p, "turn", { inputId: id });
    assert.notEqual(turn.status, "blocked", turn.reply_text);
    return turn.status === "settled" && turn;
  }, 15000);

test("role selection preserves legacy Pi and rejects unsupported checkpoint switching or embedded secrets", () => {
  assert.deepEqual(resolveHarnesses({}), { assistant: "pi", execution: "pi" });
  assert.throws(
    () => resolveHarnesses({ harnesses: { execution: "unknown" } }),
    /checkpoint/,
  );
  assert.throws(
    () => resolveHarnesses({ harnesses: { assistant: "codex" } }),
    /Explicit/,
  );
  assert.throws(
    () =>
      resolveHarnesses({
        harnesses: {
          assistant: "codex",
          codex: {
            binary,
            modelId: "test",
            baseUrl: "http://external.invalid",
          },
        },
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      resolveHarnesses({
        harnesses: {
          assistant: "codex",
          codex: {
            binary,
            modelId: "test",
            baseUrl: "https://example.invalid/v1",
            apiKey: "synthetic",
          },
        },
      }),
    /Explicit/,
  );
});

test("strict schemas are closed and decode nullable fields without silently dropping unknown authority", () => {
  assert.throws(
    () =>
      decodeOutput(
        "reception",
        wire({ kind: "continue", goal: "unauthorized background decision" }),
        {},
      ),
    /schema/,
  );
  assert.throws(
    () =>
      decodeOutput(
        "reception",
        wire({ kind: "delegate", goal: "new request", completion: null }),
        { source: { kind: "execution-report" } },
      ),
    /schema/,
  );
  const walk = (schema) => {
    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, Object.keys(schema.properties));
      Object.values(schema.properties).forEach(walk);
    }
    schema.anyOf?.forEach(walk);
    if (schema.items) walk(schema.items);
  };
  for (const kind of [
    "reception",
    "memory-propose",
    "memory-verify",
    "context-summary",
  ])
    walk(outputSchema(kind));
  assert.deepEqual(
    decodeOutput(
      "reception",
      wire({ kind: "query", name: "memory.get", params: { key: "city" } }),
    ),
    { kind: "query", name: "memory.get", params: { key: "city" } },
  );
  assert.deepEqual(
    decodeOutput(
      "reception",
      wire({ kind: "delegate", goal: "bounded", completion: null }),
    ),
    { kind: "delegate", goal: "bounded" },
  );
  assert.throws(
    () =>
      decodeOutput(
        "reception",
        wire({ kind: "reply", text: "hi", shell: "arbitrary" }),
      ),
    /schema/,
  );
  assert.throws(
    () => decodeOutput("memory-verify", '{"approved":"true"}'),
    /schema/,
  );
  const sent = decodeOutput(
    "reception",
    wire({
      kind: "send",
      message: {
        type: "attachment",
        attachmentId: "a".repeat(64),
        alt: "source image",
        replyTo: "original-message",
        channel: "local:main",
      },
    }),
  );
  assert.equal(ReceptionDecision.parse(sent).message.alt, "source image");
});

test("flat reception wire preserves tagged contracts and rejects cross-branch fields before returning a proposal", () => {
  const schema = outputSchema("reception", {});
  assert.equal(schema.properties.proposal.anyOf, undefined);
  const proposals = [
    { kind: "reply", text: "status" },
    { kind: "query", name: "work.overview", params: {} },
    {
      kind: "query",
      name: "works.list",
      params: { state: "open", query: "migration", limit: 12 },
    },
    { kind: "query", name: "questions.list", params: { workId: "work-A" } },
    {
      kind: "delegate",
      goal: "publish a note",
      completion: {
        output: "note",
        checks: [
          { kind: "note_published" },
          { kind: "note_contains", text: "literal" },
        ],
      },
    },
    {
      kind: "batch",
      commands: [
        { kind: "delegate", goal: "A" },
        { kind: "delegate", goal: "B" },
      ],
    },
    { kind: "routine.create", params: { text: "check", intervalMs: 60000 } },
    { kind: "send", message: { type: "text", content: "result" } },
  ];
  for (const proposal of proposals) {
    const raw = wireSlots(schema, { proposal });
    assert.equal(validateOutput(schema, raw), true);
    assert.deepEqual(
      decodeOutput("reception", JSON.stringify(raw), {}),
      proposal,
    );
  }
  for (const proposal of [
    { kind: "reply", text: "hello", goal: "also execute this" },
    { kind: "query", name: "work.overview", params: { workId: "work-A" } },
    { kind: "amend", goal: "missing target" },
    {
      kind: "batch",
      commands: [{ kind: "delegate", goal: "A", workId: "unrelated" }],
    },
  ]) {
    const raw = wireSlots(schema, { proposal });
    assert.equal(
      validateOutput(schema, raw),
      true,
      "wire validity must not become command authority",
    );
    assert.throws(
      () => decodeOutput("reception", JSON.stringify(raw), {}),
      /command contract/,
    );
  }
  const unknown = wireSlots(schema, {
    proposal: { kind: "reply", text: "hello" },
  });
  unknown.proposal.shell = null;
  assert.throws(
    () => decodeOutput("reception", JSON.stringify(unknown), {}),
    /schema/,
  );
  const report = { source: { kind: "execution-report" } };
  assert.throws(
    () =>
      decodeOutput(
        "reception",
        JSON.stringify(
          wireSlots(schema, {
            proposal: { kind: "delegate", goal: "new work" },
          }),
        ),
        report,
      ),
    /schema/,
  );
});

test("private credentials are explicit, owner-only, and not persisted into profiles", async () => {
  const root = temporary();
  try {
    const file = join(root, "key");
    writeFileSync(file, "synthetic-only", { mode: 0o600 });
    assert.equal(readCodexKey({ credentialFile: file }), "synthetic-only");
    assert.equal(await readCodexKeyAsync({ credentialFile: file }), "synthetic-only");
    chmodSync(file, 0o644);
    assert.throws(() => readCodexKey({ credentialFile: file }), /owner-only/);
    await assert.rejects(readCodexKeyAsync({ credentialFile: file }), /owner-only/);
    const p = initProfile(join(root, "profile"), "test");
    const before = readFileSync(join(p.path, "profile.json"), "utf8");
    loadProfile(p.path);
    assert.equal(readFileSync(join(p.path, "profile.json"), "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("actual CLI initializes selectable harnesses and offline doctor does not call the endpoint", async () => {
  const root = temporary(),
    configFile = join(root, "codex.json"),
    directory = join(root, "profile");
  writeFileSync(
    configFile,
    JSON.stringify({
      binary,
      modelId: "test",
      baseUrl: "http://127.0.0.1:1/v1",
    }),
  );
  try {
    const init = await exec(process.execPath, [
      "bin/assistant.mjs",
      "init",
      "--profile",
      directory,
      "--owner",
      "test",
      "--assistant-harness",
      "codex",
      "--codex-config",
      configFile,
    ]);
    assert.equal(JSON.parse(init.stdout).harnesses.assistant, "codex");
    const doctor = JSON.parse(
      (
        await exec(process.execPath, [
          "bin/assistant.mjs",
          "doctor",
          "--profile",
          directory,
        ])
      ).stdout,
    );
    assert.equal(
      doctor.assistantModel.protocol,
      "Responses (not Chat Completions)",
    );
    assert.equal(doctor.actualModelRequestPerformed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native subprocess environment excludes inherited credentials and preload hooks, while explicit keys stay out of config and argv", async () => {
  const root = temporary(),
    fake = join(root, "fake.mjs"),
    keyFile = join(root, "key"),
    capture = join(root, "metadata.json");
  writeFileSync(keyFile, "explicit-synthetic-key", { mode: 0o600 });
  writeFileSync(
    fake,
    `#!${process.execPath}\nimport {createInterface} from 'node:readline';\nimport {writeFileSync} from 'node:fs';\nif(process.argv.includes('--version')){console.log('codex-cli 0.162.1');process.exit(0)}\nwriteFileSync(${JSON.stringify(capture)},JSON.stringify({names:Object.keys(process.env),argv:process.argv,explicitKey:process.env.SUPERAPP_CODEX_API_KEY==='explicit-synthetic-key',home:process.env.CODEX_HOME}));\nconst send=p=>console.log(JSON.stringify(p));\ncreateInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(!p.id)return;if(p.method==='initialize')send({id:p.id,result:{}});if(p.method==='thread/start')send({id:p.id,result:{thread:{id:'one'}}});if(p.method==='turn/start'){send({id:p.id,result:{turn:{id:'t1'}}});send({method:'item/completed',params:{threadId:'one',turnId:'t1',item:{type:'agentMessage',text:'{"approved":true}'}}});send({method:'turn/completed',params:{threadId:'one',turn:{id:'t1',status:'completed'}}});}});`,
    { mode: 0o700 },
  );
  const oldKey = process.env.OPENAI_API_KEY,
    oldOptions = process.env.NODE_OPTIONS;
  process.env.OPENAI_API_KEY = "inherited-synthetic-key";
  process.env.NODE_OPTIONS = "--an-invalid-preload-option";
  const harness = new CodexStructuredHarness({
    binary: fake,
    baseUrl: "http://127.0.0.1:1/v1",
    modelId: "test",
    credentialFile: keyFile,
  });
  try {
    await harness.complete({
      kind: "memory-verify",
      instruction: "Review",
      input: {},
      signal: AbortSignal.timeout(10000),
    });
    const metadata = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(metadata.explicitKey, true);
    assert.ok(
      !metadata.names.includes("OPENAI_API_KEY") &&
        !metadata.names.includes("NODE_OPTIONS"),
    );
    assert.doesNotMatch(
      JSON.stringify(metadata.argv),
      /explicit-synthetic-key|inherited-synthetic-key/,
    );
    assert.equal(existsSync(metadata.home), false);
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    if (oldOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = oldOptions;
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "real Codex app-server forwards schemas, restricts native tools and returns usage with independent concurrent calls",
  native,
  async () => {
    const server = await endpoint(({ res, n }) =>
      sse(res, wire({ kind: "reply", text: `reply-${n}` }), n),
    );
    const harness = new CodexStructuredHarness(server.config);
    try {
      const answers = await Promise.all(
        [1, 2].map((n) =>
          harness.complete({
            kind: "reception",
            instruction: "Return a reply",
            input: { text: `hello-${n}` },
            signal: AbortSignal.timeout(15000),
          }),
        ),
      );
      assert.equal(server.requests.length, 2);
      assert.equal(
        new Set(answers.map((a) => JSON.parse(a.content[0].text).text)).size,
        2,
      );
      assert.deepEqual(answers[0].usage, {
        input: 10,
        output: 5,
        totalTokens: 15,
        cacheRead: 0,
      });
      assert.equal(server.requests[0].authorization, undefined);
    } finally {
      await harness.close();
      await server.close();
    }
  },
);

test(
  "real native planning decodes a flat batch while preserving each command and completion check",
  native,
  async () => {
    const proposal = {
      kind: "batch",
      commands: [
        {
          kind: "delegate",
          goal: "A waits for input",
          completion: { output: "note", checks: [{ kind: "note_published" }] },
        },
        {
          kind: "delegate",
          goal: "B publishes now",
          completion: {
            output: "note",
            checks: [{ kind: "note_contains", text: "B" }],
          },
        },
      ],
    };
    const server = await endpoint(({ body, res, n }) => {
      const schema = body.text.format.schema;
      assert.equal(schema.properties.proposal.anyOf, undefined);
      sse(res, JSON.stringify(wireSlots(schema, { proposal })), n);
    });
    const harness = new CodexStructuredHarness(server.config);
    try {
      const answer = await harness.complete({
        kind: "reception",
        instruction: "Propose two independent works",
        input: { text: "create A and B" },
        signal: AbortSignal.timeout(15000),
      });
      assert.deepEqual(JSON.parse(answer.content[0].text), proposal);
      assert.equal(server.requests.length, 1);
    } finally {
      await harness.close();
      await server.close();
    }
  },
);

test("turn identity rejects late events from the previous correction attempt, including events arriving before its RPC acknowledgement", async () => {
  const root = temporary(),
    fake = join(root, "events.mjs");
  writeFileSync(
    fake,
    `#!${process.execPath}\nimport {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('codex-cli 0.162.1');process.exit(0)}
const send=p=>console.log(JSON.stringify(p));let n=0;
const item=(id,text)=>send({method:'item/completed',params:{threadId:'one',turnId:id,item:{type:'agentMessage',text}}});
const done=id=>send({method:'turn/completed',params:{threadId:'one',turn:{id,status:'completed'}}});
createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(!p.id)return;
if(p.method==='initialize')send({id:p.id,result:{}});
if(p.method==='thread/start')send({id:p.id,result:{thread:{id:'one'}}});
if(p.method==='turn/start'){
n++;const id='t'+n;
if(n===1){item(id,'invalid');done(id);send({id:p.id,result:{turn:{id}}});}
else {item('t1','{"approved":false}');done('t1');send({id:p.id,result:{turn:{id}}});setTimeout(()=>{item(id,'{"approved":true}');done(id)},80);}
}});`,
    { mode: 0o700 },
  );
  const harness = new CodexStructuredHarness({
    binary: fake,
    modelId: "test",
    baseUrl: "http://127.0.0.1:1/v1",
  });
  try {
    const answer = await harness.complete({
      kind: "memory-verify",
      instruction: "Review",
      input: {},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(JSON.parse(answer.content[0].text).approved, true);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "real native context receives one bounded correction; continued invalid output fails closed",
  native,
  async () => {
    const server = await endpoint(({ res, n }) =>
      sse(
        res,
        n === 1
          ? "plain non-JSON"
          : n === 2
            ? wire({ kind: "reply", text: "corrected" })
            : "still invalid",
        n,
      ),
    );
    const harness = new CodexStructuredHarness(server.config);
    const args = {
      kind: "reception",
      instruction: "Return a reply",
      input: { text: "hi" },
      signal: AbortSignal.timeout(20000),
    };
    try {
      const answer = await harness.complete(args);
      assert.equal(JSON.parse(answer.content[0].text).text, "corrected");
      assert.match(
        JSON.stringify(server.requests[1].body.input),
        /previous response was invalid/,
      );
      assert.match(
        JSON.stringify(server.requests[1].body.input),
        /plain non-JSON/,
      );
      assert.equal(answer.usage.totalTokens, 30);
      await assert.rejects(harness.complete(args), /one protocol correction/);
      assert.equal(server.requests.length, 4);
    } finally {
      await harness.close();
      await server.close();
    }
  },
);

test(
  "real native correction receives the host field failure without relaxing the command contract",
  native,
  async () => {
    const server = await endpoint(({ body, res, n }) =>
      sse(
        res,
        JSON.stringify(
          wireSlots(body.text.format.schema, {
            proposal: {
              kind: "answer",
              interactionId: "pending-question",
              expectedRevision: n === 1 ? null : 3,
              text: "tomorrow",
            },
          }),
        ),
        n,
      ),
    );
    const events = [];
    const harness = new CodexStructuredHarness(server.config, {
      telemetry: {
        run: (_name, _attributes, generate) => generate(),
        event: (name, attributes) => events.push({ name, attributes }),
      },
    });
    try {
      const answer = await harness.complete({
        kind: "reception",
        instruction: "Answer the supplied pending question.",
        input: {
          pendingInteractions: [{ id: "pending-question", revision: 3 }],
          text: "tomorrow",
        },
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(JSON.parse(answer.content[0].text).expectedRevision, 3);
      assert.equal(server.requests.length, 2);
      const feedback = JSON.stringify(
        server.requests[1].body.input.filter((i) => i.role === "user").at(-1),
      );
      assert.match(
        feedback,
        /command_contract\/required at \$\.proposal.expectedRevision/,
      );
      assert.match(feedback, /Never guess identifiers or revisions/);
      assert.deepEqual(events[0], {
        name: "codex.schema_rejected",
        attributes: {
          "app.attempt": 0,
          "app.model_role": "reception",
          "app.phase": "proposal",
          "app.schema_stage": "command_contract",
          "app.schema_issue": "required",
          "app.schema_path": "$.proposal.expectedRevision",
        },
      });
    } finally {
      await harness.close();
      await server.close();
    }
  },
);

test(
  "real native memory proposal/review and context models reuse their original prompts and usage boundary",
  native,
  async () => {
    const server = await endpoint(({ body, res, n }) => {
      const props = body.text.format.schema.properties;
      const value = props.changes
        ? {
            changes: [
              {
                action: "create",
                content: "brief responses",
                kind: "profile",
                sourceEvidenceIds: ["e1"],
                scope: null,
                project: null,
              },
            ],
          }
        : props.approved
          ? { approved: true }
          : {
              goals: [{ text: "evaluate memory", sourceIds: ["m1"] }],
              constraints: [],
              decisions: [],
              openItems: [],
            };
      sse(res, JSON.stringify(value), n);
    });
    const harness = new CodexStructuredHarness(server.config),
      usage = [];
    const catalog = { configured: { mode: "model" } },
      options = { transport: harness, recordUsage: (v) => usage.push(v) };
    const signal = AbortSignal.timeout(15000);
    try {
      const model = new MemoryLearningModel(catalog, options);
      const proposal = await model.propose(
        {
          evidence: [
            { id: "e1", role: "user", text: "I prefer brief responses" },
          ],
          snapshot: { facts: [] },
        },
        signal,
      );
      assert.equal(proposal.changes[0].content, "brief responses");
      assert.equal(proposal.changes[0].scope, undefined);
      assert.equal((await model.verify({ proposal }, signal)).approved, true);
      const context = await new ConversationContextModel(
        catalog,
        options,
      ).summarize(
        { messages: [{ id: "m1", role: "user", text: "evaluate memory" }] },
        signal,
      );
      assert.deepEqual(context.goals[0].sourceIds, ["m1"]);
      assert.deepEqual(
        usage.map((v) => v.kind),
        ["memory-propose", "memory-verify", "context-summary"],
      );
      assert.ok(
        usage.every(
          (v) =>
            v.provider === "codex-responses" &&
            v.usage.totalTokens === 15 &&
            v.usage.cost === undefined,
        ),
      );
    } finally {
      await harness.close();
      await server.close();
    }
  },
);

test(
  "structured failures retain native usage and close aborts active requests",
  native,
  async () => {
    const server = await endpoint(({ res, n }) => {
      if (n <= 2) sse(res, "invalid", n);
    });
    const harness = new CodexStructuredHarness(server.config),
      rows = [];
    try {
      await assert.rejects(
        modelRequest(
          { configured: { mode: "model" } },
          "memory-verify",
          "Review",
          {},
          AbortSignal.timeout(15000),
          { transport: harness, recordUsage: (v) => rows.push(v) },
        ),
        /one protocol correction/,
      );
      assert.equal(rows[0].outcome, "error");
      assert.equal(rows[0].usage.totalTokens, 30);
      const active = harness.complete({
        kind: "memory-verify",
        instruction: "Review",
        input: {},
        signal: AbortSignal.timeout(15000),
      });
      const rejection = assert.rejects(active, /closing/);
      await until(() => server.requests.length === 3);
      await harness.close();
      await rejection;
      assert.equal(harness.active.size, 0);
    } finally {
      await harness.close();
      await server.close();
    }
  },
);

test(
  "real Codex rejects unregistered shell calls instead of executing them",
  native,
  async () => {
    const root = temporary(),
      marker = join(root, "must-not-exist");
    const server = await endpoint(({ res, n }) =>
      n === 1
        ? sse(res, "", n, {
            type: "function_call",
            name: "exec_command",
            call_id: "unauthorized",
            arguments: JSON.stringify({ cmd: `touch ${marker}` }),
          })
        : sse(res, wire({ kind: "reply", text: "no shell authority" }), n),
    );
    const harness = new CodexStructuredHarness(server.config);
    try {
      await harness.complete({
        kind: "reception",
        instruction: "Return a reply",
        input: {},
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(existsSync(marker), false);
      assert.equal(server.requests.length, 2);
      assert.match(
        JSON.stringify(server.requests[1].body.input),
        /unsupported|unknown|not found/i,
      );
    } finally {
      await harness.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "abort and close reap real native requests; a new call remains usable after one cancellation",
  native,
  async () => {
    const server = await endpoint(({ res, n }) => {
      if (n > 1) sse(res, '{"approved":true}', n);
    });
    const harness = new CodexStructuredHarness(server.config),
      controller = new AbortController();
    try {
      const first = harness.complete({
        kind: "memory-verify",
        instruction: "Review",
        input: {},
        signal: controller.signal,
      });
      const rejection = assert.rejects(first, /cancelled/);
      await until(() => server.requests.length === 1);
      controller.abort(new Error("cancelled"));
      await rejection;
      assert.equal(harness.active.size, 0);
      const answer = await harness.complete({
        kind: "memory-verify",
        instruction: "Review",
        input: {},
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(JSON.parse(answer.content[0].text).approved, true);
      await harness.close();
      await assert.rejects(harness.complete({}), /closed/);
    } finally {
      await harness.close();
      await server.close();
    }
  },
);

test(
  "LocalRunner selects Codex assistant, runs real host query and Pi durable delegation, and preserves state across reopen",
  native,
  async () => {
    const root = temporary();
    const server = await endpoint(({ body, res, n }) => {
      const schema = body.text.format.schema;
      if (schema.properties.changes) return sse(res, '{"changes":[]}', n);
      if (schema.properties.goals)
        return sse(
          res,
          '{"goals":[],"constraints":[],"decisions":[],"openItems":[]}',
          n,
        );
      const last = body.input.findLast((v) => v.role === "user");
      const raw = last.content.map((c) => c.text).join("");
      const input = JSON.parse(raw);
      if (input.source?.kind === "execution-report")
        return sse(
          res,
          wire({
            kind: "deliver",
            text: "Pi report received",
            message: null,
            finishRoutine: null,
          }),
          n,
        );
      if (input.text.includes("delegate"))
        return sse(
          res,
          wire({
            kind: "delegate",
            goal: "bounded text result",
            completion: { output: "text", requirements: [], checks: [] },
          }),
          n,
        );
      if (!input.observations.length)
        return sse(
          res,
          wire({ kind: "query", name: "memory.get", params: { key: "city" } }),
          n,
        );
      assert.match(JSON.stringify(input.observations), /Shanghai/);
      return sse(
        res,
        wire({ kind: "reply", text: "Shanghai from authorized query" }),
        n,
      );
    });
    const profile = initProfile(join(root, "profile"), "test", {
      memoryDefaultScope: "user",
      memoryPolicy: { enabled: false },
      harnesses: { assistant: "codex", execution: "pi", codex: server.config },
    });
    let runner;
    try {
      runner = await LocalRunner.open(profile);
      await call(
        profile,
        "memory.set",
        { key: "city", value: "Shanghai", expectedRevision: 0 },
        "city",
      );
      await call(profile, "say", { text: "where?" }, "greeting");
      assert.match((await settled(profile, "greeting")).reply_text, /Shanghai/);
      const turn = await call(profile, "turn", { inputId: "greeting" });
      assert.match(JSON.stringify(turn), /memory.get/);
      await call(
        profile,
        "say",
        { text: "delegate a bounded task" },
        "delegate",
      );
      const delegated = await settled(profile, "delegate");
      const done = await completed(profile, delegated.work_id);
      assert.equal(done.work.status, "completed");
      await until(
        async () =>
          (await call(profile, "conversation")).messages.some(
            (m) => m.text === "Pi report received",
          ),
        15000,
      );
      const usage = await call(profile, "usage", {});
      assert.match(JSON.stringify(usage), /codex-responses/);
      const doctor = await inspectLocalConfiguration(profile);
      assert.deepEqual(doctor.harnesses, {
        assistant: "codex",
        execution: "pi",
      });
      await runner.close();
      const traceText = readFileSync(
        join(profile.path, "telemetry", "traces.otlp.jsonl"),
        "utf8",
      );
      for (const name of [
        "gen_ai.operation",
        "codex.startup",
        "codex.version_check",
        "codex.rpc",
        "codex.turn",
      ])
        assert.ok(traceText.includes('"name":"' + name + '"'), name);
      assert.equal(runner.telemetry.health().exportErrors, 0);
      runner = await LocalRunner.open(loadProfile(profile.path));
      const again = await call(profile, "say", { text: "where?" }, "greeting");
      assert.equal(again.duplicate, true);
      assert.equal((await call(profile, "status")).works.length, 1);
    } finally {
      await runner?.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "native reasoningEffort=none reaches the actual Responses HTTP request",
  native,
  async () => {
    const server = await endpoint(({ body, res, n }) => {
      assert.equal(body.model, "hy4");
      assert.equal(body.reasoning?.effort, "none");
      sse(res, '{"changes":[]}', n);
    });
    const harness = new CodexStructuredHarness({
      ...server.config,
      modelId: "hy4",
      reasoningEffort: "none",
    });
    try {
      const output = await harness.complete({
        kind: "memory-propose",
        instruction: "Return empty changes.",
        input: {},
        signal: AbortSignal.timeout(15000),
      });
      assert.deepEqual(JSON.parse(output.content[0].text), { changes: [] });
      assert.equal(server.requests.length, 1);
    } finally {
      await harness.close();
      await server.close();
    }
  },
);

test("background model selection is explicit and rejects unvalidated reasoning configuration", () => {
  const codex = { binary, modelId: "main", baseUrl: "http://127.0.0.1:1/v1" };
  const backgroundCodex = { ...codex, modelId: "hy4", reasoningEffort: "none" };
  const selected = resolveHarnesses({
    harnesses: {
      assistant: "codex",
      execution: "codex",
      codex,
      backgroundCodex,
    },
  });
  assert.equal(selected.codex.modelId, "main");
  assert.equal(selected.backgroundCodex.reasoningEffort, "none");
  assert.throws(
    () =>
      resolveHarnesses({
        harnesses: {
          backgroundCodex: {
            ...backgroundCodex,
            reasoningEffort: "silently-ignore",
          },
        },
      }),
    /reasoningEffort/,
  );
  assert.throws(
    () =>
      resolveHarnesses({
        harnesses: {
          backgroundCodex: { ...backgroundCodex, apiKey: "embedded" },
        },
      }),
    /Explicit/,
  );
});

test(
  "actual runner routes memory and working summary to background Codex while main planning keeps its model",
  native,
  async () => {
    const root = temporary();
    const main = await endpoint(({ body, res, n }) => {
      assert.equal(body.model, "main-model");
      assert.equal(body.reasoning?.effort, undefined);
      assert.ok(body.text.format.schema.properties.proposal);
      sse(res, wire({ kind: "reply", text: "Okay." }), n);
    });
    const background = await endpoint(({ body, res, n }) => {
      assert.equal(body.model, "hy4");
      assert.equal(body.reasoning?.effort, "none");
      const props = body.text.format.schema.properties;
      if (props.changes) {
        const user = body.input.filter((m) => m.role === "user").at(-1);
        const input = JSON.parse(
          user.content.find((c) => c.type === "input_text").text,
        );
        sse(
          res,
          JSON.stringify({
            changes: [
              {
                action: "create",
                content: "brief responses",
                kind: "profile",
                sourceEvidenceIds: [input.newEvidence[0].id],
                scope: null,
                project: null,
              },
            ],
          }),
          n,
        );
      } else if (props.approved) sse(res, '{"approved":true}', n);
      else
        sse(
          res,
          '{"goals":[],"constraints":[],"decisions":[],"openItems":[]}',
          n,
        );
    });
    let runner;
    try {
      const profile = initProfile(join(root, "profile"), "test", {
        mode: "model",
        memoryPolicy: { debounceMs: 0 },
        harnesses: {
          assistant: "codex",
          execution: "codex",
          codex: { ...main.config, modelId: "main-model" },
          backgroundCodex: {
            ...background.config,
            modelId: "hy4",
            reasoningEffort: "none",
          },
        },
      });
      runner = await LocalRunner.open(profile);
      await call(
        profile,
        "say",
        { text: "I prefer brief responses." },
        "background-role-test",
      );
      await settled(profile, "background-role-test");
      await until(
        () =>
          runner.app.memory.list().some((m) => m.value === "brief responses"),
        15000,
      );
      await runner.reception.context.model.summarize(
        { previous: {}, messages: [] },
        AbortSignal.timeout(10000),
      );
      assert.equal(main.requests.length, 1);
      assert.equal(background.requests.length, 3);
      const status = await inspectLocalConfiguration(profile);
      assert.equal(status.assistantModel.modelId, "main-model");
      assert.equal(status.backgroundModel.modelId, "hy4");
      assert.equal(status.backgroundModel.reasoningEffort, "none");
      assert.equal(status.actualModelRequestPerformed, false);
      await runner.close();
      assert.equal(runner.assistantHarness.active.size, 0);
      assert.equal(runner.backgroundHarness.active.size, 0);
    } finally {
      await runner?.close();
      await main.close();
      await background.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "isolated memory evaluation worker keeps reader and non-thinking background models separate",
  native,
  async () => {
    const { runMemoryGroup } = await import("../evaluation/memory-system.mjs");
    const root = temporary();
    const main = await endpoint(({ body, res, n }) => {
      assert.equal(body.model, "reader-model");
      sse(res, wire({ kind: "reply", text: "(a)" }), n);
    });
    const background = await endpoint(({ body, res, n }) => {
      assert.equal(body.model, "hy4");
      assert.equal(body.reasoning?.effort, "none");
      const props = body.text.format.schema.properties;
      if (props.changes) {
        const user = body.input.filter((m) => m.role === "user").at(-1);
        const data = JSON.parse(
          user.content.find((c) => c.type === "input_text").text,
        );
        sse(
          res,
          JSON.stringify({
            changes: [
              {
                action: "create",
                content: "brief responses",
                kind: "profile",
                sourceEvidenceIds: [data.newEvidence[0].id],
                scope: null,
                project: null,
              },
            ],
          }),
          n,
        );
      } else sse(res, '{"approved":true}', n);
    });
    try {
      const result = await runMemoryGroup(
        {
          history: [
            { role: "user", content: "I prefer brief responses." },
            { role: "assistant", content: "Okay." },
          ],
          queries: [
            {
              end: 2,
              question: "What style?",
              options: "(a) brief (b) long (c) formal (d) playful",
            },
          ],
          arms: ["memory"],
        },
        {
          directory: join(root, "case"),
          codex: { ...main.config, modelId: "reader-model" },
          backgroundCodex: {
            ...background.config,
            modelId: "hy4",
            reasoningEffort: "none",
          },
          timeoutMs: 20000,
          onRecord: () => {},
        },
      );
      assert.equal(result.status, "completed");
      assert.equal(result.result.preparation.activeFacts, 1);
      assert.equal(main.requests.length, 1);
      assert.equal(background.requests.length, 2);
      assert.deepEqual(
        result.result.calls.map((c) => [c.kind, c.model]),
        [
          ["memory-propose", "hy4"],
          ["memory-verify", "hy4"],
          ["reception", "reader-model"],
        ],
      );
    } finally {
      await main.close();
      await background.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "real native planner discovers authorized memory documents and follows a file reference through the host",
  native,
  async () => {
    const root = temporary();
    let runner;
    const server = await endpoint(({ body, res, n }) => {
      const user = body.input.filter((m) => m.role === "user").at(-1);
      const input = JSON.parse(
        user.content.find((c) => c.type === "input_text").text,
      );
      assert.ok(input.queryContracts["memory.files.list"]);
      if (!input.observations.length)
        return sse(
          res,
          wire({
            kind: "query",
            name: "memory.files.list",
            params: { limit: 1, after: null },
          }),
          n,
        );
      if (input.observations.length === 1) {
        const doc = input.observations[0].response.data.items[0];
        assert.equal(doc.path, "profile.md");
        return sse(
          res,
          wire({
            kind: "query",
            name: "memory.file.read",
            params: {
              scope: doc.scope,
              project: doc.project,
              agentId: doc.agentId,
              path: doc.path,
              offset: 0,
              limit: 2000,
            },
          }),
          n,
        );
      }
      assert.match(
        input.observations[1].response.data.content,
        /Retrieval sentinel/,
      );
      return sse(
        res,
        wire({ kind: "reply", text: "Read the authorized memory document." }),
        n,
      );
    });
    try {
      const profile = initProfile(join(root, "profile"), "test", {
        memoryPolicy: { enabled: false },
        harnesses: {
          assistant: "codex",
          execution: "codex",
          codex: server.config,
        },
      });
      runner = await LocalRunner.open(profile);
      await call(
        profile,
        "memory.set",
        { key: "sentinel", value: "Retrieval sentinel", expectedRevision: 0 },
        "set",
      );
      await call(
        profile,
        "say",
        { text: "Read my stored fact via the file catalogue." },
        "read-doc",
      );
      const done = await settled(profile, "read-doc");
      assert.match(done.reply_text, /authorized/);
      assert.equal(server.requests.length, 3);
      assert.equal(runner.app.memory.list().length, 1);
    } finally {
      await runner?.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("goal wire contracts retain old deliveries and reject cross-branch authority", () => {
  const input = { source: { kind: "execution-report" } };
  assert.deepEqual(
    decodeOutput(
      "reception",
      wire({
        kind: "deliver",
        text: "legacy",
        message: null,
        finishRoutine: null,
      }),
      input,
    ),
    { kind: "deliver", text: "legacy" },
  );
  const proposal = {
    kind: "deliver",
    goalPlan: {
      goalId: "g",
      expectedRevision: 2,
      tasks: [{ key: "next", text: "next", dependsOn: ["first"] }],
    },
  };
  const raw = wireSlots(outputSchema("reception", input), { proposal });
  assert.deepEqual(
    decodeOutput("reception", JSON.stringify(raw), input),
    proposal,
  );
  assert.throws(
    () =>
      decodeOutput(
        "reception",
        wire({ ...proposal, arbitraryGrant: true }),
        input,
      ),
    /schema/,
  );
  assert.throws(
    () =>
      decodeOutput(
        "reception",
        wire({
          kind: "goal.review",
          goalId: "g",
          expectedRevision: 1,
          evidence: [],
        }),
        input,
      ),
    /schema/,
  );
  assert.throws(
    () =>
      decodeOutput(
        "reception",
        wire({
          kind: "goal.rebase",
          goalId: "g",
          expectedRevision: 1,
          dependencies: [],
        }),
        {},
      ),
    /schema/,
  );
});

test('native Codex receives verified image bytes and bounded text file content, not just attachment labels',native,async()=>{
 const server=await endpoint(({body,res,n})=>sse(res,wire({kind:'reply',text:'read attached data'}),n));
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGUlEQVR4AWP8DwQMSICJAQ0wMaABJgY0AAAGXQQEOHaWpAAAAABJRU5ErkJggg==','base64'),text=Buffer.from('file-content-sentinel');
 const harness=new CodexStructuredHarness(server.config,{readAttachment(id){return id==='picture'?{facts:{name:'picture.png',mimeType:'image/png'},bytes:image}:{facts:{name:'notes.txt',mimeType:'text/plain'},bytes:text};}});
 try{
   await harness.complete({kind:'reception',instruction:'Reply to the user',input:{text:'Read both',attachments:[{attachmentId:'picture'},{attachmentId:'notes'}]}});
   const body=JSON.stringify(server.requests[0].body);
   assert.match(body,/file-content-sentinel/);
   assert.match(body,/input_image/);
   assert.match(body,/data:image\//);
 }finally{await harness.close();await server.close();}
});

// Real native app-server echoes image URLs on userMessage item notifications.
// The old 2 MB frame ceiling rejected a perfectly valid two-picture request.
test('native image echoes reserve bounded framing space without changing text-only limits', native, async () => {
 const server=await endpoint(({body,res,n})=>sse(res,wire({kind:'reply',text:'read two pictures'}),n));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGUlEQVR4AWP8DwQMSICJAQ0wMaABJgY0AAAGXQQEOHaWpAAAAABJRU5ErkJggg==','base64');
 const bytes=Buffer.concat([png,Buffer.alloc(1500000)]);
 const harness=new CodexStructuredHarness(server.config,{readAttachment(){return{facts:{name:'large.png',mimeType:'image/png'},bytes};}});
 try{
   const answer=await harness.complete({kind:'reception',instruction:'Reply to the user',input:{text:'Read both pictures',attachments:[{attachmentId:'one'},{attachmentId:'two'}]}});
   assert.match(answer.content[0].text,/read two pictures/);
   const images=server.requests[0].body.input.flatMap(m=>m.content??[]).filter(p=>p.type==='input_image');
   assert.equal(images.length,2);
   assert.ok(JSON.stringify(images).length>2000000);
 }finally{await harness.close();await server.close();}
});

test('native framing budget counts only sent images and rejects unbounded image sessions',async()=>{
 const {NativeCodexSession}=await import('../src/adapters/codex/native-session.mjs');
 const config={binary:'/verified/codex',managed:true,providerId:'test',modelId:'test'};
 const make=imageInput=>new NativeCodexSession(config,{home:'/unused',cwd:'/unused',imageInput});
 const s=make(true);s.child={stdin:{write(){}},kill(){}};
 const sent=s.rawRpc('turn/start',{input:[{type:'image',url:'data:image/png;base64,'+'x'.repeat(3000000)}]});
 assert.ok(s.outputFrameLimit>5000000);assert.ok(s.outputStreamLimit>22000000);
 s.fail(Error('test finished'));await assert.rejects(sent,/test finished/);
 const plain=make(false);assert.equal(plain.outputFrameLimit,2000000);assert.equal(plain.outputStreamLimit,16000000);
 const many=make(true);await assert.rejects(many.rawRpc('turn/start',{input:Array.from({length:9},()=>({type:'image',url:'data:image/png;base64,x'}))}),/protocol budget/);
 assert.equal(many.pending.size,0);assert.equal(many.imageEchoBudget,0);
});
