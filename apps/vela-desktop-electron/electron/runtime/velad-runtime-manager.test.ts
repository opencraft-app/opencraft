import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { VeladRuntimeManager } from "./velad-runtime-manager";
import {
  parseVeladReadyLine,
  VELACHAT_API_PROTOCOL,
  VELAD_LOCAL_RUNTIME_PROTOCOL,
} from "./velad-runtime-state";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill() {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

class MemoryLogger {
  lines: string[] = [];

  write(source: string, message: string) {
    this.lines.push(`${source} ${message}`);
  }
}

function createManager(options: {
  fetchImpl?: typeof fetch;
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  onSpawn?: (child: FakeChild, command: string, args: string[]) => void;
}) {
  const logger = new MemoryLogger();
  let child: FakeChild | null = null;
  const manager = new VeladRuntimeManager({
    host: {
      getPath(name) {
        return name === "home" ? "/tmp/home" : "/tmp/user-data";
      },
    },
    resourcesPath: "/tmp/resources",
    logger,
    fetchImpl: options.fetchImpl ?? fetch,
    readyTimeoutMs: options.readyTimeoutMs ?? 100,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 100,
    requestTimeoutMs: 100,
    resolveBundledVeladPath: () => "/tmp/velad",
    spawnImpl: ((command: string, args: string[]) => {
      child = new FakeChild();
      options.onSpawn?.(child, command, args);
      return child;
    }) as never,
  });
  return { manager, logger, getChild: () => child };
}

function readyLine(overrides: Record<string, unknown> = {}) {
  return `${JSON.stringify({
    type: "velad.ready",
    runtime_protocol: VELAD_LOCAL_RUNTIME_PROTOCOL,
    api_protocol: VELACHAT_API_PROTOCOL,
    pid: 123,
    listen_addr: "127.0.0.1:49321",
    api_base_url: "http://127.0.0.1:49321/api/v1",
    version: "0.1.0",
    ...overrides,
  })}\n`;
}

test("manager resolves bundled startup from stdout velad.ready", async () => {
  let spawnedArgs: string[] = [];
  const { manager, getChild } = createManager({
    onSpawn(child, _command, args) {
      spawnedArgs = args;
      queueMicrotask(() => child.stdout.write(readyLine()));
    },
  });

  const info = await manager.ensureReady();

  assert.equal(info.apiBaseUrl, "http://127.0.0.1:49321/api/v1");
  assert.equal(info.listenAddr, "127.0.0.1:49321");
  assert.deepEqual(spawnedArgs.slice(0, 2), ["--listen", "127.0.0.1:0"]);
  assert.equal(getChild()?.killed, false);
});

test("non-json stdout is logged but does not trigger ready", async () => {
  const { manager, logger } = createManager({
    readyTimeoutMs: 5,
    onSpawn(child) {
      queueMicrotask(() => child.stdout.write("plain log line\n"));
    },
  });

  await assert.rejects(manager.ensureReady(), /ready event timed out/);
  assert.match(logger.lines.join("\n"), /plain log line/);
});

test("wrong ready protocol fails startup", async () => {
  const { manager } = createManager({
    onSpawn(child) {
      queueMicrotask(() => child.stdout.write(readyLine({ runtime_protocol: "wrong.v1" })));
    },
  });

  await assert.rejects(manager.ensureReady(), /unsupported velad runtime protocol/);
});

test("external runtime validates runtime-info without fetching backends", async () => {
  const requested: string[] = [];
  const logger = new MemoryLogger();
  const manager = new VeladRuntimeManager({
    host: {
      getPath(name) {
        return name === "home" ? "/tmp/home" : "/tmp/user-data";
      },
    },
    resourcesPath: "/missing/resources",
    env: { VELA_DESKTOP_VELAD_LISTEN_ADDR: "127.0.0.1:3857" },
    logger,
    requestTimeoutMs: 100,
    fetchImpl: (async (url: RequestInfo | URL) => {
      requested.push(String(url));
      return Response.json(JSON.parse(readyLine()));
    }) as typeof fetch,
  });

  await manager.ensureReady();

  assert.deepEqual(requested, ["http://127.0.0.1:3857/api/v1/runtime-info"]);
  assert.doesNotMatch(requested.join("\n"), /backends/);
});

test("shutdown posts runtime endpoint and waits for child exit", async () => {
  const requests: string[] = [];
  const { manager, getChild } = createManager({
    fetchImpl: (async (url: RequestInfo | URL) => {
      requests.push(String(url));
      queueMicrotask(() => getChild()?.emit("exit", 0, null));
      return Response.json({ accepted: true });
    }) as typeof fetch,
    onSpawn(child) {
      queueMicrotask(() => child.stdout.write(readyLine()));
    },
  });
  await manager.ensureReady();

  await manager.stop();

  assert.deepEqual(requests, ["http://127.0.0.1:49321/api/v1/runtime/shutdown"]);
  assert.equal(getChild()?.killed, false);
});

test("shutdown fallback uses child.kill without shelling out", async () => {
  const { manager, getChild } = createManager({
    shutdownTimeoutMs: 5,
    fetchImpl: (async () => Response.json({ accepted: true })) as typeof fetch,
    onSpawn(child) {
      queueMicrotask(() => child.stdout.write(readyLine()));
    },
  });
  await manager.ensureReady();

  await manager.stop();

  assert.equal(getChild()?.killed, true);
});

test("ready parser returns null for unrelated stdout", () => {
  assert.equal(parseVeladReadyLine("not json"), null);
});
