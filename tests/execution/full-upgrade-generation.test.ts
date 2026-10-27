import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AcpGenerationHost } from "../../plugins/acp-engine/src/generations.js";
import { generationOwner } from "../../scripts/full-upgrade/generation-owner.mjs";
import { switchGeneration, acceptGenerationPlan } from "../../scripts/full-upgrade/generation-upgrade.mjs";
import { fingerprint } from "../../scripts/full-upgrade/inventory.mjs";
import { Journal } from "../../scripts/full-upgrade/journal.mjs";
import { signBytes } from "../../scripts/full-release/contract.mjs";

async function until(predicate: () => boolean) { for (let n = 0; n < 500; n++) { if (predicate()) return; await delay(10); } throw new Error("fixture timed out"); }
test("P2c real ACP private adapter compensates a lost activation reply, records dormant and resumes its exact binding", async t => {
  const root = await mkdtemp(join(tmpdir(), "p2c-acp-integration-")), trace = join(root, "trace.jsonl");
  const host = new AcpGenerationHost({ id: "acp", dataDirectory: join(root, "host"), initialGeneration: { id: "a", configPath: join(root, "a.json") },
    async readConfig() { return { command: process.execPath, args: [resolve("tests/fixtures/acp-engine-peer.mjs")], cwd: root, env: { ACP_TEST_TRACE: trace }, permission: "allow-once" }; } });
  const journal = await new Journal(join(root, "journal")).open();
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer fixture-private") { res.writeHead(403); res.end(); return; }
    try {
      let value;
      if (req.method === "GET") value = host.snapshot();
      else { const chunks = []; for await (const c of req) chunks.push(c); const { action, ...input } = JSON.parse(Buffer.concat(chunks).toString()); value = await host.manage(action, input); }
      res.writeHead(200); res.end(JSON.stringify(value));
    } catch { res.writeHead(409); res.end('{}'); }
  });
  await host.start(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await journal.close(); await rm(root, { recursive: true, force: true }); });
  const client = { notify() {}, async request() { throw new Error("unexpected browser call"); } };
  let callbacks = 0, finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  host.setOrchestration({ tools: [{ name: "thread_spawn", description: "fixture", inputSchema: { type: "object" } }], async call() { callbacks++; await held; return { childId: "fixture-child" }; } });
  const old = await host.request("thread/start", {}, client);
  const turn = await host.request("turn/start", { threadId: old.thread.id, input: [{ type: "text", text: "call:thread_spawn" }] }, client);
  await until(() => callbacks === 1);
  const originalPid = host.snapshot().generations[0].pid;
  const address = server.address() as import("node:net").AddressInfo;
  const owner = generationOwner({ kind: "acp", endpoint: `http://127.0.0.1:${address.port}`, token: "fixture-private", definition: { configPath: join(root, "b.json") } });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"), hash = "a".repeat(64);
  const combination = { ownerId: "acp", targetId: "b", from: fingerprint(await owner.snapshot()), to: "fixture-b" };
  const matrixBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "opencraft.generation-compatibility", manifestSha256: hash, expiresAt: Date.now() + 60000,
    combinations: [{ combination, status: "verified", forward: true, rollback: true, retainBindings: true }] }));
  const plan = acceptGenerationPlan({ manifestSha256: hash, inventoryFingerprint: hash, policy: { isolated: true }, combination, matrixBytes,
    signature: signBytes(matrixBytes, privateKey, "fixture"), trust: { keys: { fixture: publicKey.export({ type: "spki", format: "pem" }) } } });
  const activate = owner.activate;
  let created: any;
  owner.activate = async (...args: any[]) => {
    const value = await activate(...args);
    if (args[0] === "b") { created = await host.request("thread/start", {}, client); throw new Error("synthetic reply loss after admission"); }
    return value;
  };
  const job = await switchGeneration({ plan, operationId: "real-acp-switch", bootId: "isolated-boot", journal, lockPath: join(root, "host.lock"), owner, targetId: "b", validate: async () => true });
  assert.equal(job.state, "rolled-back"); assert.equal(host.snapshot().current, "a");
  assert.equal(job.steps[3].receipt.disposition, "dormant");
  const dormant = host.snapshot().generations.find((g: any) => g.id === "b"); assert.equal(dormant.state, "dormant"); assert.equal(dormant.pid, null); assert.equal(dormant.bindings, 1);
  assert.equal(host.snapshot().generations[0].pid, originalPid); assert.equal(host.executionObservation(old.thread.id).turn.id, turn.turn.id);
  host.disconnect(client); finish(); await until(() => host.executionObservation(old.thread.id).turn?.status === "completed");
  await host.request("thread/resume", { threadId: created.thread.id }, client);
  assert.equal(host.snapshot().generations.find((g: any) => g.id === "b").state, "draining");
  const calls = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.filter(call => call.method === "session/new").length, 2); assert.equal(callbacks, 1);
  assert.equal(calls.filter(call => call.method === "session/resume").length, 1);
});
