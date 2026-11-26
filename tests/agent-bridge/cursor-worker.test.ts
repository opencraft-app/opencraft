import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { CursorBridge, CursorError } from "../../apps/cursor-bridge/src/cursor.js";
import type { CursorFactory } from "../../apps/cursor-bridge/src/types.js";

const sdk = String.raw`
  import { access, appendFile, writeFile } from "node:fs/promises";
  import { join } from "node:path";
  import { setTimeout } from "node:timers/promises";
  export class AuthenticationError extends Error {}
  export class ConfigurationError extends Error {}
  export class RateLimitError extends Error {}
  export class AgentBusyError extends Error {}
  export class JsonlLocalAgentStore {}
  delete process.env.CURSOR_API_KEY;
  async function probe(stage) {
    if (stage !== HELD_MODEL_PROBE) return;
    await appendFile(join(MODEL_PROBE_ROOT, "probe.entries"), stage + "\n");
    await writeFile(join(MODEL_PROBE_ROOT, "probe.started"), stage);
    while (!await access(join(MODEL_PROBE_ROOT, "probe.release")).then(() => true, () => false))
      await setTimeout(5);
  }
  export const Cursor = {
    auth: { status: async () => { await probe("auth"); return { status: "logged-in" }; } },
    models: { list: async () => { await probe("models"); return [{ id: "fixture", displayName: "Fixture" }]; } },
  };
  export const Agent = {
    async create({ local, model }) {
      return {
        agentId: "agent",
        async send(id) {
          const message = text => ({ type: "assistant", agent_id: "agent", run_id: id,
            message: { role: "assistant", content: [{ type: "text", text }] } });
          let finish;
          const result = id === "stop-drain"
            ? new Promise(resolve => { finish = resolve; })
            : Promise.resolve({ id, status: "finished" });
          return {
            id,
            async *stream() {
              yield message("first");
              if (id === "drain" || id === "stop-drain") {
                while (!await access(join(local.cwd, "stream.release")).then(() => true, () => false))
                  await setTimeout(5);
                yield message("last");
              }
            },
            wait: () => result,
            async steer() { return "complete_delivered"; },
            async cancel() { finish?.({ id, status: "cancelled" }); },
          };
        },
        async [Symbol.asyncDispose]() {
          if (model.id !== "held-disposal") return;
          await appendFile(join(local.cwd, "dispose.started"), "dispose\n");
          while (!await access(join(local.cwd, "dispose.release")).then(() => true, () => false))
            await setTimeout(5);
          await writeFile(join(local.cwd, "dispose.finished"), "");
        },
      };
    },
  };
`;

async function setupWorker(t: TestContext, heldModelProbe: "auth" | "models" | "" = "") {
  const root = await mkdtemp(join(tmpdir(), "cursor-worker-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { bundle: true, platform: "node", format: "esm" } as const;
  const worker = join(root, "sdk-worker.mjs");
  await build({
    ...options,
    entryPoints: [resolve("apps/cursor-bridge/src/sdk-worker.ts")],
    outfile: worker,
    define: { HELD_MODEL_PROBE: JSON.stringify(heldModelProbe), MODEL_PROBE_ROOT: JSON.stringify(root) },
    plugins: [
      {
        name: "synthetic-cursor-sdk",
        setup(builder) {
          builder.onResolve({ filter: /^@cursor\/sdk$/ }, () => ({ path: "sdk", namespace: "fixture" }));
          builder.onLoad({ filter: /^sdk$/, namespace: "fixture" }, () => ({ contents: sdk, loader: "js" }));
        },
      },
    ],
  });
  const entry = join(root, "native.mjs");
  const sha256 = createHash("sha256")
    .update(await readFile(worker))
    .digest("hex");
  await build({
    ...options,
    entryPoints: [resolve("apps/cursor-bridge/src/native.ts")],
    outfile: entry,
    define: { CURSOR_WORKER_SHA256: JSON.stringify(sha256) },
  });
  const { cursorFactory } = (await import(pathToFileURL(entry).href)) as { cursorFactory: CursorFactory };
  return { root, cursorFactory };
}

function beforeDeadline<T>(result: Promise<T>, message: string, timeoutMs = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([result, timeout]).finally(() => clearTimeout(timer));
}

test("Cursor Worker publishes terminal receipt before the SDK stream finishes draining", async (t) => {
  const { root, cursorFactory } = await setupWorker(t);
  const agent = await cursorFactory.create(root, "fixture", root);
  try {
    const run = await agent.send("drain");
    const stream = run.stream()[Symbol.asyncIterator]();
    const first = await stream.next();
    assert.equal(first.value.message.content[0].text, "first");
    const remaining = stream.next();
    void remaining.catch(() => {});
    const result = await beforeDeadline(run.wait(), "terminal receipt waited for the stream to drain");
    assert.equal(result.status, "finished");
    await writeFile(join(root, "stream.release"), "");
    const last = await remaining;
    assert.equal(last.value.message.content[0].text, "last");
    assert.equal((await stream.next()).done, true);
  } finally {
    await agent.close();
  }
});

test("Cursor Worker releases older SDK runs after admitting the next turn", async (t) => {
  const { root, cursorFactory } = await setupWorker(t);
  const agent = await cursorFactory.create(root, "fixture", root);
  try {
    const first = await agent.send("first");
    for await (const _ of first.stream()) {
      /* Drain the run as the adapter does. */
    }
    assert.equal((await first.wait()).status, "finished");
    const second = await agent.send("second");
    await assert.rejects(first.steer!("stale"), /outcome is unknown/);
    await assert.rejects(first.cancel(), /outcome is unknown/);
    assert.equal(await second.steer!("current"), "complete_delivered");
    for await (const _ of second.stream()) {
      /* Join the current run. */
    }
    assert.equal((await second.wait()).status, "finished");
  } finally {
    await agent.close();
  }
});

test("Cursor Stop finishes after confirmed cancellation while the SDK stream is held", async (t) => {
  const { root, cursorFactory } = await setupWorker(t);
  const deltas: { op: string; text?: string; status?: string }[] = [];
  let sawFirst!: () => void;
  const firstOutput = new Promise<void>((resolve) => {
    sawFirst = resolve;
  });
  const bridge = new CursorBridge({
    factory: cursorFactory,
    notify: async (method, params) => {
      if (method === "thread/delta") {
        const batch = params.deltas as typeof deltas;
        deltas.push(...batch);
        if (batch.some((delta) => delta.op === "item.textDelta" && delta.text === "first")) sawFirst();
      }
      return {};
    },
  });
  let stopping: Promise<unknown> | undefined;
  try {
    await bridge.handle("initialize", { protocolVersion: 1, grammarRange: { min: 1, max: 1 } });
    await bridge.handle("session/create", {
      threadId: "thread",
      cwd: root,
      stateDirectory: root,
      model: "fixture",
      permissionMode: "full",
    });
    const started = (await bridge.handle("turn/start", { threadId: "thread", input: { text: "stop-drain" } })) as {
      nativeTurnId: string;
    };
    await beforeDeadline(firstOutput, "the SDK stream did not deliver its first message");
    stopping = bridge.handle("turn/stop", { threadId: "thread", expectedTurnId: started.nativeTurnId });
    assert.deepEqual(await beforeDeadline(stopping, "Stop waited for SDK output after confirmed cancellation"), {
      stopped: true,
    });
    assert.deepEqual(
      deltas.filter((delta) => delta.op === "turn.close").map((delta) => delta.status),
      ["interrupted"],
    );
    assert.deepEqual(
      deltas.filter((delta) => delta.op === "item.textDelta").map((delta) => delta.text),
      ["first"],
    );
    await bridge.handle("turn/start", { threadId: "thread", input: { text: "next" } });
    assert.deepEqual(await bridge.handle("session/close", { threadId: "thread" }), { closed: true });
  } finally {
    await writeFile(join(root, "stream.release"), "");
    await Promise.allSettled([stopping]);
    await bridge.close();
  }
});

test("Cursor agent close terminates the Worker when SDK disposal never acknowledges", async (t) => {
  const { root, cursorFactory } = await setupWorker(t);
  const agent = await cursorFactory.create(root, "held-disposal", root);
  const closing = agent.close();
  const concurrent = agent.close();
  try {
    assert.equal(concurrent, closing);
    await beforeDeadline(closing, "Worker termination waited indefinitely for SDK disposal", 6000);
    assert.equal(await readFile(join(root, "dispose.started"), "utf8"), "dispose\n");
    await assert.rejects(readFile(join(root, "dispose.finished")), { code: "ENOENT" });
    await assert.rejects(agent.send("closed"), /worker unavailable/i);
    await agent.close();
    assert.equal(await readFile(join(root, "dispose.started"), "utf8"), "dispose\n");
  } finally {
    await writeFile(join(root, "dispose.release"), "");
    await Promise.allSettled([closing, concurrent]);
    await agent.close();
  }
});

async function waitForModelProbe(root: string, stage: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const started = await readFile(join(root, "probe.started"), "utf8").catch(() => "");
    if (started === stage) return;
    await delay(5);
  }
  assert.fail("the SDK did not start the " + stage + " probe");
}

for (const stage of ["auth", "models"] as const)
  test("Cursor shutdown joins the models Worker during " + stage, async (t) => {
    const { root, cursorFactory } = await setupWorker(t, stage);
    const bridge = new CursorBridge({ factory: cursorFactory, notify: async () => ({}) });
    await bridge.handle("initialize", { protocolVersion: 1, grammarRange: { min: 1, max: 1 } });
    let finished = false;
    const listing = bridge.handle("model/list").finally(() => {
      finished = true;
    });
    void listing.catch(() => {});
    try {
      await waitForModelProbe(root, stage);
      await beforeDeadline(bridge.close(), "bridge shutdown did not finish");
      assert.equal(finished, true, "shutdown returned with its Worker request still pending");
      await assert.rejects(listing, /model lookup.*bridge.*closed/i);
    } finally {
      await writeFile(join(root, "probe.release"), "");
      await Promise.allSettled([listing]);
      await bridge.close();
    }
  });

test("Cursor shares stalled model discovery and lets callers retry after its deadline", async (t) => {
  const { root, cursorFactory } = await setupWorker(t, "models");
  const bridge = new CursorBridge({ factory: cursorFactory, notify: async () => ({}) });
  await bridge.handle("initialize", { protocolVersion: 1, grammarRange: { min: 1, max: 1 } });
  const first = bridge.handle("model/list");
  void first.catch(() => {});
  let second: Promise<unknown> | undefined;
  try {
    await waitForModelProbe(root, "models");
    second = bridge.handle("model/list");
    const results = await beforeDeadline(
      Promise.allSettled([first, second]),
      "stalled model discovery never settled",
      13_000,
    );
    for (const result of results) {
      assert.equal(result.status, "rejected");
      const error = (result as PromiseRejectedResult).reason;
      assert.ok(error instanceof CursorError);
      assert.equal(error.kind, "explicit-reject");
      assert.match(error.message, /model lookup timed out/i);
    }
    const entries = join(root, "probe.entries");
    assert.equal(await readFile(entries, "utf8"), "models\n");
    await writeFile(join(root, "probe.release"), "");
    assert.deepEqual(await bridge.handle("model/list"), { models: [{ id: "fixture", name: "Fixture" }] });
    assert.equal(await readFile(entries, "utf8"), "models\nmodels\n");
  } finally {
    await writeFile(join(root, "probe.release"), "");
    await Promise.allSettled([first, second]);
    await bridge.close();
  }
});
