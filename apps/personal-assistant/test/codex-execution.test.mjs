import { provisionBotProfile } from "../src/adapters/local/bot-profile.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { initProfile, loadProfile } from "../src/adapters/local/profile.mjs";
import { request } from "../src/adapters/local/unix-socket.mjs";
import { Store } from "../src/store.mjs";
import { completed, until, childRunner, root } from "./helpers.mjs";
const binary =
  process.env.SUPERAPP_TEST_CODEX_BINARY ??
  "/opt/opencraft/runtime/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
const native = { skip: !existsSync(binary), timeout: 45000 };
const call = (p, op, params = {}, id = crypto.randomUUID()) =>
  request(p, { op, params, id });
const text = (item) =>
  (item?.content ?? [])
    .filter((c) => ["input_text", "text"].includes(c.type))
    .map((c) => c.text)
    .join("");
function envelope(body) {
  for (const item of [...body.input].reverse()) {
    if (item.role !== "user") continue;
    try {
      const p = JSON.parse(text(item));
      if (p.snapshot) return p;
    } catch {}
  }
  throw new Error("Missing execution envelope");
}
function send(res, item, n) {
  const es = [
    { type: "response.created", response: { id: "r" + n } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: "r" + n,
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
  res.end(es.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""));
}
const tool = (name, args, id) => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
  call_id: id,
});
const answer = (value, n) => ({
  type: "message",
  role: "assistant",
  id: "m" + n,
  content: [{ type: "output_text", text: value }],
});
async function fixture(handler) {
  const requests = [],
    errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/responses");
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      const names = body.tools.map((t) => t.name);
      for (const name of names)
        assert.ok(
          [
            "work_context",
            "thread_command",
            "platform_read",
            "publish_note",
            "ask_user",
            "request_intervention",
            "list_materials",
            "read_material",
            "list_skills",
            "load_skill",
            "recall_memory",
            "search_history",
            "read_memory_file",
            "list_memory_files",
          ].includes(name),
          name,
        );
      assert.ok(names.includes("publish_note"));
      await handler({
        body,
        res,
        n: requests.length,
        send: (item) => send(res, item, requests.length),
      });
    } catch (e) {
      errors.push(e);
      res.writeHead(500).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    requests,
    errors,
    config: {
      binary,
      modelId: "gpt-5.4",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      assert.deepEqual(errors, []);
    },
  };
}
function profile(config, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sa-codex-exec-"));
  return initProfile(directory, "local:test-owner", {
    memoryPolicy: { enabled: false },
    harnesses: { assistant: "pi", execution: "codex", codex: config },
    ...options,
  });
}
function outputs(body) {
  return body.input.filter((i) => i.type === "function_call_output");
}

// This runs a real Codex process, real dynamic tool RPC, actual files and the original completion pipeline.
test(
  "Codex durable executor calls the shared publication tool and completes through original delivery",
  native,
  async () => {
    const server = await fixture(({ body, n, send }) =>
      send(
        outputs(body).some((o) => o.call_id === "note-1")
          ? answer("Published a real note.", n)
          : tool(
              "publish_note",
              { body: "# Native Codex note\nverified bytes" },
              "note-1",
            ),
      ),
    );
    const p = profile(server.config);
    let runner;
    try {
      runner = await LocalRunner.open(p);
      const { workId } = await call(
        p,
        "submit",
        { text: "publish bounded note" },
        "note-work",
      );
      const done = await completed(p, workId);
      assert.equal(done.executions[0].harness, "codex");
      assert.equal(
        JSON.parse(done.executions[0].conversation_id).engine,
        "codex",
      );
      const files = readdirSync(join(p.path, "artifacts"));
      assert.equal(files.length, 1);
      assert.match(
        readFileSync(join(p.path, "artifacts", files[0]), "utf8"),
        /verified bytes/,
      );
      assert.equal(done.deliveries.length, 1);
      assert.equal(server.requests.length, 2);
      assert.match(JSON.stringify(await call(p, "usage")), /codex\.usage/);
    } finally {
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

for (const managed of [false, true])
  test(
    `waiting owner resumes original ${managed ? "managed route after model change" : "native route"} and original answer`,
    native,
    async () => {
      const server = await fixture(({ body, n, send }) => {
        const input = envelope(body),
          recovered = JSON.stringify(input.recovery ?? []);
        if (!recovered.includes("week") && !outputs(body).length)
          return send(
            tool("ask_user", { question: "Which range?" }, "question-1"),
          );
        if (outputs(body).some((o) => o.call_id === "wait-note"))
          return send(answer("Answered and published.", n));
        assert.match(recovered, /week/);
        send(tool("publish_note", { body: "# range week" }, "wait-note"));
      });
      const selected = managed
        ? {
            binary,
            managed: true,
            providerId: "original",
            modelId: server.config.modelId,
          }
        : server.config;
      const resolved = [];
      const overrides = managed
        ? {
            resolveModel: async (config) => {
              resolved.push(config.providerId);
              return { baseUrl: server.config.baseUrl };
            },
          }
        : {};
      const p = profile(selected, { concurrency: 1 });
      let runner;
      try {
        runner = await LocalRunner.open(p, overrides);
        const { workId } = await call(
          p,
          "submit",
          { text: "wait for range" },
          "wait",
        );
        const waiting = await until(async () => {
          const d = await call(p, "work", { workId });
          return d.work.status === "waiting_input" && d;
        });
        await until(async () => (await call(p, "status")).active === 0);
        const binding = waiting.executions[0].conversation_id;
        const q = waiting.interactions[0];
        assert.equal(waiting.interactions.length, 1);
        await runner.close();
        const reopened = loadProfile(p.path);
        if (managed)
          reopened.config.harnesses.codex = {
            ...selected,
            providerId: "new-provider",
            modelId: "new-model",
          };
        runner = await LocalRunner.open(reopened, overrides);
        await call(
          p,
          "interaction.answer",
          { interactionId: q.id, expectedRevision: q.revision, text: "week" },
          "answer",
        );
        const done = await completed(p, workId);
        assert.equal(done.interactions.length, 1);
        assert.equal(done.interactions[0].state, "answered");
        assert.equal(done.executions[0].conversation_id, binding);
        assert.equal(done.deliveries.length, 1);
        assert.equal(server.requests.length, 3);
        if (managed) {
          assert.ok(resolved.length >= 4);
          assert.ok(resolved.every((id) => id === "original"));
          assert.ok(server.requests.every((r) => r.model === selected.modelId));
        }
      } finally {
        await runner?.close();
        await server.close();
        await rm(p.path, { recursive: true, force: true });
      }
    },
  );

test(
  "graceful suspension resumes a native interrupted turn without changing the execution identity",
  native,
  async () => {
    let first = true;
    const server = await fixture(({ body, n, send }) => {
      if (first) {
        first = false;
        return;
      }
      send(answer("recovered textual report", n));
    });
    const p = profile(server.config);
    let runner;
    try {
      runner = await LocalRunner.open(p);
      const { workId } = await call(
        p,
        "submit",
        { text: "text result", completion: { output: "text" } },
        "suspend",
      );
      await until(() => server.requests.length === 1);
      const before = (await call(p, "work", { workId })).executions[0];
      await runner.close();
      runner = await LocalRunner.open(loadProfile(p.path));
      const done = await completed(p, workId);
      assert.equal(done.executions[0].id, before.id);
      assert.equal(done.executions[0].conversation_id, before.conversation_id);
      assert.equal(done.results.length, 1);
      assert.equal(server.requests.length, 2);
      assert.equal(envelope(server.requests[1]).hostRequestId, "turn:1");
    } finally {
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

test(
  "harness selection is persisted on creation and mixed queued Pi/Codex work stays with its original engine",
  native,
  async () => {
    const server = await fixture(({ body, n, send }) =>
      send(
        outputs(body).length
          ? answer("codex finished", n)
          : tool("publish_note", { body: "# mixed Codex" }, "mixed-note"),
      ),
    );
    let p = profile(server.config, {
        harnesses: { assistant: "pi", execution: "pi", codex: server.config },
      }),
      store = new Store(p),
      runner;
    const old = store.submit("old", { text: "old Pi note" }).workId;
    store.close();
    p.config.harnesses.execution = "codex";
    writeFileSync(join(p.path, "profile.json"), JSON.stringify(p.config));
    p = loadProfile(p.path);
    try {
      runner = await LocalRunner.open(p);
      const next = (await call(p, "submit", { text: "new Codex note" }, "new"))
        .workId;
      assert.equal((await completed(p, old)).executions[0].harness, "pi");
      assert.equal((await completed(p, next)).executions[0].harness, "codex");
      assert.equal(server.requests.length, 2);
    } finally {
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

for (const point of [
  "codex-bound-before-turn",
  "codex-tool-effect-before-receipt",
  "codex-result-before-report",
])
  test(
    `real process crash at ${point} reconciles the same execution with one immutable note/result/delivery`,
    native,
    async (t) => {
      const server = await fixture(({ body, n, send }) => {
        const e = envelope(body);
        send(
          outputs(body).length ||
            e.recovery?.some(
              (r) => r.tool === "publish_note" && r.state === "completed",
            )
            ? answer("Recovered published result.", n)
            : tool(
                "publish_note",
                { body: "# crash-safe fixed bytes" },
                "crash-note",
              ),
        );
      });
      const p = profile(server.config);
      let processHandle, runner;
      try {
        processHandle = await childRunner(t, p, { LAB_TEST_CRASH_AT: point });
        const { workId } = await call(
          p,
          "submit",
          { text: "crash-safe note" },
          "crash-work",
        );
        assert.equal((await processHandle.exited).code, 86);
        const before = new Store(loadProfile(p.path));
        const binding = before.app.detail(workId).executions[0].conversation_id;
        const saved = before.app.executions.nativeCalls(
          before.app.workRecord(workId),
        );
        assert.equal(
          before.app.detail(workId).inputs[0].delivered_at === null,
          point === "codex-bound-before-turn",
          "persisting an empty native thread is not input admission",
        );
        before.close();
        const calls = server.requests.length;
        if (point === "codex-tool-effect-before-receipt") {
          assert.equal(
            readdirSync(join(p.path, "artifacts")).filter((f) =>
              f.endsWith(".md"),
            ).length,
            1,
          );
          assert.ok(
            saved.some(
              (r) => r.tool === "publish_note" && r.state === "pending",
            ),
          );
        }
        runner = await LocalRunner.open(loadProfile(p.path));
        const done = await completed(p, workId);
        assert.equal(done.executions[0].conversation_id, binding);
        assert.equal(done.results.length, 1);
        assert.equal(done.deliveries.length, 1);
        assert.equal(
          readdirSync(join(p.path, "artifacts")).filter((f) =>
            f.endsWith(".md"),
          ).length,
          1,
        );
        if (point === "codex-result-before-report")
          assert.equal(
            server.requests.length,
            calls,
            "saved native final must not call the model again",
          );
      } finally {
        await runner?.close();
        await processHandle?.stop();
        await server.close();
        await rm(p.path, { recursive: true, force: true });
      }
    },
  );

test(
  "a process crash after the durable question resumes only after its original answer",
  native,
  async (t) => {
    const server = await fixture(({ body, n, send }) => {
      const e = envelope(body);
      if (!JSON.stringify(e.recovery ?? []).includes("range-answer"))
        return send(
          tool("ask_user", { question: "Choose range" }, "durable-question"),
        );
      send(answer("range-answer consumed", n));
    });
    const p = profile(server.config);
    let processHandle, runner;
    try {
      processHandle = await childRunner(t, p, {
        LAB_TEST_CRASH_AT: "interaction-saved-before-suspend",
      });
      const { workId } = await call(
        p,
        "submit",
        { text: "wait durably", completion: { output: "text" } },
        "question-work",
      );
      assert.equal((await processHandle.exited).code, 86);
      runner = await LocalRunner.open(loadProfile(p.path));
      const d = await call(p, "work", { workId });
      assert.equal(d.work.status, "waiting_input");
      assert.equal((await call(p, "status")).active, 0);
      assert.equal(server.requests.length, 1);
      await call(
        p,
        "interaction.answer",
        {
          interactionId: d.interactions[0].id,
          expectedRevision: 1,
          text: "range-answer",
        },
        "range",
      );
      const done = await completed(p, workId);
      assert.equal(done.interactions.length, 1);
      assert.equal(done.results.length, 1);
      assert.equal(server.requests.length, 2);
    } finally {
      await runner?.close();
      await processHandle?.stop();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

test(
  "Codex host tools reject extra authority fields, feed the error back, then accept a valid call",
  native,
  async () => {
    const server = await fixture(({ body, n, send }) => {
      if (n === 1)
        return send(
          tool("publish_note", { body: "bad", actor: "other-human" }, "bad"),
        );
      if (n === 2) {
        assert.match(JSON.stringify(outputs(body)), /invalid arguments/);
        return send(
          tool("publish_note", { body: "# valid after correction" }, "good"),
        );
      }
      send(answer("corrected", n));
    });
    const p = profile(server.config);
    let runner;
    try {
      runner = await LocalRunner.open(p);
      const { workId } = await call(
        p,
        "submit",
        { text: "correct invalid arguments" },
        "correct",
      );
      const done = await completed(p, workId);
      assert.equal(done.results.length, 1);
      const files = readdirSync(join(p.path, "artifacts"));
      assert.equal(files.length, 1);
      assert.match(
        readFileSync(join(p.path, "artifacts", files[0]), "utf8"),
        /valid after correction/,
      );
    } finally {
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

test(
  "native host-call budget also bounds invalid arguments instead of looping indefinitely",
  native,
  async () => {
    const server = await fixture(({ n, send }) =>
      send(tool("publish_note", { body: 5 }, "invalid-" + n)),
    );
    const p = profile(server.config, { runPolicy: { maxSteps: 2 } });
    let runner;
    try {
      runner = await LocalRunner.open(p);
      const { workId } = await call(
        p,
        "submit",
        { text: "invalid loop" },
        "invalid-loop",
      );
      const done = await until(async () => {
        const d = await call(p, "work", { workId });
        return d.work.status === "blocked" && d;
      });
      assert.match(done.work.error, /step limit/);
      assert.equal(readdirSync(join(p.path, "artifacts")).length, 0);
      assert.ok(server.requests.length <= 3);
    } finally {
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

test(
  "cancelling a native turn prevents a late remote tool call from publishing",
  native,
  async () => {
    let release;
    const server = await fixture(({ n, send }) => {
      release = () =>
        send(tool("publish_note", { body: "# must not publish" }, "late"));
    });
    const p = profile(server.config);
    let runner;
    try {
      runner = await LocalRunner.open(p);
      const { workId } = await call(
        p,
        "submit",
        { text: "cancel native" },
        "cancel-me",
      );
      await until(() => !!release);
      await call(p, "cancel", { workId }, "cancel");
      release();
      await until(async () => (await call(p, "status")).active === 0);
      assert.equal(
        (await call(p, "work", { workId })).work.status,
        "cancelled",
      );
      assert.equal(readdirSync(join(p.path, "artifacts")).length, 0);
    } finally {
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

test(
  "shared material tools register real source evidence while native read receipts keep only hashes",
  native,
  async () => {
    const material = mkdtempSync(join(tmpdir(), "sa-codex-source-"));
    writeFileSync(
      join(material, "project.md"),
      "SOURCE-FACT-724: native reads are bounded",
    );
    const server = await fixture(({ body, n, send }) => {
      const done = outputs(body);
      if (!done.some((o) => o.call_id === "listed"))
        return send(tool("list_materials", { directory: "" }, "listed"));
      if (!done.some((o) => o.call_id === "read"))
        return send(tool("read_material", { path: "project.md" }, "read"));
      if (!done.some((o) => o.call_id === "published")) {
        assert.match(JSON.stringify(done), /SOURCE-FACT-724/);
        return send(
          tool(
            "publish_note",
            { body: "# Sources\nproject.md: SOURCE-FACT-724" },
            "published",
          ),
        );
      }
      send(answer("source-grounded report", n));
    });
    const p = profile(server.config, { workspace: material });
    let runner;
    try {
      runner = await LocalRunner.open(p);
      const { workId } = await call(
        p,
        "submit",
        {
          text: "read and publish",
          completion: {
            checks: [{ kind: "material_read", path: "project.md" }],
          },
        },
        "source-work",
      );
      const done = await completed(p, workId);
      const receipts = runner.app.executions.nativeCalls(
        runner.app.workRecord(workId),
      );
      const read = receipts.find((r) => r.tool === "read_material");
      assert.ok(read);
      assert.equal(JSON.parse(read.output_json).read, true);
      assert.doesNotMatch(read.output_json, /SOURCE-FACT-724/);
      assert.equal(JSON.parse(read.output_json).outputHash.length, 64);
      assert.equal(done.results.length, 1);
    } finally {
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
      await rm(material, { recursive: true, force: true });
    }
  },
);

test(
  "an explicit memory change during owner wait fences a stale Codex publication",
  native,
  async () => {
    const server = await fixture(({ body, send }) => {
      if (!JSON.stringify(envelope(body).recovery ?? []).includes("week"))
        return send(
          tool("ask_user", { question: "Which range?" }, "memory-question"),
        );
      send(
        tool(
          "publish_note",
          { body: "# stale snapshot must not publish" },
          "stale-note",
        ),
      );
    });
    const p = profile(server.config);
    let runner;
    try {
      runner = await LocalRunner.open(p);
      const { workId } = await call(
        p,
        "submit",
        { text: "wait then publish" },
        "memory-fence",
      );
      const q = await until(async () => {
        const d = await call(p, "work", { workId });
        return d.interactions[0]?.state === "pending" && d.interactions[0];
      });
      await until(async () => (await call(p, "status")).active === 0);
      await call(
        p,
        "memory.set",
        { key: "city", value: "updated explicitly", expectedRevision: 0 },
        "change-memory",
      );
      await call(
        p,
        "interaction.answer",
        { interactionId: q.id, expectedRevision: q.revision, text: "week" },
        "answer-memory",
      );
      const blocked = await until(async () => {
        const d = await call(p, "work", { workId });
        return d.work.status === "blocked" && d;
      });
      assert.match(blocked.work.error, /Memory changed/);
      assert.equal(readdirSync(join(p.path, "artifacts")).length, 0);
    } finally {
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

test(
  "a revised Codex work gets a new native thread and retires the old question and snapshot",
  native,
  async () => {
    const server = await fixture(({ body, n, send }) => {
      const e = envelope(body);
      send(
        e.snapshot.revision === 1
          ? tool("ask_user", { question: "Old question" }, "old-q")
          : answer("new revision done", n),
      );
    });
    const p = profile(server.config);
    let runner;
    try {
      runner = await LocalRunner.open(p);
      const { workId } = await call(
        p,
        "submit",
        { text: "old goal" },
        "rev-one",
      );
      const old = await until(async () => {
        const d = await call(p, "work", { workId });
        return d.work.status === "waiting_input" && d;
      });
      await until(async () => (await call(p, "status")).active === 0);
      await call(
        p,
        "amend",
        {
          workId,
          expectedRevision: 1,
          text: "new goal",
          completion: { output: "text" },
        },
        "rev-two",
      );
      const done = await completed(p, workId);
      assert.equal(done.work.revision, 2);
      assert.equal(done.executions.length, 2);
      assert.notEqual(
        done.executions[0].conversation_id,
        done.executions[1].conversation_id,
      );
      assert.equal(
        done.executions[0].context_json,
        old.executions[0].context_json,
      );
      assert.equal(done.interactions[0].state, "superseded");
      await assert.rejects(
        call(
          p,
          "interaction.answer",
          {
            interactionId: old.interactions[0].id,
            expectedRevision: 1,
            text: "late",
          },
          "late-answer",
        ),
        /revision|superseded|current/i,
      );
      assert.equal(done.results.length, 1);
    } finally {
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

test(
  "a model-chosen reserved-looking call ID cannot overwrite host admission or final receipts",
  native,
  async () => {
    const server = await fixture(({ body, n, send }) =>
      send(
        outputs(body).length
          ? answer("host-owned final", n)
          : tool(
              "publish_note",
              { body: "# reserved identity safe" },
              "__final__",
            ),
      ),
    );
    const p = profile(server.config);
    let runner;
    try {
      runner = await LocalRunner.open(p);
      const { workId } = await call(
        p,
        "submit",
        { text: "reserved call id" },
        "reserved",
      );
      await completed(p, workId);
      const rows = runner.app.executions.nativeCalls(
        runner.app.workRecord(workId),
      );
      assert.equal(
        JSON.parse(rows.find((r) => r.call_id === "__final__").output_json)
          .text,
        "host-owned final",
      );
      assert.ok(
        rows.some(
          (r) =>
            r.call_id.startsWith("tool:") &&
            r.call_id.endsWith(":__final__") &&
            r.tool === "publish_note",
        ),
      );
    } finally {
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

test(
  "same-requirement continuation reuses the real Codex thread with fresh tool ownership after restart",
  native,
  async () => {
    const server = await fixture(({ body, n, send }) => {
      const e = envelope(body),
        id = `note:${e.executionId}`;
      send(
        outputs(body).some((o) => o.call_id === id)
          ? answer(`result for ${e.executionId}`, n)
          : tool(
              "publish_note",
              { body: `# ${e.executionId}\nNew execution-owned artifact` },
              id,
            ),
      );
    });
    const p = profile(server.config);
    let runner;
    try {
      runner = await LocalRunner.open(p);
      const { workId } = await call(
        p,
        "submit",
        { text: "Publish a report" },
        "first",
      );
      const first = await completed(p, workId),
        initial = first.executions[0];
      await runner.close();
      runner = null;
      runner = await LocalRunner.open(p);
      await call(
        p,
        "work.continue",
        {
          workId,
          expectedRevision: 1,
          expectedExecutionId: initial.id,
          text: "Add a second evidence report",
        },
        "followup",
      );
      const second = await completed(p, workId),
        next = second.executions[1];
      assert.equal(second.work.revision, 1);
      assert.equal(next.predecessor_id, initial.id);
      assert.equal(
        JSON.parse(next.conversation_id).threadId,
        JSON.parse(initial.conversation_id).threadId,
      );
      assert.equal(next.session_root, initial.id);
      assert.equal(second.executions[0].context_json, initial.context_json);
      assert.equal(second.results.length, 2);
      assert.notEqual(
        second.results[0].execution_id,
        second.results[1].execution_id,
      );
      assert.equal(readdirSync(join(p.path, "artifacts")).length, 2);
      assert.equal(server.requests.length, 4);
      assert.match(
        JSON.stringify(server.requests[2].input),
        /New execution-owned artifact/,
      );
    } finally {
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

test(
  "two in-flight instructions reach the next real Codex turn in order without overwriting",
  native,
  async () => {
    let release, entered;
    const held = new Promise((r) => (release = r)),
      started = new Promise((r) => (entered = r));
    const server = await fixture(async ({ body, n, send }) => {
      const e = envelope(body);
      if (n === 1) {
        entered();
        await held;
      }
      send(
        answer(
          e.snapshot.directives?.length
            ? e.snapshot.directives.map((x) => x.text).join(" | ")
            : "first boundary",
          n,
        ),
      );
    });
    const p = profile(server.config);
    let runner;
    try {
      runner = await LocalRunner.open(p);
      const { workId } = await call(
        p,
        "submit",
        { text: "Process user context", completion: { output: "text" } },
        "original",
      );
      await started;
      await call(
        p,
        "work.instruct",
        { workId, expectedRevision: 1, text: "include dates" },
        "d1",
      );
      await call(
        p,
        "work.instruct",
        { workId, expectedRevision: 1, text: "include sources" },
        "d2",
      );
      release();
      const done = await completed(p, workId);
      assert.equal(done.work.revision, 1);
      assert.equal(done.executions.length, 2);
      assert.equal(done.results.length, 1);
      assert.equal(done.results[0].text, "include dates | include sources");
      assert.ok(done.directives.every((d) => d.state === "submitted"));
      assert.deepEqual(
        done.directives.map((d) => d.text),
        ["include dates", "include sources"],
      );
      assert.equal(
        JSON.parse(done.executions[0].conversation_id).threadId,
        JSON.parse(done.executions[1].conversation_id).threadId,
      );
    } finally {
      release();
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

test(
  "goal pause stops the real native turn and resume keeps the execution and thread",
  native,
  async () => {
    let release, entered;
    const held = new Promise((r) => (release = r)),
      started = new Promise((r) => (entered = r));
    const server = await fixture(async ({ n, send }) => {
      if (n === 1) {
        entered();
        await held;
        return;
      }
      send(answer("resumed evidence", n));
    });
    const p = profile(server.config);
    let runner;
    try {
      runner = await LocalRunner.open(p);
      const g = await call(p, "goal.create", {
        definition: {
          objective: "Keep original context across pause",
          criteria: ["evidence"],
          tasks: [
            {
              key: "a",
              text: "analyze",
              dependsOn: [],
              completion: { output: "text" },
            },
          ],
        },
      });
      await started;
      const workId = g.works[0].id,
        first = await call(p, "work", { workId });
      await call(p, "goal.pause", { goalId: g.id, expectedRevision: 1 });
      await until(() => runner.work.active.size === 0, 10000);
      const paused = await call(p, "work", { workId });
      assert.equal(paused.reports.length, 0);
      assert.equal(paused.work.status, "running");
      await runner.close();
      runner = null;
      release();
      runner = await LocalRunner.open(p);
      assert.equal(runner.work.active.size, 0);
      await call(p, "goal.resume", { goalId: g.id, expectedRevision: 2 });
      const done = await completed(p, workId);
      assert.equal(done.executions.length, 1);
      assert.equal(done.results.length, 1);
      assert.equal(done.executions[0].id, first.executions[0].id);
      assert.equal(
        JSON.parse(done.executions[0].conversation_id).threadId,
        JSON.parse(first.executions[0].conversation_id).threadId,
      );
    } finally {
      release();
      await runner?.close();
      await server.close();
      await rm(p.path, { recursive: true, force: true });
    }
  },
);

test(
  "real Codex dynamic thread tool uses the managed Bot port and preserves its Work identity",
  native,
  async () => {
    const commands = [];
    const server = await fixture(({ body, n, send }) => {
      if (outputs(body).some((o) => o.call_id === "threads"))
        return send(
          answer(
            "The platform accepted the task; its outcome is not yet known.",
            n,
          ),
        );
      assert.ok(body.tools.some((t) => t.name === "thread_command"));
      send(
        tool(
          "thread_command",
          {
            argv: [
              "thread",
              "start",
              "--profile",
              "coding",
              "--prompt",
              "Implement this task",
              "--idempotency-key",
              "native-1",
            ],
          },
          "threads",
        ),
      );
    });
    const directory = mkdtempSync(join(tmpdir(), "sa-native-thread-tool-"));
    const binding = {
      serverId: "server",
      botId: "bot",
      assignmentId: "assignment",
      owner: { kind: "human", id: "owner" },
    };
    const p = provisionBotProfile(directory, binding, {
      telemetry: { enabled: false },
      memoryPolicy: { enabled: false },
      harnesses: { assistant: "pi", execution: "codex", codex: server.config },
    });
    let runner;
    try {
      runner = await LocalRunner.open(p, {
        platformChannelPort: {
          async authorize() {
            return { binding, epoch: "one", expiresAt: Date.now() + 15000 };
          },
          async request(_b, m, args) {
            assert.equal(m, "opencraft/personal-assistant/threads/command");
            commands.push(args);
            return {
              workId:args.workId,
              ...(args.argv[1]==="operation"?{input:{deliveryState:"injected",targetTurnId:"native-platform-turn",completion:{version:1,status:"completed",turnId:"native-platform-turn",text:"The native platform task really finished.",truncated:false}}}:{}),
              operationId: "op",
              state: "submitted",
              reference: "opencraft://conversation/v1/server/platform-task",
              taskOutcome: "unknown",
            };
          },
        },
      });
      const { workId } = await call(
        p,
        "submit",
        {
          text: "Create a platform task",
          completion: { requirements: ["Explain task acceptance"], checks: [] },
        },
        "thread-task",
      );
      await until(async () => {
        const d = await call(p, "work", { workId });
        return ["completed", "blocked"].includes(d.work.status) && d;
      }, 15000);
      assert.equal(commands.filter(c=>c.argv[1]==="start").length, 1);
      assert.ok(commands.some(c=>c.argv[1]==="operation"));
      assert.equal(commands[0].workId, workId);
      assert.match(commands[0].argv.at(-1), /^execution:/);
      assert.equal(server.requests.length, 2);
      assert.ok(
        outputs(server.requests[1]).some((o) =>
          JSON.stringify(o).includes("platform-task"),
        ),
      );
    } finally {
      await runner?.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "real Codex worker reads groups through the captured Bot capability and retains host evidence",
  native,
  async () => {
    const reads = [];
    const server = await fixture(({ body, n, send }) => {
      if (outputs(body).some((o) => o.call_id === "groups"))
        return send(
          answer(
            "One visible group was checked. This is not an exhaustive search of all history.",
            n,
          ),
        );
      assert.ok(body.tools.some((t) => t.name === "platform_read"));
      send(
        tool(
          "platform_read",
          { name: "platform.groups.list", params: {} },
          "groups",
        ),
      );
    });
    const directory = mkdtempSync(join(tmpdir(), "sa-native-platform-read-"));
    const binding = {
      serverId: "server",
      botId: "bot",
      assignmentId: "assignment",
      owner: { kind: "human", id: "owner" },
    };
    const p = provisionBotProfile(directory, binding, {
      telemetry: { enabled: false },
      memoryPolicy: { enabled: false },
      harnesses: { assistant: "pi", execution: "codex", codex: server.config },
    });
    let runner;
    try {
      runner = await LocalRunner.open(p, {
        platformChannelPort: {
          async authorize() {
            return { binding, epoch: "one", expiresAt: Date.now() + 15000 };
          },
          async request(_b, m, args) {
            assert.equal(m, "opencraft/personal-assistant/groups/list");
            reads.push(args);
            return { groups: [{ id: "visible-group", title: "Example" }] };
          },
        },
      });
      const { workId } = await call(
        p,
        "submit",
        { text: "List visible groups", completion: { output: "text" } },
        "read-groups",
      );
      const detail = await until(async () => {
        const d = await call(p, "work", { workId });
        return ["completed", "blocked"].includes(d.work.status) && d;
      }, 15000);
      assert.equal(detail.work.status, "completed");
      assert.equal(reads.length, 1);
      assert.ok(
        outputs(server.requests[1]).some((o) =>
          JSON.stringify(o).includes("visible-group"),
        ),
      );
      const evidence = runner.uow.db
        .prepare(
          "SELECT data_json FROM completion_evidence WHERE kind='platform.read'",
        )
        .all();
      assert.equal(evidence.length, 1);
      assert.equal(JSON.parse(evidence[0].data_json).ok, true);
    } finally {
      await runner?.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
