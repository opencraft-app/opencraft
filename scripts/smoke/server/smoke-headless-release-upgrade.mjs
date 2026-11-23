// Tests the standalone Linux Headless replacement path with two exact archives.
// Only the model endpoint is simulated. The baseline writes its own session and project.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { startHeadlessSmokeProcess } from "./headless-smoke-process.mjs";
import { unpackHeadlessPackage } from "./smoke-headless-package.mjs";

const hostId = "opencraft-server";
const leaseId = "headless-release-upgrade";
const modelId = "upgrade-fixture-model";
const originalPrompt = "Original upgrade fixture message";
const continuedPrompt = "Continued upgrade fixture message";
const replyFor = (prompt) => `Fixture reply to: ${prompt}`;

async function until(read, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function connect(origin) {
  const ws = new WebSocket(origin.replace(/^http/u, "ws") + "/apphost", { origin, handshakeTimeout: 10_000 });
  const frames = [];
  let generation;
  let requestId = 0;
  ws.on("message", (wire) => frames.push(JSON.parse(wire.toString())));
  const wait = (pick, label) =>
    until(() => {
      const frame = frames.find(pick);
      if (frame) return frame;
      if (ws.readyState >= WebSocket.CLOSING) throw new Error(`AppHost closed during ${label}`);
    }, label);
  const send = (frame) => ws.send(JSON.stringify(frame));
  async function request(method, params = {}) {
    const id = ++requestId;
    send({
      type: "host/send",
      requestId: `send-${id}`,
      hostId,
      leaseId,
      generation,
      frame: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const result = await wait((frame) => frame.type === "host/frame" && JSON.parse(frame.frame).id === id, method);
    const reply = JSON.parse(result.frame);
    assert.equal(reply.error, undefined, `${method}: ${JSON.stringify(reply.error)}`);
    return reply.result;
  }
  try {
    await new Promise((resolveOpen, reject) => {
      ws.once("open", resolveOpen);
      ws.on("error", reject);
    });
    send({ type: "hello", protocolVersion: 2, rendererId: leaseId });
    await wait((frame) => frame.type === "ready", "AppHost hello");
    send({ type: "host/connect", requestId: "connect", hostId, leaseId });
    const connected = await wait((frame) => frame.requestId === "connect", "Host connect");
    assert.equal(connected.ok, true, JSON.stringify(connected.error));
    generation = connected.result.generation;
    await request("initialize", {
      clientInfo: { name: leaseId, version: "1" },
      capabilities: { experimentalApi: true },
    });
    return { request, close: () => ws.terminate() };
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

function launch(root, data, home) {
  const process = startHeadlessSmokeProcess(
    join(root, "bin/opencraft-server"),
    ["--host", "127.0.0.1", "--port", "0", "--data-dir", data, "--engines", "pi", "--default-engine", "pi"],
    {
      cwd: root,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        GIT_CONFIG_NOSYSTEM: "1",
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "127.0.0.1,localhost",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const { child } = process;
  let stdout = "";
  let stderr = "";
  let failure;
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-8_000);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8_000);
  });
  child.on("error", (error) => {
    failure = error;
  });
  const exited = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, failure })),
  );
  return {
    exited,
    async ready(buildId) {
      const origin = await until(
        () => {
          if (failure || child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`Headless exited before readiness: ${failure ?? stderr}`);
          }
          return /OpenCraft WebUI: (http:\/\/127\.0\.0\.1:\d+)/u.exec(stdout)?.[1];
        },
        "Headless readiness",
        90_000,
      );
      const read = async (path) => {
        const response = await fetch(origin + path, { signal: AbortSignal.timeout(5_000) });
        assert.equal(response.status, 200, path);
        return response.json();
      };
      const health = await read("/__opencraft_health");
      assert.equal(health.ok, true);
      assert.ok(health.storage?.length > 0, "Headless did not report storage owners");
      assert.deepEqual(
        health.storage.filter((owner) => owner.movedAside === true),
        [],
        "Storage was moved aside",
      );
      assert.equal((await read("/version.json")).buildId, buildId);
      return origin;
    },
    close: process.close,
  };
}

async function exercise(root, manifest, data, home, action) {
  const server = launch(root, data, home);
  let client;
  let completed = false;
  try {
    client = await connect(await server.ready(manifest.buildId));
    const result = await action(client.request);
    completed = true;
    return result;
  } finally {
    client?.close();
    await server.close();
    const stopped = await server.exited;
    if (completed) assert.equal(stopped.code, 0, `Headless did not close cleanly: ${stopped.stderr}`);
  }
}

async function completedTurn(request, threadId, prompt) {
  const { turn } = await request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
    clientUserMessageId: prompt.replaceAll(" ", "-").toLowerCase(),
  });
  assert.ok(turn.id);
  await until(async () => {
    const { thread } = await request("thread/read", { threadId, includeTurns: true });
    const persisted = thread.turns.find((item) => item.id === turn.id);
    if (persisted?.status === "failed" || persisted?.status === "interrupted") {
      throw new Error(`Fixture turn ${persisted.status}: ${JSON.stringify(persisted.error)}`);
    }
    if (persisted?.status !== "completed") return false;
    assert.ok(JSON.stringify(persisted.items).includes(replyFor(prompt)), "The model reply was not persisted");
    return true;
  }, "a real, persisted turn");
  return turn.id;
}

function modelFixture(observed) {
  return createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const prompt = [continuedPrompt, originalPrompt].find((value) => JSON.stringify(input.messages).includes(value));
      if (!prompt || input.model !== modelId) {
        response.writeHead(422).end();
        return;
      }
      observed.add(prompt);
      const common = { id: "upgrade-model-reply", object: "chat.completion.chunk", created: 1, model: modelId };
      const events = [
        {
          ...common,
          choices: [{ index: 0, delta: { role: "assistant", content: replyFor(prompt) }, finish_reason: null }],
        },
        {
          ...common,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
    } catch {
      response.writeHead(400).end();
    }
  });
}

async function assertPreserved(request, seed) {
  const projects = await request("project/list");
  const project = projects.data.find((item) => item.id === seed.projectId);
  assert.ok(
    project?.roots.some((root) => root.path === seed.cwd),
    "Original project and root were not preserved",
  );
  const { thread } = await request("thread/resume", { threadId: seed.threadId });
  assert.equal(thread.id, seed.threadId);
  assert.equal(thread.cwd, seed.cwd);
  assert.equal(thread.projectId, seed.projectId);
  const history = (await request("thread/read", { threadId: seed.threadId, includeTurns: true })).thread;
  const previous = history.turns.find((turn) => turn.id === seed.turnId);
  assert.equal(previous?.status, "completed");
  for (const marker of [originalPrompt, replyFor(originalPrompt)]) {
    assert.ok(JSON.stringify(previous.items).includes(marker), `Missing persisted marker: ${marker}`);
  }
}

async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function rejectIncompatibleCopy(candidate, data, home, isolated) {
  // Seed a future ledger on a copy of a baseline-written, required SQLite owner
  // that opens after the core store. The installed-state input is never writable by
  // the candidate: an actual update must only proceed after an isolated trial passes.
  const core = join(data, "opencraft-server.sqlite");
  const policy = "model-usage-policy.sqlite";
  const before = await Promise.all([digest(core), digest(join(data, policy))]);
  await cp(data, isolated, { recursive: true, verbatimSymlinks: true });
  const db = new DatabaseSync(join(isolated, policy));
  try {
    db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(
      999_999,
      "upgrade-fixture-future-schema",
      "0".repeat(64),
      Date.now(),
    );
  } finally {
    db.close();
  }
  const server = launch(candidate.root, isolated, home);
  let timer;
  try {
    const stopped = await Promise.race([
      server.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Incompatible candidate did not exit")), 30_000);
      }),
    ]);
    assert.equal(stopped.failure, undefined);
    assert.equal(stopped.signal, null);
    assert.equal(stopped.code, 1, stopped.stderr);
    assert.match(stopped.stderr, /Unsupported newer database migration history/u);
    assert.doesNotMatch(stopped.stdout, /OpenCraft WebUI:/u);
    assert.deepEqual(await Promise.all([digest(core), digest(join(data, policy))]), before);
  } finally {
    clearTimeout(timer);
    await server.close();
  }
}

export async function smokeHeadlessReleaseUpgrade(baselineArchive, candidateArchive) {
  assert.equal(process.platform + "/" + process.arch, "linux/x64", "Linux x64 archives require a Linux x64 runner");
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencraft-headless-upgrade-")));
  const data = join(root, "data");
  const home = join(root, "home");
  const cwd = join(root, "project");
  const observed = new Set();
  const model = modelFixture(observed);
  try {
    const packages = [];
    for (const [name, archive] of [
      ["baseline", baselineArchive],
      ["candidate", candidateArchive],
    ]) {
      const path = join(root, name);
      await mkdir(path);
      packages.push(await unpackHeadlessPackage(archive, path));
    }
    const [baseline, candidate] = packages;
    assert.notEqual(baseline.manifest.buildId, candidate.manifest.buildId, "Upgrade must use different builds");
    await mkdir(home, { mode: 0o700 });
    await mkdir(cwd, { mode: 0o700 });
    await new Promise((resolveListen, reject) => {
      model.once("error", reject);
      model.listen(0, "127.0.0.1", resolveListen);
    });
    // Configure only the external model seam. The baseline itself writes all
    // projects, conversations, turns and per-owner migration records.
    const modelsDirectory = join(data, "models");
    await mkdir(modelsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(modelsDirectory, "models.json"),
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        defaultModel: null,
        providers: [
          {
            id: "upgrade-fixture",
            name: "Upgrade fixture",
            enabled: true,
            protocol: "openai-completions",
            baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
            authentication: "none",
            credentialRef: null,
            models: [{ id: modelId, enabled: true, contextWindow: 8192, maxTokens: 1024 }],
          },
        ],
      }),
      { mode: 0o600 },
    );
    const seed = await exercise(baseline.root, baseline.manifest, data, home, async (request) => {
      const models = await request("model/list");
      const entry = models.data.find((model) => model.model.includes(modelId));
      assert.ok(entry, "Baseline must expose the synthetic provider through the production model catalog");
      const { project } = await request("project/create", {
        name: "Upgrade fixture project",
        roots: [{ path: cwd }],
        idempotencyKey: "headless-release-upgrade",
      });
      assert.ok(project.id && project.roots.some((root) => root.path === cwd));
      const { thread } = await request("thread/start", { cwd, projectId: project.id, model: entry.model });
      assert.ok(thread.id);
      assert.equal(thread.cwd, cwd);
      assert.equal(thread.projectId, project.id);
      const turnId = await completedTurn(request, thread.id, originalPrompt);
      return { projectId: project.id, threadId: thread.id, turnId, cwd };
    });
    assert.ok(observed.has(originalPrompt), "Baseline did not run the fixture turn through Pi");
    await rejectIncompatibleCopy(candidate, data, home, join(root, "incompatible"));
    const continuedTurnId = await exercise(candidate.root, candidate.manifest, data, home, async (request) => {
      await assertPreserved(request, seed);
      return completedTurn(request, seed.threadId, continuedPrompt);
    });
    assert.ok(observed.has(continuedPrompt), "Candidate did not continue the original Pi thread");
    await exercise(candidate.root, candidate.manifest, data, home, async (request) => {
      await assertPreserved(request, seed);
      const { thread } = await request("thread/read", { threadId: seed.threadId, includeTurns: true });
      const continued = thread.turns.find((turn) => turn.id === continuedTurnId);
      assert.equal(continued?.status, "completed");
      assert.ok(JSON.stringify(continued.items).includes(replyFor(continuedPrompt)));
    });
    console.log(
      JSON.stringify({
        baselineBuildId: baseline.manifest.buildId,
        candidateBuildId: candidate.manifest.buildId,
        incompatibleCopyRefused: true,
        baselineStatePreserved: true,
        originalThreadResumed: true,
        restartPassed: true,
      }),
    );
  } finally {
    await new Promise((resolveClose) => model.close(resolveClose));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const [baseline, candidate] = process.argv.slice(2);
assert.ok(
  baseline && candidate && process.argv.length === 4,
  "Usage: npm run smoke:headless:upgrade -- BASELINE_ARCHIVE CANDIDATE_ARCHIVE",
);
await smokeHeadlessReleaseUpgrade(resolve(baseline), resolve(candidate));
