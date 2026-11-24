// The Pi and ACP owner locks are process-lifetime kernel writers. The former
// proper-lockfile mtime lease let a contender take over an owner whose event
// loop stalled for 10s, and threw ECOMPROMISED from its refresh timer.
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { acquireOwnerLock } from "../../packages/sqlite-node/src/index.ts";
import { startIndependentEngineHost } from "../../scripts/server-deployment/engine-host.mjs";
import { startIndependentAcpHost } from "../../scripts/server-deployment/acp-host.mjs";
import { startHeadlessServer } from "../../apps/headless-server/src/headless-server.mjs";
import { ModelConfigurationRepository } from "../../apps/local-agent-host/src/model-config/repository.ts";
import { ownedCleanup } from "../support/owned-cleanup.mjs";

async function fixture(t) {
  const runtime = fileURLToPath(new URL("../../.runtime/", import.meta.url));
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, "owner-locks-"));
  const cleanup = ownedCleanup(t);
  cleanup.last(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Owner locks</title>");
  await writeFile(
    join(webRoot, "version.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildId: "owner-locks-test",
      headlessServer: true,
      headlessHostId: "opencraft-server",
    }),
  );
  const headless = (dataDirectory) => ({ root, webRoot, dataDirectory, port: 0, engines: ["pi"], defaultEngine: "pi" });
  const startHeadless = (dataDirectory) =>
    startHeadlessServer({
      ...headless(dataDirectory),
      startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:9/rpc", close: async () => {} }),
    });
  const engineHost = async (dataDirectory, name = "engine") => {
    await new ModelConfigurationRepository(fileStateDocumentStore(join(dataDirectory, "models")))
      .initialize({ schemaVersion: 1, revision: 0, providers: [], defaultModel: null })
      .catch(() => {});
    return startIndependentEngineHost({
      dataDirectory,
      descriptorPath: join(root, `${name}.json`),
      runtimeDirectory: root,
      engines: ["pi"],
      defaultEngine: "pi",
    });
  };
  const acpHost = async (dataDirectory, name = "acp") => {
    const configPath = join(root, `${name}-generation.json`);
    await writeFile(
      configPath,
      JSON.stringify({ command: process.execPath, args: [resolve("tests/fixtures/acp-engine-peer.mjs")], cwd: root }),
      { mode: 0o600 },
    );
    return startIndependentAcpHost({
      id: "acp",
      descriptorPath: join(root, `${name}.json`),
      dataDirectory,
      runtimeDirectory: root,
      initialGeneration: { id: "one", configPath },
    });
  };
  return { root, own: cleanup.own, headless, startHeadless, engineHost, acpHost };
}

function uncaughtRecorder(t) {
  const uncaught = [],
    record = (error) => {
      uncaught.push(error);
    };
  process.on("uncaughtException", record);
  t.after(() => {
    process.off("uncaughtException", record);
  });
  return uncaught;
}

test(
  "a stalled in-process Headless Pi owner is never replaced by an independent engine host, and its death releases the owner at once",
  { skip: process.platform !== "linux", timeout: 120_000 },
  async (t) => {
    const f = await fixture(t),
      dataDirectory = join(f.root, "data");
    const child = fork(
      new URL("../fixtures/headless-pi-owner.mjs", import.meta.url),
      [JSON.stringify(f.headless(dataDirectory))],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    f.own(async () => {
      if (child.exitCode !== null || child.signalCode) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    });
    const [ready] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error(`Headless owner exited: ${stderr}`);
      }),
    ]);
    assert.equal(ready.type, "ready");
    const lock = join(dataDirectory, "pi-owner.lock");
    assert.equal(
      (await stat(lock)).isFile(),
      true,
      "the Pi owner lock is a kernel writer, not an mtime lease directory",
    );
    // A stopped event loop refreshes nothing: age the lock far past any staleness.
    child.kill("SIGSTOP");
    await utimes(lock, 0, 0);
    await assert.rejects(f.engineHost(dataDirectory), { code: "ELOCKED" });
    child.kill("SIGCONT");
    assert.equal((await fetch(ready.url)).status, 200, "the resumed Headless owner still serves");
    assert.equal(child.exitCode, null);
    assert.doesNotMatch(stderr, /ECOMPROMISED/);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const successor = await f.engineHost(dataDirectory);
    f.own(() => successor.close());
    await assert.rejects(f.startHeadless(dataDirectory), { code: "ELOCKED" });
  },
);

test(
  "every owner lock refuses a second writer in the same process and has no refresh timer to compromise",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t),
      uncaught = uncaughtRecorder(t);
    const headlessData = join(f.root, "headless"),
      engineData = join(f.root, "engine"),
      acpData = join(f.root, "acp");
    const headless = await f.startHeadless(headlessData);
    f.own(() => headless.close());
    const engine = await f.engineHost(engineData);
    f.own(() => engine.close());
    const acp = await f.acpHost(acpData);
    f.own(() => acp.close());
    // In-process and independent Pi owners exclude each other on one data directory, either way round.
    await assert.rejects(f.engineHost(headlessData, "engine-contender"), { code: "ELOCKED" });
    await assert.rejects(f.startHeadless(engineData), { code: "ELOCKED" });
    const locks = [
      join(headlessData, "pi-owner.lock"),
      join(engineData, "pi-owner.lock"),
      join(acpData, "acp-owner.lock"),
    ];
    for (const lock of locks) {
      assert.equal((await stat(lock)).isFile(), true, `${lock} is a kernel writer`);
      await assert.rejects(acquireOwnerLock(lock), { code: "ELOCKED" });
      await utimes(lock, 0, 0);
    }
    // Longer than the 5s refresh period of the former mtime lease, which treated a
    // changed mtime as a compromise and threw from its timer.
    await delay(6_000);
    assert.deepEqual(uncaught, []);
    await Promise.all([headless.close(), engine.close(), acp.close()]);
    assert.deepEqual(uncaught, []);
    for (const lock of locks) (await acquireOwnerLock(lock))();
  },
);

test(
  "an abandoned legacy owner lease is converted, while a fresh one is still honoured",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const cases = [
      ["pi-owner.lock", (dataDirectory) => f.engineHost(dataDirectory)],
      ["acp-owner.lock", (dataDirectory) => f.acpHost(dataDirectory)],
    ];
    for (const [name, start] of cases) {
      const dataDirectory = join(f.root, name.replace(".lock", "")),
        lock = join(dataDirectory, name);
      // An older release left its lease directory inside the owner's private data directory.
      await mkdir(dataDirectory, { mode: 0o700 });
      await mkdir(lock);
      await assert.rejects(start(dataDirectory), { code: "ELOCKED" });
      assert.equal((await stat(lock)).isDirectory(), true, "a fresh legacy lease is never removed");
      await utimes(lock, 0, 0);
      const host = await start(dataDirectory);
      f.own(() => host.close());
      assert.equal((await stat(lock)).isFile(), true);
    }
  },
);
